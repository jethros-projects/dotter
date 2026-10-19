import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { bounded, captureCommand, completedMarkerReply, fixtureMessage, replyEvidence, requiredStages, runStatus } from '../scripts/e2e-sdk-checks.mjs';

const passed = () => requiredStages.map(name => ({ name, status: 'passed' }));

test('a live pass requires every declared stage, including file and CLI checks', () => {
  assert.equal(runStatus(passed()), 'passed');
  for (const missing of requiredStages) {
    assert.equal(runStatus(passed().filter(step => step.name !== missing)), 'failed', missing);
    assert.equal(runStatus(passed().map(step => step.name === missing ? { ...step, status: 'skipped' } : step)), 'failed', missing);
  }
  assert.equal(runStatus([{ name: 'sdk.discovery', status: 'blocked' }]), 'blocked');
  assert.equal(runStatus([...passed(), { name: 'runner.unhandled', status: 'failed' }]), 'failed');
  assert.equal(runStatus([{ name: 'sdk.discovery', status: 'blocked' }, { name: 'runner.cleanup', status: 'failed' }]), 'failed');
});

test('fixture proof uses the acknowledged user ID and a completed assistant response', () => {
  const marker = 'UNIQUE_SYNTHETIC_MARKER';
  assert.equal(fixtureMessage({ id: 'owned', role: 'user', text: marker }, 'owned', marker), true);
  assert.equal(fixtureMessage({ id: 'different', role: 'user', text: marker }, 'owned', marker), false);
  assert.equal(fixtureMessage({ id: 'owned', role: 'assistant', text: marker }, 'owned', marker), false);
  const reply = { id: 'reply', role: 'assistant', text: marker, streaming: false };
  assert.equal(completedMarkerReply(reply, marker), true);
  assert.equal(completedMarkerReply({ ...reply, streaming: true }, marker), false);
  assert.equal(completedMarkerReply({ ...reply, streaming: undefined }, marker), false);
  assert.equal(completedMarkerReply({ ...reply, text: 'unrelated' }, marker), false);
});

test('reply evidence distinguishes native parent linkage, absent linkage, and contradictions', () => {
  assert.deepEqual(replyEvidence({ replyToMessageId: 'owned', replyRootMessageId: 'root' }, 'owned'), {
    nativeParents: { replyToMessageId: 'owned', replyRootMessageId: 'root' },
    nativeParentPresent: true, nativeParentMatched: true, correlation: 'native_parent_link_and_unique_marker',
  });
  assert.equal(replyEvidence({ replyRootMessageId: 'owned' }, 'owned').nativeParentMatched, true);
  assert.equal(replyEvidence({ replyToMessageId: null }, 'owned').correlation, 'unique_marker_no_native_parent_link');
  assert.equal(replyEvidence({ replyToMessageId: 'different' }, 'owned').correlation, 'native_parent_mismatch');
});

test('bounded observation settles without waiting for a stalled source and handles late rejection', { timeout: 1000 }, async () => {
  let reject;
  const late = new Promise((_, no) => { reject = no; });
  await assert.rejects(bounded(late, 10), { code: 'TIMEOUT' });
  reject(new Error('late source failure'));
  assert.equal(await bounded(Promise.resolve('ready'), 100), 'ready');
  await assert.rejects(bounded(Promise.reject(Object.assign(new Error(), { code: 'RESYNC_REQUIRED' })), 100), { code: 'RESYNC_REQUIRED' });
});

function child() {
  const process = new EventEmitter();
  process.stdout = new PassThrough(); process.stderr = new PassThrough(); process.killedWith = [];
  process.kill = signal => { process.killedWith.push(signal); return true; };
  return process;
}

test('installed CLI capture preserves split UTF-8 and keeps stderr private', async () => {
  const process = child(), bytes = Buffer.from('{"text":"🌍"}');
  const capture = captureCommand('/fixture/node', ['fixture.mjs'], { spawnImpl(executable, args, options) {
    assert.equal(executable, '/fixture/node'); assert.deepEqual(args, ['fixture.mjs']);
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']); return process;
  } });
  process.stdout.write(bytes.subarray(0, 11)); process.stdout.write(bytes.subarray(11));
  process.stderr.write('PRIVATE_DIAGNOSTIC'); process.emit('close', 0);
  assert.deepEqual(await capture, { exitCode: 0, stdout: bytes.toString('utf8') });
  assert.deepEqual(process.killedWith, []);
});

test('CLI deadline kills the child and settles even when it never emits close', { timeout: 1000 }, async () => {
  const process = child();
  await assert.rejects(captureCommand('/fixture/node', [], { timeoutMs: 10, spawnImpl: () => process }), { code: 'TIMEOUT' });
  assert.deepEqual(process.killedWith, ['SIGKILL']);
  process.emit('close', 0);
});

for (const stream of ['stdout', 'stderr']) {
  test(`CLI ${stream} has a byte bound and cannot expose private data through errors`, async () => {
    const process = child();
    const capture = captureCommand('/fixture/node', [], { maxOutputBytes: 4, spawnImpl: () => process });
    process[stream].write('PRIVATE');
    await assert.rejects(capture, error => error.code === 'OUTPUT_TOO_LARGE' && !error.message.includes('PRIVATE'));
    assert.deepEqual(process.killedWith, ['SIGKILL']);
  });
}

test('CLI startup failures are sanitized', async () => {
  await assert.rejects(captureCommand('/fixture/node', [], { spawnImpl() { throw new Error('PRIVATE_PATH'); } }),
    error => error.code === 'OPERATION_FAILED' && !error.message.includes('PRIVATE'));
});
