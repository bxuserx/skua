# skua-cmd-hook.sh — record the last command run in a skua terminal.
#
# Sourced ONCE at shell start via the per-session ZDOTDIR rc lib/terminals.ts generates. On each
# command it writes the command line to $SKUA_LIVE_DIR/$SKUA_TERM_ID.cmd, which
# the dashboard reads to label the terminal tab with the last command instead of
# the directory. Inert (and returns cleanly) unless the skua env vars are set, so
# sourcing it in a non-skua shell is a no-op. Registered additively (add-zsh-hook
# / DEBUG trap) so it never clobbers the user's own preexec hooks.

[ -n "$SKUA_TERM_ID" ] && [ -n "$SKUA_LIVE_DIR" ] || return 0 2>/dev/null || exit 0

__skua_record_cmd() {
  local line="$1"
  [ -n "${line// /}" ] || return 0
  mkdir -p "$SKUA_LIVE_DIR" 2>/dev/null
  printf '%s' "$line" > "$SKUA_LIVE_DIR/$SKUA_TERM_ID.cmd" 2>/dev/null
}

if [ -n "$ZSH_VERSION" ]; then
  autoload -Uz add-zsh-hook 2>/dev/null
  __skua_preexec() { __skua_record_cmd "$1"; }
  add-zsh-hook preexec __skua_preexec 2>/dev/null
elif [ -n "$BASH_VERSION" ]; then
  __skua_debug() {
    [ -n "$COMP_LINE" ] && return
    [ "$BASH_COMMAND" = "${PROMPT_COMMAND%%;*}" ] && return
    __skua_record_cmd "$BASH_COMMAND"
  }
  trap '__skua_debug' DEBUG
fi
