<#
.SYNOPSIS
  On your own PC: makes the Hyper-V virtual machine eNCode's CI runs in, or copies the runner's setup script into it.

.DESCRIPTION
  Run it on the PC itself, not inside the VM, in Windows PowerShell started as administrator, with Hyper-V on.
  It changes nothing on the PC but the new VM.

  First, with -IsoPath: makes a VM named "eNCode CI", ready for Windows 11 (generation 2, Secure Boot and a virtual
  TPM), with 4 processors, 8 GB of memory and a 100 GB disk that only takes the space it uses. It reaches the internet
  through Hyper-V's Default Switch, starts and stops with the PC, keeps no automatic checkpoints, and starts from the
  ISO. Its window opens: press a key when it asks, to install Windows from the ISO.

  Then, with -CopySetup, once Windows is installed in it and signed in: copies windows-runner.ps1, from the folder this
  script is in, to C:\eNCode-CI in the VM. Nothing has to be signed in inside the VM for it.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\new-runner-vm.ps1 -IsoPath "$env:USERPROFILE\Downloads\Windows11.iso"

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\new-runner-vm.ps1 -CopySetup
#>
[CmdletBinding(DefaultParameterSetName = 'Make')]
param(
  [Parameter(Mandatory, ParameterSetName = 'Make')][string]$IsoPath,
  [Parameter(Mandatory, ParameterSetName = 'Copy')][switch]$CopySetup,
  [string]$Name = 'eNCode CI',
  [Parameter(ParameterSetName = 'Make')][ValidateRange(2, 64)][int]$Processors = 4,
  [Parameter(ParameterSetName = 'Make')][ValidateRange(4, 256)][int]$MemoryGB = 8,
  [Parameter(ParameterSetName = 'Make')][ValidateRange(64, 2048)][int]$DiskGB = 100
)

$ErrorActionPreference = 'Stop'

function Say([string]$text) { Write-Host "[encode-ci] $text" }
function Fail([string]$text) { Write-Host "[encode-ci] $text" -ForegroundColor Red; exit 1 }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { Fail 'Run PowerShell as administrator (right-click it, Run as administrator) and start this again.' }
if (-not (Get-Command New-VM -ErrorAction SilentlyContinue)) {
  Fail 'Hyper-V is not on. Turn it on with: Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All, restart the PC, and run this again. (Windows Home has no Hyper-V; docs/ci/windows-runner.md says what to use instead.)'
}

if ($CopySetup) {
  $setup = Join-Path $PSScriptRoot 'windows-runner.ps1'
  if (-not (Test-Path -LiteralPath $setup)) { Fail "windows-runner.ps1 is not next to this script ($PSScriptRoot). Put both in one folder." }
  $vm = Get-VM -Name $Name -ErrorAction SilentlyContinue
  if (-not $vm) { Fail "There is no VM named '$Name'." }
  if ($vm.State -ne 'Running') { Fail "The VM '$Name' is not running. Start it, sign in, and run this again." }
  # Guest services carry the file; they are on from when the VM was made, and need Windows running inside it.
  $guest = Get-VMIntegrationService -VM $vm | Where-Object { $_.Id -match '6C09BB55-D683-4DA0-8931-C9BF705F6480' -or $_.Name -eq 'Guest Service Interface' }
  if ($guest -and -not $guest.Enabled) { $guest | Enable-VMIntegrationService; Start-Sleep -Seconds 5 }
  Copy-VMFile -VM $vm -SourcePath $setup -DestinationPath 'C:\eNCode-CI\windows-runner.ps1' -CreateFullPath -FileSource Host -Force
  Say "Copied to C:\eNCode-CI\windows-runner.ps1 in '$Name'."
  exit 0
}

if (-not (Test-Path -LiteralPath $IsoPath)) { Fail "There is no file at $IsoPath." }
$IsoPath = (Resolve-Path -LiteralPath $IsoPath).Path
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

$vm = New-VM -Name $Name -Generation 2 -MemoryStartupBytes ([int64]$MemoryGB * 1GB) -NewVHDPath $vhd -NewVHDSizeBytes ([int64]$DiskGB * 1GB) -SwitchName 'Default Switch'
Set-VM -VM $vm -ProcessorCount $Processors -StaticMemory -AutomaticCheckpointsEnabled $false -AutomaticStartAction Start -AutomaticStartDelay 30 -AutomaticStopAction ShutDown
Set-VMKeyProtector -VM $vm -NewLocalKeyProtector
Enable-VMTPM -VM $vm
$dvd = Add-VMDvdDrive -VM $vm -Path $IsoPath -Passthru
Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate MicrosoftWindows -FirstBootDevice $dvd
Get-VMIntegrationService -VM $vm | Where-Object { $_.Id -match '6C09BB55-D683-4DA0-8931-C9BF705F6480' -or $_.Name -eq 'Guest Service Interface' } | Enable-VMIntegrationService
Say "Made '$Name': $Processors processors, $MemoryGB GB of memory, a $DiskGB GB disk at $vhd."

# The window first, so the "Press any key to boot from CD or DVD" prompt is on screen when it shows.
Start-Process -FilePath vmconnect.exe -ArgumentList 'localhost', "`"$Name`""
Start-Sleep -Seconds 3
Start-VM -VM $vm
Say 'Started. In its window, press a key when it says "Press any key to boot from CD or DVD".'
Say 'Missed it ("No operating system was loaded")? In the window: Action, Reset, then press a key at once.'
