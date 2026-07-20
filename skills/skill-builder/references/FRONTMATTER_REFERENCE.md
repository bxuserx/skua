# SKILL.md Frontmatter Reference

The complete frontmatter surface for a Claude Code SKILL.md. Official
Anthropic fields are sourced from
https://code.claude.com/docs/en/skills.md#frontmatter-reference. Local
conventions are marked **🏠 local** and are NOT Anthropic-blessed.

## Official Anthropic fields

### `name`

Skill display name. Lowercase kebab-case, max 64 chars. Defaults to the
directory name if omitted.

**When to set**: always. Match the directory slug exactly.

### `description`

Core capability statement. Combined with `when_to_use`, capped at 1,536
characters in the skill listing — Claude reads the listing to decide
whether to invoke. Descriptions are truncated **from the end** when the
budget overflows, so put essential keywords first.

**When to set**: always.

**Writing pattern**: lead with the use case (what it does + what it
produces). Avoid stuffing trigger phrases here — use `when_to_use` for
those.

### `when_to_use`

Trigger phrases and example user requests. Appended to `description` in
the listing; counts toward the 1,536-char cap.

**When to set**: every skill. Splitting trigger phrases out of
`description` improves auto-trigger reliability and keeps `description`
focused on capability.

### `argument-hint`

Hint shown during `/`-menu autocomplete (e.g. `[issue-number]`).

**When to set**: only if the skill takes positional arguments.

### `arguments`

Named positional args for `$name` substitution (e.g.
`arguments: [source, target]`). Names map to positions in order.

**When to set**: only if the skill body uses `$name` substitutions.

### `allowed-tools`

Tools Claude may use without per-use approval while this skill is active.
Does NOT restrict which tools are available — only suppresses prompts.

**When to set**: cautiously. Review carefully for project-level skills
before trusting them with auto-approved tools.

### `disable-model-invocation`

If `true`, Claude cannot auto-invoke the skill — only `/<slug>` works.
**Also blocks the skill from being preloaded into subagents.**

**When to set**: only for genuinely dangerous or surprising auto-actions
(e.g. `deploy`, `commit-and-push`). Do NOT set for ordinary mutators
that should still auto-trigger (e.g. `ticket-manager`, `sync-runner`).

### `user-invocable`

If `false`, hides the skill from the `/`-menu. Does NOT block Claude
from invoking it via the Skill tool.

**When to set**: for background-knowledge skills that the model should
access but users shouldn't invoke directly.

### `model`

Override the active model when this skill is invoked. Resets to session
model on the next user prompt.

**When to set**: rarely. Use only when the skill genuinely needs a
specific model.

### `effort`

One of `low | medium | high | xhigh | max`. Overrides session effort
for this skill's invocation.

**When to set**: `max` for synthesis-heavy skills (e.g. a `<domain>-review`
synthesizer, `bug-scan`); `low` for lightweight utilities. Omit to inherit
session effort.

### `context: fork`

Run this skill in an isolated subagent. The skill content becomes the
subagent's prompt; no conversation history is shared.

**When to set**: for one-shot, self-contained tasks where a clean
context is helpful (deep research, isolated audits). Do NOT set for
reference/knowledge skills — a subagent with no actionable task returns
nothing.

### `agent`

Which subagent type to use when `context: fork` is set. Built-ins:
`Explore`, `Plan`, `general-purpose`. Or any custom agent from
`.claude/agents/`.

**When to set**: always when `context: fork` is set. Defaults to
`general-purpose`. For read-only research, prefer `agent: Explore`
(Haiku, faster, skips CLAUDE.md and git status snapshot).

### `hooks`

Hooks scoped to this skill's lifecycle. See `HOOKS_QUICK_REFERENCE.md`.

**When to set**: rare. Project-level hooks usually live in
`.claude/settings.json`. Use skill-scoped hooks only when the behavior
should activate **only** while this skill is running (e.g. a linter that
runs after the skill edits files).

### `paths`

Glob patterns limiting **when Claude auto-activates** this skill. The
skill is still user-invocable at any time.

**When to set**: for skills tightly coupled to a file type (e.g.
`"**/*.test.ts"` for a test-helper skill).

### `shell`

Shell for `` !`cmd` `` blocks. `bash` (default) or `powershell`
(requires `CLAUDE_CODE_USE_POWERSHELL_TOOL=1`).

**When to set**: only if the skill uses `` !`cmd` `` dynamic context
injection on Windows.

---

## Local conventions (NOT Anthropic)

### 🏠 `connects_to`

List of skill slugs this skill routes to (orchestrators) or hands off to
(leaves). Empty list (`connects_to: []`) for self-contained skills.

**When to set**: every skill in this project. Drives the
`/graphs/skills` view in the `.skua` dashboard. See
`CONNECTS_TO_CONVENTION.md` for examples.

### 🏠 `kind`

One of `orchestrator | audit | action | generator | utility | specialized`.
Used by the skills graph view for node styling. If absent, the view
infers `orchestrator` for nodes with out-degree ≥ 2 and in-degree 0.

**When to set**: when the bucket is unambiguous. Omit if the skill
doesn't cleanly fit.

---

## String substitutions available in skill body

- `$ARGUMENTS` — all arguments typed after the skill name.
- `$ARGUMENTS[N]` / `$N` — specific argument by 0-based index.
- `$name` — named argument from the `arguments` frontmatter list.
- `${CLAUDE_SESSION_ID}` — current session ID.
- `${CLAUDE_EFFORT}` — active effort level.
- `${CLAUDE_SKILL_DIR}` — **always use this to reference bundled
  scripts/references**. Absolute paths break when the skill moves.

## Dynamic context injection

A line starting with `` !`<shell command>` `` is executed *before* the
skill content reaches Claude; the output replaces the line. The `!` must
appear at the start of a line or after whitespace — `KEY=!`cmd`` does
NOT work.

Multi-line form:

````
```!
git diff HEAD
```
````

Substitution runs once at skill-invocation time; the output is not
re-scanned for further `` !`cmd` `` placeholders. Can be disabled
globally via `"disableSkillShellExecution": true` in `settings.json`
(returns `[shell command execution disabled by policy]`).

**Use cases**: inject live git diff, current date, environment info,
external query results, file listings.

**No current project skill uses this** — it's a documented capability,
not an established pattern in this repo.

## Diagnostic and visibility tooling

- `/doctor` — surfaces skill descriptions being silently truncated due to
  budget overflow. Run if a skill seems not to auto-trigger.
- `/skills` — interactive menu. `Space` cycles state (`on` |
  `name-only` | `user-invocable-only` | `off`); saves to
  `settings.local.json`.
- `skillListingBudgetFraction` — fraction of model context reserved for
  skill listings (default 1%; increase to `0.02` if descriptions are
  being cut).
- `maxSkillDescriptionChars` — per-skill cap on `description` +
  `when_to_use` (default 1,536).
- `skillOverrides` in `settings.json`: control visibility without
  editing SKILL.md. States `"on"` | `"name-only"` |
  `"user-invocable-only"` | `"off"`.

## Reference URLs

- Official skills docs: https://code.claude.com/docs/en/skills.md
- Frontmatter reference: https://code.claude.com/docs/en/skills.md#frontmatter-reference
- Settings reference: https://code.claude.com/docs/en/settings.md
