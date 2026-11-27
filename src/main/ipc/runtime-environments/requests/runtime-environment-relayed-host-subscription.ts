import { getPreferredPairedRuntimeConnection } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { RUNTIME_CLIENT_RELAY_TERMINAL_MULTIPLEX_RUNTIME_CAPABILITY } from '../../../../shared/remote-runtime/relay/mobile-desktop-relay-contract'
import type { RemoteRuntimeTransportSubscription } from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-contract'
import { subscribeRemoteRuntimeTransport } from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-transport'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { desktopRuntimeClientCapabilities } from '../connections/runtime-environment-shared-control-policy'
import { decodeRuntimeEnvironmentSubscriptionEvents } from '../subscriptions/runtime-environment-subscription-events'
import { resolveRelayedHostOwner } from './runtime-environment-relayed-host-call'
import { relayedHostSubscriptionAdmission } from './runtime-environment-relayed-host-send'
import { subscribeRuntimeEnvironment } from './runtime-environment-transport-routing'
import { withRuntimeUnreachableHint } from './runtime-environment-unreachable-hint'

const DEFAULT_RELAYED_HOST_TIMEOUT_MS = 15_000

type RelayedHostSubscriptionEvent =
  | { type: 'response'; response: RuntimeRpcResponse<unknown> }
  | { type: 'binary'; bytes: Uint8Array<ArrayBufferLike> }
  | { type: 'error'; code: string; message: string }
  | { type: 'close' }

/**
 * Opens a stream (or an abortable call) on a `relay:` environment. It gets its own socket to the
 * paired server, which must advertise the relay on that socket before the request names the
 * relayed server. A refusal decided here is answered as the stream's one response, so callers
 * with a fallback for an unavailable method take it as they would from a server.
 */
export async function subscribeRelayedRuntimeHost(
  userDataPath: string,
  request: {
    selector: string
    method: string
    params: unknown
    timeoutMs?: number
    expectedPairingRevision?: number
    expectedRuntimeId?: string
    background?: boolean
  },
  rawCallbacks: { onEvent: (event: RelayedHostSubscriptionEvent) => void; onClose: () => void },
  isCurrent: () => boolean,
  signal?: AbortSignal
): Promise<RemoteRuntimeTransportSubscription> {
  const { method } = request
  const onEvent = decodeRuntimeEnvironmentSubscriptionEvents(
    method,
    rawCallbacks.onEvent,
    isCurrent
  )
  const resolved = await resolveRelayedHostOwner(
    userDataPath,
    request.selector,
    method,
    request.expectedPairingRevision,
    signal
  )
  if (resolved.failure) {
    onEvent({ type: 'response', response: resolved.failure })
    onEvent({ type: 'close' })
    rawCallbacks.onClose()
    return { requestId: resolved.failure.id, close: () => {}, sendBinary: () => false }
  }
  const { owner, relayed } = resolved
  const connection = getPreferredPairedRuntimeConnection(owner)
  try {
    return await subscribeRemoteRuntimeTransport(
      connection,
      method,
      request.params,
      request.timeoutMs ?? DEFAULT_RELAYED_HOST_TIMEOUT_MS,
      {
        // Never recorded as the owner's use or runtime: the answers are the relayed server's.
        onResponse: (response) => onEvent({ type: 'response', response }),
        onBinary: (bytes) => onEvent({ type: 'binary', bytes }),
        onError: (error) =>
          onEvent({
            type: 'error',
            code: error.code,
            message: withRuntimeUnreachableHint(owner, error.message, connection.endpoint)
          }),
        onClose: () => {
          onEvent({ type: 'close' })
          rawCallbacks.onClose()
        }
      },
      {
        clientCapabilities:
          method === 'terminal.multiplex'
            ? [
                ...desktopRuntimeClientCapabilities(owner.id),
                RUNTIME_CLIENT_RELAY_TERMINAL_MULTIPLEX_RUNTIME_CAPABILITY
              ]
            : desktopRuntimeClientCapabilities(owner.id),
        envelope: { executionHost: relayed.executionHost },
        admit: relayedHostSubscriptionAdmission(
          relayed,
          method,
          owner.name,
          request.expectedRuntimeId
        ),
        idlePassive: request.background,
        signal
      }
    )
  } catch (error) {
    if (error instanceof Error && error.name !== 'AbortError') {
      error.message = withRuntimeUnreachableHint(owner, error.message, connection.endpoint)
    }
    throw error
  }
}

export type RuntimeEnvironmentSubscriptionCallbacks = Parameters<
  typeof subscribeRuntimeEnvironment
>[5]

/** One renderer stream on its transport: the saved server's own, or its relay to the server `args.selector` names. */
export function openRuntimeEnvironmentSubscription(open: {
  userDataPath: string
  /** The saved server: the selector's own, or the one that relays to it. */
  environmentId: string
  relayed: boolean
  pairingRevision: number
  args: {
    selector: string
    method: string
    params?: unknown
    timeoutMs?: number
    expectedEnvironmentRuntimeId?: string | null
    background?: boolean
    wake?: boolean
  }
  callbacks: RuntimeEnvironmentSubscriptionCallbacks
  isCurrent: () => boolean
  signal: AbortSignal
  crewAttempt: Parameters<typeof subscribeRuntimeEnvironment>[9]
}): Promise<RemoteRuntimeTransportSubscription> {
  const { args } = open
  if (open.relayed) {
    return subscribeRelayedRuntimeHost(
      open.userDataPath,
      {
        selector: args.selector,
        method: args.method,
        params: args.params,
        timeoutMs: args.timeoutMs,
        expectedPairingRevision: open.pairingRevision,
        expectedRuntimeId: args.expectedEnvironmentRuntimeId ?? undefined,
        background: args.background
      },
      open.callbacks,
      open.isCurrent,
      open.signal
    )
  }
  return subscribeRuntimeEnvironment(
    open.userDataPath,
    open.environmentId,
    args.method,
    args.params,
    args.timeoutMs,
    open.callbacks,
    open.isCurrent,
    open.signal,
    args.background || args.wake ? { background: args.background, wake: args.wake } : undefined,
    open.crewAttempt
  )
}
