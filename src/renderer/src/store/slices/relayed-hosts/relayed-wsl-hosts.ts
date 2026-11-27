import type { StateCreator } from 'zustand'
import type { AppState } from '../../types'
import { MOBILE_RELAY_HOSTS_LIST_METHOD } from '../../../../../shared/remote-runtime/relay/mobile-relay-hosts-contract'
import { persistedUIValuesEqual } from '../../../../../shared/collections/persisted-ui-equality'
import { callRuntimeRpc } from '../../../runtime/rpc/calls/runtime-rpc-call'
import {
  parseRelayedWslHosts,
  relayingRuntimeOwners,
  type RelayedWslHost
} from '../../../runtime/hosts/relayed/relayed-wsl-host-listing'

/** One owner's answer: its WSL hosts, or null when it did not answer (its known hosts stand). */
export type RelayedWslHostListing = { ownerEnvironmentId: string; hosts: RelayedWslHost[] | null }

/** WSL hosts of paired servers; their projects live in the normal catalog under `runtime:<environmentId>`. */
export type RelayedWslHostsSlice = {
  relayedWslHosts: readonly RelayedWslHost[]
  /** `relayingOwnerIds`: the servers that relay now; hosts of any other owner are dropped with their rows. */
  applyRelayedWslHostListings: (
    listings: readonly RelayedWslHostListing[],
    relayingOwnerIds: ReadonlySet<string>
  ) => void
  refreshRelayedWslHosts: () => Promise<void>
}

const refreshesInFlight = new WeakMap<object, Promise<void>>()

async function readRelayedWslHosts(ownerEnvironmentId: string): Promise<RelayedWslHost[] | null> {
  try {
    // Answered by the paired server itself, so it reaches (and wakes) no distro.
    const result = await callRuntimeRpc<unknown>(
      { kind: 'environment', environmentId: ownerEnvironmentId },
      MOBILE_RELAY_HOSTS_LIST_METHOD,
      undefined,
      { timeoutMs: 15_000, background: true, reuseRecentCompatibilityFailure: true }
    )
    return parseRelayedWslHosts(ownerEnvironmentId, result)
  } catch {
    return null
  }
}

export const createRelayedWslHostsSlice: StateCreator<AppState, [], [], RelayedWslHostsSlice> = (
  set,
  get
) => ({
  relayedWslHosts: [],

  applyRelayedWslHostListings: (listings, relayingOwnerIds) => {
    const previous = get().relayedWslHosts
    const answered = new Map(
      listings.flatMap(({ ownerEnvironmentId, hosts }) =>
        hosts && relayingOwnerIds.has(ownerEnvironmentId)
          ? [[ownerEnvironmentId, hosts] as const]
          : []
      )
    )
    const next = [
      ...previous.filter(
        (host) =>
          relayingOwnerIds.has(host.ownerEnvironmentId) && !answered.has(host.ownerEnvironmentId)
      ),
      ...[...answered.values()].flat()
    ]
    if (persistedUIValuesEqual(previous, next)) {
      return
    }
    const nextIds = new Set(next.map((host) => host.environmentId))
    const gone = previous.flatMap((host) =>
      nextIds.has(host.environmentId) ? [] : [host.environmentId]
    )
    const readyBefore = new Set(
      previous.flatMap((host) => (host.reach === 'ready' ? [host.environmentId] : []))
    )
    set({ relayedWslHosts: next })
    // A host its owner no longer lists is gone like a removed server: its rows must not linger.
    if (gone.length > 0) {
      get().purgeStaleRuntimeHostState?.(gone)
    }
    if (next.some((host) => host.reach === 'ready' && !readyBefore.has(host.environmentId))) {
      // Newly reachable hosts join the catalogs through the same all-host load as any server.
      void get().fetchReposForAllHosts?.()
      void get().fetchProjectGroupsForAllHosts?.()
      void get().fetchFolderWorkspacesForAllHosts?.()
    }
  },

  refreshRelayedWslHosts: () => {
    const inFlight = refreshesInFlight.get(get)
    if (inFlight) {
      return inFlight
    }
    const refresh = (async () => {
      // Owners that do not advertise the relay are never asked, and never sent an executionHost.
      const owners = relayingRuntimeOwners(get())
      const listings = await Promise.all(
        owners
          .filter((owner) => owner.inContact)
          .map(async ({ environmentId }) => ({
            ownerEnvironmentId: environmentId,
            hosts: await readRelayedWslHosts(environmentId)
          }))
      )
      // Re-read: an owner unpaired or downgraded while the listing was out must not be re-added.
      get().applyRelayedWslHostListings(
        listings,
        new Set(relayingRuntimeOwners(get()).map((owner) => owner.environmentId))
      )
    })().finally(() => refreshesInFlight.delete(get))
    refreshesInFlight.set(get, refresh)
    return refresh
  }
})
