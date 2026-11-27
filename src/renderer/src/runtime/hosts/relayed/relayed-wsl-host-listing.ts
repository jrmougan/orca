import { z } from 'zod'
import { RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY } from '../../../../../shared/remote-runtime/relay/mobile-desktop-relay-contract'
import {
  isWslHostRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../../../../shared/remote-runtime/host-catalog/runtime-environments'
import {
  isRuntimeHostContactRevoked,
  lastVerifiedRuntimeStatus,
  type RuntimeEnvironmentStatus
} from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { toRelayedRuntimeEnvironmentId } from '../../../../../shared/remote-runtime/relay/relayed-runtime-environment'
import type { RelayedWslHostReach } from '../../../../../shared/execution-host/relayed-wsl-execution-host'

// Another machine's answer: bound how much of it one relaying server can make this client hold.
const MAX_RELAYED_HOSTS = 50
const MAX_RELAYED_TEXT_LENGTH = 200
const MAX_RELAYED_ID_LENGTH = 1024

/** A WSL host of a paired server, listed here as one more `runtime:` catalog host. */
export type RelayedWslHost = {
  /** Synthetic environment id; routes to the owner with `executionHost` on the envelope. */
  environmentId: string
  ownerEnvironmentId: string
  label: string
  distro: string
  reach: RelayedWslHostReach
}

export type RelayingRuntimeOwner = {
  environmentId: string
  /** Verified over a ready transport now; only then may a read reach it. */
  inContact: boolean
}

type RelayingOwnerState = {
  runtimeEnvironments: readonly PublicKnownRuntimeEnvironment[]
  runtimeStatusByEnvironmentId: ReadonlyMap<string, RuntimeEnvironmentStatus>
}

/** Paired servers that advertised relaying on this pairing's connection; this computer's own WSL distros relay to nothing. */
export function relayingRuntimeOwners(state: RelayingOwnerState): RelayingRuntimeOwner[] {
  return state.runtimeEnvironments.flatMap((environment) => {
    if (isWslHostRuntimeEnvironment(environment)) {
      return []
    }
    const entry = state.runtimeStatusByEnvironmentId.get(environment.id)
    const snapshot = entry?.snapshot
    // Capabilities are per connection: status from an earlier pairing or a refusal says nothing now.
    if (
      !snapshot ||
      snapshot.pairingRevision !== (environment.pairingRevision ?? environment.createdAt) ||
      isRuntimeHostContactRevoked(entry) ||
      lastVerifiedRuntimeStatus(entry)?.capabilities?.some(
        (capability: string) => capability === RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY
      ) !== true
    ) {
      return []
    }
    return [
      {
        environmentId: environment.id,
        inContact: snapshot.verification === 'verified' && snapshot.transport === 'ready'
      }
    ]
  })
}

const HostsListSchema = z.object({ hosts: z.array(z.unknown()) })

const WslHostSchema = z.looseObject({
  hostId: z.string().max(MAX_RELAYED_ID_LENGTH),
  label: z.string(),
  relay: z.string(),
  stoppedOnDesktop: z.literal(true).optional().catch(undefined),
  unavailableOnDesktop: z.literal(true).optional().catch(undefined),
  wsl: z.object({ distro: z.string().min(1) })
})

function clip(text: string): string {
  return text.length > MAX_RELAYED_TEXT_LENGTH ? text.slice(0, MAX_RELAYED_TEXT_LENGTH) : text
}

function relayedReach(host: z.infer<typeof WslHostSchema>): RelayedWslHostReach {
  // Stopped hosts stay listed: the user sees where the distro can be started.
  if (host.stoppedOnDesktop) {
    return 'stopped'
  }
  if (host.unavailableOnDesktop) {
    return 'unavailable'
  }
  return host.relay === 'ready'
    ? 'ready'
    : host.relay === 'update-needed'
      ? 'update-needed'
      : 'unavailable'
}

/** The owner's WSL hosts from its `mobileRelay.hosts.list` answer; null when the answer is malformed. */
export function parseRelayedWslHosts(
  ownerEnvironmentId: string,
  result: unknown
): RelayedWslHost[] | null {
  const listed = HostsListSchema.safeParse(result)
  if (!listed.success) {
    return null
  }
  const hosts = new Map<string, RelayedWslHost>()
  for (const raw of listed.data.hosts) {
    if (hosts.size >= MAX_RELAYED_HOSTS) {
      break
    }
    // Only WSL hosts: any other server behind the owner has no place under its machine yet.
    const host = WslHostSchema.safeParse(raw)
    if (!host.success) {
      continue
    }
    const environmentId = toRelayedRuntimeEnvironmentId({
      ownerEnvironmentId,
      executionHost: host.data.hostId
    })
    if (!environmentId || hosts.has(environmentId)) {
      continue
    }
    hosts.set(environmentId, {
      environmentId,
      ownerEnvironmentId,
      label: clip(host.data.label),
      distro: clip(host.data.wsl.distro),
      reach: relayedReach(host.data)
    })
  }
  return [...hosts.values()]
}
