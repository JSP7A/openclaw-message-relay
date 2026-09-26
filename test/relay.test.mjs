import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageStore } from '../dist/store.js';
import { RelayService, idempotencyKey, replyForRun, sessionKey } from '../dist/relay.js';

const device = 'c'.repeat(64);
const quiet = { warn() {} };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('run-bound reply selection will not substitute an older answer', () => {
  const history = { messages: [
    { role: 'assistant', content: [{ text: 'old' }], __openclaw: { runId: 'old-run' } },
    { role: 'assistant', content: [{ text: 'right' }], __openclaw: { runId: 'new-run' } },
  ] };
  assert.equal(replyForRun(history, 'new-run'), 'right');
  assert.equal(replyForRun(history, 'missing-run'), null);
  assert.notEqual(sessionKey('main', device, 'chat-1'), sessionKey('main', device, 'chat-2'));
  assert.notEqual(idempotencyKey(device, 'message-1'), idempotencyKey('d'.repeat(64), 'message-1'));
});

test('relay dispatches once, records the matching reply, and skips repeated send', async () => {
  const store = new MessageStore(':memory:');
  store.enqueue(device, 'chat-1', 'message-1', 'Hello');
  const calls = [];
  const gateway = async (method, params) => {
    calls.push([method, params]);
    if (method === 'chat.send') return { runId: 'run-1' };
    if (method === 'agent.wait') return { status: 'ok' };
    return { messages: [
      { role: 'assistant', content: [{ text: 'stale' }], __openclaw: { runId: 'old' } },
      { role: 'assistant', content: [{ text: 'Done' }], __openclaw: { runId: 'run-1' } },
    ] };
  };
  const service = new RelayService(store, gateway, 'main', quiet);
  service.pump();
  await tick();
  assert.deepEqual(calls.map(x => x[0]), ['chat.send', 'agent.wait', 'chat.history']);
  assert.equal(calls[0][1].idempotencyKey, idempotencyKey(device, 'message-1'));
  assert.equal(store.sync(device, 'chat-1', 0).changes.at(-1).message.reply, 'Done');
  service.pump();
  await tick();
  assert.equal(calls.length, 3);
  await service.close();
});

test('recovery of an admitted run does not call chat.send again', async () => {
  const store = new MessageStore(':memory:');
  let row = store.enqueue(device, 'chat-1', 'message-1', 'Hello');
  row = store.markAdmitted(row, 'saved-run');
  const calls = [];
  const gateway = async method => {
    calls.push(method);
    if (method === 'agent.wait') return { status: 'ok' };
    if (method === 'chat.history') return { messages: [{ role: 'assistant', text: 'Recovered', __openclaw: { runId: 'saved-run' } }] };
    throw new Error('chat.send must not run');
  };
  const service = new RelayService(store, gateway, 'main', quiet);
  service.pump();
  await tick();
  assert.deepEqual(calls, ['agent.wait', 'chat.history']);
  assert.equal(store.sync(device, 'chat-1', 0).changes.at(-1).message.reply, 'Recovered');
  await service.close();
});

test('transient wait failure is retried without losing the run ID', async () => {
  const store = new MessageStore(':memory:');
  store.enqueue(device, 'chat-1', 'message-1', 'Hello', 100);
  const calls = [];
  const gateway = async method => {
    calls.push(method);
    if (method === 'chat.send') return { runId: 'saved-run' };
    throw new Error('offline');
  };
  const service = new RelayService(store, gateway, 'main', quiet);
  service.pump();
  await tick();
  const state = store.sync(device, 'chat-1', 0).changes.at(-1).message;
  assert.equal(state.status, 'retry');
  assert.equal(state.error, 'Delivery temporarily unavailable');
  assert.deepEqual(calls, ['chat.send', 'agent.wait']);
  await service.close();
});
