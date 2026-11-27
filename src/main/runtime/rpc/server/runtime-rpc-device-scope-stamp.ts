import type { RpcResponse } from '../core'
import type { DeviceScope } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

// Stamp proven scope and per-connection capabilities at transport boundary; status.get has no connection context.
export function injectDeviceScope(
  response: string,
  scope: DeviceScope,
  connectionCapabilities: readonly string[] = []
): string {
  try {
    const parsed = JSON.parse(response) as RpcResponse
    if (parsed.ok !== true || typeof parsed.result !== 'object' || parsed.result === null) {
      return response
    }
    const result = parsed.result as Record<string, unknown>
    result.deviceScope = scope
    if (connectionCapabilities.length > 0 && Array.isArray(result.capabilities)) {
      result.capabilities = [...result.capabilities, ...connectionCapabilities]
    }
    return JSON.stringify(parsed)
  } catch {
    return response
  }
}
