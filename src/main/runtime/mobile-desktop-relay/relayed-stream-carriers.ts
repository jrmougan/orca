/** terminal-stream-id renumbers result/header ids; untagged-binary sends binary frames that carry
 * no id (one phone screencast at a time); none sends no binary.
 * client-stream-ids keeps ids as sent: the client allocates them, and its binary input is forwarded unread.
 * unrelayed-client-binary is driven by client binary frames the relay has no lane for, so it is refused. */
export type RelayedStreamCarrier =
  | 'terminal-stream-id'
  | 'untagged-binary'
  | 'none'
  | 'client-stream-ids'
  | 'unrelayed-client-binary'

export const RELAYED_STREAM_CARRIERS: ReadonlyMap<string, RelayedStreamCarrier> = new Map([
  ['terminal.subscribe', 'terminal-stream-id'],
  ['terminal.multiplex', 'client-stream-ids'],
  ['browser.screencast', 'untagged-binary'],
  ['network.browserTunnel', 'unrelayed-client-binary'],
  ['network.portForward', 'unrelayed-client-binary'],
  ['agentSession.subscribe', 'none'],
  ['agentSession.subscribeStatus', 'none'],
  ['nativeChat.subscribe', 'none'],
  ['session.tabs.subscribe', 'none'],
  ['session.tabs.subscribeAll', 'none']
])
