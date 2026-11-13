# Opening-prompt rules (generic)

Pick the case that fits the to-do text, then write a prompt for it. If two cases fit, take the more specific one. If none fit, use "Unknown".

## Common rules for every prompt
- Name any ticket, work item, or PR number from the to-do text. If the case needs a number and the text has none, the first step is to ask me for it.
- Start by looking for related notes, docs, or earlier work on the topic, and say what was found.
- Give findings or a short plan first. Wait for my go-ahead before editing code, committing, pushing, or writing to any external system (tickets, PRs, chat, email).
- Do not invent details that are not in the to-do text.
- If the case lists a toolkit skill (`Skill:` line), invoke it for the work and follow it; its steps replace the generic steps where they overlap. If the skill is not installed, follow the steps written here. The rule above about waiting for my go-ahead still applies.

## Cases

### 1. Address review comments on my PR
Signals: "comments", "review", "address", "reviewer", a PR number, "changes requested".
Steps: read every active comment thread on the PR. For each thread decide: change needed, answer only, or disagree with a reason. Propose the fixes, apply them after my go-ahead, run only the tests that cover the change, then draft the replies for me to approve. Do not post replies or resolve threads without my approval.

### 2. Tagged in a ticket comment
Skill: `lsc-dev-toolkit:ado-work-item` to read the ticket and its comments.
Signals: "mentioned", "tagged", "@", "comment from <name>", "asked me", "reply".
Steps: read the ticket and its comments, find the question or request addressed to me, and check the notes and code for the answer. Draft a short reply for me to approve. Do not post it.

### 3. Start a new user story or issue
Skill: `lsc-dev-toolkit:ls:plan` (requirements and design only, no implementation).
Signals: "start", "kick off", "new ticket", "implement", a work item number alone.
Steps: read the work item and its comments. Set up an isolated branch or workspace for it. Write a short brief, a technical design, and a plan. Stop for my review before implementing anything.

### 4. New task or bug added inside an existing issue
Skill: `lsc-dev-toolkit:ls:analyze` to classify the bug and find the root cause.
Signals: "new task", "new bug", "child", "added under", "subtask", "added to".
Steps: read the parent issue and the new item. Find any existing branch or work for the parent and reuse it. For a bug, classify it first (real bug, expected behaviour, configuration, or incomplete report) and find the root cause before proposing a fix. Do not create or edit tickets.

### 5. Review someone else's PR
Skill: `lsc-dev-toolkit:ls:review-pr`. Report the findings to me first; do not post them as PR comments or vote.
Signals: "review PR", "please review", "reviewer", "needs my review".
If the task says "Re-review" (I already reviewed it), do not review the whole PR again: read my earlier comments, look only at what changed since my last review, check how each comment was addressed, and tell me if I can approve now.
Steps: check whether I have already commented on it. If not, read the change against the work item and look for correctness problems, missing tests, and risk. Report findings as file, line, and a one-line reason. Do not vote or post comments without my approval.

### 6. Failed build or pipeline
Signals: "build failed", "pipeline", "red", "tests failing", "CI".
Steps: find the failed step or tests and read the log. Compare with the last green run. Classify the cause (product bug, outdated or flaky test, branch drift, infrastructure) and say whether to fix or re-queue. Read-only until I decide.

### 7. Backport
Skill: `lsc-dev-toolkit:ls:backport`.
Signals: "backport", "cherry-pick", "hotfix branch", "release branch".
Steps: identify the merged change and the target branches. Check that the change applies cleanly and that only the intended files are included. Propose the branch names and the plan. Do not push or open PRs without my go-ahead.

### 8. Test a ticket
Signals: "test", "verify", "QA", "check the fix".
Steps: read the ticket and its PR. Explain the previous behaviour and the new behaviour, then write a test plan with concrete steps and expected results.

### 9. Write something for a ticket
Skills: `lsc-dev-toolkit:release-notes` (release notes), `lsc-dev-toolkit:hotfix-postmortem` (postmortem), `lsc-dev-toolkit:ls:onlinehelp-document` (online help), `lsc-dev-toolkit:ls:document` (technical docs).
Signals: "release notes", "postmortem", "documentation", "online help", "acceptance criteria".
Steps: read the ticket and the change. Draft the requested text, matching any existing style. Show the draft for approval. Do not publish or save it elsewhere.

### 10. Investigation or question
Skill: `lsc-dev-toolkit:ls:analyze` when the question is about a reported issue.
Signals: "why", "how", "investigate", "find out", "look into".
Steps: gather evidence from notes and code first. Report what is known, what is uncertain, and what to check next. Make no changes.

### 11. Admin
Signals: "timesheet", "hours", "clean up", "housekeeping", "update list".
Steps: list what is needed and what can be done automatically. Show the result for approval before saving anything.

### 12. Unknown
Ask me one short question to identify what kind of work this is, then follow the matching case above.
