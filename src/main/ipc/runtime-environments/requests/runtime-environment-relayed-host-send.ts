import {
  RUNTIME_CLIENT_RELAY_HOST_ROUTES_RUNTIME_CAPABILITY,
  RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY,
  RUNTIME_CLIENT_RELAY_TERMINAL_MULTIPLEX_RUNTIME_CAPABILITY
} from '../../../../shared/remote-runtime/relay/mobile-desktop-relay-contract'
import type { RelayedRuntimeEnvironment } from '../../../../shared/remote-runtime/relay/relayed-runtime-environment'
import { RELAYED_STREAM_CARRIERS } from '../../../runtime/mobile-desktop-relay/relayed-stream-carriers'
import { runtimeClientRelayRoute } from '../../../runtime/rpc/server/runtime-client-relay-routes'
import { MOBILE_RPC_METHOD_ROUTES } from '../../../runtime/rpc/server/runtime-rpc-mobile-method-routing'
import { RemoteRuntimeClientError } from '../../../../shared/remote-runtime/remote-runtime-client-error'
import type { RemoteRuntimeSubscriptionAdmissionRequest } from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-contract'
import type {
  RuntimeRpcFailure,
  RuntimeRpcResponse
} from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import {
  sendOnAdmittedSharedControlSocket,
  type AdmittingSharedControlSocket,
  type SharedControlSocketAdmissions
} from '../connections/runtime-environment-admitted-shared-send'

/** Never the relaying server's runtime id: the reply is the relayed server's, or this computer's refusal. */
export function relayedHostFailure(
  method: string,
  code: string,
  message: string
): RuntimeRpcFailure {
  return { id: method, ok: false, error: { code, message }, _meta: { runtimeId: null } }
}

/**
 * Null when `method` may be asked of a relayed server; otherwise this computer's refusal. The rule
 * is the relaying server's own: what names a host goes to it, except what that server answers
 * itself (its pairing and relay catalog) and streams whose client binary frames it has no lane for.
 */
export function relayedHostMethodRefusal(
  method: string,
  ownerName: string
): RuntimeRpcFailure | null {
  if (
    runtimeClientRelayRoute(method) === 'named-host' &&
    RELAYED_STREAM_CARRIERS.get(method) !== 'unrelayed-client-binary'
  ) {
    return null
  }
  // method_not_found: callers with a fallback for a server that lacks the method take it.
  return relayedHostFailure(
    method,
    'method_not_found',
    `${method} is not available on a server reached through ${ownerName}`
  )
}

/** The capabilities a server must advertise, on the socket that sends, before `method` names a relayed server. */
export function relayedHostCapabilitiesFor(method: string): readonly string[] {
  return [
    RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY,
    // A server that only relays the phone's host methods would run any other one itself.
    ...(MOBILE_RPC_METHOD_ROUTES.get(method) === 'execution-host'
      ? []
      : [RUNTIME_CLIENT_RELAY_HOST_ROUTES_RUNTIME_CAPABILITY]),
    ...(method === 'terminal.multiplex'
      ? [RUNTIME_CLIENT_RELAY_TERMINAL_MULTIPLEX_RUNTIME_CAPABILITY]
      : [])
  ]
}

function advertises(status: unknown, required: readonly string[]): boolean {
  const capabilities =
    typeof status === 'object' && status !== null && 'capabilities' in status
      ? status.capabilities
      : null
  return (
    Array.isArray(capabilities) && required.every((capability) => capabilities.includes(capability))
  )
}

// One memo per set of capabilities a socket was asked for.
const relayAdmissions = new Map<string, SharedControlSocketAdmissions>()

function relayAdmissionsFor(required: readonly string[]): SharedControlSocketAdmissions {
  const key = required.join('\n')
  const admissions = relayAdmissions.get(key) ?? new WeakMap()
  relayAdmissions.set(key, admissions)
  return admissions
}

/**
 * Sends one call to a server behind `owner`, on the owner's shared socket. The envelope names the
 * relayed server, so the call leaves only after that same socket advertised the relay: a server
 * that ignores `executionHost` would answer from its own store, which may hold the same ids.
 */
export async function sendRelayedHostCall(
  shared: AdmittingSharedControlSocket,
  relayed: RelayedRuntimeEnvironment,
  call: {
    method: string
    params: unknown
    timeoutMs: number
    idlePassive?: boolean
    /** The relayed server's runtime the call was shaped for; another runtime never receives it. */
    expectedRuntimeId?: string
  },
  ownerName: string
): Promise<RuntimeRpcResponse<unknown>> {
  const refusal = relayedHostMethodRefusal(call.method, ownerName)
  if (refusal) {
    return refusal
  }
  const envelope = { executionHost: relayed.executionHost }
  const required = relayedHostCapabilitiesFor(call.method)
  const send = (request: { method: string; params: unknown }) =>
    sendOnAdmittedSharedControlSocket<unknown>(
      shared,
      { ...request, timeoutMs: call.timeoutMs, idlePassive: call.idlePassive, envelope },
      (status) => advertises(status, required),
      relayAdmissionsFor(required)
    )
  const unconfirmed = (): RuntimeRpcFailure =>
    relayedHostFailure(
      call.method,
      'remote_runtime_unavailable',
      `${ownerName} did not confirm it relays to its servers; nothing was sent`
    )
  if (call.expectedRuntimeId !== undefined) {
    const status = await send({ method: 'status.get', params: undefined })
    if (!status) {
      return unconfirmed()
    }
    if (!status.ok || status._meta?.runtimeId !== call.expectedRuntimeId) {
      return relayedRuntimeChanged(call.method)
    }
  }
  return (await send({ method: call.method, params: call.params })) ?? unconfirmed()
}

function relayedRuntimeChanged(method: string): RuntimeRpcFailure {
  return relayedHostFailure(
    method,
    'runtime_environment_changed',
    'Runtime environment identity changed; refresh and try again'
  )
}

/**
 * The admission a dedicated socket runs before its subscription names a relayed server: the same
 * socket must advertise the relay, and a pinned runtime must be the one the relayed server reports.
 */
export function relayedHostSubscriptionAdmission(
  relayed: RelayedRuntimeEnvironment,
  method: string,
  ownerName: string,
  expectedRuntimeId?: string
): (request: RemoteRuntimeSubscriptionAdmissionRequest) => Promise<void> {
  return async (request) => {
    const status = await request('status.get', undefined)
    if (!status.ok || !advertises(status.result, relayedHostCapabilitiesFor(method))) {
      throw new RemoteRuntimeClientError(
        'remote_runtime_unavailable',
        `${ownerName} did not confirm it relays ${method} to its servers; nothing was sent`
      )
    }
    if (expectedRuntimeId === undefined) {
      return
    }
    const relayedStatus = await request('status.get', undefined, {
      executionHost: relayed.executionHost
    })
    if (!relayedStatus.ok || relayedStatus._meta?.runtimeId !== expectedRuntimeId) {
      throw new RemoteRuntimeClientError(
        'runtime_environment_changed',
        'Runtime environment identity changed; refresh and try again'
      )
    }
  }
}
