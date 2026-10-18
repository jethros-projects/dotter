import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.mjs';
import { FullDotClient } from '../src/advanced.mjs';
import { Transport } from '../src/transport.mjs';
import { normalizeActivity } from '../src/live.mjs';

const buffer = () => ({ text: '', write(value) { this.text += value; } });
const uuid = '11111111-1111-4111-8111-111111111111';

test('CLI voice allocation travels through actual raw transport and exposes the SDP result', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dot-v3-integration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sdpFile = join(directory, 'offer.sdp'); await writeFile(sdpFile, 'v=0\r\ns=offer\r\n');
  let calls = 0;
  const transport = new Transport({ authLoader: async () => ({ accountId: 'account_1', accessToken: 'test-access' }),
    fetchImpl: async (url, options) => {
      calls++; assert.equal(url.pathname, '/backend-api/tbo/dot_1/voice/calls');
      assert.equal(JSON.parse(options.body).sdp, 'v=0\r\ns=offer\r\n');
      return new Response('v=0\r\ns=answer\r\n', { status: 201, headers: { location: '/backend-api/tbo/dot_1/voice/calls/rtc_test', 'openai-root-thread-id': 'thread_1' } });
    } });
  const stdout = buffer();
  await run(['voice','allocate','--dot','dot_1','--root-thread','thread_1','--sdp-file',sdpFile], {
    createClient: async () => new FullDotClient({ transport }), stdout, stderr: buffer()
  });
  assert.equal(calls, 1);
  assert.equal(JSON.parse(stdout.text).answer, 'v=0\r\ns=answer\r\n');
  assert(!stdout.text.includes('test-access'));
});

test('CLI meeting start passes the UUID HTTP header and prints only the safe acknowledgment', async () => {
  let calls = 0;
  const transport = new Transport({ authLoader: async () => ({ accountId: 'account_1', accessToken: 'test-access' }),
    fetchImpl: async (url, options) => {
      calls++; assert.equal(url.pathname, '/backend-api/tbo/dot_1/meeting-sessions');
      assert.equal(options.headers['Idempotency-Key'], uuid);
      assert.deepEqual(JSON.parse(options.body), { meeting_url: 'https://meet.google.com/abc-defg-hij' });
      return Response.json({ id: 'meeting_1', status: 'pending', token: 'private' });
    } });
  const stdout = buffer(), stderr = buffer();
  await run(['meeting','start','abc-defg-hij','--dot','dot_1','--key',uuid], {
    createClient: async () => new FullDotClient({ transport }), stdout, stderr
  });
  assert.equal(calls, 1); assert.match(stderr.text, new RegExp(uuid));
  assert.equal(JSON.parse(stdout.text).status, 'accepted'); assert(!stdout.text.includes('private'));
});

test('CLI sends task, Page context and preuploaded file references with one message request', async () => {
  let calls = 0;
  const client = new FullDotClient({ transport: { async request(method, route, options) {
    calls++; assert.equal(method, 'POST'); assert.equal(route, '/backend-api/messaging/rooms/room_1/messages');
    assert.equal(options.body.task_id, 'task_1'); assert.deepEqual(options.body.page_context, { page_id: 'page_1' });
    assert.deepEqual(options.body.content.attachments, [{ type: 'file', file_id: 'file_1' }]);
    return { id: 'message_1' };
  } } });
  await run(['send','Hello','--room','room_1','--task','task_1','--page','page_1','--attachment-id','file_1','--key',uuid], {
    createClient: async () => client, stdout: buffer(), stderr: buffer()
  });
  assert.equal(calls, 1);
});

test('activity previews never expose analysis, tool recipients, deleted records or placeholders', async () => {
  for (const unsafe of [{ channel: 'analysis' }, { metadata: { channel: 'analysis' } }, { recipient: 'tool' }, { metadata: { recipient: 'tool' } }, { deleted_at: '2026-01-01' }]) {
    assert.equal(normalizeActivity({ thread_id: 't1', ...unsafe }), null);
    assert.equal(normalizeActivity({ thread_id: 't1', preview: { text: 'hidden', ...unsafe } }).preview, null);
  }
  assert.equal(normalizeActivity({ thread_id: 't1', preview: { text: ' ::SKIP_COMPLETION:: ' } }).preview, null);
  const c = new FullDotClient({ transport: { request: async () => ({ data: [
    { thread_id: 'hidden', channel: 'analysis', title: 'private' },
    { thread_id: 'visible', preview: { text: 'private', recipient: 'tool' } }
  ] }) } });
  const result = await c.lifecycle.activity({ dotId: 'dot_1' });
  assert.equal(result.data.length, 1);
  assert(!JSON.stringify(result).includes('private'));
});
