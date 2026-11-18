import type { ClientModule } from 'claude-code'

/** The task fields this view reads; the server owns the full record. */
type Item = {
  id: number
  text: string
  isDone: boolean
  url?: string
  inProgress?: boolean
  startedAt?: number
  createdAt?: number
  closedBy?: string
  sessionId?: string
}
type Props = { tasks: Item[]; now: number; newWindowMs?: number; currentSessionId?: string }

type Status = 'new' | 'todo' | 'progress' | 'done'

/** Ops posted to the server module; their shapes are the contract with register.tsx. */
type Op =
  | { op: 'move'; id: number; to: number }
  | { op: 'toggle'; id: number }
  | { op: 'status'; id: number; status: Status }
  | { op: 'start'; id: number }
  | { op: 'open'; id: number }
  | { op: 'resume'; id: number }
  | { op: 'remove'; id: number }
  | { op: 'edit'; id: number; text: string }
/** rest = normal row, held = the row being dragged, ghost = the copy that follows the pointer. */
type RowMode = 'rest' | 'held' | 'ghost'

type State = {
  /** Drag: index of the picked-up row, the row under the pointer, and the pointer's y. */
  from: number | null
  over: number | null
  y: number
  editId: number | null
  draft: string
  confirmId: number | null
  statusId: number | null
}

const IDLE: State = {
  from: null,
  over: null,
  y: 0,
  editId: null,
  draft: '',
  confirmId: null,
  statusId: null,
}

/** How long a task shows the New tag when the pane passes no newTaskHours setting. */
const DEFAULT_NEW_WINDOW_MS = 24 * 60 * 60 * 1000
/** A left press in the first columns of a row (the ⠇ grip) starts a drag. */
const GRIP_COLUMNS = 4
/** Indents the action line so it lines up with the task text. */
const GUTTER = 6
const MAX_LINES = 4
/** Lines a row takes besides its text: top border, action line, bottom border. */
const ROW_CHROME_LINES = 3
const MIN_TEXT_WIDTH = 12
/** Columns taken by the grip, checkbox, ✎/✕ buttons, borders and padding. */
const RESERVED_COLUMNS = 18
const INPUT_EXTRA_COLUMNS = 6

const COLOR = {
  rowBg: '#262626',
  ghostBg: '#2b4f6b',
  buttonBg: '#3c3c3c',
  checkOff: '#444444',
  checkOn: '#2f8f46',
  checkHover: '#4a9d5b',
  edit: '#2a6fb0',
  danger: '#b03a3a',
  neutral: '#555555',
  save: '#2f8f46',
  open: '#2a8f8f',
  resume: '#d08a1f',
  start: '#7a5bd0',
  statusHover: '#4f6d8f',
  here: '#4ec468',
} as const

/** Shown instead of Resume on the task that belongs to the chat this pane is in. */
const HERE_LABEL = '● This chat'

/** Label and colour of the status shown on each row. */
const STATUS_BADGE: Record<Status, { label: string; color: string }> = {
  done: { label: 'resolved', color: '#4ec468' },
  progress: { label: '● in progress', color: '#f0c430' },
  new: { label: 'New', color: '#ff9a2e' },
  todo: { label: 'To do', color: '#4aa3ff' },
}

const STATUS_OPTIONS: readonly { value: Status; label: string; fill: string }[] = [
  { value: 'new', label: ' New ', fill: '#e8820c' },
  { value: 'todo', label: ' To do ', fill: '#2a6fb0' },
  { value: 'progress', label: ' In progress ', fill: '#c9a21f' },
  { value: 'done', label: ' Done ', fill: '#2f8f46' },
]

const statusOf = (t: Item, now: number, newWindowMs: number = DEFAULT_NEW_WINDOW_MS): Status => {
  if (t.isDone) return 'done'
  if (t.inProgress) return 'progress'
  if (t.createdAt !== undefined && now - t.createdAt < newWindowMs) return 'new'
  return 'todo'
}

/** Word-wraps text to `width`, hard-splitting long words, capped at MAX_LINES with an ellipsis. */
const wrap = (text: string, width: number): string[] => {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let line = ''
  for (const w of words) {
    let word = w
    while (word.length > width) {
      if (line) {
        lines.push(line)
        line = ''
      }
      lines.push(word.slice(0, width))
      word = word.slice(width)
    }
    if (!line) line = word
    else if (line.length + 1 + word.length <= width) line += ` ${word}`
    else {
      lines.push(line)
      line = word
    }
  }
  if (line) lines.push(line)
  if (lines.length > MAX_LINES) {
    const cut = lines.slice(0, MAX_LINES)
    const last = cut[MAX_LINES - 1] ?? ''
    cut[MAX_LINES - 1] = `${last.slice(0, Math.max(0, width - 1))}…`
    return cut
  }
  return lines.length ? lines : ['']
}

const List: ClientModule<Props, State> = (props, surface) => {
  const { Box, Text, Button, Input } = surface.elements
  const cur = surface.state ?? IDLE
  const tasks = props.tasks
  const textWidth = Math.max(MIN_TEXT_WIDTH, surface.columns - RESERVED_COLUMNS)

  const send = (op: Op) => surface.post(op)
  const latest = () => surface.state ?? IDLE
  const reset = () => surface.setState({ ...IDLE })
  const commitEdit = (id: number, value: string) => {
    const text = value.trim()
    if (text) send({ op: 'edit', id, text })
    reset()
  }

  // Row geometry, also used to map pointer y to a row while dragging.
  // The action line (status, Open, Resume/Start) is stacked on two explicit lines whenever it
  // might not fit, so a row's height never depends on the app wrapping it.
  // The task started in this very chat; its Resume button would only reopen the chat it is in.
  const isHere = (t: Item): boolean => !!props.currentSessionId && t.sessionId === props.currentSessionId
  const stackedFor = (t: Item): boolean => {
    const label = STATUS_BADGE[statusOf(t, props.now, props.newWindowMs)].label.length
    const needed = GUTTER + label + 4 + (t.url ? 9 : 0) + (isHere(t) ? HERE_LABEL.length : 10)
    return needed + 2 > surface.columns - 4
  }
  const linesOf = tasks.map(t => (cur.editId === t.id ? [''] : wrap(t.text, textWidth)))
  const heights = linesOf.map((l, i) => {
    const t = tasks[i]
    return l.length + ROW_CHROME_LINES + (t && stackedFor(t) ? 1 : 0)
  })
  const starts: number[] = []
  let total = 0
  for (const h of heights) {
    starts.push(total)
    total += h
  }

  // The region's real height tells how far the modelled heights are off; scale y to match.
  const scale = surface.rows > 0 && total > 0 && surface.rows / total > 0.5 && surface.rows / total < 2
    ? total / surface.rows
    : 1

  const rowAt = (y: number): number => {
    const m = y * scale
    for (let i = tasks.length - 1; i >= 0; i--) {
      if (m >= (starts[i] ?? 0)) return i
    }
    return 0
  }

  // The list can change under a drag (watcher update), so a stale index simply ends it.
  const dragged = cur.from !== null && cur.over !== null ? tasks[cur.from] : undefined

  surface.onPointer(ev => {
    const now = latest()
    const row = rowAt(Math.max(0, ev.y))
    if (
      ev.type === 'down' &&
      ev.button === 'left' &&
      ev.x < GRIP_COLUMNS &&
      now.editId === null &&
      now.confirmId === null &&
      now.statusId === null
    ) {
      surface.setState({ ...now, from: row, over: row, y: ev.y })
    } else if (ev.type === 'move' && now.from !== null) {
      if (now.over !== row || now.y !== ev.y) {
        surface.setState({ ...now, over: row, y: ev.y })
      }
    } else if (ev.type === 'up' && now.from !== null) {
      const task = tasks[now.from]
      if (task && now.over !== null && now.from !== now.over) {
        send({ op: 'move', id: task.id, to: now.over })
      }
      surface.setState({ ...now, from: null, over: null })
    }
  })

  // Grey button that takes `fill` on hover. The app draws Buttons natively and drops the
  // colours of Text inside them, so the hover is set on both the Button and its Text.
  const actionButton = (
    id: number,
    mode: string,
    label: string,
    fill: string,
    onPress: () => void,
  ) => {
    const hover = { scope: `${mode}-${id}`, backgroundColor: fill, color: 'white' }
    return (
      <Button key={`${mode}-${id}`} onPress={onPress} hover={hover}>
        <Text backgroundColor={COLOR.buttonBg} color="white" hover={hover}>
          {label}
        </Text>
      </Button>
    )
  }

  const separator = () => <Text color="gray">{' │ '}</Text>

  const deleteConfirm = (t: Item) => (
    <Box>
      <Text color="red">Delete? </Text>
      {actionButton(t.id, 'yes', ' Yes ', COLOR.danger, () => {
        send({ op: 'remove', id: t.id })
        reset()
      })}
      <Text> </Text>
      {actionButton(t.id, 'no', ' No ', COLOR.neutral, reset)}
    </Box>
  )

  const editActions = (t: Item) => (
    <Box>
      {actionButton(t.id, 'sv', ' ✓ Save ', COLOR.save, () =>
        commitEdit(t.id, surface.state?.draft ?? ''),
      )}
      <Text> </Text>
      {actionButton(t.id, 'cx', ' ✕ Cancel ', COLOR.neutral, reset)}
    </Box>
  )

  const statusPicker = (t: Item) => (
    <Box>
      <Text color="gray">Set status: </Text>
      {STATUS_OPTIONS.map(({ value, label, fill }, i) => (
        <Box key={`pick-${value}-${t.id}`}>
          {i > 0 ? separator() : null}
          {actionButton(t.id, `pk-${value}`, label, fill, () => {
            send({ op: 'status', id: t.id, status: value })
            reset()
          })}
        </Box>
      ))}
      {separator()}
      {actionButton(t.id, 'pk-x', ' ✕ ', COLOR.neutral, reset)}
    </Box>
  )

  // The colour must stay on plain Text: inside a Button the app would drop it.
  const statusControl = (t: Item, mode: RowMode) => {
    const badge = STATUS_BADGE[statusOf(t, props.now, props.newWindowMs)]
    const scope = `stat-${mode}-${t.id}`
    return (
      <Box>
        <Text color={badge.color}>{badge.label}</Text>
        <Button
          key={scope}
          onPress={() => surface.setState({ ...IDLE, statusId: t.id })}
          hover={{ scope, backgroundColor: COLOR.statusHover }}
        >
          <Text color="white" hover={{ scope, backgroundColor: COLOR.statusHover }}>
            {' ▾ '}
          </Text>
        </Button>
        <Text> </Text>
      </Box>
    )
  }

  const openAndStart = (t: Item, mode: RowMode) => (
    <Box>
      {t.url ? (
        <Box>
          {actionButton(t.id, `src-${mode}`, ' ↗ Open ', COLOR.open, () =>
            send({ op: 'open', id: t.id }),
          )}
          <Text> </Text>
        </Box>
      ) : null}
      {isHere(t) ? (
        <Text key={`here-${mode}-${t.id}`} color={COLOR.here}>
          {HERE_LABEL}
        </Text>
      ) : t.isDone || t.inProgress
        ? actionButton(t.id, `rs-${mode}`, ' ↩ Resume ', COLOR.resume, () =>
            send({ op: 'resume', id: t.id }),
          )
        : actionButton(t.id, `go-${mode}`, ' ▶ Start ', COLOR.start, () =>
            send({ op: 'start', id: t.id }),
          )}
    </Box>
  )

  const taskActions = (t: Item, mode: RowMode) =>
    stackedFor(t) ? (
      <Box flexDirection="column">
        <Box>{statusControl(t, mode)}</Box>
        {openAndStart(t, mode)}
      </Box>
    ) : (
      <Box>
        {statusControl(t, mode)}
        {openAndStart(t, mode)}
      </Box>
    )

  const row = (t: Item, lines: string[], mode: RowMode) => {
    // Edit, delete-confirm and status-picker states only apply to the row in place.
    const isEditing = cur.editId === t.id && mode === 'rest'
    const isConfirming = cur.confirmId === t.id && mode === 'rest'
    const isPicking = cur.statusId === t.id && mode === 'rest'
    const dim = t.isDone || mode === 'held'
    return (
      <Box
        key={`${mode}-${t.id}`}
        width="100%"
        flexDirection="column"
        borderStyle="round"
        borderColor={mode === 'ghost' ? 'cyan' : 'gray'}
        paddingX={1}
        backgroundColor={mode === 'ghost' ? COLOR.ghostBg : COLOR.rowBg}
      >
        <Box>
          <Text color={mode === 'rest' ? 'gray' : 'cyan'}>{'⠇ '}</Text>
          <Button
            key={`check-${mode}-${t.id}`}
            onPress={() => send({ op: 'toggle', id: t.id })}
            hover={{ scope: `chk-${t.id}-${mode}`, backgroundColor: COLOR.checkHover }}
          >
            <Text backgroundColor={t.isDone ? COLOR.checkOn : COLOR.checkOff} color="white">
              {t.isDone ? ' ✓ ' : '   '}
            </Text>
          </Button>
          <Text> </Text>
          {isEditing ? (
            <Box width={textWidth + INPUT_EXTRA_COLUMNS} flexDirection="column" alignItems="stretch">
              <Input
                key={`edit-${t.id}`}
                value={cur.draft}
                autoFocus
                rows={3}
                submitLabel=" "
                onInput={(value: string) => surface.setState({ ...latest(), draft: value })}
                onSubmit={(value: string) => commitEdit(t.id, value)}
              />
            </Box>
          ) : (
            <Box flexDirection="column" flexGrow={1}>
              {lines.map((line, i) => (
                <Text
                  key={`l-${t.id}-${i}`}
                  dimColor={dim}
                  strikethrough={t.isDone}
                  wrap="truncate-end"
                >
                  {line}
                </Text>
              ))}
            </Box>
          )}
          {!isEditing && !isConfirming ? (
            <Box alignSelf="flex-start">
              <Text> </Text>
              {actionButton(t.id, `ed-${mode}`, ' ✎ ', COLOR.edit, () =>
                surface.setState({ ...IDLE, editId: t.id, draft: t.text }),
              )}
              <Text> </Text>
              {actionButton(t.id, `rm-${mode}`, ' ✕ ', COLOR.danger, () =>
                surface.setState({ ...IDLE, confirmId: t.id }),
              )}
            </Box>
          ) : null}
        </Box>
        <Box>
          <Text>{' '.repeat(stackedFor(t) ? 2 : GUTTER)}</Text>
          {isConfirming
            ? deleteConfirm(t)
            : isEditing
              ? editActions(t)
              : isPicking
                ? statusPicker(t)
                : taskActions(t, mode)}
        </Box>
      </Box>
    )
  }

  const dragOverlay = () => {
    if (!dragged || cur.from === null || cur.over === null) return null
    const from = cur.from
    const over = cur.over
    const overStart = starts[over] ?? total
    // Moving up drops above the hovered row, moving down drops below it.
    const edge = over <= from ? overStart : overStart + (heights[over] ?? 0)
    const ghostTop = Math.max(0, Math.min(total - (heights[from] ?? 0), cur.y - 1))
    return [
      <Box key="drop-line" position="absolute" top={Math.max(0, edge - 1)} left={0}>
        <Text color="cyan">{'━'.repeat(Math.max(4, surface.columns))}</Text>
      </Box>,
      <Box key="ghost" position="absolute" top={ghostTop} left={0} right={0}>
        {row(dragged, linesOf[from] ?? [''], 'ghost')}
      </Box>,
    ]
  }

  return (
    <Box flexDirection="column">
      {tasks.map((t, i) =>
        row(t, linesOf[i] ?? [''], dragged && cur.from === i ? 'held' : 'rest'),
      )}
      {dragOverlay()}
    </Box>
  )
}

export default List
