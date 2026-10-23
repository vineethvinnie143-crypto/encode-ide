# eNCode's Windows runner

Every CI job runs on a GitHub Actions runner of eNCode's own: a Windows 11 virtual machine on Vineeth's PC. That
covers all of `ci.yml` (artifact storage and the Windows build), `desktop.yml` and `sandbox.yml`.

## Why a runner of our own, and why in a VM

- **Minutes.** The account's included Actions minutes ran out on 2026-10-23, so GitHub's runners stopped taking
  jobs. A self-hosted runner uses none.
- **Why not the everyday account.** The checks open windows and use the mouse and keyboard. They also install and
  uninstall eNCode, and start the packaged program on the real profile (`%APPDATA%\eNCode`, `~\.encode`,
  `Documents\eNCode`, the Start menu). On someone's own account they would take over the desktop and replace that
  person's eNCode data. A VM kept for CI is a machine of its own, as GitHub's runner is.
- **Two guards keep them off any other machine.** Both refuse a self-hosted runner without `ENCODE_CI_MACHINE=1`, which
  only `scripts/ci/windows-runner.ps1` sets (in the runner's `.env`):
  - `scripts/ci/tidy-runner.ps1 -Start`, at the start of a job;
  - the packaged and installer smokes.

## Where jobs run

- **The default.** `runs-on` is `${{ fromJSON(vars.ENCODE_WINDOWS_RUNNER || '["self-hosted","windows","encode"]') }}`.
- **Back to GitHub's runners**, which costs minutes: add a repository variable (Settings, Secrets and variables,
  Actions, Variables) named `ENCODE_WINDOWS_RUNNER`, with the value `"windows-latest"`, quotes included.
- **Back to the VM:** delete that variable.

## Setting it up with nothing to click (about 40 minutes)

This is how the VM on Vineeth's PC is made. It needs Hyper-V on (step 1 below, and virtualization on in the PC's
firmware), the Windows 11 Enterprise evaluation ISO (step 2), both scripts in one folder, and a registration token
(step 7). Then, in PowerShell as administrator:

```powershell
powershell -ExecutionPolicy Bypass -File .\new-runner-vm.ps1 -IsoPath <the ISO> -Unattended -Token <token> -Processors 6 -DiskGB 80
```

What it does, start to finish:

1. **Makes the VM** as in step 4 below.
2. **Installs Windows from an answer file**, on a second disc made with Windows' own image mastering service:
   - the disk is wiped and partitioned for UEFI, and the ISO's first image goes on it;
   - setup asks nothing, and the account is a local administrator `ci`;
   - the account's generated password is kept only for the PC's account, encrypted by Windows, in
     `%LOCALAPPDATA%\eNCode-CI` (`-ShowPassword` prints it).
3. **Starts the disc without a key press.** The VM's own keyboard presses one at the disc's prompt. A disk still empty
   after 6 minutes means the disc never started, and the script tries again, up to 3 times.
4. **Waits for Windows.** It waits until PowerShell Direct reaches the account and its desktop is up.
5. **Runs the setup inside the VM.** It copies `windows-runner.ps1` in and runs it through PowerShell Direct with the
   token and password, so nothing is asked. PowerShell Direct goes over Hyper-V's own channel; it needs no network and
   no sign-in inside the VM. The answer file sets `LocalAccountTokenFilterPolicy` so that this session has
   administrator rights.
6. **Restarts the VM from its disk.** The discs are removed, the VM restarts from its disk, and the script checks that
   the runner is running on the VM's desktop.

Vineeth approved the settings this makes inside the VM on 2026-10-23: automatic sign-in, a password that never
expires, Smart App Control off, Defender skipping `C:\actions-runner`, and administrator rights through PowerShell
Direct. None of them touch the PC's own account.

## Setting it up by hand (about 45 minutes, most of it Windows installing)

This needs Windows Pro, Enterprise or Education on the PC for Hyper-V. Settings, System, About shows the edition. On
Windows Home, see below.

1. **Turn on Hyper-V.** In PowerShell as administrator, run
   `Enable-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V -All`, then restart the PC. If it says
   virtualization is off, turn on Intel VT-x or AMD SVM in the PC's firmware settings first.
2. **Get Windows 11.** Download the ISO of Windows 11 Enterprise evaluation from Microsoft's Evaluation Center. It is
   free and runs 90 days. A Windows 11 ISO from microsoft.com with a licence of your own also works.
3. **Get the two scripts.** Put `scripts/ci/new-runner-vm.ps1` and `scripts/ci/windows-runner.ps1` in one folder on
   the PC.
4. **Make the VM.** In that folder, in PowerShell as administrator, run:
   `powershell -ExecutionPolicy Bypass -File .\new-runner-vm.ps1 -IsoPath <path to the ISO>`.
   - It makes the VM "eNCode CI" and opens its window.
   - Press a key when the window says "Press any key to boot from CD or DVD".
   - Missed it? Action, Reset, then press a key at once.
5. **Install Windows in it.**
   - Choose Custom install, onto the one disk.
   - When it asks you to sign in, choose Sign-in options, then Domain join instead. Make a local account, for example
     `ci`, with a password.
   - Turn every privacy option off.
6. **Copy the setup script in.** On the PC, in the same folder, run:
   `powershell -ExecutionPolicy Bypass -File .\new-runner-vm.ps1 -CopySetup`.
   It puts the script at `C:\eNCode-CI\windows-runner.ps1` in the VM. Nothing needs signing in inside the VM.
7. **Get a token.** In the PC's browser, open
   https://github.com/vineethvinnie143-crypto/encode-ide/settings/actions/runners/new?arch=x64&os=win and copy the
   value after `--token`. It is good for an hour.
8. **Run the setup in the VM.**
   - Open Start, type `powershell`, and choose Run as administrator.
   - Run `powershell -ExecutionPolicy Bypass -File C:\eNCode-CI\windows-runner.ps1 -AutoLogon`.
   - At the token prompt, use the VM window's Clipboard menu, Type clipboard text, then press Enter.
   - Type the account's password.
   - It installs what the checks need, registers the runner, and restarts the VM after 5 to 10 minutes.
9. **Check it.** The VM signs in by itself, and a minimized "eNCode CI runner" window starts. GitHub's Runners page
   (Settings, Actions, Runners) shows `encode-<name>` as Idle. Jobs that were waiting start on their own.

### Windows Home

Home has no Hyper-V. Use VirtualBox 7 instead.

- **Make the VM.** Make one from the ISO as Windows 11 (64-bit), with 8 GB of memory, 4 processors and a 100 GB disk.
  VirtualBox turns on EFI, TPM 2.0 and Secure Boot for that type itself. Then install Windows as in step 5.
- **Get the script into the VM.**
  1. In the VM's Edge, open an InPrivate window (Ctrl+Shift+N) and sign in to GitHub.
  2. Open `scripts/ci/windows-runner.ps1` on the pull request's branch and save its Raw file to `C:\eNCode-CI`.
  3. Close the InPrivate window, so that no GitHub sign-in stays in the VM.
- **Finish.** Do steps 7 to 9. Type the token, or paste it with VirtualBox's shared clipboard (Devices, Shared Clipboard,
  Host To Guest) once its Guest Additions are installed.
- **After each PC restart,** start the VM with Start, Headless start. When closing its window, choose Continue
  running in the background.

## Day to day

- **Keep the VM running.** Its window can be closed at any time, and the VM keeps running and signed in.
- **Basic session only.** Leave the window's View, Enhanced session unticked. An enhanced session is a remote
  desktop, and once its window closes there is no screen for the checks. If that happens, restart the VM.
- **The PC.** The VM starts with the PC and stops with it. While the PC is off, jobs wait for up to 24 hours and start
  when it is back.
- **Updates.** The runner updates itself. Windows Update may restart the VM; it signs in again by itself.
- **The evaluation edition ends after 90 days.** Make a new VM the same way (steps 4 to 9), or activate a licence.

## How the VM differs from GitHub's runner, and what makes up for it

| GitHub's runner | eNCode's VM | What makes up for it |
| --- | --- | --- |
| A new machine for every job | Kept from job to job | `tidy-runner.ps1 -Start` removes eNCode's data from an earlier job; `tidy-runner.ps1` after a job stops whatever the job left running |
| Always has a desktop | Has one only while signed in on its own screen | The VM signs in by itself, and `-Start` fails with a plain message if the desktop is locked or in a remote session |
| Git, PowerShell 7, the Visual C++ runtime, long paths, local scripts allowed | A new Windows | `windows-runner.ps1` sets each of these up |

## Safety

- **Nothing shared with the PC.** No shared folders, no shared clipboard in a basic session, and no personal sign-in
  inside the VM. It reaches the internet through Hyper-V's Default Switch.
- **Who can run code there.** Only this repository's workflows run there. Keep the repository private: on a public
  repository, anyone's pull request could run code on the machine, which is why GitHub advises against self-hosted
  runners for public repositories.
- **What a job's token can do.** It is read-only, except for the storage job, which may delete this repository's
  artifacts.
- **Downloads are checked before they run.** `windows-runner.ps1` checks each file it downloads before running it:
  - GitHub's release files (the runner, Git and PowerShell) against the SHA-256 digest GitHub publishes;
  - Microsoft's files (the Visual C++ runtime and Autologon) against Microsoft's signature.
- **The password for signing in automatically** is kept by Windows, encrypted, through Sysinternals Autologon.

## Taking it down

1. On GitHub's Runners page, remove `encode-<name>`.
2. In Hyper-V Manager, delete the VM, then delete its disk (`eNCode CI.vhdx`).
