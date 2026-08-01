// YAML frontmatter for ticket and ADR files.
//
// Backed by the vendored `yaml` (lib/vendor/yaml) via its Document API. The
// previous hand-rolled subset parser was not an inverse of its serializer, and
// a no-op save through the editor silently destroyed data: comment lines and
// hyphenated keys were dropped outright, nested maps collapsed to `[]`, block
// scalars became the literal string "|", backslashes were eaten (so a Windows
// path degraded on every save), and a newline in any value could forge
// arbitrary frontmatter fields or break out of the block entirely.
//
// Why the Document API and not `parse`/`stringify`: only Document round-trips
// comments and constructs we don't model. `parse(raw)` keeps the parsed
// Document on the result, and `serialize(fm, body, prev)` applies the diff of
// `fm` onto it — so keys nobody edited keep their original comments, quoting and
// ordering, and the file a user hand-wrote still looks hand-written afterwards.
//
// Vendored rather than imported from node_modules: setup.sh copies the dashboard
// with `rsync --exclude node_modules` and never runs an install, so an installed
// skua has no node_modules at all and a bare `import "yaml"` would break it.

import { parseDocument, type Document } from "./vendor/yaml/index.js";

export type Frontmatter = {
  id?: string;
  title?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  created?: string;
  completed?: string;
  domain?: string;
  secondary_domains?: string[];
  tags?: string[];
  depends_on?: string[];
  blocks?: string[];
  related?: string[];
  // Repo-relative paths the agent edited while implementing this ticket.
  // Captured on move-to-testing; union'd on subsequent moves.
  files_touched?: string[];
  // Per-ticket override for the dashboard hovercard's "Next:" hint.
  // Written by ticket-manager skill ops at each lifecycle transition;
  // empty / absent falls back to the canonical per-bucket sentence.
  next_step_hint?: string;
  [key: string]: unknown;
};

export type ParsedFile = {
  frontmatter: Frontmatter;
  body: string;
  /** Set when the frontmatter block is absent or unparseable. Consumers must
   *  treat the file as read-only: writing over it would destroy whatever the
   *  parser could not read. */
  malformed?: string;
  /** The retained YAML Document, so serialize() can write back onto the original
   *  structure instead of regenerating it. Opaque — do not depend on its shape. */
  _doc?: unknown;
};

/** 1.2/core pins the schema explicitly. It is already yaml@2's default, but the
 *  difference matters enough to state: under YAML 1.1 a title of `yes`/`no`/`on`
 *  parses as a boolean and an unquoted `created: 2026-05-18` becomes a Date. */
const YAML_OPTS = { version: "1.2", schema: "core" } as const;

/** lineWidth 0 disables folding: the default (80) reflows any plain scalar over
 *  ~70 chars, so every ticket with a long title would show a spurious diff on
 *  first save. flowCollectionPadding false emits `[TKT-102]` rather than
 *  `[ TKT-102 ]`, matching what skua and its skills have always written — without
 *  it every existing file churns one line the first time it is saved. */
const STRINGIFY_OPTS = { lineWidth: 0, flowCollectionPadding: false } as const;

const DELIM = /^---\s*$/;

/** Split a file into its frontmatter source and body. Returns null when there is
 *  no frontmatter block to speak of. */
function split(raw: string): { fmText: string; body: string } | null {
  if (!raw.startsWith("---")) return null;
  const lines = raw.split(/\r?\n/);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (DELIM.test(lines[i])) { end = i; break; }
  }
  if (end < 0) return null;
  return {
    fmText: lines.slice(1, end).join("\n"),
    // Only leading NEWLINES are trimmed, never leading spaces: a body opening
    // with an indented code block must keep its indentation.
    body: lines.slice(end + 1).join("\n").replace(/^\n+/, ""),
  };
}

export function parse(raw: string): ParsedFile {
  const parts = split(raw);
  if (!parts) {
    return {
      frontmatter: {},
      body: raw,
      malformed: raw.startsWith("---")
        ? "unterminated frontmatter"
        : "missing frontmatter delimiter",
    };
  }

  const doc = parseDocument(parts.fmText, YAML_OPTS);
  if (doc.errors.length) {
    // Surface the real YAML error rather than silently dropping the line, which
    // is what let a broken ticket render as blank and then be saved over.
    return {
      frontmatter: {},
      body: raw,
      malformed: `invalid YAML frontmatter: ${doc.errors[0].message}`,
    };
  }

  const value = doc.toJS();
  const frontmatter: Frontmatter =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Frontmatter)
      : {};

  return { frontmatter, body: parts.body, _doc: doc };
}

// Key order for files we author from scratch. An existing file keeps whatever
// order it already had — reordering someone's frontmatter on save is churn.
const KEY_ORDER = [
  "id", "title", "status", "priority", "assignee",
  "created", "completed",
  "domain", "secondary_domains",
  "tags",
  "depends_on", "blocks", "related",
  "files_touched",
];

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Apply `fm` onto an existing Document, touching only what actually changed. */
function applyOnto(doc: Document, fm: Frontmatter): void {
  const current = (doc.toJS() ?? {}) as Record<string, unknown>;

  for (const key of Object.keys(current)) {
    if (!(key in fm) || fm[key] === undefined) doc.delete(key);
  }
  for (const [key, value] of Object.entries(fm)) {
    if (value === undefined) continue;
    // Only write when the value differs: doc.set() replaces the node, which
    // would discard that key's comment and quoting style.
    if (!sameValue(current[key], value)) doc.set(key, value);
  }
}

/** Serialize frontmatter + body back to file text.
 *
 *  Pass the `ParsedFile` the values came from as `prev` to preserve the original
 *  document's comments, quoting and key order. Without it the frontmatter is
 *  regenerated from scratch, which is correct but loses formatting — so callers
 *  editing an existing file should always thread it through. */
export function serialize(fm: Frontmatter, body: string, prev?: ParsedFile): string {
  let doc: Document;
  const retained = prev?._doc as Document | undefined;

  if (retained && retained.contents) {
    doc = retained;
    applyOnto(doc, fm);
  } else {
    doc = parseDocument("{}", YAML_OPTS) as Document;
    doc.contents = null;
    const ordered = [
      ...KEY_ORDER.filter((k) => fm[k] !== undefined),
      ...Object.keys(fm).filter((k) => !KEY_ORDER.includes(k) && fm[k] !== undefined),
    ];
    // Seed an empty map, then set in order.
    doc = parseDocument(ordered.length ? "" : "{}", YAML_OPTS) as Document;
    for (const key of ordered) doc.set(key, fm[key]);
  }

  let yaml = doc.toString(STRINGIFY_OPTS);
  if (yaml === "null\n" || yaml === "{}\n") yaml = "";
  if (yaml && !yaml.endsWith("\n")) yaml += "\n";

  return `---\n${yaml}---\n\n${body.replace(/^\n+/, "")}`;
}
