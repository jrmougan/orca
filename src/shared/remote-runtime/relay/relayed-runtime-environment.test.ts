import { describe, expect, it } from 'vitest'
import { parseExecutionHostId, toRuntimeExecutionHostId } from '../../execution-host/execution-host'
import {
  parseRelayedRuntimeEnvironmentId,
  runtimeEnvironmentPairingOwnerId,
  toRelayedRuntimeEnvironmentId
} from './relayed-runtime-environment'

describe('relayed runtime environment id', () => {
  it('round-trips through the execution host id that catalog rows carry', () => {
    const relayed = {
      ownerEnvironmentId: 'env/windows pc',
      executionHost: 'runtime:wsl%3Aubuntu-22.04'
    }
    const environmentId = toRelayedRuntimeEnvironmentId(relayed)

    expect(environmentId).toBe('relay:env%2Fwindows%20pc/runtime%3Awsl%253Aubuntu-22.04')
    const host = parseExecutionHostId(toRuntimeExecutionHostId(environmentId!))
    expect(
      host?.kind === 'runtime' && parseRelayedRuntimeEnvironmentId(host.environmentId)
    ).toEqual(relayed)
    expect(runtimeEnvironmentPairingOwnerId(environmentId!)).toBe('env/windows pc')
    expect(runtimeEnvironmentPairingOwnerId('env-1')).toBe('env-1')
  })

  it('gives both spellings of one host the same id', () => {
    expect(
      toRelayedRuntimeEnvironmentId({
        ownerEnvironmentId: 'a',
        executionHost: 'runtime:wsl:ubuntu'
      })
    ).toBe(
      toRelayedRuntimeEnvironmentId({
        ownerEnvironmentId: 'a',
        executionHost: 'runtime:wsl%3Aubuntu'
      })
    )
  })

  it('keeps the same host id of two paired servers apart', () => {
    const onA = toRelayedRuntimeEnvironmentId({
      ownerEnvironmentId: 'a',
      executionHost: 'runtime:vm-1'
    })
    const onB = toRelayedRuntimeEnvironmentId({
      ownerEnvironmentId: 'b',
      executionHost: 'runtime:vm-1'
    })

    expect(onA).not.toBe(onB)
    expect(parseRelayedRuntimeEnvironmentId(onA!)?.ownerEnvironmentId).toBe('a')
    expect(parseRelayedRuntimeEnvironmentId(onB!)?.ownerEnvironmentId).toBe('b')
  })

  it('refuses hosts that are not a runtime and owners that are themselves relayed', () => {
    expect(
      toRelayedRuntimeEnvironmentId({ ownerEnvironmentId: 'a', executionHost: 'local' })
    ).toBeNull()
    expect(
      toRelayedRuntimeEnvironmentId({ ownerEnvironmentId: 'a', executionHost: 'ssh:box' })
    ).toBeNull()
    expect(
      toRelayedRuntimeEnvironmentId({ ownerEnvironmentId: ' ', executionHost: 'runtime:x' })
    ).toBeNull()
    expect(
      toRelayedRuntimeEnvironmentId({
        ownerEnvironmentId: 'relay:a/runtime%3Ax',
        executionHost: 'runtime:y'
      })
    ).toBeNull()
  })

  it.each([
    'env-1',
    'relay:',
    'relay:a',
    'relay:a/',
    'relay:/runtime%3Ax',
    'relay:a/local',
    'relay:a/ssh%3Abox',
    'relay:a/runtime%3A',
    'relay:a/runtime%3Ax/extra',
    'relay:a/%E0%A4%A',
    // Not the canonical spelling of its host.
    'relay:a/runtime%3Awsl%3Aubuntu',
    'relay:a/runtime:x'
  ])('refuses the malformed id %s', (environmentId) => {
    expect(parseRelayedRuntimeEnvironmentId(environmentId)).toBeNull()
  })
})
