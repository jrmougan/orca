import { mintDeviceCredential } from './device-credential'
import type { DelegatedPhone } from '../../../../../shared/remote-runtime/pairing/delegated-mobile-device-contract'
import type { DeviceEntry } from './device-entry'

export type DelegatedMobileDeviceEntry = DeviceEntry & {
  parentDeviceId: string
  phoneKey: string
  token: string
}

/** Only a desktop paired here in its own right delegates: never a phone, never another delegated child. */
export function isDelegatingDesktop(parent: DeviceEntry): boolean {
  return parent.scope === 'runtime' && parent.parentDeviceId === undefined
}

export function planDelegatedMobileDevices(
  devices: DeviceEntry[],
  parent: DeviceEntry,
  phones: readonly DelegatedPhone[],
  // The parent installation that synced: several desktops can share one parent row.
  originClientInstanceId?: string,
  now = Date.now()
): { nextDevices: DeviceEntry[]; entries: DelegatedMobileDeviceEntry[] } {
  // A parent removed meanwhile (e.g. on disk) must not mint children nobody can revoke with it.
  if (!devices.some((device) => device.deviceId === parent.deviceId)) {
    return { nextDevices: devices, entries: [] }
  }
  let nextDevices = devices
  const entries = phones.flatMap((phone): DelegatedMobileDeviceEntry[] => {
    const scope = phone.kind ?? 'mobile'
    if (scope === 'runtime' && !isDelegatingDesktop(parent)) {
      return []
    }
    // A row of the other scope is never re-scoped under its token; the sync revokes it first.
    const existing = nextDevices.find(
      (device) =>
        device.parentDeviceId === parent.deviceId &&
        device.phoneKey === phone.phoneKey &&
        device.scope === scope
    )
    if (existing) {
      const origin = originClientInstanceId ?? existing.originClientInstanceId
      const { token } = existing
      if (
        token !== undefined &&
        existing.name === phone.name &&
        existing.originClientInstanceId === origin
      ) {
        return [{ ...existing, token, parentDeviceId: parent.deviceId, phoneKey: phone.phoneKey }]
      }
      const updated: DelegatedMobileDeviceEntry = {
        ...existing,
        parentDeviceId: parent.deviceId,
        phoneKey: phone.phoneKey,
        name: phone.name,
        ...(origin ? { originClientInstanceId: origin } : {}),
        // A row a hash-storing build left has no token to hand the phone: mint it a new one.
        ...(token === undefined
          ? {
              token: mintDeviceCredential().token,
              credentialRevision: (existing.credentialRevision ?? 0) + 1
            }
          : { token })
      }
      nextDevices = nextDevices.map((device) => (device === existing ? updated : device))
      return [updated]
    }
    const entry: DelegatedMobileDeviceEntry = {
      ...mintDeviceCredential(),
      name: phone.name,
      // A runtime child holds the standard paired-client permissions and no grants: the parent's
      // desktop-control is never delegated, and pairing-admin is never a paired client's.
      scope,
      pairedAt: now,
      // QR rotation targets lastSeenAt === 0; delegated children must never be pending offers.
      lastSeenAt: now,
      pairingReach: parent.pairingReach ?? 'network',
      parentDeviceId: parent.deviceId,
      phoneKey: phone.phoneKey,
      ...(originClientInstanceId ? { originClientInstanceId } : {})
    }
    nextDevices = [...nextDevices, entry]
    return [entry]
  })
  return { nextDevices, entries }
}
