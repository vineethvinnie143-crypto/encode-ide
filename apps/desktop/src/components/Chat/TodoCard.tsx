import { CheckCircle2, Circle, ListTodo, Loader2 } from '../../ui/icons'
import { useChat } from '../../stores/chat'

const ICONS = {
  pending: Circle,
  in_progress: Loader2,
  completed: CheckCircle2,
} as const

export default function TodoCard() {
  const todos = useChat((state) => state.todos)
  if (!todos.length) return null

  const done = todos.filter((todo) => todo.status === 'completed').length

  return (
    <div className="todo-card">
      <div className="todo-head">
        <ListTodo size={13} />
        <span>Tasks</span>
        <span className="todo-count">
          {done}/{todos.length}
        </span>
      </div>
      <div className="todo-list">
        {todos.map((todo) => {
          const Icon = ICONS[todo.status]
          return (
            <div className={`todo-item todo-${todo.status}`} key={todo.id}>
              <Icon size={12} className={todo.status === 'in_progress' ? 'spin' : ''} />
              <span>{todo.text}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
