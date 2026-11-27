import type { WebSocket } from 'ws'
import type { TerminalStreamFrame } from '../../../../shared/terminal/stream/terminal-stream-protocol'
import { RUNTIME_CLIENT_RELAY_TERMINAL_MULTIPLEX_RUNTIME_CAPABILITY } from '../../../../shared/remote-runtime/relay/mobile-desktop-relay-contract'
import type { RelayedStreamCaller } from '../../mobile-desktop-relay/relayed-client-stream-admission'
import type { AuthenticatedMobileSocket } from '../mobile/mobile-socket-wiring'
import { DeviceRegistry } from './pairing/device-registry'
import { loadOrCreateE2EEKeypair, type E2EEKeypair } from './pairing/e2ee-keypair'
import { ensureHostInstanceIdentity, type HostIdentityOutcome } from '../../host-instance-identity'
import { RuntimeRpcState } from './runtime-rpc-state'
import {
  DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE,
  E2EE_KEY_UNAVAILABLE_GUIDANCE,
  pairingUnavailable,
  type PairingIdentityInitialization
} from './runtime-rpc-pairing-types'

export class RuntimeRpcBinaryRouting extends RuntimeRpcState {
  protected registerBinaryStreamHandler(
    connectionId: string | undefined,
    streamId: number,
    handler: (frame: TerminalStreamFrame) => void
  ): () => void {
    this.assertNoRelayedClientStreams(connectionId)
    return this.binaryMessageRouter.registerTerminalStream(connectionId, streamId, handler)
  }

  protected registerBinaryMessageHandler(
    connectionId: string | undefined,
    handler: (bytes: Uint8Array<ArrayBufferLike>) => void
  ): () => void {
    this.assertNoRelayedClientStreams(connectionId)
    return this.binaryMessageRouter.registerRawMessage(connectionId, handler)
  }

  /** Binary frames are client data (terminal input, uploads), so they are use on every socket. */
  protected handleWebSocketBinaryMessage(bytes: Uint8Array<ArrayBufferLike>, ws: WebSocket): void {
    if (this.idleStopFenced) {
      return
    }
    this.lastClientRequestAt = Date.now()
    const connectionId = this.mobileSocketWiring?.getConnectionId(ws)
    // A relayed multiplex owns its connection's binary lane; every other connection stays local.
    if (connectionId && this.mobileDesktopRelay?.forwardClientBinary(connectionId, bytes)) {
      return
    }
    this.binaryMessageRouter.dispatch(connectionId, bytes)
  }

  /** What a runtime client's socket lets the relay carry beyond text requests. */
  protected relayedStreamCaller(socket: AuthenticatedMobileSocket): RelayedStreamCaller {
    return {
      // Both sides negotiate relayed binary frames; a client that only knows the relay keeps its refusal.
      carriesClientStreams: socket.clientCapabilities.includes(
        RUNTIME_CLIENT_RELAY_TERMINAL_MULTIPLEX_RUNTIME_CAPABILITY
      ),
      hasLocalBinaryStreams: () => this.binaryMessageRouter.hasHandlers(socket.connectionId)
    }
  }

  // Frames on a relayed lane never reach local handlers, so a local stream there would hang silently.
  private assertNoRelayedClientStreams(connectionId: string | undefined): void {
    if (connectionId && this.mobileDesktopRelay?.carriesClientStreams(connectionId)) {
      throw new Error('binary_handler_mode_conflict')
    }
  }

  protected registerWebSocketDispatchAbort(ws: WebSocket): {
    signal: AbortSignal
    dispose: () => void
  } {
    const abortController = new AbortController()
    if (ws.readyState !== ws.OPEN) {
      abortController.abort()
      return { signal: abortController.signal, dispose: () => {} }
    }

    let state = this.wsDispatchAbortStates.get(ws)
    if (!state) {
      state = {
        controllers: new Set(),
        abortOnClose: () => this.abortWebSocketDispatches(ws)
      }
      this.wsDispatchAbortStates.set(ws, state)
      // Why: many streaming RPCs share one WebSocket; one socket-level abort fan-out avoids MaxListenersExceededWarning.
      ws.on('close', state.abortOnClose)
      ws.on('error', state.abortOnClose)
    }
    state.controllers.add(abortController)

    return {
      signal: abortController.signal,
      dispose: () => {
        const current = this.wsDispatchAbortStates.get(ws)
        if (!current) {
          return
        }
        current.controllers.delete(abortController)
        if (current.controllers.size > 0) {
          return
        }
        this.wsDispatchAbortStates.delete(ws)
        ws.off('close', current.abortOnClose)
        ws.off('error', current.abortOnClose)
      }
    }
  }

  protected abortWebSocketDispatches(ws: WebSocket): void {
    const state = this.wsDispatchAbortStates.get(ws)
    if (!state) {
      return
    }
    this.wsDispatchAbortStates.delete(ws)
    ws.off('close', state.abortOnClose)
    ws.off('error', state.abortOnClose)
    for (const controller of state.controllers) {
      controller.abort()
    }
    state.controllers.clear()
  }

  protected initializePairingIdentity(): PairingIdentityInitialization {
    try {
      logHostIdentityOutcome(ensureHostInstanceIdentity(this.userDataPath))
    } catch (error) {
      // A rotation that started but could not finish must not be served; the next start finishes it.
      console.error('[runtime] Failed to finish rotating the pairing identity:', error)
      return {
        ok: false,
        failure: pairingUnavailable('e2ee_key_unavailable', E2EE_KEY_UNAVAILABLE_GUIDANCE)
      }
    }
    let deviceRegistry: DeviceRegistry
    try {
      deviceRegistry = new DeviceRegistry(this.userDataPath)
    } catch (error) {
      console.error('[runtime] Failed to initialize pairing registry:', error)
      return {
        ok: false,
        failure: pairingUnavailable(
          'device_registry_unavailable',
          DEVICE_REGISTRY_UNAVAILABLE_GUIDANCE
        )
      }
    }
    let e2eeKeypair: E2EEKeypair
    try {
      e2eeKeypair = loadOrCreateE2EEKeypair(this.userDataPath)
    } catch (error) {
      console.error('[runtime] Failed to initialize E2EE identity:', error)
      return {
        ok: false,
        failure: pairingUnavailable('e2ee_key_unavailable', E2EE_KEY_UNAVAILABLE_GUIDANCE)
      }
    }
    return { ok: true, deviceRegistry, e2eeKeypair }
  }
}

function logHostIdentityOutcome(outcome: HostIdentityOutcome): void {
  if (outcome.kind === 'kept') {
    console.error(
      '[runtime] Could not apply ORCA_INSTANCE_ID; serving the existing pairing identity unchanged. Orca retries on the next start.',
      outcome.error
    )
  } else if (outcome.kind === 'rotated' && outcome.reason === 'instance_changed') {
    // Loud on purpose: a value that changes on every start would un-pair clients each time.
    console.error(
      '[runtime] ORCA_INSTANCE_ID differs from the value recorded with this pairing identity, so Orca created a new identity and removed all paired devices. Clients must pair with this host again. If this host was not copied, set ORCA_INSTANCE_ID to a value that stays the same across restarts.'
    )
  } else if (outcome.kind === 'rotated') {
    console.error(
      '[runtime] Finished an interrupted pairing identity rotation. Clients must pair with this host again.'
    )
  }
}
