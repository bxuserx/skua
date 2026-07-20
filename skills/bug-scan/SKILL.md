---
name: bug-scan
description: "Multi-agent bug hunt over the repo containing `.skua/`: fans out finders across correctness, error-handling, resource/state, risky-pattern, and security dimensions; adversarially refutes every candidate; files survivors as actionable `0-backlog` tickets via the ticket CLI. Caps tickets per run and logs what it truncated; de-dupes against existing backlog so re-runs never refile. Read-only on user code — the only writes are new ticket markdown files. Delegates the security lens to the `security` skill rather than reimplementing it."
when_to_use: "User says 'scan for bugs', 'find bugs and file tickets', 'bug hunt this repo', 'audit the code for bugs'. Also run automatically by setup.sh on first install to populate the empty board with real findings from the user's own code (headless: `claude -p \"/bug-scan\"`)."
connects_to:
  - handoff:ticket-manager
  - handoff:security
kind: workflow
---

# Bug Scan

Hunt for real bugs across a repo and file the confirmed ones as backlog tickets. Built to run both headlessly (`claude -p "/bug-scan"`, the path `setup.sh` uses on first install) and interactively.

The product contract: the board is seeded by **real findings from the user's own code**, never demo/seed data. That makes false-positive control the whole game — a backlog full of phantom bugs is worse than an empty one. Every finding clears an adversarial refute pass before it becomes a ticket.

`ultrathink` — correctness judgments and refutations need careful reasoning, not pattern-matching.

## When to invoke

- "scan for bugs" / "find bugs and file tickets" / "bug hunt this repo" → full scan
- "audit the code for bugs" → full scan
- Offered by `setup.sh` on first install — a y/N prompt; runs headless `claude -p` on yes.

## When NOT to invoke

- **Security-only sweep** → invoke the `security` skill directly. This skill *calls* it as one lens; it is not a security entry point.
- **Per-PR / diff review** → `/code-review` or `/security-review` (change-scoped). bug-scan sweeps the whole tree.
- **Style / lint / formatting** → a linter. This skill files *bugs* (wrong behavior, crashes, data corruption), not nits.
- **A known specific bug the user already located** → just fix it, or file one ticket via `ticket-manager`. Don't spin up the whole fan-out for one item.

## Standing rules

- **Read-only on the user's code.** The ONLY writes are new ticket markdown files created through the ticket CLI (or the dashboard API). Never edit, never fix inline.
- **Never run git. Never install anything.** No `git`, no `bun add`, no `npm install`, no downloads.
- **Verify before filing.** A candidate that has not survived an independent refute pass is not a finding. Zero false-positive spam is the bar.
- **Cap and log — never silently truncate.** Default cap ≤ 15 tickets/run. If more survive, file the top-N by severity and LOG the truncated remainder (titles + one-line reason) in the final report.
- **De-dupe against the existing backlog** so re-runs don't refile the same bug.

## Definitions

- **REPO_ROOT** — the repository being scanned: the directory that contains `.skua/`. In a vendored install, the ticket CLI is at `REPO_ROOT/.skua/scripts/ticket-cli.ts`. (In *this* source repo only, it lives at `app/.skua/scripts/ticket-cli.ts` — do not hardcode that path in a scanned project.) Resolve REPO_ROOT by walking up from the cwd to the nearest `.skua/` directory.
- **Finder** — a subagent assigned one bug dimension over a slice of the tree.
- **Refuter** — an independent second opinion whose only job is to try to prove a candidate is NOT a real bug.

## Procedure

### 1. Orient

1. Resolve REPO_ROOT (nearest ancestor containing `.skua/`). All CLI calls run from there.
2. Confirm the CLI flags before filing anything: `Read REPO_ROOT/.skua/scripts/ticket-cli.ts`. Confirm `create` still takes `--title`, `--domain`, `--priority`, `--bucket`, `--body-file`. If the flags drifted, adapt the filing command in step 5 to match the file — never file against a guessed interface.
3. Size the repo (rough source-file count, excluding `node_modules/`, `.git/`, `dist/`, `.next/`, `__pycache__/`, vendored deps, lockfiles). This sets finder count (step 2).
4. **Detect repo conventions to inject into every finder.** Skim `CLAUDE.md`, key docs, and config for invariants a finder would otherwise misread — numeric scale/units, auth model, data-scope/universe rules, naming conventions — and pass a short "project conventions" block into each finder + refuter prompt. It stops finders flagging intended design as a bug AND helps them catch violations of those conventions. This is the single biggest precision lever, especially headless.

### 2. Fan out finders

Prefer the **Workflow tool** if available in this environment for the fan-out; otherwise spawn **parallel `Agent` subagents** (place all spawns in a single message so they run concurrently). Read-only finders may use the `Explore` agent.

Dimensions (one finder per dimension at minimum; split a dimension across multiple finders for a large tree):

| Dimension | Hunt for |
|---|---|
| Correctness / logic | wrong conditionals, inverted comparisons, bad control flow, wrong return values, broken invariants, mis-implemented algorithms |
| Errors / edge cases | unhandled exceptions, swallowed errors, missing null/empty/boundary handling, unchecked external/IO/parse results, partial-failure paths |
| Resource / concurrency / state | leaks (fds, handles, connections), races, shared-mutable-state corruption, missing cleanup, await/async misuse, ordering bugs |
| Risky patterns | injection (SQL/shell/path), unsafe parsing/deserialization, off-by-one, null/undefined deref, unchecked type coercions, footguns |
| **Security** | **DELEGATE to the `security` skill** — read `${CLAUDE_SKILL_DIR}/../security/SKILL.md`, invoke it as the security lens, and feed its P0/P1/P2 findings into the same refute → file pipeline. Do not reimplement security checks here. |

**Finder contract** — give each finder the step-1.4 conventions block, and require it to READ the files it cites (not pattern-match names). Each finder returns a list of candidates, each with: short title, `file:line` cite(s), a one-paragraph *why it's a bug* (the failing input / sequence / state), and a self-rated severity (high/med/low). No fixes from finders; that's step 5.

**Scale to repo size:** small repo (≲50 source files) → ~5 finders (one per dimension). Larger → split the heavier dimensions (correctness, security) across the tree by directory so no finder reads more than it can hold. A finder fed too large a slice SKIMS and under-reports — keep each slice small enough to actually READ (≈≤25 files), not just grep names. Don't over-spawn a tiny repo.

### 3. Adversarially verify (refute pass)

This is the step that protects the backlog. For **every** candidate from step 2:

1. Spawn an **independent** refuter (fresh `Agent`, no finder context) whose sole task is: *"Try to prove this is NOT a real bug."* Give it the candidate's title, cites, and reasoning, and have it re-read the cited code cold.
2. The refuter checks the usual false-positive sources: a guard/validation upstream the finder missed, a caller-side invariant that makes the bad input impossible, dead/unreachable code, intended behavior, a framework/runtime guarantee, a test that already pins the behavior.
3. **Kill only on CONCRETE disproof.** The refuter must cite specific evidence the bug cannot occur — a real upstream guard/validation (with `file:line`), an enforced caller invariant, dead/unreachable code, a pinning test, or a language/framework guarantee. Do NOT kill on speculation ("the caller probably validates", "likely intended", "unlikely input"): a refuter that hand-waves a defense produces a FALSE-EMPTY board — the failure mode seen when run headless over a large tree. If nothing concrete rebuts it, the bug stands. Keep the refuter's surviving reasoning; it becomes ticket Context.

Batch refuters in parallel (single message, multiple spawns) when there are several candidates.

### 4. De-dupe and cap

1. **De-dupe against the backlog.** Glob `REPO_ROOT/.tickets/0-backlog/TKT-*.md` (also scan `1-staging` … `5-validating` so a bug already in-flight isn't refiled; skip `6-complete`/`7-archive`). For each survivor, compare title + primary `file:line` cite against existing tickets. A match → drop the survivor and note it as "already tracked: TKT-NNN" in the report.
2. **Run the ID/board sanity check** before filing: `bun .skua/scripts/ticket-cli.ts audit-ids` (from REPO_ROOT). If it reports collisions, surface that in the report — but still file (the CLI allocates fresh IDs; pre-existing collisions are a separate board-hygiene problem).
3. **Cap.** If survivors after de-dupe exceed the cap (default 15), sort by severity (high → med → low) and keep the top N. Everything cut is **logged** in the final report (title + one-line reason), never dropped silently.

### 5. File survivors as backlog tickets

For each capped survivor, write an actionable ticket body to a tmpfile, then file it via the CLI. **Map severity → priority** (high→High, med→Medium, low→Low) and **infer `domain`** from where the bug lives (`app` for application/source code, `infra` for build/CI/deploy/config, `docs` for documentation, `meta` for tooling/workflow). The body MUST contain, in this order: `### Objective`, `### Context` (with `file:line` cites + why it's a bug, carrying the refuter's surviving reasoning), `### Acceptance Criteria` (checkbox list), and a suggested fix. See `${CLAUDE_SKILL_DIR}/references/TICKET_BODY.md` for the exact shape.

**The filing command** (run from REPO_ROOT; one invocation per confirmed bug):

```
bun .skua/scripts/ticket-cli.ts create \
  --title "<concise bug title>" \
  --domain <app|infra|docs|meta> \
  --priority <Low|Medium|High> \
  --bucket 0-backlog \
  --body-file <tmpfile>
```

- **Never hand-pick IDs.** The CLI uses the same `nextTicketId()` allocator as the dashboard and prints the new `TKT-NNN` on stdout — capture it for the report.
- New bugs land in `0-backlog` (the prioritization queue), never `1-staging`.
- **Alternative (only when the dashboard server is already running):** POST the same body to `/api/tickets`. Prefer the CLI — `setup.sh` runs bug-scan *before* the server starts, so the CLI is the path that always works.
- Clean up tmpfiles after filing.

### 6. Report

Emit a concise summary: finders run, candidates found, candidates killed by refute, survivors filed (with their `TKT-NNN`s + titles), already-tracked dupes skipped, and the **truncation log** if the cap was hit. This is the surface `setup.sh` shows the user after the first scan.

## Inputs

| param | default | meaning |
|---|---|---|
| `cap=<N>` | `15` | max tickets filed this run; remainder logged |
| `dimensions=<list>` | all 5 | restrict the fan-out (e.g. `correctness,security`) |
| `path=<subdir>` | REPO_ROOT | scan a subtree instead of the whole repo |

## Prerequisites

- `bun` on PATH (the ticket CLI is Bun). If absent, STOP and report — do not install it.
- REPO_ROOT contains `.skua/scripts/ticket-cli.ts` and a `.tickets/` tree (the dashboard scaffolds both).
- The `security` skill is installed (this skill delegates the security lens to it). If missing, run the other four dimensions and note the gap in the report.

## References

- `${CLAUDE_SKILL_DIR}/references/TICKET_BODY.md` — exact ticket-body template (Objective / Context / Acceptance Criteria / Suggested fix) + severity→priority and domain-inference rules.

## What this skill does NOT do

- Does NOT fix bugs — files them. Remediation is a separate `ticket-manager` build flow.
- Does NOT run git or install packages.
- Does NOT seed demo/placeholder tickets — every ticket is a refute-survived finding from the user's own code.
- Does NOT silently truncate — the cap is logged.
