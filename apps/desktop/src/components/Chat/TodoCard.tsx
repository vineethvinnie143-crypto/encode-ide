import { useEffect, useRef, useState } from 'react'
import type { TodoItem } from '@shared/types'
import { CheckCircle2, Circle, CircleDot, ListTodo, Loader2 } from '../../ui/icons'
import { Collapse } from '../../ui/Collapse'
import { cx } from '../../ui/cx'
import { finishedList, useChat } from '../../stores/chat'

const ICONS = {
  pending: Circle,
  in_progress: Loader2,
  completed: CheckCircle2,
} as const

/** How long a list stays once its last item is ticked, so the tick is seen before the card folds away. */
const LINGER_MS = 1200

/**
 * The agent's task list above the message box. It grows in when the agent writes a list, and folds away a moment
 * after every item is done (ADR 0115); the step in the thread keeps how far the list got.
 */
export default function TodoCard() {
  const todos = useChat((state) => state.todos)
  // Only a running request turns its item: once it ends, the item it left open is shown as left, not as under way (ADR 0125).
  const running = useChat((state) => state.running)
  const finished = finishedList(todos)
  // The finished list that has folded away; a new list from the agent is another array, and shows.
  const [folded, setFolded] = useState<readonly TodoItem[] | null>(null)
  // What the card shows while it folds away, when the list it showed is already gone.
  const last = useRef<readonly TodoItem[]>(todos)
  if (todos.length) last.current = todos

  useEffect(() => {
    if (!finished) return
    const timer = window.setTimeout(() => setFolded(todos), LINGER_MS)
    return () => window.clearTimeout(timer)
  }, [todos, finished])

  const shown = last.current
  const done = shown.filter((todo) => todo.status === 'completed').length

  return (
    <Collapse open={todos.length > 0 && folded !== todos}>
      <div className="todo-card">
        <div className="todo-head">
          <ListTodo size={13} />
          <span>Tasks</span>
          <span className="todo-count">
            {done}/{shown.length}
          </span>
        </div>
        <div className="todo-list">
          {shown.map((todo) => {
            const held = todo.status === 'in_progress' && !running
            const Icon = held ? CircleDot : ICONS[todo.status]
            return (
              <div className={cx('todo-item', `todo-${todo.status}`, held && 'is-held')} key={todo.id} title={held ? 'Left open when the request ended' : undefined}>
                <Icon size={12} className={todo.status === 'in_progress' && !held ? 'spin' : ''} />
                <span>{todo.text}</span>
              </div>
            )
          })}
        </div>
      </div>
    </Collapse>
  )
}
