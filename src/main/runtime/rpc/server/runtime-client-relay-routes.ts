import { DECLARE_ORCA_ACCOUNT_METHOD } from '../../../../shared/remote-runtime/pairing/paired-desktop-account-contract'
import {
  ORCAD_DECLARE_CLIENT_METHOD,
  ORCAD_PEER_DESKTOPS_METHOD
} from '../../../../shared/remote-runtime/orcad-lifecycle/orcad-peer-desktops-contract'

export type RuntimeClientRelayRoute = 'this-server' | 'named-host'

// Namespaces about the client's pairing with this computer and the servers it relays to.
const THIS_SERVER_METHOD_PREFIXES = ['pairing.', 'mobileRelay.'] as const

// Who the connected installation is, which only the computer it is connected to can know.
const THIS_SERVER_METHODS: ReadonlySet<string> = new Set([
  DECLARE_ORCA_ACCOUNT_METHOD,
  ORCAD_DECLARE_CLIENT_METHOD,
  ORCAD_PEER_DESKTOPS_METHOD
])

/** Where a paired desktop/web client's call goes when it names a server: there, unless the method is
 * by nature this computer's. Unlike the phone table it lists no host methods, so a new one is relayed. */
export function runtimeClientRelayRoute(method: string): RuntimeClientRelayRoute {
  return THIS_SERVER_METHODS.has(method) ||
    THIS_SERVER_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix))
    ? 'this-server'
    : 'named-host'
}
