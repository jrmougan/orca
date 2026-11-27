import { describe, expect, it } from 'vitest'
import { publicRuntimeEnvironment } from '@/runtime/rpc/testing/paired-runtime-environment-test-fixture'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { adoptEndpointRepo } from '../../../../shared/project/catalog/endpoint-catalog-adoption'
import { toRelayedRuntimeEnvironmentId } from '../../../../shared/remote-runtime/relay/relayed-runtime-environment'
import type { Repo } from '../../../../shared/repository/repo-types'
import { mergeFetchedReposForHost } from '../repos/repo-catalog-identity'
import { createTestStore } from '../testing/app-store-test-fixture'
import { claimHostCatalogFence, isHostCatalogFenceCurrent } from './host-catalog-fence'

const OWNER = 'windows-pc'
const RELAYED = toRelayedRuntimeEnvironmentId({
  ownerEnvironmentId: OWNER,
  executionHost: 'runtime:wsl%3Aubuntu'
})!
const relayedHost = {
  environmentId: RELAYED,
  ownerEnvironmentId: OWNER,
  label: 'Ubuntu',
  distro: 'Ubuntu',
  reach: 'ready' as const
}
const relayedTarget = { kind: 'environment' as const, environmentId: RELAYED }

function pairedStore() {
  const store = createTestStore()
  store.getState().setRuntimeEnvironments([publicRuntimeEnvironment({ id: OWNER })])
  store.setState({ relayedWslHosts: [relayedHost] })
  return store
}

describe('relayed host catalog fence', () => {
  it('rejects a late relayed catalog once its paired server is unpaired', () => {
    const store = pairedStore()
    const fence = claimHostCatalogFence(store.getState, 'repos', relayedTarget)
    expect(isHostCatalogFenceCurrent(store.getState, fence)).toBe(true)

    store.getState().setRuntimeEnvironments([])

    expect(isHostCatalogFenceCurrent(store.getState, fence)).toBe(false)
  })

  it('rejects a late relayed catalog once the same id is paired to another machine', () => {
    const store = pairedStore()
    const fence = claimHostCatalogFence(store.getState, 'repos', relayedTarget)

    store
      .getState()
      .setRuntimeEnvironments([publicRuntimeEnvironment({ id: OWNER, pairingRevision: 99 })])

    expect(isHostCatalogFenceCurrent(store.getState, fence)).toBe(false)
  })

  it('rejects a late relayed catalog once its paired server stops listing the host', () => {
    const store = pairedStore()
    const fence = claimHostCatalogFence(store.getState, 'repos', relayedTarget)

    store
      .getState()
      .applyRelayedWslHostListings([{ ownerEnvironmentId: OWNER, hosts: [] }], new Set([OWNER]))

    expect(isHostCatalogFenceCurrent(store.getState, fence)).toBe(false)
  })

  it('drops the relayed rows with the paired server, keeping other hosts', () => {
    const store = pairedStore()
    const row = (executionHostId: Repo['executionHostId']): Repo => ({
      id: 'repo',
      path: '/repo',
      displayName: 'repo',
      badgeColor: '',
      addedAt: 0,
      executionHostId
    })
    store.setState({
      repos: [
        row('local'),
        row(toRuntimeExecutionHostId(OWNER)),
        row(toRuntimeExecutionHostId(RELAYED))
      ]
    })

    store.getState().setRuntimeEnvironments([])

    expect(store.getState().repos.map((repo) => repo.executionHostId)).toEqual(['local'])
  })
})

describe('a project moved to WSL keeps its repo id on both hosts', () => {
  const fetched = (path: string): Repo => ({
    id: 'moved-repo',
    path,
    displayName: 'api',
    badgeColor: '',
    addedAt: 0
  })
  const ownerTarget = { kind: 'environment' as const, environmentId: OWNER }
  const ownerHostId = toRuntimeExecutionHostId(OWNER)
  const relayedHostId = toRuntimeExecutionHostId(RELAYED)

  it('lists the row of each host and lets neither answer drop the other', () => {
    const onWindows = adoptEndpointRepo(ownerTarget, fetched('C:\\src\\api'))
    const onWsl = adoptEndpointRepo(relayedTarget, fetched('/home/me/api'))

    let repos = mergeFetchedReposForHost([], [onWindows], ownerHostId)
    repos = mergeFetchedReposForHost(repos, [onWsl], relayedHostId)
    expect(repos.map((repo) => [repo.executionHostId, repo.path])).toEqual([
      [ownerHostId, 'C:\\src\\api'],
      [relayedHostId, '/home/me/api']
    ])

    // The Windows server hides its moved row: only its own row goes.
    repos = mergeFetchedReposForHost(repos, [], ownerHostId)
    expect(repos.map((repo) => [repo.executionHostId, repo.path])).toEqual([
      [relayedHostId, '/home/me/api']
    ])
  })
})
