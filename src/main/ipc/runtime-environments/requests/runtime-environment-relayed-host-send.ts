import { RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY } from '../../../../shared/remote-runtime/relay/mobile-desktop-relay-contract'
import {
  RELAYED_RUNTIME_CATALOG_METHODS,
  type RelayedRuntimeEnvironment
} from '../../../../shared/remote-runtime/relay/relayed-runtime-environment'
import type {
  RuntimeRpcFailure,
  RuntimeRpcResponse
} from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import {
  sendOnAdmittedSharedControlSocket,
  type AdmittingSharedControlSocket
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
 * Sends one catalog read to a server behind `owner`, on the owner's shared socket. The envelope
 * names the relayed server, so the call leaves only after that same socket advertised the relay:
 * a server that ignores `executionHost` would answer from its own store, which may hold the same repo id.
 */
export async function sendRelayedHostCall(
  shared: AdmittingSharedControlSocket,
  relayed: RelayedRuntimeEnvironment,
  call: { method: string; params: unknown; timeoutMs: number; idlePassive?: boolean },
  ownerName: string
): Promise<RuntimeRpcResponse<unknown>> {
  if (!RELAYED_RUNTIME_CATALOG_METHODS.has(call.method)) {
    // method_not_found: callers with a legacy fallback (worktree.detectedList) take it.
    return relayedHostFailure(
      call.method,
      'method_not_found',
      `${call.method} is not available yet on a server reached through ${ownerName}`
    )
  }
  const response = await sendOnAdmittedSharedControlSocket<unknown>(
    shared,
    { ...call, envelope: { executionHost: relayed.executionHost } },
    (status) =>
      status.capabilities?.some(
        (capability: string) => capability === RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY
      ) === true
  )
  return (
    response ??
    relayedHostFailure(
      call.method,
      'remote_runtime_unavailable',
      `${ownerName} did not confirm it relays to its servers; nothing was sent`
    )
  )
}
