// Shared localhost port utilities: find a free port, wait for one to become
// occupied (a server booted), or wait for an HTTP endpoint to answer. Extracted
// from terminals.ts so the terminal allocator AND the smoke harness share one
// implementation instead of two copies. Runtime-agnostic (no Bun-only APIs) so
// it behaves identically whether the caller runs under Bun or Node.

import { createServer } from "node:net";

const DEFAULT_HOST = "127.0.0.1";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** True if nothing is listening on `port` (we could bind it ourselves). */
export function portFree(port: number, host: string = DEFAULT_HOST): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.once("listening", () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

/** First free port in [start, end] not already in `used`, or null if none.
 *  With `randomStart`, the scan begins at a random offset and wraps — so two
 *  near-simultaneous callers in separate processes (e.g. parallel chaos workers
 *  each booting an app to smoke) are unlikely to pick the same port despite the
 *  unavoidable test-then-bind window. */
export async function allocPort(
  used: Set<number>,
  opts: { start: number; end: number; host?: string; randomStart?: boolean },
): Promise<number | null> {
  const span = opts.end - opts.start + 1;
  const offset = opts.randomStart ? Math.floor(Math.random() * span) : 0;
  for (let i = 0; i < span; i++) {
    const p = opts.start + ((offset + i) % span);
    if (used.has(p)) continue;
    if (await portFree(p, opts.host)) return p;
  }
  return null;
}

/** Resolve once something is listening on `port`, or false after `timeoutMs`. */
export async function waitForPortOccupied(
  port: number,
  timeoutMs: number,
  host: string = DEFAULT_HOST,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await portFree(port, host))) return true; // something is listening
    await sleep(80);
  }
  return false;
}

/** Resolve once `url` returns ANY HTTP response (even 404/500 means the server
 *  is up and routing), or false after `timeoutMs`. Preferred over a bare
 *  port-occupied check when we can name a URL — it confirms the HTTP stack, not
 *  just that something grabbed the socket. */
export async function waitForHttpReady(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(2000),
      });
      if (res) return true;
    } catch {
      /* not up yet — keep polling */
    }
    await sleep(150);
  }
  return false;
}
