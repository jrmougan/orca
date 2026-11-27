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
  DELEGATED_RUNTIME_DEVICES_RUNTIME_CAPABILITY,
  DelegatedMobileDeviceSyncParamsSchema,
  type DelegatedPhone
} from '../../../../shared/remote-runtime/pairing/delegated-mobile-device-contract'
import {
  RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY,
  RUNTIME_CLIENT_RELAY_UPDATE_NEEDED_MESSAGE
} from '../../../../shared/remote-runtime/relay/mobile-desktop-relay-contract'
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

const CURRENT_HOST = [
  DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY,
  DELEGATED_RUNTIME_DEVICES_RUNTIME_CAPABILITY
]

async function startRelayingServer(hostCapabilities: readonly string[] = CURRENT_HOST) {
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
  const synced: Pick<DelegatedPhone, 'phoneKey' | 'kind'>[][] = []
  const hostCalls: string[] = []
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
      hostCalls.push(method)
      if (method !== DELEGATED_MOBILE_DEVICE_SYNC_METHOD) {
        return {
          id: 'status',
          ok: true,
          result: { capabilities: [...hostCapabilities] },
          _meta: { runtimeId: 'wsl-runtime' }
        }
      }
      const { phones } = DelegatedMobileDeviceSyncParamsSchema.parse(params)
      synced.push(phones.map(({ phoneKey, kind }) => ({ phoneKey, kind })))
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
  return { server, opened, synced, hostCalls }
}

describe('a paired runtime client naming a WSL host', () => {
  it('is relayed to that host under either spelling of its id, never run locally', async () => {
    const { server, opened, synced } = await startRelayingServer()
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
    // The host mints a runtime device for this client only; the unconfigured host never syncs.
    expect(synced).toEqual([[{ phoneKey: client.deviceId, kind: 'runtime' }]])
  })

  it('loses its device on the host when its access is revoked here', async () => {
    const { server, synced } = await startRelayingServer()
    const client = await connectPhone(server, 'Laptop', cleanups, 'runtime')
    client.send('open', 'worktree.ps', {}, 'runtime:wsl%3AUbuntu')
    await client.next('open')
    const child = { phoneKey: client.deviceId, kind: 'runtime' }
    expect(synced).toEqual([[child]])

    expect(server.revokeRuntimeAccess(client.deviceId)).toBe(true)

    await vi.waitFor(() => expect(synced).toEqual([[child], []]))
  })

  it('asks for a phone child for a phone, whatever host it names', async () => {
    const { server, synced } = await startRelayingServer()
    const phone = await connectPhone(server, 'Phone', cleanups)

    phone.send('open', 'worktree.ps', {}, 'runtime:wsl%3AUbuntu')
    await phone.next('open')

    expect(synced).toEqual([[{ phoneKey: phone.deviceId, kind: undefined }]])
  })

  it('is refused on a host too old for runtime devices: no phone device stands in, nothing runs here', async () => {
    const { server, synced, hostCalls } = await startRelayingServer([
      DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY
    ])
    const client = await connectPhone(server, 'Laptop', cleanups, 'runtime')
    const phone = await connectPhone(server, 'Phone', cleanups)

    client.send('write', 'files.write', {}, 'runtime:wsl%3AUbuntu')
    expect(await client.next('write')).toMatchObject({
      ok: false,
      error: {
        code: 'remote_runtime_unavailable',
        message: RUNTIME_CLIENT_RELAY_UPDATE_NEEDED_MESSAGE
      }
    })
    phone.send('open', 'worktree.ps', {}, 'runtime:wsl%3AUbuntu')
    await phone.next('open')

    // The client is never sent, as a phone or otherwise; the phone still is.
    expect(synced.flat()).toEqual([{ phoneKey: phone.deviceId, kind: undefined }])
    expect(hostCalls).not.toContain('files.write')
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
