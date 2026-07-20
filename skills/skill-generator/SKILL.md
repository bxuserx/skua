---
name: skill-generator
description: "Cold-start bootstrap for a Claude Code skill portfolio. Introspects a target codebase (deploy units, data layers, cross-cutting concerns) and PROPOSES a customized skill portfolio + harness scaffold as a markdown plan. Child tickets via `ticket-manager.create-ticket` execute the scaffolding through `skill-builder.create-skill`. Consumes `skill-builder.overlap-check` + `skill-builder.audit-all` rather than re-walking `.claude/skills/`. Read-only — never writes SKILL.md files directly."
when_to_use: "User says 'bootstrap a skill portfolio', 'this repo has no skills, scaffold some', 'what skills should this codebase have?', 'are we missing any skill coverage?', 'generate a skill portfolio for X', 'run the skill generator on this repo', 'propose a skill harness', 'cold-start the .claude/skills/ tree'."
connects_to:
  - skill-builder
  - skill-organizer
  - ticket-manager
kind: generator
---

# Skill Generator

Bootstrap skill for a Claude Code skill portfolio. Given a target codebase, this skill introspects the repo, maps observable signals to skill-family candidates, and proposes a customized portfolio as a markdown plan document. Propose-only — never writes SKILL.md files directly.

**v0.2 — agent-first DAG architecture.** v0.1 (the original cold-start build) ran 2 subagents and did synthesis in the parent context. v0.2 runs 5 subagents in a DAG and the parent is pure orchestration. See `references/AGENT_PROMPTS.md` for each agent's prompt skeleton.

## When to invoke

- "bootstrap a skill portfolio for this repo" → `generate-bootstrap-plan`
- "what skills is this codebase missing?" → `generate-bootstrap-plan` (against existing partial portfolio)
- "file tickets for the proposed skills" → `emit-child-tickets` (only after plan approval)

## When NOT to invoke

- Creating a single new skill from scratch → `skill-builder.create-skill`
- Auditing or refactoring an existing portfolio → `skill-organizer`
- Validating frontmatter on an existing skill → `skill-builder.validate-frontmatter`
- Mutating any SKILL.md file directly — this skill PROPOSES; child tickets EXECUTE.
- Auto-applying the plan — never call `ticket-manager.create-ticket` proactively from inside this skill.

## Single-source-of-truth boundary

`skill-generator` does NOT enumerate `.claude/skills/` directly. The 5 inventory primitives live in `skill-builder` (see `.claude/skills/skill-builder/SKILL.md`):

| Primitive | Owner |
|---|---|
| `overlap-check` | `skill-builder` |
| `audit-all` | `skill-builder` |
| `list-orphans` | `skill-builder` |
| `validate-frontmatter` | `skill-builder` |
| `audit-skill` | `skill-builder` |

Every op consumes those primitives' output and adds policy on top. This mirrors the boundary `skill-organizer` enforces (see `.claude/skills/skill-organizer/references/SKILL_OWNERSHIP_BOUNDARIES.md`). Failure mode this prevents: two skills with slightly different regexes producing disagreeing inventories of the same source set.

## v0.2 architecture: the 5-agent DAG

```
generate-bootstrap-plan (parent — orchestration only)
    │
    ├── 1. Explore: introspect-codebase
    │       ↳ walks target repo, returns structured signal report
    │
    ├── 2. general-purpose: verify-cites              (gates downstream)
    │       ↳ grep-validates every file:line in the signal report
    │       ↳ on drift → abort the DAG before synthesis runs
    │
    ├── 3. general-purpose: synthesize-plan
    │       ↳ consumes verified signal report + PORTFOLIO_HEURISTICS
    │       ↳ produces draft plan markdown (portfolio + harness sections)
    │
    ├── 4. general-purpose: validate-plan             (cold-reader judge)
    │       ↳ 4 orthogonal axes (signal fidelity, overlap correctness,
    │         cluster sanity, harness justification)
    │
    └── 5. general-purpose × N: draft-child-tickets   (parallel fan-out)
            ↳ one subagent per proposed-new skill
            ↳ each returns a structured ticket body (Objective + Context + AC)
            ↳ N drafters run in a single message — parallel execution
```

**Thin parent property.** The parent's main-context work during `generate-bootstrap-plan` is limited to:

1. **Orchestration** — spawning agents in the right order; respecting the gate at node 2.
2. **Result aggregation** — collecting each agent's JSON output.
3. **Final rendering** — populating `templates/BOOTSTRAP_PLAN_TEMPLATE.md` with aggregated data.

No heuristic mapping, no synthesis, no per-ticket drafting happens in the parent context. The heuristic-mapping rules in `PORTFOLIO_HEURISTICS.md` are consumed by the synthesize agent (DAG node 3) inline — they do NOT need to be loaded into the parent.

**Why the cite-verifier comes before synthesis.** In an early self-test, the introspection subagent produced one bad cite (claiming a canonical constant at a `file:line` that actually held a weaker inline assignment); synthesis mapped that signal anyway. A pre-synthesis verifier catches such drift early — failed verification aborts the DAG before wasted synthesis work.

**Why drafters fan out in parallel.** Each proposed skill's draft is independent (`auth-flow-audit`'s draft has no dependency on a `cache-sync` skill's). Spawning N drafters in a single message with N concurrent `Agent` tool calls (per the parallel-agent guidance in CLAUDE.md) ≈ N× faster than serial drafting.

**Token-budget tradeoff.** More spawns = more per-call context setup. For `generate-bootstrap-plan` (run rarely — cold-start or annual portfolio review), the spawn overhead is acceptable. For frequently-invoked ops, agent fan-out would be wasteful.

---

## Procedure overview

The user-facing surface is 2 ops. Internal DAG nodes are documented under `generate-bootstrap-plan` and in `references/AGENT_PROMPTS.md`.

| op | trigger phrases | driven by |
|---|---|---|
| `generate-bootstrap-plan` | "bootstrap a skill portfolio", "run the skill generator on this repo", "what skills is this codebase missing?" | 5-agent DAG (this skill orchestrates) |
| `emit-child-tickets` | "file tickets for the proposed skills" (only after user approves the plan) | Parent context (calls `ticket-manager.create-ticket` per drafter output) |

Legacy ops from v0.1 (`introspect-codebase`, `propose-portfolio`, `propose-harness`, `validate-plan`) are no longer user-facing — they're DAG-internal subagent calls.

---

## Operation: generate-bootstrap-plan

The top-level entrypoint. Walks the target repo via subagents and produces a markdown bootstrap plan.

### Procedure

For each step, the parent issues a single `Agent` tool call (or N parallel calls for the drafter fan-out) using the prompt skeletons in `references/AGENT_PROMPTS.md`. The parent aggregates JSON outputs between steps and ONLY does the orchestration / aggregation / final-render work itself.

1. **Spawn Explore subagent — `introspect-codebase`.**
   - Prompt skeleton: `references/AGENT_PROMPTS.md` § "introspect".
   - Inputs: the introspection-signature catalog from `references/INTROSPECTION_SIGNATURES.md`, the target repo root path, the structured-output schema.
   - Output: JSON signal report (deploy units, data layers, cross-cutting concerns, deploy targets, notes).
   - Cache the report at `cache/plans/_signals/<target>-<YYYYMMDD>.json`.
   - **On empty report** (no signals found) → surface "repo too sparse for a skill portfolio" to user and stop. Do NOT fabricate signals.

2. **Spawn general-purpose subagent — `verify-cites`.** (GATE — DAG aborts on fail.)
   - Prompt skeleton: `references/AGENT_PROMPTS.md` § "verify-cites".
   - Inputs: the cached signal report.
   - Output: `{pass: bool, failed_cites: [{cite, reason}], notes}`.
   - **On `pass: false`** → write the failure to `cache/plans/_stuck/<target>-<YYYYMMDD>-cite-verification.md` and surface to user. Do NOT proceed to synthesis.
   - **On `pass: true`** → continue to step 3.

3. **Spawn general-purpose subagent — `synthesize-plan`.**
   - Prompt skeleton: `references/AGENT_PROMPTS.md` § "synthesize".
   - Inputs: the verified signal report; the full text of `references/PORTFOLIO_HEURISTICS.md` (this is what makes the parent thin — heuristics travel WITH the agent, not in the parent context).
   - Output: structured draft plan: `{clusters: [...], proposed_new: [...], skipped_existing: [...], harness: {...}}`. Heuristic mapping happens IN THIS AGENT, not in the parent.
   - The parent stores the draft but does NOT render it yet.

4. **Spawn general-purpose subagent — `validate-plan`.** (Distinct from `verify-cites` — judges WHOLE-PLAN fitness on 4 axes.)
   - Prompt skeleton: `references/AGENT_PROMPTS.md` § "validate-plan".
   - Inputs: the draft plan from step 3; the signal report from step 1; the `ls .claude/skills/` output (read-only).
   - Output: `{pass: bool, axes: {signal_fidelity, overlap_correctness, cluster_sanity, harness_justification}, flagged_items, notes}`.
   - **On `pass: false`** → write plan + validator report to `cache/plans/_stuck/<target>-<YYYYMMDD>.md` and surface to user. Do NOT continue to drafter fan-out.
   - **On `pass: true`** → continue to step 5.

5. **Spawn N general-purpose subagents in parallel — `draft-child-tickets`.**
   - Prompt skeleton: `references/AGENT_PROMPTS.md` § "draft-child-ticket".
   - The parent issues ONE message containing N concurrent `Agent` tool calls (one per `proposed_new` skill in the plan).
   - Inputs per drafter: signal evidence for THIS skill, plan rationale for THIS skill (extracted from step 3 output), the per-skill-AC template from `PORTFOLIO_HEURISTICS.md § Per-skill AC template`.
   - Output per drafter: `{slug, domain, complexity, objective, context, ac, depends_on, related}`.
   - The parent collects all N drafter outputs. (No skill files are written yet — this is still propose-only.)

6. **Render final plan.** The parent populates `templates/BOOTSTRAP_PLAN_TEMPLATE.md` with: aggregated signal summary (from step 1), cluster + portfolio sections (from step 3), validator report (from step 4), ordered child-ticket list (from step 5), introspection notes.
   - Write to `cache/plans/<target>-<YYYYMMDD>.md` (or `-v0.2.md` if a v0.1 plan exists at the unsuffixed path).
   - Echo a one-block summary to the user: target, cluster count, proposed-skill count, validator verdict.

### Honesty rules

- **The validator runs AFTER synthesis but BEFORE the user sees the plan.** If validation fails, the user sees the failure report, NOT the plan — this prevents a hallucinated plan from being acted on.
- **The plan markdown must explicitly enumerate skipped-as-existing slugs** so the user can verify the overlap detection was correct.
- **No mid-DAG user prompts.** The DAG runs end-to-end; the only user touch-point is the final plan-review at the end (and optionally `emit-child-tickets` after approval).
- **Drafter fan-out is parallel.** Do NOT serialize the drafters in the parent context — that defeats the architecture's purpose.

---

## Operation: emit-child-tickets

Files one child ticket per proposed skill in the approved plan, using `ticket-manager.create-ticket`. **Only runs after the user has explicitly approved the plan** — never auto-fires.

### Procedure

1. Load the approved plan from `cache/plans/<target>-<DATE>.md`.
2. Confirm with the user: list the proposed-skill count and the expected ticket-ID range; require an explicit `y` confirmation.
3. For each `proposed_new` skill in the plan's ordered child-ticket list:
   - The drafter agent's output (from `generate-bootstrap-plan` step 5) already contains the ticket body fields. Hand the full payload to `ticket-manager.create-ticket`.
   - Set `related: [TKT-NNN]` on each child ticket where TKT-NNN is the parent skill-generator invocation ticket (typically the ticket the user was working under when they ran the bootstrap).
4. Echo the created ticket IDs to the user.

### Honesty rules

- Never call this op without explicit user approval. The plan is propose-only; ticket emission is a separate, user-gated step.
- If a child ticket would collide with an existing TKT (same title and domain), skip it and note the collision in the response.

---

## Subagent surface summary

| DAG node | Subagent type | Purpose | Output gate |
|---|---|---|---|
| 1. `introspect-codebase` | `Explore` | Parallel grep across the target repo for signature catalog patterns | Empty report → stop |
| 2. `verify-cites` | `general-purpose` | Grep-validates every file:line in the signal report | Drift → abort DAG before synthesis |
| 3. `synthesize-plan` | `general-purpose` | Heuristic mapping (signals → candidates) + cluster grouping + harness proposal | None (proceeds to validator) |
| 4. `validate-plan` | `general-purpose` | Cold-reader on 4 orthogonal axes | Validator fail → plan → `_stuck/` |
| 5. `draft-child-tickets` × N | `general-purpose` | Per-skill ticket body drafting | Drafter fail on a single skill → skip that skill, continue |

Hooks remain **out of scope for v2** (no `SessionStart` auto-suggest, no `Stop`/cron drift detection, no auto-bootstrap). Revisit in v3 once the skill proves value through repeated invocations.

## Prerequisites

- `.claude/skills/skill-builder/` exists with the 5 inventory primitives operational.
- `.claude/skills/ticket-manager/` exists (only required if `emit-child-tickets` is run).
- The target repo is the current working directory.

## References

- `${CLAUDE_SKILL_DIR}/references/INTROSPECTION_SIGNATURES.md` — grep-pattern + manifest-key catalog for `introspect-codebase`.
- `${CLAUDE_SKILL_DIR}/references/PORTFOLIO_HEURISTICS.md` — signal → skill-family mapping rules consumed by the `synthesize-plan` agent.
- `${CLAUDE_SKILL_DIR}/references/AGENT_PROMPTS.md` — the 5 prompt skeletons (one per DAG node) with inputs / output schemas / evidence requirements / deny-lists.
- `${CLAUDE_SKILL_DIR}/templates/BOOTSTRAP_PLAN_TEMPLATE.md` — the markdown structure the parent populates after step 6.

## After every operation

After `generate-bootstrap-plan` (passing validation), echo a one-block summary to the user listing: target repo, cluster count, proposed-skill count, harness-extra count, validator verdict. Nothing else — no inline plan markdown, no embedded JSON.
