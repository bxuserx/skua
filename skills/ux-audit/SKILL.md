---
name: ux-audit
description: "The optimization counterpart to bug-scan (defects) and feature-scout (new features): audits the EXISTING app's UX and proposes improvements — routing/flow simplification, visual hierarchy, affordances, feedback/loading/empty/error states, consistency, microcopy, and animation/interaction polish. Grades against Nielsen's 10 heuristics + standard visual-design principles; pure code-read (no server, no extra perms) so it runs in the chaos scout rotation. Files [ux, ai-proposed] improvement tickets, deduped against the board. Runs with ponytail OFF (propose boldly; minimalism is for build time)."
when_to_use: "User says 'audit the UX', 'review the UI/flow', 'what should we polish', 'is the routing/visual/flow right', '/ux-audit'. Also auto-run by the chaos supervisor's scout rotation when the backlog drains."
connects_to:
  - handoff:ticket-manager
kind: workflow
---

# UX Audit

Skua's third generative seam: **refine what exists.** `bug-scan` finds defects, `feature-scout` invents features, and `ux-audit` asks *"is what we already built actually good to use?"* — routing, flow, visual hierarchy, feedback, polish — and files concrete improvement tickets.

> **Ponytail is OFF here.** Propose improvements boldly (including *adding* polish/animation where it earns its keep) — ponytail governs HOW the fix is built later, not WHETHER a UX improvement is worth proposing. Imagine expansively, build minimally.

Product contract (same as bug-scan/feature-scout): every filed ticket is a **real, grounded** finding — cited to a `file:line` and tied to a heuristic — never vague "make it prettier" filler. A backlog of taste-only nitpicks is worse than none.

## Arguments

`/ux-audit [N]` — file up to `N` improvements (default 5; the chaos supervisor passes its remaining `max_generated_features` cap). Optional focus, e.g. `/ux-audit onboarding`.

## Procedure

### 1. Read the app's UX surface
- **Routing & flow:** the router / route definitions, page entry points, primary user journeys (auth, the core task, settings). Map "how does a user get from A to B".
- **Components:** shared UI components, forms, navigation, primary/secondary actions.
- **State coverage:** for each meaningful view, does it handle **loading / empty / error / success** states, or only the happy path?
- **Context:** `CLAUDE.md` (product intent) and the dashboard graphs (`/graphs/dataflow`, `/graphs/ai-ecosystem`) for the flow + the data the UI could surface.

### 2. Diverge (fan-out by heuristic cluster)
Spawn **3–5 fresh `Agent` subagents in parallel**, each owning a cluster, each returning concrete findings with a `file:line` and a one-line impact:
- **Flow & navigation** — routing depth/dead-ends, unnecessary steps, unclear back/forward, deep links, breadcrumbs. (Nielsen #3 user control, #7 efficiency.)
- **Feedback & states** — missing loading/empty/error states, no confirmation on destructive/async actions, silent failures, optimistic-update gaps. (Nielsen #1 status visibility, #9 error recovery.)
- **Visual hierarchy & consistency** — primary action not prominent, competing emphasis, inconsistent spacing/typography/components, mismatched patterns. (Nielsen #4 consistency, #8 minimalist.)
- **Affordance & clarity** — is it obvious what's clickable/editable; microcopy that's jargony or ambiguous; labels/empty-state guidance. (Nielsen #2 match real world, #6 recognition.)
- **Motion & polish** — interactions that would benefit from transitions/feedback animation (and `prefers-reduced-motion` respect); abrupt state changes; missing hover/focus affordances. (Use sparingly — animation must serve a purpose.)

### 3. Converge (judge panel)
Score each finding on **user impact × effort × confidence** (is it really an issue, or just taste?). Then:
- **Adversarially de-dupe** against every existing ticket + ADR. Never refile.
- Drop taste-only / unfalsifiable items — keep findings a reviewer would agree are real. Keep the top **N**.
- **Saturation:** if nothing clears the bar, say so and file nothing — this is the signal the chaos rotation uses to move to the next scout.

### 4. File the survivors
Create a backlog ticket per finding via the CLI:

```bash
bun .skua/scripts/ticket-cli.ts create \
  --title "<concise improvement>" --domain app \
  --priority <High|Medium|Low> --complexity <1-3> \
  --tags ux,ai-proposed --body-file <tmp.md>
```

Body = standard **Objective / Context (with `file:line`) / Acceptance Criteria**, plus a **`### UX Finding`** block:

```markdown
### UX Finding
**Heuristic:** <e.g. "Visibility of system status (Nielsen #1)" / "Visual hierarchy">
**Where:** <file:line or component / route>
**Now:** <what the current experience does>
**Proposed:** <the concrete change>
**Why it helps:** <the user-facing benefit, one line>
**Impact:** <high/med/low> · **Effort:** <low/med>
```

`ux,ai-proposed` tags are mandatory — `ai-proposed` lets the human filter AI-found work; `ux` lets the board filter the optimization seam.

### 5. Report
List filed (id · title · heuristic), deduped, and whether the pass saturated. No full bodies.

## Honesty rules
- Every finding cites a `file:line` and a heuristic. No ground = not ready; drop it.
- Distinguish **real usability issues** from **personal taste**. File the former; skip the latter. The fastest way to make this skill ignored is to fill the board with subjective nitpicks.
- De-dupe against the whole board + ADRs before filing.
- Saturation is a valid, common outcome — say "nothing actionable this pass."
- You file backlog tickets only — never edit code. Chaos (or a human) builds the fix.
