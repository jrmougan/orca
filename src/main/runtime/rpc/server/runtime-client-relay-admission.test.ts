import { describe, expect, it } from 'vitest'
import type { RpcCallerScope } from '../callers/rpc-caller-scope'
import type { RpcMethodPermission } from '../callers/rpc-method-permission'
import { runtimeClientRelayAdmission } from './runtime-client-relay-admission'

const PAIRED: RpcCallerScope = { kind: 'runtime-paired', grants: [] }
const WSL = 'runtime:wsl%3AUbuntu'
const WORKSPACE = { permission: 'workspace' } as const

function admit(
  method: string,
  executionHost: unknown,
  // Explicit: an omitted permission must stay undefined, the unregistered-method case.
  {
    permission,
    callerScope = PAIRED
  }: { permission?: RpcMethodPermission; callerScope?: RpcCallerScope }
): string {
  const admission = runtimeClientRelayAdmission({ method, executionHost }, callerScope, permission)
  return admission.kind === 'refused' ? admission.code : admission.kind
}

describe('runtimeClientRelayAdmission', () => {
  it('runs here only what names no other host', () => {
    expect(admit('worktree.ps', undefined, WORKSPACE)).toBe('run-here')
    expect(admit('worktree.ps', 'local', WORKSPACE)).toBe('run-here')
    expect(admit('worktree.ps', 'ssh:devbox', WORKSPACE)).toBe('run-here')
  })

  it('refuses a host it cannot read instead of running the call here', () => {
    expect(admit('worktree.ps', 'runtime:', WORKSPACE)).toBe('invalid_argument')
    expect(admit('worktree.ps', 'runtime:%E0%A4%A', WORKSPACE)).toBe('invalid_argument')
    expect(admit('worktree.ps', 'runtime:a|b', WORKSPACE)).toBe('invalid_argument')
    expect(admit('worktree.ps', 'wsl:Ubuntu', WORKSPACE)).toBe('invalid_argument')
    expect(admit('worktree.ps', null, WORKSPACE)).toBe('invalid_argument')
    expect(admit('worktree.ps', { id: 'wsl:Ubuntu' }, WORKSPACE)).toBe('invalid_argument')
  })

  it('relays an execution-host method to a WSL host under either spelling of its id', () => {
    expect(admit('worktree.ps', 'runtime:wsl%3AUbuntu', WORKSPACE)).toBe('relay')
    expect(admit('worktree.ps', 'runtime:wsl:Ubuntu', WORKSPACE)).toBe('relay')
  })

  it('keeps only its own pairing and relay catalog here', () => {
    expect(admit('mobileRelay.hosts.list', WSL, WORKSPACE)).toBe('run-here')
    expect(admit('pairing.getEndpoints', WSL, { permission: 'pairing-admin' })).toBe('run-here')
    expect(admit('host.declareClient', WSL, WORKSPACE)).toBe('run-here')
  })

  it('relays what names the host, including methods the phone table lacks or keeps on the desktop', () => {
    expect(admit('files.write', WSL, WORKSPACE)).toBe('relay')
    expect(admit('git.createBranch', WSL, WORKSPACE)).toBe('relay')
    expect(admit('terminal.split', WSL, WORKSPACE)).toBe('relay')
    expect(admit('settings.update', WSL, { permission: 'settings-write' })).toBe('relay')
  })

  it('never relays again a client another computer relayed here', () => {
    const admission = runtimeClientRelayAdmission(
      { method: 'worktree.ps', executionHost: WSL },
      PAIRED,
      'workspace',
      true
    )
    expect(admission.kind === 'refused' && admission.code).toBe('forbidden')
  })

  it('refuses a method this computer does not register', () => {
    expect(admit('worktree.ps', WSL, {})).toBe('forbidden')
    expect(admit('no.such.method', WSL, {})).toBe('forbidden')
  })

  it('never relays pairing-admin, desktop-control or device-self, even to a client granted them', () => {
    expect(admit('worktree.ps', WSL, { permission: 'device-self' })).toBe('forbidden')
    const granted: RpcCallerScope = { kind: 'runtime-paired', grants: ['desktop-control'] }
    expect(admit('worktree.ps', WSL, { permission: 'desktop-control', callerScope: granted })).toBe(
      'forbidden'
    )
    expect(admit('worktree.ps', WSL, { permission: 'pairing-admin', callerScope: granted })).toBe(
      'forbidden'
    )
    expect(
      admit('worktree.ps', WSL, { permission: 'pairing-admin', callerScope: { kind: 'owner' } })
    ).toBe('forbidden')
  })
})
