#!/usr/bin/env bun
/**
 * Fork the current Claude conversation into a new skua dashboard terminal.
 *
 * Run from INSIDE a Claude Code session — normally via the `/fork` command, which
 * calls `bun .skua/scripts/fork.ts $ARGUMENTS`. It reads the session's own id
 * from CLAUDE_CODE_SESSION_ID (Claude Code exports it into every session's env),
 * then asks the running dashboard to open a new in-browser terminal that boots
 * `claude --resume <id> --fork-session` — a *divergent* copy carrying the full
 * transcript up to now, in this session's working directory. The argv label (if
 * any) titles the new tab and seeds its first message.
 *
 * The fork reads the parent's transcript from disk and never writes to it, so the
 * still-running parent is untouched; it captures everything up to the last
 * completed turn (an in-flight turn may not yet be flushed).
 */
import { PORT } from "../skua.config.ts";

const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
if (!sessionId) {
  console.error(
    "fork: no CLAUDE_CODE_SESSION_ID in the environment — run this from inside a Claude Code session.",
  );
  process.exit(1);
}

// Reach the dashboard that spawned THIS terminal: it seeds SKUA_PORT with the
// port it actually bound to (which may have walked past a busy base PORT). Fall
// back to the configured PORT when run outside a skua-spawned terminal.
const port = process.env.SKUA_PORT || String(PORT);

const label = process.argv.slice(2).join(" ").trim();
const body = {
  cwd: process.cwd(),
  title: label ? `fork: ${label}` : "fork",
  fork: { sessionId, prompt: label || undefined },
};

const url = `http://127.0.0.1:${port}/api/terminals`;
let res: Response;
try {
  res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
} catch (e) {
  console.error(
    `fork: couldn't reach the skua dashboard at ${url} — is it running? ` +
      `(${e instanceof Error ? e.message : String(e)})`,
  );
  process.exit(1);
}

if (!res.ok) {
  console.error(`fork: dashboard rejected the request (${res.status}): ${await res.text()}`);
  process.exit(1);
}

const rec = (await res.json()) as { id?: string; title?: string };
console.log(
  `Forked this conversation → new dashboard terminal "${rec.title ?? "fork"}" ` +
    `at http://localhost:${port}\n` +
    `It resumes the full history up to now and diverges from here ` +
    `(the in-flight turn may not be included). Open the dashboard's Terminal tab and select it.`,
);
