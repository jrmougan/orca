import {
  DELEGATED_MOBILE_DEVICE_SYNC_MAX_PHONES,
  type DelegatedMobileDeviceSyncParams
} from '../../../shared/remote-runtime/pairing/delegated-mobile-device-contract'
import { unavailable } from './mobile-desktop-relay-link'
import { RUNTIME_CLIENT_RELAY_UPDATE_NEEDED_MESSAGE } from '../../../shared/remote-runtime/relay/mobile-desktop-relay-contract'
import {
  syncDelegatedPhoneGrants,
  type DelegatedPhoneGrant,
  type DelegatedPhoneGrants
} from './delegated-phone-grants'
import type { MobileDesktopRelayHost, MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'

/** The credential the server minted for this caller, or why it is not relayed there. */
export function acceptedGrantFor(
  grants: Extract<DelegatedPhoneGrants, { kind: 'ready' }>,
  deviceId: string
): DelegatedPhoneGrant {
  if (grants.updateNeeded.has(deviceId)) {
    throw unavailable(RUNTIME_CLIENT_RELAY_UPDATE_NEEDED_MESSAGE)
  }
  const grant = grants.grants.get(deviceId)
  if (!grant || grants.refused.has(deviceId)) {
    throw unavailable('The server does not accept this phone.')
  }
  return grant
}

type GrantsEntry = {
  promise: Promise<DelegatedPhoneGrants>
  settled: boolean
  result?: DelegatedPhoneGrants
}

/** Each server's delegated phone grants, synced once per fence and shared by racing phones. */
export class DelegatedPhoneGrantCache {
  private readonly entries = new Map<string, GrantsEntry>()

  constructor(
    private readonly hosts: MobileDesktopRelayHosts,
    private readonly listPhones: (
      environmentId: string
    ) => DelegatedMobileDeviceSyncParams['phones']
  ) {}

  environmentIds(): string[] {
    return [...this.entries.keys()]
  }

  delete(environmentId: string): void {
    this.entries.delete(environmentId)
  }

  clear(): void {
    this.entries.clear()
  }

  /** `phoneKey: null` accepts any answered sync; a phone the sync never asked about re-syncs. */
  get(host: MobileDesktopRelayHost, phoneKey: string | null): Promise<DelegatedPhoneGrants> {
    if (phoneKey !== null && this.pastSyncCap(host.environmentId, phoneKey)) {
      // Phones rank first and the cap never drops them; a device past it fails fast, without a sync per request.
      return Promise.reject(
        unavailable(
          `This computer already relays ${DELEGATED_MOBILE_DEVICE_SYNC_MAX_PHONES} devices to that server.`
        )
      )
    }
    const cached = this.entries.get(host.environmentId)
    if (cached && !cached.settled) {
      // A device enrolled mid-sync is missing from that sync's list, so it must re-sync.
      return cached.promise.then((grants) =>
        grants.fence !== host.fence ||
        (grants.kind === 'ready' &&
          phoneKey !== null &&
          !grants.asked.has(phoneKey) &&
          // Racing requests share one update-needed answer; like the whole-server one, it is not cached.
          !grants.updateNeeded.has(phoneKey))
          ? this.get(host, phoneKey)
          : grants
      )
    }
    const answered =
      cached?.result?.kind === 'ready' &&
      cached.result.fence === host.fence &&
      (phoneKey === null || cached.result.asked.has(phoneKey))
    // Never cache update-needed: in-place server upgrades must work without re-pairing.
    return answered && cached.result ? Promise.resolve(cached.result) : this.sync(host)
  }

  private pastSyncCap(environmentId: string, phoneKey: string): boolean {
    return (
      this.listPhones(environmentId).findIndex((phone) => phone.phoneKey === phoneKey) >=
      DELEGATED_MOBILE_DEVICE_SYNC_MAX_PHONES
    )
  }

  private sync(host: MobileDesktopRelayHost): Promise<DelegatedPhoneGrants> {
    const entry: GrantsEntry = {
      promise: syncDelegatedPhoneGrants(this.hosts, host, this.listPhones(host.environmentId)),
      settled: false
    }
    this.entries.set(host.environmentId, entry)
    entry.promise.then(
      (result) => {
        entry.settled = true
        entry.result = result
      },
      () => {
        // Unreachability is no answer; retry the sync on the next request.
        if (this.entries.get(host.environmentId) === entry) {
          this.entries.delete(host.environmentId)
        }
      }
    )
    return entry.promise
  }
}
