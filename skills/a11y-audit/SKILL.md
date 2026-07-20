---
name: a11y-audit
description: "Accessibility audit that files [a11y, ai-proposed] tickets for WCAG 2.2 AA gaps. ENGINE mode wraps the real tools (axe-core / pa11y) against a running dev server for objective, high-signal findings; STATIC mode (the autonomous fallback) reads components/templates for high-confidence issues (missing alt text, unlabeled inputs, non-semantic clickables, missing lang, focus/contrast smells) using only Read/Grep — so it still contributes in the chaos scout rotation where the worker's Bash allowlist blocks the engine. Deduped against the board; ponytail OFF."
when_to_use: "User says 'audit accessibility', 'check a11y', 'WCAG audit', '/a11y-audit'. Auto-run by the chaos scout rotation when the backlog drains (it self-selects STATIC mode there). Run it on-demand with a dev server up to get the full axe-core/pa11y engine pass."
connects_to:
  - handoff:ticket-manager
kind: workflow
---

# Accessibility Audit

Files WCAG 2.2 AA improvement tickets. The objective engines (`axe-core`, `pa11y`) catch ~half of WCAG issues mechanically and beat any LLM eyeballing — so use them when you can, and fall back to a high-confidence static read when you can't.

> **Ponytail is OFF here** (propose all real gaps). Findings are corrective, so taste isn't the risk — *false positives* are. Only file issues you're confident map to a real WCAG criterion.

## Arguments

`/a11y-audit [N]` — file up to `N` findings (default 5; chaos passes its remaining cap). Optional `--url <http://localhost:PORT>` to point ENGINE mode at a specific server.

## Mode selection (do this first)

1. **ENGINE mode** if a dev server is reachable (a running app URL — from `--url`, `skua.config.json` port, or an obvious dev script) AND you can run `npx`:
   - axe-core: `npx @axe-core/cli <url> --save axe.json` → parse `violations[]` (each has `id`, `impact`, `help`, `helpUrl`, `nodes[].target`).
   - or pa11y: `npx pa11y --reporter json <url>` → parse the issue array (`code`, `message`, `selector`, `type`).
   - Audit the key routes, not just `/`.
2. **STATIC mode** (the fallback — and what the chaos rotation gets, since the worker allowlist blocks `npx`): read components/templates with Read/Grep for **high-confidence** issues only (next section). No browser, no Bash beyond what's allowed.

State which mode you used in the report. Never block on the engine — if it's unavailable, switch to STATIC, don't stop.

## STATIC checks (high-confidence only)

Grep/read the frontend for these — each maps to a concrete WCAG criterion:
- **Images without alt** — `<img>` / `Image` without `alt` (WCAG 1.1.1).
- **Inputs without labels** — form controls with no `<label>` / `aria-label` / `aria-labelledby` (1.3.1, 4.1.2).
- **Non-semantic clickables** — `onClick` on a `div`/`span` with no `role` + `tabIndex` + key handler (2.1.1 keyboard, 4.1.2).
- **Buttons/links without accessible names** — icon-only `<button>`/`<a>` with no text or `aria-label` (4.1.2).
- **Missing `lang`** on the root `<html>` (3.1.1).
- **Focus suppression** — `outline: none` / `outline: 0` without a replacement focus style (2.4.7).
- **Color-only signaling** — status conveyed by color alone (e.g. red/green class with no text/icon) (1.4.1) — flag only when clear.
- **Motion without guard** — animations/transitions with no `prefers-reduced-motion` handling (2.3.3).

Only file what you can cite at a `file:line`. When in doubt, drop it — a false a11y ticket erodes trust.

## File the survivors

Dedupe against the board + ADRs, keep the top N, then per finding:

```bash
bun .skua/scripts/ticket-cli.ts create \
  --title "<a11y fix>" --domain app --priority <High|Medium|Low> \
  --complexity <1-3> --tags a11y,ai-proposed --body-file <tmp.md>
```

Body = **Objective / Context (`file:line`) / Acceptance Criteria** plus:

```markdown
### A11y Finding
**WCAG:** <criterion + number, e.g. "1.1.1 Non-text Content (A)">
**Mode:** engine (axe-core/pa11y) | static
**Where:** <file:line or selector>
**Issue:** <what fails and for whom (screen-reader / keyboard / low-vision)>
**Fix:** <the concrete change>
```

## Report
List filed (id · title · WCAG), the mode used, deduped, and whether the pass saturated (so the chaos rotation advances). File tickets only — never edit code.
