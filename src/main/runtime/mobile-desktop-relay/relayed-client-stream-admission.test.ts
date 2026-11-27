import { describe, expect, it } from 'vitest'
import { relayedStreamRefusal } from './relayed-client-stream-admission'

const FREE = { clientStreams: false, otherBinaryStreams: false }
const negotiated = { carriesClientStreams: true, hasLocalBinaryStreams: () => false }

describe('relayedStreamRefusal', () => {
  it('relays terminal.multiplex only for a caller that negotiated relayed binary frames', () => {
    expect(relayedStreamRefusal('terminal.multiplex', 'client-stream-ids', negotiated, FREE)).toBe(
      null
    )
    // A phone, or a runtime client that only knows runtime.client-relay.v1.
    expect(relayedStreamRefusal('terminal.multiplex', 'client-stream-ids', {}, FREE)).toMatchObject(
      { code: 'forbidden' }
    )
  })

  it('refuses a relayed multiplex beside streams whose binary input it would take', () => {
    const refusal = { code: 'forbidden' }
    // Local binary streams on the same connection.
    expect(
      relayedStreamRefusal(
        'terminal.multiplex',
        'client-stream-ids',
        { ...negotiated, hasLocalBinaryStreams: () => true },
        FREE
      )
    ).toMatchObject(refusal)
    // Another relayed binary stream, or a second multiplex.
    expect(
      relayedStreamRefusal('terminal.multiplex', 'client-stream-ids', negotiated, {
        clientStreams: false,
        otherBinaryStreams: true
      })
    ).toMatchObject(refusal)
    expect(
      relayedStreamRefusal('terminal.multiplex', 'client-stream-ids', negotiated, {
        clientStreams: true,
        otherBinaryStreams: false
      })
    ).toMatchObject(refusal)
  })

  it('refuses other relayed binary streams on a connection a multiplex owns, and lets text streams by', () => {
    const owned = { clientStreams: true, otherBinaryStreams: false }
    expect(
      relayedStreamRefusal('terminal.subscribe', 'terminal-stream-id', negotiated, owned)
    ).toMatchObject({ code: 'forbidden' })
    expect(
      relayedStreamRefusal('browser.screencast', 'untagged-binary', negotiated, owned)
    ).toMatchObject({ code: 'forbidden' })
    expect(relayedStreamRefusal('session.tabs.subscribe', 'none', negotiated, owned)).toBe(null)
    expect(relayedStreamRefusal('worktree.ps', undefined, negotiated, owned)).toBe(null)
  })
})
