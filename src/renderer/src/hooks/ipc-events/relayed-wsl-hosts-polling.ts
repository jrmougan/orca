import {
  installWindowVisibilityInterval,
  isWindowVisible
} from '@/lib/window-activity/window-visibility-interval'
import { relayingRuntimeOwners } from '@/runtime/hosts/relayed/relayed-wsl-host-listing'
import { useAppStore } from '../../store'
import type { AppState } from '../../store/types'

// Paired servers announce no host-list events to this client; the list itself is answered without reaching a distro.
const RELAYED_WSL_HOSTS_REFRESH_MS = 30_000

type PollingStore = Pick<typeof useAppStore, 'getState' | 'subscribe'>

function relayingOwnersKey(state: AppState): string {
  return relayingRuntimeOwners(state)
    .map((owner) => `${owner.environmentId}\0${owner.inContact}`)
    .join('\n')
}

/** Poll relaying servers while the window is visible; re-read at once when pairings, contact or the capability change. */
export function installRelayedWslHostsPolling(store: PollingStore = useAppStore): () => void {
  let ownersKey = ''
  let stopInterval: (() => void) | null = null
  const refresh = (): void => {
    void store.getState().refreshRelayedWslHosts()
  }
  const sync = (): void => {
    const key = relayingOwnersKey(store.getState())
    if (key === ownersKey) {
      return
    }
    const hadOwners = ownersKey !== ''
    ownersKey = key
    if (key === '') {
      stopInterval?.()
      stopInterval = null
      // No server relays now: the refresh drops every host listed under one that did.
      if (hadOwners) {
        refresh()
      }
      return
    }
    if (!stopInterval) {
      // Runs at once when visible, then on the interval; a hidden window waits for visibility.
      stopInterval = installWindowVisibilityInterval({
        run: refresh,
        intervalMs: RELAYED_WSL_HOSTS_REFRESH_MS,
        slowWhileUnfocused: true
      })
    } else if (isWindowVisible()) {
      refresh()
    }
  }
  const unsubscribe = store.subscribe((state, previous) => {
    if (
      state.runtimeEnvironments !== previous.runtimeEnvironments ||
      state.runtimeStatusByEnvironmentId !== previous.runtimeStatusByEnvironmentId
    ) {
      sync()
    }
  })
  sync()
  return () => {
    unsubscribe()
    stopInterval?.()
    stopInterval = null
  }
}
