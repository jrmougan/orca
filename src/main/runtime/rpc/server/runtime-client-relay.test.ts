// A paired desktop/web client naming a WSL host is relayed there under a device the server can revoke.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  generateKeyPair,
  publicKeyToBase64
} from '../../../../shared/remote-runtime/e2ee/node/e2ee-crypto'
import {
  DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
  DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY,
  DelegatedMobileDeviceSyncParamsSchema
} from '../../../../shared/remote-runtime/pairing/delegated-mobile-device-contract'
import { RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY } from '../../../../shared/remote-runtime/relay/mobile-desktop-relay-contract'
import type { MobileDesktopRelayHosts } from '../../mobile-desktop-relay/mobile-desktop-relay-hosts'
import { connectPhone } from '../../mobile-desktop-relay/mobile-desktop-relay-phone.test-fixture'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

const WSL_ENVIRONMENT_ID = 'wsl:Ubuntu'
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

async function startRelayingServer() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-client-relay-'))
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    enableWebSocket: true,
    wsPort: 0
  })
  await server.start()
  cleanups.push(async () => {
    await server.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  })
  const opened: string[] = []
  const syncedPhoneKeys: string[][] = []
  const hosts: MobileDesktopRelayHosts = {
    list: () => ({
      environments: [],
      statusByEnvironmentId: new Map(),
      sshTargetLabels: new Map(),
      sshConnectionStates: new Map()
    }),
    resolve: async (environmentId, openingMethod) => {
      if (openingMethod) {
        opened.push(environmentId)
      }
      return environmentId === WSL_ENVIRONMENT_ID
        ? {
            environmentId,
            fence: 'fence-1',
            // Nothing listens there: the relayed socket fails after the delegated device sync.
            pairing: {
              v: 2,
              endpoint: 'ws://127.0.0.1:1',
              deviceToken: 'd'.repeat(48),
              publicKeyB64: publicKeyToBase64(generateKeyPair().publicKey)
            }
          }
        : null
    },
    call: async (_host, method, params) => {
      if (method !== DELEGATED_MOBILE_DEVICE_SYNC_METHOD) {
        return {
          id: 'status',
          ok: true,
          result: { capabilities: [DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY] },
          _meta: { runtimeId: 'wsl-runtime' }
        }
      }
      const { phones } = DelegatedMobileDeviceSyncParamsSchema.parse(params)
      syncedPhoneKeys.push(phones.map((phone) => phone.phoneKey))
      return {
        id: 'sync',
        ok: true,
        result: {
          devices: phones.map(({ phoneKey }) => ({
            phoneKey,
            deviceId: `child-of-${phoneKey}`,
            token: 'c'.repeat(48)
          }))
        },
        _meta: { runtimeId: 'wsl-runtime' }
      }
    },
    hostsBrowserPage: () => false,
    onEnvironmentRetired: () => () => {},
    onStatusChanged: () => () => {},
    watchChanges: () => ({ close: () => {}, current: () => false })
  }
  server.setMobileDesktopRelayHosts(hosts)
  return { server, opened, syncedPhoneKeys }
}

describe('a paired runtime client naming a WSL host', () => {
  it('is relayed to that host under either spelling of its id, never run locally', async () => {
    const { server, opened, syncedPhoneKeys } = await startRelayingServer()
    const client = await connectPhone(server, 'Laptop', cleanups, 'runtime')

    client.send('encoded', 'worktree.ps', {}, 'runtime:wsl%3AUbuntu')
    expect(await client.next('encoded')).toMatchObject({ ok: false })
    client.send('plain', 'worktree.ps', {}, 'runtime:wsl:Ubuntu')
    expect(await client.next('plain')).toMatchObject({ ok: false })
    client.send('unknown', 'worktree.ps', {}, 'runtime:wsl%3ADebian')
    expect(await client.next('unknown')).toMatchObject({
      ok: false,
      error: { code: 'remote_runtime_unavailable' }
    })

    expect(opened).toEqual([WSL_ENVIRONMENT_ID, WSL_ENVIRONMENT_ID, 'wsl:Debian'])
    // The host mints a device for this client only; the unconfigured host never syncs.
    expect(syncedPhoneKeys).toEqual([[client.deviceId]])
  })

  it('loses its device on the host when its access is revoked here', async () => {
    const { server, syncedPhoneKeys } = await startRelayingServer()
    const client = await connectPhone(server, 'Laptop', cleanups, 'runtime')
    client.send('open', 'worktree.ps', {}, 'runtime:wsl%3AUbuntu')
    await client.next('open')
    expect(syncedPhoneKeys).toEqual([[client.deviceId]])

    expect(server.revokeRuntimeAccess(client.deviceId)).toBe(true)

    await vi.waitFor(() => expect(syncedPhoneKeys).toEqual([[client.deviceId], []]))
  })

  it('advertises the relay to runtime clients only', async () => {
    const { server } = await startRelayingServer()
    const client = await connectPhone(server, 'Laptop', cleanups, 'runtime')
    const phone = await connectPhone(server, 'Phone', cleanups)

    client.send('status', 'status.get', undefined, null)
    phone.send('status', 'status.get', undefined, null)
    const capabilitiesOf = (frame: unknown): string[] =>
      z.object({ result: z.object({ capabilities: z.array(z.string()) }) }).parse(frame).result
        .capabilities

    expect(capabilitiesOf(await client.next('status'))).toContain(
      RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY
    )
    expect(capabilitiesOf(await phone.next('status'))).not.toContain(
      RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY
    )
  })
})
