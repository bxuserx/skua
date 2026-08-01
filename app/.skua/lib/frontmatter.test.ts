// Frontmatter round-trip suite.
//
//   A. CONTRACT — behaviour that held before the YAML rewrite and must keep
//      holding. A break here is a regression.
//   B. FORMERLY BROKEN — each of these was a real data-loss defect in the
//      hand-rolled parser. They were staged as `test.failing` so the suite
//      stayed green while the bugs existed and went red the moment the rewrite
//      fixed them; that flip was the acceptance criterion for step 2.1.
//
// Deliberately NOT asserted: that `next_step_hint: fix bug #42` survives
// UNQUOTED. A space-preceded '#' terminates a plain scalar — that is the YAML
// spec, not a skua defect, and no YAML library will "fix" it. The real defect
// was write-side (only 5 keys were ever quoted), covered by B7.

import { test, expect, describe } from "bun:test";
import { parse, serialize } from "./frontmatter.ts";

const doc = (fm: string, body = "body text") => `---\n${fm}\n---\n\n${body}`;

// ─────────────────────────────────────────────────────────────────────────────
// A. CONTRACT — must survive the rewrite
// ─────────────────────────────────────────────────────────────────────────────
describe("contract", () => {
  test("parses a plain ticket", () => {
    const r = parse(doc(`id: TKT-101\ntitle: "A ticket"\nstatus: 0-backlog`));
    expect(r.frontmatter.id).toBe("TKT-101");
    expect(r.frontmatter.title).toBe("A ticket");
    expect(r.frontmatter.status).toBe("0-backlog");
    expect(r.body.trim()).toBe("body text");
    expect(r.malformed).toBeUndefined();
  });

  test("flags a file with no frontmatter delimiter", () => {
    expect(parse("just a body").malformed).toBeTruthy();
  });

  test("flags an unterminated frontmatter block", () => {
    expect(parse("---\nid: TKT-1\nstill going").malformed).toBeTruthy();
  });

  test("round-trips block-style lists", () => {
    const r = parse(doc(`id: TKT-1\ntags:\n  - alpha\n  - beta`));
    expect(r.frontmatter.tags).toEqual(["alpha", "beta"]);
    expect(parse(serialize(r.frontmatter, r.body)).frontmatter.tags).toEqual(["alpha", "beta"]);
  });

  test("round-trips inline flow lists", () => {
    const r = parse(doc(`id: TKT-1\ndepends_on: [TKT-2, TKT-3]`));
    expect(r.frontmatter.depends_on).toEqual(["TKT-2", "TKT-3"]);
    expect(parse(serialize(r.frontmatter, r.body)).frontmatter.depends_on).toEqual(["TKT-2", "TKT-3"]);
  });

  test("round-trips an empty list", () => {
    const r = parse(doc(`id: TKT-1\nblocks: []`));
    expect(r.frontmatter.blocks).toEqual([]);
    expect(parse(serialize(r.frontmatter, r.body)).frontmatter.blocks).toEqual([]);
  });

  test("a '#' inside a quoted scalar is literal, not a comment", () => {
    // This is correct YAML and must keep working after the rewrite.
    expect(parse(doc(`title: "fix bug #42 before shipping"`)).frontmatter.title)
      .toBe("fix bug #42 before shipping");
  });

  test("file paths with slashes survive files_touched", () => {
    const fm = { id: "TKT-1", files_touched: ["app/.skua/lib/tickets.ts", "a b/c.ts"] };
    expect(parse(serialize(fm, "b")).frontmatter.files_touched)
      .toEqual(["app/.skua/lib/tickets.ts", "a b/c.ts"]);
  });

  test("serialize is stable — a second pass changes nothing", () => {
    const once = serialize(parse(doc(`id: TKT-1\ntitle: "T"\ntags:\n  - a`)).frontmatter, "body text");
    const twice = serialize(parse(once).frontmatter, parse(once).body);
    expect(twice).toBe(once);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. FORMERLY BROKEN — each of these was real data loss before 2.1.
// ─────────────────────────────────────────────────────────────────────────────
describe("formerly-broken behaviour (fixed in 2.1)", () => {
  // B1 was written against the old docstring's promise of a `_raw` string slot.
  // The rewrite fulfils that promise through a retained YAML Document (`_doc`)
  // instead, so the assertion is on the BEHAVIOUR (exotic content survives a
  // round-trip) rather than on a particular field name.
  test("B1: exotic content survives a round-trip", () => {
    const p = parse(doc(`id: TKT-1\nowner:\n  name: bx\n  team: core`));
    expect(p._doc).toBeDefined();
    const again = parse(serialize(p.frontmatter, p.body, p));
    expect(again.frontmatter.owner).toEqual({ name: "bx", team: "core" });
  });

  test("B2: hyphenated keys are silently dropped", () => {
    expect(parse(doc(`id: TKT-1\nweird-key: value`)).frontmatter["weird-key"]).toBe("value");
  });

  // Comments survive only when the ParsedFile is threaded back through as
  // `prev` — that is the documented contract, and how every caller editing an
  // existing file must use it. (The original version of this test parsed twice
  // and passed no `prev`, so it was asking serialize to preserve something it
  // had never been given.)
  test("B3: comment lines survive a round-trip via prev", () => {
    const raw = doc(`# a hand-written note\nid: TKT-1`);
    const p = parse(raw);
    expect(serialize(p.frontmatter, p.body, p)).toContain("# a hand-written note");
  });

  test("B3b: without prev, formatting is regenerated — values still intact", () => {
    const raw = doc(`# a hand-written note\nid: TKT-1`);
    const p = parse(raw);
    expect(parse(serialize(p.frontmatter, p.body)).frontmatter.id).toBe("TKT-1");
  });

  test("B4: nested maps collapse to [] and their children vanish", () => {
    expect(parse(doc(`id: TKT-1\nowner:\n  name: bx\n  team: core`)).frontmatter.owner)
      .toEqual({ name: "bx", team: "core" });
  });

  test("B5: block scalars become the literal string '|'", () => {
    expect(parse(doc(`id: TKT-1\ndescription: |\n  line one\n  line two`)).frontmatter.description)
      .toBe("line one\nline two\n");
  });

  // The original input here, `title: "C:\Users\bx"`, is not valid YAML at all —
  // `\U` is an illegal escape in a double-quoted scalar. The old parser ate the
  // backslashes silently; the correct behaviour is to round-trip a real path we
  // write, and to REFUSE the invalid form rather than mangle it.
  test("B6: a Windows path round-trips when skua writes it", () => {
    const written = serialize({ id: "TKT-1", title: String.raw`C:\Users\bx` }, "b");
    expect(parse(written).frontmatter.title).toBe(String.raw`C:\Users\bx`);
  });

  test("B6b: an illegal escape is reported, not silently mangled", () => {
    const p = parse(doc(String.raw`title: "C:\Users\bx"`));
    expect(p.malformed).toContain("Invalid escape");
  });

  test("B6c: a trailing backslash no longer corrupts progressively on save", () => {
    let fm: Record<string, unknown> = { id: "TKT-1", title: "trailing slash \\" };
    const first = { ...fm };
    for (let i = 0; i < 3; i++) fm = parse(serialize(fm, "b")).frontmatter;
    expect(fm.title).toBe(first.title);
  });

  test("B7: unquoted values containing ' #' are truncated on write", () => {
    // The defect is write-side: serialize only quotes title/status/priority/
    // assignee/domain, so any other key with a ' #' is re-read as truncated.
    const fm = { id: "TKT-1", next_step_hint: "fix bug #42 before shipping" };
    expect(parse(serialize(fm, "b")).frontmatter.next_step_hint).toBe("fix bug #42 before shipping");
  });

  test("B8: a newline in a value forges arbitrary frontmatter fields", () => {
    // Titles come from users and agents. This is stored injection.
    const fm = { id: "TKT-1", title: "x\nrelated: [TKT-999]" };
    const reparsed = parse(serialize(fm, "b")).frontmatter;
    expect(reparsed.related).toBeUndefined();
    expect(reparsed.title).toBe("x\nrelated: [TKT-999]");
  });

  test("B8b: a newline containing '---' breaks out of the frontmatter block", () => {
    const fm = { id: "TKT-1", title: "x\n---\nINJECTED BODY\n---\ntitle: hijacked" };
    expect(parse(serialize(fm, "real body")).body.trim()).toBe("real body");
  });

  test("B9: object values serialize as '[object Object]'", () => {
    expect(serialize({ id: "TKT-1", meta: { a: 1 } }, "b")).not.toContain("[object Object]");
  });

  test("B10: leading body indentation is stripped", () => {
    const body = "    indented code block\n    line two";
    expect(serialize({ id: "TKT-1" }, body)).toContain("    indented code block");
  });
});
