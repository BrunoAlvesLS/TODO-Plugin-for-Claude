<#
.SYNOPSIS
  Maps an engine session id (what the TODO pane saves when you press Start) to the Claude
  desktop app's own session id, so the pane can reopen that session. Read only.

.PARAMETER Cli
  The engine (CLI) session id, a 36-character GUID.

.OUTPUTS
  The app session id (local_<guid>) on stdout, or nothing.
  Exit codes: 0 found, 1 not found, 2 -Cli is not a session id.
#>
param([Parameter(Mandatory = $true)][string]$Cli)

Set-StrictMode -Version Latest

$GuidPattern = '[0-9a-fA-F-]{36}'
if ($Cli -notmatch "^$GuidPattern$") { exit 2 }

$roots = @("$env:LOCALAPPDATA\Claude-Data", "$env:APPDATA\Claude") | Where-Object { Test-Path -LiteralPath $_ }
$files = foreach ($root in $roots) {
    Get-ChildItem -LiteralPath $root -Recurse -Filter 'local_*.json' -File -ErrorAction SilentlyContinue
}

# Newest first: the session just started is almost always the most recently written file.
foreach ($file in ($files | Sort-Object LastWriteTime -Descending)) {
    try {
        $text = [IO.File]::ReadAllText($file.FullName)
        # Cheap substring test before parsing, since most files are unrelated sessions.
        if (-not $text.Contains($Cli)) { continue }
        $session = $text | ConvertFrom-Json
        if ($session.cliSessionId -eq $Cli -and $session.sessionId -match "^local_$GuidPattern$") {
            Write-Output $session.sessionId
            exit 0
        }
    } catch {
        # Unreadable, locked or unrelated JSON (missing properties under strict mode): skip it.
    }
}
exit 1
