// Terminal session lifecycle for the dashboard's "terminal" tab.
//
// Each session is a single `ttyd` process bound to 127.0.0.1 on its own port,
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
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { REPO_ROOT, PORT } from "../skua.config.ts";
import { allocPort, portFree, waitForPortOccupied } from "./ports.ts";

const CACHE_DIR = join(import.meta.dir, "..", "cache", "terminals");
// Per-terminal "live" status files written by the skua_terminal_live.ts hook (state,
// summary, pending notification). A subdir of CACHE_DIR so its `<id>.json` files
// never collide with the session records readAllRecords() scans there.
const LIVE_DIR = join(CACHE_DIR, "live");
// skua's private zellij server state: ZELLIJ_SOCKET_DIR set on every zellij
// (and ttyd→zellij) invocation keeps skua's sessions off the user's default
// zellij entirely.
const ZELLIJ_SOCKET_DIR = join(CACHE_DIR, "zellij");
// Passed as ZELLIJ_CONFIG_DIR: holds config.kdl AND layouts/skua.kdl, so
// `default_layout "skua"` (the bare no-chrome pane) resolves on every path —
// including ttyd's `attach --create`, which ignores a --layout flag.
const ZELLIJ_CONFIG_DIR = join(import.meta.dir, "zellij");
// Per-session generated ZDOTDIRs (see writeZdot) — the zellij replacement for
// keystroke injection at create time.
const ZDOT_DIR = join(CACHE_DIR, "zdot");
const HOST = "127.0.0.1";
const PORT_BASE = 7700;
const PORT_MAX = 7799;
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
  port: number;
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

// ── Ports ─────────────────────────────────────────────────────────────────
// portFree / allocPort / waitForPortOccupied live in ./ports.ts (shared with
// the smoke harness); the terminal allocator passes its own 7700–7799 range.

// ── Spawning ──────────────────────────────────────────────────────────────

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

function ttydArgs(name: string, port: number, title: string): string[] {
  return [
    "ttyd",
    "-p", String(port),
    "-i", HOST,            // localhost-only — ttyd defaults to 0.0.0.0
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
function spawnTtyd(name: string, port: number, cwd: string, title: string, id: string) {
  const proc = Bun.spawn(ttydArgs(name, port, title), {
    cwd,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    env: zellijEnv(id),
  });
  proc.unref(); // don't let the child keep the dashboard's event loop alive
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
  const used = new Set((await readAllRecords()).map((r) => r.port));
  const port = await allocPort(used, { start: PORT_BASE, end: PORT_MAX });
  if (port == null) throw new Error(`no free port available in ${PORT_BASE}-${PORT_MAX}`);

  const id = `term-${Date.now().toString(36)}`;
  const zellij = `skua-${id}`;
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

  const proc = spawnTtyd(zellij, port, cwd, title, id);
  if (!(await waitForPortOccupied(port, 2500))) {
    try { proc.kill(); } catch { /* noop */ }
    await killMaster(zellij);
    throw new Error("ttyd failed to start (port never opened) — check that ttyd and zellij are installed");
  }

  const rec: TermSession = {
    id, title, cwd, port,
    pid: proc.pid ?? 0,
    zellij,
    createdAt: new Date().toISOString(),
  };
  await writeRecord(rec);
  return rec;
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
  const used = new Set((await readAllRecords()).map((x) => x.port).filter((p) => p !== r.port));
  const port = (await portFree(r.port)) ? r.port : await allocPort(used, { start: PORT_BASE, end: PORT_MAX });
  if (port == null) return null;
  const proc = spawnTtyd(r.zellij, port, r.cwd, r.title, r.id);
  if (!(await waitForPortOccupied(port, 2500))) { try { proc.kill(); } catch { /* noop */ } return null; }
  const updated: TermSession = { ...r, port, pid: proc.pid ?? 0 };
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
  for (const r of await readAllRecords()) {
    if (!r.zellij) { await removeRecord(r.id); continue; } // dtach/tmux-era record
    if (pidAlive(r.pid)) continue; // ttyd alive — nothing to do
    if (!(await zellijHasSession(r.zellij))) { await removeRecord(r.id); await removeLive(r.id); await removeZdot(r.id); continue; }
    try {
      await respawnTtyd(r);
    } catch {
      /* leave the record; listSessions will report it not-alive */
    }
  }
}

reconcile().catch(() => { /* best-effort */ });
