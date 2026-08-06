// Terminal status tests — the two halves of the Terminal tab's status dot.
//
// The state machine lives in the hook (skua_terminal_live.ts), which only ever
// runs as a subprocess fed JSON on stdin, so that's how it's tested here: real
// process, real file, real env. Asserting on the JSON it leaves behind is the
// only way to cover the edges that made the dot lie — a permission answer that
// fired no event, an idle nudge that restamped a tab you'd already read, a
// compaction mid-turn reading as "finished".
//
// summarizeLive() is the other half: the pure mapping from that file to the two
// bits the browser renders.

import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// Deliberately the standalone module, not lib/terminals.ts: importing that would
// pull in skua.config.ts, whose TICKETS_ROOT is a module-scope const, and this
// file loads before lib/tickets.test.ts gets to point it at a temp board.
import { summarizeLive, type TermLive } from "./terminal-status.ts";

// The hook sits in the skua checkout during development and under .claude/hooks
// once installed into a repo. Both layouts are real, so find whichever is here.
const HOOK = [
  resolve(import.meta.dir, "../../../hooks/skua_terminal_live.ts"),
  resolve(import.meta.dir, "../../.claude/hooks/skua_terminal_live.ts"),
].find((p) => existsSync(p));

const SANDBOX = mkdtempSync(join(tmpdir(), "skua-live-"));
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

const TERM_ID = "t-test";
const liveFile = (dir: string) => join(dir, `${TERM_ID}.json`);

// Run the hook once against `dir` with the given payload; return the state file.
async function fire(dir: string, payload: Record<string, unknown>, env: Record<string, string> = {}): Promise<TermLive | null> {
  const proc = Bun.spawn(["bun", HOOK!], {
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: "sess-1", ...payload })),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, SKUA_TERM_ID: TERM_ID, SKUA_LIVE_DIR: dir, ...env },
  });
  expect(await proc.exited).toBe(0); // a status hook must never fail a turn
  try {
    return JSON.parse(readFileSync(liveFile(dir), "utf8")) as TermLive;
  } catch {
    return null;
  }
}

// Each case gets its own live dir so histories can't leak between tests.
let n = 0;
function freshDir(): string {
  const dir = join(SANDBOX, `live-${n++}`);
  return dir;
}

// Guards the describe.if below: if neither layout resolves, every hook test
// would silently vanish and the suite would still report green.
test("the hook under test was found", () => {
  expect(HOOK).toBeTruthy();
});

describe.if(Boolean(HOOK))("skua_terminal_live hook", () => {
  test("a submitted prompt is working, with nothing to read", async () => {
    const dir = freshDir();
    const st = await fire(dir, { hook_event_name: "UserPromptSubmit", prompt: "fix the  status dot" });
    expect(st?.state).toBe("working");
    expect(st?.awaitingSince).toBe(null);
    expect(st?.summary).toBe("fix the status dot");
    expect(st?.sessionId).toBe("sess-1");
  });

  test("a finished turn is idle and stamps awaitingSince", async () => {
    const dir = freshDir();
    await fire(dir, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    const st = await fire(dir, { hook_event_name: "Stop" });
    expect(st?.state).toBe("idle");
    expect(typeof st?.awaitingSince).toBe("string");
  });

  // skua_skill_reflect.ts returns decision:"block" on the first Stop of any turn
  // that edited a file, so on those turns the ONLY Stop that marks the real end
  // of the turn carries stop_hook_active. Ignoring it strands the tab.
  test("the second Stop of a blocked turn still ends the turn", async () => {
    const dir = freshDir();
    await fire(dir, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    await fire(dir, { hook_event_name: "PostToolUse", tool_name: "Edit" });
    await fire(dir, { hook_event_name: "Stop" }); // blocked by skill_reflect
    await fire(dir, { hook_event_name: "PostToolUse", tool_name: "Edit" }); // reflection
    const st = await fire(dir, { hook_event_name: "Stop", stop_hook_active: true });
    expect(st?.state).toBe("idle");
    expect(typeof st?.awaitingSince).toBe("string");
  });

  test("a permission prompt blocks on you and stores the message", async () => {
    const dir = freshDir();
    await fire(dir, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    const st = await fire(dir, {
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      message: "Claude needs your permission to use Bash",
    });
    expect(st?.state).toBe("waiting");
    expect(typeof st?.awaitingSince).toBe("string");
    expect(st?.notification?.message).toBe("Claude needs your permission to use Bash");
  });

  test("answering a permission prompt clears the block — PostToolUse is the only signal", async () => {
    const dir = freshDir();
    await fire(dir, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    await fire(dir, { hook_event_name: "Notification", notification_type: "permission_prompt", message: "may I" });
    const st = await fire(dir, { hook_event_name: "PostToolUse", tool_name: "Bash" });
    expect(st?.state).toBe("working");
    expect(st?.awaitingSince).toBe(null);
    expect(st?.notification).toBe(null);
  });

  test("the 60s idle nudge changes nothing — it must not re-flash a read tab", async () => {
    const dir = freshDir();
    await fire(dir, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    const done = await fire(dir, { hook_event_name: "Stop" });
    const nudged = await fire(dir, {
      hook_event_name: "Notification",
      notification_type: "idle_prompt",
      message: "Claude is waiting for your input",
    });
    expect(nudged?.state).toBe("idle");
    expect(nudged?.awaitingSince).toBe(done?.awaitingSince); // NOT restamped
    expect(nudged?.notification).toBe(null); // and not surfaced as a pending ask
  });

  test("re-entering the SAME needs-you state keeps the original stamp", async () => {
    const dir = freshDir();
    await fire(dir, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    const first = await fire(dir, { hook_event_name: "Stop" });
    await Bun.sleep(5);
    const second = await fire(dir, { hook_event_name: "Stop" });
    expect(second?.awaitingSince).toBe(first?.awaitingSince);
  });

  // idle and waiting are both "needs you", but moving between them is a real new
  // event: you read the finished turn, THEN Claude asked for permission.
  test("a permission prompt after a read turn restamps", async () => {
    const dir = freshDir();
    await fire(dir, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    const done = await fire(dir, { hook_event_name: "Stop" });
    await Bun.sleep(5);
    const blocked = await fire(dir, { hook_event_name: "Notification", notification_type: "permission_prompt", message: "may I" });
    expect(blocked?.state).toBe("waiting");
    expect(blocked?.awaitingSince).not.toBe(done?.awaitingSince);
  });

  test("a second ask while already waiting restamps", async () => {
    const dir = freshDir();
    await fire(dir, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    const first = await fire(dir, { hook_event_name: "Notification", notification_type: "permission_prompt", message: "read a file?" });
    await Bun.sleep(5);
    const second = await fire(dir, { hook_event_name: "Notification", notification_type: "permission_prompt", message: "now run a command?" });
    expect(second?.awaitingSince).not.toBe(first?.awaitingSince);
    expect(second?.notification?.message).toBe("now run a command?");
  });

  // A permission prompt ends three ways. Only one of them is PostToolUse, and
  // missing the other two leaves the tab red for the rest of the turn.
  test.each([
    ["PostToolUse", { tool_name: "Bash" }],
    ["PostToolUseFailure", { tool_name: "Bash" }],
    ["PermissionDenied", { tool_name: "Bash" }],
  ])("%s clears a block", async (event, extra) => {
    const dir = freshDir();
    await fire(dir, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    await fire(dir, { hook_event_name: "Notification", notification_type: "permission_prompt", message: "may I" });
    const st = await fire(dir, { hook_event_name: event, ...extra });
    expect(st?.state).toBe("working");
    expect(st?.awaitingSince).toBe(null);
    expect(st?.notification).toBe(null);
  });

  test("answering an elicitation unblocks it", async () => {
    const dir = freshDir();
    await fire(dir, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    const asked = await fire(dir, { hook_event_name: "Notification", notification_type: "elicitation_dialog", message: "which one?" });
    expect(asked?.state).toBe("waiting");
    const answered = await fire(dir, { hook_event_name: "Notification", notification_type: "elicitation_response", message: "" });
    expect(answered?.state).toBe("working");
    expect(answered?.notification).toBe(null);
  });

  // agent_completed is a BACKGROUND agent finishing, not this turn ending.
  test("a background agent finishing doesn't claim this turn ended", async () => {
    const dir = freshDir();
    const working = await fire(dir, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    const st = await fire(dir, { hook_event_name: "Notification", notification_type: "agent_completed", message: "agent done" });
    expect(st?.state).toBe("working");
    expect(st?.awaitingSince).toBe(working?.awaitingSince);
  });

  test("a nested claude's exit doesn't black out the tab that owns it", async () => {
    const dir = freshDir();
    await fire(dir, { hook_event_name: "UserPromptSubmit", prompt: "go" }); // session sess-1
    const st = await fire(dir, { hook_event_name: "SessionEnd", reason: "other", session_id: "inner-claude-p" });
    expect(st?.state).toBe("working"); // the outer session is still running
    expect(st?.sessionId).toBe("sess-1"); // and still the fork target
  });

  test("an exited session isn't resurrected by a straggler event", async () => {
    const dir = freshDir();
    await fire(dir, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    await fire(dir, { hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
    const st = await fire(dir, { hook_event_name: "PostToolUse", tool_name: "Bash" });
    expect(st?.state).toBe("ended");
  });

  test("a new session revives an ended tab", async () => {
    const dir = freshDir();
    await fire(dir, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    await fire(dir, { hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
    const st = await fire(dir, { hook_event_name: "SessionStart", source: "startup", session_id: "sess-2" });
    expect(st?.state).toBe("idle");
    expect(st?.sessionId).toBe("sess-2");
  });

  test("the state file is replaced atomically — a reader never sees a torn file", async () => {
    const dir = freshDir();
    await fire(dir, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    // Hammer the file while reading it: every read must parse.
    const writes = Array.from({ length: 12 }, (_, i) =>
      fire(dir, { hook_event_name: "PostToolUse", tool_name: `tool-${i}` }),
    );
    for (let i = 0; i < 60; i++) {
      const raw = readFileSync(liveFile(dir), "utf8");
      expect(() => JSON.parse(raw)).not.toThrow();
      await Bun.sleep(2);
    }
    await Promise.all(writes);
    expect(existsSync(liveFile(dir))).toBe(true);
  });

  test("a block AFTER you read a finished turn does restamp", async () => {
    const dir = freshDir();
    await fire(dir, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    const done = await fire(dir, { hook_event_name: "Stop" });
    await fire(dir, { hook_event_name: "UserPromptSubmit", prompt: "next" }); // working again
    await Bun.sleep(5);
    const blocked = await fire(dir, { hook_event_name: "Notification", notification_type: "permission_prompt", message: "may I" });
    expect(blocked?.awaitingSince).not.toBe(done?.awaitingSince);
  });

  test("compaction is mid-turn, not a finished turn", async () => {
    const dir = freshDir();
    await fire(dir, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    const st = await fire(dir, { hook_event_name: "SessionStart", source: "compact" });
    expect(st?.state).toBe("working");
    expect(st?.awaitingSince).toBe(null);
  });

  test("a fresh session is idle with nothing unread", async () => {
    const dir = freshDir();
    await fire(dir, { hook_event_name: "UserPromptSubmit", prompt: "old ask" });
    await fire(dir, { hook_event_name: "Stop" });
    const st = await fire(dir, { hook_event_name: "SessionStart", source: "startup" });
    expect(st?.state).toBe("idle");
    expect(st?.awaitingSince).toBe(null);
    expect(st?.summary).toBe(null); // the previous session's ask is not this one's
  });

  test("a resumed session keeps its summary and stays quiet", async () => {
    const dir = freshDir();
    await fire(dir, { hook_event_name: "UserPromptSubmit", prompt: "old ask" });
    const st = await fire(dir, { hook_event_name: "SessionStart", source: "resume" });
    expect(st?.state).toBe("idle");
    expect(st?.awaitingSince).toBe(null);
    expect(st?.summary).toBe("old ask");
  });

  test("session end stops the tab claiming a live session, but keeps fork data", async () => {
    const dir = freshDir();
    await fire(dir, { hook_event_name: "UserPromptSubmit", prompt: "go" });
    const st = await fire(dir, { hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
    expect(st?.state).toBe("ended");
    expect(st?.awaitingSince).toBe(null);
    expect(st?.sessionId).toBe("sess-1");
    expect(summarizeLive(st!).isClaude).toBe(false);
  });

  test("untracked events and non-skua terminals write nothing", async () => {
    const dir = freshDir();
    expect(await fire(dir, { hook_event_name: "PreCompact" })).toBe(null);
    const bare = freshDir();
    expect(await fire(bare, { hook_event_name: "Stop" }, { SKUA_TERM_ID: "" })).toBe(null);
  });

  test("every write stamps updatedAt, so liveness can be judged", async () => {
    const dir = freshDir();
    const st = await fire(dir, { hook_event_name: "PostToolUse", tool_name: "Read" });
    expect(Date.parse(st!.updatedAt!)).toBeGreaterThan(0);
  });
});

describe("summarizeLive", () => {
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

  test("no hook data is not a Claude session", () => {
    expect(summarizeLive(null)).toEqual({ status: "idle", isClaude: false, awaitingSince: null, stale: false });
    expect(summarizeLive({}).isClaude).toBe(false);
  });

  test("a live working session is running and fresh", () => {
    const s = summarizeLive({ state: "working", updatedAt: iso(1000) });
    expect(s.status).toBe("working");
    expect(s.isClaude).toBe(true);
    expect(s.stale).toBe(false);
  });

  test("working with no check-in for ages is stale, not running", () => {
    expect(
      summarizeLive({ state: "working", awaitingSince: null, updatedAt: iso(60 * 60_000) }).stale,
    ).toBe(true);
  });

  test("waiting never goes stale — a prompt can sit for hours and still be real", () => {
    expect(summarizeLive({ state: "waiting", updatedAt: iso(60 * 60_000) }).stale).toBe(false);
    expect(summarizeLive({ state: "idle", updatedAt: iso(60 * 60_000) }).stale).toBe(false);
  });

  test("a live file from the old hook still reads as a live session", () => {
    // Pre-2026 spelling, and no awaitingSince at all.
    const s = summarizeLive({ state: "attention", updatedAt: iso(1000) } as TermLive);
    expect(s.status).toBe("waiting");
    expect(s.isClaude).toBe(true);
    expect(s.awaitingSince).toBe(null); // nothing to flash about until the next turn
  });

  // The old hook only wrote updatedAt once a turn, so elapsed turn time would
  // masquerade as "stopped reporting". Absence of awaitingSince is the tell.
  test("a long turn recorded by the old hook is not called stale", () => {
    expect(summarizeLive({ state: "working", updatedAt: iso(30 * 60_000) }).stale).toBe(false);
    // ...whereas the current hook, which heartbeats per tool call, is judged.
    expect(
      summarizeLive({ state: "working", awaitingSince: null, updatedAt: iso(30 * 60_000) }).stale,
    ).toBe(true);
  });

  test("missing updatedAt can't be judged stale", () => {
    expect(summarizeLive({ state: "working" }).stale).toBe(false);
  });

  test("an ended session is not a Claude session", () => {
    expect(summarizeLive({ state: "ended", updatedAt: iso(1000) }).isClaude).toBe(false);
  });
});
