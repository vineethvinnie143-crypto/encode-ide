<#
.SYNOPSIS
  Tidies the Windows machine a CI job runs on, before and after the job.

.DESCRIPTION
  GitHub's own runner is a new machine for every job. eNCode's runner (scripts/ci/windows-runner.ps1) is one virtual
  machine kept from job to job, so a job may find what the one before it left.

  With -Start, on eNCode's runner only, at the start of a job:
    - checks that the machine's desktop is on screen and unlocked, since the checks open windows and use the mouse and
      keyboard;
    - removes what eNCode keeps for the account (its profile, ~\.encode, Documents\eNCode and the Start menu
      shortcut), so the packaged program starts as on a new machine. It refuses on a machine the setup script did not
      set up, which could be someone's own account.

  Without -Start, after a job, on any runner: stops every process the job left running from the checkout or the
  job's temporary folder, which would otherwise keep files the next checkout deletes.
#>
[CmdletBinding()]
param([switch]$Start)

$ErrorActionPreference = 'Stop'

function Fail([string]$text) { Write-Host "::error::$text"; exit 1 }

if (-not $Start) {
  $roots = @()
  foreach ($folder in @($env:GITHUB_WORKSPACE, $env:RUNNER_TEMP)) {
    if (-not $folder) { continue }
    $root = $folder.TrimEnd('\', '/') + '\'
    $roots += $root
    $roots += $root.Replace('\', '/')
  }
  $processes = @(Get-CimInstance Win32_Process)
  $byId = @{}
  foreach ($process in $processes) { $byId[[int]$process.ProcessId] = $process }
  # This script and the runner above it are never stopped, though their command lines name the temporary folder.
  $keep = @{}
  $id = [int]$PID
  while ($byId.ContainsKey($id) -and -not $keep.ContainsKey($id)) {
    $keep[$id] = $true
    $id = [int]$byId[$id].ParentProcessId
  }
  foreach ($process in $processes) {
    if ($keep.ContainsKey([int]$process.ProcessId)) { continue }
    $text = "$($process.ExecutablePath)|$($process.CommandLine)"
    foreach ($root in $roots) {
      if ($text.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
        "stopped $($process.Name) ($($process.ProcessId))"
        break
      }
    }
  }
  exit 0
}

if ($env:RUNNER_ENVIRONMENT -ne 'self-hosted') { 'A machine of GitHub''s is new for every job; nothing to tidy.'; exit 0 }
if ($env:ENCODE_CI_MACHINE -ne '1') {
  Fail 'This runner was not set up by scripts/ci/windows-runner.ps1, so it may be an everyday Windows account. The checks use the real eNCode profile and open windows on its desktop: run them only on a machine set up for CI.'
}

# The desktop: the job's session must be the one on the machine's screen (not a remote or enhanced session, which has
# no screen once its window closes), and not locked.
Add-Type -Namespace EncodeCi -Name Session -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();'
$console = [EncodeCi.Session]::WTSGetActiveConsoleSessionId()
$mine = (Get-Process -Id $PID).SessionId
$locked = @(Get-Process -Name LogonUI -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $mine }).Count -gt 0
if ($console -ne $mine -or $locked) {
  Fail 'The runner''s desktop is not on screen: the VM is locked, or its window was left in an enhanced session. Restart the VM; it signs in by itself. Keep its window on a basic session (View, untick Enhanced session).'
}

$documents = [Environment]::GetFolderPath('MyDocuments')
$state = @(
  (Join-Path $env:APPDATA 'eNCode'),
  (Join-Path $env:USERPROFILE '.encode'),
  (Join-Path $documents 'eNCode'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\eNCode.lnk')
)
foreach ($path in $state) {
  if (Test-Path -LiteralPath $path) {
    Remove-Item -LiteralPath $path -Recurse -Force
    "removed $path"
  }
}
'The desktop is on screen and eNCode starts as on a new machine.'
