import React from 'react'
import { LinuxPenguinIcon } from '@/components/icons/LinuxPenguinIcon'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { selectWorkspaceRuntimeEnvironmentId } from '../../lib/workspace/ownership/workspace-runtime-environment'
import { getRelayedWslReachDetail } from '../sidebar/worktree-list/rows/relayed-wsl-host-reach-detail'
import { selectWorkspaceHasNoTabs } from '../wsl-host-stopped/WslHostStoppedWorkspaceNotice'

type RelayedWslWorkspace = { distro: string; reach: AppState['relayedWslHosts'][number]['reach'] }

function selectRelayedWslWorkspace(
  state: AppState,
  worktreeId: string | null
): (RelayedWslWorkspace & { host: string }) | null {
  // Why gated: almost no workspace is on a relayed host, and this runs on every store change.
  if (worktreeId === null || state.relayedWslHosts.length === 0) {
    return null
  }
  const environmentId = selectWorkspaceRuntimeEnvironmentId(state, worktreeId)
  const relayed = state.relayedWslHosts.find((host) => host.environmentId === environmentId)
  // A ready distro opens like any server's workspace; only one that can't be reached needs saying.
  if (!relayed || relayed.reach === 'ready' || !selectWorkspaceHasNoTabs(state, worktreeId)) {
    return null
  }
  const owner = state.runtimeEnvironments.find(
    (environment) => environment.id === relayed.ownerEnvironmentId
  )
  return { distro: relayed.distro, reach: relayed.reach, host: owner?.name ?? relayed.label }
}

/** A workspace in a paired computer's WSL distro that is stopped or unreachable: say so instead of a blank surface. */
export function RelayedWslWorkspaceNotice({
  worktreeId
}: {
  worktreeId: string | null
}): React.JSX.Element | null {
  const t = useTranslate()
  const distro = useAppStore((state) => selectRelayedWslWorkspace(state, worktreeId)?.distro)
  const reach = useAppStore((state) => selectRelayedWslWorkspace(state, worktreeId)?.reach)
  const host = useAppStore((state) => selectRelayedWslWorkspace(state, worktreeId)?.host)
  if (!distro || !reach || !host) {
    return null
  }
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <div
        className="flex flex-col items-center justify-center gap-2 px-4 text-center text-sm text-muted-foreground"
        role="status"
        data-relayed-wsl-workspace-notice=""
      >
        <LinuxPenguinIcon className="mb-1 size-7 text-muted-foreground" />
        <span>{getRelayedWslReachDetail({ distro, reach }, host, t)}</span>
        <span>
          {t('auto.components.relayedWslHost.openOnHost', 'Open this workspace on {{host}}', {
            host
          })}
        </span>
      </div>
    </div>
  )
}
