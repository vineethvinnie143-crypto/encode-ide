<#
.SYNOPSIS
  On your own PC: makes the Hyper-V virtual machine eNCode's CI runs in and, with -Unattended, installs Windows in it
  and sets the runner up there with nothing to click.

.DESCRIPTION
  Run it on the PC itself, not inside the VM, in Windows PowerShell started as administrator, with Hyper-V on.
  It changes nothing on the PC but the new VM and a folder of its own (%LOCALAPPDATA%\eNCode-CI).

  With -IsoPath: makes a VM named "eNCode CI" that is ready for Windows 11:
    - generation 2, with Secure Boot and a virtual TPM;
    - 4 processors, 8 GB of memory, and a 100 GB disk that only takes the space it uses;
    - the internet through Hyper-V's Default Switch;
    - starts and stops with the PC, and keeps no automatic checkpoints;
    - starts from the ISO.

  Add -Unattended (and -Token) for the rest, start to finish, in about 30 to 40 minutes:
    - Windows is installed from an answer file, with a local administrator "ci" whose generated password is kept for
      this PC's account only, encrypted by Windows (-ShowPassword prints it);
    - windows-runner.ps1, from this script's folder, is copied in and run through PowerShell Direct, which needs no
      network and no sign-in inside the VM;
    - the VM is restarted, and the script checks the runner is running on the VM's desktop.
  -Unattended needs the Windows 11 Enterprise evaluation ISO, or another ISO whose first image is the edition wanted
  (-ImageIndex picks another).

  Without -Unattended, the VM's window opens to install Windows by hand (docs/ci/windows-runner.md); -CopySetup then
  copies windows-runner.ps1 to C:\eNCode-CI in the VM.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\new-runner-vm.ps1 -IsoPath C:\eNCode-CI\Windows11-Eval.iso -Unattended -Token <token>
#>
[CmdletBinding(DefaultParameterSetName = 'Make')]
param(
  [Parameter(Mandatory, ParameterSetName = 'Make')][string]$IsoPath,
  [Parameter(ParameterSetName = 'Make')][switch]$Unattended,
  # The runner's registration token (GitHub: Settings, Actions, Runners, New self-hosted runner, the value after
  # --token). Asked for when Windows is ready if it is not given.
  [Parameter(ParameterSetName = 'Make')][string]$Token,
  [Parameter(ParameterSetName = 'Make')][ValidateRange(1, 32)][int]$ImageIndex = 1,
  [Parameter(Mandatory, ParameterSetName = 'Copy')][switch]$CopySetup,
  [Parameter(Mandatory, ParameterSetName = 'Password')][switch]$ShowPassword,
  [string]$Name = 'eNCode CI',
  [Parameter(ParameterSetName = 'Make')][ValidateRange(2, 64)][int]$Processors = 4,
  [Parameter(ParameterSetName = 'Make')][ValidateRange(4, 256)][int]$MemoryGB = 8,
  [Parameter(ParameterSetName = 'Make')][ValidateRange(64, 2048)][int]$DiskGB = 100
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Say([string]$text) { Write-Host "[encode-ci $(Get-Date -Format HH:mm:ss)] $text" }
function Fail([string]$text) { Write-Host "[encode-ci] $text" -ForegroundColor Red; exit 1 }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail 'Run PowerShell as administrator (right-click it, Run as administrator) and start this again.' }
if (-not (Get-Command New-VM -ErrorAction SilentlyContinue)) {
  Fail 'Hyper-V is not on. Turn it on with: Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All, restart the PC, and run this again. (Windows Home has no Hyper-V; docs/ci/windows-runner.md says what to use instead.)'
}

# What only this PC's account can read: the VM's account, encrypted by Windows (DPAPI).
$keep = Join-Path $env:LOCALAPPDATA 'eNCode-CI'
$credentialFile = Join-Path $keep "$Name.credential.xml"
$setup = Join-Path $PSScriptRoot 'windows-runner.ps1'
$guestServices = { $_.Id -match '6C09BB55-D683-4DA0-8931-C9BF705F6480' -or $_.Name -eq 'Guest Service Interface' }

if ($ShowPassword) {
  if (-not (Test-Path -LiteralPath $credentialFile)) { Fail "No password is kept for '$Name' on this account." }
  $credential = Import-Clixml -LiteralPath $credentialFile
  Write-Host "User: $($credential.UserName)"
  Write-Host "Password: $($credential.GetNetworkCredential().Password)"
  exit 0
}

if ($CopySetup) {
  if (-not (Test-Path -LiteralPath $setup)) { Fail "windows-runner.ps1 is not next to this script ($PSScriptRoot). Put both in one folder." }
  $vm = Get-VM -Name $Name -ErrorAction SilentlyContinue
  if (-not $vm) { Fail "There is no VM named '$Name'." }
  if ($vm.State -ne 'Running') { Fail "The VM '$Name' is not running. Start it, sign in, and run this again." }
  # Guest services carry the file; they are on from when the VM was made, and need Windows running inside it.
  $guest = Get-VMIntegrationService -VM $vm | Where-Object $guestServices
  if ($guest -and -not $guest.Enabled) { $guest | Enable-VMIntegrationService; Start-Sleep -Seconds 5 }
  Copy-VMFile -VM $vm -SourcePath $setup -DestinationPath 'C:\eNCode-CI\windows-runner.ps1' -CreateFullPath -FileSource Host -Force
  Say "Copied to C:\eNCode-CI\windows-runner.ps1 in '$Name'."
  exit 0
}

if (-not (Test-Path -LiteralPath $IsoPath)) { Fail "There is no file at $IsoPath." }
$IsoPath = (Resolve-Path -LiteralPath $IsoPath).Path
if ($Unattended -and -not (Test-Path -LiteralPath $setup)) { Fail "windows-runner.ps1 is not next to this script ($PSScriptRoot). Put both in one folder." }
if (Get-VM -Name $Name -ErrorAction SilentlyContinue) { Fail "A VM named '$Name' exists already. Remove it in Hyper-V Manager first, or pass -Name with another name." }
if (-not (Get-VMSwitch -Name 'Default Switch' -ErrorAction SilentlyContinue)) { Fail "Hyper-V's 'Default Switch' is missing, so the VM would have no internet. Restart the PC once after turning Hyper-V on; it makes the switch." }

# What the PC can spare: at most all but one of its processors, and half its memory.
$Processors = [Math]::Min($Processors, [Math]::Max(2, [Environment]::ProcessorCount - 1))
$hostGB = [Math]::Floor((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
if ($MemoryGB -gt [Math]::Floor($hostGB / 2)) {
  $MemoryGB = [Math]::Max(4, [Math]::Floor($hostGB / 2))
  Say "The PC has $hostGB GB of memory; the VM gets $MemoryGB GB."
}

$vhd = Join-Path (Get-VMHost).VirtualHardDiskPath "$Name.vhdx"
if (Test-Path -LiteralPath $vhd) { Fail "$vhd exists already, from an earlier VM. Delete it or pass -Name with another name." }

# ---------------------------------------------------------------- the answer file, on a disc of its own

$answerIso = $null
$credential = $null
if ($Unattended) {
  New-Item -ItemType Directory -Path $keep -Force | Out-Null
  # Letters and digits only, so it needs no escaping in the answer file; 24 of them from the system's generator.
  $alphabet = [char[]]'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $plain = 'Ci' + (-join ($bytes | ForEach-Object { $alphabet[$_ % $alphabet.Length] })) + '7'
  $credential = New-Object Management.Automation.PSCredential('ci', (ConvertTo-SecureString $plain -AsPlainText -Force))
  $credential | Export-Clixml -LiteralPath $credentialFile

  $component = 'processorArchitecture="amd64" publicKeyToken="31bf3856ad364e35" language="neutral" versionScope="nonSxS"'
  $answer = @"
<?xml version="1.0" encoding="utf-8"?>
<unattend xmlns="urn:schemas-microsoft-com:unattend" xmlns:wcm="http://schemas.microsoft.com/WMIConfig/2002/State">
  <settings pass="windowsPE">
    <component name="Microsoft-Windows-International-Core-WinPE" $component>
      <SetupUILanguage><UILanguage>en-US</UILanguage></SetupUILanguage>
      <InputLocale>en-US</InputLocale><SystemLocale>en-US</SystemLocale><UILanguage>en-US</UILanguage><UserLocale>en-US</UserLocale>
    </component>
    <component name="Microsoft-Windows-Setup" $component>
      <DiskConfiguration>
        <Disk wcm:action="add">
          <DiskID>0</DiskID>
          <WillWipeDisk>true</WillWipeDisk>
          <CreatePartitions>
            <CreatePartition wcm:action="add"><Order>1</Order><Type>EFI</Type><Size>300</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>2</Order><Type>MSR</Type><Size>16</Size></CreatePartition>
            <CreatePartition wcm:action="add"><Order>3</Order><Type>Primary</Type><Extend>true</Extend></CreatePartition>
          </CreatePartitions>
          <ModifyPartitions>
            <ModifyPartition wcm:action="add"><Order>1</Order><PartitionID>1</PartitionID><Format>FAT32</Format><Label>System</Label></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>2</Order><PartitionID>2</PartitionID></ModifyPartition>
            <ModifyPartition wcm:action="add"><Order>3</Order><PartitionID>3</PartitionID><Format>NTFS</Format><Label>Windows</Label><Letter>C</Letter></ModifyPartition>
          </ModifyPartitions>
        </Disk>
      </DiskConfiguration>
      <ImageInstall>
        <OSImage>
          <InstallTo><DiskID>0</DiskID><PartitionID>3</PartitionID></InstallTo>
          <InstallFrom><MetaData wcm:action="add"><Key>/IMAGE/INDEX</Key><Value>$ImageIndex</Value></MetaData></InstallFrom>
        </OSImage>
      </ImageInstall>
      <UserData><AcceptEula>true</AcceptEula></UserData>
    </component>
  </settings>
  <settings pass="specialize">
    <component name="Microsoft-Windows-Shell-Setup" $component>
      <ComputerName>CI-VM</ComputerName>
      <TimeZone>UTC</TimeZone>
    </component>
    <component name="Microsoft-Windows-Deployment" $component>
      <RunSynchronous>
        <RunSynchronousCommand wcm:action="add">
          <Order>1</Order>
          <Path>reg add HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System /v LocalAccountTokenFilterPolicy /t REG_DWORD /d 1 /f</Path>
        </RunSynchronousCommand>
      </RunSynchronous>
    </component>
  </settings>
  <settings pass="oobeSystem">
    <component name="Microsoft-Windows-International-Core" $component>
      <InputLocale>en-US</InputLocale><SystemLocale>en-US</SystemLocale><UILanguage>en-US</UILanguage><UserLocale>en-US</UserLocale>
    </component>
    <component name="Microsoft-Windows-Shell-Setup" $component>
      <OOBE>
        <HideEULAPage>true</HideEULAPage>
        <HideOEMRegistrationScreen>true</HideOEMRegistrationScreen>
        <HideOnlineAccountScreens>true</HideOnlineAccountScreens>
        <HideWirelessSetupInOOBE>true</HideWirelessSetupInOOBE>
        <HideLocalAccountScreen>true</HideLocalAccountScreen>
        <ProtectYourPC>3</ProtectYourPC>
      </OOBE>
      <UserAccounts>
        <LocalAccounts>
          <LocalAccount wcm:action="add">
            <Name>ci</Name>
            <Group>Administrators</Group>
            <Password><Value>$plain</Value><PlainText>true</PlainText></Password>
          </LocalAccount>
        </LocalAccounts>
      </UserAccounts>
      <AutoLogon>
        <Enabled>true</Enabled>
        <Username>ci</Username>
        <LogonCount>1</LogonCount>
        <Password><Value>$plain</Value><PlainText>true</PlainText></Password>
      </AutoLogon>
    </component>
  </settings>
</unattend>
"@
  $plain = $null
  $folder = Join-Path $keep 'answer'
  Remove-Item -LiteralPath $folder -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $folder -Force | Out-Null
  Set-Content -LiteralPath (Join-Path $folder 'autounattend.xml') -Value $answer -Encoding UTF8
  $answer = $null

  # A disc image made with Windows' own image mastering service; Windows Setup reads autounattend.xml from a disc.
  if (-not ('EncodeCi.IsoWriter' -as [type])) {
    Add-Type -TypeDefinition @'
namespace EncodeCi {
  public static class IsoWriter {
    public static void Write(string path, object stream, int blockSize, int totalBlocks) {
      var source = (System.Runtime.InteropServices.ComTypes.IStream)stream;
      var buffer = new byte[blockSize];
      using (var target = System.IO.File.Create(path)) {
        for (int i = 0; i < totalBlocks; i++) {
          source.Read(buffer, blockSize, System.IntPtr.Zero);
          target.Write(buffer, 0, blockSize);
        }
      }
    }
  }
}
'@
  }
  $image = New-Object -ComObject IMAPI2FS.MsftFileSystemImage
  $image.FileSystemsToCreate = 3
  $image.VolumeName = 'ENCODE_CI'
  $image.Root.AddTree($folder, $false)
  $result = $image.CreateResultImage()
  $answerIso = Join-Path $keep 'answer.iso'
  [EncodeCi.IsoWriter]::Write($answerIso, $result.ImageStream, $result.BlockSize, $result.TotalBlocks)
  Remove-Item -LiteralPath $folder -Recurse -Force
  Say 'Made the answer file for an installation with nothing to click.'
}

# ---------------------------------------------------------------- the VM

$vm = New-VM -Name $Name -Generation 2 -MemoryStartupBytes ([int64]$MemoryGB * 1GB) -NewVHDPath $vhd -NewVHDSizeBytes ([int64]$DiskGB * 1GB) -SwitchName 'Default Switch'
Set-VM -VM $vm -ProcessorCount $Processors -StaticMemory -AutomaticCheckpointsEnabled $false -AutomaticStartAction Start -AutomaticStartDelay 30 -AutomaticStopAction ShutDown
Set-VMKeyProtector -VM $vm -NewLocalKeyProtector
Enable-VMTPM -VM $vm
$dvd = Add-VMDvdDrive -VM $vm -Path $IsoPath -Passthru
if ($answerIso) { Add-VMDvdDrive -VM $vm -Path $answerIso }
Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows -FirstBootDevice $dvd
Get-VMIntegrationService -VM $vm | Where-Object $guestServices | Enable-VMIntegrationService
Say "Made '$Name': $Processors processors, $MemoryGB GB of memory, a $DiskGB GB disk at $vhd."

if (-not $Unattended) {
  # The window first, so the "Press any key to boot from CD or DVD" prompt is on screen when it shows.
  Start-Process -FilePath vmconnect.exe -ArgumentList 'localhost', "`"$Name`""
  Start-Sleep -Seconds 3
  Start-VM -VM $vm
  Say 'Started. In its window, press a key when it says "Press any key to boot from CD or DVD".'
  Say 'Missed it ("No operating system was loaded")? In the window: Action, Reset, then press a key at once.'
  exit 0
}

# ---------------------------------------------------------------- Windows, installed with nothing to click

# The disc asks for a key press before it starts; the VM's own keyboard gives it one.
function Start-FromDisc {
  Start-VM -VM $vm
  $system = Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_ComputerSystem -Filter "Name='$($vm.Id)'"
  $deadline = (Get-Date).AddSeconds(40)
  while ((Get-Date) -lt $deadline) {
    try {
      $keyboard = Get-CimAssociatedInstance -InputObject $system -ResultClassName Msvm_Keyboard
      if ($keyboard) { Invoke-CimMethod -InputObject $keyboard -MethodName TypeKey -Arguments @{ keyCode = [uint32]13 } | Out-Null }
    } catch { }
    Start-Sleep -Milliseconds 700
  }
}

function Session-Or-Null {
  try { New-PSSession -VMName $Name -Credential $credential -ErrorAction Stop } catch { $null }
}

Say 'Starting Windows Setup in the VM; it installs on its own in about 20 to 30 minutes.'
$session = $null
for ($attempt = 1; $attempt -le 3 -and -not $session; $attempt++) {
  Start-FromDisc
  $started = Get-Date
  while (-not $session) {
    Start-Sleep -Seconds 30
    $minutes = [int]((Get-Date) - $started).TotalMinutes
    $written = [Math]::Round((Get-Item -LiteralPath $vhd).Length / 1GB, 1)
    # Setup writes gigabytes within minutes; a disk still nearly empty means the disc never started.
    if ($minutes -ge 6 -and $written -lt 0.5) {
      Say "Windows Setup did not start (attempt $attempt of 3); trying again."
      Stop-VM -VM $vm -TurnOff -Force
      break
    }
    if ($minutes -ge 90) { Fail "Windows is not ready after 90 minutes. Open the VM in Hyper-V Manager to see where it stopped." }
    $session = Session-Or-Null
    if (-not $session) { Say "Installing... $minutes min, $written GB written." }
  }
}
if (-not $session) { Fail "Windows Setup did not start from $IsoPath. Open the VM in Hyper-V Manager to see what it shows." }
# The account exists before its first sign-in has finished: wait for its desktop.
$ready = $false
$deadline = (Get-Date).AddMinutes(15)
while ((Get-Date) -lt $deadline) {
  $ready = Invoke-Command -Session $session -ScriptBlock {
    $explorer = @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'")
    @($explorer | Where-Object { (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User -eq 'ci' }).Count -gt 0
  }
  if ($ready) { break }
  Start-Sleep -Seconds 15
}
if (-not $ready) { Fail 'Windows is installed, but its desktop did not come up within 15 minutes. Open the VM in Hyper-V Manager to see what it shows.' }
Say 'Windows is installed and signed in.'

# ---------------------------------------------------------------- the runner, set up through PowerShell Direct

if (-not $Token) {
  Start-Process 'https://github.com/vineethvinnie143-crypto/encode-ide/settings/actions/runners/new?arch=x64&os=win'
  $secure = Read-Host -AsSecureString 'Registration token (the page that just opened; the value after --token)'
  $Token = (New-Object Management.Automation.PSCredential('token', $secure)).GetNetworkCredential().Password
}

Invoke-Command -Session $session -ScriptBlock { New-Item -ItemType Directory -Path 'C:\eNCode-CI' -Force | Out-Null }
Copy-Item -ToSession $session -LiteralPath $setup -Destination 'C:\eNCode-CI\windows-runner.ps1' -Force
Say 'Setting the runner up inside the VM (5 to 10 minutes)...'
$code = @(Invoke-Command -Session $session -ArgumentList $Token, $credential.Password -ScriptBlock {
  param($token, $password)
  Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
  & 'C:\eNCode-CI\windows-runner.ps1' -Token $token -Password $password -AutoLogon -NoRestart | Out-Host
  $LASTEXITCODE
})[-1]
$Token = $null
Remove-PSSession -Session $session
if ("$code" -ne '0') { Fail "The setup inside the VM failed (exit code $code); its messages are above. Run this step again with a new token: powershell -ExecutionPolicy Bypass -File .\new-runner-vm.ps1 -CopySetup, then the setup in the VM." }

Say 'Restarting the VM, which now signs in by itself...'
Stop-VM -VM $vm -Force
# The installation discs go, and the VM starts from its disk from now on.
Get-VMDvdDrive -VM $vm | Remove-VMDvdDrive
Set-VMFirmware -VM $vm -FirstBootDevice (Get-VMHardDiskDrive -VM $vm | Select-Object -First 1)
Remove-Item -LiteralPath $answerIso -Force -ErrorAction SilentlyContinue
Start-VM -VM $vm
$session = $null
$deadline = (Get-Date).AddMinutes(10)
while (-not $session -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 15; $session = Session-Or-Null }
if (-not $session) { Fail 'The VM did not come back within 10 minutes. Open it in Hyper-V Manager to see what it shows.' }
$state = $null
$deadline = (Get-Date).AddMinutes(3)
while ((Get-Date) -lt $deadline) {
  $state = Invoke-Command -Session $session -ScriptBlock {
    Add-Type -Namespace EncodeCi -Name Console -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();' -ErrorAction SilentlyContinue
    $console = [EncodeCi.Console]::WTSGetActiveConsoleSessionId()
    $runner = @(Get-Process -Name Runner.Listener -ErrorAction SilentlyContinue)
    [pscustomobject]@{ Running = $runner.Count -gt 0; OnDesktop = @($runner | Where-Object { $_.SessionId -eq $console }).Count -gt 0 }
  }
  if ($state.OnDesktop) { break }
  Start-Sleep -Seconds 10
}
Remove-PSSession -Session $session
if (-not $state.OnDesktop) { Fail "The runner is not running on the VM's desktop (running: $($state.Running)). Open the VM in Hyper-V Manager to see what it shows." }
Say "Done. The runner is running on the VM's desktop, and shows as Idle on GitHub's Runners page within a minute."
Say "The VM starts with this PC and signs in by itself. Its window can stay closed; to look at it: vmconnect localhost `"$Name`"."
