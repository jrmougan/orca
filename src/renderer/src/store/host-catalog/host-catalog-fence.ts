import type { AppState } from '../types'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { isRemovedRuntimeHostId } from './removed-runtime-host-rows'
import { isRelayedRuntimeEnvironmentId } from '../../../../shared/remote-runtime/relay/relayed-runtime-environment'
import { getEnvironmentSshStateGeneration } from '../slices/ssh/runtime-environment-ssh'
import { getRuntimeTargetHostId } from '../../runtime/rpc/targets/runtime-client-target'
import type { HostIdentityFence } from '../../runtime/rpc/environment-revisions/host-identity-fence'
import {
  captureHostIdentityFence,
  isHostIdentityFenceCurrent
} from '../../runtime/rpc/environment-revisions/host-identity-fence'

export type HostCatalogKind = 'repos' | 'project-groups' | 'folder-workspaces'

export type HostCatalogIdentity = {
  target: RuntimeClientTarget
  identity: HostIdentityFence
  sshStateGeneration: number | null
}

/** Identity fence plus data generations: guards reads that apply a host's catalog snapshot. */
export type HostCatalogFence = HostCatalogIdentity & { key: string; generation: number }

type CatalogFenceState = Pick<AppState, 'removedRuntimeEnvironmentIds'> &
  Partial<Pick<AppState, 'relayedWslHosts'>>

type CatalogFenceStore = () => CatalogFenceState

const latestHostCatalogGenerationByStore = new WeakMap<CatalogFenceStore, Map<string, number>>()

export function claimHostCatalogFence(
  get: CatalogFenceStore,
  kind: HostCatalogKind,
  target: RuntimeClientTarget
): HostCatalogFence {
  const key = `${kind}:${getRuntimeTargetHostId(target)}`
  let generations = latestHostCatalogGenerationByStore.get(get)
  if (!generations) {
    generations = new Map()
    latestHostCatalogGenerationByStore.set(get, generations)
  }
  const generation = (generations.get(key) ?? 0) + 1
  generations.set(key, generation)
  return {
    key,
    generation,
    target,
    identity: captureHostIdentityFence({ target, at: 'local' }),
    sshStateGeneration:
      target.kind === 'environment' ? getEnvironmentSshStateGeneration(target.environmentId) : null
  }
}

export function isHostCatalogFenceCurrent(
  get: CatalogFenceStore,
  fence: HostCatalogFence
): boolean {
  if (latestHostCatalogGenerationByStore.get(get)?.get(fence.key) !== fence.generation) {
    return false
  }
  return isHostCatalogIdentityCurrent(get(), fence)
}

export function isHostCatalogIdentityCurrent(
  state: CatalogFenceState,
  fence: HostCatalogIdentity
): boolean {
  if (fence.target.kind !== 'environment') {
    return true
  }
  const { environmentId } = fence.target
  // A relayed host exists only while its owner lists it: unpairing or losing the relay retires it.
  if (
    isRelayedRuntimeEnvironmentId(environmentId) &&
    !state.relayedWslHosts?.some((host) => host.environmentId === environmentId)
  ) {
    return false
  }
  return (
    !isRemovedRuntimeHostId(
      getRuntimeTargetHostId(fence.target),
      state.removedRuntimeEnvironmentIds
    ) &&
    getEnvironmentSshStateGeneration(fence.target.environmentId) === fence.sshStateGeneration &&
    isHostIdentityFenceCurrent(fence.identity)
  )
}

async function listRuntimeEnvironmentsForAllHostLoad(): Promise<{ id: string }[] | null> {
  try {
    return (await window.api.runtimeEnvironments.list()) ?? []
  } catch (err) {
    console.warn('Failed to list runtime environments for all-host load:', err)
    return null
  }
}

/** Claim each runtime fence before listing; stale loads claim none and callers own settlement. */
export async function loadRuntimeHostCatalogs(
  get: CatalogFenceStore,
  kind: HostCatalogKind,
  load: (
    target: Extract<RuntimeClientTarget, { kind: 'environment' }>,
    fence: HostCatalogFence
  ) => Promise<void>,
  isCurrentLoad: () => boolean = () => true,
  /** Called only when the environment list itself answered, so absence from it is authoritative. */
  onListed?: (environmentIds: readonly string[]) => void
): Promise<void> {
  const listed = await listRuntimeEnvironmentsForAllHostLoad()
  if (!isCurrentLoad()) {
    return
  }
  const environments = listed ?? []
  const listedIds = new Set(environments.map((environment) => environment.id))
  // WSL hosts of paired servers are catalog hosts too; one that is not running is never dialed.
  const relayed = (get().relayedWslHosts ?? []).filter((host) =>
    listedIds.has(host.ownerEnvironmentId)
  )
  if (listed) {
    onListed?.([...listedIds, ...relayed.map((host) => host.environmentId)])
  }
  await Promise.all(
    [
      ...listedIds,
      ...relayed.flatMap((host) => (host.reach === 'ready' ? [host.environmentId] : []))
    ].map((environmentId) => {
      const target = { kind: 'environment' as const, environmentId }
      return load(target, claimHostCatalogFence(get, kind, target))
    })
  )
}
