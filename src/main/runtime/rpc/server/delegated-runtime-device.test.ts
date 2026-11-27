// A host holds a relayed desktop/web client as a runtime device under the relaying computer's
// pairing: the paired-client method set, never more than that computer, gone when it is.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { DELEGATED_MOBILE_DEVICE_SYNC_METHOD } from '../../../../shared/remote-runtime/pairing/delegated-mobile-device-contract'
import { RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY } from '../../../../shared/remote-runtime/relay/mobile-desktop-relay-contract'
import {
  connectPaired,
  connectPhone,
  pair
} from '../../mobile-desktop-relay/mobile-desktop-relay-phone.test-fixture'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

const SyncReply = z.object({
  ok: z.literal(true),
  result: z.object({
    devices: z.array(z.object({ phoneKey: z.string(), deviceId: z.string(), token: z.string() }))
  })
})
const CHILDREN = [
  { phoneKey: 'phone', name: 'Pixel via PC' },
  { phoneKey: 'laptop', name: 'Laptop via PC', kind: 'runtime' }
]

async function startHost() {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-delegated-runtime-device-'))
  const host = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    enableWebSocket: true,
    wsPort: 0
  })
  await host.start()
  cleanups.push(async () => {
    await host.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  })
  const offer = pair(host, 'runtime', 'PC')
  const desktop = await connectPaired(offer, cleanups)
  let syncs = 0
  const sync = async (phones: unknown) => {
    const id = `sync-${syncs++}`
    desktop.send(id, DELEGATED_MOBILE_DEVICE_SYNC_METHOD, { phones }, null)
    return SyncReply.parse(await desktop.next(id)).result.devices
  }
  const connectChild = (child: { deviceId: string; token: string }) =>
    connectPaired({ ...offer, deviceToken: child.token, pairedDeviceId: child.deviceId }, cleanups)
  return { host, desktop, sync, connectChild }
}

async function errorCodeOf(
  client: Awaited<ReturnType<typeof connectPaired>>,
  id: string,
  method: string,
  params: unknown
): Promise<string | undefined> {
  client.send(id, method, params, null)
  const frame = z
    .object({ error: z.object({ code: z.string() }).optional() })
    .parse(await client.next(id))
  return frame.error?.code
}

describe('a runtime device delegated by a paired desktop', () => {
  it('reaches a method outside the phone table, which its phone sibling does not', async () => {
    const { host, sync, connectChild } = await startHost()
    const [phone, laptop] = await sync(CHILDREN)

    expect(host.getDeviceRegistry()?.getDevice(phone!.deviceId)?.scope).toBe('mobile')
    expect(host.getDeviceRegistry()?.getDevice(laptop!.deviceId)?.scope).toBe('runtime')
    // Past admission, the empty params are what fails.
    expect(await errorCodeOf(await connectChild(laptop!), 'w', 'files.write', {})).toBe(
      'invalid_argument'
    )
    expect(await errorCodeOf(await connectChild(phone!), 'w', 'files.write', {})).toBe('forbidden')
  })

  it('holds no more than the desktop that delegated it', async () => {
    const { host, sync, connectChild } = await startHost()
    const registry = host.getDeviceRegistry()!
    const granted = registry.addDevice('Granted PC', 'runtime', 'network', ['desktop-control'])
    registry.updateLastSeen(granted.deviceId)
    const [inherited] = registry.upsertDelegatedMobileDevices(granted, [
      { phoneKey: 'laptop', name: 'Laptop', kind: 'runtime' }
    ])
    expect(inherited).toMatchObject({ scope: 'runtime', parentDeviceId: granted.deviceId })
    expect(inherited?.grants).toBeUndefined()

    const [, laptop] = await sync(CHILDREN)
    const child = await connectChild(laptop!)
    // pairing-admin stays out of reach, and a child delegates and relays nothing itself.
    expect(await errorCodeOf(child, 'offer', 'pairing.createOffer', {})).toBe('forbidden')
    child.send('sync', DELEGATED_MOBILE_DEVICE_SYNC_METHOD, { phones: [] }, null)
    expect(await child.next('sync')).toMatchObject({ ok: false })
    expect(registry.listDelegatedMobileDevices(laptop!.deviceId)).toEqual([])
    child.send('status', 'status.get', undefined, null)
    const status = z
      .object({ result: z.object({ capabilities: z.array(z.string()) }) })
      .parse(await child.next('status'))
    expect(status.result.capabilities).not.toContain(RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY)
  })

  it('is never minted for a phone parent, nor by re-scoping a phone child', async () => {
    const { host, sync } = await startHost()
    const registry = host.getDeviceRegistry()!
    const phoneParent = registry.addDevice('Phone', 'mobile')
    registry.updateLastSeen(phoneParent.deviceId)
    expect(
      registry.upsertDelegatedMobileDevices(phoneParent, [
        { phoneKey: 'laptop', name: 'Laptop', kind: 'runtime' }
      ])
    ).toEqual([])
    const phone = await connectPhone(host, 'Paired phone', cleanups)
    expect(
      await errorCodeOf(phone, 'sync', DELEGATED_MOBILE_DEVICE_SYNC_METHOD, { phones: CHILDREN })
    ).toBe('forbidden')

    const [asPhone] = await sync([{ phoneKey: 'laptop', name: 'Laptop via PC' }])
    const [asRuntime] = await sync([{ phoneKey: 'laptop', name: 'Laptop via PC', kind: 'runtime' }])
    expect(asRuntime!.token).not.toBe(asPhone!.token)
    expect(registry.validateToken(asPhone!.token)).toBeNull()
  })

  it('is revoked when the desktop drops it from a sync, and when the desktop itself is revoked', async () => {
    const { host, desktop, sync, connectChild } = await startHost()
    const [, laptop] = await sync(CHILDREN)
    const child = await connectChild(laptop!)
    expect(await errorCodeOf(child, 'before', 'status.get', undefined)).toBeUndefined()

    const [phoneOnly, ...rest] = await sync([CHILDREN[0]])
    expect(rest).toEqual([])
    expect(phoneOnly!.phoneKey).toBe('phone')
    expect(host.getDeviceRegistry()?.validateToken(laptop!.token)).toBeNull()

    const [, again] = await sync(CHILDREN)
    expect(host.revokeRuntimeAccess(desktop.deviceId)).toBe(true)
    expect(host.getDeviceRegistry()?.validateToken(again!.token)).toBeNull()
  })
})
