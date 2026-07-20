#!/usr/bin/env bun
/**
 * End-of-turn skill/script self-reflection hook (one script, two events).
 *
 * Wired to UserPromptSubmit + Stop in .claude/settings.json. Runs on Bun (already
 * skua's only hard runtime requirement) — no extra interpreter needed.
 *
 *   UserPromptSubmit  -> ARM: a new user turn started; record where it begins in the
 *                        transcript (line count) so Stop can scope "what did this turn do".
 *   Stop              -> if armed AND this turn was SUBSTANTIVE (edited files), block the stop
 *                        ONCE and feed back a short end-of-turn wrap-up with three parts:
 *                        (1) should an EXISTING skill/script/doc be updated with this turn's
 *                        lesson, or — for an action likely to recur 2+ times (a migration, a
 *                        repeated refactor, a multi-file generator) — should a NEW skill exist
 *                        (ask first)?; (2) a one-sentence summary of what the turn did for the
 *                        user (the actual work, ignoring any skill/script housekeeping from
 *                        part 1); and (3) a one-sentence list of action items the user should
 *                        review, if any. Conversational / read-only turns pass through silently.
 *
 * Loop-safe: `armed` is set only by a real user prompt and cleared on the first Stop, so the
 * reflection continuation this triggers cannot re-trigger itself. `stop_hook_active` is honored
 * too. Fails OPEN on any error (never wedges a session).
 *
 * State: $TMPDIR/claude-skill-reflect-<session_id>.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STATE_DIR = process.env.TMPDIR || "/tmp";
// File edits are the unambiguous "did substantive work" signal. Read-only / conversational
// turns (no edits) pass through silently — keep this conservative so the wrap-up doesn't
// fire on a pure `git status` or `grep` turn.
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Kept as tight as the three-part ask allows: Claude Code prints a blocking Stop hook's full
// `reason` to the terminal, so every extra line is console noise. The full skill criteria
// (LESSON -> existing asset; NEW skill on the >=2x rule, ask first) live in CLAUDE.md; part 1
// here is just the trigger, biased to "nothing" unless clearly reusable. Parts 2-3 add a
// one-sentence turn summary + an action-items line for the user, both ignoring part 1.
const REFLECTION =
  "[skill-reflect] One-time end-of-turn wrap-up — do these in order:\n" +
  "1. Skill/spec: if this turn revealed a REUSABLE lesson an existing skill/spec should " +
  "encode, or a NEW 2x+ recurring workflow with no skill (ask before creating), do it now; " +
  "otherwise skip this part silently (no 'no learning' line).\n" +
  "2. Then output exactly these two lines, IGNORING any part-1 skill/script housekeeping:\n" +
  "**Summary: <one sentence on what this turn did in response to my prompt>\n\n" +
  "**User Action items: <one sentence of action items I should check, or 'none'>";

function statePath(sessionId: string): string {
  const safe = (sessionId || "default").replace(/[^A-Za-z0-9._-]/g, "_");
  return join(STATE_DIR, `claude-skill-reflect-${safe}.json`);
}

function load(p: string): Record<string, any> {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function save(p: string, st: unknown): void {
  try {
    writeFileSync(p, JSON.stringify(st));
  } catch {
    // best-effort: state loss only means one missed wrap-up, never a wedged session
  }
}

// Mirror Python str.splitlines(): split on line boundaries with no trailing empty element
// for a final newline. Used for BOTH the arm-time line count and the Stop-time slice, so the
// recorded `start` index lines up across the two separate invocations.
function splitLines(text: string): string[] {
  if (text === "") return [];
  const parts = text.split(/\r\n|\r|\n/);
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

function lineCount(path: string): number {
  try {
    return splitLines(readFileSync(path, "utf8")).length;
  } catch {
    return 0;
  }
}

// True if any assistant tool_use since `start` line was a file edit (Edit/Write/MultiEdit/
// NotebookEdit). File edits are the deliberate "did substantive work" signal; Bash-only turns
// (git status, grep, tests) intentionally do NOT count, so the wrap-up stays quiet.
function turnWasSubstantive(path: string, start: number): boolean {
  let lines: string[];
  try {
    lines = splitLines(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  for (const ln of lines.slice(Math.max(0, start))) {
    let rec: any;
    try {
      rec = JSON.parse(ln);
    } catch {
      continue;
    }
    const msg = rec?.message;
    const content = msg && typeof msg === "object" ? msg.content : null;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (!b || typeof b !== "object" || b.type !== "tool_use") continue;
      if (EDIT_TOOLS.has(b.name)) return true;
    }
  }
  return false;
}

async function main(): Promise<void> {
  let data: any;
  try {
    data = JSON.parse(await Bun.stdin.text());
  } catch {
    process.exit(0);
  }

  const event = data.hook_event_name || "";
  const sessionId = data.session_id || process.env.CLAUDE_SESSION_ID || "default";
  const sp = statePath(sessionId);
  const transcript = data.transcript_path || "";

  if (event === "UserPromptSubmit") {
    save(sp, { armed: true, start: lineCount(transcript) });
    process.exit(0);
  }

  if (event === "Stop") {
    if (data.stop_hook_active) process.exit(0);
    const st = load(sp);
    if (!st.armed) process.exit(0);
    st.armed = false; // disarm BEFORE deciding, so we can't loop
    save(sp, st);
    const start = Number(st.start) || 0;
    if (transcript && turnWasSubstantive(transcript, start)) {
      process.stdout.write(
        JSON.stringify({
          decision: "block",
          reason: REFLECTION,
          systemMessage:
            "skill-reflect: end-of-turn wrap-up (skill check + summary + review)",
        }),
      );
    }
    process.exit(0);
  }

  process.exit(0);
}

// Fail OPEN on any unexpected error — a reflection hook must never wedge a session.
main().catch(() => process.exit(0));
