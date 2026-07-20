// Headless-browser smoke verification — the deterministic core.
//
// Boots the target project's web app on a free port, drives a headless Chromium
// over the configured routes, and fails on the runtime problems that unit tests
// can't see: uncaught exceptions (`pageerror`), `console.error`, failed network
// requests, never-resolving spinners, and blank-body white-screens. Captures the
// actual console errors + screenshots so the agent and humans can SEE them.
//
// Everything here is deterministic — no LLM judgement. The test-ticket subagent
// (or a human via `bun run smoke`) just invokes it and transcribes the JSON.
//
// Repo-scoped by construction (see the chaos repo-scoping guard): Playwright and
// its Chromium live under .skua (driver) / .skua/cache/browsers (binaries,
// gitignored), never machine-global. The module NEVER imports playwright at the
// top level — it's a dynamic import inside runSmoke() behind a try/catch, so a
// vendored copy without the (opt-in) driver imports fine and simply skips.

import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import {
  SMOKE,
  SMOKE_ARTIFACTS_DIR,
  SMOKE_BROWSERS_PATH,
  SMOKE_PORT_RANGE,
  type SmokeConfig,
} from "../skua.config.ts";
import { allocPort, waitForHttpReady } from "./ports.ts";

// `document` is referenced only inside page.evaluate / addInitScript callbacks,
// which Playwright serializes and runs IN THE BROWSER — not in Bun. Declare it so
// tsc (a Bun/server project with no DOM lib) doesn't flag those browser closures.
declare const document: any;

// The working copy whose code we boot: the dir containing the .skua that's
// actually running. In a chaos worktree that's the worktree (the edited code);
// interactively it's the repo. Anchored on this module's location, NOT REPO_ROOT
// (which the worker pins at the root repo for the shared board).
const WORKING_COPY_ROOT = join(import.meta.dir, ".."); // .skua/lib → .skua → ..= working copy
const WC_ROOT = join(WORKING_COPY_ROOT, "..");

export type SmokeStatus = "pass" | "fail" | "skipped" | "error";

export type RouteResult = {
  route: string;
  pass: boolean;
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  spinnerStuck: string[]; // spinner selectors still visible after settle
  blank: boolean; // body had essentially no content (white-screen)
  screenshot: string | null;
  note: string;
};

export type SmokeResult = {
  status: SmokeStatus;
  reason?: string; // populated for skipped / error / boot-fail
  port?: number;
  routes: RouteResult[];
  bootLogTail?: string;
  ticketId?: string;
  artifactsDir?: string;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Smoke is active iff a target declared a `smoke` block AND it isn't disabled. */
export function smokeConfigured(): boolean {
  return SMOKE !== null && process.env.SKUA_SMOKE_DISABLE !== "1";
}

/** True if a Chromium build exists in the repo-local browser cache. Playwright
 *  lays down `chromium-<rev>` and `chromium_headless_shell-<rev>` dirs. */
export function browsersProvisioned(): boolean {
  try {
    if (!existsSync(SMOKE_BROWSERS_PATH)) return false;
    return readdirSync(SMOKE_BROWSERS_PATH).some((d) => /^chromium/.test(d));
  } catch {
    return false;
  }
}

function appCwd(cfg: SmokeConfig): string {
  return isAbsolute(cfg.cwd) ? cfg.cwd : join(WC_ROOT, cfg.cwd);
}

function routeSlug(route: string): string {
  return route.replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "root";
}

// Allowlist entry matches as a plain substring OR, if it's a valid regex, a regex.
function matchesAllow(text: string, pattern: string): boolean {
  if (text.includes(pattern)) return true;
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return false;
  }
}

// Kill the dev server reliably: the child is `sh -c "<start>"`, the real server
// is usually a grandchild, so child.kill() alone can leak it. We also kill
// whatever still holds the allocated port (which we know is ours — we allocated
// it free). Best-effort; never throws.
function killApp(child: { kill: () => void }, port: number): void {
  try {
    child.kill();
  } catch {
    /* already dead */
  }
  try {
    Bun.spawnSync([
      "sh",
      "-c",
      `lsof -ti tcp:${port} 2>/dev/null | while read p; do kill -9 "$p" 2>/dev/null; done`,
    ]);
  } catch {
    /* lsof missing or nothing to kill */
  }
}

// Drain a child stream into a bounded ring buffer (so the dev server never blocks
// on a full stdout pipe, and we keep a tail for boot-failure diagnostics).
function drain(stream: ReadableStream<Uint8Array> | null, sink: string[]): void {
  if (!stream) return;
  (async () => {
    try {
      const reader = stream.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sink.push(dec.decode(value));
        if (sink.length > 200) sink.splice(0, sink.length - 200);
      }
    } catch {
      /* stream closed on teardown */
    }
  })();
}

export async function runSmoke(
  opts: { ticketId?: string; cwd?: string } = {},
): Promise<SmokeResult> {
  const ticketId = opts.ticketId;

  // ── three independent skip gates — all return exit-0 "skipped", never a fail ──
  if (!smokeConfigured()) {
    return { status: "skipped", reason: "no smoke config (or SKUA_SMOKE_DISABLE=1)", routes: [], ticketId };
  }
  const cfg = SMOKE as SmokeConfig;
  if (!browsersProvisioned()) {
    return {
      status: "skipped",
      reason: `browsers not provisioned at ${SMOKE_BROWSERS_PATH} — run: bun run install:browsers`,
      routes: [],
      ticketId,
    };
  }
  // repo-local browsers, never machine-global — set before importing playwright
  process.env.PLAYWRIGHT_BROWSERS_PATH = SMOKE_BROWSERS_PATH;
  let chromium: any;
  try {
    // @ts-ignore — playwright is an optional, opt-in dependency (see install:browsers);
    // absent in the default vendored copy, resolved at runtime when provisioned.
    const pw = await import("playwright");
    chromium = pw.chromium;
  } catch {
    return {
      status: "skipped",
      reason: "playwright not installed in .skua — run: bun run install:browsers",
      routes: [],
      ticketId,
    };
  }

  // ── allocate a free port + substitute {PORT} ──
  const forced = process.env.SKUA_SMOKE_PORT ? Number(process.env.SKUA_SMOKE_PORT) : null;
  const port = forced ?? (await allocPort(new Set(), { ...SMOKE_PORT_RANGE, randomStart: true }));
  if (port == null) {
    return { status: "error", reason: "no free port in smoke range", routes: [], ticketId };
  }
  const sub = (str: string): string => str.replaceAll("{PORT}", String(port));
  const startCmd = sub(cfg.start);
  const baseUrl = sub(cfg.url).replace(/\/+$/, "");
  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, sub(v)])),
    PORT: String(port),
    PLAYWRIGHT_BROWSERS_PATH: SMOKE_BROWSERS_PATH,
  };

  const artifactsDir = join(SMOKE_ARTIFACTS_DIR, ticketId ?? "adhoc");
  mkdirSync(artifactsDir, { recursive: true });

  // ── boot the target app ──
  const bootLog: string[] = [];
  const child = Bun.spawn(["sh", "-c", startCmd], {
    cwd: opts.cwd ?? appCwd(cfg),
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  drain(child.stdout as ReadableStream<Uint8Array>, bootLog);
  drain(child.stderr as ReadableStream<Uint8Array>, bootLog);
  const tail = (): string => bootLog.join("").slice(-2000);

  let browser: any = null;
  try {
    if (!(await waitForHttpReady(`${baseUrl}/`, cfg.bootTimeoutMs))) {
      return {
        status: "fail",
        reason: `app never became ready at ${baseUrl}/ within ${cfg.bootTimeoutMs}ms`,
        port,
        routes: [],
        bootLogTail: tail(),
        ticketId,
        artifactsDir,
      };
    }

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      viewport: cfg.viewport,
      reducedMotion: "reduce",
      colorScheme: "light",
    });

    const routes: RouteResult[] = [];
    for (const route of cfg.routes) {
      let result: RouteResult | null = null;
      for (let attempt = 0; attempt <= cfg.retriesPerRoute; attempt++) {
        result = await checkRoute(context, baseUrl, route, cfg, artifactsDir);
        if (result.pass) break;
      }
      routes.push(result as RouteResult);
    }

    const status: SmokeStatus = routes.every((r) => r.pass) ? "pass" : "fail";
    return {
      status,
      port,
      routes,
      bootLogTail: status === "pass" ? undefined : tail(),
      ticketId,
      artifactsDir,
    };
  } catch (e) {
    return {
      status: "error",
      reason: e instanceof Error ? e.message : String(e),
      port,
      routes: [],
      bootLogTail: tail(),
      ticketId,
      artifactsDir,
    };
  } finally {
    try {
      if (browser) await browser.close();
    } catch {
      /* noop */
    }
    killApp(child, port);
  }
}

async function checkRoute(
  context: any,
  baseUrl: string,
  route: string,
  cfg: SmokeConfig,
  artifactsDir: string,
): Promise<RouteResult> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const spinnerStuck: string[] = [];
  let blank = false;
  let readyMissing = false;
  const notes: string[] = [];

  const page = await context.newPage();
  page.on("console", (m: any) => {
    if (m.type() === "error") {
      const t = m.text();
      if (!cfg.consoleErrorAllowlist.some((p) => matchesAllow(t, p))) consoleErrors.push(t);
    }
  });
  page.on("pageerror", (e: any) => pageErrors.push(e?.message ?? String(e)));
  page.on("requestfailed", (r: any) => {
    const u = r.url();
    if (!cfg.requestFailedAllowlist.some((p) => matchesAllow(u, p))) {
      failedRequests.push(`${u} (${r.failure()?.errorText ?? "failed"})`);
    }
  });

  let screenshot: string | null = null;
  try {
    // networkidle can never settle on polling/websocket/SSE apps — tolerate a
    // timeout here and lean on the ready-signal / settle window instead.
    await page
      .goto(baseUrl + route, { waitUntil: "networkidle", timeout: cfg.navTimeoutMs })
      .catch(() => notes.push("networkidle did not settle"));

    // Disable animations/transitions POST-load (injecting at document-start via
    // addInitScript corrupts HTML parsing → empty body). With reducedMotion + the
    // settle window, this keeps the screenshot + spinner checks deterministic.
    await page
      .addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important}" })
      .catch(() => {});

    if (cfg.readySelector) {
      await page
        .waitForSelector(cfg.readySelector, { state: "visible", timeout: cfg.navTimeoutMs })
        .catch(() => {
          readyMissing = true;
          notes.push(`readySelector '${cfg.readySelector}' never appeared`);
        });
    } else {
      await page.waitForLoadState("load", { timeout: cfg.navTimeoutMs }).catch(() => {});
    }

    await sleep(cfg.settleMs);

    for (const sel of cfg.spinnerSelectors) {
      const loc = page.locator(sel);
      const n = await loc.count().catch(() => 0);
      if (n > 0 && (await loc.first().isVisible().catch(() => false))) spinnerStuck.push(sel);
    }

    blank = await page
      .evaluate(() => {
        const text = (document.body?.innerText ?? "").trim();
        const els = document.body ? document.body.querySelectorAll("*").length : 0;
        return text.length < 2 && els < 3;
      })
      .catch(() => false);

    screenshot = join(artifactsDir, `${routeSlug(route)}.png`);
    await page.screenshot({ path: screenshot, fullPage: false }).catch(() => {
      screenshot = null;
    });
  } finally {
    await page.close().catch(() => {});
  }

  const pass =
    consoleErrors.length === 0 &&
    pageErrors.length === 0 &&
    failedRequests.length === 0 &&
    spinnerStuck.length === 0 &&
    !blank &&
    !readyMissing;

  if (!pass) {
    notes.push(
      [
        consoleErrors.length && `${consoleErrors.length} console error(s)`,
        pageErrors.length && `${pageErrors.length} uncaught exception(s)`,
        failedRequests.length && `${failedRequests.length} failed request(s)`,
        spinnerStuck.length && "stuck spinner",
        blank && "blank page",
      ]
        .filter(Boolean)
        .join(", "),
    );
  }

  return {
    route,
    pass,
    consoleErrors,
    pageErrors,
    failedRequests,
    spinnerStuck,
    blank,
    screenshot,
    note: notes.filter(Boolean).join("; ") || "ok",
  };
}
