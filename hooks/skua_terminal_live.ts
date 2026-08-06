#!/usr/bin/env bun
/**
 * Per-terminal live status for skua's Terminal tab.
 *
 * Wired to UserPromptSubmit + PostToolUse + Stop + Notification + SessionStart +
 * SessionEnd in .claude/settings.json. The skua dashboard can't see inside a
 * terminal (ttyd streams I/O straight to the browser), so instead of scraping the
 * terminal or calling an API, it reads a tiny JSON file this hook keeps up to
 * date — what the session is working on, its coarse state, and any pending user
 * decision.
 *
 * The dashboard renders two bits: is Claude RUNNING, and does it NEED YOU. So the
 * state here is deliberately coarse:
 *
 *   working  — Claude is running (a prompt was submitted, a tool just ran).
 *   waiting  — Claude is blocked ON YOU (permission prompt, elicitation).
 *   idle     — a turn finished; the ball is in your court.
 *   ended    — `claude` exited; this is a plain shell again.
 *
 *   UserPromptSubmit  -> working; summary = a few words of the prompt; clear any
 *                        stale notification (a new turn supersedes a wait).
 *   PostToolUse       -> working. Two jobs: with PostToolUseFailure and
 *   PostToolUseFailure   PermissionDenied it covers every way a permission prompt
 *   PermissionDenied     can end (approved, approved-then-failed, denied), so a
 *                        `waiting` can't sit red for the rest of the turn — a
 *                        denied tool fires NEITHER PostToolUse nor Stop for a
 *                        while, which is why all three are wired; and it
 *                        heartbeats `updatedAt` so the dashboard can tell a live
 *                        turn from a session that died mid-flight.
 *   Stop              -> idle; clear notification (keep summary so the tab still
 *                        shows what it last worked on). Deliberately handled even
 *                        when stop_hook_active is set: a Stop hook elsewhere in
 *                        the chain (skua_skill_reflect) blocks the first Stop of
 *                        any substantive turn, so the SECOND one is the real end
 *                        of the turn. Skipping it strands the tab mid-turn
 *                        forever. This hook never returns a decision, so it has
 *                        no re-entrancy of its own to guard against.
 *   Notification      -> permission/elicitation asks become `waiting` and store the
 *                        message; the matching "answered" notifications go back to
 *                        working; `idle_prompt` (Claude's 60s "still there?" nudge)
 *                        and `agent_completed` (a BACKGROUND agent, not this turn)
 *                        are IGNORED — they say nothing about this session, and
 *                        letting them restamp would re-flash a tab you already read
 *                        or claim a running turn had finished.
 *   SessionStart      -> idle with nothing unread (`compact` means mid-turn, so it
 *                        maps to working instead).
 *   SessionEnd        -> ended. Keeps sessionId + summary so the tab can still be
 *                        forked, but stops the dot from claiming a live session.
 *
 * `awaitingSince` is the moment there became something new to look at. The
 * dashboard compares it with when you last looked at that tab, which is what
 * makes "unread" survive a page reload and never miss a turn that started and
 * finished between two polls.
 *
 * Inert unless SKUA_TERM_ID + SKUA_LIVE_DIR are set — skua injects those into
 * the zellij session it owns, so this is a silent no-op in any other Claude
 * session. Purely observational (never returns a `decision`), so it can't
 * interfere with other hooks on the same event. Fails OPEN on any error.
 *
 * State: $SKUA_LIVE_DIR/$SKUA_TERM_ID.json (read by app/.skua/server.ts).
 */
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";

type State = "working" | "waiting" | "idle" | "ended";
type Notification = { type: string; message: string; id: string; at: string };
type Live = {
  id: string;
  state?: State;
  // When this session last became something you have to look at, or null while
  // it's running. Stamped on the working -> needs-you edge only.
  awaitingSince?: string | null;
  summary?: string | null;
  notification?: Notification | null;
  sessionId?: string | null;
  updatedAt?: string;
};

// Notification types that say nothing about whether THIS session is running: the
// 60s idle nudge, an auth toast, and background-agent chatter (`agent_completed`
// is a teammate agent finishing, not this turn — treating it as "done" would
// claim a running turn had ended).
const IGNORED_NOTIFICATIONS = new Set(["idle_prompt", "auth_success", "agent_completed"]);
// The user answered an elicitation, so Claude is moving again. Without these the
// `waiting` set by `elicitation_dialog` would sit red until the next tool call.
const ANSWERED_NOTIFICATIONS = new Set(["elicitation_complete", "elicitation_response"]);
// Everything else (permission_prompt, elicitation_dialog, agent_needs_input, and
// anything unrecognised) is a block. Unknown types failing to "needs you" is the
// safe direction — a spurious ask beats a missed one.

// Events that mean Claude is running again. All three tool outcomes are here on
// purpose: a permission prompt ends in approve (PostToolUse), approve-then-fail
// (PostToolUseFailure), or deny (PermissionDenied), and only covering the first
// leaves a denied tool showing "blocked on you" for the rest of the turn.
const RUNNING_EVENTS = new Set(["PostToolUse", "PostToolUseFailure", "PermissionDenied"]);

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

const needsYou = (s: State | undefined): boolean => s === "waiting" || s === "idle";

// Move to `next`. awaitingSince is stamped whenever the session ACTUALLY changes
// into a needs-you state, and cleared whenever Claude starts running again.
//
// Deliberately keyed on a state CHANGE rather than "was it already needs-you":
// idle -> waiting is a real event (a finished turn you'd read, then a permission
// prompt) and has to re-flash, while idle -> idle (two Stops in one turn, see the
// header) is not and must not. `fresh` covers the one case a state change can't
// see: a second ask arriving while already waiting is a second thing to answer.
function enter(st: Live, next: State, now: string, fresh = false): void {
  if (!needsYou(next)) {
    st.awaitingSince = null;
  } else if (st.state !== next || fresh || !st.awaitingSince) {
    st.awaitingSince = now;
  }
  st.state = next;
}

// Replace the state file in one step. A plain write truncates first, so a
// dashboard poll landing mid-write reads a torn file, fails to parse, and the tab
// blinks "no Claude session"; worse, the NEXT hook to read it would find garbage
// and start from scratch, losing the sessionId the fork button needs.
function writeAtomic(file: string, data: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, file);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
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
  const now = new Date().toISOString();
  const file = join(liveDir, `${termId}.json`);
  const st: Live = load(file) ?? { id: termId };
  st.id = termId;
  // Record the Claude session id so the dashboard can fork THIS terminal from the
  // outside — it can't read the session's CLAUDE_CODE_SESSION_ID env directly.
  // session_id is present on every hook payload; keep the last value if one omits it.
  const incomingSession = (typeof data.session_id === "string" && data.session_id) || "";
  const ownerSession = st.sessionId ?? null;
  st.sessionId = incomingSession || ownerSession || null;

  // `ended` is sticky: once `claude` has exited, a straggler event from that same
  // session must not resurrect the tab into "working". A genuinely new session
  // announces itself with SessionStart, which is always honoured.
  if (st.state === "ended" && event !== "SessionStart" && (!incomingSession || incomingSession === ownerSession)) {
    process.exit(0);
  }

  if (event === "UserPromptSubmit") {
    const prompt = String(data.prompt ?? "").trim();
    enter(st, "working", now);
    st.summary = toSummary(prompt) || st.summary || null;
    st.notification = null;
  } else if (RUNNING_EVENTS.has(event)) {
    // A tool resolved — approved, failed, or denied — so Claude is moving again
    // and whatever it was blocked on is over. Cheap: no summary churn, just the
    // edge, plus the updatedAt heartbeat that proves the turn is still alive.
    enter(st, "working", now);
    st.notification = null;
  } else if (event === "Stop") {
    // No stop_hook_active guard: this hook never blocks, and the second Stop is
    // the REAL end of any turn another Stop hook chose to block (see the header).
    enter(st, "idle", now);
    st.notification = null;
  } else if (event === "Notification") {
    const type = String(data.notification_type ?? "");
    if (ANSWERED_NOTIFICATIONS.has(type)) {
      enter(st, "working", now);
      st.notification = null;
    } else if (!IGNORED_NOTIFICATIONS.has(type)) {
      // A new ask always restamps, even if we were already waiting — a second
      // prompt is a second thing to answer.
      enter(st, "waiting", now, true);
      st.notification = {
        type,
        message: String(data.message ?? "").trim(),
        id: `n-${Date.now()}`,
        at: now,
      };
    }
    // Ignored types fall through to the updatedAt heartbeat, leaving the state —
    // and crucially awaitingSince — exactly as they were.
  } else if (event === "SessionStart") {
    // `compact` fires mid-turn (auto-compaction), so it must NOT read as "done" —
    // that would flash the tab while Claude is still going.
    const source = String(data.source ?? "");
    if (source === "compact") {
      enter(st, "working", now);
    } else {
      st.state = "idle";
      st.awaitingSince = null; // a fresh/resumed session has nothing unread yet
      st.notification = null;
      if (source === "startup" || source === "clear") st.summary = null; // stale ask
    }
  } else if (event === "SessionEnd") {
    // A nested `claude -p` (spawned by a Bash tool inside this very terminal)
    // inherits SKUA_TERM_ID and says goodbye while the session that OWNS the tab
    // is still mid-turn. Its exit must not black the tab out.
    if (incomingSession && ownerSession && incomingSession !== ownerSession) {
      st.sessionId = ownerSession; // don't let it steal the fork target either
      process.exit(0);
    }
    st.state = "ended";
    st.awaitingSince = null;
    st.notification = null;
  } else {
    process.exit(0); // event we don't track
  }

  st.updatedAt = now;
  try {
    mkdirSync(liveDir, { recursive: true });
    writeAtomic(file, JSON.stringify(st));
  } catch {
    // best-effort: a missed update only means one stale tab, never a wedged session
  }
  process.exit(0);
}

// Fail OPEN on any unexpected error — a status hook must never wedge a session.
main().catch(() => process.exit(0));
