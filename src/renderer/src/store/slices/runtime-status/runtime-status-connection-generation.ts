import { runtimeEnvironmentPairingOwnerId } from '../../../../../shared/remote-runtime/relay/relayed-runtime-environment'

const connectionGenerationByEnvironment = new Map<string, number>()

/**
 * A relayed server rides its owner's connection, so its generation moves with the owner's; its
 * own count on top moves it when the relayed server itself starts a new runtime session.
 */
export function getRuntimeEnvironmentConnectionGeneration(environmentId: string): number {
  const ownerId = runtimeEnvironmentPairingOwnerId(environmentId)
  const owner = connectionGenerationByEnvironment.get(ownerId) ?? 0
  return ownerId === environmentId
    ? owner
    : owner + (connectionGenerationByEnvironment.get(environmentId) ?? 0)
}

export function advanceRuntimeEnvironmentConnectionGeneration(environmentId: string): number {
  connectionGenerationByEnvironment.set(
    environmentId,
    (connectionGenerationByEnvironment.get(environmentId) ?? 0) + 1
  )
  return getRuntimeEnvironmentConnectionGeneration(environmentId)
}

export function clearRuntimeEnvironmentConnectionGenerations(): Iterable<string> {
  const environmentIds = [...connectionGenerationByEnvironment.keys()]
  connectionGenerationByEnvironment.clear()
  return environmentIds
}
