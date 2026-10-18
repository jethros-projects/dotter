import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { FullDotClient } from '../src/advanced.mjs';
import { run } from '../src/cli.mjs';

const key = 'b3dba593-d81e-45f7-9cbd-eb2fca20d692';
const capture = () => ({ text: '', write(value) { this.text += value; } });
function client() {
  const calls = [];
  const value = new FullDotClient({ transport: { request: async (method, route, options) => {
    calls.push({ method, route, options }); return { id: 'accepted-message' };
  } } });
  return { value, calls };
}

test('reply wait has an actual deadline even while a history read ignores cancellation', async () => {
  const { value, calls } = client(); let signal;
  value.historyPages = async options => { signal = options.signal; return new Promise(() => {}); };
  const result = await Promise.race([value.send({ roomId: 'room', text: 'marker', idempotencyKey: key, waitSeconds: 0.025 }), delay(150).then(() => null)]);
  assert.notEqual(result, null, 'wait must complete at its own deadline');
  assert.equal(result.accepted, true); assert.equal(result.messageId, 'accepted-message'); assert.equal(result.idempotencyKey, key);
  assert.equal(result.wait.status, 'timeout'); assert.equal(signal.aborted, true);
  assert.equal(calls.filter(x => x.method === 'POST').length, 1);
});

test('CLI SIGINT during reply wait preserves the accepted receipt and detaches handlers', async () => {
  const signals = new EventEmitter(), stdout = capture(), stderr = capture(); let passed;
  const result = await run(['send', 'marker', '--room', 'room', '--key', key, '--wait', '30'], {
    signals, stdout, stderr, createClient: async () => ({ send: async args => {
      passed = args.signal;
      const interrupted = new Promise(resolve => args.signal?.addEventListener('abort', () => resolve({ accepted: true, messageId: 'accepted-message', idempotencyKey: key, wait: { status: 'interrupted', error: 'INTERRUPTED', messages: [] } }), { once: true }));
      queueMicrotask(() => signals.emit('SIGINT'));
      return Promise.race([interrupted, delay(75).then(() => ({ broken: true }))]);
    } })
  });
  assert.equal(passed?.aborted, true);
  assert.equal(result.accepted, true); assert.equal(JSON.parse(stdout.text).messageId, 'accepted-message');
  assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.match(stderr.text, new RegExp(key));
});

test('external cancellation aborts in-flight polling, retains acceptance and releases listeners', async () => {
  const controller = new AbortController(), { value, calls } = client(); let pollingSignal;
  value.historyPages = async ({ signal }) => {
    pollingSignal = signal;
    queueMicrotask(() => controller.abort());
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  const result = await value.send({ roomId: 'room', text: 'marker', waitSeconds: 30, idempotencyKey: key, signal: controller.signal });
  assert.equal(result.accepted, true); assert.equal(result.wait.status, 'interrupted'); assert.equal(result.wait.error, 'INTERRUPTED');
  assert.equal(pollingSignal.aborted, true); assert.equal(calls.length, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancellation after acceptance but before wait setup retains the receipt without polling', async () => {
  const controller = new AbortController(); let calls = 0, polls = 0;
  const value = new FullDotClient({ transport: { request: async () => { calls++; controller.abort(); return { id: 'accepted-message' }; } } });
  value.historyPages = async () => { polls++; return { messages: [] }; };
  const result = await value.send({ roomId: 'room', text: 'marker', waitSeconds: 30, idempotencyKey: key, signal: controller.signal });
  assert.equal(result.accepted, true); assert.equal(result.wait.status, 'interrupted'); assert.equal(calls, 1); assert.equal(polls, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('primitive cancellation and read-failure reasons cannot discard an accepted receipt', async () => {
  for (const reason of [null, 'cancelled', 42]) {
    const controller = new AbortController();
    const value = new FullDotClient({ transport: { request: async () => { controller.abort(reason); return { id: 'accepted-message' }; } } });
    const result = await value.send({ roomId: 'room', text: 'marker', waitSeconds: 30, signal: controller.signal });
    assert.equal(result.accepted, true); assert.equal(result.wait.status, 'interrupted'); assert.equal(result.wait.error, 'INTERRUPTED');
  }
  const { value } = client(); value.historyPages = async () => { throw null; };
  const result = await value.send({ roomId: 'room', text: 'marker', waitSeconds: 30 });
  assert.equal(result.accepted, true); assert.equal(result.wait.error, 'INTERRUPTED');
});

test('already-cancelled send never submits a message', async () => {
  const controller = new AbortController(); controller.abort(); const { value, calls } = client();
  await assert.rejects(value.send({ roomId: 'room', text: 'marker', waitSeconds: 30, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(calls.length, 0);
});

test('deadline interrupts a real history-page traversal before another page request', async () => {
  let polls = 0, signal, writes = 0;
  const value = new FullDotClient({ transport: { request: async (method, _route, options) => {
    if (method === 'POST') { writes++; return { id: 'accepted-message' }; }
    polls++; signal = options.signal;
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  } } });
  const result = await value.send({ roomId: 'room', text: 'marker', waitSeconds: 0.025 });
  assert.equal(result.wait.status, 'timeout'); assert.equal(signal.aborted, true); assert.equal(polls, 1); assert.equal(writes, 1);
});

test('a late ignored-abort response cannot continue pagination after wait has returned', async () => {
  let release, reads = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const value = new FullDotClient({ transport: { request: async method => {
    if (method === 'POST') return { id: 'accepted-message' };
    reads++;
    return reads === 1 ? gate : { items: [] };
  } } });
  const result = await value.send({ roomId: 'room', text: 'marker', waitSeconds: 0.025 });
  assert.equal(result.wait.status, 'timeout'); assert.equal(reads, 1);
  release({ items: [], next_cursor: 'another-page' });
  await delay(5);
  assert.equal(reads, 1);
});

test('observed replies clear the wait timer and retain explicit temporal semantics', async () => {
  const controller = new AbortController(), { value } = client(); let pollSignal;
  value.historyPages = async ({ signal }) => { pollSignal = signal; return { messages: [{ id: 'reply', role: 'assistant', text: 'Later room message', inProgress: false }] }; };
  const result = await value.send({ roomId: 'room', text: 'marker', waitSeconds: 300, signal: controller.signal });
  assert.equal(result.wait.status, 'observed'); assert.equal(result.wait.correlation, 'messages after accepted send in this room');
  assert.equal(pollSignal.aborted, true); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('CLI SIGTERM and external cancellation detach wait handlers even when send fails', async () => {
  for (const trigger of ['SIGTERM', 'external']) {
    const signals = new EventEmitter(), controller = new AbortController(), stdout = capture(), stderr = capture();
    const work = run(['send', 'marker', '--key', key, '--wait', '30'], { signals, signal: controller.signal, stdout, stderr,
      createClient: async () => ({ send: async ({ signal }) => {
        if (trigger === 'external') controller.abort(); else signals.emit('SIGTERM');
        assert.equal(signal.aborted, true); throw new Error('No receipt was received');
      } }) });
    await assert.rejects(work, /No receipt was received/);
    assert.equal(stdout.text, ''); assert.equal(signals.listenerCount('SIGINT'), 0); assert.equal(signals.listenerCount('SIGTERM'), 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});
