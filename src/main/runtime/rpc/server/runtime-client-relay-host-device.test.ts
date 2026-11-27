// A paired desktop client reaches a host behind the server it is paired with, end to end: its own
// transport, the relaying server, and the host that holds it as a runtime device.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pairedRuntimeConnectionFromOffer } from '../../../../shared/remote-runtime/pairing/paired-runtime-connection'
import { RUNTIME_CLIENT_RELAY_TERMINAL_MULTIPLEX_RUNTIME_CAPABILITY } from '../../../../shared/remote-runtime/relay/mobile-desktop-relay-contract'
import { sendRemoteRuntimeRequestOnSocket } from '../../../../shared/remote-runtime/requests/remote-runtime-request-socket'
import { subscribeRemoteRuntimeTransport } from '../../../../shared/remote-runtime/requests/remote-runtime-subscription-transport'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import {
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  encodeTerminalStreamJson,
  TerminalStreamOpcode
} from '../../../../shared/terminal/stream/terminal-stream-protocol'
import { relayedHostSubscriptionAdmission } from '../../../ipc/runtime-environments/requests/runtime-environment-relayed-host-send'
import type { MobileDesktopRelayHosts } from '../../mobile-desktop-relay/mobile-desktop-relay-hosts'
import { pair } from '../../mobile-desktop-relay/mobile-desktop-relay-phone.test-fixture'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

const HOST = { ownerEnvironmentId: 'windows-pc', executionHost: 'runtime:wsl%3AUbuntu' } as const
const ENVELOPE = { executionHost: HOST.executionHost }
const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

async function startServer(name: string) {
  const userDataPath = mkdtempSync(join(tmpdir(), `orca-relay-host-device-${name}-`))
  const runtime = new OrcaRuntimeService()
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath,
    enableWebSocket: true,
    wsPort: 0
  })
  await server.start()
  cleanups.push(async () => {
    await server.stop()
    rmSync(userDataPath, { recursive: true, force: true })
  })
  return { server, runtime }
}

/** A client paired with `relaying`, which relays to `host` as its WSL distro. */
async function startRelayedHost() {
  const host = await startServer('host')
  const relaying = await startServer('relaying')
  const hostPairing = pair(host.server, 'runtime', 'Windows PC')
  const hosts: MobileDesktopRelayHosts = {
    list: () => ({
      environments: [],
      statusByEnvironmentId: new Map(),
      sshTargetLabels: new Map(),
      sshConnectionStates: new Map()
    }),
    resolve: async (environmentId) =>
      environmentId === 'wsl:Ubuntu'
        ? { environmentId, fence: 'fence-1', pairing: hostPairing }
        : null,
    call: (_host, method, params) =>
      sendRemoteRuntimeRequestOnSocket(
        pairedRuntimeConnectionFromOffer(hostPairing),
        method,
        params,
        10_000
      ),
    hostsBrowserPage: () => false,
    onEnvironmentRetired: () => () => {},
    onStatusChanged: () => () => {},
    watchChanges: () => ({ close: () => {}, current: () => false })
  }
  relaying.server.setMobileDesktopRelayHosts(hosts)
  const client = pairedRuntimeConnectionFromOffer(pair(relaying.server, 'runtime', 'Laptop'))
  const call = (method: string, params: unknown): Promise<RuntimeRpcResponse<unknown>> =>
    sendRemoteRuntimeRequestOnSocket(client, method, params, 10_000, ENVELOPE)
  return { host, relaying, client, call }
}

describe('a paired desktop client naming a host behind its server', () => {
  it('is answered by the host, as a runtime device, for methods the phone table refuses', async () => {
    const { host, relaying, call } = await startRelayedHost()

    const status = await call('status.get', undefined)
    expect(status).toMatchObject({
      ok: true,
      result: { deviceScope: 'runtime' },
      _meta: { runtimeId: host.runtime.getRuntimeId() }
    })
    expect(host.runtime.getRuntimeId()).not.toBe(relaying.runtime.getRuntimeId())

    // Past both admissions: only the empty params are refused, and by the host.
    for (const method of ['terminal.split', 'files.write', 'session.tabs.updatePaneLayout']) {
      expect(await call(method, {}), method).toMatchObject({
        ok: false,
        error: { code: 'invalid_argument' },
        _meta: { runtimeId: host.runtime.getRuntimeId() }
      })
    }
  }, 30_000)

  it('drives terminal.multiplex with its own stream ids, both ways', async () => {
    const { host, client } = await startRelayedHost()
    const replies: unknown[] = []
    const frames: Uint8Array[] = []
    const multiplex = await subscribeRemoteRuntimeTransport(
      client,
      'terminal.multiplex',
      {},
      10_000,
      {
        onResponse: (response) => replies.push(response),
        onBinary: (bytes) => frames.push(bytes),
        onError: (error) => replies.push(error)
      },
      {
        clientCapabilities: [RUNTIME_CLIENT_RELAY_TERMINAL_MULTIPLEX_RUNTIME_CAPABILITY],
        envelope: ENVELOPE,
        admit: relayedHostSubscriptionAdmission(
          HOST,
          'terminal.multiplex',
          'Windows PC',
          host.runtime.getRuntimeId()
        )
      }
    )
    cleanups.push(() => multiplex.close())
    await vi.waitFor(() =>
      expect(replies[0]).toMatchObject({ ok: true, result: { type: 'ready' } })
    )

    // The client's binary frame reaches the host, which answers on the id the client chose.
    multiplex.sendBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Subscribe,
        streamId: 0,
        seq: 0,
        payload: encodeTerminalStreamJson({
          streamId: 5,
          terminal: 'term_missing',
          viewport: { cols: 80, rows: 24 }
        })
      })
    )

    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0))
    expect(decodeTerminalStreamFrame(frames[0])).toMatchObject({ streamId: 5 })
    expect(replies).toContainEqual(
      expect.objectContaining({ ok: true, result: { type: 'end', streamId: 5 } })
    )
  }, 30_000)
})
