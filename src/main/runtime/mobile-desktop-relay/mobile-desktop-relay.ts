import { openRelayedPhoneSocket } from './relayed-phone-socket'
import { PHONE_RELAY_CONNECT_BUDGET_MS } from '../../../shared/remote-runtime/recipe-vm-wake'
import { preflightRelayedRequest } from './relayed-request-preflight'
import { randomUUID } from 'node:crypto'
import type { RpcRequest } from '../rpc/core'
import type { DelegatedMobileDeviceSyncParams } from '../../../shared/remote-runtime/pairing/delegated-mobile-device-contract'
import type { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
import {
  failure,
  linkKey,
  RelayLink,
  relayError,
  unavailable,
  type OpenedRelayLink,
  type RelayedPhone
} from './mobile-desktop-relay-link'
import { acceptedGrantFor, DelegatedPhoneGrantCache } from './delegated-phone-grant-cache'
import { localHostedBrowserPageRequest } from './hosted-browser-page-route'
import type { MobileDesktopRelayHost, MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'
import { RELAYED_STREAM_CARRIERS } from './relayed-stream-carriers'
import { relayedStreamRefusal } from './relayed-client-stream-admission'
import {
  declareRelayedPhoneCapabilities,
  rewriteRelayedPhoneRequest,
  withRelayedDesktopDefaults,
  type RelayedDesktopDefaults
} from './relayed-phone-frames'

const RELAY_CONNECT_TIMEOUT_MS = PHONE_RELAY_CONNECT_BUDGET_MS

/** One socket per (phone connection, configured server), authenticated with memory-only delegated phone grants.
 * Forward execution-host methods only; old servers require an update, and revocation lasts until the next sync.
 * Replies stay opaque except stream-id renumbering; replace every upstream desktop-token occurrence. */
export class MobileDesktopRelay {
  private readonly links = new Map<string, RelayLink>()
  /** Connections whose relayed multiplex is admitted but whose link is still being found. */
  private readonly clientStreamOpenings = new Set<string>()
  private readonly grants: DelegatedPhoneGrantCache
  private readonly stopRetirementWatch: () => void

  constructor(
    private readonly options: RelayedDesktopDefaults & {
      hosts: MobileDesktopRelayHosts
      /** The callers to keep delegated devices for on that server. */
      listPhones: (environmentId: string) => DelegatedMobileDeviceSyncParams['phones']
      allocateStreamId: () => number
      prepareBrowserHost?: (host: MobileDesktopRelayHost) => Promise<string | null>
    }
  ) {
    this.grants = new DelegatedPhoneGrantCache(options.hosts, options.listPhones)
    this.stopRetirementWatch = options.hosts.onEnvironmentRetired((environmentId) =>
      this.retireEnvironment(environmentId)
    )
  }

  dispose(): void {
    this.stopRetirementWatch()
    for (const link of this.links.values()) {
      this.endLink(link, unavailable('The paired desktop stopped relaying.'))
    }
    this.grants.clear()
  }

  localRequestFor(request: RpcRequest, environmentId: string): RpcRequest | null {
    const { hostsBrowserPage } = this.options.hosts
    return localHostedBrowserPageRequest(request, environmentId, hostsBrowserPage)
  }

  async forward(
    phone: RelayedPhone,
    environmentId: string,
    request: { id: string; method: string },
    frame: string
  ): Promise<void> {
    const carrier = RELAYED_STREAM_CARRIERS.get(request.method)
    const streamRefusal = relayedStreamRefusal(request.method, carrier, phone, {
      clientStreams: this.carriesClientStreams(phone.connectionId),
      otherBinaryStreams: this.linksOf(phone.connectionId).some(({ replies }) =>
        replies.carriesOtherBinaryStreams()
      )
    })
    if (streamRefusal) {
      phone.reply(failure(request.id, streamRefusal.code, streamRefusal.message))
      return
    }
    // Claimed before the link is awaited, so no local stream registers on the lane meanwhile.
    const claimsLane = carrier === 'client-stream-ids'
    if (claimsLane) {
      this.clientStreamOpenings.add(phone.connectionId)
    }
    let link: RelayLink
    try {
      link = await this.linkFor(phone, environmentId, request.method)
      if (!this.isCurrent(link)) {
        throw unavailable('The server connection was reset.')
      }
    } catch (error) {
      if (claimsLane) {
        this.clientStreamOpenings.delete(phone.connectionId)
      }
      const refusal = relayError(error, 'The server connection was reset.')
      phone.reply(failure(request.id, refusal.code, refusal.message))
      return
    }
    link.replies.noteForwarded(request.id, {
      carrier,
      browserScreencast:
        request.method === 'status.get'
          ? () => Boolean(this.options.hosts.browserHostClientId?.(environmentId))
          : undefined
    })
    if (claimsLane) {
      this.clientStreamOpenings.delete(phone.connectionId)
    }
    link.opened.then(
      async ({ socket, hostToken, host }) => {
        // An opening link may already have ended and answered; never send its request late.
        if (!this.isCurrent(link)) {
          return
        }
        const outgoing = withRelayedDesktopDefaults(
          rewriteRelayedPhoneRequest(frame, phone.deviceToken, hostToken),
          request.method,
          environmentId,
          this.options
        )
        const send = await preflightRelayedRequest({
          hosts: this.options.hosts,
          prepareBrowserHost: this.options.prepareBrowserHost,
          link,
          host,
          request,
          frame: outgoing,
          socket,
          isCurrent: () => this.isCurrent(link),
          timeoutMs: RELAY_CONNECT_TIMEOUT_MS
        })
        if (!send) {
          return
        }
        if (!socket.send(outgoing)) {
          this.endLink(link, unavailable('The server connection could not take the request.'))
        }
      },
      () => {}
    )
  }

  /** Mirrors a phone's capability update to every server socket that phone has open. */
  forwardClientCapabilities(connectionId: string, frame: string): void {
    for (const link of this.links.values()) {
      if (link.phone.connectionId !== connectionId) {
        continue
      }
      // The phone already has the desktop reply for its original id.
      const id = `relay-capabilities:${randomUUID()}`
      link.replies.noteForwarded(id, { swallowReplies: true })
      link.opened.then(
        ({ socket, hostToken }) => {
          if (
            this.isCurrent(link) &&
            !socket.send(
              declareRelayedPhoneCapabilities(
                rewriteRelayedPhoneRequest(frame, link.phone.deviceToken, hostToken, id)
              )
            )
          ) {
            this.endLink(link, unavailable('The server connection could not take the request.'))
          }
        },
        () => {}
      )
    }
  }

  /** Whether a relayed multiplex owns this connection's client binary frames. */
  carriesClientStreams(connectionId: string): boolean {
    return (
      this.clientStreamOpenings.has(connectionId) ||
      this.linksOf(connectionId).some(({ replies }) => replies.carriesClientStreams())
    )
  }

  /** Forwards a client frame unchanged when a relayed multiplex owns the connection; false leaves it local. */
  forwardClientBinary(connectionId: string, bytes: Uint8Array<ArrayBufferLike>): boolean {
    if (!this.carriesClientStreams(connectionId)) {
      return false
    }
    const link = this.linksOf(connectionId).find(({ replies }) => replies.carriesClientStreams())
    // Swallowed before the link opens: the server has no stream yet, and clients wait for `ready`.
    if (link?.ready && this.isCurrent(link) && !link.ready.socket.sendBinary(bytes)) {
      this.endLink(link, unavailable('The server connection could not take terminal input.'))
    }
    return true
  }

  closePhoneConnection(connectionId: string): void {
    this.clientStreamOpenings.delete(connectionId)
    for (const link of this.links.values()) {
      if (link.phone.connectionId === connectionId) {
        this.endLink(link, null)
      }
    }
  }

  retireEnvironment(environmentId: string): void {
    this.grants.delete(environmentId)
    for (const link of this.links.values()) {
      if (link.environmentId === environmentId) {
        link.retire(() => this.endLink(link, unavailable('The server connection was reset.')))
      }
    }
  }

  phonesChanged(): void {
    for (const environmentId of this.grants.environmentIds()) {
      this.grants.delete(environmentId)
      void this.resync(environmentId)
    }
  }

  private async resync(environmentId: string): Promise<void> {
    try {
      const host = await this.options.hosts.resolve(environmentId)
      if (host) {
        await this.grants.get(host, null)
      }
    } catch {}
  }

  // The request that opens a link decides whether it may wake a recipe VM behind the server.
  private async linkFor(
    phone: RelayedPhone,
    environmentId: string,
    method: string
  ): Promise<RelayLink> {
    const key = linkKey(phone.connectionId, environmentId)
    for (;;) {
      const existing = this.links.get(key)
      if (!existing) {
        break
      }
      let endedHere = false
      const carries = await existing.carries(method, this.options.hosts, (refusal) => {
        if (this.links.get(key) === existing) {
          endedHere = true
          this.endLink(existing, refusal)
        }
      })
      const current = this.links.get(key)
      if (current !== existing && !(endedHere && !current)) {
        if (!current) {
          throw unavailable('The server connection was reset.')
        }
        continue
      }
      if (carries) {
        return existing
      }
      break
    }
    const link = new RelayLink(environmentId, phone, this.options.allocateStreamId, (opening) =>
      this.open(opening, method)
    )
    link.opened.catch((error: unknown) => this.endLink(link, relayError(error, String(error))))
    this.links.set(linkKey(phone.connectionId, environmentId), link)
    return link
  }

  private async open(link: RelayLink, openingMethod: string): Promise<OpenedRelayLink> {
    const { phone } = link
    const host = await link.setup.within(link.prepare(this.options.hosts, openingMethod))
    if (!host) {
      throw unavailable('The server is not configured on this computer.')
    }
    // One budget covers the whole open, so a phone's open still answers in time.
    const grants = await link.setup.within(this.grants.get(host, phone.deviceId))
    if (grants.kind === 'update-needed') {
      throw unavailable('The server needs an Orca update to open its workspaces from a phone.')
    }
    // Sync can outlive phone departure or server retirement; never open a stale link.
    if (!this.isCurrent(link)) {
      throw unavailable('The relayed request was cancelled.')
    }
    const grant = acceptedGrantFor(grants, phone.deviceId)
    return openRelayedPhoneSocket(
      link,
      host,
      grant,
      grants,
      () => this.isCurrent(link),
      (error) => this.endLink(link, error)
    )
  }

  private linksOf(connectionId: string): RelayLink[] {
    return [...this.links.values()].filter((link) => link.phone.connectionId === connectionId)
  }

  private isCurrent(link: RelayLink): boolean {
    return this.links.get(linkKey(link.phone.connectionId, link.environmentId)) === link
  }

  private endLink(link: RelayLink, error: RemoteRuntimeClientError | null): void {
    if (!this.isCurrent(link)) {
      return
    }
    this.links.delete(linkKey(link.phone.connectionId, link.environmentId))
    link.abortController.abort()
    link.opened.then(
      ({ socket }) => socket.close(),
      () => {}
    )
    const openRequestIds = link.replies.takeOpenRequestIds()
    if (error) {
      for (const id of openRequestIds) {
        link.phone.reply(failure(id, error.code, error.message))
      }
    }
  }
}
