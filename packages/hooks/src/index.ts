import { parseHooksConfig, type HookGroup } from './config'

export * from './config'
export * from './hooks'
export * from './runner'

/** Reads the hook configuration of every settings source that applies, in precedence order. */
export function loadHookGroups(configs: ReadonlyArray<{ scope: string; config: unknown }>): { groups: HookGroup[]; problems: string[] } {
  const groups: HookGroup[] = []
  const problems: string[] = []
  for (const { scope, config } of configs) {
    const parsed = parseHooksConfig(config, scope)
    groups.push(...parsed.groups)
    problems.push(...parsed.problems.map((problem) => `${scope} settings: ${problem}`))
  }
  return { groups, problems }
}
