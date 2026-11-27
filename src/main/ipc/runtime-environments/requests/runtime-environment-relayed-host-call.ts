import {
  getPreferredPairedRuntimeConnection,
  isWslHostRuntimeEnvironment,
  type KnownRuntimeEnvironment
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { resolveEnvironment } from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import { RuntimeEnvironmentStoreError } from '../../../../shared/remote-runtime/host-store/runtime-environment-store-records'
import {
  parseRelayedRuntimeEnvironmentId,
  type RelayedRuntimeEnvironment
} from '../../../../shared/remote-runtime/relay/relayed-runtime-environment'
import { RemoteRuntimeClientError } from '../../../../shared/remote-runtime/remote-runtime-client-error'
import { RuntimeRpcCallQueueOverloadError } from '../../../../shared/remote-runtime/rpc/runtime-rpc-call-queue'
import type {
  RuntimeRpcFailure,
  RuntimeRpcResponse
} from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { getSharedControlConnection } from '../connections/runtime-environment-request-connections'
import {
  isRuntimeEnvironmentManuallyDisconnected,
  runtimeEnvironmentManualDisconnectReason
} from '../connectivity/runtime-environment-manual-disconnect'
import { enqueueRuntimeCall } from './runtime-environment-call-queue'
import {
  relayedHostFailure,
  relayedHostMethodRefusal,
  sendRelayedHostCall
} from './runtime-environment-relayed-host-send'
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

export type RelayedHostOwner =
  | { failure: RuntimeRpcFailure }
  | { failure: null; owner: KnownRuntimeEnvironment; relayed: RelayedRuntimeEnvironment }

/**
 * The paired server a `relay:` id rides, prepared and held to the caller's pairing fence. The
 * relayed server's own runtime is never compared with the owner's: only a send can ask it.
 */
export async function resolveRelayedHostOwner(
  userDataPath: string,
  selector: string,
  method: string,
  expectedPairingRevision: number | undefined,
  signal?: AbortSignal
): Promise<RelayedHostOwner> {
  const relayed = parseRelayedRuntimeEnvironmentId(selector)
  if (!relayed) {
    return { failure: relayedHostFailure(method, 'invalid_argument', 'Unknown relayed server') }
  }
  let saved: KnownRuntimeEnvironment
  try {
    saved = await resolveEnvironment(userDataPath, relayed.ownerEnvironmentId)
  } catch (error) {
    // Unpaired since the id was minted: the server it named is gone.
    if (error instanceof RuntimeEnvironmentStoreError) {
      return {
        failure: relayedHostFailure(
          method,
          'runtime_environment_changed',
          'Runtime environment pairing changed; refresh and try again'
        )
      }
    }
    throw error
  }
  // This computer's own WSL distro connects for work open here; it relays to nothing.
  if (isWslHostRuntimeEnvironment(saved)) {
    return {
      failure: relayedHostFailure(method, 'forbidden', `${saved.name} does not relay to servers`)
    }
  }
  if (isRuntimeEnvironmentManuallyDisconnected(saved.id)) {
    return {
      failure: relayedHostFailure(
        method,
        'runtime_manually_disconnected',
        runtimeEnvironmentManualDisconnectReason(saved.id)
      )
    }
  }
  const refusal = relayedHostMethodRefusal(method, saved.name)
  if (refusal) {
    return { failure: refusal }
  }
  const prepared = await prepareFencedRuntimeRequest(
    userDataPath,
    saved.id,
    method,
    undefined,
    { pairingRevision: expectedPairingRevision, runtimeId: undefined },
    signal
  )
  if (prepared.failure) {
    // Restamped: the owner's runtime id must not sign a reply for the relayed server.
    return {
      failure: prepared.failure.ok
        ? relayedHostFailure(method, 'runtime_error', 'Unexpected preparation reply')
        : relayedHostFailure(method, prepared.failure.error.code, prepared.failure.error.message)
    }
  }
  return { failure: null, owner: prepared.environment, relayed }
}

/** Answers a renderer call on a `relay:` environment through the paired server that relays to it. */
export async function callRelayedRuntimeHost(
  userDataPath: string,
  call: RelayedHostCall
): Promise<RuntimeRpcResponse<unknown>> {
  const { method } = call
  try {
    return await enqueueRuntimeCall(call.selector, method, async () => {
      const resolved = await resolveRelayedHostOwner(
        userDataPath,
        call.selector,
        method,
        call.expectedEnvironmentPairingRevision
      )
      if (resolved.failure) {
        return resolved.failure
      }
      const { owner, relayed } = resolved
      return sendRelayedHostCall(
        getSharedControlConnection(owner.id, getPreferredPairedRuntimeConnection(owner)),
        relayed,
        {
          method,
          params: call.params,
          timeoutMs: call.timeoutMs ?? DEFAULT_RELAYED_HOST_TIMEOUT_MS,
          idlePassive: call.background === true,
          expectedRuntimeId: call.expectedEnvironmentRuntimeId
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
    throw error
  }
}
