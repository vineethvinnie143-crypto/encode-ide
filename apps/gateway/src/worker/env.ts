import { parseConfig, type ConfigResult, type GatewayEnvVars } from '../core/config'
import type { AddressLimiterObject, ControlObject, UserQuotaObject } from './objects'

/** The Worker's bindings, as wrangler.jsonc declares them, plus its variables and secrets. */
export interface Env extends GatewayEnvVars {
  USER_QUOTA: DurableObjectNamespace<UserQuotaObject>
  CONTROL: DurableObjectNamespace<ControlObject>
  ADDRESS_LIMITER: DurableObjectNamespace<AddressLimiterObject>
  DB: D1Database
  CONFIG: KVNamespace
}

const parsed = new WeakMap<object, ConfigResult>()

/** The configuration for this isolate's environment, parsed once. */
export function configFor(env: Env): ConfigResult {
  let result = parsed.get(env)
  if (!result) {
    result = parseConfig(env)
    parsed.set(env, result)
  }
  return result
}
