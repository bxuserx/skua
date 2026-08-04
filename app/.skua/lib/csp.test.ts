import { test, expect, describe } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Guard for the bug class that broke the terminal's project-search tab: the base
// CSP pins `frame-ancestors 'none'`, so any page loaded into an <iframe> must be
// listed in server.ts's framed-page allowlist or the browser blocks it outright
// and the pane renders empty. The allowlist is hand-maintained, so adding a
// framed page and forgetting it is silent — nothing throws, the frame is just
// blank. These tests read the real sources so the check can't drift.

const HERE = join(import.meta.dir, "..");
const SERVER = readFileSync(join(HERE, "server.ts"), "utf8");
const PUBLIC = join(HERE, "public");

/** Every `.html` a client script loads into an iframe (`x.src = "/foo.html…"`). */
function framedPages(): Set<string> {
  const found = new Set<string>();
  for (const file of readdirSync(PUBLIC)) {
    if (!file.endsWith(".js")) continue;
    const src = readFileSync(join(PUBLIC, file), "utf8");
    // Only .src assignments — a fetch() or link href isn't framing.
    for (const m of src.matchAll(/\.src\s*=\s*[`"']\/([\w.-]+\.html)/g)) {
      found.add(m[1]);
    }
  }
  return found;
}

/** Header-set consts whose CSP actually permits being framed. Derived from the
 *  declarations rather than hardcoded, so renaming a set can't fool the test. */
function framingHeaderSets(): Set<string> {
  const sets = new Set<string>();
  for (const m of SERVER.matchAll(/const (\w*HEADERS)\s*=\s*\{[\s\S]*?\n\};/g)) {
    if (m[0].includes("frame-ancestors 'self'")) sets.add(m[1]);
  }
  return sets;
}

/** The `.html` names server.ts routes to a framing-permitted header set. */
function allowlisted(): Set<string> {
  // The header-selection expression: `const htmlHeaders = <ternary>;`
  const block = /const htmlHeaders\s*=([\s\S]*?);\n/.exec(SERVER);
  expect(block, "server.ts should pick headers via `const htmlHeaders = …`").toBeTruthy();
  const framing = framingHeaderSets();
  expect(framing.size, "some header set should grant frame-ancestors 'self'").toBeGreaterThan(0);

  const names = new Set<string>();
  // Each ternary arm is `<condition> ? <HEADER_SET>`. One condition can cover
  // several pages via `||`, so collect every path test in the matching arm.
  for (const [, cond, ident] of block![1].matchAll(/([^?:]+?)\?\s*(\w*HEADERS)/g)) {
    if (!framing.has(ident)) continue;
    for (const m of cond.matchAll(/path === "([\w.-]+\.html)"/g)) names.add(m[1]);
  }
  return names;
}

describe("CSP framed-page allowlist", () => {
  test("every iframed page is allowlisted for framing", () => {
    const framed = framedPages();
    // Sanity: the scan must actually find the known frames, or it silently passes.
    expect(framed.size).toBeGreaterThan(0);
    expect(framed).toContain("terminal-xterm.html");
    expect(framed).toContain("search.html");

    const allowed = allowlisted();
    for (const page of framed) {
      expect(
        allowed.has(page),
        `${page} is loaded into an <iframe> but is not in server.ts's framed-page ` +
          `allowlist — the base CSP's \`frame-ancestors 'none'\` will block it and ` +
          `the pane will render empty.`,
      ).toBe(true);
    }
  });

  test("the framed header set really grants frame-ancestors 'self'", () => {
    const decl = /const FRAMED_HTML_HEADERS[\s\S]*?\n};/.exec(SERVER);
    expect(decl, "FRAMED_HTML_HEADERS should exist").toBeTruthy();
    expect(decl![0]).toContain("frame-ancestors 'self'");
    // Built fresh, not appended: a second frame-ancestors directive is ignored,
    // so `CSP + "; frame-ancestors 'self'"` would silently keep 'none'.
    expect(decl![0]).not.toMatch(/CSP\s*\+/);
  });

  test("the base CSP still denies framing by default", () => {
    expect(SERVER).toContain("\"frame-ancestors 'none'\"");
  });
});

describe("static assets are servable", () => {
  test("every extension referenced by the stylesheets has a MIME entry", () => {
    const styles = join(PUBLIC, "styles");
    const exts = new Set<string>();
    for (const file of readdirSync(styles)) {
      if (!file.endsWith(".css")) continue;
      const css = readFileSync(join(styles, file), "utf8");
      for (const m of css.matchAll(/url\(\/[\w./-]+?(\.\w+)\)/g)) exts.add(m[1]);
    }
    for (const ext of exts) {
      expect(SERVER.includes(`"${ext}":`), `MIME map is missing ${ext}`).toBe(true);
    }
  });
});
