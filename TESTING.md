# Testing eNCode

This is for the people trying the tester builds: the owner and a few friends. A tester build changes often, is not
signed and does not update itself. Windows 10 or 11, 64-bit.

## Get it

Every build that reaches `main` is kept for 30 days as an artifact of its CI run (GitHub → Actions → the run →
*Artifacts*), named `eNCode-windows-<commit>-run<number>`. It holds:

| File | Use it when |
| --- | --- |
| `eNCode-<version>-setup.exe` | Normally. Installs for your user only, with no administrator prompt, and adds a Start menu entry. |
| `eNCode-<version>-portable.exe` | You cannot or do not want to install. Nothing is installed, and it starts more slowly because it unpacks itself each time. |

## First start

1. Windows says **"Windows protected your PC"** because the build is not signed. Choose **More info**, then **Run
   anyway**. This is expected for every tester build.
2. Open **Help → About eNCode** and check that the commit matches what you were told you are testing.
3. A **Connect a model** window opens on the first start. Choose how eNCode reaches a model:
   - **Free models** needs a free OpenRouter key (create one at openrouter.ai/keys, no payment needed). eNCode picks a
     free model that works and moves to the next when one is busy or refused.
   - **My own API key** takes a key from OpenRouter, Anthropic, OpenAI, DeepSeek or any compatible provider, or a model
     running on your computer (Ollama, LM Studio). The key is checked before anything else, and a model of your own is
     asked for a real tool call, because a model that cannot call tools cannot drive the agent.
   - **Offline demo** runs a scripted plan against a folder you open, so approvals, diffs and the shell can be tried
     with no key at all. **Skip for now** does the same.
4. Keys are sealed by Windows (DPAPI) and go only to the server they were entered for. A key that is refused is
   explained in words, with a way to try again.

## Models

- The **model button** in the message box lists what is in use, the free models and each connection's models. Type to
  narrow the list; **Connect a model…** and **Roles** are at the bottom.
- **Settings → Roles** sets **Only use free models** (on until you choose a model that costs money, which asks first),
  which model does which job (writing, exploring, planning, reviewing, summarizing, small tasks) with a fallback order,
  and how each connection is doing: whether its key works, how many models, how many free requests are left today, and
  what is paused until when. **Check again** lifts a pause after you changed a key or added credit.
- Free models can be slower and busier than paid ones, and their providers may keep and learn from what you send. For
  private code, use a key of your own.
- A paid key is never used for a call you did not choose: with **Only use free models** on, billed models are skipped,
  and a failed call is never retried on a second key or on a billed model after a free one.

## Stay safe

- The default is **Workspace Write**: edits inside the open folder go through, and the agent asks before every command
  and before it touches anything outside the folder. Leave it there. **Full access** lets the agent run commands without
  asking.
- Open a **copy** of a project you care about, not the only copy.
- eNCode sends nothing anywhere except your requests to the model provider you chose and, when you approve it, the web
  pages the agent fetches. There is no telemetry and no update check.

## Permissions and trust

- A folder you open is **not trusted**. Its own settings (`.encode/settings.json`) cannot allow anything until you
  trust the folder and approve what they say; they can still forbid things. Open **Settings → Permissions** to see
  the folder's state, what its settings are waiting to grant, and every rule that applies.
- Approve a command with **Always allow**. The card shows the rule it will save and where (by default
  `.encode/settings.local.json`, which only you have, and git is asked to ignore it). Run the same command again: it
  should not ask. A different command should.
- Add a rule by hand under **Settings → Permissions** (for example, never allow `Read(./.env)`) and watch the agent
  refuse it. Remove it again.
- Change `.encode/settings.json` yourself, or pull a change to it: a banner should appear above the message box, and
  the rules it adds should wait until you approve.
- Put a typo in a settings file (`{ "permissions": ` and nothing else). Nothing should run in that folder, and the
  banner and the Permissions tab should say which file and what is wrong. Fix the file; it should work again.

What is most useful to hear: anything that asked when a rule said it would not, anything that did not ask when it
should have, and any message you could not understand.

## Hooks and rewind

- Ask the agent to change a file and add another. Under each of your requests, **Rewind** (the arrow next to Copy)
  opens a dialog that lists every file the agent changed since: what will be put back and what will be deleted. Choose
  **Code only** and press **Put the files back**; the files should be exactly as they were. Press **Undo** in the notice
  that appears and they should come back.
- Edit one of those files yourself after the agent did, then rewind: it should be marked **Changed since** and left
  alone unless you tick the box to overwrite it. The agent's other files still go back.
- **Code and conversation** also goes back in the conversation: your request returns to the message box so you can
  change it and send it again.
- Changes made by commands the agent ran (installs, builds, git) are not recorded, and the dialog says so. Open a
  copy of a project you care about.
- Hooks: add this to `.encode/settings.local.json` in a project (only you have that file):
  `{ "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [ { "type": "command", "command": "echo \"no commands here\" 1>&2; exit 2" } ] } ] } }`
  Trust the folder under **Settings → Permissions**, then ask for a command: it should be refused with that text and
  never ask. Take the trust back and it should ask again. A typo in the hooks of a settings file should stop work in
  that folder and say where, rather than quietly drop the guard.

What is most useful to hear: any change the rewind did not put back, any file it overwrote that you did not tell it
to, and any hook that ran when the folder was not trusted.

## Computer use

**Settings → Agent → Let the agent use this computer** is off until you turn it on. With it on, ask the agent to do
something in a program that has no command line (change a setting, fill in a form, use a program's menus). The first
use of each program asks. While it works, a banner at the bottom of the screen says so:

- **Stop** on the banner, or **Ctrl+Alt+Esc** from any window, ends the turn. Using the mouse or keyboard yourself stops
  it too, and the agent waits for you to say whether to go on.
- It never uses terminals, password managers, programs running as administrator or eNCode itself, and never types into a
  password field. The model gets a picture of the program's window only (if it can read images), the newest one only, and no picture is saved in the conversation.
- The first use builds a small helper program from source that ships with eNCode; it takes a few seconds. If an
  antivirus program blocks it, the message names the file to allow.

What is most useful to hear: any click that landed in the wrong place, any step where it said it had done something
that had not happened, and anything that kept the banner up when nothing was running.

## What to try

Open a folder you know well and use eNCode for the work you would do anyway: ask it to explain code, make a change,
run the tests and fix what fails, then review the diff. Stop it in the middle of a turn. Work in two sessions at once.
Edit a file in the editor by hand while the agent works in the same folder. Change the theme, the text size and the
Windows display scale (125%, 150%). Leave it open for an hour.

What is most useful to hear: where it is wrong, where it is slow, where it is confusing, and where it feels worse than
the tools you use now.

## When something goes wrong

1. **Help → Save diagnostics…** and pick a place for the file.
2. Send that file with what you did, what you expected and what happened. A screenshot helps.

The report says which build this is and what it runs on, lists the models without their keys, counts the sessions and
ends with the last 400 lines of the log. It has no API keys, no file contents and no conversations. Your user folder is
shown as `~`. A log line can still name a file or folder when something went wrong with it, and the file is plain
text: read it before you send it. **Help → Show log files** opens the folder the logs are in.

## Where things are

| What | Where |
| --- | --- |
| Settings, with keys sealed | `%APPDATA%\eNCode\eNCode-settings.json` |
| Sessions | `%APPDATA%\eNCode\sessions\` |
| Logs | `%APPDATA%\eNCode\logs\` |
| Your instructions, skills and agents | `%USERPROFILE%\.encode\` |

Updating means installing the next build over the last one: everything above stays.

## Start over, or remove it

- Uninstall from **Settings → Apps**. Your data stays.
- For a clean slate, close eNCode and delete `%APPDATA%\eNCode`.

## Known limits

- Windows only for now; macOS and Linux are not tested.
- Not signed, so SmartScreen warns on first start, and some antivirus programs look closely at a new program.
- No automatic updates: a new build is a new download.
- A network that needs a proxy does not work yet for model requests.
- The free models run on an OpenRouter key of your own; eNCode has no free service of its own yet.
- A model that lists only a few thousand tokens of context cannot hold eNCode's instructions and tools. Pick one with at least 16,000.
