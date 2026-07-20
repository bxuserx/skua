// Minimal YAML frontmatter parser/serializer for ticket files.
// Supports the subset the ticket-manager skill writes:
//   scalar:  key: "string"  | key: bare-string | key: 2026-05-18
//   list:    key:
//              - item
//              - item
//   inline:  key: []
// Anything more exotic is preserved verbatim in a `_raw` slot.

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
  malformed?: string;
};

const DELIM = /^---\s*$/m;

export function parse(raw: string): ParsedFile {
  if (!raw.startsWith("---")) {
    return { frontmatter: {}, body: raw, malformed: "missing frontmatter delimiter" };
  }
  const lines = raw.split(/\r?\n/);
  // first line is ---, find next ---
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (DELIM.test(lines[i])) { end = i; break; }
  }
  if (end < 0) return { frontmatter: {}, body: raw, malformed: "unterminated frontmatter" };

  const fmLines = lines.slice(1, end);
  const body = lines.slice(end + 1).join("\n");

  const fm: Frontmatter = {};
  let i = 0;
  while (i < fmLines.length) {
    const line = fmLines[i];
    if (!line.trim() || line.trim().startsWith("#")) { i++; continue; }
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!m) { i++; continue; }
    const key = m[1];
    const valRaw = m[2];

    if (valRaw === "" || valRaw === undefined) {
      // block list
      const items: string[] = [];
      i++;
      while (i < fmLines.length && /^\s+-\s+/.test(fmLines[i])) {
        items.push(stripScalar(fmLines[i].replace(/^\s+-\s+/, "")));
        i++;
      }
      fm[key] = items;
      continue;
    }

    if (valRaw.startsWith("[") && valRaw.endsWith("]")) {
      const inner = valRaw.slice(1, -1).trim();
      fm[key] = inner === "" ? [] : inner.split(",").map((s) => stripScalar(s.trim()));
      i++;
      continue;
    }

    fm[key] = stripScalar(valRaw);
    i++;
  }
  return { frontmatter: fm, body };
}

function stripScalar(s: string): string {
  s = s.trim();
  // Quoted scalar: read to the matching closing quote so a '#' inside the
  // value stays literal (it is NOT a comment), and any trailing " # comment"
  // after the close is dropped. Double-quoted values honor backslash escapes.
  const q = s[0];
  if (q === '"' || q === "'") {
    let out = "";
    for (let i = 1; i < s.length; i++) {
      const c = s[i];
      if (q === '"' && c === "\\" && i + 1 < s.length) { out += s[i + 1]; i++; continue; }
      if (c === q) return out;
      out += c;
    }
    // Unterminated quote — fall through to bare handling.
  }
  // Unquoted scalar: a whitespace-prefixed '#' starts a trailing comment.
  return s.replace(/\s+#.*$/, "").trim();
}

// Serialize back. Keys appear in this order; unknown keys appended after.
const KEY_ORDER = [
  "id", "title", "status", "priority", "assignee",
  "created", "completed",
  "domain", "secondary_domains",
  "tags",
  "depends_on", "blocks", "related",
  "files_touched",
];

const QUOTED_KEYS = new Set(["title", "status", "priority", "assignee", "domain"]);
const LIST_KEYS = new Set([
  "secondary_domains", "tags", "depends_on", "blocks", "related",
  "files_touched",
]);

export function serialize(fm: Frontmatter, body: string): string {
  const out: string[] = ["---"];
  const seen = new Set<string>();

  const emit = (k: string) => {
    const v = fm[k];
    if (v === undefined || v === null) return;
    seen.add(k);
    if (LIST_KEYS.has(k) || Array.isArray(v)) {
      const arr = (v as unknown[]).map(String);
      if (arr.length === 0) {
        out.push(`${k}: []`);
      } else if (k === "tags" || k === "secondary_domains") {
        // tags/secondary_domains historically use block-list style
        out.push(`${k}:`);
        for (const item of arr) out.push(`  - ${item}`);
      } else if (k === "files_touched") {
        // File paths contain "/" and sometimes spaces — quote each so YAML
        // stays well-formed.
        out.push(`${k}:`);
        for (const item of arr) out.push(`  - "${item.replace(/"/g, '\\"')}"`);
      } else {
        // depends_on/blocks/related: inline flow style for compactness
        out.push(`${k}: [${arr.join(", ")}]`);
      }
      return;
    }
    if (QUOTED_KEYS.has(k)) {
      out.push(`${k}: "${String(v).replace(/"/g, '\\"')}"`);
    } else {
      out.push(`${k}: ${v}`);
    }
  };

  for (const k of KEY_ORDER) emit(k);
  for (const k of Object.keys(fm)) if (!seen.has(k)) emit(k);

  out.push("---");
  // ensure exactly one blank line between frontmatter and body
  const bodyTrimmed = body.replace(/^\s+/, "");
  return out.join("\n") + "\n\n" + bodyTrimmed;
}
