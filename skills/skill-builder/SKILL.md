---
name: skill-builder
description: "Author, audit, or refactor a Claude Code skill — produces a populated SKILL.md skeleton, validates frontmatter against the official Anthropic spec, checks against the project authoring checklist with severity-ranked output (P0/P1/P2), and audits the whole skill portfolio. Owns the canonical authoring guide (references/SKILL_AUTHORING.md), frontmatter reference, hooks quick-reference, the connects_to local-convention spec, and the SKILL.md template. CLAUDE.md does NOT duplicate this content — it points here."
when_to_use: "User says 'create a new skill', 'scaffold a skill called X', 'audit the <slug> skill', 'review my SKILL.md', 'what frontmatter fields should this skill set?', 'split trigger phrases out of description', 'refactor <slug> to use references/', 'list skills with no connects_to', 'audit all skills', 'what's the right kind for <slug>?', 'is my description too long?'."
connects_to:
  - skill-organizer
kind: utility
---

# Skill Builder

Owns Claude Code skill authoring and auditing in this project. For
authoring questions ("what does `disable-model-invocation` do?", "how do
I declare a hook?") read `references/` first; answer from the file
rather than memory.

## When NOT to invoke

- Writing application code, tests, or documentation outside `.claude/skills/`.
- Editing or building hooks in `.claude/settings.json` (that's a separate concern; this skill only references hook concepts).
- Authoring plugins for cross-project distribution — this skill covers project-local skills only.
- **Portfolio-level structural decisions** (merging skills, renaming, retiring, wrapping in orchestrators) — that's `skill-organizer`'s domain. This skill owns per-skill authoring plus the inventory primitives (`overlap-check`, `audit-all`, `list-orphans`, `validate-frontmatter`, `audit-skill`) that `skill-organizer` consumes. Single-owner mapping in `.claude/skills/skill-organizer/references/SKILL_OWNERSHIP_BOUNDARIES.md`.

## Operations

Six operations; compose freely (e.g. `create-skill foo` + `audit-skill foo`).

| op | trigger phrases |
|---|---|
| `create-skill <slug>` | "create a skill for X", "scaffold a new skill called <slug>", "make a skill that does Y" |
| `audit-skill <slug>` | "audit the <slug> skill", "review SKILL.md for <slug>", "what's wrong with <slug>?" |
| `validate-frontmatter <slug>` | "validate the frontmatter for <slug>", "is the frontmatter correct?" |
| `overlap-check <slug-or-description>` | "does <slug> duplicate any existing skill?", "what does <slug> overlap with?", "is this new skill description novel?" |
| `list-orphans` | "which skills have no `connects_to`?", "list skills missing `when_to_use`" |
| `audit-all` | "audit all skills", "portfolio-wide skill review", "do all skills pass?" |

## Canonical references — read before answering authoring questions

Do NOT paraphrase from memory. Read the file and answer from it:

- **`${CLAUDE_SKILL_DIR}/references/SKILL_AUTHORING.md`** — the full authoring guide. Start here for "how do I write a skill?"
- **`${CLAUDE_SKILL_DIR}/references/FRONTMATTER_REFERENCE.md`** — every official Anthropic frontmatter field, each with a one-line "when to set this".
- **`${CLAUDE_SKILL_DIR}/references/HOOKS_QUICK_REFERENCE.md`** — hook events, handler types, exit codes, output schema.
- **`${CLAUDE_SKILL_DIR}/references/CONNECTS_TO_CONVENTION.md`** — the local `connects_to` and `kind` field conventions (NOT Anthropic-blessed).
- **`${CLAUDE_SKILL_DIR}/templates/skill-template.md`** — the canonical SKILL.md skeleton.

---

## Operation: create-skill

Scaffolds a new skill at `.claude/skills/<slug>/SKILL.md` from the template.

### 1. Validate the slug

- Slug must be **kebab-case** (lowercase letters, digits, hyphens; no underscores, no spaces).
- Slug must be ≤ 64 characters.
- Slug must NOT collide with an existing skill directory in `.claude/skills/`.

If any check fails, stop and ask the user for a corrected slug.

### 2. Gather the four required fields from the user

Prompt for these one at a time if they weren't provided in the initial request:

- **`description`** — capability + output statement. Leads with the use case. No trigger phrases here.
- **`when_to_use`** — list of trigger phrases / example user requests. Separate from `description`. Combined cap with `description` is 1,536 characters.
- **`connects_to`** — list of skill slugs this skill routes or hands off to. Empty list (`[]`) if self-contained.
- **`kind`** — one of `orchestrator | audit | action | generator | utility | specialized`. Omit if ambiguous.

### 3. Overlap pre-check (before scaffolding)

Run `overlap-check` against the proposed `description` + `when_to_use` strings (not against a slug yet — the file doesn't exist). Outcome rules:

- **P0 overlap** (Jaccard > 0.5 or a 3+ word noun phrase verbatim match): **abort**. Print the overlapping skill slug and the matched phrases, recommend "narrow the scope or extend `<slug>` instead", and stop. Do not write the file.
- **P1 overlap** (Jaccard 0.3–0.5 or 2-word noun phrase match): print the overlapping skill slug and recommend either narrowing the scope OR adding the overlapping skill to `connects_to`. Require the user to explicitly say "proceed anyway" or revise the description before continuing.
- **P2 overlap** (Jaccard 0.2–0.3): print as informational only; proceed.
- **No overlap**: proceed silently.

### 4. Scaffold the files

- Create `.claude/skills/<slug>/SKILL.md` by copying `${CLAUDE_SKILL_DIR}/templates/skill-template.md` and substituting `{{slug}}`, `{{description}}`, `{{when_to_use}}`, `{{connects_to}}`, `{{kind}}`.
- Do NOT create empty `scripts/`, `references/`, or `templates/` directories. Add those only when the skill body actually invokes a script or references a file.

### 5. Verify

- Run `audit-skill <slug>` immediately. Resolve any P0/P1 findings before considering the scaffold done.
- Confirm the new skill loads in a fresh session (the user will need to start a new conversation to see it in their available-skills list).

---

## Operation: audit-skill

Reads `.claude/skills/<slug>/SKILL.md` and reports severity-ranked findings.

### 1. Read the source files

- Parse YAML frontmatter from `.claude/skills/<slug>/SKILL.md`. (The project already has a generic parser at `.skua/lib/frontmatter.ts:44 parse()`; use its export rather than writing a new one.)
- Read the full body to compute the line count and scan for absolute paths / trigger-phrase prose.
- Run `overlap-check <slug>` as a sub-step (see operation below) — any findings it emits get merged into the P0/P1/P2 sections at the tier `overlap-check` assigned.

### 2. Run the checklist from `references/SKILL_AUTHORING.md`

Findings are severity-ranked:

**P0 — must fix before merge**

- Missing `name:` frontmatter.
- `name:` does not match the directory slug.
- Body > 500 lines.
- Combined `description` + `when_to_use` > 1,536 characters.
- Frontmatter is malformed YAML.

**P1 — should fix before merge**

- Trigger phrases ("use this skill when…", "when the user says…") found inside `description`. They belong in `when_to_use`.
- Absolute paths to bundled scripts/references instead of `${CLAUDE_SKILL_DIR}/...`.
- Missing `connects_to:` field (omitted entirely — even `[]` is acceptable).
- `context: fork` set without an `agent:` field. Defaults to `general-purpose`, which is usually wrong for read-only research.
- `disable-model-invocation: true` set on a skill that should still auto-trigger (this also blocks subagent preload — confirm intent).

**Capability overlap (tier passthrough)**

- Findings raised by `overlap-check <slug>` (see operation below) are merged into the report at whichever tier `overlap-check` itself assigned — P0, P1, or P2. **Do not coerce the tier.** Example output: `P1 (overlap) repo-map J=0.38 shared: "dependency graph"`.

**P2 — nice to fix**

- Missing optional `kind:` field.
- Missing optional `effort:` on a clearly heavy or light skill.
- `references/` or `scripts/` directory present but empty.
- Body lacks the house template (`When to invoke / When NOT to invoke / Procedure`).
- `description` starts with trigger phrases instead of leading with the use case.

### 3. Emit findings

Group by severity. For each finding include: line number (if applicable), short rationale, fix hint.

If zero findings: emit `<slug>: clean (0 findings)`.

---

## Operation: validate-frontmatter

Lighter-weight than `audit-skill`. Parses frontmatter and checks each field for type/value correctness against the official Anthropic spec.

### Checks

- `name`: present, kebab-case, ≤ 64 chars, matches directory slug.
- `description`: present, non-empty.
- `when_to_use`: present (warning if missing — it's optional in the spec but the project convention requires it).
- Combined `description` + `when_to_use` length ≤ 1,536 chars.
- `allowed-tools`: if present, every entry is a known tool name.
- `disable-model-invocation`: boolean.
- `user-invocable`: boolean.
- `effort`: if present, one of `low | medium | high | xhigh | max`.
- `context`: if present, value is `fork`.
- `agent`: if present, one of `Explore | Plan | general-purpose` OR a file exists at `.claude/agents/<value>.md`.
- `paths`: if present, a list of strings.
- `shell`: if present, one of `bash | powershell`.
- `argument-hint`: if present, a string.
- `arguments`: if present, a list of strings.

Emit pass/fail and a list of typed warnings.

---

## Operation: list-orphans

Walk every `.claude/skills/*/SKILL.md`, parse frontmatter, return:

- Skills missing `when_to_use:` entirely.
- Skills missing `connects_to:` entirely.
- Skills where `connects_to:` is present but lists a slug that does NOT resolve to an existing skill directory (broken edge).

Output: a markdown table with columns `slug | missing when_to_use | missing connects_to | broken edges`.

---

## Operation: overlap-check

Detects capability duplication between a candidate skill and the existing portfolio. Documented procedure executed inline — no standalone script. Use `bun -e` snippets that import `.skua/lib/frontmatter.ts:44 parse()` if scripting the comparison is easier than doing it in prose.

### Input

Two forms, depending on the calling op:

- **`overlap-check <slug>`** — read `.claude/skills/<slug>/SKILL.md` and use that file's `description` + `when_to_use` as the candidate. Used by `audit-skill` and `audit-all` (skill exists on disk).
- **`overlap-check --description "..." --when-to-use "..."`** — score the proposed strings against the existing portfolio without writing any file. Used by `create-skill` step 3 (skill does NOT yet exist on disk).

### Procedure

1. **Load candidate text.** Either read the slug's SKILL.md frontmatter (via `.skua/lib/frontmatter.ts:44 parse()`) or take the literal strings from the CLI args. Concatenate `description + " " + when_to_use` into one string `candidateText`.
2. **Load corpus.** Walk every `.claude/skills/*/SKILL.md` (skip the candidate's own file if it exists), parse frontmatter, build a map `slug → description + " " + when_to_use`. This is the comparison corpus.
3. **Tokenize.** Lowercase, strip punctuation, **split on whitespace AND hyphens** (so `bug-scan` becomes 2 tokens — without this, hyphenated skill slugs never match across skills that write the same words unhyphenated). Apply:
   - **Stop-word filter** — drop tokens that appear in nearly every skill description and carry no signal. Starter list (tune over time): `the, a, an, of, for, and, or, to, in, on, with, this, that, when, what, which, run, runs, produce, produces, report, reports, skill, skills, user, audit, audits, plus, also, used, is, be, are, as, does, do, not, no, by, from, but, via, its, it, they, their, each, every, one, two, three`. Note: `dashboard` and `graph` are intentionally NOT stop-words — they ARE signal.
   - **Light lemmatization** — strip trailing `-s`, `-ing`, `-ed` from any remaining token of length ≥ 5. This collapses `audits` / `auditing` / `audited` → `audit`. Skip for tokens that are already stop-listed (`audits` is dropped above; this is for words like `rebuild` / `rebuilds` / `rebuilding`).
4. **Score each (candidate, existing-skill) pair.**
   - **Jaccard** = `|tokens(A) ∩ tokens(B)| / |tokens(A) ∪ tokens(B)|`. Cheap.
   - **Noun-phrase overlap** — find 2-word and 3-word contiguous phrases (after stop-word removal in step 3) that appear in BOTH `candidateText` and the other skill's text. Track the highest-N matched phrase length.
5. **Tier each pair** — highest severity its scores qualify for. Phrase matches alone are noisy (common bigrams like "diff against", "produces a" fire on unrelated skills); P0/P1 escalation requires phrase match AND a Jaccard floor.

   | Tier | Condition |
   |---|---|
   | **P0** | Jaccard > 0.5 **OR** (Jaccard ≥ 0.25 AND ≥ 1 verbatim 3-word noun-phrase match). Indicates near-duplicate capability — recommend rejecting the new skill or merging into the existing one. |
   | **P1** | Jaccard 0.3–0.5 **OR** (Jaccard ≥ 0.20 AND ≥ 1 verbatim 2-word noun-phrase match) **OR** (Jaccard ≥ 0.15 AND ≥ 1 verbatim 3-word noun-phrase match — same phrase that wasn't enough for P0). Partial overlap — recommend narrowing the new skill's scope AND adding the existing skill to `connects_to`. |
   | **P2** | Jaccard 0.2–0.3 **OR** ≥ 1 verbatim 2-word noun-phrase match below the P1 floor (Jaccard 0.10–0.20 with a 2-word match). Adjacency only — surface for author confirmation that the boundary is intentional. |
   | (none) | Jaccard < 0.10, OR Jaccard 0.10–0.20 with no qualifying noun-phrase match. Suppress. |

6. **Emit findings** as a ranked list, highest tier first, ties broken by Jaccard score descending:

   ```
   P1  <existing-slug>  Jaccard=0.38  shared phrases: "retry policy", "cache invalidation"
   P2  <existing-slug>  Jaccard=0.24  shared phrases: (none)
   ```

   Empty output = no overlap found. The calling op (create-skill / audit-skill / audit-all) decides what to do with the findings.

### Calibration target (unit test for the implementation)

Running `overlap-check bug-scan` against the current portfolio must produce a result of roughly this shape (an adjacent audit surfaces as low-tier adjacency, never a near-duplicate):

```
P2  security            J=0.15   2-word: verified findings
P2  adr-researcher      J=0.11   2-word: (none)
```

If an adjacent audit escalates to P0, thresholds are too aggressive. If it disappears entirely, the tokenizer / stop-word list regressed.

### When to invoke

- Automatically from `create-skill` step 3 (pre-scaffold), with `--description` / `--when-to-use` args.
- Automatically from `audit-skill` step 1 (as a sub-step), with the slug.
- Automatically from `audit-all` (once per skill).
- Manually when the user says "does X overlap with anything?" or "is this new skill description novel?".

### What this operation does NOT do

- Does not modify any skill file. Read-only.
- Does not auto-add `connects_to` edges for the overlapping skill — the author decides whether the overlap should be resolved by narrowing the scope, adding the edge, or merging the skills.
- Does not score against skills outside `.claude/skills/` (user-scope skills in `~/.claude/skills/` or plugin skills). Project-local only.
- Does not use embeddings or LLM similarity. Lexical only — revisit only if the lexical version produces too many false negatives in practice.

---

## Operation: audit-all

For every `.claude/skills/<slug>/SKILL.md`, run `audit-skill <slug>` (which itself runs `overlap-check` as a sub-step). Emit:

- Per-skill: one line summarizing finding counts (`<slug>: 2 P0, 1 P1, 0 P2`). Overlap findings are counted in the same totals as other findings.
- Portfolio totals at the bottom (`Total: 23 skills · 3 P0 · 11 P1 · 18 P2`).
- The top 5 skills by severity-weighted finding count (P0 worth 100, P1 worth 10, P2 worth 1).
- **Top 5 overlapping skill pairs across the portfolio** (P0/P1 pairs only — P2 noise suppressed). Format: `<slug-a> ↔ <slug-b>  Jaccard=0.42  shared: "retry policy", "cache invalidation"`. Surfaces structural duplication that per-skill audits each see from only one side.

---

## Common pitfalls when authoring or editing a skill

Full pitfall list, decision matrix (skill vs agent vs hook vs plan), and authoring checklist live in `${CLAUDE_SKILL_DIR}/references/SKILL_AUTHORING.md` §Common pitfalls. The two that bite hardest at authoring time:

- **Trigger phrases in `description`** — move to `when_to_use`. Descriptions truncate from the end; trigger keywords get cut first.
- **Front-load critical instructions** — after compaction only the first 5,000 tokens of each invoked skill are re-attached.

## After every operation

Re-run `audit-skill <slug>` on any skill you just modified. Resolve P0/P1 findings before declaring done.
