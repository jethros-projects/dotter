import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { runChat } from '../src/chat.mjs';
import { DotClient } from '../src/client.mjs';

function harness({ send, watch } = {}) {
  const input = new PassThrough(), output = new PassThrough(), error = new PassThrough();
  let stdout = '', stderr = '', watchOptions;
  const calls = [];
  output.on('data', data => { stdout += data; });
  error.on('data', data => { stderr += data; });
  const client = {
    async send(options) { calls.push(options); return send?.(options); },
    async watch(options) {
      watchOptions = options;
      if (watch) return watch(options);
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
    },
  };
  const promise = runChat(client, { roomId: 'room_test', input, output, error });
  return { input, promise, calls, stdout: () => stdout, stderr: () => stderr, watchOptions: () => watchOptions };
}

test('chat sends only entered message lines and exits on quit', async () => {
  const h = harness();
  h.input.end('/help\n\nHello Dot\n/quit\nDo not send\n');
  assert.deepEqual(await h.promise, { sentCount: 1, reason: 'quit' });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].text, 'Hello Dot');
  assert.deepEqual(h.calls[0].files, []);
  assert.equal(h.calls[0].roomId, 'room_test');
  assert.match(h.calls[0].idempotencyKey, /^[a-f0-9-]{36}$/);
  assert.ok(h.stderr().includes(h.calls[0].idempotencyKey));
  assert.equal(h.watchOptions().signal.aborted, true);
});

test('chat queues attachments for the next explicit message only', async () => {
  const h = harness();
  h.input.end('/attach "report with spaces.pdf"\n/attach image.png\nReview these\nNext message\n');
  assert.deepEqual(await h.promise, { sentCount: 2, reason: 'eof' });
  assert.deepEqual(h.calls[0].files, ['report with spaces.pdf', 'image.png']);
  assert.deepEqual(h.calls[1].files, []);
});

test('chat renders only visible assistant replies and strips terminal controls', async () => {
  const h = harness({ watch: async options => {
    options.onMessage({ role: 'user', text: 'user echo' });
    options.onMessage({ role: 'assistant', channel: 'analysis', text: 'secret thoughts' });
    options.onMessage({ role: 'assistant', metadata: { is_hidden: true }, text: 'hidden' });
    options.onMessage({ role: 'assistant', text: '::SKIP_COMPLETION::' });
    options.onMessage({ role: 'assistant', text: 'Visible\u001b[31m reply', attachments: [{ name: 'result.pdf' }] });
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
  } });
  h.input.end('/quit\n');
  await h.promise;
  assert.ok(h.stdout().includes('Visible[31m reply'));
  assert.ok(h.stdout().includes('[attachment: result.pdf]'));
  assert.doesNotMatch(h.stdout(), /user echo|secret thoughts|SKIP_COMPLETION|hidden|\u001b/);
});

test('chat reports send errors without retrying and prints the key before sending', async () => {
  let h;
  h = harness({ send: async options => {
    assert.ok(h.stderr().includes(options.idempotencyKey));
    throw new Error('Delivery uncertain');
  } });
  h.input.end('/attach report.pdf\nMessage\n/quit\n');
  assert.equal((await h.promise).sentCount, 0);
  assert.equal(h.calls.length, 1);
  assert.match(h.stderr(), /Check history before retrying/);
});

test('watch failure closes idle input and is propagated', async () => {
  const failure = new Error('Watch unavailable');
  const h = harness({ watch: async () => { throw failure; } });
  await assert.rejects(h.promise, failure);
  assert.equal(h.calls.length, 0);
});

test('external cancellation closes chat and the watcher', async () => {
  const input = new PassThrough(), output = new PassThrough(), error = new PassThrough();
  const controller = new AbortController();
  let watchSignal;
  const promise = runChat({
    async send() { assert.fail('Must not send'); },
    async watch({ signal }) {
      watchSignal = signal;
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
  }, { input, output, error, signal: controller.signal });
  await Promise.resolve();
  controller.abort();
  assert.deepEqual(await promise, { sentCount: 0, reason: 'aborted' });
  assert.equal(watchSignal.aborted, true);
});

test('EOF and a queued file alone do not send a message', async () => {
  const h = harness();
  h.input.end('/attach report.pdf\n/attach\n/unknown\n');
  assert.deepEqual(await h.promise, { sentCount: 0, reason: 'eof' });
  assert.equal(h.calls.length, 0);
  assert.match(h.stderr(), /Use \/attach PATH/);
  assert.match(h.stderr(), /Unknown command/);
});

test('chat renders live-shaped Dot member replies but not other human messages', async () => {
  const transport = { async request(method, path) {
    if (path.endsWith('/messages')) return { items: [
      { id: 'human', role: 'user', account_user_id: 'human_member', content: { text: 'HUMAN_TEXT' } },
      { id: 'bot', role: 'user', account_user_id: 'opaque_member', content: { text: 'BOT_MARKER' } },
    ] };
    return { id: 'room_test', type: 'DM', app_source: 'chatgpt:messaging', aeon_id: 'dot', members: [
      { account_user_id: 'human_member', aeon_id: null }, { account_user_id: 'opaque_member', aeon_id: 'dot' },
    ] };
  } };
  const client = new DotClient({ transport });
  let ready;const observed = new Promise(resolve=>{ready=resolve;});
  const h = harness({ watch: async ({ onMessage, signal }) => {
    const batch=await client.history({roomId:'room_test'});for(const item of batch.messages)onMessage(item);ready();
    await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
  } });
  await observed;h.input.end('/quit\n');await h.promise;
  assert.match(h.stdout(),/Dot> BOT_MARKER/);assert.ok(!h.stdout().includes('HUMAN_TEXT'));assert.equal(h.calls.length,0);
});
