import test from 'node:test';
import assert from 'node:assert/strict';
import { DotChannels } from '../src/channels.mjs';
import { DotError } from '../src/errors.mjs';

const key = 'e568d874-413c-4d4f-96f7-69d80b868e6a';
const options = { narrow_email_enabled: true, available_domains: ['chatgpt.email'], default_domain: 'chatgpt.email', inboxes: [] };
const linked = { status: 'linked', inbox_id: 'inbox_1', email_address: 'person@chatgpt.email', narrow_email_consent_version: 1 };
const errorCode = code => error => error.code === code;
function setup(...responses) {
  const calls = [], primaryCalls = [];
  const client = { primary: async opts => { primaryCalls.push(opts); return { id: 'account~dot' }; }, transport: {
    request: async (...args) => { calls.push(args); const next = responses.shift(); if (next instanceof Error) throw next; return next; }
  } };
  return { channels: new DotChannels(client), calls, primaryCalls, client };
}

test('channel client requires a Dot transport and primary resolver', () => {
  assert.throws(() => new DotChannels({}), TypeError);
});

test('email status defaults to primary Dot and exposes only display fields', async () => {
  const { channels, calls, primaryCalls } = setup({ ...linked, access_token: 'secret', credentials: { password: 'secret' } });
  const signal = new AbortController().signal;
  assert.deepEqual(await channels.emailStatus({ signal }), linked);
  assert.deepEqual(calls, [['GET', '/backend-api/tbo/account~dot/channels/email', { signal }]]);
  assert.equal(primaryCalls.length, 1);
});

test('email options project safe fields and filter invalid domains', async () => {
  const data = { ...options, auto_allocate_work_address: false, suggested_email_address: null,
    available_domains: ['chatgpt.email', 'https://evil.test', { host: 'bad' }],
    current_claim: { ...linked, token: 'secret' }, inboxes: [{ ...linked, refresh_token: 'secret' }], auth: 'secret' };
  const { channels, calls, primaryCalls } = setup(data);
  assert.deepEqual(await channels.emailOptions({ dotId: 'explicit:dot' }), {
    ...options, auto_allocate_work_address: false, suggested_email_address: null,
    current_claim: linked, inboxes: [linked]
  });
  assert.equal(calls[0][1], '/backend-api/tbo/explicit:dot/channels/email/options');
  assert.equal(primaryCalls.length, 0);
});

test('invalid identifiers and unavailable primary cannot form requests', async () => {
  const { channels, calls, client } = setup();
  for (const dotId of ['..', '.', 'foo/bar', 'foo%2fbar', 'foo?bar', 'foo#bar', 'foo\\bar']) {
    await assert.rejects(channels.emailStatus({ dotId }), errorCode('INVALID_ARGUMENT'));
  }
  client.primary = async () => ({});
  await assert.rejects(channels.emailStatus(), errorCode('DOT_UNAVAILABLE'));
  assert.equal(calls.length, 0);
});

test('malformed email status and options responses fail closed', async () => {
  for (const data of [null, [], {}, { status: 'mystery' }]) {
    const { channels } = setup(data);
    await assert.rejects(channels.emailStatus(), errorCode('INVALID_RESPONSE'));
  }
  for (const data of [null, [], {}, { ...options, narrow_email_enabled: undefined }, { ...options, inboxes: {} }]) {
    const { channels } = setup(data);
    await assert.rejects(channels.emailOptions(), errorCode('INVALID_RESPONSE'));
  }
});

test('claim and link require deliberate boolean consent before any read or mutation', async () => {
  const { channels, calls, primaryCalls } = setup();
  for (const acceptedConsent of [undefined, false, 'true', 1]) {
    await assert.rejects(channels.claimEmail({ localPart: 'person', domain: 'chatgpt.email', acceptedConsent }), errorCode('EMAIL_CONSENT_REQUIRED'));
    await assert.rejects(channels.linkEmail({ inboxId: 'inbox_1', acceptedConsent }), errorCode('EMAIL_CONSENT_REQUIRED'));
  }
  assert.equal(calls.length, 0);
  assert.equal(primaryCalls.length, 0);
});

test('claim validates complete email syntax before any requests', async () => {
  const { channels, calls } = setup();
  for (const localPart of ['', '.person', 'person.', 'per..son', 'PERSON', 'per@son', 'person\n', 'a'.repeat(65)]) {
    await assert.rejects(channels.claimEmail({ localPart, domain: 'chatgpt.email', acceptedConsent: true }), errorCode('INVALID_ARGUMENT'));
  }
  for (const domain of ['', '.chatgpt.email', 'chatgpt.email.', 'chatgpt', '-chatgpt.email', 'https://chatgpt.email', 'ChatGPT.email', 'chatgpt.email\n']) {
    await assert.rejects(channels.claimEmail({ localPart: 'person', domain, acceptedConsent: true }), errorCode('INVALID_ARGUMENT'));
  }
  assert.equal(calls.length, 0);
});

test('claim preflights eligibility and sends exact consent version', async () => {
  const { channels, calls, primaryCalls } = setup(options, { ...linked, credential: 'secret' });
  const signal = new AbortController().signal;
  assert.deepEqual(await channels.claimEmail({ localPart: 'person', domain: 'chatgpt.email', acceptedConsent: true, signal }), linked);
  assert.equal(primaryCalls.length, 1);
  assert.deepEqual(calls[1], ['POST', '/backend-api/tbo/account~dot/channels/email/claim', {
    body: { local_part: 'person', domain: 'chatgpt.email', narrow_email_consent_version: 1 }, signal
  }]);
});

test('disabled setup and unavailable domain never perform a claim', async () => {
  for (const [data, code] of [[{ ...options, narrow_email_enabled: false }, 'EMAIL_UNAVAILABLE'], [options, 'EMAIL_DOMAIN_UNAVAILABLE']]) {
    const { channels, calls } = setup(data);
    await assert.rejects(channels.claimEmail({ localPart: 'person', domain: 'elsewhere.email', acceptedConsent: true }), errorCode(code));
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'GET');
  }
});

test('custom handles enforce 30 characters after resolving available options', async () => {
  const { channels, calls } = setup(options);
  await assert.rejects(channels.claimEmail({ localPart: 'a'.repeat(31), domain: 'chatgpt.email', acceptedConsent: true }), errorCode('INVALID_ARGUMENT'));
  assert.equal(calls.length, 1);
});

test('fixed current claim and suggested work addresses cannot be overridden', async () => {
  for (const data of [{ ...options, current_claim: linked }, { ...options, auto_allocate_work_address: true, suggested_email_address: linked.email_address }]) {
    const { channels, calls } = setup(data);
    await assert.rejects(channels.claimEmail({ localPart: 'other', domain: 'chatgpt.email', acceptedConsent: true }), errorCode('EMAIL_ADDRESS_FIXED'));
    assert.equal(calls.length, 1);
  }
});

test('fixed addresses may be reclaimed even when their domain is absent from available domains', async () => {
  const { channels, calls } = setup({ ...options, available_domains: [], current_claim: linked }, linked);
  assert.deepEqual(await channels.claimEmail({ localPart: 'person', domain: 'chatgpt.email', acceptedConsent: true }), linked);
  assert.equal(calls[1][0], 'POST');
});

test('link validates owned inbox and sends exact PUT contract', async () => {
  const { channels, calls } = setup({ ...options, inboxes: [linked] }, linked);
  await channels.linkEmail({ dotId: 'dot_1', inboxId: 'inbox_1', acceptedConsent: true });
  assert.deepEqual(calls[1], ['PUT', '/backend-api/tbo/dot_1/channels/email', {
    body: { inbox_id: 'inbox_1', narrow_email_consent_version: 1 }, signal: undefined
  }]);
});

test('link can renew consent for an already linked inbox', async () => {
  const { channels, calls } = setup(options, { ...linked, narrow_email_consent_version: 0 }, linked);
  await channels.linkEmail({ inboxId: 'inbox_1', acceptedConsent: true });
  assert.deepEqual(calls.map(call => call[0]), ['GET', 'GET', 'PUT']);
});

test('unowned inboxes are rejected and never linked', async () => {
  const { channels, calls } = setup(options, { status: 'unlinked' });
  await assert.rejects(channels.linkEmail({ inboxId: 'unknown', acceptedConsent: true }), errorCode('EMAIL_INBOX_UNAVAILABLE'));
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call[0] === 'GET'));
  await assert.rejects(channels.linkEmail({ inboxId: '../foo', acceptedConsent: true }), errorCode('INVALID_ARGUMENT'));
  assert.equal(calls.length, 2);
});

test('remove detaches the email channel without exposing response fields', async () => {
  const { channels, calls } = setup({ completed: true, secret: 'secret' });
  assert.deepEqual(await channels.removeEmail({ dotId: 'dot_1' }), { status: 'unlinked', dotId: 'dot_1' });
  assert.deepEqual(calls, [['DELETE', '/backend-api/tbo/dot_1/channels/email', { signal: undefined }]]);
});

test('meeting invitation uses normalized Google Meet URL and persistent UUID key', async () => {
  const { channels, calls } = setup({ id: 'session_1', status: 'pending', access_token: 'secret', join_credentials: { token: 'secret' } });
  const result = await channels.startMeeting({ dotId: 'dot_1', meetingUrl: ' https://meet.google.com/abc-defg-hij/?authuser=1 ', idempotencyKey: key });
  assert.deepEqual(calls, [['POST', '/backend-api/tbo/dot_1/meeting-sessions', {
    body: { meeting_url: 'https://meet.google.com/abc-defg-hij' }, headers: { 'Idempotency-Key': key }, idempotencyKey: key, signal: undefined
  }]]);
  assert.deepEqual(result, { status: 'accepted', dotId: 'dot_1', meetingUrl: 'https://meet.google.com/abc-defg-hij', idempotencyKey: key,
    session: { id: 'session_1', status: 'pending' } });
});

test('meeting shorthand and implicit key follow the native UI contract', async () => {
  const { channels, calls } = setup({}, {});
  for (const meetingUrl of ['abc-defg-hij', 'meet.google.com/abc-defg-hij']) {
    const result = await channels.startMeeting({ meetingUrl });
    assert.match(result.idempotencyKey, /^[0-9a-f-]{36}$/);
    assert.equal(result.meetingUrl, 'https://meet.google.com/abc-defg-hij');
  }
  assert.notEqual(calls[0][2].idempotencyKey, calls[1][2].idempotencyKey);
});

test('meeting rejects unsupported URLs and malformed keys before API calls', async () => {
  const { channels, calls, primaryCalls } = setup();
  for (const meetingUrl of ['', 'http://meet.google.com/abc-defg-hij', 'https://zoom.us/abc-defg-hij', 'https://meet.google.com.evil/abc-defg-hij',
    'https://user:pass@meet.google.com/abc-defg-hij', 'https://meet.google.com/abc-defg-hij#secret', 'abc-defg-hij/other', 'https://meet.google.com/ABC-DEFG-HIJ']) {
    await assert.rejects(channels.startMeeting({ meetingUrl }), errorCode('INVALID_ARGUMENT'));
  }
  await assert.rejects(channels.startMeeting({ meetingUrl: 'abc-defg-hij', idempotencyKey: 'bad-key' }), errorCode('INVALID_ARGUMENT'));
  assert.equal(calls.length, 0);
  assert.equal(primaryCalls.length, 0);
});

test('mutation failures are passed through exactly once without retry', async () => {
  const failure = new DotError('NETWORK_ERROR', 'Unknown delivery', { delivery: 'unknown', idempotencyKey: key });
  const { channels, calls } = setup(failure);
  await assert.rejects(channels.startMeeting({ meetingUrl: 'abc-defg-hij', idempotencyKey: key }), error => error === failure);
  assert.equal(calls.length, 1);
  const email = setup(options, failure);
  await assert.rejects(email.channels.claimEmail({ localPart: 'person', domain: 'chatgpt.email', acceptedConsent: true }), error => error === failure);
  assert.equal(email.calls.length, 2);
});

test('malformed successful mutation responses retain uncertain delivery', async () => {
  const meeting = setup(null);
  await assert.rejects(meeting.channels.startMeeting({ meetingUrl: 'abc-defg-hij', idempotencyKey: key }), error =>
    error.code === 'INVALID_RESPONSE' && error.details.delivery === 'unknown' && error.details.idempotencyKey === key);
  assert.equal(meeting.calls.length, 1);
  const email = setup(options, {});
  await assert.rejects(email.channels.claimEmail({ localPart: 'person', domain: 'chatgpt.email', acceptedConsent: true }), error =>
    error.code === 'INVALID_RESPONSE' && error.details.delivery === 'unknown');
  assert.equal(email.calls.length, 2);
});
