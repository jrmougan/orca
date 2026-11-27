import React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { LinuxPenguinIcon } from '@/components/icons/LinuxPenguinIcon'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import type { Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { cn } from '@/lib/class-names'
import { parseExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { isRelayedRuntimeEnvironmentId } from '../../../../shared/remote-runtime/relay/relayed-runtime-environment'
import {
  isWslHostRuntimeEnvironment,
  type OrcadDeploymentLink
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'

/** The distro a WSL host runs in; null for any other host, including an unknown runtime id. */
export function selectWslHostDistro(
  state: {
    /** Optional: some list builders run before the environments load. */
    runtimeEnvironments?: readonly {
      id: string
      orcadDeployment?: OrcadDeploymentLink | null
    }[]
    /** A paired computer's WSL hosts, known by the distro that computer's relay listed. */
    relayedWslHosts?: readonly { environmentId: string; distro: string }[]
  },
  hostId: string | null | undefined
): string | null {
  const host = parseExecutionHostId(hostId)
  if (host?.kind !== 'runtime') {
    return null
  }
  if (isRelayedRuntimeEnvironmentId(host.environmentId)) {
    return (
      state.relayedWslHosts?.find((relayed) => relayed.environmentId === host.environmentId)
        ?.distro ?? null
    )
  }
  const environment = (state.runtimeEnvironments ?? []).find(
    (candidate) => candidate.id === host.environmentId
  )
  return environment && isWslHostRuntimeEnvironment(environment)
    ? environment.orcadDeployment.distro
    : null
}

export function useWslHostDistro(hostId: string | null | undefined): string | null {
  return useAppStore((state) => selectWslHostDistro(state, hostId))
}

/** A paired computer's WSL host: its mark sits beside that computer's label instead of replacing it. */
export function isRelayedWslHostId(hostId: string | null | undefined): boolean {
  const host = parseExecutionHostId(hostId)
  return host?.kind === 'runtime' && isRelayedRuntimeEnvironmentId(host.environmentId)
}

export function wslHostRunsOnLabel(distro: string, t: Translate = translate): string {
  return t('components.wslHostMark.runsOn', 'Runs on WSL: {{distro}} (Linux)', { distro })
}

/** Stands in for a WSL host's text badge on project and workspace rows. */
export function WslHostMark({
  distro,
  className,
  withTooltip = true
}: {
  distro: string
  className?: string
  /** Off where the row already has its own identity tooltip. */
  withTooltip?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const label = wslHostRunsOnLabel(distro, t)
  if (!withTooltip) {
    return (
      <span
        role="img"
        aria-label={label}
        data-wsl-host-mark={distro}
        className={cn('inline-flex shrink-0 items-center text-muted-foreground', className)}
      >
        <LinuxPenguinIcon className="size-3.5" />
      </span>
    )
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Focusable so keyboard users can open the tooltip too. */}
        <span
          role="img"
          aria-label={label}
          tabIndex={0}
          data-wsl-host-mark={distro}
          className={cn(
            'inline-flex shrink-0 items-center rounded-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            className
          )}
        >
          <LinuxPenguinIcon className="size-3.5" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
