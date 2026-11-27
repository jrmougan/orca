import {
  lastVerifiedRuntimeStatus,
  type RuntimeEnvironmentStatus
} from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { RuntimeStatus } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RelayedWslHost } from '../../../runtime/hosts/relayed/relayed-wsl-host-listing'
import { runtimeEnvironmentStatusesEqual } from '../runtime-status/runtime-environment-status-equality'
import type { HostStatusReplacement } from '../runtime-status/host-status-transaction-draft'
import {
  advanceRuntimeEnvironmentConnectionGeneration,
  getRuntimeEnvironmentConnectionGeneration
} from '../runtime-status/runtime-status-connection-generation'

/** A relayed host's own `status.get` answer; null when it is not reachable, undefined when nobody answered. */
export type RelayedHostStatusReading = {
  environmentId: string
  status: RuntimeStatus | null | undefined
}

// The owner's contact epoch each relayed entry was last written under.
const ownerContactEpochByRelayedHost = new Map<string, number>()

/**
 * The status entries a relayed host's readings stand for. A relayed host has no status owner in
 * the main process: its entry is its own answer through the relay, on its owner's connection.
 * An unanswered read keeps the entry, since a relay hiccup proves nothing about the host.
 */
export function relayedHostStatusReplacements(
  state: {
    relayedWslHosts: readonly RelayedWslHost[]
    runtimeStatusByEnvironmentId: ReadonlyMap<string, RuntimeEnvironmentStatus>
  },
  readings: readonly RelayedHostStatusReading[],
  now = Date.now()
): HostStatusReplacement[] {
  const hostsById = new Map(state.relayedWslHosts.map((host) => [host.environmentId, host]))
  const replacements: HostStatusReplacement[] = []
  for (const { environmentId, status } of readings) {
    const host = hostsById.get(environmentId)
    if (!host || status === undefined) {
      continue
    }
    const previous = state.runtimeStatusByEnvironmentId.get(environmentId)
    const previousRuntimeId = lastVerifiedRuntimeStatus(previous)?.runtimeId
    // Same rule as a paired server: the first answer starts no new connection, a new runtime does.
    if (previous !== undefined && status !== null && previousRuntimeId !== status.runtimeId) {
      advanceRuntimeEnvironmentConnectionGeneration(environmentId)
    }
    const ownerEpoch =
      state.runtimeStatusByEnvironmentId.get(host.ownerEnvironmentId)?.hostContactEpoch ?? 0
    const writtenUnder = ownerContactEpochByRelayedHost.get(environmentId)
    const contactRegained =
      status !== null &&
      (previous?.status === null || (writtenUnder !== undefined && writtenUnder !== ownerEpoch))
    ownerContactEpochByRelayedHost.set(environmentId, ownerEpoch)
    const next: RuntimeEnvironmentStatus = {
      status,
      checkedAt: now,
      connectionGeneration: getRuntimeEnvironmentConnectionGeneration(environmentId),
      // Streams that ended with lost contact restart on this edge, here or at the owner.
      hostContactEpoch: (previous?.hostContactEpoch ?? 0) + (contactRegained ? 1 : 0)
    }
    if (!previous || !runtimeEnvironmentStatusesEqual(previous, next)) {
      replacements.push([environmentId, next])
    }
  }
  return replacements
}

/** Drops what was remembered for hosts their owners no longer list. */
export function forgetRelayedHostStatuses(environmentIds: Iterable<string>): void {
  for (const environmentId of environmentIds) {
    ownerContactEpochByRelayedHost.delete(environmentId)
  }
}
