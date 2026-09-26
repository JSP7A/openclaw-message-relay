# Message Relay 0.1.1

Message Relay lets third-party OpenClaw messaging clients submit text durably and sync replies after disconnects. It runs on the Gateway host and uses the host's paired-device authentication. It does not create a Tailscale/Cloudflare tunnel or expose an HTTP endpoint.

This patch release adds the build metadata required for ClawHub publication and refreshes early-release wording. Messaging runtime behavior is unchanged from 0.1.0.

Validated with eight local tests, ClawHub's package validator, and an isolated OpenClaw `npm-pack:` install that loaded all three Gateway methods. The 0.1.0 implementation completed a paired iPhone 18 Pro simulator send/sync/reply round trip against one live Gateway. It has not been live-tested on a second Gateway or physical phone.

Download `openclaw-plugin-message-relay-0.1.1.tgz`, then run `openclaw plugins install ./openclaw-plugin-message-relay-0.1.1.tgz` on the Gateway host. See `README.md` and `docs/PROTOCOL.md` before integrating a client.

SHA-256 of release archive: 102665b859afdde3e890953f73a5503e7ea7fed2b1546adf7791dc237f6ccd79
