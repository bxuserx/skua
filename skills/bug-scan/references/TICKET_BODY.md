# Bug-scan ticket body

The body written to the `--body-file` tmpfile for each confirmed bug. Mirrors
`skills/ticket-manager/templates/ticket-template.md` (body sections only — the
CLI writes the frontmatter). Keep it actionable: a reader who has never seen the
code should be able to confirm the bug and fix it from this body alone.

## Template

```markdown
### Objective
<One or two sentences: what's wrong and what fixing it achieves. State the
user-visible or system effect, not just "there is a bug at line N".>

### Context
- `<path>:<line>` — <what the code does here and why it's wrong: the failing
  input / sequence / state. This is the finder's claim, hardened by the
  refuter's surviving reasoning.>
- <Second cite if the bug spans call sites, or the upstream caller that proves
  the bad input is reachable (this is what defeated the refuter).>
- <Note any test that SHOULD have caught it but didn't, if relevant.>

### Acceptance Criteria
- [ ] <The wrong behavior no longer occurs — stated as a testable check.>
- [ ] <A regression test covers the failing input / path.>
- [ ] <Edge cases adjacent to the fix are handled (null/empty/boundary), if applicable.>

### Suggested fix
<The smallest change that addresses the root cause, with a `file:line` anchor.
A sketch is fine — name the guard to add, the comparison to flip, the resource
to close. Do NOT claim the fix was applied; this skill only files.>
```

## Severity → priority

| Finder/refuter severity | `--priority` |
|---|---|
| high — crash, data corruption, security, silent wrong result on common path | `High` |
| med — wrong result on an edge case, leak under load, recoverable failure | `Medium` |
| low — latent, hard-to-hit, or low-impact | `Low` |

Security findings carry the `security` skill's P0/P1/P2 → map P0→High, P1→Medium, P2→Low.

## Domain inference (`--domain`)

| Where the bug lives | `--domain` |
|---|---|
| Application / source / library / UI code | `app` |
| Build, CI, deploy, container, env, config | `infra` |
| Documentation, READMEs, comments-as-contract | `docs` |
| Tooling, scripts, the ticket/dev workflow itself | `meta` |

Pick the primary location where the fix will land. When genuinely split, choose
where the bulk of the fix goes.

## Tags (optional)

The CLI accepts `--tags a,b,c`. Always include `bug`. Add a dimension tag when
useful: `security`, `correctness`, `concurrency`, `error-handling`. Keep to ≤4.
