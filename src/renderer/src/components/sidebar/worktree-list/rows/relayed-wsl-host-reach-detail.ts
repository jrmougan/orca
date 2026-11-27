import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { ExecutionHostRegistryEntry } from '../../../../../../shared/execution-host/execution-host-registry-entry'

type RelayedWsl = NonNullable<ExecutionHostRegistryEntry['relayedWsl']>

/** Why a paired computer's WSL distro can't be reached from here; null while it can. Only that computer starts it. */
export function getRelayedWslReachDetail(
  wsl: RelayedWsl,
  hostLabel: string,
  t: Translate = translate
): string | null {
  const values = { distro: wsl.distro, host: hostLabel }
  switch (wsl.reach) {
    case 'ready':
      return null
    case 'stopped':
      return t(
        'auto.components.sidebar.WorktreeList.relayedWslStopped',
        '{{distro}} is stopped on {{host}}',
        values
      )
    case 'update-needed':
      return t(
        'auto.components.sidebar.WorktreeList.relayedWslUpdateNeeded',
        '{{distro}} needs an Orca update on {{host}}',
        values
      )
    case 'unavailable':
      return t(
        'auto.components.sidebar.WorktreeList.relayedWslUnavailable',
        '{{distro}} is not running on {{host}}',
        values
      )
  }
}
