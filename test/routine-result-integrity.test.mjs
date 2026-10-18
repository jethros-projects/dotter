import test from 'node:test';
import assert from 'node:assert/strict';
import { DotOperations } from '../src/operations.mjs';

const runKey = '12345678-1234-1234-1234-123456789abc';
const routine = { id: 'routine-1', title: 'Fixture', prompt: 'Fixture only',
  schedule: 'BEGIN:VEVENT\nRRULE:FREQ=DAILY;BYHOUR=9\nEND:VEVENT', default_timezone: 'UTC',
  is_enabled: false, notifications_enabled: false, email_enabled: false, timing_mode: 0, executor: 'cloud' };
function setup(...responses) {
  const calls = [];
  return { calls, ops: new DotOperations({ transport: { async request(...args) { calls.push(args); return responses.shift(); } } }) };
}

test('a malformed accepted-run receipt remains an unknown delivery with the original request key', async () => {
  for (const receipt of [null, {}, { run_id: '' }, { run_id: '   ' }, { run_id: 42 }]) {
    const { ops, calls } = setup(routine, receipt);
    await assert.rejects(ops.runRoutine({ routineId: routine.id, idempotencyKey: runKey }), error =>
      error.code === 'INVALID_RESPONSE' && error.details?.delivery === 'unknown' && error.details?.idempotencyKey === runKey);
    assert.equal(calls.filter(([method]) => method === 'POST').length, 1);
  }
});

test('a routine detail from another ID cannot be used as a mutation preflight', async () => {
  for (const operation of [ops => ops.getRoutine({ routineId: routine.id }),
    ops => ops.updateRoutine({ routineId: routine.id, title: 'Changed' }),
    ops => ops.runRoutine({ routineId: routine.id, idempotencyKey: runKey })]) {
    const { ops, calls } = setup({ ...routine, id: 'another-routine' });
    await assert.rejects(operation(ops), { code: 'INVALID_RESPONSE' });
    assert.equal(calls.filter(([method]) => method === 'POST').length, 0);
  }
});

test('wrong-ID mutation acknowledgements cannot confirm a routine update or status change', async () => {
  for (const [updating, operation] of [[true, ops => ops.updateRoutine({ routineId: routine.id, title: 'Changed' })],
    [false, ops => ops.setRoutineEnabled({ routineId: routine.id, enabled: true })]]) {
    const { ops, calls } = setup(...(updating ? [routine] : []), { ...routine, id: 'another-routine' });
    await assert.rejects(operation(ops), error => error.code === 'INVALID_RESPONSE' && error.details?.delivery === 'unknown');
    assert.equal(calls.filter(([method]) => method === 'POST').length, 1);
  }
});

test('routine result output excludes hidden, analysis, routed, deleted and skip-completion text', async () => {
  for (const flags of [{ hidden: true }, { metadata: { is_hidden: true } }, { channel: 'analysis' },
    { metadata: { channel: 'analysis' } }, { recipient: 'python' }, { metadata: { recipient: 'python' } },
    { deleted_at: '2026-10-18T00:00:00Z' }, { metadata: { deleted_at: '2026-10-18T00:00:00Z' } }]) {
    const { ops } = setup({ run: { id: 'run-1', status: 'completed' }, latest_update: { content_text: 'PRIVATE-FIXTURE', ...flags } });
    assert.ok(!JSON.stringify(await ops.routineRun({ routineId: routine.id, runId: 'run-1' })).includes('PRIVATE-FIXTURE'));
  }
  const { ops } = setup({ run: { id: 'run-1', status: 'completed' }, latest_update: { content_text: '\n ::SKIP_COMPLETION::\n' } });
  assert.equal((await ops.routineRun({ routineId: routine.id, runId: 'run-1' })).latest_update?.content_text, undefined);
});

test('hidden or deleted parent runs suppress both run identifiers and visible-looking child text', async () => {
  for (const flags of [{ hidden: true }, { is_hidden: true }, { metadata: { is_visually_hidden_from_conversation: true } },
    { deleted_at: '2026-10-18T00:00:00Z' }, { metadata: { deleted_at: '2026-10-18T00:00:00Z' } }]) {
    const run = { id: 'PRIVATE-RUN', status: 'completed', ...flags };
    for (const response of [{ run, latest_update: { content_text: 'PRIVATE-CHILD' } },
      { last_run: run, latest_update: { run, latest_update: { content_text: 'PRIVATE-CHILD' } } }]) {
      const { ops } = setup(response);
      const result = await ops.routineRun({ routineId: routine.id, runId: 'PRIVATE-RUN' });
      assert.ok(!JSON.stringify(result).includes('PRIVATE-'));
    }
  }
});

test('run history omits hidden and deleted records while preserving visible native metadata', async () => {
  const { ops } = setup({ runs: [
    { id: 'visible', status: 'completed', chat_ref: { type: 'chatgpt', id: 'visible-chat' } },
    { id: 'hidden', hidden: true }, { id: 'deleted', deleted_at: '2026-10-18T00:00:00Z' },
    { id: 'nested-hidden', metadata: { is_hidden: true } }, { id: 'nested-deleted', metadata: { deleted_at: '2026-10-18T00:00:00Z' } }
  ], cursor: 'next' });
  assert.deepEqual(await ops.routineRuns({ routineId: routine.id }), {
    runs: [{ id: 'visible', status: 'completed', chat_ref: { type: 'chatgpt', id: 'visible-chat' } }], cursor: 'next'
  });
});

test('an explicit routine result cannot substitute another run identity', async () => {
  for (const response of [
    { run: { id: 'other-run' }, latest_update: { content_text: 'WRONG-RUN' } },
    { latest_update: { run: { id: 'other-run' }, latest_update: { content_text: 'WRONG-RUN' } } },
    { run: { status: 'completed' }, latest_update: { content_text: 'UNIDENTIFIED-RUN' } }
  ]) {
    const { ops } = setup(response);
    await assert.rejects(ops.routineRun({ routineId: routine.id, runId: 'wanted-run' }), { code: 'INVALID_RESPONSE' });
  }
});

test('matching explicit results and flexible latest envelopes retain their separate last run', async () => {
  const response = { last_run: { id: 'last-run', status: 'completed' }, latest_update: {
    run: { id: 'wanted-run', status: 'completed' }, latest_update: { content_text: 'Visible result' }
  } };
  const { ops } = setup(response, response);
  const wanted = await ops.routineRun({ routineId: routine.id, runId: 'wanted-run' });
  assert.equal(wanted.latest_update.run.id, 'wanted-run');
  assert.equal(wanted.last_run.id, 'last-run');
  assert.deepEqual(await ops.routineRun({ routineId: routine.id }), wanted);
});
