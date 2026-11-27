import { describe, expect, it } from 'vitest'
import type { AdmittingSharedControlSocket } from '../connections/runtime-environment-admitted-shared-send'
import { sendRelayedHostCall } from './runtime-environment-relayed-host-send'

const RELAYED = { ownerEnvironmentId: 'windows-pc', executionHost: 'runtime:wsl%3Aubuntu' } as const

function ownerSocket(capabilities: string[], generations: number[] = [1, 1]) {
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
      return method === 'status.get'
        ? {
            id: '1',
            ok: true,
            result: { runtimeId: 'owner', capabilities },
            _meta: { runtimeId: 'owner' }
          }
        : { id: '2', ok: true, result: { repos: [] }, _meta: { runtimeId: 'wsl' } }
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

  it('keeps calls outside the catalog on this computer', async () => {
    const { socket, sent } = ownerSocket(['runtime.client-relay.v1'])

    const response = await sendRelayedHostCall(
      socket,
      RELAYED,
      { ...call, method: 'terminal.create' },
      'Windows PC'
    )

    expect(response).toMatchObject({ ok: false, error: { code: 'method_not_found' } })
    expect(sent).toEqual([])
  })
})
