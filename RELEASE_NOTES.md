# Message Relay 0.1.0

Message Relay lets third-party OpenClaw messaging clients submit text durably and sync replies after disconnects. It runs on the Gateway host and uses the host's paired-device authentication. It does not create a Tailscale/Cloudflare tunnel or expose an HTTP endpoint.

Validated with eight local tests and a paired iPhone 18 Pro simulator send/sync/reply round trip against one live Gateway. The exact final archive includes additional queue/concurrency bounds covered by tests; it has not been live-tested on a second Gateway or physical phone.

Download `openclaw-plugin-message-relay-0.1.0.tgz`, then run `openclaw plugins install ./openclaw-plugin-message-relay-0.1.0.tgz` on the Gateway host. See `README.md` and `docs/PROTOCOL.md` before integrating a client.

SHA-256 of release archive: bcf095a83ac7099f05acfde9347bb7492f790eaab0ec6ce03bbb0eea87508fc1
