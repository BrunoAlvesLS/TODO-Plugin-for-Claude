---
name: update-todo
description: Use when the user wants to add, change, tick off, reopen, reorder or remove tasks in their TODO pane (the /todo list), for example "mark ticket 12345 done in my todo", "add this to my todo list", "put the review task in progress", "remove that task from the pane". Edits the pane's task file; the open pane refreshes by itself.
---

# Update the TODO pane list

The `/todo` pane keeps its whole list in one file. Edit that file and every open pane refreshes within about a second. The pane does not have to be open.

This changes the local list only. It never touches Azure DevOps: marking a ticket's task done does not close, comment on or change the ticket.

## 1. Find the file

`%USERPROFILE%\.claude\todo-pane\tasks.json` (bash: `$USERPROFILE/.claude/todo-pane/tasks.json`, PowerShell: `$env:USERPROFILE\.claude\todo-pane\tasks.json`).

- **If the file does not exist, stop and do not create it.** It means the todo-pane plugin is not installed, is older than 0.3.0, or has not started a session since it was updated. Creating the file would replace the user's existing list on the next load. Tell the user to update the plugin and open a new session.
- Edit only `tasks.json`. Never edit `inbox.json`, `tasks-backup.json` or the plugin store file.

## 2. Edit rules

1. Read the whole file right before you write. The pane, the Auto-sync job or another session may have changed it a moment ago; never write from an earlier read.
2. Change only the tasks the user asked about. Keep every other task and every field exactly as it is, in the same order.
3. Write the whole file back as a JSON array, UTF-8, 2-space indent. Times are milliseconds since 1970 (`Date.now()` in node, `[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()` in PowerShell).

## 3. Find the right task

Match by ticket or PR number in `text` or `key`. Auto-sync tasks have a `key` like `wi-assigned:12345` (assigned to the user), `wi-mention:12345` (mentioned), `wi-tester:12345` (user is the tester), `wi-child:...`, `pr-reply:67890` (replies on their PR), `pr-review:...` (they review it), `pr-build:...` (failing build). One ticket can have several tasks. If more than one fits and the user did not say which, ask; change all of them only when they asked for the whole ticket.

## 4. Recipes

| Ask | Edit |
|---|---|
| Add a task | Insert `{"text": "..."}` at the start of the array. Nothing else; the plugin assigns `id` and `createdAt`. |
| Done | `"isDone": true`, `"inProgress": false`, `"closedBy": "user"`, `"closedAt": <now>` |
| Reopen / To do | `"isDone": false`, `"inProgress": false`; delete `startedAt`, `closedBy`, `closedAt` |
| In progress | `"isDone": false`, `"inProgress": true`, `"startedAt": <now>` (keep an existing one) |
| New | `"isDone": false`, `"inProgress": false`, `"createdAt": <now>`; delete `startedAt` |
| Edit text | change `text` |
| Reorder | move the object within the array (first is shown first) |
| Remove | delete the object. Tasks with a `key` stay gone until their source has new activity. If the user only says the work is finished, mark it done instead of deleting. |

Example, mark the mention task for ticket 12345 done:

```
node -e "const fs=require('fs'),p=process.env.USERPROFILE+'/.claude/todo-pane/tasks.json';const t=JSON.parse(fs.readFileSync(p,'utf8'));const x=t.find(y=>y.key==='wi-mention:12345');Object.assign(x,{isDone:true,inProgress:false,closedBy:'user',closedAt:Date.now()});fs.writeFileSync(p,JSON.stringify(t,null,2)+'\n')"
```

Check that `find` returned a task before assigning, and print what you changed.

## 5. Check the result

Wait about 2 seconds and read the file again. The plugin may have rewritten it in its standard layout, which is fine. If the file was rejected, `tasks.rejected.json` appears next to it holding your text, and the pane shows a warning: the whole file is refused when it is not valid JSON, not an array, a task has no `text`, an `id` is not a positive whole number or is repeated, or `isDone` is not true or false. Fix the problem and write the file again.

Then tell the user in one line what changed (task id and text).

Auto-sync tasks close and reopen by themselves when their source changes, so a task you marked done can come back if the ticket or PR has new activity. That is expected.

The full field reference is in the plugin's `README.md`, section "Editing the list from outside".
