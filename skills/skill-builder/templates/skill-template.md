---
name: {{slug}}
description: "{{description}}"
when_to_use: "{{when_to_use}}"
connects_to: {{connects_to}}
kind: {{kind}}
---

# {{Title Case Of Slug}}

One-sentence summary of what this skill does and what it produces.

## When to invoke

- "<trigger phrase 1>" → <op name>
- "<trigger phrase 2>" → <op name>

## When NOT to invoke

- <thing that looks like a trigger but isn't>
- <adjacent skill that handles X instead>

## Procedure

Numbered procedure that Claude follows when this skill is active. Each step should be a directive, not a description — write it as a standing instruction that applies whenever the skill is invoked.

1. **Step name** — what to do, with concrete file paths / commands.
2. **Step name** — …
3. **Step name** — …

## Prerequisites

- Files or tools this skill assumes exist.
- Environment variables or secrets required.
- Other skills that must run first (if any) — also list them in `connects_to:`.

## References

- `${CLAUDE_SKILL_DIR}/references/<file>.md` — what's in it and when to read it.

## After every operation

Always-run wrap-up step (if any) — e.g. "re-run `audit-X` on the modified files".
