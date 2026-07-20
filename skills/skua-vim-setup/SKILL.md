---
name: skua-vim-setup
description: "Idempotently sets up the terminal editors for the skua workflow. NEOVIM is skua's DEFAULT editor (.skua/server.ts click-to-open prefers nvim): writes a managed ~/.config/nvim/init.lua that is kickstart.nvim plus two skua additions — neo-tree (file browser, <leader>e) and gitsigns hunk keymaps (]h/[h); the default colorscheme is Aizen Dark (the skua terminal palette, generated via mini.base16; catppuccin/tokyonight also installed); plugins install via the built-in vim.pack manager on first launch (and eagerly during setup; needs nvim 0.12+). VIM is the fallback: ~/.vimrc gets syntax on + the built-in `evening` colorscheme (matches MacVim/mvim) and vim-signify auto-loaded from the native pack `start/` dir for a git diff gutter, configured `g:signify_realtime = 0` so signs refresh only on write/BufEnter — no as-you-type churn — keeping it safe for the skua terminal. Runs a bundled shell script; safe to re-run; skips each editor cleanly when its binary is absent; never clobbers a hand-owned init.lua. Downloads plugins from GitHub on first run only."
when_to_use: "User says 'set up vim/nvim for skua', 'install neovim for skua', 'set up the skua editor', 'make nvim the default editor', 'install vim-signify', 'make terminal vim/nvim show git hunks / a diff gutter', 'my diff gutter / signify isn't showing changes', 'why are there no colors in terminal vim', 'add a file browser / git signs / themes to nvim', or 'match mvim colors in plain vim'. Also invoked by the skua installer (setup.sh) on install of the skua repo into a project — headless via `claude -p \"/skua-vim-setup\"`, or by calling the bundled scripts/install.sh directly from setup."
connects_to: []
kind: action
---

# Skua Vim/Nvim Setup

Configures the terminal editors skua can open — in one idempotent step.

**Neovim is skua's default editor** (`.skua/server.ts:buildOpenCommand` opens a
clicked file with `nvim` when present, then `mvim`, then `vim`). The script writes
a managed `~/.config/nvim/init.lua` that is **kickstart.nvim**
(https://github.com/nvim-lua/kickstart.nvim) plus two skua additions — **neo-tree**
(file browser, `<leader>e`) and **gitsigns** hunk keymaps (`]h`/`[h`). Colorscheme
defaults to **Aizen Dark** — the same palette as the skua browser terminal (`terminal-schemes.js`), generated as a full colorscheme by **mini.base16** (catppuccin and kickstart's tokyonight are also installed). Plugins install via the built-in **vim.pack**
manager (needs nvim 0.12+) on first launch and eagerly during setup.

**Vim is the fallback:** a `~/.vimrc` block that turns on syntax highlighting and
the `evening` colorscheme (so terminal vim looks like MacVim/mvim), plus
vim-signify installed to the pack `start/` dir (auto-loaded) for git diff signs.

Produces a managed `~/.config/nvim/init.lua`, a modified `~/.vim/pack/...` and
`~/.vimrc`; prints what it changed vs skipped. Never clobbers a hand-owned
`init.lua` (one without the `skua-vim-setup: managed neovim config` marker).

**Hand-owned drift:** when you add a feature to the template `scripts/nvim/init.lua`,
a user whose live `~/.config/nvim/init.lua` is hand-owned (marker removed) will NOT
receive it — `install.sh` prints `exists and is hand-owned (skip)` and leaves the file
alone. Editing the template is not enough. Read their live config, confirm the feature's
plugin is present, then apply the delta **directly** to `~/.config/nvim/init.lua` as an
additive edit (never re-add the marker on their behalf — that silently re-arms clobber).

## Skua-terminal rendering note (read this)

The skua terminal is now ttyd → zellij → xterm.js, and its rendering is
probe-verified (see `skua-terminal`) — the tmux-era scroll-region hacks are
gone. The diff-gutter plugin here is still **vim-signify with
`g:signify_realtime = 0`**, kept as a deliberate low-churn default:

- signify recomputes signs **only on write/BufEnter**, not on every keystroke —
  no continuous redraw churn — so it is safe to **auto-load from `start/`**;
- historical context: under the old tmux-era terminal, as-you-type refresh
  (vim-gitgutter's low-`updatetime`) corrupted rendering outright, which is why
  gitgutter lived in `opt/`. That corruption class is gone; realtime stays off
  because signs-on-write is enough and cheaper.

Do **not** set `let g:signify_realtime = 1` and do **not** lower `updatetime`
for the skua terminal — either reintroduces the churn. Signs appearing only
after `:w` is expected and intended.

## When to invoke

- "set up the skua editor" / "set up nvim/vim for skua" / "make nvim the default editor" → run `scripts/install.sh`
- "add a file browser / git signs / themes to nvim" → run `scripts/install.sh`
- "why no colors in terminal vim" / "match mvim colors" → run `scripts/install.sh`
- "make terminal vim/nvim show git hunks / a diff gutter" → run `scripts/install.sh`
- "signify / the diff gutter isn't showing my changes" (vim) → run `scripts/install.sh` (it usually means the plugin was never installed — the `.vimrc` had signify config but no plugin in pack `start/`)
- skua installer → `setup.sh` calls `scripts/install.sh` directly, or `claude -p "/skua-vim-setup"`

## When NOT to invoke

- The skua *dashboard* terminal itself (ttyd/zellij/xterm.js render stack) — that's `skua-terminal`. This skill only touches the user's editor config (`~/.config/nvim`, `~/.vimrc`, the vim pack dir).
- Editing project code, or editor options unrelated to the file browser / git signs / colors.
- Changing which editor `.skua/server.ts` opens — that binary preference lives in `buildOpenCommand` (a `.skua` change, backported via `skua-sync`), not in this skill's install script.

## Procedure

The work is deterministic — delegate to the bundled script, don't hand-roll the steps.

1. **Run the installer** — `bash ${CLAUDE_SKILL_DIR}/scripts/install.sh`. It runs `setup_nvim` then `setup_vim`; idempotent and self-reporting; re-running is safe.
2. **What `setup_nvim` does** (skua's default editor) — if `nvim` is on PATH, copies the managed `scripts/nvim/init.lua` to `~/.config/nvim/init.lua` (kickstart.nvim + neo-tree + gitsigns hunk keymaps; Aizen Dark theme via mini.base16), auto-installs the external CLIs kickstart shells out to (`tree-sitter-cli` for parser compile, `ripgrep` for Telescope live-grep, `fd` for find-files; via brew/cargo/npm) if missing, then eagerly installs the plugins with `nvim --headless "+qa"` (vim.pack clones them at startup). A hand-owned `init.lua` (no `skua-vim-setup: managed neovim config` marker) is left untouched; a previously-managed one is refreshed.
3. **What `setup_vim` does** (fallback) — (a) clones `mhinz/vim-signify` into `~/.vim/pack/mhinz/start/vim-signify` only if absent (`start/` = auto-loaded), then rebuilds helptags; (b) writes a marker-delimited managed block to `~/.vimrc` with the colors fix (`syntax on`, `colorscheme evening`) **and** the terminal-safe signify config (`set signcolumn=yes`, `let g:signify_realtime = 0`, `let g:signify_vcs_list = ['git']`). Self-migrating: a stale block is stripped and re-appended. Hand-configured signify outside the markers is left untouched.
4. **First-run download** — cloning the nvim plugins via vim.pack (and vim-signify) is a network op (gated by `CLAUDE.md`). When invoked interactively, confirm before the first run. On second+ runs nothing new is downloaded. (kickstart's treesitter compiles parsers with the `tree-sitter` **CLI** — the *separate* `tree-sitter-cli` package, NOT Homebrew's lib-only `tree-sitter` formula — so `setup_nvim` auto-installs it via brew/cargo/npm when missing; with no package manager, parser builds skip and syntax falls back to Vim's built-in engine.)
5. **Report** — relay the script's skip/change lines. Tell the user: clicking a file in the skua terminal now opens **nvim** (file explorer **Space e**, git hunks `]h`/`[h`, Aizen Dark theme, search **Space s f** / **Space s g** — and press **Space** and pause for the which-key menu of every command; a quick-reference comment block is at the top of `init.lua`); vim (the fallback) matches mvim colors and shows signify signs after `:w`.

## Prerequisites

- `git` on PATH. `nvim` (0.9+) and/or `vim` (8.0+) — each editor's setup is skipped (exit 0, skip notice) when its binary is absent. The script does **not** install the editor binaries; if `nvim` is missing it prints an `install neovim` hint.
- Network access on the **first** run only (vim.pack clones the nvim plugins; the vim path clones vim-signify).
- **nvim 0.12+** for the neovim path — kickstart uses the built-in `vim.pack` manager, which older nvim lacks. The setup skips nvim cleanly on older versions.
- A package manager (**brew**, **cargo**, or **npm**) so `setup_nvim` can auto-install kickstart's external CLIs — `tree-sitter-cli` (parser compile), `ripgrep` (Telescope live-grep, a hard requirement), and `fd` (find-files). Without one, treesitter syntax falls back to Vim's built-in engine and Telescope's grep picker errors.

## Background

- **nvim is skua's default editor.** `.skua/server.ts:buildOpenCommand` (the terminal Search tab's click-to-open) resolves the editor as `nvim` → `mvim` → `vim`, probing `Bun.which` plus the usual Homebrew/local paths. The nvim config is a whole managed file (not a marker block inside a user file, the way `~/.vimrc` is), because `init.lua` is normally the entire config — so the marker is a single top comment line and "hand-owned" = that line absent.
- **nvim config**: the config is upstream **kickstart.nvim** copied verbatim (Telescope, LSP via mason, treesitter, blink.cmp, which-key, mini.nvim, tokyonight) with a few `-- skua:` additions in the file — a neo-tree file browser (`<leader>e` toggle, `\` reveal — the stock kickstart bind), gitsigns hunk keymaps (`]h`/`[h`, `<leader>gp`/`gb`/`gD`/`gd`), and the default colorscheme switched to Aizen Dark (the skua terminal palette, built by mini.base16 in the mini section — catppuccin fallback if mini is unavailable). To refresh from upstream, re-download `kickstart.nvim/init.lua`, re-apply the `-- skua:` blocks, keep the marker header. These render fine in the current skua terminal (ttyd→zellij→xterm.js — probe-verified; the tmux-era redraw corruption that forced vim's signify to `realtime=0` no longer sits in the render path).
- **Verifying an external CLI (`rg`/`fd`/`tree-sitter`) is REALLY installed** — check nvim's own `vim.fn.exepath('rg')` (or `type -P rg` in a clean shell), NOT the interactive shell's `command -v rg`. Claude Code's shell snapshot defines `rg` as a *function* that reroutes to the `claude` binary, so `command -v rg` reports it "present" even when no `rg` binary exists on PATH and Telescope's live_grep still errors. `install.sh` runs in a clean bash subprocess (no snapshot), so its `command -v` probes are fine; the trap is only when diagnosing by hand from a Claude Code shell.
- **nvim 0.12 ships popular themes as built-in colorschemes** (`catppuccin`, plus others in `$VIMRUNTIME/colors/`), so setting `colorscheme catppuccin` needs no plugin — it works on every 0.12 machine. `getcompletion('', 'color')` lists everything available.
- **`syntax on`** is the colors fix: MacVim's bundled gvimrc runs `syntax on` automatically, but terminal vim does not when a user `~/.vimrc` exists — so terminal vim looked colorless. `evening` is a built-in colorscheme (no download).
- **vim-signify** shows lines that differ from the git index as gutter signs — the "hunk"/diff view. It refreshes on write/BufEnter (never as-you-type, given `realtime = 0`), which is why it renders cleanly in the skua terminal where gitgutter did not.
- **Verifying it works** (headless): silent Ex mode suppresses signify's autocmds, so a bare `vim -es … sign place` shows nothing even when signify is fine. Instead force a compute and dump signs:
  `vim -N -u ~/.vimrc -c "silent! call sy#start()" -c "sleep 500m" -c "redir! > /tmp/sig.txt" -c "silent! sign place" -c "redir END" -c "qa!" <a-modified-tracked-file>` — expect `name=SignifyAdd/SignifyChange/SignifyDelete` lines.
- **Superseded gitgutter**: earlier versions of this skill installed vim-gitgutter to `opt/`. Signify replaces it. A leftover `~/.vim/pack/airblade/opt/vim-gitgutter` is inert (not auto-loaded) and harmless; remove it only if the user asks.

## References

- `${CLAUDE_SKILL_DIR}/scripts/install.sh` — the idempotent installer (`setup_nvim` + `setup_vim`). This is the single source of the install logic; do not duplicate its steps elsewhere.
- `${CLAUDE_SKILL_DIR}/scripts/nvim/init.lua` — the managed neovim config template copied to `~/.config/nvim/init.lua`. Edit the config here (keep the marker line first), not in the user's home.
- `.skua/server.ts:buildOpenCommand` — where the default-editor preference (`nvim` → `mvim` → `vim`) lives. Changing it is a `.skua` edit backported via `skua-sync`, not part of this skill.
