#!/usr/bin/env node
// chaos mode — PreToolUse safety guard.
//
// While a chaos run is active (the `.chaos-active` flag exists), this denies, at
// the tool boundary, the classes of action a fully-autonomous agent must never
// take in someone else's repo:
//
//   1. Irreversible git-history / data / infra destruction (force-push, push to
//      the default branch, branch deletion, `reset --hard`, drop database,
//      terraform destroy, kubectl delete) — the wiped-DB / rewritten-history
//      failure mode autonomous agents are known for.
//   2. Machine- or account-GLOBAL mutations. Chaos is REPO-SCOPED: dependencies
//      live in the worktree's node_modules, and Claude config (skills, plugins,
//      MCP servers, settings) belongs to the repo's committed `.claude/`, never
//      the user's `~/.claude` or the machine. So this blocks global package
//      installs (`npm i -g`, `brew install`, …), Claude account mutations
//      (`claude plugin/mcp/config`, writes into `~/.claude`), and any file write
//      whose target escapes the worktree / repo.
//
// Layering: the per-child `--disallowedTools` the supervisor passes is the
// ALWAYS-ON layer (a git worktree may not carry `.claude/`, and this hook with
// it). The supervisor also injects this guard into the worker via `--settings`
// so the regex checks below — which catch the `-g` / `--global` / abbreviated
// variants that prefix-matched `--disallowedTools` rules miss — actually run.
//
// Wired as a PreToolUse hook (Bash + file-write tools). Inert unless chaos active.

const fs = require("fs");
const os = require("os");
const path = require("path");

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function chaosActive() {
  return fs.existsSync(path.join(claudeDir(), ".chaos-active"));
}

// ── Bash denies. [pattern, reason], matched against the command string. ─────────
const BASH_DENY = [
  // irreversible git history / data / infra
  [/\bgit\s+push\b[^\n]*(--force\b|--force-with-lease\b|(?:^|\s)-f\b)/, "force-push rewrites shared history"],
  [/\bgit\s+push\b[^\n]*\b(origin\s+)?(main|master|HEAD)\b/, "chaos never pushes the default branch — it works on chaos/* branches only"],
  [/\bgit\s+push\b[^\n]*(--delete\b|\s:\S)/, "deleting a remote branch is irreversible"],
  [/\bgit\s+branch\b[^\n]*\s-(D|d)\b/, "deleting a branch is irreversible"],
  [/\bgit\s+reset\b[^\n]*--hard\b/, "git reset --hard discards work irreversibly"],
  [/\bgit\s+(checkout|switch)\b[^\n]*\b(main|master)\b/, "chaos must not switch onto the default branch"],
  [/\b(drop\s+database|dropdb\b|drop\s+table|truncate\s+table)\b/i, "destructive database operation"],
  [/\bterraform\s+destroy\b/i, "terraform destroy tears down infrastructure"],
  [/\bkubectl\s+delete\b/i, "kubectl delete removes live resources"],

  // machine-global package installs — chaos keeps deps in the worktree's node_modules
  [/\bnpm\s+(i|in|install|add)\b[^\n]*\s-(-global\b|g\b)/, "global npm install — keep deps repo-local (worktree node_modules)"],
  [/\bpnpm\s+(i|install|add)\b[^\n]*\s-(-global\b|g\b)/, "global pnpm install — keep deps repo-local"],
  [/\bbun\s+(a|add|i|install)\b[^\n]*\s-(-global\b|g\b)/, "global bun install — keep deps repo-local"],
  [/\bnpm\s+link\b/, "npm link writes a global symlink"],
  [/\byarn\s+global\b/, "yarn global mutates the machine"],
  [/\b(brew|port)\s+(install|reinstall|upgrade|tap)\b/i, "Homebrew/MacPorts mutate the machine"],
  [/\b(apt|apt-get|yum|dnf|pacman|apk|zypper)\s+(install|add|upgrade)\b/i, "a system package install mutates the machine"],
  [/\bpipx\s+install\b/i, "pipx installs a global tool"],
  [/\bpip3?\s+install\b[^\n]*\s--user\b/i, "pip --user installs outside the repo"],
  [/\b(gem\s+install|cargo\s+install|go\s+install)\b/i, "this installs a global binary outside the repo"],

  // the user's global Claude account/config (plugins, skills, MCP, settings)
  [/\bclaude\s+(plugin|mcp|config)\b/i, "chaos must not mutate global Claude config (plugins/MCP/settings) — keep it in the repo's committed .claude/"],
  [/(>>?\s*|\b(?:tee|cp|mv|ln|install|rsync|sed)\b[^\n]*?\s)(?:~|\$\{?HOME\}?)?\/\.claude(?:\/|\b)/, "writing into ~/.claude is a global change — keep Claude config in the repo"],
];

// ── file-write tools: the target must stay inside the repo/worktree (or tmp). ───
// Allowed roots: the worktree (cwd), the root repo whose board chaos updates
// (SKUA_REPO_ROOT / SKUA_TICKETS_ROOT), the Claude project dir, and the OS temp
// dir. Anything else — above all the user's ~/.claude — is a global change.
function writeRoots() {
  const roots = [process.cwd()];
  for (const v of [
    process.env.SKUA_REPO_ROOT,
    process.env.SKUA_TICKETS_ROOT,
    process.env.CLAUDE_PROJECT_DIR,
  ]) {
    if (v) roots.push(v);
  }
  roots.push(os.tmpdir());
  return roots.map((r) => path.resolve(r));
}

function within(target, root) {
  return target === root || target.startsWith(root + path.sep);
}

// Returns a deny reason if the write must be blocked, else null.
function checkWritePath(rawPath) {
  if (!rawPath) return null; // nothing to check
  const target = path.resolve(process.cwd(), rawPath);
  if (within(target, path.resolve(claudeDir()))) {
    return "writing into the user's global ~/.claude is a global change — chaos keeps Claude config (skills/plugins/MCP/settings) in the repo's committed .claude/";
  }
  if (writeRoots().some((r) => within(target, r))) return null; // inside the repo / tmp — fine
  return `chaos is repo-scoped — this writes to ${target}, outside the worktree and repo`;
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: `chaos-guard: blocked — ${reason}. (Chaos is repo-scoped: deps go in the worktree, config in the repo's .claude/, and the supervisor owns commits/pushes.)`,
      },
    }),
  );
  process.exit(0);
}

// ── entry ───────────────────────────────────────────────────────────────────
let raw = "";
try {
  raw = fs.readFileSync(0, "utf8");
} catch {
  process.exit(0); // no input → nothing to guard
}

if (!chaosActive()) process.exit(0);

let data;
try {
  data = JSON.parse(raw);
} catch {
  process.exit(0);
}

const tool = data.tool_name || data.toolName || "";
const input = data.tool_input || data.toolInput || {};

if (tool === "Bash") {
  const cmd = String(input.command ?? "");
  for (const [re, reason] of BASH_DENY) {
    if (re.test(cmd)) deny(reason);
  }
} else if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") {
  const target = input.file_path ?? input.notebook_path ?? input.path ?? "";
  const reason = checkWritePath(String(target));
  if (reason) deny(reason);
}

process.exit(0);
