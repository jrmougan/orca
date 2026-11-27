import { describe, expect, it } from 'vitest'
import { RELAYED_RUNTIME_METHODS } from '../../../../shared/remote-runtime/relay/relayed-runtime-environment'
import { MOBILE_RPC_METHOD_ROUTES } from '../../../runtime/rpc/server/runtime-rpc-mobile-method-routing'
import type { AdmittingSharedControlSocket } from '../connections/runtime-environment-admitted-shared-send'
import {
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
      { ...call, method: 'settings.get' },
      'Windows PC'
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'method_not_found' } })
    expect(sent).toEqual([])
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
  it('are all routes the relaying server forwards, never ones it answers itself', () => {
    const answeredByOwner = [...RELAYED_RUNTIME_METHODS].filter(
      (method) => MOBILE_RPC_METHOD_ROUTES.get(method) !== 'execution-host'
    )

    expect(answeredByOwner).toEqual([])
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
