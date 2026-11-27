import { runtimeEnvironmentPairingOwnerId } from '../../../../../shared/remote-runtime/relay/relayed-runtime-environment'

const connectionGenerationByEnvironment = new Map<string, number>()

/** A relayed server rides its owner's connection, so it answers with the owner's generation. */
export function getRuntimeEnvironmentConnectionGeneration(environmentId: string): number {
  return connectionGenerationByEnvironment.get(runtimeEnvironmentPairingOwnerId(environmentId)) ?? 0
}

export function advanceRuntimeEnvironmentConnectionGeneration(environmentId: string): number {
  const next = getRuntimeEnvironmentConnectionGeneration(environmentId) + 1
  connectionGenerationByEnvironment.set(environmentId, next)
  return next
}

export function clearRuntimeEnvironmentConnectionGenerations(): Iterable<string> {
  const environmentIds = [...connectionGenerationByEnvironment.keys()]
  connectionGenerationByEnvironment.clear()
  return environmentIds
}
