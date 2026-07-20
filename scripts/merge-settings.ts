// Idempotently merge skua's hook entries (and, only with --git-perms, its git
// permission allowlist) from settings.template.json into a target
// `.claude/settings.json`, creating it if absent.
//
// Two safety properties beyond a plain union merge:
//   • Hook double-fire guard — skua's hooks are namespaced (skua_*.ts). Before adding
//     one, we check whether the target already registers an equivalent hook (same basename
//     once a `skua_` prefix and extension are stripped). If you already run a `skill_reflect`
//     hook — even a `.py` one on a different runtime — skua defers to it instead of stacking
//     a second copy that fires on every turn.
//   • Permissions are OPT-IN — skua never silently widens your permission surface. The git
//     allowlist (commit / push / branch / worktree …) is merged only when --git-perms is
//     passed; otherwise we just print what it WOULD add.
//
//   bun merge-settings.ts <template.json> <target-settings.json> [--git-perms]

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const argv = process.argv.slice(2);
const withGitPerms = argv.includes("--git-perms");
const [tplPath, tgtPath] = argv.filter((a) => !a.startsWith("--"));
if (!tplPath || !tgtPath) {
  console.error("usage: bun merge-settings.ts <template.json> <target.json> [--git-perms]");
  process.exit(2);
}

const tpl = JSON.parse(readFileSync(tplPath, "utf8"));
const tgt: Record<string, any> = existsSync(tgtPath)
  ? JSON.parse(readFileSync(tgtPath, "utf8"))
  : {};

const sig = (h: unknown) => JSON.stringify(h);

// The identity of a hook entry, for collision detection: the basename(s) of any script it
// runs, stripped of directory, extension, and a leading `skua_`. So both
// `bun ".../skua_skill_reflect.ts"` and `uv run ".../skill_reflect.py"` reduce to
// `skill_reflect` and are recognized as the same hook.
function hookKeys(entry: any): string[] {
  const keys: string[] = [];
  for (const h of entry?.hooks ?? []) {
    const cmd = typeof h?.command === "string" ? h.command : "";
    for (const tok of cmd.match(/[\w.\-/$]+\.(?:ts|js|mjs|cjs|py|sh)\b/g) ?? []) {
      const base = tok
        .split("/")
        .pop()!
        .replace(/\.(?:ts|js|mjs|cjs|py|sh)$/, "")
        .replace(/^skua_/, "");
      keys.push(base);
    }
  }
  return keys;
}

tgt.hooks ??= {};
for (const [event, entries] of Object.entries(tpl.hooks ?? {})) {
  tgt.hooks[event] ??= [];
  const existing = tgt.hooks[event] as any[];
  const seenSig = new Set(existing.map(sig));
  const existingKeys = new Set(existing.flatMap(hookKeys));
  for (const entry of entries as any[]) {
    if (seenSig.has(sig(entry))) continue; // exact duplicate (re-run) — already there
    const clash = hookKeys(entry).find((k) => existingKeys.has(k));
    if (clash) {
      console.log(
        `⚠ ${event}: you already have a '${clash}' hook — leaving it; not adding skua's ` +
          `(would double-fire). Skua's is .claude/hooks/skua_${clash}.ts if you'd rather swap.`,
      );
      continue;
    }
    existing.push(entry);
    seenSig.add(sig(entry));
    for (const k of hookKeys(entry)) existingKeys.add(k);
  }
}

// permission rules: OPT-IN. Merge each bucket (allow / deny / ask) as a de-duplicated,
// order-preserving union only when the user asked for it; otherwise report and skip.
if (tpl.permissions) {
  if (withGitPerms) {
    tgt.permissions ??= {};
    for (const bucket of ["allow", "deny", "ask"]) {
      const incoming = tpl.permissions[bucket];
      if (!Array.isArray(incoming)) continue;
      tgt.permissions[bucket] ??= [];
      const have = new Set(tgt.permissions[bucket]);
      for (const rule of incoming) {
        if (!have.has(rule)) {
          tgt.permissions[bucket].push(rule);
          have.add(rule);
        }
      }
    }
    console.log("→ merged skua's git permission allowlist (--git-perms)");
  } else {
    const allow = tpl.permissions.allow ?? [];
    console.log(
      `ℹ did NOT add git permissions. Re-run with --git-perms to let parallel worktree ` +
        `sessions run git unprompted. It would add: ${allow.join(", ")}`,
    );
  }
}

if (tpl.$schema && !tgt.$schema) tgt.$schema = tpl.$schema;

writeFileSync(tgtPath, JSON.stringify(tgt, null, 2) + "\n");
console.log(`merged skua hooks${withGitPerms ? " + permissions" : ""} into ${tgtPath}`);
