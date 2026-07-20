// Buffer-probe for the terminal-zellij branch: identical drive to probe2.mjs,
// ground truth = `zellij action dump-screen` (zellij's own grid).
import { chromium } from "/Users/bx/code/skua/app/.skua/node_modules/playwright/index.mjs";
import { execFileSync, } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";

const PORT = process.argv[2];
const ZJ_NAME = process.argv[3];
const URL = `http://127.0.0.1:${process.argv[4]}/terminal-xterm.html?port=${PORT}`;
const ENV = {
  ...process.env,
  ZELLIJ_SOCKET_DIR: process.argv[5],
  ZELLIJ_CONFIG_DIR: process.argv[6],
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dumpScreen() {
  const out = execFileSync("zellij", ["--session", ZJ_NAME, "action", "dump-screen"], { env: ENV, encoding: "utf8" });
  return out.split("\n").map((l) => l.replace(/\s+$/, ""));
}

async function xtermRows(page) {
  return page.evaluate(() => {
    const g = term;
    g.refresh(0, g.rows - 1);
    const b = g.buffer.active;
    const rows = [];
    for (let i = 0; i < g.rows; i++) {
      const line = b.getLine(b.baseY + i);
      rows.push(line ? line.translateToString(true).replace(/\s+$/, "") : "");
    }
    return rows;
  });
}

const diffGrids = (x, t) => {
  const n = Math.max(x.length, t.length);
  const out = [];
  for (let i = 0; i < n; i++) if ((x[i] ?? "") !== (t[i] ?? "")) out.push({ row: i, xterm: x[i] ?? "", zellij: t[i] ?? "" });
  return out;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
await page.goto(URL);
await sleep(2000);

await page.evaluate(() => {
  window.__w = [];
  const dec = new TextDecoder();
  const orig = term.write.bind(term);
  term.write = (data, cb) => { window.__w.push(typeof data === "string" ? data : dec.decode(data)); return orig(data, cb); };
});
const drainTee = () => page.evaluate(() => { const w = window.__w.join(""); window.__w = []; return w; });
const vis = (s) => s.replace(/\x1b/g, "\\E").replace(/\r/g, "\\r").replace(/\n/g, "\\n");

const results = {};

// ── ghost line after dd ──────────────────────────────────────────────────────
await page.keyboard.type("vim /tmp/skua-ghost.txt", { delay: 20 });
await page.keyboard.press("Enter");
await sleep(1500);
await page.keyboard.type("10G", { delay: 50 });
await sleep(400);
await drainTee();
await page.keyboard.type("dd", { delay: 50 });
await sleep(900);
{
  const bytes = await drainTee();
  const rows = await xtermRows(page);
  const zj = dumpScreen();
  const stale = rows.some((r) => r.includes("GHOSTLINE-10"));
  const line10 = rows[9] ?? "";
  results.ghostline = {
    pass: !stale && line10.includes("GHOSTLINE-11") && diffGrids(rows, zj).length === 0,
    row10: line10, stalePresent: stale, zellijRow10: zj[9] ?? "",
    gridDiffCount: diffGrids(rows, zj).length,
    bytes: { csiM: /\x1b\[\d*M/.test(bytes), csiS: /\x1b\[\d*S/.test(bytes), csiR: /\x1b\[\d+;\d+r/.test(bytes), len: bytes.length },
  };
}

// ── rapid scroll ─────────────────────────────────────────────────────────────
await page.keyboard.type(":q!", { delay: 30 });
await page.keyboard.press("Enter");
await sleep(500);
await page.keyboard.type("vim /tmp/skua-scroll.txt", { delay: 20 });
await page.keyboard.press("Enter");
await sleep(1500);
await page.keyboard.type("G", { delay: 30 });
await sleep(300);
await page.keyboard.type("gg", { delay: 30 });
await sleep(300);
await drainTee();
for (let i = 0; i < 6; i++) { await page.keyboard.press("Control+d"); await sleep(60); }
await sleep(1200);
{
  const bytes = await drainTee();
  const rows = await xtermRows(page);
  const zj = dumpScreen();
  const blanks = rows.slice(0, rows.length - 2).filter((r) => r === "").length;
  const content = rows.filter((r) => /SCROLL-\d+/.test(r));
  const nums = content.map((r) => parseInt(r.match(/SCROLL-(\d+)/)[1], 10));
  const contiguous = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
  const d = diffGrids(rows, zj);
  results.rapidScroll = {
    pass: blanks === 0 && contiguous && d.length === 0,
    blankRows: blanks, contiguous, firstContent: content[0] ?? null, lastContent: content.at(-1) ?? null,
    gridDiffCount: d.length, sampleDiffs: d.slice(0, 4), bytesLen: bytes.length,
  };
}

// ── resize with vim open ─────────────────────────────────────────────────────
await page.setViewportSize({ width: 760, height: 520 });
await sleep(1000);
await page.setViewportSize({ width: 1100, height: 720 });
await sleep(1200);
{
  const rows = await xtermRows(page);
  const zj = dumpScreen();
  const d = diffGrids(rows, zj);
  results.resize = { pass: d.length === 0, gridDiffCount: d.length, sampleDiffs: d.slice(0, 4) };
}

// ── hard reload → reattach re-emits the screen ───────────────────────────────
await page.keyboard.type(":q!", { delay: 30 });
await page.keyboard.press("Enter");
await sleep(500);
await page.keyboard.type("echo SKUA-RELOAD-MARKER-77", { delay: 15 });
await page.keyboard.press("Enter");
await sleep(600);
await page.reload();
await sleep(2200);
{
  const rows = await xtermRows(page);
  results.reloadReattach = {
    pass: rows.some((r) => r.trim() === "SKUA-RELOAD-MARKER-77"),
    tail: rows.filter((r) => r !== "").slice(-6),
  };
}

console.log(JSON.stringify(results, null, 2));
await browser.close();
