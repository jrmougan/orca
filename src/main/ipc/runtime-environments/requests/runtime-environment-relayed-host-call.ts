import {
  getPreferredPairedRuntimeConnection,
  isWslHostRuntimeEnvironment
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { resolveEnvironment } from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import { RuntimeEnvironmentStoreError } from '../../../../shared/remote-runtime/host-store/runtime-environment-store-records'
import { parseRelayedRuntimeEnvironmentId } from '../../../../shared/remote-runtime/relay/relayed-runtime-environment'
import { RemoteRuntimeClientError } from '../../../../shared/remote-runtime/remote-runtime-client-error'
import { RuntimeRpcCallQueueOverloadError } from '../../../../shared/remote-runtime/rpc/runtime-rpc-call-queue'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { getSharedControlConnection } from '../connections/runtime-environment-request-connections'
import {
  isRuntimeEnvironmentManuallyDisconnected,
  runtimeEnvironmentManualDisconnectReason
} from '../connectivity/runtime-environment-manual-disconnect'
import { enqueueRuntimeCall } from './runtime-environment-call-queue'
import { relayedHostFailure, sendRelayedHostCall } from './runtime-environment-relayed-host-send'
import { prepareFencedRuntimeRequest } from './runtime-environment-request-preparation'

const DEFAULT_RELAYED_HOST_TIMEOUT_MS = 15_000

type RelayedHostCall = {
  selector: string
  method: string
  params?: unknown
  timeoutMs?: number
  expectedEnvironmentPairingRevision?: number
  expectedEnvironmentRuntimeId?: string
  background?: boolean
}

/** Answers a renderer call on a `relay:` environment through the paired server that relays to it. */
export async function callRelayedRuntimeHost(
  userDataPath: string,
  call: RelayedHostCall
): Promise<RuntimeRpcResponse<unknown>> {
  const { method } = call
  const relayed = parseRelayedRuntimeEnvironmentId(call.selector)
  if (!relayed) {
    return relayedHostFailure(method, 'invalid_argument', 'Unknown relayed server')
  }
  // The relayed server's runtime can't be proven before the send.
  if (call.expectedEnvironmentRuntimeId !== undefined) {
    return relayedHostFailure(method, 'forbidden', "A runtime can't be pinned through a relay")
  }
  try {
    return await enqueueRuntimeCall(call.selector, method, async () => {
      const saved = await resolveEnvironment(userDataPath, relayed.ownerEnvironmentId)
      // This computer's own WSL distro connects for work open here; it relays to nothing.
      if (isWslHostRuntimeEnvironment(saved)) {
        return relayedHostFailure(method, 'forbidden', `${saved.name} does not relay to servers`)
      }
      if (isRuntimeEnvironmentManuallyDisconnected(saved.id)) {
        return relayedHostFailure(
          method,
          'runtime_manually_disconnected',
          runtimeEnvironmentManualDisconnectReason(saved.id)
        )
      }
      const prepared = await prepareFencedRuntimeRequest(
        userDataPath,
        saved.id,
        method,
        undefined,
        { pairingRevision: call.expectedEnvironmentPairingRevision, runtimeId: undefined }
      )
      if (prepared.failure) {
        // Restamped: the owner's runtime id must not sign a reply for the relayed server.
        return prepared.failure.ok
          ? prepared.failure
          : relayedHostFailure(method, prepared.failure.error.code, prepared.failure.error.message)
      }
      const owner = prepared.environment
      return sendRelayedHostCall(
        getSharedControlConnection(owner.id, getPreferredPairedRuntimeConnection(owner)),
        relayed,
        {
          method,
          params: call.params,
          timeoutMs: call.timeoutMs ?? DEFAULT_RELAYED_HOST_TIMEOUT_MS,
          idlePassive: call.background === true
        },
        owner.name
      )
    })
  } catch (error) {
    if (
      error instanceof RemoteRuntimeClientError ||
      error instanceof RuntimeRpcCallQueueOverloadError
    ) {
      return relayedHostFailure(method, error.code, error.message)
    }
    // Unpaired since the id was minted: the server it named is gone.
    if (error instanceof RuntimeEnvironmentStoreError) {
      return relayedHostFailure(
        method,
        'runtime_environment_changed',
        'Runtime environment pairing changed; refresh and try again'
      )
    }
    throw error
  }
}
