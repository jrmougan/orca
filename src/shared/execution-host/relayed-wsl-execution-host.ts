/** A paired server's WSL distro is that machine's project space: one picker row, both ownership ids in the registry. */
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from './execution-host'
import type { ExecutionHostRegistryEntry } from './execution-host-registry-entry'
import { parseRelayedRuntimeEnvironmentId } from '../remote-runtime/relay/relayed-runtime-environment'

/** Whether the paired server can relay to its WSL host now; `stopped` is a distro confirmed stopped there. */
export type RelayedWslHostReach = 'ready' | 'stopped' | 'unavailable' | 'update-needed'

export type RelayedWslHostSummary = {
  /** Synthetic environment id of the relayed host. */
  environmentId: string
  distro: string
  reach: RelayedWslHostReach
}

function mergeUnderOwner(
  hosts: Map<ExecutionHostId, ExecutionHostRegistryEntry>,
  environmentId: string,
  wsl: { distro: string; reach: RelayedWslHostReach } | null
): void {
  const relayed = parseRelayedRuntimeEnvironmentId(environmentId)
  const owner = relayed && hosts.get(toRuntimeExecutionHostId(relayed.ownerEnvironmentId))
  // An unpaired owner leaves no machine to list under.
  if (!owner) {
    return
  }
  const hostId = toRuntimeExecutionHostId(environmentId)
  const shown = (owner.mergedIntoHostId && hosts.get(owner.mergedIntoHostId)) || owner
  hosts.set(hostId, {
    id: hostId,
    kind: 'runtime',
    label: shown.label,
    detail: wsl ? `WSL · ${wsl.distro}` : 'WSL',
    // Reachable only through the owner, and only while the distro runs there.
    health: wsl?.reach === 'ready' ? owner.health : 'disconnected',
    mergedIntoHostId: shown.id,
    ...(wsl ? { relayedWsl: wsl } : {})
  })
  if (!shown.aliasHostIds?.includes(hostId)) {
    hosts.set(shown.id, { ...shown, aliasHostIds: [...(shown.aliasHostIds ?? []), hostId] })
  }
}

/** Merge relayed WSL hosts into their paired machine in place; rows that only reference one merge too. */
export function annotateRelayedWslExecutionHosts(args: {
  hosts: Map<ExecutionHostId, ExecutionHostRegistryEntry>
  relayedWslHosts?: readonly RelayedWslHostSummary[]
}): void {
  const described = new Set<string>()
  for (const host of args.relayedWslHosts ?? []) {
    described.add(host.environmentId)
    mergeUnderOwner(args.hosts, host.environmentId, { distro: host.distro, reach: host.reach })
  }
  // Rewrites existing keys only, so iterating the live map is safe.
  for (const host of args.hosts.values()) {
    const parsed = parseExecutionHostId(host.id)
    if (parsed?.kind === 'runtime' && !described.has(parsed.environmentId)) {
      mergeUnderOwner(args.hosts, parsed.environmentId, null)
    }
  }
}
