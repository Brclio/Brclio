# Sourced by this login shell's PROMPT_COMMAND, with the previous command
# status as $1. A user profile can replace PROMPT_COMMAND as usual.
if [[ ${BRCLIO_UNEXPORT_PROMPT-} == 1 ]]; then
  export -n PROMPT_COMMAND
  unset BRCLIO_UNEXPORT_PROMPT
fi
if [[ -n ${__brclio_had_prompt-} && ${PS0-} == *$'\033]133;C\a' ]]; then
  builtin printf '\033]133;D;%d\a' "$1"
fi
__brclio_had_prompt=1
builtin printf '\033]133;A\a'
# PS0 is expanded immediately before execution on Bash 4.4 and later.
if (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
  [[ ${PS0-} == *$'\033]133;C\a' ]] || PS0+=$'\033]133;C\a'
else
  # Bash expands \# to its actual command number. Unlike HISTCMD, this works
  # inside PS1 on 3.2 even with file history disabled. Keep the user's DEBUG trap.
  __brclio_legacy_marker=$'\\[\033]1337;BrclioBashCommand=\\#\a\\]'
  [[ ${PS1-} == *"$__brclio_legacy_marker"* ]] || PS1+="$__brclio_legacy_marker"
  __brclio_legacy_marker=$'\\[\033]1337;BrclioBashContinuation\a\\]'
  [[ ${PS2-} == *"$__brclio_legacy_marker"* ]] || PS2+="$__brclio_legacy_marker"
  unset __brclio_legacy_marker
fi
if [[ ${PS1-} != *$'\\[\033]133;B\a\\]' ]]; then
  PS1+=$'\\[\033]133;B\a\\]'
fi
return "$1"
