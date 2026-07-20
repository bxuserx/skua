---
description: Chaos-mode worker — drive one ticket autonomously to validating (used by the chaos supervisor; also runnable by hand)
---

Read `.skua/templates/chaos-work.md` and follow it **exactly** to drive ticket **$ARGUMENTS** through the chaos pipeline.

That template is the full doctrine. The essentials: the ticket board lives at `$SKUA_TICKETS_ROOT` (operate there, not this worktree's `.tickets/`); your code changes go in the current working directory (an isolated `chaos/` worktree); drive the `ticket-manager` pipeline refine → pass-2 → build → test → validate with no user prompts; on a blocking decision either deliberate (spawn 2–3 viewpoint subagents, judge, document) or `mark-stuck` and stop; land in `5-validating/`. **Do not commit, push, or merge** — the supervisor does that.
