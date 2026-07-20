// ----------------------------------------------------------------------------
// Accordion — the canonical <details> chrome used by the ADR detail view
// (markdown sections), the ticket detail view (initial-plan sections +
// relationships block), and anywhere else we want collapsible content with
// the colored left-border accent.
//
// Markup contract (the CSS rules in styles.css all key off these classes):
//
//   <details class="adr-section adr-section-<slug>" [open]>
//     <summary class="adr-section-h">Title</summary>
//     ...content...
//     [nested]:
//     <details class="adr-subsection adr-subsection-<slug>" open>
//       <summary class="adr-subsection-h">Sub-title</summary>
//       ...
//     </details>
//   </details>
//
// All accordion-bearing containers must sit inside an `.adr-md` ancestor so
// the base-section CSS rules (background, border, padding) apply.
//
// Per-slug accent colors live in the "Section slug accents" block in
// styles.css. To introduce a new section, add the slug there + use the same
// slug here.
// ----------------------------------------------------------------------------

import { escapeHtml } from "/components/html-utils.js";

export const ACCORDION_CONTAINER_CLASS = "adr-md";
export const SECTION_CLASS = "adr-section";
export const SECTION_HEADING_CLASS = "adr-section-h";
export const SUBSECTION_CLASS = "adr-subsection";
export const SUBSECTION_HEADING_CLASS = "adr-subsection-h";

export function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

// Render a top-level accordion section. `titleHtml` and `contentHtml` are
// inserted as-is — callers are responsible for escaping.
export function renderAccordion({
  title,
  titleHtml,
  slug,
  contentHtml = "",
  open = false,
  extraClass = "",
}) {
  const s = slug ?? slugify(title ?? "");
  const cls = [SECTION_CLASS, `${SECTION_CLASS}-${s}`, extraClass]
    .filter(Boolean)
    .join(" ");
  const openAttr = open ? " open" : "";
  const heading = titleHtml ?? escapeHtml(title ?? "");
  return (
    `<details class="${cls}"${openAttr}>` +
    `<summary class="${SECTION_HEADING_CLASS}">${heading}</summary>` +
    contentHtml +
    `</details>`
  );
}

// Render a nested H4-level sub-section inside an accordion.
export function renderSubsection({
  title,
  titleHtml,
  slug,
  contentHtml = "",
  open = true,
}) {
  const s = slug ?? slugify(title ?? "");
  const openAttr = open ? " open" : "";
  const heading = titleHtml ?? escapeHtml(title ?? "");
  return (
    `<details class="${SUBSECTION_CLASS} ${SUBSECTION_CLASS}-${s}"${openAttr}>` +
    `<summary class="${SUBSECTION_HEADING_CLASS}">${heading}</summary>` +
    contentHtml +
    `</details>`
  );
}

