import { describe, expect, it } from 'vitest'
import { OWNER_RPC_CALLER_SCOPE } from '../../../runtime/rpc/callers/rpc-caller-scope'
import { runtimeClientRelayAdmission } from '../../../runtime/rpc/server/runtime-client-relay-admission'
import type { AdmittingSharedControlSocket } from '../connections/runtime-environment-admitted-shared-send'
import {
  relayedHostMethodRefusal,
  relayedHostSubscriptionAdmission,
  sendRelayedHostCall
} from './runtime-environment-relayed-host-send'

const RELAYED = { ownerEnvironmentId: 'windows-pc', executionHost: 'runtime:wsl%3Aubuntu' } as const

function ownerSocket(
  capabilities: string[],
  generations: number[] = [1, 1],
  relayedRuntimeId = 'wsl'
) {
  const sent: { method: string; executionHost: unknown }[] = []
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake has the two members the send reads; its canned results stand in for any TResult.
  const socket = {
    socketGeneration: { peek: () => generations.shift() ?? 1 },
    request: async (
      method: string,
      _params: unknown,
      _timeoutMs: number,
      envelope: { executionHost?: string } | undefined,
      _signal: unknown,
      hooks: { beforeSend?: () => void } | undefined
    ) => {
      hooks?.beforeSend?.()
      sent.push({ method, executionHost: envelope?.executionHost })
      return method === 'status.get' && envelope?.executionHost === undefined
        ? {
            id: '1',
            ok: true,
            result: { runtimeId: 'owner', capabilities },
            _meta: { runtimeId: 'owner' }
          }
        : { id: '2', ok: true, result: { repos: [] }, _meta: { runtimeId: relayedRuntimeId } }
    }
  } as unknown as AdmittingSharedControlSocket
  return { socket, sent }
}

const call = { method: 'repo.list', params: undefined, timeoutMs: 1_000 }

describe('sendRelayedHostCall', () => {
  it('names the relayed host on a socket that advertised the relay', async () => {
    const { socket, sent } = ownerSocket(['runtime.client-relay.v1'])

    const response = await sendRelayedHostCall(socket, RELAYED, call, 'Windows PC')

    expect(response.ok).toBe(true)
    expect(sent).toEqual([
      { method: 'status.get', executionHost: undefined },
      { method: 'repo.list', executionHost: 'runtime:wsl%3Aubuntu' }
    ])
  })

  it('sends nothing to a server that does not advertise the relay', async () => {
    const { socket, sent } = ownerSocket(['some.other.capability'])

    const response = await sendRelayedHostCall(socket, RELAYED, call, 'Windows PC')

    expect(response).toMatchObject({ ok: false, error: { code: 'remote_runtime_unavailable' } })
    expect(sent.map((request) => request.method)).toEqual(['status.get'])
  })

  it('sends nothing when the socket that advertised the relay was replaced', async () => {
    const { socket, sent } = ownerSocket(['runtime.client-relay.v1'], [1, 2])

    const response = await sendRelayedHostCall(socket, RELAYED, call, 'Windows PC')

    expect(response).toMatchObject({ ok: false, error: { code: 'remote_runtime_unavailable' } })
    expect(sent.map((request) => request.method)).toEqual(['status.get'])
  })

  it('keeps a call the relay does not carry on this computer', async () => {
    const { socket, sent } = ownerSocket(['runtime.client-relay.v1'])

    const response = await sendRelayedHostCall(
      socket,
      RELAYED,
      { ...call, method: 'mobileRelay.hosts.list' },
      'Windows PC'
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'method_not_found' } })
    expect(sent).toEqual([])
  })

  it('sends a method outside the phone table only to a server that relays every host method', async () => {
    // A server that relays phone methods only would run settings.update on itself.
    const phoneRoutesOnly = ownerSocket(['runtime.client-relay.v1'])
    const settings = { ...call, method: 'settings.update' }

    const refused = await sendRelayedHostCall(phoneRoutesOnly.socket, RELAYED, settings, 'PC')

    expect(refused).toMatchObject({ ok: false, error: { code: 'remote_runtime_unavailable' } })
    expect(phoneRoutesOnly.sent.map((request) => request.method)).toEqual(['status.get'])

    const everyRoute = ownerSocket([
      'runtime.client-relay.v1',
      'runtime.client-relay.host-routes.v1'
    ])
    await sendRelayedHostCall(everyRoute.socket, RELAYED, settings, 'PC')

    expect(everyRoute.sent.at(-1)).toEqual({
      method: 'settings.update',
      executionHost: 'runtime:wsl%3Aubuntu'
    })
  })

  it('does not send a call shaped for another runtime of the relayed host', async () => {
    const { socket, sent } = ownerSocket(['runtime.client-relay.v1'], [1, 1, 1], 'wsl-restarted')

    const response = await sendRelayedHostCall(
      socket,
      RELAYED,
      { ...call, method: 'terminal.create', expectedRuntimeId: 'wsl' },
      'Windows PC'
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'runtime_environment_changed' } })
    expect(sent.map((request) => request.method)).toEqual(['status.get', 'status.get'])
  })
})

describe('relayed host methods', () => {
  const sentByClient = (method: string): boolean => relayedHostMethodRefusal(method, 'PC') === null
  const relayedByServer = (method: string): boolean =>
    runtimeClientRelayAdmission(
      { method, executionHost: 'runtime:wsl%3Aubuntu' },
      OWNER_RPC_CALLER_SCOPE,
      'workspace'
    ).kind === 'relay'

  it('are sent exactly when the relaying server forwards them, never when it answers itself', () => {
    const forwarded = ['terminal.split', 'files.write', 'settings.get', 'terminal.multiplex']
    const answeredByServer = ['mobileRelay.hosts.list', 'pairing.offer', 'host.peerDesktops']

    expect(forwarded.map(sentByClient)).toEqual([true, true, true, true])
    expect(forwarded.map(relayedByServer)).toEqual([true, true, true, true])
    expect(answeredByServer.map(sentByClient)).toEqual([false, false, false])
    expect(answeredByServer.map(relayedByServer)).toEqual([false, false, false])
  })

  it('keeps streams driven by client binary frames the relay cannot carry on this computer', () => {
    expect(['network.portForward', 'network.browserTunnel'].map(sentByClient)).toEqual([
      false,
      false
    ])
  })
})

describe('relayedHostSubscriptionAdmission', () => {
  function dedicatedSocket(capabilities: string[]) {
    const sent: { method: string; executionHost: unknown }[] = []
    const request = async (
      method: string,
      _params: unknown,
      envelope?: { executionHost?: string }
    ) => {
      sent.push({ method, executionHost: envelope?.executionHost })
      return {
        id: '1',
        ok: true as const,
        result: { runtimeId: 'owner', capabilities },
        _meta: { runtimeId: envelope?.executionHost ? 'wsl' : 'owner' }
      }
    }
    return { request, sent }
  }

  it('refuses the stream on a socket that does not advertise the relay, naming no host', async () => {
    const { request, sent } = dedicatedSocket([])

    await expect(
      relayedHostSubscriptionAdmission(RELAYED, 'session.tabs.subscribe', 'Windows PC')(request)
    ).rejects.toMatchObject({ code: 'remote_runtime_unavailable' })
    expect(sent).toEqual([{ method: 'status.get', executionHost: undefined }])
  })

  it('refuses terminal.multiplex on a server that relays calls but not binary frames', async () => {
    const { request, sent } = dedicatedSocket(['runtime.client-relay.v1'])

    await expect(
      relayedHostSubscriptionAdmission(RELAYED, 'terminal.multiplex', 'Windows PC')(request)
    ).rejects.toMatchObject({ code: 'remote_runtime_unavailable' })
    expect(sent).toEqual([{ method: 'status.get', executionHost: undefined }])
  })

  it('admits terminal.multiplex once the socket advertises both', async () => {
    const { request } = dedicatedSocket([
      'runtime.client-relay.v1',
      'runtime.client-relay.terminal-multiplex.v1'
    ])

    await expect(
      relayedHostSubscriptionAdmission(RELAYED, 'terminal.multiplex', 'Windows PC')(request)
    ).resolves.toBeUndefined()
  })

  it('refuses a stream pinned to another runtime of the relayed host', async () => {
    const { request } = dedicatedSocket(['runtime.client-relay.v1'])

    await expect(
      relayedHostSubscriptionAdmission(
        RELAYED,
        'session.tabs.subscribe',
        'Windows PC',
        'wsl-before-restart'
      )(request)
    ).rejects.toMatchObject({ code: 'runtime_environment_changed' })
  })
})
