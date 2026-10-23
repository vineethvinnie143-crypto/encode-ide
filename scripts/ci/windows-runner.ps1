<#
.SYNOPSIS
  Sets up a Windows virtual machine as eNCode's CI runner: a GitHub Actions runner for this repository only, labelled
  "encode", that starts when the machine signs in and runs every check of every pull request.

.DESCRIPTION
  Run it once, inside the VM, in Windows PowerShell started as administrator. It is meant for a machine kept for CI:
  the checks open windows, use the mouse and keyboard, and install and remove eNCode on the real profile, so it does
  not belong on an everyday Windows account (docs/ci/windows-runner.md says why).

  It asks for the registration token first, and with -AutoLogon for this account's password, then runs on its own:
    - installs Git for Windows, PowerShell 7 and the Visual C++ runtime if they are missing, as GitHub's own Windows
      runner has them. Each download is checked before it runs: against the SHA-256 digest GitHub publishes for a
      release file, and for Microsoft's files, against Microsoft's signature;
    - downloads GitHub's latest actions/runner release for Windows x64, checked the same way, and registers it for
      this repository with the token;
    - starts it, with administrator rights as GitHub's runner has, whenever this account signs in (a Windows service
      would have no desktop for the checks' windows);
    - sets the machine up as GitHub's runner is: long paths, local scripts allowed, the runner's folder left out of
      Defender's scanning, Smart App Control off (it would stop the unsigned programs the checks build), and nothing
      that sleeps, locks or pops up over the checks' windows;
    - with -AutoLogon, signs this account in when the machine starts, through Microsoft's Sysinternals Autologon,
      which keeps the password encrypted by Windows, then restarts the machine to finish.

  The registration token comes from GitHub: the repository's Settings, Actions, Runners, New self-hosted runner. It is
  the value after --token on that page (pasting the whole line works too), and it expires an hour after the page was
  opened. It is used once and not kept.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File C:\eNCode-CI\windows-runner.ps1 -AutoLogon
#>
[CmdletBinding()]
param(
  [string]$Token,
  [ValidatePattern('^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$')]
  [string]$Repository = 'vineethvinnie143-crypto/encode-ide',
  [string]$RunnerDir = 'C:\actions-runner',
  [switch]$AutoLogon
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Say([string]$text) { Write-Host "[encode-ci] $text" }
function Fail([string]$text) { Write-Host "[encode-ci] $text" -ForegroundColor Red; exit 1 }
function Have([string]$command) { [bool](Get-Command $command -ErrorAction SilentlyContinue) }
function Plain([Security.SecureString]$secure) {
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
}
function Set-Value([string]$key, [string]$name, $value, [string]$type = 'DWord') {
  if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
  Set-ItemProperty -LiteralPath $key -Name $name -Value $value -Type $type
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail 'Run PowerShell as administrator (right-click it, Run as administrator) and start this again.' }

# ---------------------------------------------------------------- what is asked, all at the start

if (-not $Token) { $Token = Plain (Read-Host -AsSecureString 'Registration token (GitHub: Settings, Actions, Runners, New self-hosted runner; the value after --token)') }
$Token = $Token.Trim()
if ($Token -match '--token\s+(\S+)') { $Token = $Matches[1] }
if ($Token -notmatch '^[A-Za-z0-9_-]{20,200}$') { Fail 'That does not look like a registration token: copy the value after --token on GitHub''s page and run this again.' }

$password = $null
if ($AutoLogon) {
  $password = Read-Host -AsSecureString "Windows password of $env:USERNAME, for signing in automatically"
  Add-Type -AssemblyName System.DirectoryServices.AccountManagement
  $machine = New-Object System.DirectoryServices.AccountManagement.PrincipalContext([System.DirectoryServices.AccountManagement.ContextType]::Machine)
  $plain = Plain $password
  try { $valid = $machine.ValidateCredentials($env:USERNAME, $plain) } finally { $plain = $null; $machine.Dispose() }
  if (-not $valid) { Fail "That password does not sign $env:USERNAME in. An account with no password needs one first (Settings, Accounts, Sign-in options, Password); then run this again." }
}

# ---------------------------------------------------------------- downloads, checked before anything runs

$agent = @{ 'User-Agent' = 'encode-ci-setup' }
$downloads = Join-Path $env:TEMP "encode-ci-$([guid]::NewGuid().ToString('n'))"
New-Item -ItemType Directory -Path $downloads -Force | Out-Null

function Assert-Signed([string]$file, [string]$subject) {
  $signature = Get-AuthenticodeSignature -LiteralPath $file
  if ($signature.Status -ne 'Valid' -or ($subject -and $signature.SignerCertificate.Subject -notmatch $subject)) {
    Remove-Item -LiteralPath $file -Force
    Fail "$(Split-Path $file -Leaf) does not carry the signature expected, so it was not run. Nothing else was changed by it."
  }
}

# A file of a repository's latest release, checked against the SHA-256 digest GitHub publishes for it.
function Get-ReleaseFile([string]$repo, [string]$pattern) {
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers ($agent + @{ Accept = 'application/vnd.github+json' })
  $asset = @($release.assets | Where-Object { $_.name -match $pattern }) | Select-Object -First 1
  if (-not $asset) { Fail "The latest release of $repo ($($release.tag_name)) has no file matching $pattern." }
  if ("$($asset.digest)" -notmatch '^sha256:([0-9a-f]{64})$') { Fail "GitHub publishes no SHA-256 digest for $($asset.name), so it cannot be checked. Nothing was installed from it." }
  $expected = $Matches[1]
  $file = Join-Path $downloads $asset.name
  Say "Downloading $($asset.name)..."
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $file -UseBasicParsing -Headers $agent
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { Remove-Item -LiteralPath $file -Force; Fail "$($asset.name) does not match GitHub's digest ($actual, expected $expected). Nothing was installed from it." }
  $file
}

function Install([string]$what, [string]$program, [string[]]$arguments, [int[]]$fine = @(0)) {
  Say "Installing $what..."
  $run = Start-Process -FilePath $program -ArgumentList $arguments -Wait -PassThru
  if ($fine -notcontains $run.ExitCode) { Fail "Installing $what failed (exit code $($run.ExitCode))." }
}

# ---------------------------------------------------------------- what the checks need

if (-not (Have 'git')) {
  $setup = Get-ReleaseFile 'git-for-windows/git' '^Git-[0-9.]+-64-bit\.exe$'
  Assert-Signed $setup ''
  Install 'Git for Windows' $setup @('/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES', '/CLOSEAPPLICATIONS')
}
if (-not (Have 'pwsh')) {
  $msi = Get-ReleaseFile 'PowerShell/PowerShell' '^PowerShell-[0-9.]+-win-x64\.msi$'
  Assert-Signed $msi 'O=Microsoft Corporation'
  Install 'PowerShell 7' 'msiexec.exe' @('/i', "`"$msi`"", '/quiet', '/norestart', 'ADD_PATH=1', 'USE_MU=0', 'ENABLE_MU=0') @(0, 3010)
}
$runtime = Join-Path $downloads 'vc_redist.x64.exe'
Say 'Downloading the Visual C++ runtime...'
Invoke-WebRequest -Uri 'https://aka.ms/vs/17/release/vc_redist.x64.exe' -OutFile $runtime -UseBasicParsing -Headers $agent
Assert-Signed $runtime 'O=Microsoft Corporation'
# 1638: a newer one is there already.
Install 'the Visual C++ runtime' $runtime @('/install', '/quiet', '/norestart') @(0, 1638, 3010)

$env:Path = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')) -join ';'
if (-not (Have 'git')) { Fail 'Git was installed but cannot be found; restart the VM and run this again.' }

# ---------------------------------------------------------------- the machine, as GitHub's runner is

Set-Value 'HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem' 'LongPathsEnabled' 1
git config --system core.longpaths true
# The checks run scripts of their own; a script downloaded from the internet still needs a signature.
try { Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope LocalMachine -Force } catch { }
if ((Get-ExecutionPolicy -Scope LocalMachine) -ne 'RemoteSigned') { Say 'Could not allow local scripts (a policy of the machine forbids it); the checks may not start.' }
try { Add-MpPreference -ExclusionPath $RunnerDir } catch { Say "Could not leave $RunnerDir out of Defender's scanning; the checks run slower." }
# Smart App Control stops programs that are not signed, and the checks build and start eNCode unsigned. Once off it
# stays off; it is not turned on again without a new Windows.
$policy = 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy'
if ((Test-Path -LiteralPath $policy) -and (Get-ItemProperty -LiteralPath $policy -Name VerifiedAndReputablePolicyState -ErrorAction SilentlyContinue).VerifiedAndReputablePolicyState -ne 0) {
  try { Set-Value $policy 'VerifiedAndReputablePolicyState' 0 } catch { Say 'Could not turn Smart App Control off: turn it off in Windows Security, App and browser control.' }
}

# Awake, unlocked and quiet: a locked or sleeping desktop takes no input, and a notice over a window takes its clicks.
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change monitor-timeout-ac 0 | Out-Null
powercfg /change hibernate-timeout-ac 0 | Out-Null
Set-Value 'HKCU:\Control Panel\Desktop' 'ScreenSaveActive' '0' 'String'
Set-Value 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\Personalization' 'NoLockScreen' 1
Set-Value 'HKCU:\Software\Microsoft\Windows\CurrentVersion\PushNotifications' 'ToastEnabled' 0
Set-Value 'HKCU:\Software\Microsoft\Windows\CurrentVersion\UserProfileEngagement' 'ScoobeSystemSettingEnabled' 0
foreach ($name in @('SubscribedContent-310093Enabled', 'SubscribedContent-338389Enabled', 'SoftLandingEnabled')) {
  Set-Value 'HKCU:\Software\Microsoft\Windows\CurrentVersion\ContentDeliveryManager' $name 0
}
Say 'This machine no longer sleeps, locks, turns its screen off or shows notices.'

# ---------------------------------------------------------------- the runner

$task = 'eNCode CI runner'
if (Test-Path (Join-Path $RunnerDir '.runner')) {
  Say "A runner is set up in $RunnerDir already; it is registered again in its place."
  Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
  Get-Process -Name Runner.Listener, Runner.Worker -ErrorAction SilentlyContinue | Stop-Process -Force
  foreach ($file in @('.runner', '.credentials', '.credentials_rsaparams')) { Remove-Item -LiteralPath (Join-Path $RunnerDir $file) -Force -ErrorAction SilentlyContinue }
}
New-Item -ItemType Directory -Force -Path $RunnerDir | Out-Null
$zip = Get-ReleaseFile 'actions/runner' '^actions-runner-win-x64-[0-9.]+\.zip$'
Say "Checked against GitHub's digest; unpacking into $RunnerDir."
Expand-Archive -LiteralPath $zip -DestinationPath $RunnerDir -Force

$name = "encode-$($env:COMPUTERNAME.ToLowerInvariant())"
Push-Location $RunnerDir
try {
  & .\config.cmd --unattended --replace --url "https://github.com/$Repository" --token $Token --name $name --labels encode --work _work
  if ($LASTEXITCODE -ne 0) { Fail 'GitHub refused the registration. A token expires an hour after the page was opened: open the page again for a new one.' }
} finally {
  Pop-Location
  $Token = $null
}

# Every job is told it runs on a machine set up for CI; scripts/ci/tidy-runner.ps1 and the smokes that use the real
# profile refuse a self-hosted runner without it.
$envFile = Join-Path $RunnerDir '.env'
$lines = @(if (Test-Path -LiteralPath $envFile) { Get-Content -LiteralPath $envFile | Where-Object { $_ -notmatch '^ENCODE_CI_MACHINE=' } })
Set-Content -LiteralPath $envFile -Value ($lines + 'ENCODE_CI_MACHINE=1') -Encoding Ascii

$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c start `"$task`" /min `"$RunnerDir\run.cmd`"" -WorkingDirectory $RunnerDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Say "The runner '$name' starts whenever $env:USERNAME signs in (task '$task')."

if ($AutoLogon) {
  # Windows Hello's "only Hello sign-in" setting turns automatic sign-in off.
  Set-Value 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device' 'DevicePasswordLessBuildVersion' 0
  $tool = Join-Path $downloads 'Autologon64.exe'
  Invoke-WebRequest -Uri 'https://live.sysinternals.com/Autologon64.exe' -OutFile $tool -UseBasicParsing -Headers $agent
  Assert-Signed $tool 'O=Microsoft Corporation'
  $plain = Plain $password
  try {
    & $tool /accepteula $env:USERNAME $env:USERDOMAIN $plain | Out-Null
  } finally {
    $plain = $null
    $password = $null
  }
  Remove-Item -LiteralPath $downloads -Recurse -Force -ErrorAction SilentlyContinue
  Say "This machine signs in as $env:USERNAME when it starts, and the runner starts with it."
  Say 'Restarting in 20 seconds to finish (Ctrl+C to restart later yourself)...'
  Start-Sleep -Seconds 20
  Restart-Computer -Force
  exit 0
}

Remove-Item -LiteralPath $downloads -Recurse -Force -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName $task
Say "Done. Runner '$name' should show as Idle at https://github.com/$Repository/settings/actions/runners within a minute."
Say 'Restart the VM once when you can, so every setting takes effect; the runner starts again when you sign in.'
