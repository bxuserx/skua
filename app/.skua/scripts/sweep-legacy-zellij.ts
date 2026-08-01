#!/usr/bin/env bun
// Sweep zellij daemons stranded by the ZELLIJ_SOCKET_DIR move.
//
// skua used to keep zellij's IPC sockets at <repo>/.skua/cache/terminals/zellij.
// That path is now /tmp/skua-<hash>z, because zellij appends a 44-byte
// "/contract_version_1/<session>" segment and macOS caps a unix socket path at
// 103 bytes — a nested checkout blew the limit and no terminal would start.
//
// The move leaves any session created by the OLD code invisible: its zellij
// daemon is still running and still holding a live shell, but the dashboard now
// looks somewhere else and prunes the record. Nothing ever reaps those daemons,
// so they linger exactly like the orphaned ttyds did.
//
// Default is a DRY RUN. Nothing is killed without --kill, because each daemon
// may hold a shell with work in it.
//
//   bun run scripts/sweep-legacy-zellij.ts           # report only
//   bun run scripts/sweep-legacy-zellij.ts --kill    # kill daemons + remove dir

import { join } from "node:path";
import { readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";

const KILL = process.argv.includes("--kill");
const LEGACY_DIR = join(import.meta.dir, "..", "cache", "terminals", "zellij");
const CONTRACT = join(LEGACY_DIR, "contract_version_1");

/** Sessions the old layout left behind, by socket name. */
async function legacySessions(): Promise<string[]> {
  if (!existsSync(CONTRACT)) return [];
  try {
    return (await readdir(CONTRACT)).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
}

/**
 * pids of `zellij --server <path>` processes whose socket path is under the
 * legacy dir. Matching on the path — not the session name — is what keeps this
 * scoped to THIS repo: another checkout's daemons carry their own path, and a
 * personal `zellij` carries none of ours.
 */
async function legacyDaemons(): Promise<Array<{ pid: number; path: string }>> {
  const proc = Bun.spawn(["ps", "-eo", "pid=,command="], { stdout: "pipe" });
  const out = await new Response(proc.stdout).text();
  const found: Array<{ pid: number; path: string }> = [];
  for (const line of out.split("\n")) {
    const m = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pid, cmd] = m;
    if (!cmd.includes("zellij --server")) continue;
    if (!cmd.includes(LEGACY_DIR)) continue;
    found.push({ pid: Number(pid), path: cmd.slice(cmd.indexOf("zellij --server")) });
  }
  return found;
}

const sessions = await legacySessions();
const daemons = await legacyDaemons();

if (!existsSync(LEGACY_DIR)) {
  console.log("nothing to sweep — no legacy zellij dir in this install.");
  process.exit(0);
}

console.log(`legacy socket dir: ${LEGACY_DIR}`);
console.log(`  stranded session sockets: ${sessions.length}`);
for (const s of sessions) console.log(`    ${s}`);
console.log(`  running daemons under it: ${daemons.length}`);
for (const d of daemons) console.log(`    pid ${d.pid}  ${d.path.slice(0, 90)}`);

if (!KILL) {
  const empty = sessions.length === 0 && daemons.length === 0;
  console.log(
    empty
      ? "\nDry run: nothing live here. Re-run with --kill to remove the empty directory."
      : "\nDry run — nothing killed. Each daemon may hold a shell with work in it;" +
          "\nattach and save anything you need first, then re-run with --kill.",
  );
  process.exit(0);
}

let killed = 0;
for (const d of daemons) {
  try {
    process.kill(d.pid, "SIGTERM");
    killed++;
  } catch {
    /* already gone */
  }
}
// SIGTERM first, then verify — zellij usually goes quietly, but a wedged server
// ignores it and would otherwise be reported as swept while still running.
if (killed) await Bun.sleep(1500);
let stubborn = 0;
for (const d of daemons) {
  try {
    process.kill(d.pid, 0); // liveness probe; throws when the pid is gone
    process.kill(d.pid, "SIGKILL");
    stubborn++;
  } catch {
    /* dead, as intended */
  }
}

await rm(LEGACY_DIR, { recursive: true, force: true });
const gone = !existsSync(LEGACY_DIR);
console.log(
  `\nswept: ${killed} daemon(s) signalled` +
    (stubborn ? `, ${stubborn} needed SIGKILL` : "") +
    `; legacy dir ${gone ? "removed" : "NOT removed — check permissions"}`,
);
if (!gone) process.exit(1);
