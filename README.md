# TODO pane

A TODO list pane for the Claude desktop app: add, edit, check off, remove and drag to reorder tasks, and press ▶ Start to write an opening prompt for a task into the prompt box. Optionally it watches Azure DevOps and adds what needs you.

The pane opens only when you run `/todo`.

> **Agents: to add, change, tick off or remove tasks, edit `%USERPROFILE%\.claude\todo-pane\tasks.json` and nothing else.** The pane refreshes by itself. Read "Editing the list from outside" below first; the bundled skill `update-todo` (in `skills/`) is the short version. Needs plugin version 0.3.0 or newer. If `tasks.json` does not exist, do not create it (see below).

Windows only for the alerts (they use Windows Task Scheduler and Windows notifications). The list itself works anywhere.

## Setup

### For humans (2 minutes)

You need the Claude desktop app and [Node.js](https://nodejs.org) (on your PATH). For the Azure DevOps alerts you also need Windows and the [Azure CLI](https://aka.ms/installazurecliwindows) signed in with `az login`.

1. On the GitHub page of this repo press **Code → Download ZIP**.
2. In the Claude app open **Settings → Plugins → Add** and import the ZIP file.
3. Start a **new session** and type `/todo`. The pane opens.
4. Optional: press **Set up** in the pane to turn on the Azure DevOps alerts (see "Alerts" below).

Updating: download the new ZIP and import it again, then start a new session. Sessions that were already open keep the old version until you close them.

If the import is refused, the ZIP must have the `.claude-plugin` folder at its top level. GitHub's ZIP puts everything inside one extra folder; unzip it and zip the inside of that folder instead. Or use the manual route in the agent steps below.

### For AI agents (set this up on the user's machine)

Do these steps in order and check each one. Never overwrite a file or setting the user already has; merge into it. Do not touch `%USERPROFILE%\.claude\todo-pane\` (the user's data: `tasks.json`, `alerts.json`, ...).

1. **Check prerequisites.** `node --version` must work (the plugin starts `node` for its file watcher and prompt-title hook). `az --version` is needed only if the user wants alerts. The plugin loads only in the Claude desktop app (it is a pane plugin); it does nothing in a plain terminal session. If a prerequisite is missing, tell the user and stop; do not install software without asking.
2. **Get the files.** If the user has no local copy, clone this repository into a stable folder of their choice (ask, or propose `%USERPROFILE%\claude-plugins\todo-pane`; not inside a temp or session folder). The folder you want is the one containing `.claude-plugin\plugin.json`. Check that `version` in that file is 0.3.0 or newer.
3. **Register the folder.** Read `%USERPROFILE%\.claude\settings.json` (it may not exist, or may have no `env` block). Set `env.CLAUDE_CODE_PLUGIN_DIRS` to the plugin folder's absolute path, with `\\` escaped in JSON. If the variable already has a value, keep it and add the new path in the same format as the existing entries (ask the user if you cannot tell the separator). Keep every other key in the file unchanged and keep the file valid JSON. Show the user the change.
4. **Verify it loads, without opening a session of theirs.** Run a throwaway headless session and read its debug log:
   ```
   claude -p "reply ok" --max-turns 1 --debug --debug-file <log path>
   ```
   Then search the log for `todo-pane`. `hooks module todo-pane@inline loaded` means success. `did not load` followed by a reason means failure: report the reason to the user. The headless run uses the user's real data folder, so it must not create, edit or delete tasks.
5. **Tell the user what to do next:** close and reopen Claude, start a new session and type `/todo`. The pane opens only on that command. You cannot open it for them. After the first run `%USERPROFILE%\.claude\todo-pane\tasks.json` exists and the agent rules in "Editing the list from outside" apply.
6. **Alerts (only if the user asks).** Do not run the setup for them: it creates a Windows Task Scheduler job and needs the user's `az login`. Point them to the **Set up** button in the pane and to "Alerts: how they work" below.

Troubleshooting: `/todo` is "not installed" or the pane does not open → the plugin did not load; repeat step 4 and read the reason in the log, and check that the path in `CLAUDE_CODE_PLUGIN_DIRS` points at the folder that contains `.claude-plugin`. Changes to the plugin files take effect only in new sessions.

## Alerts: how they work

On first open the pane offers to set up alerts. Setup does this, after you press Set up:

1. Writes `alerts.json` with default settings if it does not exist yet, and copies `scripts/ado-watch.ps1` to `%USERPROFILE%\.claude\todo-pane\ado-watch.ps1` (the plugin refreshes this copy at every session start while alerts are on, and before every ↻ refresh).
2. Checks that your `az login` works (the script signs in with your own Azure CLI session, nothing is stored).
3. Creates a per-user scheduled job named `TodoPaneAdoWatch` that runs every `intervalMinutes` (10 by default).
4. Runs once to take a baseline (existing items do not flood the list) and sends a test notification.

Requirements: the [Azure CLI](https://aka.ms/installazurecliwindows) installed and signed in with `az login` using an account that can see the project. If `az` is missing or signed out, setup stops with a message saying which. Once running, if the sign-in expires the alerts pause, one "TODO alerts paused" notification appears (at most every 12 hours) and they resume by themselves after `az login`. If `az` is not on your PATH, add `"az": "C:\\path\\to\\az.cmd"` to `alerts.json`.

The job is read only: it never writes to Azure DevOps. It writes `inbox.json` next to the settings file; the pane reads it every minute and turns each item into a task with a link to its source.

If there are no settings yet, setup looks for your organization and project (the git remote of the open folder first, then your Azure DevOps account) and offers them as buttons; you can also type `organization/project`. The ↻ refresh button next to the pane title runs the check right now. Tasks that came from Azure DevOps get an "↗ Open" button that opens the source (ticket, or the PR for build failures) in your browser.

## In the list

- An orange **New** tag marks an open task created in the last 24 hours. It disappears when the task is started (in progress), done, or older than a day. Tasks created before this feature existed have no creation time and never get it.
- The ▾ next to the status label sets it by hand: **New** (restarts the New tag), **To do** (clears in progress, done and the New tag), **In progress** (keeps the first start time), **Done**.
- ▶ **Start** writes the opening prompt for the task into the prompt box (see Playbook). The task becomes "in progress" and the session is named after it once you submit your next prompt. ↩ **Resume** (shown for in-progress tasks) goes back to the session it was started in.
- ✎ edits the text, ✕ removes the task (asks first), the box on the left ticks it done or reopens it, the ⠇ grip drags it to a new position. Done tasks show "resolved".

What gets added, and when it closes by itself:

| Event | Task closes when |
|---|---|
| A work item is assigned to you | it is closed, resolved or reassigned |
| New bug/task under a ticket assigned to you | it is closed |
| You are mentioned in a work item comment | you reply after the mention |
| Someone replied on your PR threads | no thread is waiting on your reply |
| Your PR has a failing build (status check or build validation policy) | the build is green again |
| You are the Tester (`Custom.Tester`) of a ticket whose State is Resolved (ready to test) | the ticket leaves Resolved, or you are no longer the tester. Skipped when the ticket is also assigned to you (the assigned task covers it) |
| You are a reviewer and have not voted | you vote, or the PR closes. Once you have commented, it is dropped until the author pushes again **and** none of your threads is still waiting for an answer (a thread counts as answered when it is resolved or someone replied after you). A new push reopens the task even if you closed it by hand |

Removing (✕) an alert task makes it stay gone until its source has new activity; ticking it done keeps it in the list. One task per source: more activity on the same PR updates its task, it does not add another. A task you tick yourself stays closed until the source has new activity (for review tasks: a new push after your comments, once they are answered). Tasks closed by the watcher reopen if the source shows up again, and disappear 3 days after closing (change with `keepResolvedDays`); tasks you tick yourself expire by the same rule, and an expired alert task stays gone until its source has new activity.

## Where to change things

Everything personal lives outside the plugin, so plugin updates never overwrite it:

- `%USERPROFILE%\.claude\todo-pane\alerts.json` - settings. Fields: `organization`, `project`, `repository` (empty means all repos), `intervalMinutes` (applies when alerts are set up again), `windowDays`, `events` (set any of `assigned`, `prReplies`, `reviewer`, `failedBuild`, `mention`, `childItems`, `tester` to false), `keepResolvedDays` (how long tasks closed by the watcher stay listed as "resolved" before they are removed, default 3, 0 removes them at the next sync), `ignoreIds` (ticket or PR numbers to never alert on), `quietHours` (like `"22:00-07:00"`: no notification, the list still updates).
- `%USERPROFILE%\.claude\todo-pane\watch.log` - what the last runs did.
- Task Scheduler, job `TodoPaneAdoWatch` - or use the pane's ⏻ Turn off button.
- Skill `update-todo` (in `skills/`) - ships with the plugin; teaches Claude to edit `tasks.json` for you ("mark ticket 12345 done in my todo"). Nothing to configure.
- Plugin option `playbookPath` - optional markdown file with your own wording for the opening prompts. See `rules/playbook.example.md`.

Other files in the same folder, written by the plugin and the job (no need to edit them):

- `inbox.json` - the job's current list of items; the pane turns it into tasks every minute.
- `tasks.json` - **the task list itself**, the source of truth. See "Editing the list from outside" below.
- `tasks-backup.json` and the plugin store (`%USERPROFILE%\.claude\plugins\store\todo-pane_*.json`) - copies of the list, rewritten after every change. They are only read at session start when `tasks.json` is missing or invalid. Do not edit them.
- `tasks.rejected.json` - the text of the last `tasks.json` edit that could not be loaded (see below).
- `pending-title.json` - the title for the session started with ▶ Start; the plugin's `UserPromptSubmit` hook applies it once and deletes it.

## Editing the list from outside (for Claude, scripts, or by hand)

`%USERPROFILE%\.claude\todo-pane\tasks.json` is the task list. The pane shows exactly what is in this file. Every change made in the pane is written to it first, and an edit made to it from outside shows up in every open pane within about a second (at most a minute if the file watcher could not start). To change tasks, edit this file; nothing else is needed and the pane does not have to be open.

### Before you start

- **Where the file is:** `%USERPROFILE%\.claude\todo-pane\tasks.json` on the machine you are running on (PowerShell: `$env:USERPROFILE\.claude\todo-pane\tasks.json`; bash: `$USERPROFILE/.claude/todo-pane/tasks.json`). Every user has their own copy; never assume another person's path.
- **If the file does not exist, stop. Do not create it.** The plugin is not installed, is older than 0.3.0 (check `version` in `.claude-plugin/plugin.json`), or has not started a session since it was updated. Creating the file would replace the user's real list the next time the plugin loads. Tell the user to update the plugin and open a new session.
- **Local only:** editing the list never writes to Azure DevOps. Marking a ticket's task done does not close, comment on or change the ticket.

### How to edit it (rules for an agent)

1. Read the whole file, change what was asked, and write the whole file back (UTF-8, a JSON array). Read it right before writing: the pane, the alert job or another session may have changed it a moment ago.
2. Leave every other task exactly as it is, including its fields. Never reorder, rewrite or drop tasks you were not asked to touch.
3. Do not edit `inbox.json`, `tasks-backup.json` or the plugin store file. Only `tasks.json`.
4. After you save, the plugin may rewrite the file in its standard layout (it fills in missing ids and closing info). Read it again before the next edit.
5. Times are milliseconds since 1970 (`Date.now()`).

### Fields of a task

| Field | Meaning |
|---|---|
| `id` | Whole number, unique, never reused. Leave it out on a new task and the plugin assigns the next one. |
| `text` | Required. What the task says. |
| `isDone` | `true` or `false`. Required on existing tasks; a new task without it is open. |
| `inProgress`, `startedAt` | In progress: `inProgress: true` plus the start time. |
| `createdAt` | Creation time; drives the orange **New** tag for 24 hours. Filled in for new tasks. |
| `closedBy`, `closedAt` | Set when done: `"user"` for a task you or the user closed, `"auto"` when the alert job closed it. Filled in for you when you set `isDone: true`; removed when you reopen. |
| `key`, `rev`, `url` | Only on tasks the alerts added. Do not change them (see below). |
| `sessionId`, `appSessionId` | The session a task was started in (for Resume). Do not change. |

### Recipes

The first task in the array is shown first.

- **Add a task:** insert `{"text": "Review the release notes"}` at the start of the array. Nothing else is needed.
- **Mark done:** set `"isDone": true` (and remove `"inProgress"` or set it to `false`). `closedBy: "user"` and `closedAt` are filled in. A done task shows as "resolved" and is removed after `keepResolvedDays` (3 by default).
- **Reopen / To do:** `"isDone": false`, `"inProgress": false`, and delete `startedAt`.
- **In progress:** `"isDone": false`, `"inProgress": true`, `"startedAt": <now>` (keep an existing `startedAt`).
- **New:** `"isDone": false`, `"inProgress": false`, `"createdAt": <now>`, delete `startedAt`.
- **Edit the text:** change `text`.
- **Remove a task:** delete its object. For a task that has a `key`, the removal is remembered like the ✕ button, so it stays gone until its source has new activity. When the user only says a task is finished, mark it done instead of deleting it.
- **Reorder:** move the object within the array.

### Finding the right task

Tasks the alerts added have a `key` that starts with the kind of event and ends with the ticket or PR number: `wi-assigned:12345` (assigned to you), `wi-mention:12345` (you were mentioned), `wi-tester:12345` (you are the tester), `wi-child:…` (new child item), `pr-reply:67890` (replies on your PR), `pr-review:…` (you are a reviewer), `pr-build:…` (failing build). The same ticket can have several tasks (assigned and mentioned, for example). Match on the number in `key` or `text`. If more than one fits and the user did not say which, ask, or change all of them only when they asked for the whole ticket.

Alert tasks close and reopen by themselves when the source changes (see the table above). A task that was closed by hand stays closed until its source has new activity.

### If the file is not valid

The whole file is rejected, nothing is half-loaded: the pane keeps the list it had, shows a warning, and saves your text to `tasks.rejected.json`. The next change made in the pane writes a good `tasks.json` over the bad one. Reasons: not valid JSON (a half-written file counts), the top level is not an array, a task without `text`, an `id` that is not a positive whole number or is used twice, or an `isDone` that is not true or false. Fix the file and save again.

## Playbook (opening prompts)

`rules/generic.md` is the built-in playbook: it classifies a task into a case (address review comments, tagged in a ticket, start a ticket, review a PR, failed build, backport, test a ticket, ...) and writes the prompt for it. Cases that have a matching dev-toolkit skill name it on a `Skill:` line, and Claude invokes that skill (and falls back to the written steps if it is not installed). Your own playbook (`playbookPath`) takes the place of the generic wording, so name your own skills there.

To test the script by hand: `powershell -File %USERPROFILE%\.claude\todo-pane\ado-watch.ps1 -DryRun` prints what it would add. `-TestToast` raises a test notification.

If you ask your own Claude to change the alerts, point it at this file and at `alerts.json`. Never edit `ado-watch.ps1` in the data folder: the plugin overwrites it from its own `scripts/` copy at session start. Change the plugin's copy instead. The script never writes to Azure DevOps; keep it that way.
