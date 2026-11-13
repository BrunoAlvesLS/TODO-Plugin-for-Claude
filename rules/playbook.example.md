# Personal playbook (example)

Copy this file somewhere on your machine, edit it, and set the plugin's
"Personal playbook file" option to its path. The plugin reads it on every
"▶ Start" click and adds it to the generic rules. If the option is
empty or the file is missing, only the generic rules are used.

## General rules
- Anything you always want in an opening prompt, for example "check my notes
  folder first".
- Things Claude must never do without asking.

## Tools per case
Map a case from the generic rules to the skill, command, or agent you want
named in the prompt.
- Review comments on my PR: /your-review-skill
- Start a new story: /your-start-skill <id>
- Failed build: /your-build-skill
