// UserPromptSubmit hook for the TODO pane: names the session after the task started with ▶ Start.
// The pane writes %USERPROFILE%\.claude\todo-pane\pending-title.json; this hook applies it once to
// the matching session and deletes it. Reads the hook payload from stdin; never blocks or changes
// the prompt, and any failure is silent so a prompt is never held up by the pane.
'use strict'
const fs = require('fs')
const path = require('path')

/** A title older than this belongs to a Start that never got a prompt; it is dropped. */
const MAX_AGE_MS = 30 * 60 * 1000
const PENDING_FILE = path.join(process.env.USERPROFILE || '', '.claude', 'todo-pane', 'pending-title.json')

/** Windows PowerShell writes UTF-8 with a BOM, which JSON.parse rejects. */
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))

const sessionIdOf = payload => {
  try {
    return String(JSON.parse(payload).session_id || '')
  } catch {
    return ''
  }
}

const applyPendingTitle = payload => {
  if (!fs.existsSync(PENDING_FILE)) return
  const pending = readJson(PENDING_FILE)
  if (Date.now() - Number(pending.at || 0) >= MAX_AGE_MS) {
    fs.unlinkSync(PENDING_FILE)
    return
  }
  // Without an id on either side, the first prompt to arrive takes the title.
  const sessionId = sessionIdOf(payload)
  const isMine = !pending.sessionId || !sessionId || pending.sessionId === sessionId
  if (!isMine || !pending.title) return
  fs.unlinkSync(PENDING_FILE)
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        sessionTitle: String(pending.title),
      },
    }),
  )
}

let input = ''
process.stdin.on('data', chunk => (input += chunk))
process.stdin.on('end', () => {
  try {
    applyPendingTitle(input)
  } catch {}
})
