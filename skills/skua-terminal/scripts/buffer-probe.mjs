// Probe v2: same drive as probe-tmux.mjs, plus a term.write byte-tee.
// Usage: bun probe2.mjs <ttydPort> [tmuxSessionName]
// With a tmux name: diff vs capture-pane. Without: dtach control — assert expected content.
import { chromium } from "/Users/bx/code/skua/app/.skua/node_modules/playwright/index.mjs";
import { execFileSync } from "node:child_process";

const PORT = process.argv[2];
const TMUX_NAME = process.argv[3] || null;
const URL = `http://127.0.0.1:5175/terminal-xterm.html?port=${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const capturePane = () =>
  execFileSync("tmux", ["-L", "skua", "capture-pane", "-t", `=${TMUX_NAME}:`, "-p"], { encoding: "utf8" })
    .split("\n").map((l) => l.replace(/\s+$/, ""));

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

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
await page.goto(URL);
await sleep(1600);

// Tee everything the client writes into xterm from here on.
await page.evaluate(() => {
  window.__w = [];
  const dec = new TextDecoder();
  const orig = term.write.bind(term);
  term.write = (data, cb) => {
    window.__w.push(typeof data === "string" ? data : dec.decode(data));
    return orig(data, cb);
  };
});
const drainTee = () => page.evaluate(() => { const w = window.__w.join(""); window.__w = []; return w; });
const vis = (s) => s.replace(/\x1b/g, "\\E").replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\x07/g, "\\a");

const results = {};

// ── ghost line after dd ──────────────────────────────────────────────────────
await page.keyboard.type("vim /tmp/skua-ghost.txt", { delay: 20 });
await page.keyboard.press("Enter");
await sleep(1400);
await page.keyboard.type("10G", { delay: 50 });
await sleep(400);
await drainTee(); // discard bytes up to the dd
await page.keyboard.type("dd", { delay: 50 });
await sleep(900);
{
  const bytes = await drainTee();
  const rows = await xtermRows(page);
  const line10 = rows[9] ?? "";
  const stale = rows.filter((r) => r.includes("GHOSTLINE-10")).length > 0;
  // scroll-ish evidence in the arriving bytes: delete-line CSI M, scroll-up CSI S,
  // scroll region set CSI r, or a full repaint of the shifted rows.
  const evidence = {
    csiM: /\x1b\[\d*M/.test(bytes),
    csiS: /\x1b\[\d*S/.test(bytes),
    csiR: /\x1b\[\d+;\d+r/.test(bytes),
    len: bytes.length,
    tail: vis(bytes.slice(-400)),
  };
  const tmuxRow10 = TMUX_NAME ? (capturePane()[9] ?? "") : null;
  results.ghostline = {
    pass: !stale && line10.includes("GHOSTLINE-11"),
    row10: line10, stalePresent: stale, tmuxRow10, bytesAfterDd: evidence,
  };
}

// ── rapid scroll ─────────────────────────────────────────────────────────────
await page.keyboard.type(":q!", { delay: 30 });
await page.keyboard.press("Enter");
await sleep(500);
await page.keyboard.type("vim /tmp/skua-scroll.txt", { delay: 20 });
await page.keyboard.press("Enter");
await sleep(1400);
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
  const blanks = rows.slice(0, rows.length - 2).filter((r) => r === "").length;
  const content = rows.filter((r) => /SCROLL-\d+/.test(r));
  const nums = content.map((r) => parseInt(r.match(/SCROLL-(\d+)/)[1], 10));
  const contiguous = nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
  const gridDiffs = TMUX_NAME ? (() => { const t = capturePane(); return rows.map((r, i) => r !== (t[i] ?? "") ? i : -1).filter((i) => i >= 0); })() : null;
  results.rapidScroll = {
    pass: blanks === 0 && contiguous && (gridDiffs === null || gridDiffs.length === 0),
    blankRows: blanks, contiguous, firstContent: content[0] ?? null, lastContent: content.at(-1) ?? null,
    diffRowCount: gridDiffs ? gridDiffs.length : null, bytesLen: bytes.length,
  };
}
await page.keyboard.type(":q!", { delay: 30 });
await page.keyboard.press("Enter");
await sleep(400);

console.log(JSON.stringify(results, null, 2));
await browser.close();
