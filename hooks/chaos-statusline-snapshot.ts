#!/usr/bin/env bun
// chaos mode — usage-snapshot bridge (statusLine tee) + [CHAOS] badge.
//
// The ONLY live source of Claude plan usage (5-hour / 7-day rate-limit
// windows) is the JSON Claude Code injects on stdin to the `statusLine`
// command. The chaos supervisor is a plain process and can't see that JSON —
// so this drop-in tee persists it to a GLOBAL snapshot, then forwards stdin to
// the user's real statusline command unchanged (so their statusline keeps
// working exactly as before). It also appends a red [CHAOS] badge while a run
// is active, since it already owns the single statusLine slot.
//
// Wire it (the `/chaos` arming ceremony offers this, reversible on stop):
//   "statusLine": { "type": "command",
//     "command": "bun \"<hooks>/chaos-statusline-snapshot.ts\" -- sh \"$HOME/.claude/statusline-command.sh\"" }
//
// Global snapshot path (rate limits are per-account, so one file serves every
// repo's supervisor and any interactive session keeps it warm):
//   ${CLAUDE_CONFIG_DIR:-~/.claude}/.skua-usage-snapshot.json

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

function snapshotPath(): string {
  return join(claudeDir(), ".skua-usage-snapshot.json");
}

// Red [CHAOS] badge when a run is active — folded in here because the snapshot
// tee already owns the single statusLine slot, so it doubles as the mode badge.
function chaosBadge(): string {
  return existsSync(join(claudeDir(), ".chaos-active"))
    ? " \x1b[38;5;196m[CHAOS]\x1b[0m"
    : "";
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const input = await Bun.stdin.text();

// Tap the usage fields, but never let a parse error break the statusline.
try {
  const data = JSON.parse(input);
  const five = num(data?.rate_limits?.five_hour?.used_percentage);
  const week = num(data?.rate_limits?.seven_day?.used_percentage);
  const ctx = num(data?.context_window?.used_percentage);
  if (five !== null) {
    const snap = {
      five_hour_pct: five,
      seven_day_pct: week ?? 0,
      context_pct: ctx ?? 0,
      ts: new Date().toISOString(),
    };
    const p = snapshotPath();
    mkdirSync(join(p, ".."), { recursive: true });
    const tmp = p + ".tmp";
    writeFileSync(tmp, JSON.stringify(snap), "utf8");
    renameSync(tmp, p);
  }
} catch {
  /* best-effort; statusline must still render */
}

// Build the base statusline: forward stdin to the wrapped command (everything
// after `--`) so the user's existing statusline renders unchanged; if none was
// given, emit a minimal line so the tee is usable standalone.
const sep = process.argv.indexOf("--");
const wrapped = sep >= 0 ? process.argv.slice(sep + 1) : process.argv.slice(2);

let base = "";
if (wrapped.length > 0) {
  const proc = Bun.spawn(wrapped, { stdin: new TextEncoder().encode(input), stdout: "pipe" });
  base = await new Response(proc.stdout).text();
  await proc.exited;
} else {
  try {
    const data = JSON.parse(input);
    const dir = data?.cwd || data?.workspace?.current_dir || "";
    const baseName = String(dir).split("/").filter(Boolean).pop() || "";
    const model = data?.model?.display_name || "";
    const five = num(data?.rate_limits?.five_hour?.used_percentage);
    base = [baseName, model && `| ${model}`, five !== null && `| session: ${Math.round(five)}%`]
      .filter(Boolean)
      .join(" ");
  } catch {
    /* nothing to render */
  }
}

process.stdout.write(base.replace(/\s+$/, "") + chaosBadge());
