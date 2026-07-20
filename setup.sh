#!/usr/bin/env bash
# skua setup — vendor the local ticket dashboard + Claude Code skills into a
# target repo, scaffold the board, build the codebase graphs, and (after asking)
# run a deep bug-scan that seeds the backlog with real findings from your code.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PORT=5174
PORT_SET=0
DO_SCAN=1
ASSUME_YES=0
DO_START=0
DO_GITPERMS=0
DO_BROWSERS=1
ASSUME_BROWSERS=0
DO_FIRESTORE=1
ASSUME_FIRESTORE=0
DO_EDITOR=1
TARGET=""

usage() {
  cat <<'EOF'
skua setup — install the skua ticket board + skills into a repo.

usage: bash setup.sh [TARGET_REPO] [options]

  TARGET_REPO   path to the repo to skua-enable (default: current directory)

options:
  --scan        run the deep bug-scan without prompting (non-interactive use)
  --no-scan     skip the bug-scan entirely, no prompt
                (default: ASK whether to run the deep bug-scan)
  --start       start the dashboard when setup finishes
  --port N      dashboard port (default: 5174)
  --git-perms   merge skua's git allowlist (commit/push/branch/worktree) into
                .claude/settings.json — off by default so setup never silently
                widens your permissions
  --smoke       provision a repo-local headless browser (Chromium) for smoke
                checks, without prompting
  --no-smoke    skip headless-browser provisioning entirely, no prompt
                (default: ASK when a "smoke" block exists in skua.config.json)
  --firestore   enable the Firestore ticket mirror (writes a firestore block,
                verifies your Google credentials, backfills the board) — no prompt
  --no-firestore  skip the Firestore mirror entirely, no prompt
                (default: ASK when a "firestore" block exists in skua.config.json)
  --no-editor   skip terminal-editor setup (writes nvim + vim config in your home)
                (default: set up nvim as skua's default editor + vim fallback —
                 file browser, git signs, themes; idempotent, non-clobbering)
  -h, --help    show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --no-scan)   DO_SCAN=0 ;;
    --scan)      ASSUME_YES=1 ;;
    --start)     DO_START=1 ;;
    --git-perms) DO_GITPERMS=1 ;;
    --smoke)     ASSUME_BROWSERS=1 ;;
    --no-smoke)  DO_BROWSERS=0 ;;
    --firestore) ASSUME_FIRESTORE=1 ;;
    --no-firestore) DO_FIRESTORE=0 ;;
    --no-editor) DO_EDITOR=0 ;;
    --port)    PORT="${2:?--port needs a value}"; PORT_SET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    -*)        echo "unknown option: $1" >&2; usage; exit 2 ;;
    *)         if [ -z "$TARGET" ]; then TARGET="$1"; else echo "unexpected arg: $1" >&2; exit 2; fi ;;
  esac
  shift
done

TARGET="${TARGET:-$PWD}"
TARGET="$(cd "$TARGET" 2>/dev/null && pwd || true)"
[ -n "$TARGET" ] || { echo "✗ target repo not found" >&2; exit 1; }

# ── preflight ────────────────────────────────────────────────────────────────
command -v bun >/dev/null 2>&1 || { echo "✗ bun is required — install from https://bun.sh" >&2; exit 1; }
command -v git >/dev/null 2>&1 || echo "⚠ git not found — skua works without it, but version control is recommended"
HAVE_CLAUDE=0; command -v claude >/dev/null 2>&1 && HAVE_CLAUDE=1

if [ "$TARGET" = "$SCRIPT_DIR" ]; then
  echo "✗ target is the skua repo itself — pass the path to the repo you want to skua-enable" >&2
  exit 1
fi

echo "→ skua setup"
echo "    skua:  $SCRIPT_DIR"
echo "    target: $TARGET"
echo "    port:   $PORT"

# ── 1. vendor the dashboard app ──────────────────────────────────────────────
echo "→ vendoring dashboard into $TARGET/.skua"
mkdir -p "$TARGET/.skua"
rsync -a --exclude 'cache' --exclude 'node_modules' "$SCRIPT_DIR/app/.skua/" "$TARGET/.skua/"

# ── 2. install skills + hooks, merge settings (upgrade-safe) ─────────────────
#    install-payload.ts records every file skua writes in .skua/install-manifest.json,
#    so a re-run can tell its own stale copy from YOUR customization: new files install,
#    untouched ones update, customized ones are KEPT (skua's copy staged as *.skua-incoming).
#    No blind overwrite, no reliance on you having committed .claude/ first.
echo "→ installing skills + hooks + commands into $TARGET/.claude (upgrade-safe)"
mkdir -p "$TARGET/.claude/skills" "$TARGET/.claude/hooks" "$TARGET/.claude/commands"
bun "$SCRIPT_DIR/scripts/install-payload.ts" "$SCRIPT_DIR" "$TARGET"
PERMS_FLAG=""
[ "$DO_GITPERMS" = 1 ] && PERMS_FLAG="--git-perms"
bun "$SCRIPT_DIR/scripts/merge-settings.ts" "$SCRIPT_DIR/settings.template.json" "$TARGET/.claude/settings.json" $PERMS_FLAG

# ── 2b. terminal editors (nvim = skua's default; vim fallback) ───────────────
#    skua's terminal opens clicked files in an editor (.skua/server.ts prefers
#    nvim, then mvim, then vim). Set that editor up: nvim with a file browser
#    (neo-tree), git signs (gitsigns) and themes (nord default + a switcher); vim
#    with signify + colors as the fallback. Idempotent and NON-clobbering — a
#    hand-owned ~/.config/nvim/init.lua or hand-written ~/.vimrc is left alone.
#    Writes to your HOME (per-user editor config), not the target repo. Plugins
#    download on first run (network); skip with --no-editor.
if [ "$DO_EDITOR" = 1 ]; then
  echo "→ setting up terminal editors (nvim default + vim fallback)"
  bash "$SCRIPT_DIR/skills/skua-vim-setup/scripts/install.sh" \
    || echo "  ⚠ editor setup hit an error — run later:  bash \"$SCRIPT_DIR/skills/skua-vim-setup/scripts/install.sh\""
else
  echo "→ editor setup skipped (--no-editor). Run later:  bash \"$SCRIPT_DIR/skills/skua-vim-setup/scripts/install.sh\""
fi

# ── 3. scaffold the .tickets board ───────────────────────────────────────────
echo "→ scaffolding .tickets board (9 buckets + ADRs)"
for b in scratch 0-backlog 1-staging 2-stuck 3-building 4-testing 5-validating 6-complete 7-archive ADRs chaos-runs; do
  mkdir -p "$TARGET/.tickets/$b"
  [ -e "$TARGET/.tickets/$b/.gitkeep" ] || : > "$TARGET/.tickets/$b/.gitkeep"
done

# ── 4. config + starter CLAUDE.md ────────────────────────────────────────────
if [ ! -e "$TARGET/skua.config.json" ]; then
  printf '{\n  "repoRoot": ".",\n  "ticketsRoot": ".tickets",\n  "port": %s\n}\n' "$PORT" > "$TARGET/skua.config.json"
  echo "→ wrote skua.config.json"
elif [ "$PORT_SET" = 1 ]; then
  echo "⚠ skua.config.json already exists — leaving it untouched; edit its \"port\" by hand to make --port $PORT stick for 'bun run start'"
fi
if [ ! -e "$TARGET/CLAUDE.md" ]; then
  cp "$SCRIPT_DIR/CLAUDE.template.md" "$TARGET/CLAUDE.md"
  echo "→ wrote CLAUDE.md (starter — customize it for your project)"
else
  echo "⚠ CLAUDE.md already exists — review $SCRIPT_DIR/CLAUDE.template.md for skua conventions to fold in"
fi

# ── 4b. keep machine-local skua cache out of git (graphs, smoke browsers) ────
if [ -e "$TARGET/.gitignore" ] && grep -qxF '.skua/cache/' "$TARGET/.gitignore"; then
  :
else
  printf '\n# skua machine-local cache (graphs, smoke browser binaries + screenshots)\n.skua/cache/\n' >> "$TARGET/.gitignore"
  echo "→ ensured .skua/cache/ is gitignored"
fi

# ── 5. build the dashboard graphs (deterministic — no Claude Code needed) ─────
echo "→ building dashboard graphs"
( cd "$TARGET/.skua" && bun run build:graphs ) \
  || echo "⚠ graph build hit an error — the dashboard will build graphs on demand instead"

# ── 5b. optional: provision a repo-local headless browser for smoke checks ────
#    Installs Chromium into .skua/cache/browsers (gitignored, repo-local — NEVER
#    ~/.cache/ms-playwright). OPT-IN: only when a "smoke" block exists in
#    skua.config.json (so CLI/library targets are never asked) or when --smoke
#    forces it. Setup-time only — never during a chaos run, where the repo-scoping
#    guard (correctly) blocks installs.
HAS_SMOKE=0
grep -q '"smoke"' "$TARGET/skua.config.json" 2>/dev/null && HAS_SMOKE=1
provision_browsers() {
  echo "  → provisioning headless Chromium into .skua/cache/browsers (repo-local)…"
  if ( cd "$TARGET/.skua" && bun run install:browsers ); then
    echo "  ✓ smoke browser provisioned"
  else
    echo "  ⚠ provisioning failed — run later:  (cd \"$TARGET/.skua\" && bun run install:browsers)"
  fi
}
if [ "$ASSUME_BROWSERS" = 1 ]; then
  provision_browsers
elif [ "$DO_BROWSERS" = 1 ] && [ "$HAS_SMOKE" = 1 ]; then
  if [ -t 0 ]; then
    printf "  Provision a repo-local headless browser for smoke checks? [y/N] "
    _bans=""; read -r _bans || true
    case "$_bans" in
      [yY]|[yY][eE][sS]) provision_browsers ;;
      *) echo "  ↳ skipped — run later:  (cd \"$TARGET/.skua\" && bun run install:browsers)" ;;
    esac
  else
    echo "  (non-interactive — skipping browser provisioning; re-run with --smoke, or: cd .skua && bun run install:browsers)"
  fi
fi

# ── 5c. optional: enable the Firestore ticket mirror ─────────────────────────
#    Reflects ticket status into a Firestore collection so the board can be
#    watched off-repo (a phone, a shared page, a cron report). Zero-dep: Firestore
#    REST + your local Application Default Credentials. OPT-IN: only when a
#    "firestore" block exists in skua.config.json, or when --firestore forces it
#    (init resolves the project from gcloud/ADC and writes the block). Credentials
#    are NEVER stored in git — they come from `gcloud auth application-default login`.
HAS_FIRESTORE=0
grep -q '"firestore"' "$TARGET/skua.config.json" 2>/dev/null && HAS_FIRESTORE=1
provision_firestore() {
  command -v gcloud >/dev/null 2>&1 || echo "  ⚠ gcloud not found — install the Google Cloud SDK, then: gcloud auth application-default login"
  echo "  → enabling Firestore mirror (writes config, verifies credentials, backfills)…"
  if ( cd "$TARGET" && bun .skua/scripts/firestore.ts init ); then
    echo "  ✓ firestore mirror enabled"
  else
    echo "  ⚠ firestore init did not complete — run later:  (cd \"$TARGET\" && bun .skua/scripts/firestore.ts init --project <gcp-id>)"
  fi
}
if [ "$ASSUME_FIRESTORE" = 1 ]; then
  provision_firestore
elif [ "$DO_FIRESTORE" = 1 ] && [ "$HAS_FIRESTORE" = 1 ]; then
  if [ -t 0 ]; then
    printf "  A \"firestore\" block exists — enable the Firestore ticket mirror now (verify creds + backfill)? [y/N] "
    _fans=""; read -r _fans || true
    case "$_fans" in
      [yY]|[yY][eE][sS]) provision_firestore ;;
      *) echo "  ↳ skipped — run later:  (cd \"$TARGET\" && bun .skua/scripts/firestore.ts init)" ;;
    esac
  else
    echo "  (non-interactive — skipping firestore enable; re-run with --firestore)"
  fi
fi

# ── 6. first-run bug-scan (seeds the backlog with REAL findings from your code) ──
#    The deep, multi-agent scan. OPTIONAL but recommended; it can take several
#    minutes and a meaningful number of Claude tokens — so we ASK first (unless
#    --scan / --no-scan force it) rather than silently running or skipping it.
#    (dataflow + schemas graphs are deterministic — already built in step 5.)
run_bug_scan() {
  echo "  → seeding the backlog: /bug-scan (deep multi-agent scan)…"
  if ( cd "$TARGET" && claude -p "/bug-scan" --permission-mode acceptEdits ); then
    echo "  ✓ bug-scan done — open the board to see the findings"
  else
    echo "  ⚠ headless /bug-scan didn't fully complete — run it interactively: open Claude Code in the repo and run /bug-scan"
  fi
}
if [ "$HAVE_CLAUDE" = 1 ] && [ "$DO_SCAN" = 1 ]; then
  cat <<'EOF'

──────────────────────────────────────────────────────────────────────
  Optional: seed your board with a DEEP BUG-SCAN
  skua can fan a multi-agent scan across your code, adversarially verify
  each finding, and file the real bugs as backlog tickets — so the board
  starts with genuine findings, not demo data.
    • Optional, but recommended for a useful first board.
    • Multi-agent: can take several minutes and uses Claude tokens.
    • Always available later in Claude Code:   /bug-scan
──────────────────────────────────────────────────────────────────────
EOF
  if [ "$ASSUME_YES" = 1 ]; then
    echo "  (--scan given — running without prompting)"
    run_bug_scan
  elif [ -t 0 ]; then
    printf "  Run the deep bug-scan now? [y/N] "
    _ans=""; read -r _ans || true
    case "$_ans" in
      [yY]|[yY][eE][sS]) run_bug_scan ;;
      *) echo "  ↳ skipped — run it anytime in Claude Code:  /bug-scan" ;;
    esac
  else
    echo "  (non-interactive shell — not prompting. Re-run with --scan, or use /bug-scan in Claude Code.)"
  fi
elif [ "$DO_SCAN" = 0 ]; then
  echo "→ bug-scan skipped (--no-scan). Run it anytime in Claude Code:  /bug-scan"
else
  echo "→ Claude Code not found — skipping bug-scan. Install Claude Code, then run /bug-scan in the repo to seed the backlog."
fi

# ── done ─────────────────────────────────────────────────────────────────────
cat <<EOF

✓ skua installed into $TARGET

  start the board:  cd "$TARGET/.skua" && bun run start
  then open:        http://127.0.0.1:$PORT

  parallel claude sessions (so concurrent terminals can't clobber each other):
    source "$TARGET/.skua/wt.sh"   # add this line to ~/.zshrc to keep it
    wt <name>                       # isolated worktree on branch wt/<name>, then claude
    wt ls / wt rm <name>            # list / remove worktrees
EOF
if [ "$DO_GITPERMS" = 1 ]; then
  echo "  (skua granted claude git push/branch/commit/worktree perms — see .claude/settings.json.)"
else
  echo "  (git perms NOT granted — re-run with --git-perms to let wt sessions push unprompted.)"
fi

cat <<'EOF'

  chaos mode — fully-autonomous ticket execution (Claude Max only):
    /chaos          arm a run (requires an explicit "arm chaos" confirm; --git-perms lets it push branches)
    /chaos status   inspect the active run    ·    /chaos stop   halt it
    /chaos-land     merge approved (6-complete) chaos branches to main
  The usage throttle reads your statusline — /chaos offers to wire the snapshot tee (reversible).
EOF

cat <<'EOF'

  smoke checks (web apps) — catch runtime/console errors that unit tests miss:
    1. add a "smoke" block to skua.config.json (start command, routes, readySelector)
    2. one-time, repo-local Chromium:   cd .skua && bun run install:browsers
  test-ticket then runs a headless smoke automatically for web targets; console
  errors land in the ticket's evidence. CLI/library repos: skip — it no-ops.
EOF

cat <<'EOF'

  firestore mirror (optional) — watch ticket status from OUTSIDE the repo:
    1. a Firestore DB (Native mode) + local creds:  gcloud auth application-default login
    2. enable:   bun .skua/scripts/firestore.ts init --project <gcp-project-id>
  Ticket status then syncs to Firestore live (real-time writes + a convergent
  reconcile); zero-dep (Firestore REST + your ADC). Not set up? It no-ops.
EOF
# (bug-scan prompt + messaging handled in step 6 above)

if [ "$DO_START" = 1 ]; then
  echo "→ starting dashboard…"
  exec bash -c "cd '$TARGET/.skua' && PORT='$PORT' bun run start"
fi
