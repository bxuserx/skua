#!/usr/bin/env bash
# skua-vim-setup: terminal-safe editor setup for the skua terminal.
#
# Configures BOTH editors skua can open (see .skua/server.ts buildOpenCommand,
# which prefers nvim, then mvim, then vim):
#
#   NEOVIM — skua's DEFAULT editor. Writes ~/.config/nvim/init.lua: kickstart.nvim
#     (https://github.com/nvim-lua/kickstart.nvim) plus two skua additions — neo-tree
#     (file browser, <leader>e) and gitsigns hunk keymaps (]h / [h). Colorscheme is
#     kickstart's default tokyonight. Plugins install via the built-in vim.pack manager
#     on first launch (and eagerly here when nvim is present; needs nvim 0.12+).
#     Missing external CLIs kickstart shells out to — the tree-sitter CLI (parser
#     compile), ripgrep (Telescope live-grep), fd (Telescope find-files) — are
#     auto-installed via brew/cargo/npm. A hand-owned init.lua (one without our
#     marker) is left untouched.
#
#   VIM — the fallback. Ensures ~/.vimrc turns on syntax highlighting + the built-in
#     `evening` colorscheme (matches MacVim/mvim), and installs vim-signify into the
#     native pack start/ dir (auto-loaded) for git diff signs in the gutter,
#     configured terminal-safe (realtime OFF — see WHY below).
#
# WHY signify AUTO-loads (unlike the old gitgutter setup, which was opt/-only):
# the skua terminal has its scroll region disabled on purpose to stop vim redraw
# artifacts, so anything driving continuous redraws re-corrupts it. vim-signify
# with `g:signify_realtime = 0` recomputes signs ONLY on write/BufEnter — no
# as-you-type churn — so it is terminal-safe to auto-load. (gitgutter's low
# `updatetime` refresh was the churn source that forced it off-by-default.)
#
# Safe to re-run. Skips cleanly when an editor is absent. Downloads plugins from
# GitHub on first run only (network op).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# kickstart pins nvim-treesitter to its `main` branch, which compiles parsers by
# shelling out to the `tree-sitter` CLI (`tree-sitter build`). Without the CLI,
# parser builds fail and nvim falls back to Vim's built-in syntax highlighting.
# Install it if missing so highlighting works out of the box. Non-fatal.
# NOTE: Homebrew's `tree-sitter` formula is the LIBRARY only; the CLI is the
# separate `tree-sitter-cli` formula (also on cargo/npm as `tree-sitter-cli`).
ensure_tree_sitter_cli() {
  if command -v tree-sitter >/dev/null 2>&1; then
    echo "skua-vim-setup: tree-sitter CLI already present (skip)."
    return 0
  fi
  echo "skua-vim-setup: tree-sitter CLI missing — needed to compile nvim-treesitter parsers."
  if command -v brew >/dev/null 2>&1; then
    echo "skua-vim-setup: installing tree-sitter-cli via Homebrew…"
    brew install tree-sitter-cli >/dev/null 2>&1 \
      && echo "skua-vim-setup: tree-sitter CLI installed." \
      || echo "skua-vim-setup: 'brew install tree-sitter-cli' failed — install it manually."
  elif command -v cargo >/dev/null 2>&1; then
    echo "skua-vim-setup: installing tree-sitter-cli via cargo…"
    cargo install tree-sitter-cli >/dev/null 2>&1 \
      && echo "skua-vim-setup: tree-sitter CLI installed." \
      || echo "skua-vim-setup: 'cargo install tree-sitter-cli' failed — install it manually."
  elif command -v npm >/dev/null 2>&1; then
    echo "skua-vim-setup: installing tree-sitter-cli via npm…"
    npm install -g tree-sitter-cli >/dev/null 2>&1 \
      && echo "skua-vim-setup: tree-sitter CLI installed." \
      || echo "skua-vim-setup: 'npm install -g tree-sitter-cli' failed — install it manually."
  else
    echo "skua-vim-setup: no brew/cargo/npm found — install the tree-sitter CLI manually"
    echo "                 ('brew install tree-sitter-cli' or 'cargo install tree-sitter-cli')."
  fi
}

# kickstart's Telescope needs external CLIs: ripgrep (`rg`) for live_grep/grep — a
# HARD requirement (live_grep errors without it) — and fd for fast find_files
# (optional; find_files falls back without it). Install missing ones so the pickers
# work out of the box. Non-fatal.
#   $1 = binary to probe, $2 = brew formula, $3 = cargo crate (or "")
ensure_cli_tool() {
  local cmd="$1" brew_pkg="$2" cargo_pkg="${3:-}"
  if command -v "$cmd" >/dev/null 2>&1; then
    echo "skua-vim-setup: '$cmd' already present (skip)."
    return 0
  fi
  echo "skua-vim-setup: '$cmd' missing — used by kickstart's Telescope pickers."
  if command -v brew >/dev/null 2>&1; then
    echo "skua-vim-setup: installing $brew_pkg via Homebrew…"
    brew install "$brew_pkg" >/dev/null 2>&1 \
      && echo "skua-vim-setup: '$cmd' installed." \
      || echo "skua-vim-setup: 'brew install $brew_pkg' failed — install '$cmd' manually."
  elif [ -n "$cargo_pkg" ] && command -v cargo >/dev/null 2>&1; then
    echo "skua-vim-setup: installing $cargo_pkg via cargo…"
    cargo install "$cargo_pkg" >/dev/null 2>&1 \
      && echo "skua-vim-setup: '$cmd' installed." \
      || echo "skua-vim-setup: 'cargo install $cargo_pkg' failed — install '$cmd' manually."
  else
    echo "skua-vim-setup: no brew/cargo found — install '$cmd' manually ('brew install $brew_pkg')."
  fi
}

# ============================ NEOVIM (skua default) =========================
setup_nvim() {
  if ! command -v nvim >/dev/null 2>&1; then
    echo "skua-vim-setup: nvim not found on PATH — skipping neovim setup."
    echo "                 install neovim (e.g. 'brew install neovim'), then re-run."
    return 0
  fi
  local template="${SCRIPT_DIR}/nvim/init.lua"
  local init="${HOME}/.config/nvim/init.lua"
  local marker="skua-vim-setup: managed neovim config"

  if [ ! -f "${template}" ]; then
    echo "skua-vim-setup: nvim template missing at ${template} (skip)."
    return 0
  fi
  # Never clobber a hand-owned init.lua (one WITHOUT our marker).
  if [ -f "${init}" ] && ! grep -qF "${marker}" "${init}"; then
    echo "skua-vim-setup: ~/.config/nvim/init.lua exists and is hand-owned (skip)."
    echo "                 to let skua manage it, remove it first, then re-run."
    return 0
  fi
  mkdir -p "$(dirname "${init}")"
  cp "${template}" "${init}"
  echo "skua-vim-setup: wrote managed neovim config -> ${init}"

  # Ensure the external CLIs kickstart shells out to are present: the tree-sitter
  # CLI (parser compile), ripgrep (Telescope live_grep — hard req), fd (find_files).
  ensure_tree_sitter_cli
  ensure_cli_tool rg ripgrep ripgrep
  ensure_cli_tool fd fd fd-find

  # Eagerly install plugins so the first real launch is instant (network op;
  # vim.pack clones them synchronously at startup, so one headless launch is
  # enough; otherwise they install on the first real `nvim`). Non-fatal.
  echo "skua-vim-setup: installing neovim plugins (kickstart + neo-tree + gitsigns)…"
  if nvim --headless "+qa" >/dev/null 2>&1; then
    echo "skua-vim-setup: neovim plugins installed."
  else
    echo "skua-vim-setup: plugin pre-install skipped — vim.pack will install them on first launch."
  fi
}

# ============================ VIM (fallback) =================================
setup_vim() {
  if ! command -v vim >/dev/null 2>&1; then
    echo "skua-vim-setup: vim not found on PATH — skipping vim setup."
    return 0
  fi
  local PLUGIN_DIR="${HOME}/.vim/pack/mhinz/start/vim-signify"
  local VIMRC="${HOME}/.vimrc"
  local MARK_BEGIN="\" >>> skua-vim-setup >>>"
  local MARK_END="\" <<< skua-vim-setup <<<"

  # 1. vim-signify into start/ (auto-loaded). Idempotent: clone only if absent.
  if [ -d "${PLUGIN_DIR}/.git" ] || [ -d "${PLUGIN_DIR}/plugin" ]; then
    echo "skua-vim-setup: vim-signify already present at ${PLUGIN_DIR} (skip)."
  else
    echo "skua-vim-setup: installing vim-signify -> ${PLUGIN_DIR} (start/, auto-loaded)"
    mkdir -p "$(dirname "${PLUGIN_DIR}")"
    git clone --depth 1 https://github.com/mhinz/vim-signify.git "${PLUGIN_DIR}"
  fi
  vim -u NONE -es -c "helptags ${PLUGIN_DIR}/doc" -c q >/dev/null 2>&1 || true

  # 2. ~/.vimrc: colors + terminal-safe signify config.
  #    - If signify is already configured OUTSIDE our markers (hand-rolled), leave
  #      it alone — the user owns that block.
  #    - Otherwise strip any stale managed block and append a fresh one (self-migrating).
  if [ -f "${VIMRC}" ] && grep -q "signify_realtime" "${VIMRC}" && ! grep -qF "${MARK_BEGIN}" "${VIMRC}"; then
    echo "skua-vim-setup: ~/.vimrc already has hand-written signify config (skip)."
  else
    if [ -f "${VIMRC}" ] && grep -qF "${MARK_BEGIN}" "${VIMRC}"; then
      local tmp; tmp="$(mktemp)"
      sed '/>>> skua-vim-setup >>>/,/<<< skua-vim-setup <<</d' "${VIMRC}" > "${tmp}" && mv "${tmp}" "${VIMRC}"
      echo "skua-vim-setup: refreshed existing managed block in ${VIMRC}"
    else
      echo "skua-vim-setup: appending managed block to ${VIMRC}"
    fi
    {
      printf '\n%s\n' "${MARK_BEGIN}"
      printf '%s\n' "\" Colors: match mvim (both built-in, no download)."
      printf 'syntax on\n'
      printf 'colorscheme evening\n'
      printf '%s\n' "\" vim-signify: git diff signs in the gutter. Auto-loaded from pack start/."
      printf '%s\n' "\" realtime OFF: signs refresh on write/BufEnter only — no as-you-type"
      printf '%s\n' "\" churn in the skua browser terminal (kept from the tmux-era fix)."
      printf 'set signcolumn=yes\n'
      printf 'let g:signify_realtime = 0\n'
      printf "let g:signify_vcs_list = ['git']\n"
      printf '%s\n' "${MARK_END}"
    } >> "${VIMRC}"
  fi
}

setup_nvim
setup_vim
echo "skua-vim-setup: done. nvim is skua's default editor (kickstart + neo-tree + gitsigns); vim is the fallback."
