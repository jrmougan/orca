import { canonicalExecutionHostId, parseExecutionHostId } from '../../execution-host/execution-host'

const RELAYED_RUNTIME_ENVIRONMENT_PREFIX = 'relay:'

/** A server reached through a paired server's relay, as one environment id for the renderer. */
export type RelayedRuntimeEnvironment = {
  /** The paired server that relays (A). */
  ownerEnvironmentId: string
  /** A's id for the relayed server (`runtime:<id on A>`), sent as the request's `executionHost`. */
  executionHost: `runtime:${string}`
}

/**
 * What a relayed server is asked: its catalog, opening a workspace, and its terminals. Anything
 * else is refused before it leaves this computer. Every entry must be an execution-host route on
 * the relaying server: a route that server keeps (settings.get, runtime.clientEvents.subscribe)
 * would be answered with its own data under the relayed server's name.
 */
export const RELAYED_RUNTIME_METHODS: ReadonlySet<string> = new Set([
  'status.get',
  'repo.list',
  'project.list',
  'projectHostSetup.list',
  'projectGroup.list',
  'folderWorkspace.list',
  'worktree.list',
  'worktree.ps',
  'worktree.show',
  'worktree.activate',
  'session.tabs.list',
  'session.tabs.listAll',
  'session.tabs.subscribe',
  'session.tabs.subscribeAll',
  'session.tabs.activate',
  'session.tabs.move',
  'session.tabs.close',
  'session.tabs.closeLifecycle',
  'session.tabs.createTerminal',
  'session.tabs.terminalShellChoices',
  'terminal.create',
  'terminal.list',
  'terminal.read',
  'terminal.send',
  'terminal.rename',
  'terminal.focus',
  'terminal.clearBuffer',
  'terminal.close',
  'terminal.closeTab',
  'terminal.adoptOrphans',
  'terminal.updateViewport',
  'terminal.multiplex'
])

/**
 * Owner-qualified, so two paired servers may each name a different machine `runtime:vm-1`.
 * Why no pairing revision: host-keyed state (order, filters, collapse) would be orphaned by every
 * re-pair of the same machine; the owner's pairing is fenced where requests and catalogs apply.
 */
export function toRelayedRuntimeEnvironmentId(relayed: {
  ownerEnvironmentId: string
  /** Any spelling, checked here: only a runtime host id yields an id. */
  executionHost: string
}): string | null {
  const ownerEnvironmentId = relayed.ownerEnvironmentId.trim()
  const host = parseExecutionHostId(canonicalExecutionHostId(relayed.executionHost))
  if (
    !ownerEnvironmentId ||
    isRelayedRuntimeEnvironmentId(ownerEnvironmentId) ||
    host?.kind !== 'runtime'
  ) {
    return null
  }
  return `${RELAYED_RUNTIME_ENVIRONMENT_PREFIX}${encodeURIComponent(ownerEnvironmentId)}/${encodeURIComponent(host.id)}`
}

export function isRelayedRuntimeEnvironmentId(environmentId: string): boolean {
  return environmentId.startsWith(RELAYED_RUNTIME_ENVIRONMENT_PREFIX)
}

/** Null for anything but a well-formed id from {@link toRelayedRuntimeEnvironmentId}. */
export function parseRelayedRuntimeEnvironmentId(
  environmentId: string
): RelayedRuntimeEnvironment | null {
  if (!isRelayedRuntimeEnvironmentId(environmentId)) {
    return null
  }
  const parts = environmentId.slice(RELAYED_RUNTIME_ENVIRONMENT_PREFIX.length).split('/')
  if (parts.length !== 2) {
    return null
  }
  try {
    const host = parseExecutionHostId(decodeURIComponent(parts[1]))
    if (host?.kind !== 'runtime') {
      return null
    }
    const relayed = { ownerEnvironmentId: decodeURIComponent(parts[0]), executionHost: host.id }
    // Only the canonical spelling: a second spelling of one host would be a second catalog host.
    return toRelayedRuntimeEnvironmentId(relayed) === environmentId ? relayed : null
  } catch {
    return null
  }
}

/** The paired server whose pairing, contact and removal govern this environment: its relay owner, or itself. */
export function runtimeEnvironmentPairingOwnerId(environmentId: string): string {
  return parseRelayedRuntimeEnvironmentId(environmentId)?.ownerEnvironmentId ?? environmentId
}

/** The saved environment whose pairing carries `environmentId`: its own, or the server that relays to it. */
export function findPairingRuntimeEnvironment<T extends { id: string }>(
  environments: readonly T[],
  environmentId: string | null | undefined
): T | undefined {
  if (!environmentId) {
    return undefined
  }
  const ownerId = runtimeEnvironmentPairingOwnerId(environmentId)
  return environments.find((environment) => environment.id === ownerId)
}
