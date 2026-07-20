# skua UI components

Shared UI primitives used across the skua dashboard pages
(`index.html`, `ticket.html`, `adr.html`, `adrs.html`, `graphs.html`).

## Conventions

- Each component is one ES module in this folder. Pages import via
  `<script type="module" src="/components/<name>.js">` or, for
  auto-wiring behaviours, a plain `<script src="/components/<name>.js">`.
- Markup is produced by `render*()` functions that return HTML strings.
  Behaviour is wired via either (a) an explicit `wire*()` call on the
  rendered DOM, or (b) an attribute-based auto-init pattern
  (see `expand-all.js`).
- CSS for every component lives in `public/styles.css`, grouped into a
  labelled block. We intentionally don't split CSS into per-component
  files — there's no build step, and one HTTP request beats many. The
  block-level banner comments are the contract.

## Components in this folder

### `accordion.js`

Canonical `<details>` chrome used by ADR section markdown, ticket
initial-plan sections, and the ticket relationships block.

Markup contract:

```html
<div class="adr-md">
  <details class="adr-section adr-section-<slug>" [open]>
    <summary class="adr-section-h">Title</summary>
    ... content ...
    <details class="adr-subsection adr-subsection-<slug>" open>
      <summary class="adr-subsection-h">Sub-title</summary>
      ...
    </details>
  </details>
</div>
```

The `.adr-md` ancestor is required so the base section CSS applies.
Per-slug accent colors live in the **Section slug accents** block in
`styles.css`. Add the slug there to introduce a new section name.

### `expand-all.js`

Drop-in `<button data-expand-all>` that toggles every
`details.adr-section` + `details.adr-subsection` on the page. Auto-wires
on `DOMContentLoaded`; re-evaluates its label on every toggle and on
DOM mutations (so it stays honest while accordions render
asynchronously).

### `html-utils.js`

`escapeHtml(s)` — HTML-entity escape for `&<>"'`. The canonical
implementation; every page module imports from here. Returns a string.

### `format.js`

`formatBytes(n)` — render a byte count as `"N B"` / `"N.M KB"` / `"N.M MB"`
with one decimal at KB/MB scale. Pure function, no DOM access.

### `theme.js`

Self-init dark/light toggle. Reads/persists `skua-theme` in localStorage,
flips `data-theme` on `<html>`, and broadcasts `skua:theme-changed` so
Cytoscape views recolor. Loaded once per page; no exports.

### `navbar-search.js`

Self-init ticket search. Finds `#navbar-search` / `#navbar-search-results`
(rendered by the shared `skua:navbar`) and wires live id/title search over
`/api/tickets`.

### `howto.js`

Self-init wiring for the `skua:howto-modal` partial — finds the help (`?`)
button and `#howto-modal` (both from the shared navbar) and handles
open/close/Escape. No exports.

## Server-side partials

Not every shared chunk needs to be a client-side ES module. Page chrome
that's identical across every page (the top navbar, the how-to modal) is
spliced in server-side by `serveStatic` in `.skua/server.ts` — the HTML
files contain a marker, the server replaces it on every request. Zero
client JS, no flash-of-unstyled-content, single source of truth.

### `skua:navbar`

The entire top navbar — nav links, ticket search, theme toggle, and the
help (`?`) button. Source of truth is `renderNavbar()` in
`.skua/server.ts` (which composes `renderNavLinks()` over the `NAV_ITEMS`
array). Replaces the whole `<header class="top">` so every view renders an
identical bar.

Markup contract:

```html
<!-- skua:navbar active="adrs" -->
```

`active` is optional — when set, the matching `NAV_ITEMS` entry gets
`class="active"`. An optional `status` token (`<!-- skua:navbar status -->`,
used by `ticket.html`) adds the `#status` save-indicator slot read by
`ticket-edit.js`. Add or remove top-level nav entries by editing
`NAV_ITEMS`; every page picks it up on next request.

### `skua:howto-modal`

The shared how-to modal. Source markup is `.skua/public/howto-modal.html`,
injected by `renderHowtoModal()` in `.skua/server.ts`. Open/close/Escape
wiring lives in the self-init `components/howto.js` module (loaded on every
page); the help button itself is part of `skua:navbar`.

Markup contract:

```html
<!-- skua:howto-modal -->
```

## Audit — what else should be componentized

The pages still have meaningful duplication. The next extractions, in
priority order, are:

| # | Component         | Used by                                                  | Notes                                                                                                          |
|---|-------------------|----------------------------------------------------------|----------------------------------------------------------------------------------------------------------------|
| 1 | `modal`           | `adr.html` (transition / comment / delete), `ticket.html` (delete) | Same `<dialog>` shape with head / body / foot, same Esc + backdrop-click close, same primary/secondary buttons. Currently re-written 4× with two slightly different style classes (`.adr-modal*` vs `.modal*`).         |
| 2 | `toolbar`         | `adr.html`, `ticket.html`                                | Both pages have a sticky toolbar with primary + danger + close affordances and the same close-X `.ticket-close` glyph. Ad-hoc per page right now.                                                                              |
| 3 | `field`           | `ticket.html`, `adrs.html` create form                   | `<label>` + input pair with consistent spacing. Currently inline markup repeated per field.                    |
| 4 | `status-pill`     | `index.html` (board rows), `adrs.html` (rows), `adr.html` (side) | `<span class="adr-status adr-status-<state>">` + icon prefix. Ticket bucket pills are a separate variant; both should share the chrome. |
| 5 | `markdown`        | `adr.js`, `ticket-edit.js`                               | ADR has a full inline markdown→HTML parser; tickets do their own naive split-on-`###`. Extracting a shared renderer (or pulling in a tiny dep) removes the divergence.                                                          |
| 6 | `cytoscape-card`  | `graphs.js`                                              | The graph viewer mounts Cytoscape with a per-theme palette + dagre layout. (The ticket and ADR pages no longer embed mini-graphs.)                                                                                            |
| 7 | `version-banner`  | `adr.js`                                                 | Snapshot-view banner. Currently ADR-only but the same pattern would suit tickets if we ever snapshot them.    |
| 8 | `comments-list`   | `adr.js`                                                 | `comments.jsonl` renderer. Future: tickets could have comments using the same component.                       |

### Cross-cutting cleanup

- **`styles.css` is 3,200 lines and unindexed.** Add a top-of-file
  table-of-contents comment that lists the section banners in order
  (search-friendly anchors like `/* === COMPONENT: modal === */`),
  and split each block under one of those banners.
- **CSS variables for accents are inconsistent.** Some section colors
  use `var(--adr-accepted, #4caf6f)`, others use a literal hex. Move
  the section-slug accent palette into `:root` as named tokens
  (e.g. `--accent-context`, `--accent-decision`) and reference those
  from the per-slug rules.
- **Modal open/close handlers** are nearly identical across four
  dialogs (Esc, backdrop click, focus-deferral on open). The `modal`
  component should own that.

### Out-of-scope for now

- A build step / bundler. The current setup (vanilla ES modules served
  by Bun) is fine at this size; introducing a bundler would add more
  complexity than it removes.
- A component framework (Lit, Preact, etc.). Same reasoning — the page
  count is small and the render surface is straightforward.
