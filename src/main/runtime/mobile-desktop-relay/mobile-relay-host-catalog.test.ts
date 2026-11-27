import { describe, expect, it } from 'vitest'
import type {
  MobileDesktopRelayHosts,
  MobileDesktopRelayListing
} from './mobile-desktop-relay-hosts'
import { MobileRelayHostCatalog } from './mobile-relay-host-catalog'
import { OnDemandServerWorktreeRows } from './on-demand-server-worktree-rows'

function catalogListing(listing: MobileDesktopRelayListing): MobileRelayHostCatalog {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: list() reads only the host listing.
  const hosts = { list: () => listing } as unknown as MobileDesktopRelayHosts
  return new MobileRelayHostCatalog({
    hosts,
    serverRows: new OnDemandServerWorktreeRows(hosts),
    hostLabelOverrides: () => new Map(),
    getWorkspaceSession: () => null
  })
}

describe('MobileRelayHostCatalog.list', () => {
  it('answers a WSL host with its distro and desktop state, and nothing internal', async () => {
    const catalog = catalogListing({
      environments: [
        {
          id: 'wsl:orca-dev',
          name: 'orca-dev (WSL)',
          orcadDeployment: { kind: 'wsl' },
          pairingRevision: 1,
          runtimeId: 'rt-wsl',
          stoppedOnDesktop: true,
          wslDistro: 'orca-dev'
        }
      ],
      statusByEnvironmentId: new Map(),
      sshTargetLabels: new Map(),
      sshConnectionStates: new Map()
    })

    const { hosts } = await catalog.list()

    expect(hosts).toHaveLength(1)
    expect(hosts[0]).toMatchObject({
      hostId: 'runtime:wsl%3Aorca-dev',
      label: 'orca-dev (WSL)',
      relay: 'unavailable',
      stoppedOnDesktop: true,
      wsl: { distro: 'orca-dev' }
    })
    expect(Object.keys(hosts[0]).sort()).toEqual([
      'health',
      'hostId',
      'label',
      'relay',
      'stoppedOnDesktop',
      'wsl'
    ])
  })
})
