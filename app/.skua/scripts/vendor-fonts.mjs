// Vendor the Google Fonts the dashboard uses into public/vendor/fonts/ and
// emit a local public/styles/fonts.css. Latin + latin-ext only: the dashboard
// is code/ticket text, and the browser falls back per-glyph for other scripts.
//
// Both families are VARIABLE fonts — Google serves one woff2 per
// (family, subset) covering every weight — so faces are deduped by URL and
// declared with a `font-weight: <min> <max>` range rather than one file per
// weight (which downloaded the same bytes three times).
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const SRC = process.argv[2];               // gf.css from fonts.googleapis.com
const OUT_FONTS = process.argv[3];         // .../public/vendor/fonts
const OUT_CSS = process.argv[4];           // .../public/styles/fonts.css
const KEEP = new Set(["latin", "latin-ext"]);

rmSync(OUT_FONTS, { recursive: true, force: true });
mkdirSync(OUT_FONTS, { recursive: true });
const css = readFileSync(SRC, "utf8");

// Split on the subset comment that precedes each @font-face block.
const blocks = css.split(/\/\* (?=[a-z-]+ \*\/)/).slice(1);
const faces = new Map(); // url -> {family, subset, range, weights:Set}

for (const raw of blocks) {
  const subset = raw.slice(0, raw.indexOf(" *"));
  if (!KEEP.has(subset)) continue;
  const family = /font-family: '([^']+)'/.exec(raw)[1];
  const weight = Number(/font-weight: (\d+)/.exec(raw)[1]);
  const url = /src: url\(([^)]+)\)/.exec(raw)[1];
  const range = /unicode-range: ([^;]+);/.exec(raw)[1];

  const face = faces.get(url) ?? { family, subset, range, weights: new Set() };
  face.weights.add(weight);
  faces.set(url, face);
}

const out = [];
let bytes = 0;

for (const [url, f] of faces) {
  const slug = f.family.toLowerCase().replace(/\s+/g, "-");
  const file = `${slug}-${f.subset}.woff2`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // woff2 magic number 'wOF2' — guard against saving an error page.
  if (buf.subarray(0, 4).toString("latin1") !== "wOF2") {
    throw new Error(`${file}: not a woff2 (got ${buf.subarray(0, 16).toString("latin1")})`);
  }
  writeFileSync(join(OUT_FONTS, file), buf);
  bytes += buf.length;

  const w = [...f.weights].sort((a, b) => a - b);
  const weightDecl = w.length > 1 ? `${w[0]} ${w[w.length - 1]}` : `${w[0]}`;
  out.push(`/* ${f.subset} */
@font-face {
  font-family: '${f.family}';
  font-style: normal;
  font-weight: ${weightDecl};
  font-display: swap;
  src: url(/vendor/fonts/${file}) format('woff2');
  unicode-range: ${f.range};
}`);
  console.log(`${file.padEnd(32)} ${String(buf.length).padStart(7)} bytes  weights ${weightDecl}`);
}

const header = `/* Fira Code + JetBrains Mono, vendored from Google Fonts.
   Served from this origin so the CSP can stay \`default-src 'self'\`: the old
   @import from fonts.googleapis.com was blocked outright, silently dropping the
   whole dashboard to ui-monospace. Latin + latin-ext only — the browser falls
   back per-glyph for other scripts. Both families are variable fonts, so one
   file covers the 400-600 range each. Regenerate with scripts/vendor-fonts.mjs. */

`;
writeFileSync(OUT_CSS, header + out.join("\n\n") + "\n");
console.log(`\n${out.length} faces, ${(bytes / 1024).toFixed(0)} KB total -> ${OUT_CSS}`);
