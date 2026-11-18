<#
.SYNOPSIS
  Read-only Azure DevOps watcher for the TODO pane.

.DESCRIPTION
  Runs from Windows Task Scheduler (Windows PowerShell 5.1). It never writes to Azure DevOps:
  every call is a GET, apart from WIQL queries, which are POSTed but only read.
  It checks what needs the signed-in person right now, writes that list to inbox.json (read by
  the TODO pane), and shows one Windows toast when something new appears.

  Settings:  %USERPROFILE%\.claude\todo-pane\alerts.json   (edit this to change behaviour)
  Output:    %USERPROFILE%\.claude\todo-pane\inbox.json, watch-state.json, watch.log

.PARAMETER DryRun
  Print the result instead of writing files; no toast.

.PARAMETER TestToast
  Only raise a test toast, then exit.

.PARAMETER Detect
  Print likely organization/project pairs as JSON for the pane's setup screen, then exit.

.PARAMETER Cwd
  With -Detect: the open folder, whose git remotes are checked first.
#>
param(
    [switch]$DryRun,
    [switch]$TestToast,
    [switch]$Detect,
    [string]$Cwd = ''
)

# Strict mode is deliberately off: ADO and settings objects omit properties freely and the
# checks below rely on a missing property reading as $null.
$ErrorActionPreference = 'Stop'

$AdoResource = '499b84ac-1321-427f-aa17-267ca6975798'
$DefaultAzPath = 'C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd'
$PowerShellAppId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
$DoneStates = "'Closed','Done','Removed','Resolved','Completed'"
$MaxLogBytes = 200KB
$WorkItemBatchSize = 150
$AuthToastIntervalHours = 12

$Dir = Join-Path $env:USERPROFILE '.claude\todo-pane'
$SettingsPath = Join-Path $Dir 'alerts.json'
$StatePath = Join-Path $Dir 'watch-state.json'
$InboxPath = Join-Path $Dir 'inbox.json'
$LogPath = Join-Path $Dir 'watch.log'
$HeartbeatPath = Join-Path $Dir 'heartbeat.txt'
$HeartbeatFreshSeconds = 150

# ---------------------------------------------------------------------------------------------
# Local helpers
# ---------------------------------------------------------------------------------------------

function Write-Log([string]$Text) {
    if ($DryRun) { Write-Host $Text; return }
    try {
        if (-not (Test-Path $Dir)) { New-Item -ItemType Directory -Path $Dir -Force | Out-Null }
        if ((Test-Path $LogPath) -and ((Get-Item $LogPath).Length -gt $MaxLogBytes)) { Remove-Item $LogPath -Force }
        Add-Content -Path $LogPath -Value ("{0:s} {1}" -f (Get-Date), $Text)
    } catch {}
}

# Anything not caught below would otherwise end the scheduled run without a trace in watch.log.
trap {
    Write-Log "fatal: $($_.Exception.Message)"
    exit 1
}

function Show-Toast([string]$Title, [string]$Body, [string]$Url) {
    try {
        [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
        [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
        $t = [System.Security.SecurityElement]::Escape($Title)
        $b = [System.Security.SecurityElement]::Escape($Body)
        $launch = ''
        if ($Url) { $launch = ' activationType="protocol" launch="' + [System.Security.SecurityElement]::Escape($Url) + '"' }
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml("<toast$launch><visual><binding template=`"ToastGeneric`"><text>$t</text><text>$b</text></binding></visual></toast>")
        $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
        # Toasts must carry a registered app id; Windows PowerShell's own one is always present.
        [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($PowerShellAppId).Show($toast)
        return $true
    } catch {
        Write-Log "toast failed: $($_.Exception.Message)"
        return $false
    }
}

function Read-Json([string]$Path, $Default) {
    if (-not (Test-Path $Path)) { return $Default }
    try {
        $raw = Get-Content -Path $Path -Raw -Encoding UTF8
        if ([string]::IsNullOrWhiteSpace($raw)) { return $Default }
        return ($raw | ConvertFrom-Json)
    } catch { return $Default }
}

# Write to a temp file and swap it in, so the pane never reads a half-written file.
function Write-JsonAtomic([string]$Path, $Value) {
    $tmp = "$Path.tmp"
    ($Value | ConvertTo-Json -Depth 8) | Set-Content -Path $tmp -Encoding UTF8
    Move-Item -Path $tmp -Destination $Path -Force
}

function Get-AzPath($Settings) {
    if ($Settings -and $Settings.az -and (Test-Path ([string]$Settings.az))) { return [string]$Settings.az }
    $cmd = Get-Command az -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    if (Test-Path $DefaultAzPath) { return $DefaultAzPath }
    return $null
}

# Returns an ADO access token from the Azure CLI sign-in, or $null when signed out.
function Get-AdoToken([string]$AzPath) {
    $token = (& $AzPath account get-access-token --resource $AdoResource --query accessToken -o tsv 2>$null)
    if ($token) { return [string]$token }
    return $null
}

# ---------------------------------------------------------------------------------------------
# One-shot modes
# ---------------------------------------------------------------------------------------------

if ($TestToast) {
    $ok = Show-Toast 'TODO pane' 'Test alert. If you can read this, alerts will reach you.' 'https://dev.azure.com'
    Write-Host ("toast shown: {0}" -f $ok)
    exit 0
}

$settings = Read-Json $SettingsPath $null

# -Detect: print likely organization/project pairs as JSON, for the setup screen. Read only.
if ($Detect) {
    $suggestions = New-Object System.Collections.ArrayList
    function Add-Suggestion([string]$Org, [string]$Project) {
        $pair = ([uri]::UnescapeDataString($Org) + '/' + [uri]::UnescapeDataString($Project))
        if (-not $suggestions.Contains($pair)) { [void]$suggestions.Add($pair) }
    }
    $authFailed = $false
    try {
        # 1. The Azure DevOps address in the git remote of the open folder
        if ($Cwd -and (Test-Path $Cwd)) {
            $git = Get-Command git -ErrorAction SilentlyContinue
            if ($git) {
                $remotes = ''
                try {
                    # git writes to stderr for a folder that is not a repo; that is not an error here.
                    $ErrorActionPreference = 'Continue'
                    $remotes = (& git -C $Cwd remote -v 2>$null) -join "`n"
                } catch {} finally { $ErrorActionPreference = 'Stop' }
                $remotePatterns = @(
                    'dev\.azure\.com/([^/\s@]+)/([^/\s]+)/_git/',
                    'ssh\.dev\.azure\.com:v3/([^/\s]+)/([^/\s]+)/',
                    '([^./\s@]+)\.visualstudio\.com/(?:DefaultCollection/)?([^/\s]+)/_git/'
                )
                foreach ($pattern in $remotePatterns) {
                    foreach ($m in [regex]::Matches($remotes, $pattern)) { Add-Suggestion $m.Groups[1].Value $m.Groups[2].Value }
                }
            }
        }
        # 2. The organizations of the signed-in person, and their projects
        if ($suggestions.Count -eq 0) {
            $az = Get-AzPath $settings
            if (-not $az) { throw 'no az' }
            $t = Get-AdoToken $az
            if (-not $t) { $authFailed = $true; throw 'no token' }
            $hd = @{ Authorization = "Bearer $t" }
            $me = Invoke-RestMethod -Uri 'https://app.vssps.visualstudio.com/_apis/profile/profiles/me?api-version=7.1' -Headers $hd
            $accts = Invoke-RestMethod -Uri "https://app.vssps.visualstudio.com/_apis/accounts?memberId=$($me.id)&api-version=7.1" -Headers $hd
            foreach ($acct in @($accts.value | Select-Object -First 4)) {
                try {
                    $ps = Invoke-RestMethod -Uri "https://dev.azure.com/$($acct.accountName)/_apis/projects?`$top=6&api-version=7.1" -Headers $hd
                    foreach ($p in @($ps.value)) { Add-Suggestion $acct.accountName $p.name }
                } catch {}
            }
        }
    } catch { [Console]::Error.WriteLine("detect: $($_.Exception.Message)") }
    ([ordered]@{ suggestions = @($suggestions | Select-Object -First 8); authFailed = $authFailed } | ConvertTo-Json -Compress)
    exit 0
}

# ---------------------------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------------------------

if (-not $settings -or -not $settings.organization -or -not $settings.project) {
    Write-Log 'alerts.json is missing or has no organization/project; nothing to do'
    Write-Host 'No settings yet. Set up alerts from the TODO pane.'
    exit 0
}
$Org = [string]$settings.organization
$Proj = [string]$settings.project
$RepoFilter = [string]$settings.repository
$WindowDays = 30
if ($settings.windowDays) { $WindowDays = [int]$settings.windowDays }

# An event is on unless alerts.json turns it off explicitly.
function Test-EventEnabled([string]$Name) {
    if ($settings.events -and ($settings.events.PSObject.Properties.Name -contains $Name)) { return [bool]$settings.events.$Name }
    return $true
}
# Process-specific names, overridable in alerts.json. Values go into WIQL, so single quotes are doubled.
function ConvertTo-WiqlLiteral([string]$Value) { return "'" + $Value.Replace("'", "''") + "'" }
$TesterState = 'Resolved'
if (([string]$settings.testerState).Trim()) { $TesterState = ([string]$settings.testerState).Trim() }
$TesterField = 'Custom.Tester'
if (([string]$settings.testerField).Trim() -match '^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$') { $TesterField = ([string]$settings.testerField).Trim() }
$doneList = @($settings.doneStates | ForEach-Object { ([string]$_).Trim() } | Where-Object { $_ })
if ($doneList.Count -gt 0) { $DoneStates = ($doneList | ForEach-Object { ConvertTo-WiqlLiteral $_ }) -join ',' }
$ignore = @()
if ($settings.ignoreIds) { $ignore = @($settings.ignoreIds | ForEach-Object { [string]$_ }) }

# Quiet hours: "22:00-07:00" means no toast (the inbox still updates). The range may wrap midnight.
$quiet = $false
if ($settings.quietHours -and ([string]$settings.quietHours) -match '^(\d\d):(\d\d)-(\d\d):(\d\d)$') {
    $now = (Get-Date).TimeOfDay
    $from = New-TimeSpan -Hours ([int]$Matches[1]) -Minutes ([int]$Matches[2])
    $to = New-TimeSpan -Hours ([int]$Matches[3]) -Minutes ([int]$Matches[4])
    if ($from -le $to) { $quiet = ($now -ge $from -and $now -lt $to) } else { $quiet = ($now -ge $from -or $now -lt $to) }
}

# ---------------------------------------------------------------------------------------------
# Sign-in
# ---------------------------------------------------------------------------------------------

try {
    $az = Get-AzPath $settings
    if (-not $az) { throw 'Azure CLI (az) not found' }
    $token = Get-AdoToken $az
    if (-not $token) { throw 'No Azure DevOps token. Run: az login' }
} catch {
    Write-Log "auth: $($_.Exception.Message)"
    # Remind at most every few hours, keeping the rest of the state untouched.
    $prev = Read-Json $StatePath $null
    $notifiedAuth = $false
    if ($prev -and $prev.authToastAt) { $notifiedAuth = (((Get-Date) - [datetime]$prev.authToastAt).TotalHours -lt $AuthToastIntervalHours) }
    if (-not $DryRun -and -not $notifiedAuth -and -not $quiet) {
        [void](Show-Toast 'TODO alerts paused' 'Sign in again with: az login' $null)
        $st = @{ authToastAt = (Get-Date).ToString('o') }
        if ($prev) { foreach ($p in $prev.PSObject.Properties) { if ($p.Name -ne 'authToastAt') { $st[$p.Name] = $p.Value } } }
        Write-JsonAtomic $StatePath $st
    }
    Write-Host "auth failed: $($_.Exception.Message)"
    exit 1
}

# ---------------------------------------------------------------------------------------------
# Azure DevOps reads
# ---------------------------------------------------------------------------------------------

$H = @{ Authorization = "Bearer $token" }
$Base = "https://dev.azure.com/$Org"

function Get-Ado([string]$Url) { return Invoke-RestMethod -Uri $Url -Method Get -Headers $H }

# WIQL only accepts POST, but it is a query: nothing in ADO changes.
function Invoke-Wiql([string]$Query) {
    $body = @{ query = $Query } | ConvertTo-Json
    return Invoke-RestMethod -Uri "$Base/$Proj/_apis/wit/wiql?api-version=7.0" -Method Post -Headers $H -Body $body -ContentType 'application/json'
}

function Get-WiqlIds([string]$Query, [int]$Max) {
    return @((Invoke-Wiql $Query).workItems | ForEach-Object { [int]$_.id } | Select-Object -First $Max)
}

function Get-WorkItems([int[]]$Ids) {
    if (-not $Ids -or $Ids.Count -eq 0) { return @() }
    $out = @()
    for ($i = 0; $i -lt $Ids.Count; $i += $WorkItemBatchSize) {
        $slice = $Ids[$i..([Math]::Min($i + $WorkItemBatchSize - 1, $Ids.Count - 1))] -join ','
        $r = Get-Ado "$Base/_apis/wit/workitems?ids=$slice&fields=System.Id,System.Title,System.WorkItemType,System.State,System.AssignedTo,System.Parent&api-version=7.0"
        $out += @($r.value)
    }
    return $out
}

function Get-WorkItemUrl([int]$Id) { return "$Base/$Proj/_workitems/edit/$Id" }
function Get-PrApiUrl([string]$RepoId, $PrId) { return "$Base/$Proj/_apis/git/repositories/$RepoId/pullrequests/$PrId" }
function Get-PrWebUrl([string]$RepoId, $PrId) { return "$Base/$Proj/_git/$RepoId/pullrequest/$PrId" }

function Test-AssignedToMe($WorkItem) {
    $assigned = $WorkItem.fields.'System.AssignedTo'
    return ($assigned -and ([string]$assigned.id -eq $myId))
}

# The comments of a PR thread that a person wrote and did not delete, oldest first.
function Get-ThreadComments($Thread) {
    return @($Thread.comments | Where-Object { $_.commentType -ne 'system' -and -not $_.isDeleted } | Sort-Object -Property id)
}

$conn = Get-Ado "$Base/_apis/connectionData?api-version=7.0-preview"
$myId = [string]$conn.authenticatedUser.id
$myName = [string]$conn.authenticatedUser.providerDisplayName

# ---------------------------------------------------------------------------------------------
# Collect what needs me. Each section is isolated: a failure is recorded and the rest still run.
# ---------------------------------------------------------------------------------------------

$items = @{}
function Add-Item([string]$Key, [string]$Type, [string]$Title, [string]$Url, [string]$Rev) {
    # Keys end in the work item or PR id, which is what ignoreIds lists.
    $id = ($Key -split ':')[-1]
    if ($ignore -contains $id) { return }
    $items[$Key] = [ordered]@{ key = $Key; type = $Type; title = $Title; url = $Url; rev = $Rev }
}

$errors = @()
function Invoke-Section([string]$Name, [scriptblock]$Block) {
    try { & $Block } catch { $script:errors += "${Name}: $($_.Exception.Message)"; Write-Log "${Name} failed: $($_.Exception.Message)" }
}

# 1. Assigned to me
if (Test-EventEnabled 'assigned') { Invoke-Section 'assigned' {
    $ids = @(Get-WiqlIds "SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND [System.State] NOT IN ($DoneStates) AND [System.ChangedDate] >= @Today - $WindowDays ORDER BY [System.ChangedDate] DESC" 100)
    foreach ($w in (Get-WorkItems $ids)) {
        Add-Item "wi-assigned:$($w.id)" 'assigned' "$($w.fields.'System.WorkItemType') $($w.id): $($w.fields.'System.Title')" (Get-WorkItemUrl $w.id) ''
    }
} }

# 1b. Tickets where I am the tester (testerField, default Custom.Tester) and the state is testerState (default Resolved = ready to test).
if (Test-EventEnabled 'tester') { Invoke-Section 'tester' {
    $testerStateLiteral = ConvertTo-WiqlLiteral $TesterState
    $ids = @(Get-WiqlIds "SELECT [System.Id] FROM WorkItems WHERE [$TesterField] = @Me AND [System.State] = $testerStateLiteral AND [System.ChangedDate] >= @Today - $WindowDays ORDER BY [System.ChangedDate] DESC" 100)
    foreach ($w in (Get-WorkItems $ids)) {
        if (Test-AssignedToMe $w) { continue }
        Add-Item "wi-tester:$($w.id)" 'tester' "Test $($w.fields.'System.WorkItemType') $($w.id): $($w.fields.'System.Title')" (Get-WorkItemUrl $w.id) ''
    }
} }

# 2. New child bugs/tasks under my tickets
if (Test-EventEnabled 'childItems') { Invoke-Section 'childItems' {
    $q = "SELECT [System.Id] FROM WorkItemLinks WHERE [Source].[System.AssignedTo] = @Me AND [Source].[System.State] NOT IN ($DoneStates) AND [System.Links.LinkType] = 'System.LinkTypes.Hierarchy-Forward' AND [Target].[System.State] NOT IN ($DoneStates) AND [Target].[System.CreatedDate] >= @Today - $WindowDays MODE (MustContain)"
    $rel = @((Invoke-Wiql $q).workItemRelations | Where-Object { $_.source -and $_.target })
    $parentOf = @{}
    foreach ($r in $rel) { $parentOf[[int]$r.target.id] = [int]$r.source.id }
    $ids = @($parentOf.Keys | Select-Object -First 100)
    foreach ($w in (Get-WorkItems $ids)) {
        if (Test-AssignedToMe $w) { continue }
        Add-Item "wi-child:$($w.id)" 'child' "New $($w.fields.'System.WorkItemType') $($w.id) under ticket $($parentOf[[int]$w.id]): $($w.fields.'System.Title')" (Get-WorkItemUrl $w.id) ''
    }
} }

# 3. Mentions in work item comments, still unanswered
if (Test-EventEnabled 'mention') { Invoke-Section 'mention' {
    $ids = @(Get-WiqlIds "SELECT [System.Id] FROM WorkItems WHERE [System.Id] IN (@RecentMentions) AND [System.ChangedDate] >= @Today - 14 ORDER BY [System.ChangedDate] DESC" 20)
    foreach ($id in $ids) {
        $c = Get-Ado "$Base/$Proj/_apis/wit/workItems/$id/comments?api-version=7.0-preview.3"
        $comments = @($c.comments | Sort-Object -Property id)
        # The latest comment that names me (mine included, as a reminder to myself); any later comment of mine answers it.
        $mentionIdx = -1
        for ($i = 0; $i -lt $comments.Count; $i++) {
            $text = [string]$comments[$i].text
            $namesMe = ($text -match [regex]::Escape($myId)) -or ($myName -and ($text -match [regex]::Escape($myName)))
            if ($namesMe) { $mentionIdx = $i }
        }
        if ($mentionIdx -lt 0) { continue }
        $answered = $false
        for ($i = $mentionIdx + 1; $i -lt $comments.Count; $i++) { if ($comments[$i].createdBy.id -eq $myId) { $answered = $true } }
        if ($answered) { continue }
        $w = @(Get-WorkItems @($id))[0]
        Add-Item "wi-mention:$id" 'mention' "$(if ($comments[$mentionIdx].createdBy.id -eq $myId) { 'You mentioned yourself' } else { "$($comments[$mentionIdx].createdBy.displayName) mentioned you" }) on $($w.fields.'System.WorkItemType') ${id}: $($w.fields.'System.Title')" (Get-WorkItemUrl $id) ([string]$comments[$mentionIdx].id)
    }
} }

# 4. My PRs: replies, failing builds and merge conflicts
$myPrs = @()
if ((Test-EventEnabled 'prReplies') -or (Test-EventEnabled 'failedBuild') -or (Test-EventEnabled 'mergeConflict')) { Invoke-Section 'myPrs' {
    $r = Get-Ado "$Base/$Proj/_apis/git/pullrequests?searchCriteria.creatorId=$myId&searchCriteria.status=active&`$top=100&api-version=7.1"
    $script:myPrs = @($r.value | Where-Object { (-not $RepoFilter) -or ($_.repository.name -eq $RepoFilter) })
} }
foreach ($pr in $myPrs) {
    $prId = $pr.pullRequestId
    $repoId = $pr.repository.id
    $prApi = Get-PrApiUrl $repoId $prId
    $prUrl = Get-PrWebUrl $repoId $prId
    if (Test-EventEnabled 'prReplies') { Invoke-Section "prReplies $prId" {
        $threads = @((Get-Ado "$prApi/threads?api-version=7.1").value)
        $count = 0; $maxId = 0; $who = ''
        foreach ($t in $threads) {
            if ($t.isDeleted -or $t.status -ne 'active') { continue }
            $texts = @(Get-ThreadComments $t)
            if ($texts.Count -eq 0) { continue }
            $last = $texts[-1]
            if ($last.author.id -eq $myId) { continue }
            $count++
            if ([int]$last.id -gt $maxId) { $maxId = [int]$last.id }
            $who = [string]$last.author.displayName
        }
        if ($count -gt 0) {
            Add-Item "pr-reply:$prId" 'prReply' "PR !${prId}: $count thread(s) from $who need your reply - $($pr.title)" $prUrl ([string]$maxId)
        }
    } }
    if (Test-EventEnabled 'mergeConflict') {
        $conflictKey = "pr-conflict:$prId"
        $conflictRev = [string]$pr.lastMergeSourceCommit.commitId + '/' + [string]$pr.lastMergeTargetCommit.commitId
        $conflictTitle = "PR !${prId}: merge conflicts with $(($pr.targetRefName -replace '^refs/heads/','')) - $($pr.title)"
        if ($pr.mergeStatus -eq 'conflicts') {
            Add-Item $conflictKey 'conflict' $conflictTitle $prUrl $conflictRev
        } elseif ($pr.mergeStatus -eq 'queued' -or $pr.mergeStatus -eq 'notSet') {
            # ADO reports queued/notSet while it recomputes the merge; keep an open conflict open instead of flapping.
            $prevState = Read-Json $StatePath $null
            if ($prevState -and $prevState.seen -and ($prevState.seen.PSObject.Properties.Name -contains $conflictKey)) {
                Add-Item $conflictKey 'conflict' $conflictTitle $prUrl ([string]$prevState.seen.$conflictKey)
            }
        }
    }
    if (Test-EventEnabled 'failedBuild') { Invoke-Section "failedBuild $prId" {
        # Latest status per context; coverage checks are informational and ignored.
        $st = @((Get-Ado "$prApi/statuses?api-version=7.1").value)
        $latest = $st | Group-Object { "$($_.context.genre)/$($_.context.name)" } | ForEach-Object { $_.Group | Sort-Object -Property creationDate | Select-Object -Last 1 }
        $bad = @($latest | Where-Object { ($_.state -eq 'failed' -or $_.state -eq 'error') -and ([string]$_.description -notmatch 'coverage') })
        if ($bad.Count -gt 0) {
            Add-Item "pr-build:$prId" 'build' "PR !${prId}: build failing ($($bad[0].description))" $prUrl ([string]$bad[0].id)
        }
        # Build validation policies report here, not under statuses.
        if (-not $items.ContainsKey("pr-build:$prId")) {
            $projId = $pr.repository.project.id
            $art = [uri]::EscapeDataString("vstfs:///CodeReview/CodeReviewId/$projId/$prId")
            $evals = @((Get-Ado "$Base/$projId/_apis/policy/evaluations?artifactId=$art&api-version=7.1-preview.1").value)
            $failedBuilds = @($evals | Where-Object { $_.configuration.type.displayName -eq 'Build' -and ($_.status -eq 'rejected' -or $_.status -eq 'broken') })
            if ($failedBuilds.Count -gt 0) {
                $fb = $failedBuilds[0]
                $buildId = [string]$fb.context.buildId
                $name = [string]$fb.configuration.settings.displayName
                if (-not $name) { $name = 'build policy' }
                Add-Item "pr-build:$prId" 'build' "PR !${prId}: build failing ($name)" $prUrl $buildId
            }
        }
    } }
}

# 5. PRs where I am a reviewer and have not voted
if (Test-EventEnabled 'reviewer') { Invoke-Section 'reviewer' {
    $r = Get-Ado "$Base/$Proj/_apis/git/pullrequests?searchCriteria.reviewerId=$myId&searchCriteria.status=active&`$top=100&api-version=7.1"
    foreach ($pr in @($r.value)) {
        if ($RepoFilter -and $pr.repository.name -ne $RepoFilter) { continue }
        if ($pr.createdBy.id -eq $myId) { continue }
        $me = $pr.reviewers | Where-Object { $_.id -eq $myId } | Select-Object -First 1
        if (-not $me -or $me.vote -ne 0) { continue }
        $prId = $pr.pullRequestId
        $repoId = $pr.repository.id
        $prApi = Get-PrApiUrl $repoId $prId
        $threads = @((Get-Ado "$prApi/threads?api-version=7.1").value)
        $myDates = @()
        $unanswered = 0
        foreach ($t in $threads) {
            $mine = $false
            foreach ($c in @($t.comments)) { if ($c.author.id -eq $myId -and $c.commentType -ne 'system') { $myDates += [datetime]$c.publishedDate; $mine = $true } }
            # My thread still active with me as the last commenter: the author has not answered it yet.
            if ($mine -and -not $t.isDeleted -and $t.status -eq 'active') {
                $texts = @(Get-ThreadComments $t)
                if ($texts.Count -gt 0 -and $texts[-1].author.id -eq $myId) { $unanswered++ }
            }
        }
        $rev = ''
        if ($myDates.Count -gt 0) {
            # Already reviewed: only ask again after a new push, and not while my comments wait on the author.
            $iters = @((Get-Ado "$prApi/iterations?api-version=7.1").value)
            $lastIter = $iters | Sort-Object -Property createdDate | Select-Object -Last 1
            $lastPush = [datetime]$lastIter.createdDate
            if (($myDates | Sort-Object | Select-Object -Last 1) -ge $lastPush) { continue }
            if ($unanswered -gt 0) { continue }
            # A changing rev reopens the task even if I closed it by hand.
            $rev = [string]$lastIter.id
        }
        $verb = if ($myDates.Count -gt 0) { 'Re-review' } else { 'Review' }
        Add-Item "pr-review:$prId" 'review' "$verb PR !${prId} from $($pr.createdBy.displayName): $($pr.title)" (Get-PrWebUrl $repoId $prId) $rev
    }
} }

# ---------------------------------------------------------------------------------------------
# Diff against what was seen before
# ---------------------------------------------------------------------------------------------

$prev = Read-Json $StatePath $null
$firstRun = ($null -eq $prev -or $null -eq $prev.seen)
$seen = @{}
if (-not $firstRun) { foreach ($p in $prev.seen.PSObject.Properties) { $seen[$p.Name] = [string]$p.Value } }
$failedSections = ($errors.Count -gt 0)

# Baseline = present on the first run and untouched since; the pane does not add those as tasks.
$out = @()
$newOnes = @()
foreach ($k in $items.Keys) {
    $it = $items[$k]
    $baseline = $false
    if ($firstRun) { $baseline = $true }
    elseif ($seen.ContainsKey($k) -and $seen[$k] -eq $it.rev) { $baseline = ($prev.baseline -and ($prev.baseline.PSObject.Properties.Name -contains $k)) }
    else { $newOnes += $it }
    $it['baseline'] = $baseline
    $out += $it
}

$result = [ordered]@{
    updated  = (Get-Date).ToString('o')
    user     = $myName
    complete = (-not $failedSections)
    errors   = $errors
    items    = $out
}

if ($DryRun) {
    $result | ConvertTo-Json -Depth 6
    Write-Host ("new since last run: {0}; first run: {1}; total open: {2}" -f $newOnes.Count, $firstRun, $out.Count)
    exit 0
}

# ---------------------------------------------------------------------------------------------
# Write inbox and state, then alert
# ---------------------------------------------------------------------------------------------

if (-not (Test-Path $Dir)) { New-Item -ItemType Directory -Path $Dir -Force | Out-Null }
Write-JsonAtomic $InboxPath $result

# Keep an item's baseline flag while it stays untouched; anything new or changed loses it.
$newSeen = [ordered]@{}
$newBase = [ordered]@{}
foreach ($it in $out) {
    $newSeen[$it.key] = $it.rev
    if ($it.baseline) { $newBase[$it.key] = $true }
}
# When a section failed, keep what was seen before so a hiccup does not look like "resolved then new".
if ($failedSections -and -not $firstRun) {
    foreach ($k in $seen.Keys) { if (-not $newSeen.Contains($k)) { $newSeen[$k] = $seen[$k] } }
}
Write-JsonAtomic $StatePath ([ordered]@{ seen = $newSeen; baseline = $newBase; updated = (Get-Date).ToString('o') })

# An open Claude session writes heartbeat.txt (epoch ms) every sync and raises its own alert for
# the tasks it adds, so this toast is skipped while that heartbeat is fresh.
$sessionAlive = $false
try {
    if (Test-Path $HeartbeatPath) {
        $beat = [int64]((Get-Content -Path $HeartbeatPath -Raw).Trim())
        $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $sessionAlive = (($nowMs - $beat) -ge 0 -and ($nowMs - $beat) -lt ($HeartbeatFreshSeconds * 1000))
    }
} catch {}

if ($newOnes.Count -gt 0 -and -not $quiet -and -not $sessionAlive) {
    $first = $newOnes[0]
    $title = if ($newOnes.Count -eq 1) { 'New on your list' } else { "$($newOnes.Count) new on your list" }
    $body = $first.title
    if ($newOnes.Count -gt 1) { $body = $body + " (+$($newOnes.Count - 1) more)" }
    [void](Show-Toast $title $body $first.url)
}
Write-Log ("ok: {0} open, {1} new, first={2}, errors={3}, sessionAlive={4}" -f $out.Count, $newOnes.Count, $firstRun, $errors.Count, $sessionAlive)
