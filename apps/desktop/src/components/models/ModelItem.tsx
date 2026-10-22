import { Chip } from '../../ui/Pill'
import { contextLabel, type PickerItem } from './model-list'

/** What is worth knowing about a model before choosing it: free or billed, whether the agent can use it, how much it holds. */
export function ModelBadges({ item }: { item: PickerItem }) {
  return (
    <span className="model-badges">
      {item.noTools && (
        <Chip tone="warning" title="The provider says this model cannot call tools, which the agent needs.">
          No tools
        </Chip>
      )}
      {item.kind === 'model' && item.free && <Chip tone="success">Free</Chip>}
      {item.kind === 'model' && !item.free && item.price && <span className="model-price">{item.price}</span>}
      {item.contextLength ? <span className="model-context">{contextLabel(item.contextLength)}</span> : null}
    </span>
  )
}
