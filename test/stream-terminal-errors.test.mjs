import test from 'node:test';
import assert from 'node:assert/strict';
import { streamSSE } from '../src/stream-http.mjs';
import { DotLive } from '../src/live.mjs';
import { DotError } from '../src/errors.mjs';

const authLoader = async () => ({ accountId: 'account', userId: 'user', accessToken: 'synthetic-token' });
const client = { transport: { authLoader } };
const challenge = '<script src="/cdn-cgi/challenge-platform/test"></script>';

for (const tail of ['error-record', 'throw', 'pending']) {
  test(`a complete challenge error body terminates before a ${tail} tail`, { timeout: 1000 }, async () => {
    let reads = 0, closed = 0, sleeps = 0;
    const live = new DotLive(client, { sleep: async () => { sleeps++; throw new Error('unexpected reconnect'); },
      streamRequest: (t, m, r, options) => streamSSE(t, m, r, { ...options, streamImpl: async function* () {
        try {
          yield { type: 'response', status: 503, headers: { 'content-type': 'text/html' } };
          yield { type: 'error-body', body: Buffer.from(challenge).toString('base64') };
          reads++;
          if (tail === 'error-record') yield { type: 'error' };
          else if (tail === 'throw') throw new Error('broken pipe');
          else await new Promise(() => {});
        } finally { closed++; }
      } }) });
    await assert.rejects(live.activity({ dotId: 'dot' }), { code: 'EDGE_CHALLENGE' });
    assert.equal(reads, 0); assert.equal(closed, 1); assert.equal(sleeps, 0);
  });
}

for (const [status, code] of [[401, 'AUTH_REJECTED'], [403, 'FORBIDDEN'], [503, 'HTTP_ERROR']]) {
  for (const tail of ['error-record', 'throw']) {
    test(`HTTP ${status} survives a ${tail} before its error body`, async () => {
      await assert.rejects(streamSSE({ authLoader }, 'GET', '/backend-api/test', { streamImpl: async function* () {
        yield { type: 'response', status, headers: { 'content-type': 'application/json' } };
        if (tail === 'error-record') yield { type: 'error' };
        else throw new Error('broken bridge');
      } }), error => error.code === code && error.details.status === status);
    });
  }
}

test('a known HTTP rejection does not override a stronger typed protocol failure', async () => {
  const failure = new DotError('INVALID_STREAM', 'invalid frame');
  await assert.rejects(streamSSE({ authLoader }, 'GET', '/backend-api/test', { streamImpl: async function* () {
    yield { type: 'response', status: 503, headers: {} };
    throw failure;
  } }), error => error === failure);
});

test('explicit abort reason wins over known HTTP status', async () => {
  const controller = new AbortController(), reason = new Error('cancelled by caller');
  await assert.rejects(streamSSE({ authLoader }, 'GET', '/backend-api/test', { signal: controller.signal, streamImpl: async function* () {
    yield { type: 'response', status: 401, headers: {} };
    controller.abort(reason);
    yield { type: 'error' };
  } }), error => error === reason);
});


test('a complete body challenge survives iterator cleanup failure', async () => {
  let closed = 0;
  await assert.rejects(streamSSE({ authLoader }, 'GET', '/backend-api/test', { streamImpl: async function* () {
    try {
      yield { type: 'response', status: 503, headers: { 'content-type': 'text/html' } };
      yield { type: 'error-body', body: Buffer.from(challenge).toString('base64') };
    } finally { closed++; throw new Error('private cleanup error'); }
  } }), error => error.code === 'EDGE_CHALLENGE' && !error.message.includes('private'));
  assert.equal(closed, 1);
});

for (const [status, code] of [[401, 'AUTH_REJECTED'], [403, 'FORBIDDEN']]) {
  test(`activity never reconnects known HTTP ${status} when its error body fails`, async () => {
    let streams = 0, sleeps = 0;
    const live = new DotLive(client, { sleep: async () => { sleeps++; throw new Error('must not reconnect'); },
      streamRequest: (t, m, r, options) => streamSSE(t, m, r, { ...options, streamImpl: async function* () {
        streams++;
        yield { type: 'response', status, headers: { 'content-type': 'application/json' } };
        yield { type: 'error' };
      } }) });
    await assert.rejects(live.activity({ dotId: 'dot' }), { code });
    assert.equal(streams, 1); assert.equal(sleeps, 0);
  });
}
