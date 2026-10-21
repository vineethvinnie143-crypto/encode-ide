/** Adds the four-policy dropdown to the composer and a smoke assertion. */
import fs from 'node:fs'

const composerPath = 'src/components/Composer.tsx'
const path = 'src/components/Chat/Composer.tsx'
const edits = [
  [path, "import { useWorkspace } from '../../stores/workspace'",
    "import { useWorkspace } from '../../stores/workspace'\n\nconst POLICY_OPTIONS = ['read-only', 'workspace-write', 'full-access', 'auto-review'] as const\nconst POLICY_LABELS: Record<string, string> = {\n  'read-only': 'Read Only',\n  'workspace-write': 'Workspace Write',\n  'full-access': 'Full access',\n  'auto-review': 'Auto review',\n}"],
  [path, "  const fullAccess = Boolean(settings?.autoApprove && settings?.autoApproveCommands)",
    "  const fullAccess = Boolean(settings?.autoApprove && settings?.autoApproveCommands)\n  const policy = settings?.policy ?? 'workspace-write'\n  const [policyOpen, setPolicyOpen] = useState(false)"],
  [path, `          <button
            className={\`policy-chip \${fullAccess ? 'is-full' : ''}\`}
            onClick={togglePolicy}
            title="Approval policy for edits and commands"
          >
            {fullAccess ? <ShieldCheck size={13} /> : <Shield size={13} />}
            {fullAccess ? 'Full access' : 'Ask first'}
            <ChevronDown size={12} />
          </button>`,
    `          <span className="session-chip-wrap">
            <button className="policy-chip" onClick={() => setPolicyOpen((value) => !value)} title="Tool permission policy">
              <Shield size={13} />
              {POLICY_LABELS[policy]}
              <ChevronDown size={12} />
            </button>
            {policyOpen && (
              <div className="session-popover policy-menu">
                {POLICY_OPTIONS.map((option) => (
                  <button
                    key={option}
                    className={policy === option ? 'is-selected' : ''}
                    onClick={() => {
                      setPolicyOpen(false)
                      void save({ policy: option })
                    }}
                  >
                    <Shield size={13} /> {POLICY_LABELS[option]}
                    {policy === option && <span>selected</span>}
                  </button>
                ))}
              </div>
            )}
          </span>`],
  ['scripts/smoke.mjs', "  await evaluate(\"window.forge.agent.reset()\")",
    "  const policyCheck = await evaluate(`(async () => {\n    await window.forge.settings.save({ policy: 'read-only' })\n    const readOnly = (await window.forge.settings.get()).policy\n    await window.forge.settings.save({ policy: 'full-access' })\n    const full = (await window.forge.settings.get()).policy\n    return { readOnly, full }\n  })()`)\n  console.log('[smoke] policy:', JSON.stringify(policyCheck))\n  if (policyCheck.readOnly !== 'read-only' || policyCheck.full !== 'full-access') throw new Error('approval policy round-trip failed')\n  await evaluate(\"window.forge.agent.reset()\")"],
]

let changed = 0
for (const [file, from, to] of edits) {
  const text = fs.readFileSync(file, 'utf8')
  if (!text.includes(from)) {
    console.log(`MISS ${file}: ${from.slice(0, 70).replace(/\n/g, '\\n')}`)
    continue
  }
  fs.writeFileSync(file, text.replace(from, to), 'utf8')
  changed += 1
}
console.log(`applied ${changed}/${edits.length}`)
