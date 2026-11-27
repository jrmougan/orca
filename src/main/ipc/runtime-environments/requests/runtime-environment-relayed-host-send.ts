import {
  RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY,
  RUNTIME_CLIENT_RELAY_TERMINAL_MULTIPLEX_RUNTIME_CAPABILITY
} from '../../../../shared/remote-runtime/relay/mobile-desktop-relay-contract'
import {
  RELAYED_RUNTIME_METHODS,
  type RelayedRuntimeEnvironment
} from '../../../../shared/remote-runtime/relay/relayed-runtime-environment'
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

/** Null when `method` may be asked of a relayed server; otherwise this computer's refusal. */
export function relayedHostMethodRefusal(
  method: string,
  ownerName: string
): RuntimeRpcFailure | null {
  if (RELAYED_RUNTIME_METHODS.has(method)) {
    return null
  }
  // method_not_found: callers with a fallback for an older server (worktree.detectedList) take it.
  return relayedHostFailure(
    method,
    'method_not_found',
    `${method} is not available yet on a server reached through ${ownerName}`
  )
}

/** The capabilities a server must advertise, on the socket that sends, before `method` names a relayed server. */
export function relayedHostCapabilitiesFor(method: string): readonly string[] {
  return method === 'terminal.multiplex'
    ? [
        RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY,
        RUNTIME_CLIENT_RELAY_TERMINAL_MULTIPLEX_RUNTIME_CAPABILITY
      ]
    : [RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY]
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

const relayAdmissions: SharedControlSocketAdmissions = new WeakMap()

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
      // The memo records the relay capability alone.
      required.length === 1 ? relayAdmissions : undefined
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
