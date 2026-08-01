---
name: ticket-manager
description: "Manages the `.tickets/` board: creates tickets (context-aware, grounded in code), refines thin backlog tickets into build-ready staged tickets ('pick up TKT-NNN' = ONE refinement pass → `1-staging`, NO code), moves tickets between lifecycle stages (backlog → staging → stuck → building → testing → validating → complete), and parks tickets in `2-stuck/` when an agentic flow needs more info or approval. Ticket template lives at `templates/ticket-template.md`."
when_to_use: "User says 'create a ticket for X', 'pick up TKT-NNN', 'work on TKT-NNN', 'move TKT-NNN to building', 'build TKT-NNN', or any other ticket-lifecycle operation."
connects_to: []
kind: utility
---

# Ticket Manager

Single skill that owns the `.tickets/` lifecycle.

## Directory model

```
.tickets/
├── scratch/        # idea stubs from the dashboard's quick-create modal; pre-lifecycle
├── 0-backlog/      # refined tickets ready for prioritization
├── 1-staging/      # post-review, awaiting user approval before build
├── 2-stuck/        # agentic flow blocked: needs info / approval
├── 3-building/     # in progress
├── 4-testing/      # post-build autonomous verification
├── 5-validating/   # tested, awaiting human review / QA / acceptance
├── 6-complete/     # accepted; auto-migrates to 7-archive after 7 days
├── 7-archive/      # long-term storage; NOT shown on the board
└── ADRs/           # architectural decisions, separate from ticket flow
```

`scratch/` holds thin stubs with only `title` + `priority`; `promote-from-scratch` writes the Objective / Context / AC and moves to `0-backlog`. Authoritative ticket template: `templates/ticket-template.md`.

## Complexity (frontmatter `complexity`, int 1–5)

`1` trivial · `2` small · `3` medium · `4` large · `5` xl.

`1` skips pass-2 + fresh-subagent test/validate. `5` → `plan-stack`, don't build as one ticket. Set at refinement; re-rate in pass-2 if wrong.

## Per-ticket next-step hint

Every lifecycle-advancing op writes a single-sentence `next_step_hint` into the ticket's frontmatter. This drives the `.skua/` dashboard hovercard's `Next:` line — when present, it overrides the generic per-bucket sentence in `.skua/lib/tickets.ts:nextStepHintFor`. Empty / absent → fallback to the canonical sentence.

**Rules:**
- One sentence, ≤140 chars, plain text (no markdown).
- Name a concrete next action that mentions a file, function, or AC bullet from THIS ticket. Generic per-bucket platitudes belong in the fallback, not here.
- Re-written by every op that lands the ticket in a new bucket. The hint is always about the bucket the ticket is now in, not the one it came from.
- If the op has nothing more specific to say than the per-bucket fallback, leave the field empty rather than copying the fallback.

**Ops that write the hint** (in addition to their other wrap-up steps):

| op | typical hint shape |
|---|---|
| `promote-from-scratch` | "Pick up TKT-NNN to scaffold AC for <one-line objective summary>." |
| `refine-from-backlog` | "Run pass-2 cold-reader against the staged AC for <one-line objective summary>." |
| `refine-staging-pass-2` | "Approve and build: <one-line build summary anchored to the first AC bullet>." |
| `build-ticket` | "Verify AC with a fresh subagent — cite <key file or function> in evidence." |
| `mark-stuck` | "Answer the Stuck Reason: <first-line summary from the Stuck Reason block>." |
| `unstick-ticket` | restore the prior bucket's hint (or clear and fall back). |

Ops that don't fit this list (`move-ticket` when not lifecycle-advancing, `link-tickets`, `record-files-touched`, etc.) leave `next_step_hint` alone.

## Operations

This skill supports four operations. Pick the one(s) implied by the user request — composing them is fine (e.g. "create a ticket and move TKT-105 to building" = `create-ticket` + `move-ticket`).

| op | trigger phrases |
|---|---|
| `flow-gate` | **First-response gate.** Any of the pick-up / build / refine / batch triggers fires `flow-gate` BEFORE the named op runs. Asks the user *"Agentic automated flow or user-driven flow?"* and waits for an explicit pick. Agentic-mode unlocks batch ops, mid-flow ticket spawning, `validate-ticket`, and the agentic-mode git policy. |
| `create-ticket` | "create a ticket for…", "file a ticket", "make a TKT for…", "track this as a ticket" |
| `promote-from-scratch` | "refine TKT-NNN" (in `scratch/`), "expand the scratch ticket", "promote TKT-NNN to backlog", "fill in TKT-NNN" — converts a thin idea stub from `scratch/` into a real backlog ticket by writing Objective / Context / Acceptance Criteria, then moving to `0-backlog` |
| `refine-from-backlog` | "pick up TKT-NNN" (when in `0-backlog`), "work on TKT-NNN", "stage TKT-NNN", "refine TKT-NNN" (when in `0-backlog`) — does TWO refinement passes: pass-1 lands the ticket in `1-staging` (Objective / Context / AC scaffolded); pass-2 runs cold-reader and lands the `### Pass-2 review` block. `build-ticket` blocks until both passes are present. |
| `refine-staging-pass-2` | "second pass on TKT-NNN", "tighten TKT-NNN", auto-runs after `refine-from-backlog` pass-1 — cold-reader re-pass that tightens AC bullets to be independently verifiable, validates `depends_on`, and appends a `### Pass-2 review` block. |
| `build-ticket` | "build TKT-NNN", "implement TKT-NNN", "ship TKT-NNN", "do TKT-NNN" — implements the ticket, then automatically moves it to `4-testing` with `record-files-touched` + `record-implementation-summary` + wrap-up. Blocks if pass-2 review is missing. |
| `test-ticket` | Auto-runs after `build-ticket` lands a ticket in `4-testing`. Spawns a fresh `Agent` subagent to verify AC bullet-by-bullet against the diff. Evidence-required verdict: each bullet must cite a command-output excerpt or file:line. Pass → `5-validating`. Fail → `2-stuck`. |
| `validate-ticket` | Auto-runs after `test-ticket` passes and the ticket lands in `5-validating`. Spawns a **second, distinct** fresh subagent that judges the whole ticket on four axes (objective fidelity / context-constraint respect / sprawl / follow-ups). Pass → stays in validating + triggers agentic-mode git policy if applicable. Fail → `2-stuck`. |
| `adversarial-pass` | Auto-runs in agentic mode **concurrently with** `test-ticket`. A fresh subagent whose job is to BREAK the change, not confirm it: construct an input the fix mishandles, an evasion the new guard misses, a revert that still passes. Findings feed `rectify-findings`. Confirmatory verification (`test-ticket`) and refutation are different prompt classes — running only the former is how a guard that asserts nothing ships green. |
| `rectify-findings` | Auto-runs after `adversarial-pass` / `test-ticket` return findings. The PARENT fixes each confirmed finding in place, then re-runs only the narrow check that failed. Two rectify rounds max, then `2-stuck`. This is what replaces "route to stuck on first fail" in agentic mode — stuck is for questions only the user can answer, not for defects the agent can fix. |
| `spawn-ticket-mid-flow` | First-class judgment during build / test / validate when the agent discovers in-scope work that belongs in a separate ticket. Decides ordering: defer-to-backlog / splice-front / splice-back. Always called via the existing `create-ticket` machinery with a `### Why this was spawned mid-stack` body block. |
| `plan-stack` | "plan a stack", "group the backlog", "what should I work on next" (agentic mode) — reads `0-backlog/`, scores ticket affinity, partitions into sub-stacks of ≤5 tickets sized to a single context window. Writes `.skua/cache/stacks/<id>.json`. No file moves. |
| `run-stack` | "run stack <id>", "go" (after `plan-stack`) — walks `members[]` end-to-end: refine → pass-2 → build → test → validate → commit prompt. Only stops at `.tickets/STOP`, a `2-stuck/` route, a destructive-op confirm, or the per-ticket commit/push prompt at validating. Foreground only in v1. |
| `stack-status` | "stack status", "where are we" — reads the active stack record and per-ticket bucket state, reports queued / refined / staged / built / tested / validating / complete / stuck / failed. Pure read. |
| `agentic-commit` | Auto-fires after `validate-ticket` passes when `agentic_mode: true`. Prompts the user once with a draft commit message; on a single `y` confirm, creates one atomic commit per ticket AND pushes.  |
| `mark-stuck` | "TKT-NNN is stuck", "park TKT-NNN — need approval", "stuck on TKT-NNN" — used by the agentic flow when it cannot proceed without additional information or human approval; moves the ticket to `2-stuck/` and appends a `### Stuck Reason` block to the body explaining what's needed |
| `unstick-ticket` | "unstick TKT-NNN", "TKT-NNN is unblocked", "resume TKT-NNN" — user confirms the question is answered or approval is given; moves the ticket back to `3-building` (or `1-staging` if it was never built) and the agentic flow may resume |
| `move-ticket` | "move TKT-NNN to <stage>", "promote to ready", "mark as building", "ship to validating", "complete TKT-NNN" |
| `link-tickets` | "TKT-A depends on TKT-B", "TKT-A blocks TKT-B", "link TKT-A and TKT-B as related" |
| `record-files-touched` | "record the files TKT-NNN edited", "snapshot files for TKT-NNN" — also runs automatically as the final step of `move-ticket` when the destination is `4-testing` or `6-complete` |
| `record-implementation-summary` | "write the implementation summary for TKT-NNN" — also runs automatically alongside `record-files-touched` when the destination is `4-testing`. Appends a `### Implementation Summary` prose section to the ticket body. |

There is also a parallel GUI for these same operations at `.skua/` —
a Bun-served localhost dashboard (`cd .skua && bun run start`). The
dashboard reads and writes the **same** ticket files this skill manages;
operations in either place yield identical filesystem state. The skill
remains the canonical mechanism for AI-driven changes; the dashboard is
the human-driven UI.

**Stale-complete archiving is NOT a skill op.** The `.skua/` server's `archiveStaleComplete()` moves `6-complete/` tickets older than 7 days to `7-archive/` on every `/api/buckets` poll. This skill does nothing about archiving.

> ⚠ EXPERIMENTAL — autonomous coding agents have wiped production databases (Replit, July 2025; AI Incident DB #1152). Review every diff. Three known failure modes: irreversible actions, context rot, fabricated status reports. **This warning applies to every agentic-mode op below** (`flow-gate`, `refine-staging-pass-2`, `test-ticket`, `validate-ticket`, `spawn-ticket-mid-flow`, `plan-stack`, `run-stack`, `agentic-commit`); not repeated per-op.

---

## Operation: flow-gate

The **first** response to any of the pick-up / build / refine / batch triggers must be the flow gate. No file reads, no exploration, no other ops — just the one-line question.

### When to run

Triggered before any of:
- `pick up TKT-NNN` / `work on TKT-NNN` / `refine TKT-NNN` (against backlog)
- `build TKT-NNN` / `implement TKT-NNN` / `ship TKT-NNN`
- `refine-from-backlog` / `plan-stack` / `run-stack`

### Procedure

1. **Inline-mode detection (first, before any prompt).** Scan the trigger phrase for an explicit mode pick. Treat any of these as **agentic, no question asked**:
   - the word "agentic" (e.g. "pick up TKT-181 in agentic mode", "build TKT-NNN agentically", "run stack agentic", "go agentic", "--agentic")
   - the word "autonomous" / "autonomously" / "auto"
   - explicit flow words: "drive end-to-end", "full loop", "run the whole flow"

   Treat any of these as **user-driven, no question asked**:
   - "user-driven", "manual", "step by step", "one step at a time", "I'll drive"

   **Chaos is a third execution mode, but it is NOT enterable here.** If the request implies fully-autonomous, *no-human-review* execution ("chaos", "drain the backlog unattended", "no oversight / no review", "arm chaos", "run it autonomously with nobody watching"), do NOT pick a mode — **redirect**: tell the user chaos runs through its own explicit arming ceremony and point them at the `chaos` skill (`/chaos`). Never start chaos from this gate. (Plain "autonomous"/"auto" still means **agentic** — chaos is specifically the *no-review* mode: zero human gates, a `chaos/TKT-NNN` worktree per ticket, and by default it **merges to `main` and pushes to origin as it runs**. Do not tell the user chaos cannot touch `main`; that is only true if they set `land_during_run: false`.)

   If a mode is detected inline, skip steps 2–3 and jump to step 4 with that pick. Do not echo a confirmation — just proceed and let the first real op's preamble announce what's happening.
2. Only if no inline mode is detected, output exactly:
   > **Agentic automated flow or user-driven flow?**
   >
   > - **Agentic** — I drive the loop end-to-end. I only stop at `2-stuck/` in the ticket board, or the per-ticket commit/push prompt at validating.
   > - **User-driven** — single-ticket ops, one step at a time. CLAUDE.md git rule applies.
3. Wait for an explicit pick. **Silence is treated as user-driven, not agentic** — never default to agentic to "be efficient".
4. If the pick is agentic, write or update the active stack record at `.skua/cache/stacks/<id>.json` (or `solo-<TKT-ID>.json` for a single-ticket agentic invocation) with `agentic_mode: true`. The presence of this flag on the active record is the SINGLE gate that unlocks: batch ops, mid-flow ticket spawning, `validate-ticket`, the agentic-mode git policy, and the experimental UI banner.
5. If user-driven, proceed with the named op as today. No stack record is written.

### Honesty rules

- **Default-deny on ambiguity.** If the user replies with anything other than a clear pick (e.g. "yeah" / "either" / "whatever"), re-ask once. Still ambiguous → user-driven. *(Applies only when the gate prompt was actually shown — inline-mode detection in step 1 short-circuits this.)*
- **Never auto-promote a user-driven session to agentic** mid-flow. The user must restart with a fresh gate.
- The gate prompt is skippable **only** via the inline-mode signals in step 1 — never via inference, never via "the user probably meant…", never via prior-session memory.

---

## Agentic speed contract (cross-cuts every op below)

Agentic mode drifts toward **30+ minutes for small tickets**. The cause is never one slow
step — it is five sequential cold-read phases per ticket, each re-deriving what the last
already knew, run strictly one ticket at a time. Depth is not free and is not always
warranted. These rules are binding on `run-stack`, `build-ticket`, `test-ticket`,
`adversarial-pass`, and `validate-ticket`.

### 1. Depth ladder — grade the ceremony to `complexity`

| complexity | refine | build | verify | validate |
|---|---|---|---|---|
| **1** trivial | skip pass-2 | inline | parent self-checks + cites evidence; **no subagent** | skip |
| **2** small | pass-2 inline (no subagent) | inline | ONE subagent doing test **and** adversarial in a single prompt | fold into the same subagent as a 5th section |
| **3** medium | pass-2 inline | inline | test + adversarial as **two concurrent** subagents | separate subagent |
| **4-5** large | full pass-2 | inline | two concurrent subagents | separate subagent |

Complexity 5 → `plan-stack`, don't build as one ticket. A ticket whose diff lands under
~40 lines across ≤3 files is complexity ≤2 regardless of what the frontmatter claims —
re-rate it down and say so, rather than paying for ceremony the change can't justify.

### 2. Run independent members CONCURRENTLY

`run-stack` processes members "in order". Order only matters for members that actually
interact. Before the loop, partition `members[]`:

- Two members are **independent** if their predicted `files_touched` are disjoint AND
  neither appears in the other's `depends_on`.
- Independent members run **in the same message, in parallel** — one `Agent` call each.
- Dependent members stay serial within their chain.

A 6-ticket stack touching 6 unrelated files is one parallel wave, not six serial passes.
State the partition in the plan summary so the user can see what runs together.

**Disjoint `files_touched` is NOT sufficient — shared fixtures couple agents invisibly.**
Some files nobody lists as touched are depended on by everyone: `conftest.py`, global test
setup, lint/tsconfig, shared factories. A parallel member that edits one changes what
*other* members' tests can import — a failure that then looks like the other agent's bug.
So:

- A parallel member MUST scope test stubs/fixtures to its **own test module**, never to a
  shared `conftest.py` or global config.
- If a member genuinely needs a shared-fixture change, it leaves the wave and runs serial.
- Expect transient cross-member red. Before blaming a member's own diff for a failing test,
  check `git status` for files it did not author — in a parallel wave the tree is shared
  and another member's uncommitted work is the likelier cause.

### 3. Hand subagents the context — "cold" means unbiased, not uninformed

Every subagent prompt MUST inline: the ticket markdown, the **actual diff hunks** (not just
`--name-only`), and the exact verification commands to run. Cold-read means *don't trust
the parent's conclusion* — it does NOT mean "re-discover the repo from scratch." A
subagent told to go find the change spends most of its budget on search. Forbidden in a
subagent prompt: "explore the codebase", "find the relevant files", "familiarize yourself".

### 4. Budgets, and say when you hit one

- Refine ≤8 tool calls · build ≤25 · each verify subagent ≤20 · validate ≤12.
- Exceeding a budget is not a failure — it's a signal the ticket is under-rated. Finish,
  then say "TKT-NNN ran N calls over the build budget; complexity should be X not Y."
- Never poll on a fixed sleep when a single terminal check would do. Never re-read a file
  to confirm an `Edit` landed — `Edit` errors if it didn't.
- One lint/type-check run per ticket at the END, not after each edit.

### 5. Don't re-verify settled facts

Within one stack run, a fact established by a real command (test count, file contents, a
schema shape) is settled. Do not re-derive it in a later phase; quote the earlier result
and cite which step produced it. If a later phase genuinely needs to re-check, say why.

---

## Operation: create-ticket

### 1. Determine the next ID

**Do not hand-scan folders for this.** Run the deterministic allocator:

```
bun .skua/scripts/ticket-cli.ts next-id
```

It prints the next free `TKT-NNN` by scanning **all 9 buckets** (`scratch/` + `0-backlog`…`7-archive`) via the same `nextTicketId()` the dashboard's quick-create uses — so the skill and the GUI can never mint diverging IDs. Use its output verbatim. (The old "eyeball `ls` for max+1" rule omitted `scratch/`, which is exactly how duplicate-ID collisions get minted — never reintroduce a hand-scan.)

If `bun` is unavailable, fall back to scanning **every** bucket including `scratch/` and `7-archive/` for `TKT-(\d+)-*.md` and take `max + 1` (start at `TKT-101` if none) — but the script is the source of truth; prefer it.

### 2. Gather context (this is the part that matters)

The point of this skill is that tickets are not vague handwaves — they cite the code. Before writing the ticket:

- **Grep / Read the relevant area of the repo.** If the user says "fix the auth redirect bug", grep for `redirect`, read the auth files, identify file:line where the bug lives. If they say "add a CSV export endpoint", find the closest existing endpoint and follow its shape.
- **Surface adjacent tickets.** Grep across all `.tickets/*/TKT-*.md` for related keywords; if an existing ticket overlaps, mention it in the Context section or ask the user whether the new ticket should be folded in.
- **Check memory and ADRs.** If a relevant ADR exists in `.tickets/ADRs/` or a relevant memory in `MEMORY.md`, cite it.
- **Verify the framing.** If the user's framing assumes something that isn't true (a file that doesn't exist, a function that's already been removed, a constraint that's been lifted), stop and ask — don't write a ticket against a wrong premise.

Budget: spend roughly 3–6 tool calls on context-gathering for a normal ticket. More if the area is genuinely unfamiliar; less if the user already cited the file. **Never skip this step entirely** — a ticket with no Context section is the failure mode this skill exists to prevent.

### 3. Classify the domain

Every ticket must be assigned to exactly **one** primary `domain` from this fixed taxonomy. The domain captures which knowledge area / deploy unit owns the work, so the board can be filtered and the right context loaded later.

| Domain | Slug in filename | What it covers |
|---|---|---|
| App | `app` | Application code — UI, services, business logic, whatever the product itself is |
| Infra | `infra` | Deploy / CI / config / ops — pipelines, container config, IaC, networking, secrets, environment |
| Docs | `docs` | Documentation — guides, READMEs, reference, architecture write-ups |
| Meta | `meta` | Tooling, skills, the skua board itself, cross-cutting decisions that don't tie to a single deploy unit |

These four labels are the generic default; a team can rename them to match its repo (e.g. split `app` into `frontend` / `backend`). Keep the set small and the slug lowercase.

**Rules:**
- Pick the **primary** domain — where the bulk of the work lives or where the code being changed/built ships from.
- For cross-cutting tickets (e.g. a skill that audits both the API and Analytics containers), pick the primary AND list the others in `secondary_domains` frontmatter.
- An orchestrator skill that routes to subskills in multiple domains → `meta` (the orchestrator itself doesn't live in any single deploy unit).
- A ticket that fixes a UI bug but requires a supporting backend change → pick the domain where the bigger lift lands; the secondary slot captures the other side. Use judgement.
- When in doubt between two `app` sub-areas: which one ships the change you'd point a reviewer at? That's the primary.

### 4. Fill the template

Read `templates/ticket-template.md` from this skill directory. Substitute:

- `id`: the computed `TKT-XXX`.
- `title`: concise, sentence-case, no trailing period. Should read as a noun phrase or imperative ("Implement the login form", not "Should we add a login form?").
- `status`: `"Todo"` unless the user specifies otherwise. (Status is also encoded by which folder the file lives in; the frontmatter field is a convenience.)
- `priority`: infer from urgency cues. Default `"Medium"`. `"High"` for blockers, production bugs, or explicit user emphasis. `"Low"` for nice-to-haves.
- `assignee`: `"Claude-Agent"` if the work is code execution; `"User"` if it requires human judgement, external access, or design decisions Claude can't make.
- `created`: today's date in `YYYY-MM-DD`.
- `domain`: one of `app | infra | docs | meta` from step 3.
- `secondary_domains`: optional list, only for cross-cutting tickets. Same taxonomy.
- `tags`: 1–4 lowercase categories. Common tags: `bug`, `feature`, `refactor`, `docs`, `infra`, `frontend`, `backend`, `tests`. Match existing tickets' tag vocabulary when possible. Tags are orthogonal to `domain` — `domain` is structural (which deploy unit), tags are descriptive (what kind of work).
- `depends_on` / `blocks` / `related`: populate by scanning all existing ticket IDs + titles (one `ls` across `.tickets/*/TKT-*.md` — no body reads needed). For each existing ticket, assess: does the new ticket require it to be done first (`depends_on`)? Does the new ticket block it (`blocks`)? Do they address overlapping concerns without strict ordering (`related`)? Set an ID only when the connection is clear; leave the array empty when ambiguous. `depends_on` and `blocks` are directional opposites — set whichever feels natural; do not set both for the same edge. The `link-tickets` op remains the correction path for relationships missed or mis-classified here.
- `complexity`: int 1–5 per the Complexity rubric.
- **Objective**: 1–3 sentences. State what + why.
- **Context**: bulleted file:line citations and pointers from step 2. This is the section that makes the ticket actionable.
- **Acceptance Criteria**: 2–6 testable checks. Each should be verifiable without re-asking the user.
- **Out of Scope** / **Notes**: only if useful; otherwise omit.

### 5. Write the file

Filename: `TKT-XXX-<domain>-<slugified-title>.md`. The domain slug from step 3 immediately follows the ID, before the title slug, so `ls` output sorts naturally and a grep for `TKT-*-app-*` returns all app-domain tickets without parsing frontmatter.

Examples:
- `TKT-104-app-add-login-form.md`
- `TKT-112-infra-ci-cache.md`
- `TKT-109-meta-security-orchestrator-skill.md`

Slug rules: lowercase, ASCII, `-`-separated, drop punctuation, total filename max ~80 chars after the domain prefix. Write to `.tickets/0-backlog/`.

New tickets **always** land in `0-backlog/`, never in `1-staging/`. `1-staging/` is reserved for tickets that have been through the AI's review and are awaiting **explicit user approval** before the automated build process picks them up — the AI populates this bucket; the user gates the move out of it.

### 6. Confirm

Echo the ticket path and a one-line summary to the user. Do not paste the full ticket body unless asked.

### 7. Scope the work

Note in the Context section (or in `files_touched` once known) the repo-relative paths the work is expected to touch. The authoritative post-build capture is `record-files-touched`; at creation time, a one-line scope note in Context is enough.

---

## Operation: move-ticket

### Stage map

| user word | folder |
|---|---|
| backlog | `0-backlog` |
| staging, approved-for-build, post-review | `1-staging` |
| stuck, blocked, awaiting-approval, awaiting-info | `2-stuck` |
| building, in-progress, started, wip | `3-building` |
| testing, autonomous-test, post-build | `4-testing` |
| validating, review, qa, blocked-on-review | `5-validating` |
| complete, done, accepted, shipped | `6-complete` |
| archive | `7-archive` (rare; auto-archive handles this) |

### Procedure

1. Find the ticket file by ID across all stage folders. If the user gave only a title or fuzzy reference, list candidates and confirm.
2. Move the file with plain `mv` — **always**, never `git mv`. 
3. Update the `status` field in the ticket's frontmatter to match the destination (`"Todo"` for backlog/staging, `"Stuck"` for stuck, `"In Progress"` for building, `"Testing"` for testing, `"Validating"` for validating, `"Complete"` for complete, `"Archived"` for archive).
4. If moving to `6-complete`, add a `completed: YYYY-MM-DD` field to the frontmatter (today's date). The `.skua/` server's `archiveStaleComplete()` reads this on every `/api/buckets` poll to decide when to migrate the ticket to `7-archive/`.
5. **Chaos auto-land (only when moving to `6-complete`).** If the ticket has a `chaos_branch:` frontmatter field and no `merged:` stamp, it is approved chaos work — moving it to complete is the approval signal. Run `bun .skua/scripts/chaos-merge.ts reconcile` to merge the approved `chaos/*` branch into the target branch (idempotent; it only ever touches `chaos/*` branches, runs in a dedicated worktree, stamps `merged:`/`merge_commit:`, and flags any conflict with `merge_conflict: true`). This per-ticket path stays conservative and does NOT guess at conflicts — if one is flagged, tell the user to run `/chaos-land`, which lands the whole queue autonomously and resolves conflicts with a best-effort merge. Skip this step for non-chaos tickets (no `chaos_branch`).

### Allowed transitions

Generally `backlog → staging → building → testing → validating → complete → archive`, but the skill does not enforce this rigidly — users can move tickets backward (e.g. validating → building if review fails) or skip stages (backlog → building for a hotfix). Just do what the user asks; only push back if the move is clearly nonsensical (e.g. `archive → building` without explicit reactivation intent).

The `4-testing` bucket is the home of the `test-ticket` op (autonomous post-build verification by a fresh-context subagent). Manual moves through testing are permitted; the bucket is not gated to that op.

### Files-touched capture on post-impl transitions

When a ticket moves into `4-testing` **or** `6-complete`, also run `record-files-touched`. Testing captures the initial build; complete captures any fix-ups made during validation. The two captures are union'd, so the final list reflects everything edited across both phases. See the `record-files-touched` operation below for the capture procedure.

### Implementation summary on testing entry

When a ticket moves into `4-testing`, also run `record-implementation-summary` alongside `record-files-touched`. This appends a `### Implementation Summary` prose section to the ticket body capturing the narrative of what was actually built. See the `record-implementation-summary` operation below for the procedure.

---

## Operation: build-ticket

Implements the work described in a ticket (currently in `1-staging` or `3-building`), then moves it to `4-testing` when done.

### Procedure

1. Locate the ticket file. If it's in `0-backlog`, stop — run `refine-from-backlog` first and wait for user approval.
2. **Staleness gate.** If the ticket's pass-2 (or its `created` date, when no pass-2 exists) predates other tickets that have since reached `5-validating`/`6-complete`, re-verify the Context cites BEFORE building: do the named files/functions still exist? Newer work can supersede a staged ticket in place (e.g. its target spec files get deleted by later tickets while it sits staged). If the premise is gone, retire it with a `### Superseded` evidence block → `6-complete`, don't build.
3. **Pass-2 gate.** If the ticket is in `1-staging` but its body lacks a `### Pass-2 review` block, stop with: *"Ticket needs pass-2 refinement before building. Run `refine-staging-pass-2 TKT-NNN` (or just `pick up TKT-NNN` again — pass-2 will auto-fire if pass-1 is already done)."* This gate is non-bypassable — in agentic mode the pass-2 op fires automatically before this check is reached, so the gate only trips in user-driven mode when the user skipped pass-2.
4. If it's in `1-staging` (with pass-2 present), move it to `3-building` first (update `status: "In Progress"`), then begin implementation.
5. Do the implementation work. This is the only operation in this skill that writes code.
6. **Watch for mid-flow ticket spawning.** While implementing, if you discover in-scope work that doesn't belong in the current ticket (a separable bug, a refactor that should be its own change, a missing test surface), follow `spawn-ticket-mid-flow` to file a new backlog ticket rather than silently expanding the current one.
7. When implementation is complete, run `move-ticket` to `4-testing`. This automatically triggers `record-files-touched` + `record-implementation-summary` + wrap-up. From `4-testing`, `test-ticket` (auto in agentic mode) verifies AC and graduates the ticket to `5-validating`, where `validate-ticket` performs full ticket review.

### Critical: always end in testing

"build TKT-NNN" is not complete until the ticket is in `4-testing`. Never leave a finished build in `3-building`. The move signals to the user (and to the autonomous test-ticket op, once TKT-169 ships) that the work is ready for verification.

### If the build is blocked: hand off to `mark-stuck`

If implementation cannot proceed because a question must be answered, an
external approval must be granted, or required information is missing,
**do not stall in `3-building`** — run `mark-stuck` to park the ticket in
`2-stuck/` with a written `### Stuck Reason` block. The agentic-flow
orchestrator polls `2-stuck/` for human attention; leaving the ticket in
`3-building` hides the blocker.

---

## Operation: mark-stuck

Used by the agentic flow when forward progress on a ticket requires
additional information or approval that only the user can provide. Parks
the ticket in `2-stuck/` and records WHY in the ticket body so the user
sees the question on the dashboard without reading the agent's transcript.

### When to run

- The agent has a concrete blocking question (a design choice it cannot
  make autonomously, a credential it needs, an approval to touch a shared
  resource, a contradiction in the spec).
- An external dependency is unavailable (an upstream API down, a
  pre-requisite ticket not yet merged) and waiting wastes the agent's
  context window.
- The user has set the agent loose on `build-ticket` and the agent
  realises the staged plan won't work as-written.

### Procedure

1. Locate the ticket file by ID. It is typically in `1-staging`,
   `2-stuck` (re-stuck), or `3-building`.
2. Append a `### Stuck Reason` block to the ticket body (BEFORE the
   `### Implementation Summary` placeholder if present). Structure:
   ```markdown
   ### Stuck Reason

   **Asked:** YYYY-MM-DD
   **Needs:** <one-line summary — "approval", "information", "design choice", "external">

   - <Specific question or blocker, one bullet per distinct ask.>
   - <Include file:line cites if the blocker lives in code.>

   **Suggested resolution:** <The agent's best-guess answer or A/B options the user can pick from. Skip if there is no defensible default.>
   ```
3. Run `move-ticket` to `2-stuck`. This updates `status: "Stuck"`.
4. **Stop.** Do not continue any other operation on this ticket until the
   user runs `unstick-ticket`. The agentic flow MUST treat
   `2-stuck/` as a hard barrier.

### Honesty rules

- One ticket, one block at a time. If you have three questions, list all
  three in the same `### Stuck Reason` section — do not split into three
  tickets and do not park-then-resume in a loop.
- The `Suggested resolution` line is optional but recommended. It lets
  the user answer "yes do that" instead of having to compose a full reply.

---

## Operation: unstick-ticket

User-driven inverse of `mark-stuck`. The user has answered the question
or granted the approval; the ticket can resume.

### Procedure

1. Locate the ticket file in `.tickets/2-stuck/`.
2. Append a `**Resolved:** YYYY-MM-DD — <one-line summary of the user's answer>`
   line to the bottom of the `### Stuck Reason` block (leave the rest of
   the block intact as an audit trail).
3. Move the ticket back to its prior bucket:
   - If the build had already started (the body contains `### Implementation Summary`
     scaffolding from a prior `3-building` pass, or the user explicitly says
     "resume building"), move to `3-building`.
   - Otherwise move to `1-staging` so the user can re-approve the (now-amended)
     plan before code is written.
4. Update `status` to match the destination (`"In Progress"` or `"Todo"`).
5. The agentic flow may now pick this ticket up again.

### When to run

- User says "unstick TKT-NNN", "TKT-NNN is unblocked", "resume TKT-NNN",
  "TKT-NNN can continue", or replies to the dashboard's stuck-reason
  prompt with an answer.

---

## Operation: link-tickets

Edit the `depends_on` / `blocks` / `related` arrays in one or more tickets' frontmatter.

### Procedure

1. Resolve both ticket IDs across all lifecycle folders (including `7-archive`). If either is missing, stop and report.
2. Pick the field:
   - "A depends on B" → append `TKT-B` to A's `depends_on`.
   - "A blocks B" → append `TKT-B` to A's `blocks`.
   - "link A and B" or "A is related to B" → append `TKT-B` to A's `related`.
3. Edit only the frontmatter; do not touch the body. Use the same atomic write pattern the skill already uses for status updates.
4. Idempotent: if the ID is already present in the target list, no-op (do not duplicate).
5. Inverse relations are **not** auto-mirrored — a `depends_on` entry from A→B does not auto-add a `blocks` entry from B→A. The user (or the dashboard) sets each direction explicitly to keep edges single-source.


---

## Skills graph awareness (meta-domain tickets)

The `.skua/` dashboard renders a third graph kind at `/graphs/skills`, built from each `.claude/skills/**/SKILL.md`'s `connects_to` frontmatter list. The graph is **automatically** rebuilt by the server when any source SKILL.md is newer than `cache/skills-graph.json` (see `.skua/server.ts:skillSourceMtimes`), so no skill op needs to invalidate the cache by hand.

What `ticket-manager` *does* owe meta-domain tickets that add, remove, or modify a `.claude/skills/**/SKILL.md`:

1. **Verify `connects_to` is current** before the move to `4-testing`. If the ticket added a new skill, every existing skill that should reference it must have its `connects_to` updated; if the ticket deleted a skill, dangling references must be pruned. Delegate the actual audit to `skill-builder` (it owns the `connects_to` spec) rather than checking inline.
2. **Record SKILL.md edits in `files_touched`.** For a pure meta ticket whose only "scope" is skill-portfolio shape, rely on `files_touched` to record which SKILL.md files changed.
3. **No skill op writes `connects_to`.** That field is human-curated (or skill-builder-proposed); `ticket-manager` only flags drift, never mutates it.

If a meta ticket's `files_touched` list contains any `.claude/skills/**/SKILL.md`, the wrap-up should remind the user to refresh `/graphs/skills` in the dashboard (the auto-rebuild fires on next page load — no manual `bun run build:graphs` needed).

---

## Operation: promote-from-scratch

Convert a thin idea stub from `.tickets/scratch/` (created by the user via the `.skua/` dashboard's quick-create modal) into a real backlog ticket. The stub has `title` + `priority` + maybe a few fields, no body. Your job is to do the context-gathering that the user skipped, write the body, and move the ticket into `0-backlog`.

### Procedure

1. Locate the ticket file in `.tickets/scratch/`. Read its frontmatter and body. The body will typically be empty.
1a. **ID-collision check (mandatory).** Both the skill's `next-id` allocator and the dashboard's `nextTicketId()` now scan `scratch/`, so newly-minted IDs can't collide — but a scratch stub created by the OLD path (or hand-edited) may already carry a duplicate ID. Before promoting, run `bun .skua/scripts/ticket-cli.ts audit-ids`: if it reports this ticket's ID as a duplicate, renumber the scratch ticket to `bun .skua/scripts/ticket-cli.ts next-id` (rename the file AND update the `id:` frontmatter) before proceeding. Carrying a duplicate ID into a lifecycle folder corrupts every ID-keyed op (`move-ticket`, `link-tickets`, `build-ticket`).
2. Run the same context-gathering pass as `create-ticket` step 2 — grep / read the relevant area of the repo, surface adjacent tickets, check ADRs and memory, verify framing. If the title is too vague to act on (e.g. "fix the thing"), stop and ask the user for the missing pivot.
3. Reclassify the `domain` if the user left it as the default `meta` and the work clearly belongs to a different deploy unit. Same rules as `create-ticket` step 3.
4. Update or fill any other empty frontmatter fields:
   - `tags`: 1–4 lowercase categories.
   - `depends_on` / `blocks` / `related`: scan all existing ticket IDs + titles (one `ls` across `.tickets/*/TKT-*.md`). Assess each for hard ordering (`depends_on`/`blocks`) or family overlap (`related`). Set IDs only when the connection is clear; leave empty when ambiguous. Same heuristics as `create-ticket` step 4.
   - `complexity`: int 1–5 per the Complexity rubric.
5. Write the body using the standard `create-ticket` step 4 structure: **Objective**, **Context** (with file:line citations from step 2), **Acceptance Criteria**. The user's title is the seed for the Objective.
6. Rename the file if the domain changed (`mv TKT-NNN-meta-foo.md TKT-NNN-app-foo.md`) so the filename's domain slug matches the frontmatter.
7. Run `move-ticket` to `0-backlog`. This updates `status` from `"Idea"` to `"Todo"` and triggers the standard wrap-up.

### When to run

- The user says "refine TKT-NNN", "promote TKT-NNN", "expand the create-bucket ticket", or similar.
- Periodically, the user may say "process the create bucket" — work through every `scratch/` ticket and promote each one. Ask before doing this proactively; it can be a lot of work.

### Honesty rules

- If the user's stub is too vague to ground in code, say so and ask one clarifying question — do not fabricate Context.
- Preserve the user's intent. The title they wrote is the authoritative statement of what they want; refine wording only if the original was unparseable.

---

## Operation: refine-from-backlog

Take a ticket sitting in `.tickets/0-backlog/` — typically thin (free-text body, no structured sections, sparse frontmatter) — and produce a build-ready ticket landed in `.tickets/1-staging/` for the user's approval gate. This is the operation that fires when the user says "pick up TKT-NNN" or "work on TKT-NNN" for a backlog item.

### Critical: backlog ≠ build

"Pick up TKT-NNN" from the backlog is a request to **refine and stage**, NOT to implement. This skill never writes implementation code as part of `refine-from-backlog`. Code is only written after the user issues an explicit build prompt (e.g. "build TKT-NNN", "ship it", "go ahead") against a ticket already in `1-staging` AND the ticket has a `### Pass-2 review` block (see `refine-staging-pass-2` below). Skipping the staging gate steals the user's review opportunity and is the failure mode this operation exists to prevent.

If you are not certain whether the user wants refinement-only or full implementation, ask before writing code. The cost of one clarification is far lower than the cost of bypassing the approval gate.

### Two-pass model

`1-staging/` is a **two-touch** bucket:
- **Pass-1** (this op) — scaffolds body + fields from the backlog stub, moves to `1-staging/`.
- **Pass-2** (`refine-staging-pass-2`) — cold-reader cross-check, AC tightening, `depends_on` validation, appends a `### Pass-2 review` block.

`build-ticket` will refuse to run until both passes are present. In agentic mode, pass-2 fires automatically after pass-1. In user-driven mode, the user invokes pass-2 explicitly with a second `pick up TKT-NNN` (or `tighten TKT-NNN`).

### Procedure

One pass, well-executed, with simultaneous attention to body content AND field optimization. If the result needs further refinement, the user will request it explicitly.

1. Locate the ticket file in `.tickets/0-backlog/`. Read its current frontmatter and body.
2. Run the same context-gathering pass as `create-ticket` step 2 — grep / read the relevant area of the repo (3–6 tool calls is a reasonable budget), surface adjacent tickets, check ADRs and memory, verify framing. If the body's premise is wrong (a file that doesn't exist, a function already removed), stop and ask before refining against a wrong frame.
3. Reclassify `domain` if needed; same rules as `create-ticket` step 3. Rename the file if the domain slug changes.
4. Fill / tighten **frontmatter fields** in the same pass:
   - `tags`: 1–4 lowercase categories grounded in what context-gathering revealed.
   - `depends_on` / `blocks` / `related`: scan all existing ticket IDs + titles (one `ls` across `.tickets/*/TKT-*.md` — no body reads needed). Assess each for hard ordering (`depends_on`/`blocks`) or family overlap (`related`). A relationship is only written when clearly warranted; ambiguous cases stay empty. Good heuristics: tickets in the same domain family (e.g. a cluster of related skill tickets, the three security subskill tickets) are almost always `related`; a ticket that requires infrastructure another ticket provides is a `depends_on` candidate.
   - `files_touched`: note the repo-relative paths this ticket is *planned* to touch, if known. Leave empty if the work has no concrete file surface yet — the authoritative capture is `record-files-touched` post-build.
   - `complexity`: int 1–5 per the Complexity rubric.
5. Rewrite the **body** using the `create-ticket` step 4 structure: **Objective** (1–3 sentences, what + why), **Context** (bulleted file:line citations from step 2 — this is the section that makes the ticket actionable), **Acceptance Criteria** (2–6 testable checks), **Out of Scope** if useful. Preserve the user's original intent — the title and free-text body are the seed; do not pivot the scope without asking.
6. Update `status` to `"Todo"` (staging uses the same status value as backlog; the bucket is the source of truth for stage).
7. Move the file to `.tickets/1-staging/` via plain `mv`.
8. **STOP.** Report what was refined and that the ticket is staged for the user's review. Do not proceed to `3-building` or write any code. Wait for an explicit build prompt.

### When to run

- The user says "pick up TKT-NNN" / "work on TKT-NNN" / "stage TKT-NNN" / "refine TKT-NNN" where the ticket is currently in `0-backlog`.
- The user says "process the backlog" or "stage the top of the backlog" — work through the highest-priority backlog tickets one at a time and stage each. Ask before doing this proactively; it can be a lot of work and the user may want to triage first.

### Honesty rules

- If the body's framing is incoherent with the codebase (e.g. references a file that doesn't exist), stop and ask one clarifying question — do not fabricate Context.
- Preserve the user's intent. The original body is the authoritative statement of what they want; refine wording only if the original was unparseable, and never silently expand scope.
- If you cannot produce a non-trivial Context section (no relevant file:line citations exist because the ticket genuinely is meta / docs / discussion), say so explicitly in Context rather than padding it.

---

## Operation: record-files-touched

Populates the ticket's `files_touched:` frontmatter array with the repo-relative paths the agent edited while implementing this ticket. A post-impl snapshot of what the work actually touched, at file-path resolution. The ticket view renders the list at the bottom of the page in any bucket where it's non-empty.

### When to run

- Automatically: as part of `move-ticket` when the destination is `4-testing` (the initial build is done) **or** `6-complete` (any review fix-ups are done). The two captures are union'd so the final list covers the whole implementation.
- Manually: when the user says "record the files TKT-NNN edited" or after a long-running ticket where the file list needs a refresh.

### Procedure

1. Locate the ticket file by ID.
2. Recall what the implementation touched. Sources, in order of preference:
   - **Session edit history**: if you implemented the work in the current conversation, your Edit/Write tool calls are the authoritative list. Collect every distinct path.
   - **Git working-tree diff**: `git diff --name-only` and `git status --short` together cover staged, unstaged, and untracked files. Use this when the work happened in this session but spans multiple sub-commits, or when you genuinely don't remember every path.
   - **Branch diff**: `git diff --name-only $(git merge-base HEAD main)...HEAD` enumerates everything changed on the current branch since it forked from `main`. Use this as a coarse fallback when the work landed across multiple sessions.
   - If none of the above yields a reliable list, leave `files_touched` unchanged and tell the user — do not guess.
3. Normalize paths: repo-relative (strip the working-directory prefix), forward slashes, no leading `./`. Drop generated artifacts (`.next/`, `dist/`, `node_modules/`, `__pycache__/`, lockfiles unless the lockfile *change* was the point of the ticket).
4. **Union, don't replace.** Read the existing `files_touched` list, merge with the new paths, dedupe, sort lexicographically. File-touch capture happens at two transitions (testing + complete) and must accumulate across them.
5. Write the merged list back via the atomic-write pattern.

### Honesty rules

- If you can't determine what was touched, leave the field alone. An empty list is a true statement; a fabricated list is worse than no list.
- File paths in this list are an audit trail, not a directive — do not retroactively "tidy" them by dropping paths whose edits were eventually reverted. The historical fact is that the agent touched them.
- The list is files **changed by the agent**, not files **read by the agent**. Reads are not part of the touched set.

---

## Operation: record-implementation-summary

Appends a `### Implementation Summary` prose section to the ticket body when implementation is complete. This is the narrative complement to the structured `files_touched` field — it captures **what was actually built**, including deviations from the plan, discoveries made during implementation, and decisions not covered in the original spec.

### When to run

- Automatically: alongside `record-files-touched` when a ticket moves into `4-testing` (i.e. immediately after implementation).
- Manually: when the user says "write the implementation summary for TKT-NNN" or "summarise what was done on TKT-NNN".

### Procedure

1. Locate the ticket file by ID.
2. Recall what was implemented. Sources, in order of preference:
   - **Session memory**: if you built this ticket in the current conversation, use what you did as the source. You were there.
   - **`files_touched`**: if the session context has expired, use this structured field plus git diff to reconstruct a best-effort summary. Note in the section that it was reconstructed.
   - If neither is sufficient, write: `_implementation details unavailable — see \`files_touched\`_` and stop. Do not fabricate.
3. Write the section with this structure:
   ```markdown
   ### Implementation Summary

   - <What was built — one bullet per distinct change or file group. Name key files or functions.>
   - <Second bullet if needed. Each bullet is a complete thought.>

   **Deviations from plan:**
   - <Bullet for each deviation — file the AC didn't mention, approach that changed, scope that expanded or shrank. If none, write "None — implementation matched the plan.">

   **Implementation notes:**
   - <Optional: constraints discovered, decisions made, follow-on work flagged. Omit the sub-header entirely if there's nothing to say.>
   ```

   The main summary is **always bullets, never prose paragraphs** — the `.skua/` ticket view parses and renders each bullet as a distinct list item. A paragraph will not be displayed.
4. Find the existing `### Implementation Summary` placeholder in the body (placed there by the ticket template) and **replace** it (including its HTML comment) with the populated section. If the placeholder is absent (older ticket), append the section to the end of the body.
5. Write the updated body back to the ticket file. Preserve all frontmatter — only the body changes.

### Idempotent behaviour

If `### Implementation Summary` is already populated (non-placeholder content), do not overwrite it unless the user explicitly asks for a re-record. Protecting a human-edited summary from accidental clobber is more important than freshness.

### Honesty rules

- Do not copy the Acceptance Criteria into the summary and call it done. The summary should describe what *actually happened*, not what was planned.
- If implementation matched the plan perfectly, say so explicitly ("implementation matched the plan") rather than leaving the deviations section empty with no explanation.
- Never fabricate file names, function names, or outcomes. If you aren't sure, say so.

---

## Operation: refine-staging-pass-2

Second of the two staging refinement passes. Where `refine-from-backlog` (pass-1) scaffolds the ticket body cold from the backlog stub, pass-2 reads the staged ticket cold and tightens it. The goal is to catch drift between when pass-1 was written and when the user actually approves the build — Context cites may have gone stale, AC bullets may be vague, blockers may have moved.

### When to run

- **Automatically** as the immediate next step after `refine-from-backlog` in agentic mode.
- **Manually** when the user says "tighten TKT-NNN", "second pass on TKT-NNN", or invokes a second `pick up TKT-NNN` on a ticket already in `1-staging/`.

### Procedure

1. Locate the ticket file in `.tickets/1-staging/`. If absent, stop with a clear error.
2. **Re-read cold.** Do NOT carry pass-1 context — start by reading the file fresh as if you've never seen the ticket.
3. **Tighten Acceptance Criteria.** Every bullet must be independently verifiable — a command to run, a `file:line` check, or a behavioral assertion. Bullets that read like aspirations ("system should be robust") or that pile multiple sub-asks into one line get split or rewritten.
4. **Verify `depends_on` blockers** are actually in a non-blocking bucket (i.e. not still in `0-backlog/`, `1-staging/`, `2-stuck/`, `3-building/`, `4-testing/`, `5-validating/`). If a blocker is still active, append a `### Pass-2 review` block flagging it; the user must resolve before build.
5. **Validate Context citations.** Every `file:line` in Context should still exist — grep / read each one. Drift here is the most common pass-1 → pass-2 finding.
5a. **Re-rate `complexity`** per the rubric. Update the frontmatter int if pass-1 was off.
6. Append a `### Pass-2 review` block to the ticket body (place it AFTER Acceptance Criteria, BEFORE Out of Scope if present). Structure:
   ```markdown
   ### Pass-2 review

   **Run:** YYYY-MM-DD
   **Reader:** cold (no pass-1 context carried)

   - **AC tightening:** <N bullets rewritten for verifiability / none>
   - **Blockers:** <ok / TKT-X still in <bucket>>
   - **Context drift:** <ok / N file:line citations updated>

   **Verdict:** <build-ready | needs-attention — see flagged items above>
   ```
7. **Do not move the ticket.** It stays in `1-staging/`. Only `build-ticket` (with user approval in user-driven mode, or the next loop step in agentic mode) graduates it.

### Honesty rules

- If pass-1 was already correct (rare but possible for a tight backlog stub), the review block should say so explicitly — write `- **All dimensions:** ok — no changes` rather than padding with fake findings.
- If pass-2 discovers the ticket should NOT be built (premise wrong, scope way too big, conflicts with active work the user didn't know about), the verdict is `needs-attention` and the next step is the user pulling the ticket back to `0-backlog/` or to `2-stuck/`. Do not pretend the ticket is build-ready when it isn't.
- The `Reader: cold` claim is a promise. If you find yourself carrying pass-1 reasoning into pass-2 (e.g. defending a wording choice from pass-1), stop and re-read the file fresh.

---

## Operation: test-ticket

Post-build verification by a **fresh `Agent` subagent**. The subagent reads the ticket cold, reads the diff cold, and grades the Acceptance Criteria bullet-by-bullet. Evidence-required: each verdict bullet must cite a command-output excerpt or a `file:line` — bare pass/fail is auto-rejected.

### When to run

- **Automatically** after `build-ticket` moves a ticket into `4-testing/`. This is the post-build step.
- **Manually** when the user says "test TKT-NNN", "verify TKT-NNN" against a ticket in `4-testing/`.

### Procedure

1. Locate the ticket in `4-testing/`. If absent, stop with a clear error.
2. Check for `.tickets/STOP`. If present, exit cleanly.
3. Capture the post-build diff metadata:
   - `git diff --name-only $(git merge-base HEAD main)...HEAD`
   - The `files_touched` list from the ticket frontmatter
4. **Spawn a fresh `Agent` subagent** with:
   - `subagent_type`: `general-purpose` by default. The stack plan may override per ticket.
   - `description`: `"Verify TKT-NNN acceptance criteria"`
   - `disallowedTools` (MANDATORY — see Hard Safety Guards below):
     - `Bash(rm:*)`, `Bash(git push:*)`, `Bash(git rm:*)`, `Bash(git reset --hard:*)`, `Bash(git commit:*)`, `Bash(bun update:*)`, `Bash(npm install:*)`, `Bash(npm publish:*)`, plus any destructive cloud/DB commands
     - Any MCP write surfaces (writes to Drive, Slack, etc.)
   - `prompt`: includes (a) the ticket's full markdown, (b) the diff metadata from step 3, (c) the contents of touched files (subagent re-reads them itself), (d) the explicit instruction to *verify the Acceptance Criteria as a cold reader* — never trust the parent agent's own summary, (e) the evidence-required verdict schema (next bullet), (f) the deny-list (repeated in prompt for prompt-level defense in depth).
5. The subagent's required output schema (strictly enforced — see next bullet):
   ```json
   {
     "pass": true|false,
     "ac_results": [
       {
         "ac_id": "<bullet text or its first 60 chars>",
         "pass": true|false,
         "evidence": "<command output excerpt OR file:line cite — MANDATORY, non-empty>"
       }
     ],
     "verification_commands_run": ["<every command the subagent ran>"],
     "notes": "<free-form, optional>"
   }
   ```
6. **Evidence validation (mandatory, by the parent agent).** Reject the verdict and respawn once if any `ac_results[].evidence` is:
   - Missing or empty
   - Vague ("looks good", "verified", "seems correct", "appears to work")
   - Not actually citing a command output excerpt OR a `file:line` reference
   Second respawn failure → treat as `pass: false` with reason `evidence_fabrication_risk`, route to stuck.
7. Append the verdict to the ticket body under `### Test Results`:
   ```markdown
   ### Test Results

   **Verifier:** fresh subagent (`general-purpose`)
   **Run:** YYYY-MM-DD
   **Overall:** PASS | FAIL

   | AC | Pass | Evidence |
   |---|---|---|
   | <ac_id> | ✓/✗ | <evidence> |
   ...

   **Commands run:**
   - `<cmd>`
   ...

   **Notes:** <subagent notes, verbatim>
   ```
8. **Smoke check — web targets only (deterministic; catches runtime/console errors unit tests miss).** If a `smoke` block exists in `skua.config.json`, run the headless-browser smoke and fold it into the evidence:
   - From the repo/worktree root, run `bun .skua/scripts/smoke.ts --ticket TKT-NNN`. It boots the app on a free port, drives headless Chromium over the configured routes, and prints a JSON `SmokeResult` to stdout (screenshots + `result.json` land in `.skua/cache/smoke/TKT-NNN/`). Treat that JSON as ground truth — never summarize past it or override it.
   - Append a `### Smoke Check` subsection under `### Test Results`, with console errors **verbatim**:
     ```markdown
     ### Smoke Check

     **Headless Chromium:** PASS | FAIL | SKIPPED (<reason>)

     | Route | Result | Console | Page errors | Failed req | Notes |
     |---|---|---|---|---|---|
     | <route> | ✓/✗ | <n> | <n> | <n> | <note> |

     **Captured console errors (verbatim):**
     - `<message>`

     **Screenshots:** `.skua/cache/smoke/TKT-NNN/<route>.png`
     ```
   - Outcome: **`skipped`** (no `smoke` block, browsers not provisioned, or driver absent) → record AS skipped and proceed — a skip is NOT a pass and never fails the ticket. **`pass`** → proceed. **`fail` / `error`** → a test failure (step 10).
9. **On pass:** the AC verdict AND the smoke check (pass or skipped) are both clean. `move-ticket` to `5-validating`. Then auto-fire `validate-ticket` (next op) in agentic mode; in user-driven mode, stop and report.
10. **On fail (AC evidence rejection, OR a smoke `fail`/`error`):** `move-ticket` to `2-stuck/` with frontmatter `test_failed: true` and the verdict appended. Append a `### Stuck Reason` block per the `mark-stuck` op format, citing which AC bullet(s) failed and/or which smoke route(s) failed, with the captured console errors. The user (or, in chaos, the next worker) triages and re-invokes the flow after fixing the cause.

### Honesty rules

- The parent agent never grades its own implementation. If the parent did the build, the parent must NOT also produce the verdict — that's the whole point of spawning a fresh subagent (LangGraph judge-node pattern).
- "PASS" without populated `ac_results` evidence is treated as missing — the verdict must show its work.
- If the subagent claims it can't verify an AC bullet (e.g. requires a credential, an external service), it must say so explicitly in `notes` AND mark that bullet `pass: false` with `evidence: "unverifiable: <reason>"`. Do not silently skip.

---

## Operation: validate-ticket

Full ticket-level review by a **second, distinct fresh `Agent` subagent**. Distinct from `test-ticket` in two ways: (a) the prompt class is different (whole-ticket fitness, not AC verification), (b) the four judgment axes are orthogonal to AC bullets. Collapsing this into `test-ticket` is the failure mode LangGraph's judge-node pattern was designed against.

### When to run

- **Automatically** in agentic mode, after `test-ticket` passes and the ticket lands in `5-validating/`.
- **Manually** when the user says "validate TKT-NNN", "full review of TKT-NNN", "is TKT-NNN really done?".

### Procedure

1. Locate the ticket in `5-validating/`. If absent, stop with a clear error.
2. Check for `.tickets/STOP`. If present, exit cleanly.
3. Capture the full diff (not just file names): `git diff $(git merge-base HEAD main)...HEAD`. Capture the `### Implementation Summary` block.
4. **Spawn a fresh `Agent` subagent** with:
   - `subagent_type`: `general-purpose`.
   - `description`: `"Validate TKT-NNN end-to-end fitness"`
   - `disallowedTools`: same deny-list as `test-ticket`.
   - `prompt`: includes (a) the ticket's FULL markdown (Objective + Context + AC + Test Results + Implementation Summary), (b) the full diff from step 3, (c) explicit instruction to grade as a cold senior reviewer on four orthogonal axes (NOT AC bullets — those were already handled in test), (d) evidence requirement.
5. The four axes (the subagent grades each independently):
   - **Objective fidelity** — did the implementation actually address the stated Objective, or did it drift to something adjacent?
   - **Context-constraint respect** — were the Context warnings, anchors, and conventions honored? Check against project-wide rules: the repo's `CLAUDE.md` (or equivalent contributor guide) and any contract/spec cited in the ticket's Context.
   - **Sprawl check** — does the diff touch files outside the `files_touched` list? Each extra file must be justified or flagged as scope creep.
   - **Follow-up surfacing** — are there obvious in-scope issues that didn't get fixed and should become backlog tickets? List them with a one-sentence rationale each.
6. The subagent's required output schema:
   ```json
   {
     "pass": true|false,
     "axes": {
       "objective_fidelity":     {"pass": true|false, "evidence": "..."},
       "context_constraints":    {"pass": true|false, "evidence": "..."},
       "sprawl":                 {"pass": true|false, "evidence": "..."},
       "follow_up_surfacing":    {"pass": true|false, "evidence": "..."}
     },
     "suggested_new_tickets": [
       {"title": "...", "rationale": "...", "ordering": "defer|splice-front|splice-back"}
     ],
     "notes": "..."
   }
   ```
7. **Evidence validation.** Same rules as `test-ticket` — each axis must cite the diff or ticket text. Vague evidence → respawn once, then fail.
8. Append to ticket body under `### Validation Review`:
   ```markdown
   ### Validation Review

   **Reviewer:** fresh subagent (`general-purpose`, distinct from test subagent)
   **Run:** YYYY-MM-DD
   **Overall:** PASS | FAIL

   | Axis | Pass | Evidence |
   |---|---|---|
   | Objective fidelity | ✓/✗ | <evidence> |
   | Context constraints | ✓/✗ | <evidence> |
   | Sprawl | ✓/✗ | <evidence> |
   | Follow-up surfacing | ✓/✗ | <evidence> |

   **Suggested new tickets:** <count, or "none">
   ```
9. **Route `suggested_new_tickets`** through `spawn-ticket-mid-flow` — the parent agent decides ordering and files each via `create-ticket`. Do NOT auto-create without the ordering decision; that's the whole point of spawning being a judgment call.
10. **On pass:** ticket stays in `5-validating/`. In agentic mode, immediately trigger `agentic-commit` (next op) — the commit + push prompt is the only per-ticket user touch-point in the agentic loop. In user-driven mode, stop and report.
11. **On fail:** `move-ticket` to `2-stuck/` with frontmatter `validation_failed: true` and the verdict + `### Stuck Reason` block appended.

### Honesty rules

- A subagent that passes all four axes but flagged 10 follow-ups should NOT be marked overall fail — follow-ups are observations, not blockers. Overall pass/fail = `pass: true` IFF all four axes pass.
- The reviewer must be a different subagent invocation than the tester. Do not reuse the test subagent's context.
- Sprawl that's explicitly justified in the Implementation Summary's "Deviations from plan" is not sprawl — credit it.

---

## Operation: adversarial-pass

A fresh subagent whose success condition is **breaking the change**, not confirming it.
Runs CONCURRENTLY with `test-ticket` (same message, two `Agent` calls) for complexity ≥3;
folded into the single verify subagent for complexity ≤2 per the depth ladder.

### Why this is separate from test-ticket

`test-ticket` asks "does each AC hold?" — a confirmatory prompt class, and confirmatory
prompts find confirmatory answers. Two failure modes it structurally cannot catch:

- **The vacuous assertion.** A fix ships, the suite is green, and the one-line revert of
  that fix ALSO passes every test — because the new test asserted that a symbol exists,
  not that anything uses it.
- **The spelling-matched guard.** A guard written to catch a bug matches one *syntactic
  form* the bug happened to take. A regression with the same defect in a different shape
  sails through every test the guard added.

A green AC table is consistent with "the fix works" and with "the assertion is vacuous."
Only an agent paid to find the second distinguishes them.

### Procedure

1. Spawn a fresh `Agent` (`general-purpose`, same deny-list as `test-ticket`).
2. Prompt inlines the ticket, the **diff hunks**, and this charge — *"Your job is to find
   what is wrong with this change. Returning 'no findings' is a valid and sometimes correct
   answer, but only after you have genuinely tried the four attacks below."*
3. The four attacks (each must be attempted and reported, even if it fails to break):
   - **Revert test** — undo the fix; does any test go red? If none do, the tests assert nothing.
   - **Evasion** — construct an input/shape the new guard misses but that has the same defect
     (assert the property, not one syntactic form of it).
   - **Blast radius** — what else reads this code path and now behaves differently?
   - **Premise check** — is the ticket's stated cause actually the cause, or did the fix
     treat a symptom?
4. Output schema:
   ```json
   {
     "findings": [
       {"severity": "blocker|major|minor", "claim": "...",
        "evidence": "<command output or file:line — MANDATORY>",
        "repro": "<exact steps or command>", "suggested_fix": "..."}
     ],
     "attacks_attempted": {"revert": "...", "evasion": "...", "blast_radius": "...", "premise": "..."},
     "notes": "..."
   }
   ```
5. Findings go to `rectify-findings`. Zero findings with all four attacks genuinely
   attempted is a pass — record `attacks_attempted` in the ticket so the reader can see
   what was tried.

### Honesty rules

- An adversarial agent that returns "no findings" without a populated `attacks_attempted`
  is rejected and respawned once. Empty effort is not a clean bill of health.
- The parent must NOT soften or pre-filter findings before rectification. Record the
  finding as written, then dispute it in the rectification note if it's wrong.
- A finding the parent disagrees with is still recorded, with the disagreement and its
  evidence. Do not silently drop it.
- When a test contradicts a file you just read, suspect a stale build/bytecode cache before
  suspecting the code.

---

## Operation: rectify-findings

Closes the loop that previously dead-ended at `2-stuck/`. In agentic mode a defect the
agent can fix is not a reason to stop — stuck is for questions only the user can answer.

### When to run

Automatically, whenever `test-ticket` returns `pass: false` or `adversarial-pass` returns
any `blocker`/`major` finding. Skipped for `minor` findings, which become follow-up tickets
via `spawn-ticket-mid-flow` instead.

### Procedure

1. **Triage each finding** — `accept` (real, fix it) or `dispute` (wrong, say why with
   evidence). Disputing is legitimate; disputing without evidence is not.
2. **The parent fixes accepted findings in place.** Do not spawn a subagent to fix — the
   parent holds the build context, and a fresh agent would re-derive it.
3. **Re-run only the narrow check that failed.** Not the whole suite, not a fresh full
   verification pass. If the finding was "revert test passes", the re-check is: revert,
   confirm RED, restore, confirm GREEN — and that transcript is the evidence.
4. **Append `### Rectification` to the ticket body:**
   ```markdown
   ### Rectification (round N)

   | Finding | Verdict | Action | Re-check evidence |
   |---|---|---|---|
   | <claim> | accepted/disputed | <what changed, file:line> | <command output> |
   ```
5. **Round limit: 2.** If findings remain after two rounds, `move-ticket` to `2-stuck/`
   with the surviving findings in the `### Stuck Reason` block. A third round means the
   ticket's premise is wrong, not that the fix needs another nudge.
6. On clean re-check, continue the lifecycle (→ `validate-ticket` or `agentic-commit`).

### Honesty rules

- Every accepted finding needs a **re-check that could have failed**. "Fixed it" with no
  command output is not rectification.
- Never mark a finding rectified by narrowing the test until it passes. If the assertion
  had to be weakened, that IS the finding — escalate to stuck.
- Report rectification rounds in the final summary. A ticket that needed 2 rounds is a
  different quality signal than one that needed 0, and the user should see which.

---

## Operation: spawn-ticket-mid-flow

**First-class judgment**, not a side effect. When the agent discovers in-scope work during build / test / validate that doesn't belong in the current ticket, it MUST proactively file a new backlog ticket via `create-ticket` AND decide ordering. This is a core part of the agentic loop, not optional cleanup.

### When to run

Three trigger sources:
1. **Build-time discovery** — during `build-ticket`, the implementer hits a bug, dead code, missing test surface, or refactor opportunity that's out of scope for the current ticket.
2. **Test-time discovery** — the `test-ticket` subagent identifies an AC bullet that's only partially addressable in the current scope (e.g. needs a separate refactor first).
3. **Validation-time discovery** — `validate-ticket` returns `suggested_new_tickets`.

### Procedure

1. **Scope-shedding check (mandatory first step).** Ask: *does this discovered work fit the current ticket's Objective?* If yes, DO IT INLINE — do not spawn. Spawning to defer in-scope work is the known failure mode this op exists to police.
2. If genuinely separate scope, run `create-ticket` with full context-gathering (3–6 tool calls grounded in the actual file:line). The new ticket's frontmatter MUST set `related: [<parent-TKT-ID>]` automatically.
3. Add a `### Why this was spawned mid-stack` body block to the new ticket:
   ```markdown
   ### Why this was spawned mid-stack

   **Parent ticket:** TKT-NNN
   **Trigger source:** build-time | test-time | validation-time
   **What was discovered:** <one-sentence summary, with file:line cite>
   **Ordering decision:** defer-to-backlog | splice-front | splice-back
   **Rationale:** <one sentence — why this ordering>
   ```
4. **Ordering decision (explicit, three options):**
   - **(a) `defer-to-backlog`** — file in `0-backlog/`, no stack-membership change. **Default for unrelated discoveries.** Examples: a refactor opportunity in an unrelated module, a missing test for old code.
   - **(b) `splice-front`** — file in `0-backlog/` AND immediately prepend to the active stack's `members[]` array (`.skua/cache/stacks/<id>.json`). Use when the discovery is a hard blocker for remaining stack members. Subject to the stack's 5-ticket cap — if cap is exceeded, downgrade to `defer-to-backlog` and append a note to the stack record's `notes`.
   - **(c) `splice-back`** — file in `0-backlog/` AND append to the active stack's `members[]`. Use when the discovery is a natural follow-up that fits the same context but isn't a blocker. Same cap rules.
5. If splicing, write back the updated `.skua/cache/stacks/<id>.json` and report the change in the user-facing channel so they can see the stack grew.
6. **Continue the current ticket's work** (build / test / validate) — spawning a child does not pause the parent.

### Honesty rules

- **No silent scope expansion.** If you find yourself thinking *"this is small, I'll just do it here"* about work outside the current Objective, stop — file a ticket and decide ordering. Scope creep is how stacks blow their token budgets.
- **No silent scope-shedding.** The inverse: if the work fits the current Objective and you're spawning to "keep this ticket clean", stop — do the work inline.
- **No retroactive spawning.** Spawning happens AS you discover, not afterward. A spawned ticket dated three days after the parent's commit means you should have committed it inline.

---

## Operation: plan-stack

Groups backlog tickets into coherent **sub-stacks** sized to fit a single context window. Reads frontmatter (no body parsing for the scoring pass), scores affinity, partitions into 2–5 sub-stacks of **at most 5 tickets each**. Writes a stack-membership record at `.skua/cache/stacks/<id>.json`. No file moves.

### When to run

- After `flow-gate` returns `agentic` and the user says "plan a stack", "what should I work on next", "group the backlog".
- Periodically as part of triage when the backlog grows past ~15 tickets.

### Procedure

1. **Load backlog summaries** via `.skua/lib/tickets.ts:listBucket("0-backlog")` (frontmatter only, body not needed). The `TicketSummary` shape gives you `domain`, `depends_on`, `blocks`, `related`, `priority`, `tags`, `files_touched`.
2. **Score pairwise affinity** between every pair of tickets `(A, B)`:
   - +3 if `A.domain == B.domain` (or both in `secondary_domains` of each other)
   - +2 per `files_touched` path (or parent dir) in `intersect(A, B)` (Jaccard-like)
   - +5 if `A ∈ B.depends_on` or vice versa (hard edge)
   - +2 if `A ∈ B.related` or vice versa
   - +1 if `intersect(A.tags, B.tags)` non-empty
   - +1 if same `priority` band
   - Capped at +15 per pair.
3. **Greedy partition.** Sort tickets by total affinity (sum across all pairs) descending. Walk the sorted list:
   - For each ticket, find the open sub-stack with the highest summed affinity to the ticket. Add it there if the sub-stack has fewer than 5 members AND the token-budget heuristic permits (next step).
   - Otherwise start a new sub-stack.
   - Stop creating new sub-stacks after 5 are open (per-fire cap).
4. **Single-context-window sizing heuristic.** Per sub-stack, estimate working surface = `sum(LOC(files_touched) + 50 * len(AC_bullets))`. If this exceeds the configurable `token_budget` (default 20000 from `.skua/cache/stacks/config.json`), split. Reading actual file LOC is OK here — it's bounded by the tickets' touched files.
5. **Materialize stack records.** For each sub-stack, write `.skua/cache/stacks/<stack-id>.json`:
   ```json
   {
     "id": "stack-<YYYYMMDD>-<short-hash>",
     "created": "<ISO-8601>",
     "members": ["TKT-NNN", ...],
     "status": "planned",
     "agentic_mode": true,
     "token_budget": 20000,
     "estimated_size": <LOC sum>,
     "notes": "..."
   }
   ```
   The `<stack-id>` format: `stack-YYYYMMDD-<6 lowercase hex>` (e.g. `stack-20260523-a3f9c1`). The directory `.skua/cache/stacks/` is auto-created if missing.
6. **Echo plan to user** as a human-readable summary, one block per sub-stack:
   ```
   Stack <id> (N tickets, ~M LOC est):
     1. TKT-NNN — <title>
     2. TKT-NNN — <title>
     ...
   Rationale: <one sentence — what holds these together>
   ```
7. **No file moves.** `plan-stack` is pure-read on the ticket board.
8. **Auto-prune.** After writing, list `.skua/cache/stacks/*.json` (excluding `config.json` and any `solo-*.json`). If count > 30, delete the oldest by mtime.

### Honesty rules

- A sub-stack of 1 ticket is fine if the ticket is high-affinity to nothing else. Don't pad sub-stacks just to hit a target size.
- If the backlog has fewer than 3 tickets, just say "backlog too small to stack — run `build TKT-NNN` directly". Don't force a stack of one.
- `agentic_mode: true` means the stack runs end-to-end. There is no separate `auto_build` toggle; once the user picked agentic at the entry gate, the loop drives each member through refine → pass-2 → build → test → validate without further mid-flow confirmations. The only stops are `2-stuck/` (genuine blocker), destructive-op confirms, the agentic-commit prompt, and `.tickets/STOP`.

---

## Operation: run-stack

Walks a planned stack's `members[]` end-to-end: refine → pass-2 → build → test → validate → agentic-commit. Drives each ticket without mid-flow confirmation prompts. The only stops are the kill switch, the token budget cap, a `2-stuck/` route, a destructive-op confirm, or the agentic-commit prompt at validating. **Foreground only in v1** — no `CronCreate` scheduling.

### When to run

- After `plan-stack` has written a stack record and the user says "run stack <id>" or "go" / "ship it" against that stack.

### Procedure

1. Load `.skua/cache/stacks/<id>.json`. If `agentic_mode != true`, refuse — `run-stack` only operates in agentic mode (set by `flow-gate`).
   - **Explicit-list entry.** If the user names the tickets directly ("run 417, 418, 421 agentic"), do NOT round-trip through `plan-stack`. Synthesize a stack record `adhoc-<first-id>.json` with `agentic_mode: true` and those `members[]`, and proceed. `plan-stack` exists to CHOOSE members from a backlog; when the user has already chosen, running it is pure latency.
2. Update the stack record `status: "running"`, `started_at: <ISO>`. Echo a one-block plan summary (members, the **concurrency partition** from step 3, predicted touched files, token-budget cap) but do NOT ask for confirmation — the user already picked agentic at `flow-gate`. Adding a second gate here is the failure mode this op was redesigned against.
3. **Partition `members[]` into waves** per the Agentic speed contract §2: members with disjoint predicted `files_touched` and no `depends_on` edge between them go in the SAME wave and run in parallel; interacting members stay serial within their chain. Process wave by wave.
4. **For each member (parallel within a wave):**
   1. **Kill-switch check.** If `.tickets/STOP` exists, mark stack `status: "halted"`, exit cleanly.
   2. **Token-budget check.** If cumulative tokens used >= `token_budget`, mark stack `status: "token_exhausted"`, halt.
   3. **Determine current bucket** of the ticket. Drive it through the lifecycle without re-asking, at the depth its `complexity` warrants (speed contract §1):
      - In `0-backlog/`: run `refine-from-backlog`. Lands in `1-staging/`.
      - In `1-staging/` without pass-2: run `refine-staging-pass-2`.
      - In `1-staging/` with pass-2: run `build-ticket`. Lands in `4-testing/`.
      - In `4-testing/`: run `test-ticket` **and** `adversarial-pass` — concurrently, in one
        message, for complexity ≥3; as a single combined subagent for complexity ≤2.
      - Findings from either → `rectify-findings` (max 2 rounds), then continue. Only
        route to `2-stuck/` after rectification fails, or for a question the agent
        genuinely cannot answer.
      - In `5-validating/`: run `validate-ticket`, then `agentic-commit` (commit + push prompt is the only per-ticket user touch-point).
      - In `2-stuck/`: mark this member as `skipped: stuck`, continue to next. The agent itself decides whether a ticket should route to stuck — that's the agent's escape hatch when it genuinely can't proceed.
      - In `6-complete/` or `7-archive/`: mark as `skipped: already_done`, continue.
5. After all waves processed (or halted), update stack `status: "complete" | "halted" | "token_exhausted"`, `completed_at: <ISO>`, write any `git_log[]` entries from `agentic-commit`.
6. Echo final summary to user — including per-ticket **rectification rounds** and any budget
   overruns, so an under-rated ticket is visible rather than averaged away.

### Honesty rules

- **Foreground only.** Do not background `run-stack` or schedule it via `CronCreate` / `/loop`. The user can still see progress + the banner + the `.tickets/STOP` kill switch.
- **Single stack at a time.** If another stack record has `status: "running"`, refuse with an error.
- **No mid-flow gates.** Once started, the only stops are: `.tickets/STOP`, token-budget breach, `2-stuck/` route (agent-initiated), destructive-op confirm, agentic-commit prompt. Do NOT invent additional checkpoints "for safety" — that undermines agentic mode.

---

## Operation: stack-status

Pure-read op. Reads the active stack record + bucket scan, reports per-ticket state.

### When to run

- User says "stack status", "where are we", "what's the active stack doing".

### Procedure

1. List `.skua/cache/stacks/*.json` (excluding `config.json`). Filter to `status: "running" | "planned"`. If multiple match, prefer the most-recently-`started_at` one.
2. For each `member`, locate the ticket file across all buckets and report:
   ```
   Stack <id> — <status>, started <ts>
   Members:
     ✓ TKT-NNN — <bucket> (status from filename)
     → TKT-NNN — <bucket> (currently being processed)
     · TKT-NNN — queued
     ✗ TKT-NNN — stuck
   Tokens used: <N> / <budget>
   ```
3. Pure read — no writes, no moves.

---

## Operation: agentic-commit

**Supersedes CLAUDE.md's git prohibition — only when** the active stack record has `agentic_mode: true`. Creates one atomic commit per ticket at the validating boundary, after `validate-ticket` passes. This op IS the per-ticket user touch-point in the agentic loop — the commit + push prompt is the only confirmation between agentic-mode entry and the end of the stack.

### When to run

- **Automatically** in agentic mode, immediately after `validate-ticket` returns `pass: true`. No intermediate gate.
- **Never** outside agentic mode. In user-driven mode, the CLAUDE.md rule applies — the user commits.

### Procedure

1. **Scope check.** Load the active stack record. If `agentic_mode != true`, refuse with `"agentic-commit requires agentic_mode: true on the active stack"`.
2. **Working-tree sanity check (NOT a sprawl gate).** Run `git status --short` for context only. The realistic dogfood scenario has multiple tickets in flight at once — TKT-A's commit happens while TKT-B is mid-build and TKT-C is in stuck. **DO NOT refuse on cross-ticket churn.** The per-file `git add <files_touched>` step (next-next) IS the safety boundary; the working-tree precondition would add friction without preventing anything. The only refusal at this step is for the ticket's own `files_touched` list being empty (nothing to commit) — in that case, halt and ask the user.
3. **Draft commit message** from the ticket:
   - Subject: `<ticket-id>: <title>` (truncated to ≤72 chars)
   - Body: the `### Implementation Summary` block's first 3 bullets, plus a `Files: <count>` line.
   - Trailer:
     ```
     🤖 Generated with autonomous ticket flow
     Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
     ```
4. **Surface the commit prompt** to the user, verbatim:
   ```
   TKT-NNN validated. Proposed commit:

   ─────────────────────────
   <message>
   ─────────────────────────

   Files (<count>):
     <files_touched, one per line>

   Commit + push to <current upstream branch>? [y/N/edit]
   ```
   Default-deny on no response.
5. **On `y` (single confirmation covers commit AND push):**
   - `git add <each file in files_touched + ticket file>`. Never `git add -A` or `git add .` (per repo CLAUDE.md security guidance).
   - `git commit -m "<message via HEREDOC>"`. Hooks run normally; do not pass `--no-verify`.
   - Verify commit landed: `git log -1 --format=%H`.
   - Immediately `git push` (no flags — push to current tracking branch only). NEVER `git push --force`, NEVER `git push origin main` from a non-main branch.
   - If the push fails (hook reject, non-fast-forward, no upstream), report the failure verbatim and stop — do NOT retry, do NOT force. The commit remains locally; the user resolves and re-pushes.
6. **On `edit`:** echo a temp file path (`.skua/cache/stacks/<id>-commit-msg-TKT-NNN.txt`) the user can edit; re-surface step 4 after the user re-invokes with the edited message. The re-surfaced `y` still covers commit AND push.
7. **On `N`:** do not commit. Append a note to the stack record `notes` field that the user opted out of agentic commit for this ticket. Move to next ticket.
8. **Audit log.** On successful commit + push, append to the stack record's `git_log[]`:
   ```json
   {"ticket_id": "TKT-NNN", "sha": "<7-char>", "pushed_at": "<ISO>", "user_confirmed_at": "<ISO>"}
   ```

### Deny-list (always)

Refused even in agentic mode:
- `git push --force` / `git push -f`
- `git push origin main` from a non-main branch
- `git push` when working tree has uncommitted changes from outside the ticket scope
- `git commit --amend` (always create new commits per repo CLAUDE.md)
- `git rebase -i` (interactive, per repo CLAUDE.md)
- Any push that bypasses hooks (`--no-verify`, `--no-gpg-sign`)

### Honesty rules

- One commit per ticket. Never batch multiple tickets into one commit — granular rollback matters.
- The user is the gate, once. A single `y` authorises commit AND push for this ticket. Silence is decline.
- If a hook fails, fix the underlying issue and create a NEW commit. Never `--amend` to "fix" a failed hook.

---

## Hard safety guards (apply to every agentic-mode op)

This section is normative — every op above that reads `agentic_mode: true` MUST enforce these guards. Listed once here, referenced by each op.

### Kill switch

- File `.tickets/STOP` (any contents — its existence is the signal).
- Every `run-stack` iteration, `test-ticket`, `validate-ticket`, `spawn-ticket-mid-flow`, and `agentic-commit` checks for it at the top and exits cleanly with `status: "halted"` if present.
- Halting via `.tickets/STOP` does NOT clean up the file — the user removes it explicitly when ready to resume. This prevents accidental auto-resume.

### Token budget (hard cap, three tiers)

Default values, all overridable in `.skua/cache/stacks/config.json`:

| Cap | Default | What happens on breach |
|---|---|---|
| Per-subagent | 100,000 tokens | Subagent killed; verdict treated as `fail`; ticket → `2-stuck/` |
| Per-ticket   | 300,000 tokens | Halt before next op; surface to user; ticket stays where it is |
| Per-stack    | 1,000,000 tokens | Stack auto-halts with `status: "token_exhausted"`; writes `.tickets/STOP` |

The agent is responsible for tracking cumulative token usage. When a cap is breached, the user-facing message must say exactly which cap fired and at what cumulative count.

### Deny-list — tool-level, not just prompt-level

Every `Agent` subagent spawned from `run-stack`, `test-ticket`, `validate-ticket` MUST be invoked with `disallowedTools` configured to block:

```
Bash(rm:*)
Bash(rm -rf:*)
Bash(git push:*)            — except in agentic-commit's controlled context
Bash(git rm:*)
Bash(git reset --hard:*)
Bash(git commit:*)          — except in agentic-commit's controlled context
Bash(git rebase:*)
Bash(bun update:*)          — supply-chain risk; lockfile is pinned
Bash(npm install:*)
Bash(npm publish:*)
Bash(curl:*)                — to non-localhost addresses
```

Plus any destructive cloud / DB commands the repo uses (table drops, infra deletes, etc.) and any MCP write surfaces (Drive write, Slack send, etc.) — block via `disallowedTools` patterns.

The prompt-level deny-list (writes restricted to `.tickets/`, `.claude/`, `.skua/`, and the repo's own source directories) is **in addition**, not in place of, the tool-level block. Defense in depth.

### Destructive-op confirmation (even within allowed dirs)

Even inside the allowed write dirs, any operation that:
- (a) deletes a file
- (b) drops / `TRUNCATE`s / `DROP`s a database table or partition
- (c) `git rm`s a tracked file
- (d) overwrites a file with >50% reduction in line count

…requires an explicit user confirmation gate. The subagent surfaces intent + diff to the parent, which surfaces to the user, which responds `y/N`. **Default-deny on no response.** This rule supersedes any "be efficient" framing in the prompt.

### Evidence-required verdicts (cross-cuts test-ticket + validate-ticket)

No bare pass verdicts. Every AC bullet (test) and every axis (validate) must carry an evidence cite — command output excerpt or `file:line`. Missing or vague evidence → auto-fail with reason `evidence_fabrication_risk`.

### Per-fire and per-day caps

- **5 tickets max** per `run-stack` invocation (matches `plan-stack`'s sub-stack cap).
- **1 stack-run per day** in v2 (cron-driven) — N/A for v1 (manual).
- Overridable in `.skua/cache/stacks/config.json`.

### Agent-initiated stuck routing (the only mid-flow escape hatch)

Agentic mode has NO mid-flow user-confirmation gates. The only way for the
loop to pause for human attention between the entry gate and the final commit
prompt is for the agent itself to decide a ticket can't proceed and route it
to `2-stuck/` via `mark-stuck`. Legitimate triggers: missing information the
agent can't infer, a design choice the agent can't make autonomously, an
external dependency unavailable, a contradiction in the ticket's framing
discovered mid-build. After routing, the agent surfaces the `### Stuck
Reason` block via the dashboard's stuck column; the user triages and
re-invokes the flow with `unstick-ticket`. Inventing other gates "for safety"
is forbidden — it undermines agentic mode (see project memory:
`feedback_agentic_flow_no_user_gates.md`).

### Stack-record auto-prune

`.skua/cache/stacks/` is auto-pruned at 30 records (mirroring `security-runs/`). The newest 30 are kept; oldest by mtime are deleted.

---

## End-of-invocation summary

At the end of every invocation, echo a one-paragraph summary to the user:
what changed (created / moved / refined / built). Nothing more — no
archive step, no implicit ops.

---

## What this skill does NOT do

- **Never** runs `git add`, `git commit`, `git rm`, or `git mv` (per repo CLAUDE.md) — **with one scoped exception**: the `agentic-commit` op may stage + commit + push when the active stack record has `agentic_mode: true`, and only with a per-ticket user confirmation. Outside that exception, all git operations remain the user's responsibility.
- **Never** deletes ticket files outright. Archive is the terminal state. If the user explicitly asks to delete a ticket, stop and confirm — and even then, prefer moving to `7-archive/` with a `deleted: true` frontmatter flag rather than `rm`.
- **Never** edits ticket bodies as an undocumented side effect. Only the explicit body-writing ops touch the body — `create-ticket`, `promote-from-scratch`, `refine-from-backlog`, `record-implementation-summary`. A `move-ticket` invocation itself updates only `status` and `completed`; any body change that happens around a move (e.g. the implementation summary appended on entry to `4-testing`) happens via one of those explicit ops, composed into the move. Ad-hoc body edits outside these ops are a separate, explicit user request.
- **Never** writes ADRs — `.tickets/ADRs/` is out of scope for this skill.
- **Never** invents context. If you cannot find the file or function the user is referencing, ask — do not bluff a Context section.
