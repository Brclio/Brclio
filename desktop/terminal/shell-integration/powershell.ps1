# Installed in this interactive process after PowerShell loads its profiles.
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage' -or (Test-Path variable:global:BrclioShellMarks)) { return }
if ($Host.Name -eq 'ConsoleHost' -and !(Test-Path function:PSConsoleHostReadLine)) {
    Import-Module PSReadLine -ErrorAction SilentlyContinue
}
$global:BrclioShellMarks = @{
    Prompt = $function:prompt
    ReadLine = if (Test-Path function:PSConsoleHostReadLine) { $function:PSConsoleHostReadLine } else { $null }
    Running = $false
    Escape = [char]27
    Bell = [char]7
}

function global:prompt {
    $succeeded = $global:?
    $marks = $global:BrclioShellMarks
    if ($marks.Running) {
        [Console]::Write(('{0}]133;D;{1}{2}' -f $marks.Escape, [int](!$succeeded), $marks.Bell))
        $marks.Running = $false
    }
    [Console]::Write(('{0}]133;A{1}' -f $marks.Escape, $marks.Bell))
    # Let existing profile prompts observe the preceding failure.
    if (!$succeeded) { Write-Error 'Previous command failed' -ErrorAction Ignore }
    $text = & $marks.Prompt
    return ("$text" + $marks.Escape + ']133;B' + $marks.Bell)
}

if ($global:BrclioShellMarks.ReadLine) {
    function global:PSConsoleHostReadLine {
        $marks = $global:BrclioShellMarks
        $line = & $marks.ReadLine
        if ($line) {
            [Console]::Write(('{0}]133;C{1}' -f $marks.Escape, $marks.Bell))
            $marks.Running = $true
        }
        return $line
    }
}
