// What the Terminal tab's status dot is allowed to claim.
//
// The skua_terminal_live.ts hook writes a per-session JSON file; this turns it
// into the handful of facts the browser renders. Kept as a standalone,
// dependency-free module on purpose: it's the contract between the hook and the
// UI, it's pure, and importing it must never drag in server config.

export type TermLive = {
  // "attention" is the pre-2026 spelling of "waiting" — still accepted so a live
  // file written by an older hook doesn't read as a dead session after an upgrade.
  state?: "working" | "waiting" | "idle" | "ended" | "attention";
  // When the session last became something the user has to look at, ISO, or null
  // while it's running. Written by the hook on the working -> needs-you edge.
  awaitingSince?: string | null;
  // Every hook write stamps this, so a session that died mid-turn can be told
  // apart from one that is genuinely still working.
  updatedAt?: string;
  summary?: string | null;
  notification?: { type: string; message: string; id: string; at: string } | null;
  // The Claude session id running in this terminal (recorded by the
  // skua_terminal_live.ts hook). Lets the dashboard fork it from the outside.
  sessionId?: string | null;
};

// How long a "working" session may go without a single hook write before we stop
// believing it. PostToolUse fires on every tool call, so a real turn heartbeats
// constantly; this only trips on a session that was killed, crashed, or was
// Esc-interrupted (none of which fire Stop). Generous, because the cost of being
// wrong is a tab that lies about running, and one long Bash call is not a death.
const WORKING_STALE_MS = 15 * 60_000;

// The shape the dashboard renders from: two bits (running / needs-you) plus the
// two ways we can be unsure. Derived here rather than in the UI so the browser
// never has to infer state from transitions it happened to witness.
export type LiveStatus = {
  status: "working" | "waiting" | "idle" | "ended";
  isClaude: boolean; // a live Claude session owns this terminal right now
  awaitingSince: string | null;
  stale: boolean; // claims to be working, but hasn't checked in
};

export function summarizeLive(live: TermLive | null, now = Date.now()): LiveStatus {
  if (!live?.state) {
    // No hook data at all: a plain shell, or a `claude` started before the hook
    // env was set. Not a Claude session as far as the dot is concerned.
    return { status: "idle", isClaude: false, awaitingSince: null, stale: false };
  }
  const status = live.state === "attention" ? "waiting" : live.state;
  const at = live.updatedAt ? Date.parse(live.updatedAt) : NaN;
  // Only the current hook heartbeats on every tool call, and only it writes
  // awaitingSince — so the field's presence (even as null) is what tells us
  // updatedAt means "last seen alive" rather than "when this turn started". A
  // file from the previous hook is never called stale: there, a 20-minute turn
  // is just a 20-minute turn, and declaring it dead is worse than saying nothing
  // until that repo re-runs setup.sh.
  const heartbeats = live.awaitingSince !== undefined;
  const stale =
    heartbeats && status === "working" && Number.isFinite(at) && now - at > WORKING_STALE_MS;
  return {
    status,
    isClaude: status !== "ended",
    awaitingSince: live.awaitingSince ?? null,
    stale,
  };
}
