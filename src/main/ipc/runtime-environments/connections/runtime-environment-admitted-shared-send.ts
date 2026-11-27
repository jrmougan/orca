import type { RemoteRuntimeSharedControlConnection } from '../../../../shared/remote-runtime/control/remote-runtime-shared-control-connection'
import type { RuntimeRpcResponse } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import type { RuntimeEnvironmentCall } from '../requests/runtime-environment-call'

export type AdmittingSharedControlSocket = Pick<
  RemoteRuntimeSharedControlConnection,
  'request' | 'socketGeneration'
>

/** The socket (by generation) each connection last passed an admission on, kept by the caller. */
export type SharedControlSocketAdmissions = WeakMap<AdmittingSharedControlSocket, number>

/**
 * Send only on the shared socket whose own status.get passed `admits`; null if it did not, or the
 * socket changed. With `admissions`, a socket that already passed is not asked again.
 */
export async function sendOnAdmittedSharedControlSocket<TResult>(
  shared: AdmittingSharedControlSocket,
  call: RuntimeEnvironmentCall,
  admits: (status: RuntimeStatus) => boolean,
  admissions?: SharedControlSocketAdmissions
): Promise<RuntimeRpcResponse<TResult> | null> {
  let statusSocket = admissions?.get(shared)
  if (statusSocket === undefined || statusSocket !== shared.socketGeneration.peek()) {
    statusSocket = undefined
    admissions?.delete(shared)
    const status = await shared.request<RuntimeStatus>(
      'status.get',
      undefined,
      call.timeoutMs,
      undefined,
      call.signal,
      {
        beforeSend: () => void (statusSocket = shared.socketGeneration.peek()),
        idlePassive: call.idlePassive
      }
    )
    if (!status.ok || !admits(status.result)) {
      return null
    }
    if (statusSocket !== undefined) {
      admissions?.set(shared, statusSocket)
    }
  }
  let socketChanged = false
  const beforeSend = (): void => {
    socketChanged = shared.socketGeneration.peek() !== statusSocket
    if (socketChanged) {
      throw new Error('Runtime connection changed before sending')
    }
  }
  try {
    return await shared.request<TResult>(
      call.method,
      call.params,
      call.timeoutMs,
      call.envelope,
      call.signal,
      {
        beforeSend,
        prepareRequest: call.prepareRequest,
        prepareGuard: call.prepareGuard,
        idlePassive: call.idlePassive
      }
    )
  } catch (error) {
    if (socketChanged) {
      return null
    }
    throw error
  }
}
