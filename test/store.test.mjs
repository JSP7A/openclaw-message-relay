import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageStore } from '../dist/store.js';

const a = 'a'.repeat(64);
const b = 'b'.repeat(64);

test('send is durable, idempotent, and rejects conflicting message IDs', () => {
  const store = new MessageStore(':memory:');
  const first = store.enqueue(a, 'chat-1', 'message-1', 'Hello', 100);
  assert.equal(first.status, 'queued');
  assert.equal(store.enqueue(a, 'chat-1', 'message-1', 'Hello', 101).seq, first.seq);
  assert.throws(() => store.enqueue(a, 'chat-1', 'message-1', 'Different', 102), /already used/);
  assert.throws(() => store.enqueue(a, 'chat-2', 'message-1', 'Hello', 102), /already used/);
  assert.notEqual(store.enqueue(b, 'chat-1', 'message-1', 'Private', 103).seq, first.seq);
  assert.deepEqual(store.sync(a, 'chat-1', 0).changes.map(x => x.message.text), ['Hello']);
  assert.deepEqual(store.sync(b, 'chat-1', 0).changes.map(x => x.message.text), ['Private']);
  store.close();
});

test('sync emits late status and reply changes after the original cursor', () => {
  const store = new MessageStore(':memory:');
  let row = store.enqueue(a, 'chat-1', 'message-1', 'Hello', 100);
  const first = store.sync(a, 'chat-1', 0);
  assert.equal(first.changes[0].message.status, 'queued');
  row = store.markAdmitted(row, 'run-1', 101);
  store.markDone(row, 'Hello back', 102);
  const later = store.sync(a, 'chat-1', first.nextCursor);
  assert.equal(later.changes.length, 2);
  assert.equal(later.changes.at(-1).message.reply, 'Hello back');
  assert.equal(later.changes.at(-1).message.status, 'done');
  assert.equal(store.sync(a, 'chat-1', later.nextCursor).changes.length, 0);
  store.close();
});

test('pagination and per-conversation ordering preserve recovery work', () => {
  const store = new MessageStore(':memory:');
  let first = store.enqueue(a, 'chat-1', 'message-1', 'One', 100);
  store.enqueue(a, 'chat-1', 'message-2', 'Two', 101);
  store.enqueue(a, 'chat-2', 'message-3', 'Other', 102);
  assert.deepEqual(store.work(50, 103).map(x => x.message_id), ['message-1', 'message-3']);
  first = store.markRetry(first, 200);
  assert.deepEqual(store.work(50, 201).map(x => x.message_id), ['message-3']);
  assert.deepEqual(store.work(50, first.next_attempt_at).map(x => x.message_id), ['message-1', 'message-3']);
  store.markFailed(first, 'failed', 500);
  assert.deepEqual(store.work(50, 501).map(x => x.message_id), ['message-2', 'message-3']);
  const page = store.sync(a, 'chat-1', 0, 1);
  assert.equal(page.hasMore, true);
  assert.equal(store.sync(a, 'chat-1', page.nextCursor, 1).changes.length, 1);
  store.close();
});

test('a device outbox is bounded without breaking duplicate acknowledgements', () => {
  const store = new MessageStore(':memory:');
  for (let n = 0; n < MessageStore.maxPendingPerDevice; n++) {
    store.enqueue(a, 'chat-1', `message-${n}`, 'Hello');
  }
  assert.throws(() => store.enqueue(a, 'chat-1', 'one-too-many', 'Hello'), /outbox is full/);
  assert.equal(store.enqueue(a, 'chat-1', 'message-0', 'Hello').message_id, 'message-0');
  store.close();
});
