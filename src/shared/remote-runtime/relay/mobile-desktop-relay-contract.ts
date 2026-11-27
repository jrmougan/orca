import {
  DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY,
  DELEGATED_RUNTIME_DEVICES_RUNTIME_CAPABILITY
} from '../pairing/delegated-mobile-device-contract'

// Send executionHost only after capability negotiation: older desktops ignore it and would execute locally.
export const MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY = 'mobile.desktop-relay.v1' as const

// The desktop answers server-row snapshots and row deltas, as worktree.ps does for its own rows.
export const MOBILE_RELAY_HOST_WORKTREE_DELTAS_RUNTIME_CAPABILITY =
  'mobile.relay-host-worktree-deltas.v1' as const

// Hosts that publish relayHostsChanged, so a phone polls mobileRelay.hosts.list only as a backstop.
export const MOBILE_RELAY_HOSTS_CHANGED_EVENT_RUNTIME_CAPABILITY =
  'mobile.relay-hosts-changed-event.v1' as const

// Hosts that publish relayHostRowsChanged while a phone that read a server's rows stays connected.
export const MOBILE_RELAY_HOST_ROWS_CHANGED_EVENT_RUNTIME_CAPABILITY =
  'mobile.relay-host-rows-changed-event.v1' as const

// Paired desktop/web clients send executionHost only when this is advertised; older servers run it locally.
// Stamped per connection, so it is not in RUNTIME_CAPABILITIES: only a server wired to its hosts relays.
export const RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY = 'runtime.client-relay.v1' as const

// Relayed terminal.multiplex needs both sides: the server stamps it beside the relay, and the client
// declares it at auth. Without the client's declaration the relay keeps refusing terminal.multiplex.
export const RUNTIME_CLIENT_RELAY_TERMINAL_MULTIPLEX_RUNTIME_CAPABILITY =
  'runtime.client-relay.terminal-multiplex.v1' as const

/** Stamped per connection wherever the server relays runtime clients. */
export const RUNTIME_CLIENT_RELAY_CONNECTION_CAPABILITIES = [
  RUNTIME_CLIENT_RELAY_RUNTIME_CAPABILITY,
  RUNTIME_CLIENT_RELAY_TERMINAL_MULTIPLEX_RUNTIME_CAPABILITY
] as const

// A server without DELEGATED_RUNTIME_DEVICES_RUNTIME_CAPABILITY refuses a paired desktop/web client with this.
export const RUNTIME_CLIENT_RELAY_UPDATE_NEEDED_MESSAGE =
  'The server needs an Orca update to open its workspaces from a paired computer.'

/** A desktop relays a phone to a server that mints delegated phone devices; each side advertises. */
export const MOBILE_RELAY_RUNTIME_CAPABILITIES = [
  DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY,
  DELEGATED_RUNTIME_DEVICES_RUNTIME_CAPABILITY,
  MOBILE_DESKTOP_RELAY_RUNTIME_CAPABILITY,
  MOBILE_RELAY_HOST_WORKTREE_DELTAS_RUNTIME_CAPABILITY,
  MOBILE_RELAY_HOSTS_CHANGED_EVENT_RUNTIME_CAPABILITY,
  MOBILE_RELAY_HOST_ROWS_CHANGED_EVENT_RUNTIME_CAPABILITY
] as const
