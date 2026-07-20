#!/usr/bin/env bun
/**
 * Per-terminal live status for skua's Terminal tab.
 *
 * Wired to UserPromptSubmit + Stop + Notification in .claude/settings.json. The
 * skua dashboard can't see inside a terminal (ttyd streams I/O straight to the
 * browser), so instead of scraping the terminal or calling an API, it reads a
 * tiny JSON file this hook keeps up to date — what the session is working on,
 * its coarse state, and any pending user decision.
 *
 *   UserPromptSubmit  -> state=working; summary = a few words of the prompt; clear
 *                        any stale notification (a new turn supersedes a wait).
 *   Stop              -> state=idle; clear notification (keep summary so the tab
 *                        still shows what it last worked on).
 *   Notification      -> state=attention; store the message Claude is waiting on,
 *                        with a fresh id the UI dedupes dismissal on.
 *
 * Inert unless SKUA_TERM_ID + SKUA_LIVE_DIR are set — skua injects those into
 * the zellij session it owns, so this is a silent no-op in any other Claude
 * session. Purely observational (never returns a `decision`), so it can't
 * interfere with other hooks on the same event. Fails OPEN on any error.
 *
 * State: $SKUA_LIVE_DIR/$SKUA_TERM_ID.json (read by app/.skua/server.ts).
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

type Notification = { type: string; message: string; id: string; at: string };
type Live = {
  id: string;
  state?: "working" | "attention" | "idle";
  summary?: string | null;
  notification?: Notification | null;
  sessionId?: string | null;
  updatedAt?: string;
};

// A short echo of the user's own ask — the simplest "what is this session
// working on" signal, with no LLM/API in the loop. Kept generous (the sidebar
// sub-line clips to one line via CSS; the tab hovercard shows the full string),
// so raising this cap only grows what the hovercard reveals, not the tab row.
function toSummary(prompt: string): string {
  return prompt.replace(/\s+/g, " ").trim().split(" ").slice(0, 40).join(" ").slice(0, 240);
}

function load(path: string): Live | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Live;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const termId = process.env.SKUA_TERM_ID;
  const liveDir = process.env.SKUA_LIVE_DIR;
  if (!termId || !liveDir) process.exit(0); // not a skua-owned terminal → inert

  let data: any;
  try {
    data = JSON.parse(await Bun.stdin.text());
  } catch {
    process.exit(0);
  }

  const event = data.hook_event_name || "";
  const file = join(liveDir, `${termId}.json`);
  const st: Live = load(file) ?? { id: termId };
  st.id = termId;
  // Record the Claude session id so the dashboard can fork THIS terminal from the
  // outside — it can't read the session's CLAUDE_CODE_SESSION_ID env directly.
  // session_id is present on every hook payload; keep the last value if one omits it.
  st.sessionId = (typeof data.session_id === "string" && data.session_id) || st.sessionId || null;

  if (event === "UserPromptSubmit") {
    const prompt = String(data.prompt ?? "").trim();
    st.state = "working";
    st.summary = toSummary(prompt) || st.summary || null;
    st.notification = null;
  } else if (event === "Stop") {
    if (data.stop_hook_active) process.exit(0); // loop-safe, mirrors skill_reflect
    st.state = "idle";
    st.notification = null;
  } else if (event === "Notification") {
    st.state = "attention";
    st.notification = {
      type: String(data.notification_type ?? ""),
      message: String(data.message ?? "").trim(),
      id: `n-${Date.now()}`,
      at: new Date().toISOString(),
    };
  } else {
    process.exit(0); // event we don't track
  }

  st.updatedAt = new Date().toISOString();
  try {
    mkdirSync(liveDir, { recursive: true });
    writeFileSync(file, JSON.stringify(st));
  } catch {
    // best-effort: a missed update only means one stale tab, never a wedged session
  }
  process.exit(0);
}

// Fail OPEN on any unexpected error — a status hook must never wedge a session.
main().catch(() => process.exit(0));
