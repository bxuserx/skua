// Round-trip fidelity over a real ticket corpus (plan step 0.3a).
//
// `git diff` is NOT an oracle for this: skua's own repo has no .tickets/ board
// (`git ls-files .tickets` → 0 files), so the "save with no edits, diff must be
// empty" check passes unconditionally there. These fixtures are the oracle
// instead — real files from a skua-installed repo (see testApp/), including one
// hand-authored ticket that deliberately carries block scalars, nested maps,
// comments, a hyphenated key and a Windows path.
//
// These were staged `test.failing` until step 2.1 replaced the hand-rolled
// parser; they flipped green the moment the rewrite landed.

import { test, expect, describe } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse, serialize } from "./frontmatter.ts";

const CORPUS = join(import.meta.dir, "..", "fixtures", "tickets");

function corpusFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (entry.endsWith(".md")) out.push(p);
    }
  };
  walk(CORPUS);
  return out.sort();
}

const files = corpusFiles();

test("corpus is non-empty (a silent empty corpus would make every test below vacuous)", () => {
  expect(files.length).toBeGreaterThan(0);
});

/** Frontmatter keys as they appear in the raw text, not as parse() reports them. */
function rawKeys(text: string): string[] {
  const end = text.indexOf("\n---", 3);
  const block = end < 0 ? "" : text.slice(3, end);
  return block
    .split("\n")
    .map((l) => l.match(/^([A-Za-z_][\w-]*):/)?.[1])
    .filter((k): k is string => Boolean(k))
    .sort();
}

// One corpus-wide assertion rather than one per file: machine-written tickets
// already round-trip cleanly, so a per-file `.failing` would report "passed
// unexpectedly" for them and turn the suite red for the wrong reason. The
// defect is a property of the CORPUS — some real file loses a key on save.
//
// Keys are read off the raw text deliberately. Comparing parse-before to
// parse-after hides every key parse() drops on the way in: `review-status:`
// disappears from both sides and the check passes while the data is gone.
test("no ticket in the corpus loses a frontmatter key on save", () => {
  const lossy: string[] = [];
  for (const file of files) {
    const raw = readFileSync(file, "utf8");
    const p = parse(raw);
    const after = rawKeys(serialize(p.frontmatter, p.body));
    const missing = rawKeys(raw).filter((k) => !after.includes(k));
    if (missing.length) lossy.push(`${file.slice(CORPUS.length + 1)} → lost ${missing.join(", ")}`);
  }
  expect(lossy).toEqual([]);
});

describe("round-trip fidelity", () => {
  for (const file of files) {
    const name = file.slice(CORPUS.length + 1);
    const raw = readFileSync(file, "utf8");

    // Self-consistency: whatever the serializer's format is, re-reading its own
    // output must reproduce it byte-for-byte. This survives a serializer change
    // (unlike asserting the CURRENT bytes), so it stays green through 2.1 and
    // catches gratuitous churn on save.
    test(`${name}: the serializer's own output is a fixed point`, () => {
      const p = parse(raw);
      const written = serialize(p.frontmatter, p.body);
      const reread = parse(written);
      expect(serialize(reread.frontmatter, reread.body)).toBe(written);
    });

    // Weakest property: a second save must not keep changing the file. Anything
    // that fails THIS is corrupting progressively on every save.
    test(`${name}: round-trip converges by the second pass`, () => {
      const p1 = parse(raw);
      const once = serialize(p1.frontmatter, p1.body);
      const p2 = parse(once);
      expect(serialize(p2.frontmatter, p2.body)).toBe(once);
    });
  }
});
