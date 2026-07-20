# Skill Authoring Guide

The canonical guide for designing, building, and structuring Claude Code
skills in this project. Owned by the `skill-builder` skill — `CLAUDE.md`
points here rather than duplicating the content.

Companion files:

- `FRONTMATTER_REFERENCE.md` — every official Anthropic field + the two
  local conventions (`connects_to`, `kind`).
- `HOOKS_QUICK_REFERENCE.md` — events, handler types, exit codes.
- `CONNECTS_TO_CONVENTION.md` — schema and examples for `connects_to`
  and `kind`.

## What a skill is

A skill is an **invokable, multi-step procedure** that Claude loads into
the conversation when a user request matches its trigger phrases.

Lifecycle facts that drive every design decision:

- **Single-message injection.** The rendered SKILL.md enters the
  conversation as a single user-role message. Claude does NOT re-read
  the file on later turns.
- **Stays loaded for the session.** Once invoked, the skill content
  persists until compaction or session end.
- **Write standing instructions, not one-time steps.** Treat the body
  like a system prompt for the duration of the task — directives that
  apply throughout, not a script that expires after the first response.
- **Compaction behavior.** After auto-compaction, invoked skills are
  re-attached within a 25,000-token shared budget; only the **first
  5,000 tokens of each** survive. Front-load critical instructions.
- **Re-invoke after compaction.** If a skill seems to stop influencing
  behavior mid-session, invoking it again restores the full content.
- **`ultrathink` keyword** anywhere in the body triggers deep reasoning
  for that invocation. Use for analytical skills (a `<domain>-review`
  synthesizer, `bug-scan`); leave off for mechanical operators.

Skills follow the [Agent Skills open standard](https://agentskills.io),
a cross-tool format that works across multiple AI coding assistants.
Skills written here are portable.

## When to build a skill (and when NOT to)

Build a skill when:

- A user intent recurs (you'd want to invoke this multiple times).
- The procedure has 3+ steps that benefit from being codified.
- The result is a side-effect or artifact, not just a verbal answer.

Don't build a skill when:

- The task is one-shot — just do it.
- The "procedure" is really just "use the right tool" (let Claude pick).
- A plan or an ad-hoc agent invocation would serve better (one-time
  alignment, no need for repeatability).

## Capability overlap and skill composition

Before writing a new skill, check whether an existing skill already covers
the capability you're about to add. **The `skill-builder.overlap-check`
operation** scores a candidate's `description + when_to_use` against every
existing skill's same fields and reports duplication at three tiers:

- **P0** — Jaccard > 0.5 or 3+ word noun phrase verbatim match. Likely a
  full duplicate. Do not scaffold; extend the existing skill instead.
- **P1** — Jaccard 0.3–0.5 or 2-word noun phrase match. Partial overlap.
  Resolve by one of the three patterns below before scaffolding.
- **P2** — Jaccard 0.2–0.3. Adjacency only. Confirm the boundary is
  intentional; usually fine.

`create-skill` runs `overlap-check` automatically before writing the file,
and `audit-skill` runs it on every existing skill. The check is lexical
(no embeddings) and reuses `.skua/lib/frontmatter.ts:44 parse()`.

### Three patterns for resolving a P1 overlap

When `overlap-check` flags a partial overlap, pick one — don't ignore it:

1. **Narrow the new skill's scope.** Most common. If the new skill was
   going to duplicate enumeration/inventory work an existing skill does,
   strip that out and have the new skill *consume* the existing skill's
   output. Example: a proposed consistency-audit skill was originally
   going to re-walk routes / proxies / handlers, but `repo-map` already
   built that graph. The new skill was narrowed to field-shape +
   param-drift checks on top of the existing graph cache.
2. **Add an explicit `connects_to` edge.** When the overlap is genuine
   composition (the new skill calls the existing one as a sub-step), make
   that edge explicit so the dashboard renders it and `audit-skill` sees
   it as intentional rather than accidental.
3. **Merge into the existing skill.** When the new "skill" is really a
   new *operation* on an existing skill's domain, add it there instead
   of creating a sibling. Cheaper to maintain; one trigger surface.

### Why this matters

Without an overlap check, two failure modes appear:

- **Capability drift** — two skills end up enumerating the same surface
  (HTTP routes, DB writers, app pages) with slightly different regexes,
  and the answers disagree at the margins. Each skill thinks it's the
  source of truth.
- **Trigger collision** — both skills auto-invoke on the same phrasing,
  so which one wins depends on order in the available-skills list. The
  user sees inconsistent behavior across sessions.

The lesson that prompted adding `overlap-check` was a new skill reaching
build-ready with ~50% of its scope already covered by an existing graph
builder, with no audit warning. The check exists to make that failure
mode detectable at authoring time.

## Naming and location

- Slug is kebab-case: `adr-manager`, `bug-scan`, `repo-map`.
- Slug matches the directory under `.claude/skills/<slug>/`.
- `name:` in frontmatter matches the slug exactly.
- Max 64 characters.
- **Prefer noun phrases or action-object pairs over imperatives**:
  `repo-map` ✓, `map-repo` ✗; `bug-scan` ✓,
  `scan-for-bugs` ✗.

## Where guidance belongs

| Content | Goes in |
|---|---|
| Global rules (universe policy, numeric scale, "always use uv") | `CLAUDE.md` |
| Skill-specific procedure | `SKILL.md` body |
| Long-form reference / config / contracts | `references/` |
| Deterministic logic | `scripts/` |
| Canonical output artifacts | `templates/` |
| Automated behavior on tool events | Hooks in `settings.json` |

New skills must NOT duplicate CLAUDE.md content — link to it instead.

**No executable code in `SKILL.md`.** SQL, Python, or shell meant to be *run*
goes in a real file under `scripts/`; the skill body shows only the invocation
(e.g. `uv run python -m scripts.data_quality`), never the body. Inline
runnable code rots silently, can't be tested, and can't actually be executed.
A short *illustrative* snippet (not run) may stay inline or go in `references/`.

## The full frontmatter surface

See `FRONTMATTER_REFERENCE.md` for the complete field-by-field reference.
Quick summary of the **most important** decisions:

- Always set `name`, `description`, `when_to_use`, `connects_to`,
  and (if unambiguous) `kind`.
- Set `disable-model-invocation: true` ONLY on destructive /
  irreversible skills (e.g. `deploy`). This also blocks subagent
  preload — confirm intent.
- Set `effort: max` ONLY for genuinely heavy skills; `effort: low`
  ONLY for trivially light ones. Omit otherwise.
- `context: fork` + `agent: <type>` for one-shot research skills. Read-only
  research should use `agent: Explore`.

## The description + when_to_use pattern

**Capability in `description`. Trigger phrases in `when_to_use`.**

Why split them:

1. Descriptions are truncated **from the end** when the 1,536-char
   combined budget overflows. Critical capability keywords must appear
   first.
2. Trigger phrases at the end of `description` are the first thing cut.
   Keeping them in `when_to_use` keeps them safe.
3. Auto-trigger matching weighs `when_to_use` separately. Better signal-
   to-noise.

### Good description

> Audit database schemas for drift between declared DDL and live tables, partitioning/indexing correctness, naming conventions, NULLABLE/REQUIRED hygiene. Produces a per-table report with P0/P1/P2 findings.

### Good when_to_use

> User says "audit the schema", "check schema drift", "are my tables partitioned correctly", "is the indexing right".

### Bad description (do not do this)

> Use this skill when the user says "audit the schema" or "check schema drift" or "are my tables partitioned" — it audits database schemas for…

Trigger phrases are eating the budget that should go to capability
keywords.

### "Does NOT do" negation

Include an explicit negation at the end of `description` (or in the
body) to prevent mis-routing. Example:

> Does NOT modify tables — read-only audit only. For actual schema migration, use a dedicated migration skill.

## Description style rules

A description should follow this shape:

```
<Verb> <object> <for/against what>. <Outputs sentence>. <One-clause read-only / boundary clause>.
```

Three sentences. No preface. No counts. No paths. No sibling
positioning. No internals. No marketing adjectives.

**Avoid these 11 patterns** (full audit + rewrite recipes in
`DESCRIPTION_AUDIT.md`):

| Pattern | Fix |
|---|---|
| P1 — "Read-only" said 2–3 ways | One canonical "Read-only." (or "Read-only; emits scripts." if relevant). |
| P2 — Counts and dated stamps ("17 clauses", "5 audits", "Renamed YYYY-MM-DD") | Strip them. Name the file, not its shape. Rename history lives in commit log. |
| P3 — Self-classifying preface ("Orchestrator for", "Synthesizer skill —", "The architectural skill for", "Meta-strategy lens for") | Lead with the verb of capability. `kind:` carries the classification. |
| P4 — Sibling / mirror paragraphs ("Sister to X", "Mirror of Y") | One short "Distinct from `<sibling>` (does X)." OR push to body / `connects_to`. |
| P5 — `references/`, `plans/`, `spec/` paths inline | Name the concept; body references the file. |
| P6 — Second sentence re-stating the first | Three sentences max: capability / outputs / boundary. |
| P7 — Internals (cache paths, DAG topology, version stamps like "v0.2", auto-archive policy) | Strip. Body explains how. |
| P8 — Marketing adjectives ("principal-engineer", "data-engineer-grade", "fully-drafted") | Drop the qualifier. |
| P9 — "Does NOT" with transient anchors ("(per CLAUDE.md)", "(TKT-NNN)") or multi-clause when one would do | One clause that prevents a real mis-route. Project-state caveats live in CLAUDE.md, not the description. |
| P10 — `when_to_use` synonym-padding (>6 near-paraphrases) | Keep 3–6 phrases that span the **distinct** intents. Drop synonyms. |
| P11 — Auditor verbosity (15+ checks enumerated inline) | 4–6 highest-signal keywords inline; full matrix in `references/CHECK_CATALOG.md`. |

### Worked example

**Before** (a hypothetical `ranking-tuning` skill, 5 sentences, ~600 chars — hits P1, P2, P3, P5, P6):

> Meta-strategy lens for the ranking pipeline. Validates and
> tunes how individual signals combine into a ranked feed with
> additional edge. Audits the feature set, candidate-formation logic,
> ranker knobs, score normalization, and runtime invariants in
> src/ranker/build_feed.py against RANKING_CONTRACT.md (17 active +
> 3 aspirational clauses). Owns three workflows: (1) tune-a-threshold
> pre-check, (2) add-a-new-feature scaffold, (3) full contract-compliance
> audit. Read-only — never re-runs the ranker, never writes the database,
> never executes the nightly sync. Produces P0/P1/P2 punch lists with
> file:line cites; hands off recompute plans to a migration runner.

**After** (3 sentences, ~280 chars):

> Audits the ranking pipeline against `RANKING_CONTRACT.md`:
> feature set, candidate formation, ranker knobs, score normalization,
> runtime invariants. Produces a P0/P1/P2 punch list with file:line
> cites; hands recompute plans to a migration runner. Read-only.

Compression: ~55%. Information loss: none material — the three
workflows belong in the body's "When to invoke", not the description.

## The house body template

Every skill body should follow this shape. (Anthropic recommends 500
lines max; detail beyond that belongs in `references/`.)

```markdown
# <Title>

One-sentence summary of what this skill does.

## When to invoke

- "<trigger phrase>" → <op name>
- ...

## When NOT to invoke

- <thing that looks like a trigger but isn't>

## Procedure

Numbered, directive steps. Standing instructions, not narration.

1. **Step name** — what to do.
2. **Step name** — ...

## Prerequisites

- Files / tools assumed to exist.
- Env vars / secrets.

## References

- `${CLAUDE_SKILL_DIR}/references/<file>.md` — when to read it.

## After every operation

Wrap-up step (if any).
```

Concrete examples: `security/SKILL.md`, `bug-scan/SKILL.md`.

## Body style rules

A scan of the portfolio (see `BODY_AUDIT.md`) surfaced 10 recurring
redundancy patterns in bodies. The rules below prevent the next-worst
offender from re-emerging. Pattern letters (B1–B10) reference the
audit doc.

1. **Procedure-only (B1).** A numbered `### Procedure` block IS the
   spec. No accompanying prose paragraph that re-narrates the same
   steps in friendlier language.
2. **Honesty rules ≤ 2 bullets per op (B2).** Standing rules that
   apply to >2 ops belong in a single top-of-file §Standing rules
   block, referenced not re-stated. "Don't fabricate" / "stop and
   ask" guidance is one bullet at the top, not per-op.
3. **Warnings ONCE (B3).** Any block-quote warning (`> ⚠ ...`)
   that applies to multiple ops is stated once with an explicit
   list of affected ops, never repeated.
4. **Trigger phrases ONCE (B4).** The top-of-file Operations table
   is the trigger index. Per-op "When to run" only adds info NOT
   in that table (proactive triggers, auto-fire conditions).
5. **State diagram ONCE (B5).** Show the lifecycle / bucket tree
   ONCE as ASCII or a table. Do not narrate it in prose afterward
   — the tree is the spec.
6. **Policy ONCE (B6).** Stale-archive, auto-prune, retention, and
   similar policies appear in exactly one section per file.
7. **Boundary disclaimers ONCE (B7).** A single
   `## What this skill does NOT do` section. No inline "this skill
   never X" restatements scattered through op sections.
8. **No `## Examples` section (B8).** If the procedure is clear, the
   examples add nothing the LLM uses. Tricky cases that genuinely
   need illustration belong in `references/EXAMPLES.md`.
9. **Templates in `templates/` (B9).** Markdown / JSON templates
   >5 lines live in `templates/`, not inline. Body references them
   by path.
10. **Glossary / config tables >5 rows in `references/` (B10).**
    Inline reference tables (domain taxonomies, complexity rubrics,
    parameter tables) are body bloat once they exceed a handful of
    rows.

### Validation triggers

- If a body exceeds 500 lines, the patterns above almost always
  apply — start there before adding new sections.
- If you find yourself writing "as mentioned above" or "see X
  below", consolidate the two mentions into one.

## Supporting-files layout

Three optional subdirectories. Only create the ones you actually use —
empty directories are noise.

### `scripts/`

Deterministic logic that the skill body invokes. Many skills use this.
Examples: `bug-scan/scripts/find_duplicates.py`,
`<layer>-schema-audit/scripts/probe_tables.py`.

**Always invoke via `${CLAUDE_SKILL_DIR}/scripts/...`**, never an
absolute path.

**Prefer a script over a prose procedure when the steps are fixed.** If a
skill's body spells out a fixed sequence of queries/checks/commands as prose
for the model to re-run each time, that's a refactor-to-script smell: the model
re-derives (and mis-types) it every run — wrong column/field names, drifted
thresholds. Move the determinism into a script that emits PASS/FAIL (or the
artifact); the skill body just invokes it and interprets. Keep prose for
judgment, routing, and the conceptual map — not for steps a script runs
identically every time. (A repo script outside the skill is equally fine; the
point is deterministic-as-code, not skill-bloat.)

### `references/`

Long-form reference: SQL probes, severity rules, contracts, config. Many
skills use this. Examples:
`bug-scan/references/CHECK_CATALOG.md`,
`<layer>-data-integrity-audit/references/probes.sql`.

The skill body should `Read` these on demand, not paraphrase from
memory.

### `templates/`

Canonical output artifacts. Currently only `ticket-manager` uses this
(`templates/ticket-template.md`). Use when the skill produces a
structured output that other tools (or the dashboard) consume.

## Dynamic context injection — the `!` syntax

A line starting with `` !`<shell command>` `` runs **before** the skill
content reaches Claude; the output replaces the line. The `!` must be at
the start of a line or after whitespace — `KEY=!`cmd`` does NOT work.

Multi-line form:

````
```!
git diff HEAD
```
````

Substitution runs once. Output is NOT re-scanned for further `` !`cmd` ``.

Use cases: live git diff, current date, environment info, external query
results, file listings.

Disabled globally via `"disableSkillShellExecution": true` in settings
(returns `[shell command execution disabled by policy]`).

**Note:** no current project skill uses `!` injection. It's a
documented capability — adopt it when the skill genuinely needs live
context at invocation time.

## String substitutions

- `$ARGUMENTS` — all arguments typed after the skill name.
- `$ARGUMENTS[N]` / `$N` — by 0-based index. Multi-word args need
  quoting (`/my-skill "hello world" second`).
- `$name` — named argument declared in `arguments:` frontmatter.
- `${CLAUDE_SESSION_ID}` — current session ID.
- `${CLAUDE_EFFORT}` — active effort level (`low | medium | high |
  xhigh | max`).
- `${CLAUDE_SKILL_DIR}` — **always use this to reference bundled
  files**. Absolute paths break when the skill moves between project /
  user / plugin scopes.

## Hooks — when and where

A hook is automated behavior on a tool event. Hooks execute **without
Claude** — the model never sees them fire.

Three locations:

| Location | When to use |
|---|---|
| `~/.claude/settings.json` | Behavior should apply across every project for this user |
| `.claude/settings.json` | Behavior should apply for every contributor on this project (checked into git) |
| `.claude/settings.local.json` | Per-contributor / personal overrides (gitignored) |
| Skill / agent `hooks:` frontmatter | Behavior should activate ONLY while that skill / agent is running |

Memory cannot fulfill "whenever X" requests. Only hooks can.

See `HOOKS_QUICK_REFERENCE.md` for events, handler types, exit codes.

## Decision matrix: skill vs agent vs hook vs plan

| Primitive | Use when |
|---|---|
| **Skill** | User intent triggers an invokable multi-step procedure; stays loaded for the session |
| **Skill with `context: fork`** | Same as skill, but needs a clean isolated context; one-shot |
| **Custom agent** (`.claude/agents/`) | Persistent named worker with its own tools / memory / preloaded skills; invoked by @-mention or delegation |
| **Hook** | Automated reaction to tool events; runs without Claude; "whenever X happens" |
| **Plan** | Multi-step alignment before implementation; ephemeral, conversation-scoped |

## Custom agents reference

For files under `.claude/agents/<name>.md`. Built-in agents:

- **Explore** — Haiku, read-only, skips CLAUDE.md + git status. Fast
  codebase search.
- **Plan** — read-only, designs implementation plans.
- **general-purpose** — all tools, broad multi-step research.

Frontmatter fields:

| Field | Required | Purpose |
|---|---|---|
| `name` | yes | Unique lowercase identifier |
| `description` | yes | Delegation routing — when Claude picks this agent |
| `tools` / `disallowedTools` | no | Allowlist / denylist |
| `model` | no | sonnet, opus, haiku, full ID, or `inherit` |
| `permissionMode` | no | `default | acceptEdits | auto | dontAsk | bypassPermissions | plan` |
| `maxTurns` | no | Cap on agentic turns |
| `effort` | no | Override session effort |
| `skills` | no | Skills to preload (full content injected at startup; cannot preload skills with `disable-model-invocation: true`) |
| `mcpServers` | no | MCP servers available |
| `hooks` | no | Lifecycle hooks |
| `memory` | no | `user | project | local` — persistent memory scope |
| `background` | no | Run as background task |
| `isolation` | no | `worktree` for git worktree isolation |
| `color` | no | Display color |
| `initialPrompt` | no | Auto-submitted first turn |

**Memory scopes** (when `memory:` is set):

- `user` → `~/.claude/agent-memory/<name>/`
- `project` → `.claude/agent-memory/<name>/`
- `local` → `.claude/agent-memory-local/<name>/`

## Read-only vs write-capable skills

Distinguish these as an explicit design dimension:

- **Read-only skills** (`security`, `bug-scan`, the audit
  family) — produce reports; never modify state. Safe to auto-invoke.
- **Reversible writers** (`ticket-manager`, a `migration-runner`) —
  modify state, but in ways the user can undo or re-run. Safe to
  auto-invoke.
- **Destructive / irreversible writers** (a hypothetical `acme-deploy`,
  future `commit-and-push`) — set `disable-model-invocation: true`. Force
  explicit `/<slug>` invocation.

## When a skill needs an orchestrator

Rule of thumb: if user intent regularly maps to **2+ skills**, or
routing logic itself is non-trivial, add an orchestrator. Otherwise
direct invocation is simpler.

### Three orchestrator patterns

| Pattern | Verb | Example | When to use |
|---|---|---|---|
| **Router** | "which sibling should I run?" | a hypothetical `backend-router` | User intent is ambiguous and routing logic itself is non-trivial. No own logic — just dispatch. Slug suffix: `-router` per `skill-organizer/references/NAMING_CONVENTION.md`. |
| **Synthesizer** | "run all siblings, give me one report" | a hypothetical `<domain>-review` | User wants a single consolidated output (typically a senior-engineer-grade markdown report). Runs every sibling, dedups, prioritizes. |
| **Composer-with-dedup** | "run a detection engine + add cross-cutting analysis" | `security` | Composer over the `/security-review` engine's findings: snapshot-over-time / cross-source dedup / ticket linkage. |

### A cluster can legitimately have BOTH a router AND a synthesizer

Imagine a backend-audits cluster of leaf audits sat on by **two** orchestrators:

- a `backend-router` (router) — answers "which audit should I run for the user's question?" — picks one of the leaves and dispatches.
- a `backend-review` (synthesizer) — answers "audit the entire backend" — runs all of them and merges into one report.

**Do not try to collapse them.** They serve different verbs (route vs synthesize) on the same cluster, and both verbs are real. A `skill-organizer.propose-merge` pass surfacing this pair as overlap candidates should mark them as **intentional dual-orchestrator pattern** and downgrade the merge proposal. The same logic applies to any cluster that wants both a "which one?" entry point and an "all of them" entry point.

The composer-with-dedup pattern can also sit on top of a synthesizer — a composer can run a synthesizer as one of its subskills. Composer-over-synthesizer-over-leaves is fine.

### Existing orchestrators in this repo

- `security` — composer over the `/security-review` engine's findings (dedup, severity bands, snapshot diff, auto-draft into the board).
- `skill-organizer` — proposer-style orchestrator for portfolio-level skill curation.
- `skill-generator` — generator that orchestrates a multi-agent bootstrap DAG.
- `ticket-manager` — self-orchestrating; multiple ops in one skill (utility kind, but routes its own ops).

An orchestrator routing to subskills in multiple domains → domain is
`meta` (the orchestrator itself doesn't live in any single deploy
unit).

## Internal flow vs external flow

When designing a skill, hold two flows in mind:

- **Internal flow** — the steps the skill runs end-to-end inside one
  invocation. Lives in the body's *Procedure* section.
- **External flow** — how the skill is triggered, how it composes with
  sibling skills, how an orchestrator routes to it. Lives in
  `description` + `when_to_use` + `connects_to`.

Internal flow is the implementation; external flow is the contract.
Confusing them produces skills that work in isolation but fight other
skills in practice.

## Patterns worth reusing

These show up across multiple existing skills — adopt when it fits:

- **Always-run wrap-up** — `ticket-manager` rewrites the dashboard
  board on every op so the index stays current. Add a *"After every
  operation"* section to your body when the skill has shared state.
- **Block-on-overlap** — a `payments-scaffold`-style skill aborts if a
  proposed name collides with an existing one. Cheap guard against
  accidental duplication.
- **Plan-first execution** — a `migration-runner` and an `acme-deploy`
  produce a plan, then prompt for confirmation before executing. Right
  pattern for destructive / expensive actions.
- **Severity-ranked output** — `bug-scan` emits findings as
  P0/P1/P2. Easy to scan; orders triage.
- **Reference-driven answers** — for any non-trivial domain knowledge,
  put it in `references/` and `Read` on demand rather than paraphrasing
  from memory.

## Common pitfalls

1. **Vague `description`** — fix by moving trigger phrases to
   `when_to_use` and leading `description` with the use case.
2. **Oversized SKILL.md** (> 500 lines) — move detail to `references/`.
3. **Missing `disable-model-invocation` on a destructive skill** — the
   model can auto-fire deploy. Set it.
4. **Post-compaction context loss** — front-load the most critical
   instructions in the first ~5,000 tokens.
5. **Absolute paths to bundled scripts** — always use
   `${CLAUDE_SKILL_DIR}/...`. Absolute paths break when the skill
   moves.
6. **Trigger phrases in `description` instead of `when_to_use`** —
   hurts auto-trigger reliability and wastes the 1,536-char budget.
7. **`context: fork` on a reference / knowledge skill** — a subagent
   with no actionable task returns nothing.
8. **Missing `agent:` on a `context: fork` skill** — defaults to
   `general-purpose`. For read-only research, use `agent: Explore`.
9. **`disable-model-invocation: true` on a skill you want preloaded
   into subagents** — this field blocks both.
10. **Silently truncated descriptions** — run `/doctor` to see if the
    description budget is overflowing. Tune via
    `skillListingBudgetFraction` or `skillOverrides`.

## Diagnostic and visibility tooling

- `/doctor` — surfaces skills with truncated descriptions (sorted by
  invocation frequency).
- `/skills` — interactive visibility menu. `Space` cycles state; saves
  to `settings.local.json`.
- `skillListingBudgetFraction` (default 1%) — fraction of context
  reserved for skill listings.
- `maxSkillDescriptionChars` (default 1,536) — per-skill cap on
  `description` + `when_to_use`.
- `skillOverrides`: `"on"` | `"name-only"` |
  `"user-invocable-only"` | `"off"` — control visibility without
  editing SKILL.md.

## Plugins and marketplaces (brief)

Skills can also ship as part of a plugin (`.claude/plugins/<plugin>/`)
installed from a marketplace. Plugin-level hooks live in
`hooks/hooks.json` inside the plugin.

Project-local skills under `.claude/skills/` are the focus of this
guide. Plugin authoring is a separate concern. Relevant settings:

- `enabledPlugins` — which plugins are active
- `extraKnownMarketplaces` — additional marketplace URLs
- `blockedMarketplaces` — denylist
- `pluginTrustMessage` — message shown when enabling a plugin

## Validation checklist

Before merging a new skill, confirm:

- [ ] Skill appears in the available-skills list of a **fresh session**
      (start a new conversation to verify).
- [ ] An organic user phrase triggers it without naming it.
- [ ] Dry-run any side-effect ops at least once.
- [ ] Run the always-run wrap-up step at least once.
- [ ] `skill-builder.audit-skill <slug>` reports zero P0 / P1 findings.
- [ ] `description` + `when_to_use` ≤ 1,536 chars.
- [ ] `description` ≤ 3 sentences; no preface, no counts, no paths,
      no internals, no sibling paragraphs, no marketing adjectives;
      one canonical read-only clause. (See §Description style rules.)
- [ ] `when_to_use` holds 3–6 **distinct** trigger phrases; no
      synonym-padding.
- [ ] Body ≤ 500 lines.
- [ ] Body follows §Body style rules — no procedure-restating prose,
      ≤2 honesty bullets per op, warnings/policies/state-diagrams
      stated once, no `## Examples` section, templates >5 lines in
      `templates/`, config tables >5 rows in `references/`.

## Reference URLs

- Official skills docs: https://code.claude.com/docs/en/skills.md
- Frontmatter reference: https://code.claude.com/docs/en/skills.md#frontmatter-reference
- Hooks docs: https://code.claude.com/docs/en/hooks.md
- Sub-agents docs: https://code.claude.com/docs/en/sub-agents.md
- Permissions docs: https://code.claude.com/docs/en/permissions.md
- Settings docs: https://code.claude.com/docs/en/settings.md
- Agent Skills open standard: https://agentskills.io
