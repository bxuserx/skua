#!/usr/bin/env bun
// Regression probe for the terminal WebSocket proxy's ping/pong keepalive.
//
// ttyd (libwebsockets) PINGs every 5s and closes the connection ~5s later if the
// client never PONGs. server.ts's dialTtyd() answers those pings; if that ever
// regresses, upstreams die on a 10s cycle, the browser reconnects, and every
// keystroke typed during the reconnect gap is silently dropped ("missing
// keystrokes"). This proves the connection survives several ping cycles AND that
// input still lands afterwards.
//
//   bun scripts/ws-keepalive-probe.ts [dashboardUrl]
//
// Creates a throwaway terminal and deletes it on the way out. Exits non-zero on
// failure.

export {};

const BASE = process.argv[2] ?? "http://127.0.0.1:5174";
const IDLE_MS = 25_000; // past two ping cycles; the bug killed it at 10s
const dec = new TextDecoder();
const enc = new TextEncoder();

const created = (await (
  await fetch(`${BASE}/api/terminals`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ cwd: process.env.HOME, title: "ws-keepalive-probe" }),
  })
).json()) as { id?: string };

const id = created.id;
if (!id) throw new Error(`could not create probe terminal: ${JSON.stringify(created)}`);

let failure: string | null = null;
try {
  await Bun.sleep(1500);

  const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/api/terminals/${id}/ws`, "tty");
  ws.binaryType = "arraybuffer";
  let closed = false;
  let out = "";
  ws.onclose = () => { closed = true; };
  ws.onmessage = (e) => {
    const u = new Uint8Array(e.data as ArrayBuffer);
    if (u[0] === 0x30) out += dec.decode(u.subarray(1));
  };
  await new Promise<void>((r) => { ws.onopen = () => r(); });
  ws.send(enc.encode(JSON.stringify({ AuthToken: "", columns: 100, rows: 30 })));

  const send = (s: string) => {
    const p = enc.encode(s);
    const m = new Uint8Array(p.length + 1);
    m[0] = 0x30;
    m.set(p, 1);
    ws.send(m);
  };

  await Bun.sleep(IDLE_MS);
  if (closed) throw new Error(`upstream closed during ${IDLE_MS}ms idle — ping/pong keepalive is broken`);

  out = "";
  send("echo KEEPALIVE_OK\r");
  await Bun.sleep(1500);
  if (!/KEEPALIVE_OK/.test(out)) throw new Error(`no shell response after idle; got ${JSON.stringify(out.slice(-200))}`);

  ws.close();
  console.log(`ok — connection survived ${IDLE_MS / 1000}s idle and still accepts input`);
} catch (e) {
  failure = String(e);
} finally {
  await fetch(`${BASE}/api/terminals/${id}`, { method: "DELETE", headers: { origin: BASE } });
}

if (failure) {
  console.error(failure);
  process.exit(1);
}
