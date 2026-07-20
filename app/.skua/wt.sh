#!/usr/bin/env bash
# skua · wt — isolated Claude Code sessions via git worktrees.
#
# Multiple `claude` terminals editing the same folder can silently clobber each
# other: Claude Code has NO cross-session file lock. A git worktree gives every
# session its own checkout + branch, so parallel edits never collide — you merge
# them back through git like any other branch.
#
# Install (once): add this line to ~/.zshrc or ~/.bashrc, then restart your shell
#
#     source "/abs/path/to/your-repo/.skua/wt.sh"
#
# `wt` resolves the repo from your current directory, so a single source line
# works across every skua-enabled repo on your machine.
#
# Usage:
#     wt <name>      create or reuse a worktree on branch wt/<name>, open claude
#     wt ls          list this repo's worktrees
#     wt rm <name>   remove the worktree for <name> (its branch is kept)
#
# Worktrees live in a sibling dir — <repo>-worktrees/<name> — so they stay out of
# the main checkout (and out of skua's graph/dashboard scans).

wt() {
  local repo
  repo="$(git rev-parse --show-toplevel 2>/dev/null)" \
    || { echo "wt: not inside a git repository" >&2; return 1; }

  local cmd="${1:-}"
  [ "$#" -gt 0 ] && shift

  case "$cmd" in
    ""|-h|--help|help)
      printf '%s\n' \
        "wt — isolated Claude Code sessions via git worktrees" \
        "  wt <name>     open an isolated worktree + branch (wt/<name>) and launch claude" \
        "  wt ls         list this repo's worktrees" \
        "  wt rm <name>  remove a worktree (keeps its branch)"
      return 0 ;;
    ls|list)
      git -C "$repo" worktree list
      return 0 ;;
    rm|remove)
      local name="${1:-}"
      [ -n "$name" ] || { echo "wt: usage: wt rm <name>" >&2; return 1; }
      git -C "$repo" worktree remove "${repo}-worktrees/${name}" \
        && echo "wt: removed ${repo}-worktrees/${name} (branch wt/${name} kept)"
      return $? ;;
  esac

  # default: treat cmd as the worktree name
  local name="$cmd"
  local branch="wt/${name}"
  local path="${repo}-worktrees/${name}"

  if [ ! -d "$path" ]; then
    if git -C "$repo" show-ref --quiet --verify "refs/heads/${branch}"; then
      git -C "$repo" worktree add "$path" "$branch" || return 1
    else
      git -C "$repo" worktree add -b "$branch" "$path" || return 1
    fi
    # seed heavy, gitignored deps (node_modules) so the dashboard runs immediately
    local nm rel
    while IFS= read -r nm; do
      rel="${nm#"$repo"/}"
      mkdir -p "$(dirname "$path/$rel")"
      ln -snf "$nm" "$path/$rel"
    done < <(find "$repo" -maxdepth 3 -type d -name node_modules -prune 2>/dev/null)
    echo "wt: created $path on branch $branch"
  else
    echo "wt: reusing $path"
  fi

  ( cd "$path" && claude )
}
