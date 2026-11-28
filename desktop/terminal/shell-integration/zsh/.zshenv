# Restore the account's startup directory before loading its real .zshenv.
# zsh itself will source the remaining login, interactive and logout files.
if (( ${+BRCLIO_ORIGINAL_ZDOTDIR} )); then
  export ZDOTDIR="$BRCLIO_ORIGINAL_ZDOTDIR"
  unset BRCLIO_ORIGINAL_ZDOTDIR
else
  unset ZDOTDIR
fi
if [[ -r "${ZDOTDIR-$HOME}/.zshenv" && ! "${ZDOTDIR-$HOME}/.zshenv" -ef "${(%):-%x}" ]]; then
  builtin source "${ZDOTDIR-$HOME}/.zshenv"
fi

if [[ -o interactive ]]; then
  function __brclio_before_command() {
    typeset -g __brclio_command_running=1
    builtin printf '\033]133;C\a'
  }
  function __brclio_before_prompt() {
    local previous_status=$?
    if [[ -n ${__brclio_command_running-} ]]; then
      builtin printf '\033]133;D;%d\a' "$previous_status"
      unset __brclio_command_running
    fi
    builtin printf '\033]133;A\a'
    local end_marker=$'%{\033]133;B\a%}'
    [[ $PROMPT == *"$end_marker" ]] || PROMPT+="$end_marker"
  }
  typeset -ga precmd_functions preexec_functions
  precmd_functions+=(__brclio_before_prompt)
  preexec_functions+=(__brclio_before_command)
fi
