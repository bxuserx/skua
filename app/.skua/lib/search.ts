// Project-wide text search backing the terminal "Search" tab (Zed ⌘⇧F style).
// Shells out to ripgrep rooted at REPO_ROOT; falls back to `git grep` when rg
// isn't installed. Returns matches grouped by file into contiguous hunks with
// ±CONTEXT lines of surrounding context. When ripgrep is used, exact highlight
// offsets come from its submatch data (so regex highlighting reflects what the
// engine actually matched); the client falls back to rebuilding the query as a
// RegExp only when the server didn't supply ranges (the git-grep path). Either
// way a matched line is flagged with `match:true`.
//
// Safety: the query is passed as an argv element (never a shell string, so no
// injection), the subprocess is killed on a global match/file cap, and a hard
// timeout kills a runaway search.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { REPO_ROOT } from "../skua.config.ts";

// The absolute directory every search is rooted at — surfaced in the search tab
// UI. Exactly the path passed as rg/git-grep's cwd, so what's shown is what's
// searched.
export const SEARCH_ROOT = REPO_ROOT;

// Resolve the ripgrep binary. Bun.which uses the server process's PATH, which —
// depending on how the dashboard was launched (GUI, launchd, a minimal shell) —
// may omit Homebrew's bin dir, so fall back to the usual absolute locations
// before giving up and using git grep.
function rgBin(): string | null {
  const w = Bun.which("rg");
  if (w) return w;
  for (const p of ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"]) {
    if (existsSync(p)) return p;
  }
  return null;
}

// `ranges` (present only on match lines, and only when the engine supplied exact
// spans) holds [start,end) CHARACTER offsets into `text` to wrap in <mark>.
export type ResultLine = { n: number; text: string; match: boolean; ranges?: [number, number][] };
export type Hunk = ResultLine[];
export type FileResult = { file: string; hunks: Hunk[]; matches: number };

export type SearchResponse = {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
  engine: "rg" | "git-grep" | "";
  files: FileResult[];
  totalMatches: number;
  totalFiles: number;
  truncated: boolean;
};

export type SearchOpts = { query: string; regex: boolean; caseSensitive: boolean };

const CONTEXT = 5; // lines shown above + below each match
const MAX_MATCHES = 4000; // stop after this many matched lines (payload guard)
const MAX_FILES = 600; // stop after this many files
const MAX_LINE = 1000; // truncate a single line to this many chars (minified files)
const TIMEOUT_MS = 20_000; // kill a runaway search
// Belt-and-suspenders on top of .gitignore — rg respects .gitignore already,
// but --hidden re-enables dot-dir traversal (.skua/.claude/.tickets ARE the
// repo), so we still hard-exclude the heavy/generated dirs.
const EXCLUDE_DIRS = ["node_modules", ".next", ".git", "dist", "build", "__pycache__", ".venv", "venv"];

// Split an in-order list of lines into hunks wherever the line numbers jump
// (a gap > 1 means a new contiguous region). Shared by both engines.
function buildFile(file: string, lines: ResultLine[]): FileResult {
  const hunks: Hunk[] = [];
  let hunk: ResultLine[] = [];
  let prev = Number.NEGATIVE_INFINITY;
  let matches = 0;
  for (const l of lines) {
    if (hunk.length && l.n > prev + 1) {
      hunks.push(hunk);
      hunk = [];
    }
    hunk.push(l);
    prev = l.n;
    if (l.match) matches++;
  }
  if (hunk.length) hunks.push(hunk);
  return { file, hunks, matches };
}

function stripEol(s: string): string {
  return s.replace(/\r?\n$/, "");
}

const ENC = new TextEncoder();
const DEC = new TextDecoder();

// rg reports each match span as BYTE offsets into the line; convert them to JS
// string (char) indices so the client can highlight exactly what rg matched —
// correct for regex mode too, where a client-rebuilt RegExp would diverge from
// rg's engine. Returns undefined (→ client falls back) when there's nothing
// usable, e.g. offsets past a max-columns-truncated preview line.
function submatchRanges(text: string, subs: unknown): [number, number][] | undefined {
  if (!Array.isArray(subs) || !subs.length) return undefined;
  const bytes = ENC.encode(text);
  const out: [number, number][] = [];
  for (const s of subs) {
    const a = s?.start, b = s?.end;
    if (typeof a !== "number" || typeof b !== "number") continue;
    if (a < 0 || b > bytes.length || b <= a) continue;
    const cs = DEC.decode(bytes.subarray(0, a)).length;
    const ce = DEC.decode(bytes.subarray(0, b)).length;
    if (ce > cs) out.push([cs, ce]);
  }
  return out.length ? out : undefined;
}

// ── ripgrep (primary) ─────────────────────────────────────────────────────────

async function searchRg(rg: string, opts: SearchOpts): Promise<SearchResponse> {
  const args = [
    "--json",
    "--context", String(CONTEXT),
    "--hidden",
    "--max-columns", "1000",
    "--max-columns-preview",
    "--no-messages",
  ];
  for (const d of EXCLUDE_DIRS) args.push("-g", `!${d}`);
  // rg treats the pattern as a regex by default; -F makes it a literal string.
  if (!opts.regex) args.push("--fixed-strings");
  args.push(opts.caseSensitive ? "--case-sensitive" : "--ignore-case");
  args.push("-e", opts.query, ".");

  const proc = Bun.spawn([rg, ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "ignore" });
  const files: FileResult[] = [];
  let cur: { file: string; lines: ResultLine[] } | null = null;
  let totalMatches = 0;
  let truncated = false;
  const timer = setTimeout(() => {
    truncated = true; // a wall-clock cut-off is a partial result — tell the UI
    try { proc.kill(); } catch { /* already gone */ }
  }, TIMEOUT_MS);

  const flush = () => {
    if (cur && cur.lines.length) files.push(buildFile(cur.file, cur.lines));
    cur = null;
  };

  const decoder = new TextDecoder();
  let buf = "";
  outer: for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const raw = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!raw) continue;
      let ev: any;
      try { ev = JSON.parse(raw); } catch { continue; }
      if (ev.type === "begin") {
        flush();
        if (files.length >= MAX_FILES) { truncated = true; break outer; }
        cur = { file: ev.data?.path?.text ?? "", lines: [] };
      } else if (ev.type === "match" || ev.type === "context") {
        if (!cur) continue;
        const n = ev.data?.line_number;
        if (typeof n !== "number") continue;
        const text = stripEol(ev.data?.lines?.text ?? "");
        const isMatch = ev.type === "match";
        const ranges = isMatch ? submatchRanges(text, ev.data?.submatches) : undefined;
        cur.lines.push({ n, text, match: isMatch, ranges });
        if (isMatch && ++totalMatches >= MAX_MATCHES) { truncated = true; break outer; }
      } else if (ev.type === "end") {
        flush();
      }
    }
  }
  clearTimeout(timer);
  try { proc.kill(); } catch { /* already exited */ }
  flush();

  return {
    query: opts.query, regex: opts.regex, caseSensitive: opts.caseSensitive,
    engine: "rg", files, totalMatches, totalFiles: files.length, truncated,
  };
}

// ── git grep (fallback) ────────────────────────────────────────────────────────
// git grep -n gives us matched lines only; we synthesize the ±CONTEXT window by
// reading each matched file once and slicing — same hunk shape as rg.

async function searchGitGrep(opts: SearchOpts): Promise<SearchResponse> {
  const args = ["grep", "-n", "--no-color", "-I", "--untracked", "--exclude-standard"];
  // -E (extended regex) so alternation/quantifiers behave like rg's default;
  // -F (fixed strings) for literal mode. git grep's default is basic regex, where
  // `|`/`+`/`?` are literal — never use it.
  args.push(opts.regex ? "-E" : "-F");
  if (!opts.caseSensitive) args.push("-i");
  args.push("-e", opts.query, "--", ".");
  // Parity with rg's -g '!dir': --exclude-standard only honours .gitignore, so a
  // *tracked* heavy/generated dir would still be searched — exclude them by glob
  // pathspec (matches at any depth) so both engines cover the same tree.
  for (const d of EXCLUDE_DIRS) args.push(`:(exclude,glob)**/${d}/**`, `:(exclude,glob)${d}/**`);

  const proc = Bun.spawn(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "ignore" });

  // Group matched line numbers per file, respecting the caps. Stream and kill
  // early on a cap (like the rg path) so a huge repo can't buffer unbounded.
  const byFile = new Map<string, number[]>();
  const order: string[] = [];
  let totalMatches = 0;
  let truncated = false;
  const timer = setTimeout(() => {
    truncated = true; // a wall-clock cut-off is a partial result — tell the UI
    try { proc.kill(); } catch { /* already gone */ }
  }, TIMEOUT_MS);

  const lineRe = /^(.+?):(\d+):/;
  const decoder = new TextDecoder();
  let buf = "";
  outer: for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = lineRe.exec(line);
      if (!m) continue;
      const file = m[1];
      const n = parseInt(m[2], 10);
      if (!byFile.has(file)) {
        if (byFile.size >= MAX_FILES) { truncated = true; break outer; }
        byFile.set(file, []);
        order.push(file);
      }
      byFile.get(file)!.push(n);
      if (++totalMatches >= MAX_MATCHES) { truncated = true; break outer; }
    }
  }
  clearTimeout(timer);
  try { proc.kill(); } catch { /* already exited */ }

  const files: FileResult[] = [];
  for (const file of order) {
    let content = "";
    try {
      content = await readFile(join(REPO_ROOT, file), "utf8");
    } catch {
      continue;
    }
    const all = content.split("\n");
    const wanted = new Map<number, boolean>(); // line -> isMatch
    for (const m of byFile.get(file)!) {
      if (m >= 1 && m <= all.length) wanted.set(m, true);
      for (let k = 1; k <= CONTEXT; k++) {
        for (const c of [m - k, m + k]) {
          if (c >= 1 && c <= all.length && !wanted.has(c)) wanted.set(c, false);
        }
      }
    }
    const nums = [...wanted.keys()].sort((a, b) => a - b);
    const lines: ResultLine[] = nums.map((n) => ({ n, text: (all[n - 1] ?? "").slice(0, MAX_LINE), match: wanted.get(n) === true }));
    files.push(buildFile(file, lines));
  }

  return {
    query: opts.query, regex: opts.regex, caseSensitive: opts.caseSensitive,
    engine: "git-grep", files, totalMatches, totalFiles: files.length, truncated,
  };
}

export async function runSearch(opts: SearchOpts): Promise<SearchResponse> {
  const q = opts.query.trim();
  if (!q) {
    return { query: q, regex: opts.regex, caseSensitive: opts.caseSensitive, engine: "", files: [], totalMatches: 0, totalFiles: 0, truncated: false };
  }
  // Search, echo, and client-side highlighting all key off the same trimmed
  // query — otherwise leading/trailing spaces would search literally yet the UI
  // would highlight the un-spaced form (or vice-versa) and the two misalign.
  const norm: SearchOpts = { ...opts, query: q };
  const rg = rgBin();
  if (rg) {
    try {
      return await searchRg(rg, norm);
    } catch {
      // rg present but failed to spawn/parse — fall through to git grep.
    }
  }
  return await searchGitGrep(norm);
}
