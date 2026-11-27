import { describe, expect, it } from 'vitest'
import { publicRuntimeEnvironment } from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import { getReachableRuntimeSessionMirrorTargets } from '@/runtime/web-session-tabs-sync/subscriptions/runtime-session-mirror-targets'
import { toRuntimeExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { toRelayedRuntimeEnvironmentId } from '../../../../../shared/remote-runtime/relay/relayed-runtime-environment'
import type { RuntimeStatus } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { createTestStore } from '../../testing/app-store-test-fixture'
import { stageHostStatuses } from '../runtime-status/host-status-transaction-draft'
import { relayedHostStatusReplacements } from './relayed-host-status'

const OWNER = 'windows-pc'
const RELAYED = toRelayedRuntimeEnvironmentId({
  ownerEnvironmentId: OWNER,
  executionHost: 'runtime:wsl%3Aubuntu'
})!
const host = {
  environmentId: RELAYED,
  ownerEnvironmentId: OWNER,
  label: 'Ubuntu',
  distro: 'Ubuntu',
  reach: 'ready' as const
}

function runtimeStatus(runtimeId: string): RuntimeStatus {
  return {
    runtimeId,
    rendererGraphEpoch: 0,
    graphStatus: 'unavailable',
    authoritativeWindowId: null,
    liveTabCount: 0,
    liveLeafCount: 0
  }
}

function pairedStore() {
  const store = createTestStore()
  store.getState().setRuntimeEnvironments([publicRuntimeEnvironment({ id: OWNER })])
  store.setState({ relayedWslHosts: [host] })
  const read = (status: RuntimeStatus | null | undefined): void =>
    store.setState((state) =>
      stageHostStatuses(
        state,
        relayedHostStatusReplacements(state, [{ environmentId: RELAYED, status }], 1),
        {}
      )
    )
  const entry = () => store.getState().runtimeStatusByEnvironmentId.get(RELAYED)
  return { store, read, entry }
}

describe('relayed host status', () => {
  it('follows the host through an unanswered read, a new runtime, a stop and its return', () => {
    const { read, entry } = pairedStore()

    read(runtimeStatus('wsl-1'))
    const first = entry()
    expect(first?.status?.runtimeId).toBe('wsl-1')

    // A relay hiccup proves nothing about the host: its sessions stay mirrored.
    read(undefined)
    expect(entry()).toBe(first)

    // A restarted orcad is a new connection for everything fenced on the old one.
    read(runtimeStatus('wsl-2'))
    expect(entry()?.connectionGeneration).toBe((first?.connectionGeneration ?? 0) + 1)
    expect(entry()?.hostContactEpoch).toBe(first?.hostContactEpoch)

    // The distro stopped, then came back: ended streams restart on the contact edge.
    read(null)
    expect(entry()?.status).toBeNull()
    read(runtimeStatus('wsl-2'))
    expect(entry()?.hostContactEpoch).toBe((first?.hostContactEpoch ?? 0) + 1)
  })

  it('survives a catalog re-read of its paired server and goes when that server does', () => {
    const { store, read, entry } = pairedStore()
    read(runtimeStatus('wsl-1'))

    store.getState().setRuntimeEnvironments([publicRuntimeEnvironment({ id: OWNER })])
    expect(entry()?.status?.runtimeId).toBe('wsl-1')

    store.getState().setRuntimeEnvironments([])
    expect(entry()).toBeUndefined()
  })

  it('mirrors a relayed host with live status under its paired server pairing', () => {
    const { store, read } = pairedStore()
    const repo = { id: 'repo-1', executionHostId: toRuntimeExecutionHostId(RELAYED) }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: mirror targets read only the repo's execution host.
    const repos = [repo] as unknown as ReturnType<typeof store.getState>['repos']
    const targets = () =>
      getReachableRuntimeSessionMirrorTargets({ ...store.getState(), repos }).filter(
        (target) => target.environmentId === RELAYED
      )

    expect(targets()).toEqual([])

    read(runtimeStatus('wsl-1'))
    const owner = store.getState().runtimeEnvironments[0]
    expect(targets()).toMatchObject([
      { runtimeId: 'wsl-1', pairingRevision: owner.pairingRevision ?? owner.createdAt }
    ])
  })
})
