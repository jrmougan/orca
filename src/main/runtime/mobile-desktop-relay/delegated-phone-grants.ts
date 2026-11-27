import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'
import {
  DELEGATED_MOBILE_DEVICE_SYNC_METHOD,
  DELEGATED_MOBILE_DEVICE_SYNC_MAX_PHONES,
  DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY,
  DELEGATED_RUNTIME_DEVICES_RUNTIME_CAPABILITY,
  type DelegatedMobileDeviceSyncParams
} from '../../../shared/remote-runtime/pairing/delegated-mobile-device-contract'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
import type { MobileDesktopRelayHost, MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'

const SyncResultSchema = lazyZodSchema(() =>
  z.object({
    devices: z.array(z.object({ phoneKey: z.string(), deviceId: z.string(), token: z.string() }))
  })
)
const StatusCapabilitiesSchema = lazyZodSchema(() =>
  z.object({ capabilities: z.array(z.string()).optional() })
)

export type DelegatedPhoneGrant = { deviceId: string; token: string }

/** Memory-only sync outcome; recovery requires another sync. */
export type DelegatedPhoneGrants =
  | { kind: 'update-needed'; fence: string }
  | {
      kind: 'ready'
      fence: string
      grants: ReadonlyMap<string, DelegatedPhoneGrant>
      // Asked but ungranted phones wait for the next sync.
      asked: ReadonlySet<string>
      // Host-revoked tokens remain refused until the next sync.
      refused: Set<string>
      // Paired desktop/web clients the server is too old to hold as runtime devices. They are never
      // sent as phones instead: the phone method table would silently cut what they can do.
      updateNeeded: ReadonlySet<string>
    }

export async function syncDelegatedPhoneGrants(
  hosts: MobileDesktopRelayHosts,
  host: MobileDesktopRelayHost,
  phones: DelegatedMobileDeviceSyncParams['phones']
): Promise<DelegatedPhoneGrants> {
  const status = await hosts.call(host, 'status.get', undefined)
  if (!status.ok) {
    throw new RemoteRuntimeClientError('remote_runtime_unavailable', status.error.message)
  }
  const capabilities = StatusCapabilitiesSchema.safeParse(status.result).data?.capabilities ?? []
  if (!capabilities.includes(DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY)) {
    return { kind: 'update-needed', fence: host.fence }
  }
  const mintsRuntimeDevices = capabilities.includes(DELEGATED_RUNTIME_DEVICES_RUNTIME_CAPABILITY)
  const withheld = mintsRuntimeDevices ? [] : phones.filter((phone) => phone.kind === 'runtime')
  const sent = phones
    .filter((phone) => mintsRuntimeDevices || phone.kind !== 'runtime')
    .slice(0, DELEGATED_MOBILE_DEVICE_SYNC_MAX_PHONES)
  const response = await hosts.call(host, DELEGATED_MOBILE_DEVICE_SYNC_METHOD, { phones: sent })
  if (!response.ok) {
    throw new RemoteRuntimeClientError('remote_runtime_unavailable', response.error.message)
  }
  const result = SyncResultSchema.safeParse(response.result)
  if (!result.success) {
    throw new RemoteRuntimeClientError(
      'invalid_runtime_response',
      'Remote Orca runtime returned an invalid delegated device sync.'
    )
  }
  return {
    kind: 'ready',
    fence: host.fence,
    grants: new Map(
      result.data.devices.map((device) => [
        device.phoneKey,
        { deviceId: device.deviceId, token: device.token }
      ])
    ),
    // Devices cut by the cap were not asked, so a later request from one re-syncs with a fresh ranking.
    asked: new Set(sent.map((phone) => phone.phoneKey)),
    refused: new Set(),
    updateNeeded: new Set(withheld.map((phone) => phone.phoneKey))
  }
}
