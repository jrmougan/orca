import { parseExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { RpcRequest } from '../core'
import { denyRpcMethodForCaller, type RpcCallerScope } from '../callers/rpc-caller-scope'
import type { RpcMethodPermission } from '../callers/rpc-method-permission'
import { runtimeClientRelayRoute } from './runtime-client-relay-routes'

export type RuntimeClientRelayAdmission =
  | { kind: 'run-here' }
  | { kind: 'relay' }
  | { kind: 'refused'; code: 'invalid_argument' | 'forbidden'; message: string }

// Granted for this computer only, or about the client's credential here: they never reach a server it relays to.
const PERMISSIONS_NEVER_RELAYED: ReadonlySet<RpcMethodPermission> = new Set([
  'pairing-admin',
  'desktop-control',
  'device-self'
])

/** A paired desktop/web client that names another host has the call relayed there, as the runtime
 * device that server holds for it. Only this computer's own pairing and relay catalog stay here. */
export function runtimeClientRelayAdmission(
  request: Pick<RpcRequest, 'method' | 'executionHost'>,
  callerScope: RpcCallerScope,
  permission: RpcMethodPermission | undefined,
  // A device another computer delegated here is relayed by that computer only.
  delegated = false
): RuntimeClientRelayAdmission {
  const { executionHost, method } = request
  if (executionHost === undefined) {
    return { kind: 'run-here' }
  }
  const target = parseExecutionHostId(typeof executionHost === 'string' ? executionHost : null)
  if (!target) {
    return { kind: 'refused', code: 'invalid_argument', message: 'Invalid executionHost' }
  }
  // SSH targets are resolved by this runtime itself.
  if (target.kind !== 'runtime') {
    return { kind: 'run-here' }
  }
  if (runtimeClientRelayRoute(method) === 'this-server') {
    return { kind: 'run-here' }
  }
  if (delegated) {
    return forbidden('A client relayed through a paired computer cannot be relayed again')
  }
  // The relay skips local dispatch, so no method_not_found follows to stop an unregistered method.
  if (permission === undefined) {
    return forbidden(`Method '${method}' is not served by this computer, so it is not relayed`)
  }
  if (PERMISSIONS_NEVER_RELAYED.has(permission)) {
    return forbidden(
      `Method '${method}' needs the '${permission}' permission, which is never relayed to a server`
    )
  }
  const denial = denyRpcMethodForCaller(callerScope, method, permission)
  return denial ? forbidden(denial) : { kind: 'relay' }
}

function forbidden(message: string): RuntimeClientRelayAdmission {
  return { kind: 'refused', code: 'forbidden', message }
}
