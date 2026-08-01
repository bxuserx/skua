// Minimal RFC6455 client-side framing.
//
// Needed because ttyd now listens on a UNIX SOCKET (see terminals.ts) and Bun's
// WebSocket client cannot dial one — `ws+unix://` is rejected. The dashboard
// therefore reaches ttyd through a raw `Bun.connect({unix})` and speaks the
// WebSocket wire format itself. The browser side is a normal Bun.serve
// WebSocket, so this codec only ever plays the CLIENT role:
//   • frames we send are masked (RFC6455 §5.3 requires it of clients)
//   • frames we receive are not masked (servers must not mask)
// Unmasking is still implemented for robustness against a non-conforming peer.

export const OP_CONT = 0x0;
export const OP_TEXT = 0x1;
export const OP_BIN = 0x2;
export const OP_CLOSE = 0x8;
export const OP_PING = 0x9;
export const OP_PONG = 0xa;

export type Frame = { opcode: number; payload: Uint8Array };

/** Encode a single un-fragmented client frame. */
export function encodeFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const n = payload.length;
  const headerLen = n < 126 ? 2 : n < 65536 ? 4 : 10;
  const buf = new Uint8Array(headerLen + 4 + n);
  const view = new DataView(buf.buffer);

  buf[0] = 0x80 | opcode; // FIN + opcode
  if (n < 126) {
    buf[1] = 0x80 | n; // MASK + length
  } else if (n < 65536) {
    buf[1] = 0x80 | 126;
    view.setUint16(2, n);
  } else {
    buf[1] = 0x80 | 127;
    view.setBigUint64(2, BigInt(n));
  }

  const mask = buf.subarray(headerLen, headerLen + 4);
  crypto.getRandomValues(mask);
  for (let i = 0; i < n; i++) buf[headerLen + 4 + i] = payload[i] ^ mask[i & 3];
  return buf;
}

/** Streaming frame decoder. Feed it socket chunks; get whole frames back.
 *
 *  Buffers a partial frame across chunks — a terminal repaint easily exceeds one
 *  TCP segment, and a decoder that assumed chunk == frame would corrupt output
 *  exactly when the screen is busiest. */
export class FrameDecoder {
  private buf: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    if (this.buf.length) {
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf);
      merged.set(chunk, this.buf.length);
      this.buf = merged;
    } else {
      this.buf = chunk;
    }

    const frames: Frame[] = [];
    for (;;) {
      if (this.buf.length < 2) break;
      const view = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.byteLength);

      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f;
      let offset = 2;

      if (len === 126) {
        if (this.buf.length < 4) break;
        len = view.getUint16(2);
        offset = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) break;
        len = Number(view.getBigUint64(2));
        offset = 10;
      }

      const maskLen = masked ? 4 : 0;
      if (this.buf.length < offset + maskLen + len) break; // frame not complete yet

      let payload = this.buf.subarray(offset + maskLen, offset + maskLen + len);
      if (masked) {
        const key = this.buf.subarray(offset, offset + 4);
        const out = new Uint8Array(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ key[i & 3];
        payload = out;
      } else {
        payload = payload.slice(); // detach from the shared buffer before we trim
      }

      frames.push({ opcode: this.buf[0] & 0x0f, payload });
      this.buf = this.buf.slice(offset + maskLen + len);
    }
    return frames;
  }
}
