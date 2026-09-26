# Message Relay protocol v1

All methods are authenticated OpenClaw Gateway WebSocket RPCs. Requests use the Gateway's standard `req` frame; the examples below show only `method` and `params`. The plugin identifies the caller from the **verified connection device**, never from a client-supplied device ID.

## Detect

`message-relay.capabilities` (`operator.read`)

```json
{}
```

Returns `protocolVersion: 1`, `maxTextLength: 32000`, `maxSyncPageSize: 100`, and a `features` list. Unknown method means the plugin is not installed or active. That should be an onboarding state, not a request to auto-install code from the phone.

## Send

`message-relay.send` (`operator.write`)

```json
{"conversationId":"chat_01","messageId":"msg_01","text":"Hello"}
```

Returns:

```json
{"message":{"conversationId":"chat_01","messageId":"msg_01","text":"Hello","status":"queued","reply":null,"error":null,"createdAt":1790000000000,"updatedAt":1790000000000}}
```

A successful response means the SQLite insert has committed, not that the agent has replied. `messageId` is unique per device. Reusing it with the same conversation and text returns the existing message; changing either is rejected. `conversationId` and `messageId` must be 1–80 ASCII letters, digits, underscores, or hyphens. Text must be nonblank and at most 32,000 JavaScript characters. The backend derives a separate core idempotency key using the verified device ID, so a crash between Gateway admission and run-ID persistence does not create a second turn.

## Sync

`message-relay.sync` (`operator.read`)

```json
{"conversationId":"chat_01","after":0,"limit":100}
```

Returns:

```json
{"changes":[{"cursor":1,"message":{"conversationId":"chat_01","messageId":"msg_01","text":"Hello","status":"done","reply":"Hello back","error":null,"createdAt":1790000000000,"updatedAt":1790000005000}}],"nextCursor":1,"hasMore":false}
```

Save `nextCursor` **after** applying the page. Use it as the next `after`. `limit` is 1–100 (default 100). Changes are ordered by monotonically increasing cursor. A message may appear multiple times as its status changes; upsert by `messageId`. The returned message is its *current* snapshot, not necessarily its state when that particular change was recorded. A client that loses its cursor can sync again from zero. Cursor values belong to this plugin database and are not portable between Gateway machines.

States: `queued` (committed), `running` (admitted to OpenClaw), `retry` (temporary transport/worker failure), `done` (reply saved), `failed` (run ended unsuccessfully or without a visible reply). `error` is generic and safe for display; raw internal exceptions are not returned to clients.

The plugin rejects new sends when a device already has 1,000 unfinished messages; duplicate sends for an existing ID remain idempotent. Clients should back off and retain their local outbox. The plugin currently has no automatic pruning, so operators must monitor its database size.

## Isolation and delivery boundary

Storage, dispatch, and sync are scoped to the Gateway-verified device ID plus `conversationId`. Different devices cannot read one another's rows, even if they choose identical conversation/message IDs. This is intentionally **not** a shared multi-device account protocol. The plugin processes each conversation serially and does not promise real-time streaming. Before `send` succeeds, durability is the client's responsibility; after it succeeds, durability is the Gateway machine's responsibility. Neither a Tailscale nor Cloudflare tunnel replaces these queues.
