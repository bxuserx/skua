// Terminal session lifecycle for the dashboard's "terminal" tab.
//
// Each session is a single `ttyd` process listening on a private unix socket,
// running `zellij attach --create skua-<id>` against skua's OWN zellij server
// state (a private ZELLIJ_SOCKET_DIR under cache/terminals/zellij — fully
// isolated from any personal zellij). The detached session outlives ttyd, the
// browser, and a dashboard restart, so the shell — and anything running in it,
// e.g. `claude` — survives disconnects, and reattach replays the visible screen
// (plus server-side scrollback) for free.
//
// WHY ZELLIJ: like tmux, zellij is a second terminal emulator — it parses the
// app's output into its own grid and re-emits to the client. tmux's re-emit
// was proven (byte-level, on a clean stock config) to drop scroll operations
// and fast output, desyncing xterm.js — no configuration fixes it. dtach (the
// interim answer) rendered perfectly as a byte-passthrough but kept no
// server-side scrollback, so reloads needed a client-side restore hack. zellij's
// re-emit passed the same buffer-probes with zero grid diffs (no ghost line, no
// blank bands, no content loss under rapid scroll) AND replays the screen on
// attach — so it is the default. Full history: the skua-terminal skill; the
// dtach implementation survives on branch terminal-dtach. Config lives in
// lib/zellij/ (config.kdl + layouts/skua.kdl — bare pane, locked mode, no
// chrome).
//
// Disk is the source of truth: one JSON record per session under
// .skua/cache/terminals/. In-memory proc handles are best-effort only — a
// `bun --hot` reload drops them while the OS processes keep running, so every
// operation re-derives liveness from the pid + `zellij list-sessions`.
//
// Mirrors the file-backed pattern used for agentic stacks (cache/stacks/).

import { join, isAbsolute, basename } from "node:path";
import { readdir, readFile, writeFile, mkdir, unlink, rm } from "node:fs/promises";
import { existsSync, statSync, lstatSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { REPO_ROOT, PORT } from "../skua.config.ts";
import { createHash, randomUUID } from "node:crypto";

const CACHE_DIR = join(import.meta.dir, "..", "cache", "terminals");
// Per-terminal "live" status files written by the skua_terminal_live.ts hook (state,
// summary, pending notification). A subdir of CACHE_DIR so its `<id>.json` files
// never collide with the session records readAllRecords() scans there.
const LIVE_DIR = join(CACHE_DIR, "live");
// skua's private zellij server state: ZELLIJ_SOCKET_DIR set on every zellij
// (and ttyd→zellij) invocation keeps skua's sessions off the user's default
// zellij entirely.
//
// It CANNOT live under the repo, and it cannot live under $TMPDIR either.
// zellij appends "/contract_version_1/<session>" — 44 bytes for a skua session
// name — to whatever directory it is given, and macOS caps a unix socket path
// (sun_path) at 103 bytes. That leaves 59 bytes for the directory, which rules
// out both of the obvious choices:
//
//   in-repo cache/terminals/zellij   70 bytes under a nested checkout → 114 ✗
//   $TMPDIR/skua-<hash8>             62 bytes on macOS                → 106 ✗
//
// macOS's per-user $TMPDIR is /var/folders/<2>/<44>/T/ — 48 bytes before we add
// anything. Fine for the ttyd socket below (no contract_version_1 segment), too
// long here. /tmp is the only base short enough, and it is exactly what zellij's
// own "socket path is too long" message recommends.
//
// /tmp is world-writable, so the directory is created 0700 and validated before
// use (see ensurePrivateDir). /tmp's sticky bit stops another user renaming ours
// away; the validation stops us adopting one they pre-created at our path, which
// is predictable from the repo path.
//
// The uid is in the hash, not just the repo path: two users with the same
// checkout path on one machine would otherwise land on the same directory, and
// the second one would be permanently locked out by the ownership check rather
// than simply getting their own.
const REPO_HASH = createHash("sha256")
  .update(`${REPO_ROOT}\0${process.getuid?.() ?? 0}`)
  .digest("hex")
  .slice(0, 8);
const ZELLIJ_SOCKET_DIR = join("/tmp", `skua-${REPO_HASH}z`);

/** macOS sun_path limit. Linux is 108; the smaller cap keeps paths portable. */
const SUN_PATH_MAX = 103;

/**
 * Create `dir` private to this user, refusing anything we don't own.
 * Synchronous: it guards paths used from zellijEnv(), which has no await point.
 *
 * lstat, NOT stat: stat follows symlinks, so a symlink planted at our path
 * pointing at a directory we happen to own passes an ownership check while
 * redirecting every socket we create into a directory of the attacker's
 * choosing. Verified — a `ln -s` at this path defeated the stat version.
 */
function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) {
    throw new Error(`skua: refusing to use ${dir} — it is a symlink. Remove it and restart.`);
  }
  if (!st.isDirectory()) {
    throw new Error(`skua: refusing to use ${dir} — not a directory. Remove it and restart.`);
  }
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(
      `skua: refusing to use ${dir} — owned by uid ${st.uid}, not ${uid}. ` +
        `Remove it (or whoever owns it) and restart.`,
    );
  }
  // Tighten a directory that exists but is group/other-accessible; mkdir's mode
  // is a no-op when the path is already there.
  if (st.mode & 0o077) chmodSync(dir, 0o700);
}

/**
 * The socket path zellij will build for `name`, and whether it fits.
 * Checked before spawning so a too-deep checkout fails with a path we can act
 * on rather than zellij's own error after the session is half-created.
 */
function zellijSocketPath(name: string): string {
  return join(ZELLIJ_SOCKET_DIR, "contract_version_1", name);
}

// Own the socket dirs before zellij/ttyd can create them for us — otherwise the
// first invocation makes them with the default umask inside world-writable /tmp.
//
// LAZY, and never at module load. Doing this at import time meant any junk at
// the (predictable) /tmp path threw during `import`, which took down the ENTIRE
// dashboard — board, graphs, ADRs, search — over a terminal-only concern.
// Verified: a bare `touch /tmp/skua-<hash>z` and the server never bound a port
// or printed a URL. Deferred to the first zellij/ttyd call, the same failure
// surfaces as an error on the terminals route and nothing else breaks.
let socketDirsReady = false;
function ensureSocketDirs(): void {
  if (socketDirsReady) return;
  ensurePrivateDir(ZELLIJ_SOCKET_DIR);
  ensurePrivateDir(SOCK_DIR);
  socketDirsReady = true; // only on success — a failure retries next call
}
// Passed as ZELLIJ_CONFIG_DIR: holds config.kdl AND layouts/skua.kdl, so
// `default_layout "skua"` (the bare no-chrome pane) resolves on every path —
// including ttyd's `attach --create`, which ignores a --layout flag.
const ZELLIJ_CONFIG_DIR = join(import.meta.dir, "zellij");
// Per-session generated ZDOTDIRs (see writeZdot) — the zellij replacement for
// keystroke injection at create time.
const ZDOT_DIR = join(CACHE_DIR, "zdot");
// ttyd listens on a UNIX SOCKET, never a TCP port.
//
// It used to bind 127.0.0.1:7700-7799 with -W (writable) and no credential.
// Loopback is not a trust boundary: a page on any origin could open a WebSocket
// to that port and drive the shell — verified as real RCE from a browser, not
// just a handshake. ttyd's own -c is no help because it authenticates at the
// HTTP upgrade and browsers cannot send Basic auth on a WebSocket.
//
// A unix socket has no browser-reachable surface at all, so the hole closes by
// construction. The dashboard proxies to it (see server.ts /api/terminals/:id/ws),
// which also retires the whole port-allocation subsystem: the alloc/bind TOCTOU,
// orphaned listeners holding ports, and stale clients reconnecting onto a
// recycled port belonging to someone else's shell.
//
// Kept SHORT and out of the repo: macOS caps unix socket paths at 103 bytes, and
// a path under a deep repo root silently blew that limit for zellij.
// Same uid-scoped hash as ZELLIJ_SOCKET_DIR. $TMPDIR is already per-user on
// macOS, but it falls back to shared /tmp when unset, so it gets the same
// ownership validation via ensureSocketDirs().
const SOCK_DIR = join(process.env.TMPDIR || "/tmp", `skua-${REPO_HASH}`);
const sockPath = (id: string): string => join(SOCK_DIR, `${id}.sock`);
// The OUTER client TERM (ttyd -T): the browser terminal is xterm.js, so zellij
// drives it as a stock xterm-256color. Panes inherit the same TERM from the
// creating environment (zellij ships no terminfo of its own).
const TERM = "xterm-256color";

export type TermSession = {
  id: string;
  title: string;
  // User-set tab name (via the rename UI). When present it wins over the
  // auto last-command / dir-basename display title. Absent → auto title.
  customTitle?: string;
  cwd: string;
  /** Absolute path to this session's ttyd unix socket. Replaces the old `port`:
   *  nothing about a terminal is reachable over TCP any more. */
  socket: string;
  pid: number;
  // The skua zellij session name for this session. Liveness of the persistent
  // shell is a non-EXITED `zellij list-sessions` entry.
  zellij: string;
  createdAt: string;
  // Manual vertical position in the tab list, set by drag-to-reorder. Unset
  // sorts after ordered tabs, by createdAt (so a fresh tab lands at the bottom).
  order?: number;
};

// The last-command shell hook, sourced once into each session's shell so it
// records every command line to <id>.cmd (read by readLastCommand for the tab title).
const CMD_HOOK_PATH = join(import.meta.dir, "skua-cmd-hook.sh");

// ── Record IO ─────────────────────────────────────────────────────────────

function recPath(id: string): string {
  return join(CACHE_DIR, `${id}.json`);
}

async function writeRecord(r: TermSession): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(recPath(r.id), JSON.stringify(r, null, 2), "utf8");
}

async function readRecord(id: string): Promise<TermSession | null> {
  try {
    return JSON.parse(await readFile(recPath(id), "utf8")) as TermSession;
  } catch {
    return null;
  }
}

async function removeRecord(id: string): Promise<void> {
  try {
    await unlink(recPath(id));
  } catch {
    /* already gone */
  }
  // Drop the socket file with the record. Every prune path used to delete the
  // record and leave the endpoint behind — that is how nine orphaned ttyds ended
  // up still listening days later, unreachable by any kill switch. A socket
  // outliving its record would leak the same way.
  try {
    await unlink(sockPath(id));
  } catch {
    /* already gone */
  }
}

async function readAllRecords(): Promise<TermSession[]> {
  let files: string[];
  try {
    files = await readdir(CACHE_DIR);
  } catch {
    return [];
  }
  const out: TermSession[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await readFile(join(CACHE_DIR, f), "utf8")) as TermSession);
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

// ── Liveness ──────────────────────────────────────────────────────────────

function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM => the process exists but isn't ours; still "alive".
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

function safeKill(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    /* already dead */
  }
}

// ── zellij plumbing ───────────────────────────────────────────────────────

// Every zellij invocation (and the ttyd that wraps one) gets the private socket
// dir + config dir; SKUA_* ride along so a session created by THIS process
// (eager create, or ttyd's create-on-attach) seeds them into the pane's shell env.
function zellijEnv(id?: string): Record<string, string | undefined> {
  // The chokepoint every zellij AND ttyd spawn passes through, so this is where
  // the socket dirs get created — lazily, never at import time.
  ensureSocketDirs();
  return {
    ...process.env,
    TERM,
    ZELLIJ_SOCKET_DIR,
    ZELLIJ_CONFIG_DIR,
    ...(id
      ? {
          SKUA_TERM_ID: id,
          SKUA_LIVE_DIR: LIVE_DIR,
          SKUA_PORT: dashboardPort(),
          // The session-bootstrap rc (hook + run-once startup command). Present
          // on both the eager create AND ttyd's recreate-on-attach path, so a
          // respawned shell re-sources the hook (its `once` marker is already
          // consumed, so the startup command never doubles).
          ...(existsSync(join(ZDOT_DIR, id, ".zshrc")) ? { ZDOTDIR: join(ZDOT_DIR, id) } : {}),
        }
      : {}),
  };
}

async function zellijRun(args: string[], opts: { cwd?: string; id?: string } = {}): Promise<number> {
  try {
    return await Bun.spawn(["zellij", ...args], {
      cwd: opts.cwd ?? REPO_ROOT,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: zellijEnv(opts.id),
    }).exited;
  } catch {
    return 1;
  }
}

// The persistent shell lives in the detached zellij session: alive = listed and
// not EXITED. (`--no-formatting` strips ANSI so the name compare is exact.)
async function zellijHasSession(name: string | undefined): Promise<boolean> {
  if (!name || !Bun.which("zellij")) return false;
  try {
    const p = Bun.spawn(["zellij", "list-sessions", "--no-formatting"], {
      stdout: "pipe",
      stderr: "ignore",
      env: zellijEnv(),
    });
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out
      .split("\n")
      .some((l) => (l.split(/\s+/)[0] ?? "") === name && !l.includes("EXITED"));
  } catch {
    return false;
  }
}

// ── Spawning ──────────────────────────────────────────────────────────────

/** Resolve once ttyd is actually accepting on `socket`, or false after timeout.
 *
 *  This connects, rather than just stat-ing the path: the old TCP check merely
 *  asked whether *something* held the port, which ttyd satisfied even when the
 *  wrapped command was broken — so a dead terminal still returned 201 and the
 *  tab silently vanished on the next poll. */
async function waitForSocket(socket: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(socket)) {
      try {
        const probe = await Bun.connect({ unix: socket, socket: { data() {}, error() {} } });
        probe.end();
        return true;
      } catch {
        /* socket file exists but nothing is accepting yet — keep waiting */
      }
    }
    await Bun.sleep(40);
  }
  return false;
}

// The port the dashboard actually bound to. server.ts sets SKUA_PORT after its
// bind loop, which may have WALKED past a busy base PORT (e.g. a skua from another
// repo). Seed it into each terminal so an in-session `claude` — and the `/fork`
// script — reach THIS dashboard, not a same-config instance on the base port.
// Falls back to the configured PORT (e.g. the reconcile path at module load, before
// the server has bound).
function dashboardPort(): string {
  return process.env.SKUA_PORT || String(PORT);
}

// Create the detached zellij session (daemon) that owns the shell's pty.
// `attach --create-background` starts the session without a client; the pane's
// shell inherits cwd + the SKUA_*/TERM env from this spawn. Best-effort on
// older zellij (no --create-background): returns false and ttyd's
// `attach --create` creates the session on first connect instead.
async function spawnMaster(name: string, cwd: string, id: string): Promise<boolean> {
  await mkdir(ZELLIJ_SOCKET_DIR, { recursive: true });
  const rc = await zellijRun(["attach", "--create-background", name], { cwd, id });
  if (rc === 0) {
    // Background creation is async in some versions; give the server a moment.
    for (let i = 0; i < 40; i++) {
      if (await zellijHasSession(name)) return true;
      await Bun.sleep(25);
    }
  }
  return zellijHasSession(name);
}

function ttydArgs(name: string, socket: string, title: string): string[] {
  return [
    "ttyd",
    // -i takes a unix socket path instead of a network interface. No TCP port is
    // opened at all, so there is nothing for a web page to connect to; the
    // dashboard reaches this over the socket and proxies it same-origin.
    "-i", socket,
    "-W",                  // writable / interactive
    "-T", TERM,            // the OUTER client TERM — exactly what xterm.js is
    "-t", "fontSize=14",
    "-t", `titleFixed=${title}`,
    "-t", "disableLeaveAlert=true",
    // Attach to the persistent session; `--create` recreates it (in this ttyd's
    // cwd, with the env below) if it died, so a reconnect always lands somewhere
    // sane. On attach, zellij replays the screen — no client-side restore.
    "zellij", "attach", "--create", name,
  ];
}

// cwd + env matter here (zellij has no tmux-style `-c`/`-e` create flags): if
// the session is gone and ttyd's `attach --create` recreates it, the new pane
// inherits THIS cwd/env.
// Every ttyd this machine's dashboard is responsible for, by pid.
//
// Lives on globalThis, not in a module-level const: `bun --hot` re-executes this
// module on every save, and a fresh Set would forget the ttyds the previous
// module instance spawned — which are still running. Same reasoning as
// __skuaArchiveTimer in server.ts.
declare global {
  var __skuaTtydPids: Set<number> | undefined;
}
const ttydPids = (globalThis.__skuaTtydPids ??= new Set<number>());

function trackTtyd(pid: number | undefined): void {
  if (pid) ttydPids.add(pid);
}

/**
 * Kill every ttyd this dashboard owns. SYNCHRONOUS — it runs from a signal
 * handler, where an async record read would not finish before the process goes.
 *
 * Deliberately does NOT touch the zellij sessions: they are daemons holding the
 * actual shells, and reconcile() respawns ttyd against the survivors on next
 * boot. So this ends the browser-facing endpoint and preserves your work.
 *
 * Without it, exiting the dashboard orphans every ttyd to pid 1, where it keeps
 * listening indefinitely — that is exactly how nine writable ttyds from dead
 * dashboards were found still accepting connections, the oldest two weeks old.
 * Each orphan also holds its unreaped `zellij attach` children forever, since
 * only the parent can reap them.
 */
export function shutdownTtyds(): number {
  let killed = 0;
  for (const pid of ttydPids) {
    if (!pidAlive(pid)) continue;
    safeKill(pid);
    killed++;
  }
  ttydPids.clear();
  return killed;
}

function spawnTtyd(name: string, socket: string, cwd: string, title: string, id: string) {
  const proc = Bun.spawn(ttydArgs(name, socket, title), {
    cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: zellijEnv(id),
  });
  proc.unref(); // don't let the child keep the dashboard's event loop alive
  trackTtyd(proc.pid);
  return proc;
}

// Kill the zellij session (which ends the shell + anything in it), then delete
// its (dead) entry so the name never lingers in list-sessions. Best-effort.
async function killMaster(name: string | undefined): Promise<void> {
  if (!name) return;
  await zellijRun(["kill-session", name]);
  await zellijRun(["delete-session", "--force", name]);
}

// ── session bootstrap (generated ZDOTDIR) ─────────────────────────────────
// zellij `action write-chars` reaches a pane ONLY while a client is attached —
// verified on 0.44.3: against a detached session it exits 0 and silently drops
// the bytes. So the tmux/dtach trick of typing the hook + startup command into
// the fresh shell CANNOT work here (sessions are created detached, before any
// browser attaches). Instead each session gets a generated ZDOTDIR whose
// .zshrc chains the user's own ~/.zshrc, sources the last-command hook, and
// runs the startup command ONCE — a `once` marker consumed on first shell
// start, so a ttyd recreate-on-attach re-sources the hook but never re-runs
// the command. zsh-only by design (any other $SHELL just gets a bare shell).

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function zdotPath(id: string): string {
  return join(ZDOT_DIR, id);
}

async function writeZdot(id: string, command?: string): Promise<void> {
  if (basename(process.env.SHELL || "/bin/zsh") !== "zsh") return;
  const dir = zdotPath(id);
  await mkdir(dir, { recursive: true });
  const cmd = command && command.trim();
  const once = join(dir, "once");
  const lines = [
    "# skua: generated session bootstrap — chains your zsh, wires the",
    "# last-command hook, runs the startup command once. Safe to delete.",
    "unset ZDOTDIR",
    '[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc"',
    ...(existsSync(CMD_HOOK_PATH) ? [`[ -f ${shq(CMD_HOOK_PATH)} ] && source ${shq(CMD_HOOK_PATH)}`] : []),
    ...(cmd
      ? [`if [ -f ${shq(once)} ]; then`, `  command rm -f ${shq(once)}`, `  ${cmd}`, `fi`]
      : []),
    "",
  ];
  await writeFile(join(dir, ".zshrc"), lines.join("\n"), "utf8");
  if (cmd) await writeFile(once, "", "utf8");
}

async function removeZdot(id: string): Promise<void> {
  try {
    await rm(zdotPath(id), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

// ── Live status (hook-written) ──────────────────────────────────────────────

export type TermLive = {
  state?: "working" | "attention" | "idle";
  summary?: string | null;
  notification?: { type: string; message: string; id: string; at: string } | null;
  // The Claude session id running in this terminal (recorded by the
  // skua_terminal_live.ts hook). Lets the dashboard fork it from the outside.
  sessionId?: string | null;
};

// Read the live status the skua_terminal_live.ts hook keeps for a session, or null
// when there's no Claude/hook activity.
export async function readLive(id: string): Promise<TermLive | null> {
  try {
    return JSON.parse(await readFile(join(LIVE_DIR, `${id}.json`), "utf8")) as TermLive;
  } catch {
    return null;
  }
}

async function removeLive(id: string): Promise<void> {
  for (const f of [`${id}.json`, `${id}.cmd`]) {
    try {
      await unlink(join(LIVE_DIR, f));
    } catch {
      /* already gone / never existed */
    }
  }
}

// The last command run in this terminal, written by skua-cmd-hook.sh's preexec
// hook. Whitespace-collapsed and length-capped for a tab label; null if the shell
// hasn't run a command yet (or isn't a skua-hooked shell).
export async function readLastCommand(id: string): Promise<string | null> {
  try {
    const s = (await readFile(join(LIVE_DIR, `${id}.cmd`), "utf8")).replace(/\s+/g, " ").trim();
    return s ? s.slice(0, 80) : null;
  } catch {
    return null;
  }
}

function resolveCwd(input?: string): string {
  const home = homedir();
  let c = (input ?? "").trim();
  if (!c) return home; // empty default → home (~)
  if (c === "~") c = home;
  else if (c.startsWith("~/")) c = join(home, c.slice(2));
  if (!isAbsolute(c)) c = join(home, c);
  if (!existsSync(c)) throw new Error(`directory not found: ${c}`);
  if (!statSync(c).isDirectory()) throw new Error(`not a directory: ${c}`);
  return c;
}

// ── Public API ────────────────────────────────────────────────────────────

export async function listSessions(): Promise<Array<TermSession & { alive: boolean }>> {
  const recs = await readAllRecords();
  const out: Array<TermSession & { alive: boolean }> = [];
  for (const r of recs) {
    // Record from another persistence branch (dtach/tmux-era: no zellij name):
    // retire it from the dashboard. Its master, if any, is left alone.
    if (!r.zellij) { await removeRecord(r.id); continue; }
    // A session is live while its ttyd process runs. Only prune when BOTH ttyd
    // and its zellij session are gone (truly closed) — and never kill a live
    // process from a read. A dead ttyd whose session survived is kept as
    // alive:false; startup reconcile respawns ttyd for it.
    if (pidAlive(r.pid)) { out.push({ ...r, alive: true }); continue; }
    if (await zellijHasSession(r.zellij)) { out.push({ ...r, alive: false }); continue; }
    await removeRecord(r.id);
    await removeLive(r.id);
    await removeZdot(r.id);
  }
  out.sort((a, b) => {
    const ao = a.order ?? Number.MAX_SAFE_INTEGER;
    const bo = b.order ?? Number.MAX_SAFE_INTEGER;
    return ao - bo || a.createdAt.localeCompare(b.createdAt);
  });
  return out;
}

export async function createSession(opts: { cwd?: string; title?: string; command?: string } = {}): Promise<TermSession> {
  if (!Bun.which("ttyd")) throw new Error("ttyd not found — install it with: brew install ttyd");
  if (!Bun.which("zellij")) throw new Error("zellij not found — install it with: brew install zellij");

  const cwd = resolveCwd(opts.cwd);

  // Random suffix, not just Date.now(): two creates in the same millisecond used
  // to produce the same id, and the id now names the socket and the zellij
  // session — a collision would mean two ttyds fighting over one socket path.
  const id = `term-${Date.now().toString(36)}${randomUUID().slice(0, 6)}`;
  const zellij = `skua-${id}`;
  const socket = sockPath(id);
  // Fail here, with the numbers, rather than letting zellij die mid-create with
  // its own "socket path is too long" after the session record already exists.
  for (const [what, path] of [["zellij", zellijSocketPath(zellij)], ["ttyd", socket]] as const) {
    if (Buffer.byteLength(path) > SUN_PATH_MAX) {
      throw new Error(
        `skua: ${what} socket path is ${Buffer.byteLength(path)} bytes, over the ` +
          `${SUN_PATH_MAX}-byte limit:\n  ${path}\nMove the checkout to a shorter path.`,
      );
    }
  }
  ensureSocketDirs();
  const title = (opts.title && opts.title.trim().slice(0, 60)) || basename(cwd) || "terminal";

  // Write the session-bootstrap rc FIRST — the pane's shell reads it at start
  // (user zsh + last-command hook + run-once startup command, e.g. a forked
  // `claude --resume … --fork-session`) — then create the detached session
  // eagerly so the shell and its persistence exist before any browser
  // attaches; ttyd simply attaches. If eager creation fails (older zellij),
  // ttyd's `attach --create` creates the session on first connect with the
  // same env, so the bootstrap still runs there.
  await writeZdot(id, opts.command);
  await spawnMaster(zellij, cwd, id);

  const proc = spawnTtyd(zellij, socket, cwd, title, id);
  if (!(await waitForSocket(socket, 2500))) {
    try { proc.kill(); } catch { /* noop */ }
    await killMaster(zellij);
    throw new Error(
      "ttyd failed to start (socket never appeared) — check that ttyd and zellij are installed",
    );
  }

  const rec: TermSession = {
    id, title, cwd, socket,
    pid: proc.pid ?? 0,
    zellij,
    createdAt: new Date().toISOString(),
  };
  await writeRecord(rec);
  return rec;
}

/** One session record by id, or null. Used by the dashboard's WebSocket proxy to
 *  resolve a terminal's unix socket before dialling it. */
export async function getSession(id: string): Promise<TermSession | null> {
  return readRecord(id);
}

export async function killSession(id: string): Promise<{ ok: true }> {
  const r = await readRecord(id);
  if (!r) return { ok: true };
  if (pidAlive(r.pid)) safeKill(r.pid); // ttyd
  await killMaster(r.zellij); // the zellij session + shell
  await removeRecord(id);
  await removeLive(id);
  await removeZdot(id);
  return { ok: true };
}

// The kill switch (the repurposed redraw button). Tears down EVERY skua terminal
// — reaps each ttyd and each zellij session, then sweeps the private socket dir
// — and clears all session records + live files for a clean slate. skua's
// sessions live in their own ZELLIJ_SOCKET_DIR, so the user's zellij sessions
// are never touched. Returns how many skua terminals were cleared.
// (Per-session healing lives in reconcile().)
export async function killAllSessions(): Promise<{ ok: boolean; killed: number }> {
  const recs = await readAllRecords();
  for (const r of recs) {
    if (pidAlive(r.pid)) safeKill(r.pid);
    await killMaster(r.zellij);
    await removeRecord(r.id);
    await removeLive(r.id);
    await removeZdot(r.id);
  }
  // Catch any session leaked without a record (private socket dir = skua-only).
  await zellijRun(["kill-all-sessions", "--yes"]);
  return { ok: true, killed: recs.length };
}

// Set (or clear, with an empty string) the user-chosen tab name. A custom name
// overrides the auto last-command / dir-basename title in the dashboard.
export async function renameSession(id: string, title: string): Promise<TermSession | null> {
  const r = await readRecord(id);
  if (!r) return null;
  const t = title.trim().slice(0, 60);
  if (t) r.customTitle = t;
  else delete r.customTitle;
  await writeRecord(r);
  return r;
}

// Persist the tab list's vertical order. `ids` is the new top-to-bottom order
// from the dashboard's drag-reorder; each listed session's `order` is set to its
// index. Records not in `ids` (or already at that index) are left untouched, so
// only what actually moved is rewritten.
export async function reorderSessions(ids: string[]): Promise<void> {
  const pos = new Map(ids.map((id, i) => [id, i]));
  for (const r of await readAllRecords()) {
    const p = pos.get(r.id);
    if (p == null || r.order === p) continue;
    r.order = p;
    await writeRecord(r);
  }
}

// Kill any live ttyd for this session and start a fresh one attached to the
// surviving zellij session, reusing the old port when it's free. Returns the
// updated record, or null when the session is gone (record dropped) or ttyd
// failed. Used by reconcile() to replace a dead ttyd WITHOUT touching the
// session, so the shell and any running `claude` are preserved.
async function respawnTtyd(r: TermSession): Promise<TermSession | null> {
  if (pidAlive(r.pid)) safeKill(r.pid);
  if (!(await zellijHasSession(r.zellij))) { await removeRecord(r.id); return null; }
  if (!Bun.which("ttyd")) return null;
  // The socket path is derived from the (stable) session id, so a respawn always
  // reuses it — no reallocation, and therefore no way for an open dashboard tab
  // to end up pointing at a stale endpoint. A dead ttyd can leave the socket
  // file behind; ttyd will not bind over it, so clear it first.
  const socket = r.socket ?? sockPath(r.id);
  ensureSocketDirs();
  await unlink(socket).catch(() => {});
  const proc = spawnTtyd(r.zellij, socket, r.cwd, r.title, r.id);
  if (!(await waitForSocket(socket, 2500))) { try { proc.kill(); } catch { /* noop */ } return null; }
  const updated: TermSession = { ...r, socket, pid: proc.pid ?? 0 };
  await writeRecord(updated);
  return updated;
}

// Run at module load (and on every `bun --hot` reload). When ttyd processes
// survived the reload their pids are still alive, so this is a no-op for them.
// After a full dashboard restart, ttyd may have died while the zellij session
// (a daemon) kept the shell alive — respawn ttyd against the surviving session
// so the terminal reconnects on next list/iframe load. Records from other
// persistence branches (no zellij name) are dropped from the dashboard.
async function reconcile(): Promise<void> {
  if (!Bun.which("zellij")) return;
  // Sessions created before ZELLIJ_SOCKET_DIR moved to /tmp are invisible to us
  // now — their daemons keep running and holding shells, and the loop below
  // prunes their records, so nothing would ever mention them again. Say so once
  // at startup rather than leaving them to accumulate silently; the sweep is
  // opt-in because those shells may still have work in them.
  if (existsSync(join(CACHE_DIR, "zellij"))) {
    console.warn(
      "skua: found a legacy in-repo zellij socket dir — sessions created before the\n" +
        "      socket-path fix are stranded. Review with: bun run sweep:legacy-zellij",
    );
  }
  for (const r of await readAllRecords()) {
    if (!r.zellij) { await removeRecord(r.id); continue; } // dtach/tmux-era record
    // Records written before terminals moved to unix sockets carry a `port` and
    // no `socket`. Their ttyd is a live TCP listener the proxy cannot dial — and
    // is exactly the browser-reachable shell we are closing off — so replace it
    // even though the pid is alive. The zellij session survives, so the shell and
    // anything running in it are preserved across the swap.
    if (!r.socket) {
      try {
        await respawnTtyd(r);
      } catch {
        /* leave the record; listSessions will report it not-alive */
      }
      continue;
    }
    // ttyd alive — nothing to respawn, but it still has to be adopted so
    // shutdownTtyds() can reach it. These are the ttyds that survived a hot
    // reload or an unclean exit; missing them here is precisely how one becomes
    // an orphan on the NEXT shutdown.
    if (pidAlive(r.pid)) { trackTtyd(r.pid); continue; }
    if (!(await zellijHasSession(r.zellij))) { await removeRecord(r.id); await removeLive(r.id); await removeZdot(r.id); continue; }
    try {
      await respawnTtyd(r);
    } catch {
      /* leave the record; listSessions will report it not-alive */
    }
  }
}

reconcile().catch(() => { /* best-effort */ });
