// Upgrade-safe install of skua's .claude payload (skills, hooks, commands) into a
// target repo. Unlike a blind `rsync -a`, this records the SHA-256 of every file skua
// writes in `.skua/install-manifest.json`, then uses that provenance to tell skua's
// own stale copy apart from a customization the user made by hand:
//
//   not present in target          -> install
//   identical to incoming          -> up-to-date (no-op, but record provenance)
//   matches last-installed hash     -> user never touched it -> update in place
//   diverged from last-installed    -> user customized it -> NEVER overwrite; stage the
//                                      incoming copy as <file>.skua-incoming and report
//   present but untracked           -> pre-existing (hand-authored, or installed before
//                                      skua) -> treat as customized: stage + report
//
// The manifest is the safety net the installer is supposed to provide itself, instead of
// relying on the user having committed .claude/ to git first.
//
//   bun install-payload.ts <skuaDir> <targetDir>

import { createHash } from "node:crypto";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { join, dirname, relative } from "node:path";

const [skuaDir, targetDir] = process.argv.slice(2);
if (!skuaDir || !targetDir) {
  console.error("usage: bun install-payload.ts <skuaDir> <targetDir>");
  process.exit(2);
}

// source subtree (in the skua repo) -> target subtree (relative to the target repo root)
const ROOTS: [string, string][] = [
  ["skills", ".claude/skills"],
  ["hooks", ".claude/hooks"],
  ["commands", ".claude/commands"],
];

const MANIFEST_REL = ".skua/install-manifest.json";

function sha256(path: string): string {
  return "sha256:" + createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

// A resolved conflict (or a now-clean file) shouldn't keep a stale .skua-incoming around.
function cleanIncoming(p: string): void {
  try {
    if (existsSync(p)) rmSync(p);
  } catch {
    /* best-effort */
  }
}

type Manifest = { version: number; files: Record<string, string> };

const manifestPath = join(targetDir, MANIFEST_REL);
let manifest: Manifest = { version: 1, files: {} };
if (existsSync(manifestPath)) {
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    /* corrupt -> rebuild from scratch */
  }
  manifest.files ??= {};
}

const installed: string[] = [];
const updated: string[] = [];
const upToDate: string[] = [];
const conflicts: string[] = [];

for (const [srcSub, dstSub] of ROOTS) {
  const srcRoot = join(skuaDir, srcSub);
  if (!existsSync(srcRoot)) continue;

  for (const srcFile of walk(srcRoot)) {
    const relTarget = join(dstSub, relative(srcRoot, srcFile)); // .claude/skills/ticket-manager/SKILL.md
    const dst = join(targetDir, relTarget);
    const incomingPath = dst + ".skua-incoming";
    const incomingHash = sha256(srcFile);

    // 1. brand new -> install
    if (!existsSync(dst)) {
      mkdirSync(dirname(dst), { recursive: true });
      writeFileSync(dst, readFileSync(srcFile));
      manifest.files[relTarget] = incomingHash;
      cleanIncoming(incomingPath);
      installed.push(relTarget);
      continue;
    }

    const currentHash = sha256(dst);

    // 2. already identical -> no-op, but record provenance so future updates flow cleanly
    if (currentHash === incomingHash) {
      manifest.files[relTarget] = incomingHash;
      cleanIncoming(incomingPath);
      upToDate.push(relTarget);
      continue;
    }

    // 3. unchanged since skua last wrote it -> safe to push skua's new version
    const known = manifest.files[relTarget];
    if (known && known === currentHash) {
      writeFileSync(dst, readFileSync(srcFile));
      manifest.files[relTarget] = incomingHash;
      cleanIncoming(incomingPath);
      updated.push(relTarget);
      continue;
    }

    // 4. customized (diverged, or never tracked by skua) -> keep theirs, stage ours
    writeFileSync(incomingPath, readFileSync(srcFile));
    conflicts.push(relTarget);
  }
}

mkdirSync(dirname(manifestPath), { recursive: true });
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

// ── report ───────────────────────────────────────────────────────────────────
console.log(
  `→ payload: ${installed.length} installed, ${updated.length} updated, ` +
    `${upToDate.length} up-to-date, ${conflicts.length} kept (your customizations)`,
);
if (conflicts.length) {
  console.log("⚠ kept YOUR versions of these — skua's copy is staged alongside, not applied:");
  for (const rel of conflicts) console.log(`    ${rel}  (vs ${rel}.skua-incoming)`);
  console.log("  review a conflict with:  diff <file> <file>.skua-incoming");
  console.log("  (a future skua-reconcile skill will merge these semantically; nothing was overwritten.)");
}
