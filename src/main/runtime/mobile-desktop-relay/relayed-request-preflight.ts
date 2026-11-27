import { GITHUB_EXACT_OPERATION_UNSUPPORTED } from '../../../shared/github/work-items/work-item-target'
import type { RemoteRuntimePassthroughSocket } from '../../../shared/remote-runtime/remote-runtime-passthrough-socket'
import type { MobileDesktopRelayHost, MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'
import { failure, type RelayLink } from './mobile-desktop-relay-link'
import { verifyRelayedGitHubAuthority } from './relay-github-authority'
import { createRelayedBrowserTab } from './relayed-browser-tab-create'

/**
 * What a forwarded request needs on its open link before it is sent. False when the request was
 * already answered here (a browser tab this desktop hosts, or a failed check), or its link ended.
 */
export async function preflightRelayedRequest(args: {
  hosts: MobileDesktopRelayHosts
  prepareBrowserHost?: (host: MobileDesktopRelayHost) => Promise<string | null>
  link: RelayLink
  host: MobileDesktopRelayHost
  request: { id: string; method: string }
  /** The frame as the server will receive it. */
  frame: string
  socket: RemoteRuntimePassthroughSocket
  isCurrent: () => boolean
  timeoutMs: number
}): Promise<boolean> {
  const { link, request, frame, socket, isCurrent, timeoutMs } = args
  try {
    if (request.method === 'status.get') {
      await args.prepareBrowserHost?.(args.host)
    }
    if (
      request.method === 'browser.tabCreate' &&
      (await createRelayedBrowserTab({
        hosts: args.hosts,
        prepareBrowserHost: args.prepareBrowserHost,
        link,
        frame,
        socket,
        isCurrent,
        timeoutMs
      }))
    ) {
      return false
    }
    const verification = verifyRelayedGitHubAuthority({
      method: request.method,
      frame,
      socket,
      replies: link.replies,
      isCurrent,
      timeoutMs
    })
    if (verification) {
      await verification
    }
    return isCurrent()
  } catch (error) {
    if (isCurrent()) {
      const reply = link.replies.text(
        failure(
          request.id,
          request.method === 'browser.tabCreate' ||
            request.method === 'status.get' ||
            (error instanceof Error && error.message === GITHUB_EXACT_OPERATION_UNSUPPORTED)
            ? 'remote_runtime_unavailable'
            : 'runtime_source_mismatch',
          error instanceof Error ? error.message : 'Unable to confirm the executing Orca server.'
        )
      )
      if (reply) {
        link.phone.reply(reply)
      }
    }
    return false
  }
}
