#!/usr/bin/env bun
// Stop-hook Firestore reconcile — the interactive-mode leg of skua's layered
// ticket mirror (see .skua/lib/firestore.ts). Programmatic moves already sync
// live via the tickets.ts mutators, and the dashboard + chaos loops reconcile
// while running; this closes the last gap: a ticket you move by hand with Claude
// (the ticket-manager skill uses a plain `mv`) when NEITHER the dashboard NOR a
// chaos run is open. At end of turn it runs a forced, diffed full-board reconcile.
//
// Inert unless a `firestore` block with a projectId exists in skua.config.json —
// a silent no-op that never even spawns Bun in a repo that hasn't opted in.
// Purely a side-effect (never returns a `decision`), so it can't interfere with
// the other Stop hooks. Bounded + fails OPEN: a slow network or any error can
// never wedge the turn. Exit 0 always.
import { readFileSync } from "node:fs";
import { join } from "node:path";

async function main(): Promise<void> {
  let data: any;
  try {
    data = JSON.parse(await Bun.stdin.text());
  } catch {
    process.exit(0);
  }
  if ((data.hook_event_name || "") !== "Stop") process.exit(0);
  if (data.stop_hook_active) process.exit(0); // loop-safe, mirrors the other Stop hooks
  if (process.env.SKUA_FIRESTORE_DISABLE === "1") process.exit(0);

  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // Cheap opt-in gate: only proceed when this repo configured a firestore mirror,
  // so non-firestore repos pay nothing (no Bun subprocess) on every turn.
  try {
    const cfg = JSON.parse(readFileSync(join(root, "skua.config.json"), "utf8")) as {
      firestore?: { projectId?: string };
    };
    if (!cfg.firestore || !String(cfg.firestore.projectId ?? "").trim()) process.exit(0);
  } catch {
    process.exit(0); // no/broken config → inert
  }

  // Run the reconcile through the CLI (it resolves paths + credentials itself).
  // Bounded so a slow network can't wedge the turn; the next trigger converges.
  try {
    const proc = Bun.spawn(["bun", join(root, ".skua", "scripts", "firestore.ts"), "sync", "--quiet"], {
      cwd: root,
      stdout: "ignore",
      stderr: "ignore",
    });
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        /* already exited */
      }
    }, 8000);
    await proc.exited;
    clearTimeout(timer);
  } catch {
    /* best-effort — a missed sync is healed by the next reconcile */
  }
  process.exit(0);
}

// Fail OPEN on any unexpected error — a side-effect hook must never wedge a turn.
main().catch(() => process.exit(0));
