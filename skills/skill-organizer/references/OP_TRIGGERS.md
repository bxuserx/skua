# Op trigger phrases

Extended trigger-phrase index for `skill-organizer`'s 9 ops. The SKILL.md body's `## When to invoke` lists one canonical phrase per op; this file holds the full alternate-phrasing set used by the trigger matcher.

| op | trigger phrases |
|---|---|
| `propose-merge` | "merge X and Y", "is X really a separate skill from Y?", "consolidate the W cluster" |
| `propose-rename` | "should we rename Z?", "is Z's slug honest?", "Z's name is confusing" |
| `propose-retire` | "retire X", "is X still pulling weight?", "X looks dead" |
| `propose-orchestrator-wrap` | "wrap the W family in an orchestrator", "should W cluster have a synthesizer?" |
| `generate-reorg-plan` | "run a full reorg pass", "reorganize the portfolio", "generate the plan" |
| `dry-run-portfolio-scan` | "is the skill portfolio coherent right now?", "quick scan of the skills", "any low-hanging fruit?", "dry-run the reorg" |
| `sweep-connects-to` | "sweep connects_to after the rename", "fix dangling edges from the merge" |
| `audit-naming` | "audit skill naming", "are the high-level slugs consistent?", "check for suffix violations" |
| `audit-edges` | "audit edges", "are connects_to annotations correct?", "check for multi-parent / off-pattern kinds" |

Composition notes:

- `generate-reorg-plan` calls every `propose-*` op internally.
- `dry-run-portfolio-scan` is the read-only sibling of `generate-reorg-plan`.
- `audit-naming` and `audit-edges` are called by `generate-reorg-plan` during its snapshot phase.
