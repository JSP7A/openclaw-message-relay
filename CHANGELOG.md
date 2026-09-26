# Changelog

## 0.1.0 — 2026-09-26

Initial release candidate:

- Durable, idempotent text submission through authenticated Gateway RPC.
- Device-scoped conversations and incremental send/reply change sync.
- Restart recovery, run-bound reply attribution, ordered per-conversation dispatch, and bounded worker concurrency.
- Companion protocol documentation and eight focused tests.

Known limitations: no push notifications, attachments, multi-device sharing, automatic pruning, or second-Gateway/physical-phone validation.
