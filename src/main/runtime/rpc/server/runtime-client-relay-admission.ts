import { parseExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { RpcRequest } from '../core'
import { denyRpcMethodForCaller, type RpcCallerScope } from '../callers/rpc-caller-scope'
import type { RpcMethodPermission } from '../callers/rpc-method-permission'
import { MOBILE_RPC_METHOD_ROUTES } from './runtime-rpc-mobile-method-routing'

export type RuntimeClientRelayAdmission =
  | { kind: 'run-here' }
  | { kind: 'relay' }
  | { kind: 'refused'; code: 'invalid_argument' | 'forbidden'; message: string }

// Granted for this computer only: they never reach a server it relays to.
const PERMISSIONS_NEVER_RELAYED: ReadonlySet<RpcMethodPermission> = new Set([
  'pairing-admin',
  'desktop-control'
])

/** A paired desktop/web client that names another host never has the call silently run here:
 * execution-host routes relay, routes this computer owns stay here, anything else is refused. */
export function runtimeClientRelayAdmission(
  request: Pick<RpcRequest, 'method' | 'executionHost'>,
  callerScope: RpcCallerScope,
  permission: RpcMethodPermission | undefined
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
  const route = MOBILE_RPC_METHOD_ROUTES.get(method)
  if (route === 'paired-desktop') {
    return { kind: 'run-here' }
  }
  if (route !== 'execution-host') {
    return forbidden(`Method '${method}' cannot run on a server this computer relays to`)
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
