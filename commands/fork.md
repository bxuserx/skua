---
description: Fork this Claude conversation into a new skua dashboard terminal — a divergent copy carrying the full history up to now, in the same directory. Optional label, e.g. /fork chase the upstream API error
---

Fork the current conversation into a new in-browser skua terminal so a second line of work can proceed independently from here (the classic case: you discover a second problem — an upstream API bug beneath the schema migration you're on — and want to chase it in parallel without losing this context).

Run exactly this once (the `$ARGUMENTS` label titles the new terminal and seeds its first message; it may be empty):

```bash
bun .skua/scripts/fork.ts $ARGUMENTS
```

Then, in one or two lines, tell the user:

- The fork opened as a **new terminal in the skua dashboard** (Terminal tab) — switch there and select it to continue.
- It carries the **full conversation up to now** but **diverges** from this point: messages and edits on either side don't affect the other.
- Because both forks share this working directory (no worktree isolation), avoid having both edit the same files at once.

If the script printed an error instead (e.g. the dashboard isn't running, or there's no `CLAUDE_CODE_SESSION_ID`), relay that plainly rather than claiming success.
