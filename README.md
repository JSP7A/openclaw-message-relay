# OpenClaw Message Relay

A self-hosted OpenClaw Gateway plugin that gives messaging apps durable text send and incremental reply sync. It is transport-agnostic: a client can reach the owner's private Gateway over a tailnet or another *owner-configured* secure route. This package does **not** create a tunnel, expose a public HTTP endpoint, or run a hosted service.

**Status:** Early 0.1.x release. The generic archive passed a paired iPhone-simulator send/sync/reply round trip against one live Gateway on 2026-09-26. It has not been tested on a second Gateway or physical phone. Treat the wire contract as version 1, not a promise of backwards compatibility beyond 0.x.

## What it does

- A paired Gateway device calls `message-relay.send` with a stable message ID. The plugin commits the request to its own SQLite database **before** acknowledging it.
- A background worker dispatches to the configured agent, waits for that specific run, and stores the run-bound reply. Queued and admitted work resumes after restart. Messages within a device/conversation are processed in order.
- `message-relay.sync` returns an incremental stream of changes, including a reply that arrives after the original send cursor. Each device sees only its own messages.
- The plugin uses `operator.read`/`operator.write` and the Gateway's existing signed device pairing. It never gives an app administrative plugin-install privileges.
- Dispatch is bounded to four concurrent runs and 1,000 queued/running/retry messages per device. This is backpressure, not a long-term storage retention policy.

No push notifications, attachments, cross-device conversation sharing, server-to-phone events, deletion/retention policy, or offline guarantee before the phone reaches the Gateway are included. Stored messages currently remain on disk indefinitely. A client needs its own local outbox and must retry with the **same** message ID until acknowledged.

## Install on the Gateway machine

From this source package:

```sh
npm install
npm test
npm pack
openclaw plugins install ./openclaw-plugin-message-relay-0.1.1.tgz
```

The release tarball must be produced from this directory; do not install a source tree that lacks compiled `dist/` output. Follow OpenClaw's pairing/approval prompts. The Gateway machine must remain available to accept and process messages. The database lives under the Gateway state directory at `message-relay/messages.sqlite`, separate from OpenClaw's core database.

By default, any **paired operator device** with the required read/write scopes may use the plugin, but devices are isolated by their Gateway-verified device IDs. Owners who want an additional allowlist can set `plugins.entries.message-relay.config.allowedDeviceIds` to an array of approved 64-hex device IDs. `agentId` defaults to `main` and can be set in the same config object. Install/configure on the host; the phone should not receive a Gateway admin token.

## Client integration

Connect through the ordinary authenticated Gateway WebSocket with signed device pairing and `operator.read`/`operator.write`. First call `message-relay.capabilities` to detect the plugin. Then:

1. Persist `{conversationId, messageId, text}` in the phone's outbox.
2. Call `message-relay.send`. A successful response means the Gateway committed it to SQLite. Only then clear the local outbox entry.
3. Call `message-relay.sync` with the last saved cursor, persist each returned change, and repeat while `hasMore` is true. Upsert by `messageId`: several changes may refer to the same message.
4. On reconnect, repeat pending sends with their **original** IDs and continue sync from the last persisted cursor.

See [the wire contract](docs/PROTOCOL.md) for request and response examples. This version provides private Gateway RPC methods, not an HTTP API. If a public-facing route is needed later, add a narrow authenticated surface; do not expose the raw administrative Gateway merely for this plugin.

## Development

`npm test` builds and runs focused Node tests for idempotency, device isolation, event cursors, ordering, recovery, and run-bound replies. The package expects Node 24+ and OpenClaw 2026.9.5+. It uses no runtime npm dependencies besides OpenClaw's plugin SDK and Node's built-in SQLite.

MIT licensed. The plugin contains no client branding or owner-specific endpoint.
