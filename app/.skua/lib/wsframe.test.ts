import { test, expect, describe } from "bun:test";
import { encodeFrame, FrameDecoder, OP_TEXT, OP_BIN, OP_CLOSE } from "./wsframe.ts";

/** Strip the client mask so a decoder (which expects server frames) can read it. */
function unmask(frame: Uint8Array): Uint8Array {
  const lenByte = frame[1] & 0x7f;
  const offset = lenByte < 126 ? 2 : lenByte < 127 ? 4 : 10;
  const key = frame.subarray(offset, offset + 4);
  const payload = frame.subarray(offset + 4);
  const out = new Uint8Array(offset + payload.length);
  out.set(frame.subarray(0, offset));
  out[1] = frame[1] & 0x7f; // clear MASK bit
  for (let i = 0; i < payload.length; i++) out[offset + i] = payload[i] ^ key[i & 3];
  return out;
}

const roundTrip = (op: number, payload: Uint8Array) =>
  new FrameDecoder().push(unmask(encodeFrame(op, payload)));

describe("encode/decode round-trip", () => {
  test("small payload (7-bit length)", () => {
    const data = new TextEncoder().encode("0echo hi\n");
    const [f] = roundTrip(OP_TEXT, data);
    expect(f.opcode).toBe(OP_TEXT);
    expect(new TextDecoder().decode(f.payload)).toBe("0echo hi\n");
  });

  test("125 bytes — last size that fits the 7-bit length", () => {
    const data = new Uint8Array(125).fill(65);
    expect(roundTrip(OP_BIN, data)[0].payload.length).toBe(125);
  });

  test("126 bytes — first size needing the 16-bit length", () => {
    const data = new Uint8Array(126).fill(66);
    const [f] = roundTrip(OP_BIN, data);
    expect(f.payload.length).toBe(126);
    expect(f.payload[125]).toBe(66);
  });

  test("65535 bytes — last size fitting the 16-bit length", () => {
    const data = new Uint8Array(65535).fill(67);
    expect(roundTrip(OP_BIN, data)[0].payload.length).toBe(65535);
  });

  test("65536 bytes — first size needing the 64-bit length (a full repaint)", () => {
    // zellij re-emits ~64KB on resize; this is the boundary that would corrupt
    // output exactly when the screen is busiest.
    const data = new Uint8Array(65536).fill(68);
    const [f] = roundTrip(OP_BIN, data);
    expect(f.payload.length).toBe(65536);
    expect(f.payload[65535]).toBe(68);
  });

  test("empty payload", () => {
    expect(roundTrip(OP_CLOSE, new Uint8Array(0))[0].payload.length).toBe(0);
  });

  test("payload is masked on the wire (clients must mask)", () => {
    const data = new Uint8Array(64).fill(0);
    const frame = encodeFrame(OP_BIN, data);
    expect(frame[1] & 0x80).toBe(0x80);
    // 64 zero bytes XOR a random key is almost surely not all zero.
    expect(frame.subarray(6).some((b) => b !== 0)).toBe(true);
  });
});

describe("streaming decoder", () => {
  test("reassembles a frame split across chunks", () => {
    const whole = unmask(encodeFrame(OP_BIN, new Uint8Array(300).fill(9)));
    const dec = new FrameDecoder();
    expect(dec.push(whole.subarray(0, 10))).toEqual([]);
    expect(dec.push(whole.subarray(10, 100))).toEqual([]);
    const done = dec.push(whole.subarray(100));
    expect(done).toHaveLength(1);
    expect(done[0].payload.length).toBe(300);
  });

  test("splitting inside the 2-byte extended length header does not desync", () => {
    const whole = unmask(encodeFrame(OP_BIN, new Uint8Array(500).fill(3)));
    const dec = new FrameDecoder();
    expect(dec.push(whole.subarray(0, 3))).toEqual([]); // mid-length-field
    expect(dec.push(whole.subarray(3))[0].payload.length).toBe(500);
  });

  test("yields multiple frames arriving in one chunk", () => {
    const a = unmask(encodeFrame(OP_TEXT, new TextEncoder().encode("one")));
    const b = unmask(encodeFrame(OP_TEXT, new TextEncoder().encode("two")));
    const merged = new Uint8Array(a.length + b.length);
    merged.set(a); merged.set(b, a.length);
    const frames = new FrameDecoder().push(merged);
    expect(frames).toHaveLength(2);
    expect(new TextDecoder().decode(frames[1].payload)).toBe("two");
  });

  test("a trailing partial frame is buffered, not emitted or lost", () => {
    const a = unmask(encodeFrame(OP_TEXT, new TextEncoder().encode("first")));
    const b = unmask(encodeFrame(OP_TEXT, new TextEncoder().encode("second")));
    const dec = new FrameDecoder();
    const merged = new Uint8Array(a.length + 3);
    merged.set(a); merged.set(b.subarray(0, 3), a.length);
    expect(dec.push(merged)).toHaveLength(1);
    const rest = dec.push(b.subarray(3));
    expect(rest).toHaveLength(1);
    expect(new TextDecoder().decode(rest[0].payload)).toBe("second");
  });

  test("decodes a masked frame too (non-conforming peer)", () => {
    const [f] = new FrameDecoder().push(encodeFrame(OP_TEXT, new TextEncoder().encode("masked")));
    expect(new TextDecoder().decode(f.payload)).toBe("masked");
  });
});
