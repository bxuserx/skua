// Ticket write-path tests.
//
// TICKETS_ROOT is a module-scope const in skua.config.ts, evaluated at import
// time, so it cannot be varied between test cases. The env var is set here
// BEFORE a dynamic import, which is what makes a temp board possible at all —
// a static `import` would be hoisted above the assignment and pick up the real
// board instead.

import { test, expect, describe, afterAll } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// Two levels on purpose. The traversal test asserts on ROOT/.. , so ROOT must
// NOT sit directly in the system tmpdir: an escape written by a failing run
// would survive cleanup and poison every subsequent run (and litter /tmp).
// SANDBOX is the outer dir we own and delete; ROOT is the board inside it.
const SANDBOX = mkdtempSync(join(tmpdir(), "skua-sandbox-"));
const ROOT = join(SANDBOX, "board");
mkdirSync(ROOT, { recursive: true });
process.env.SKUA_TICKETS_ROOT = ROOT;

const { createTicket } = await import("./tickets.ts");

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }));

describe("createTicket: domain is not a path", () => {
  // Confirmed exploit against a real install: {"domain":"x/../../../ESCAPED"}
  // wrote ESCAPED-owned.md into the repo root, outside .tickets entirely, with
  // attacker-controlled body. join() normalizes "../" lexically, so no
  // intermediate directory has to exist.
  test("a traversing domain cannot write outside TICKETS_ROOT", async () => {
    const escapeTarget = resolve(ROOT, "..", "ESCAPED-owned.md");
    await createTicket({ title: "owned", domain: "x/../../../ESCAPED" });
    expect(existsSync(escapeTarget)).toBe(false);
  });

  test("every created file stays inside its bucket directory", async () => {
    await createTicket({ title: "nested", domain: "a/b/c" });
    const files = readdirSync(join(ROOT, "scratch"));
    expect(files.some((f) => f.includes("a-b-c"))).toBe(true);
    // No stray directories were created inside the bucket.
    expect(files.every((f) => f.endsWith(".md"))).toBe(true);
  });

  test("a domain with a slash no longer 500s (it slugifies)", async () => {
    const t = await createTicket({ title: "slashy", domain: "web/ui" });
    expect(t.domain).toBe("web-ui");
    expect(t.filename).toContain("web-ui");
  });

  test("an all-punctuation domain falls back to meta, not untitled", async () => {
    const t = await createTicket({ title: "punct", domain: "../.." });
    expect(t.domain).toBe("meta");
  });

  test("a normal domain is unchanged", async () => {
    const t = await createTicket({ title: "normal", domain: "app" });
    expect(t.domain).toBe("app");
  });
});
