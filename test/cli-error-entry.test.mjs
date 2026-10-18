import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const entrypoint = fileURLToPath(new URL('../bin/dotter.mjs', import.meta.url));
const httpHelper = fileURLToPath(new URL('../src/http.py', import.meta.url));
const advancedURL = new URL('../src/advanced.mjs', import.meta.url).href;
const accountId = 'synthetic-entry-account';
const token = 'synthetic-entry-token';
const roomId = 'synthetic_entry_room';
const key = 'a9c1e164-089b-44f7-9d7c-dc4dd2790123';
const secret = 'private-diagnostic-must-not-be-printed';

// Exercise the actual executable, parser, auth loader, request serialization,
// transport error classification and final process exit. Only the python3
// executable is replaced; it cannot contact a service. Use CommonJS for the
// extensionless executable so this also works with Node 22.0.
async function cli(t, args, {
  json = false, auth = 'valid', helper = true,
  status = 200, headers = { 'content-type': 'application/json' },
  value = {}, raw, envelope, unexpected = false, literal,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dot-cli-error-entry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const authFile = join(directory, 'auth.json');
  const logFile = join(directory, 'requests.ndjson');
  const executable = join(directory, 'python3');
  if (auth !== 'missing') {
    const authData = auth === 'invalid' ? '{not JSON'
      : JSON.stringify(auth === 'api-key' ? { auth_mode: 'apikey', OPENAI_API_KEY: secret }
        : { auth_mode: 'chatgpt', tokens: { account_id: accountId, access_token: token } });
    await writeFile(authFile, authData, { mode: 0o600 });
  }
  if (helper) {
    const reply = envelope ?? { status, headers, body: Buffer.from(raw ?? JSON.stringify(value)).toString('base64') };
    await writeFile(executable, `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
const request = JSON.parse(readFileSync(0, 'utf8'));
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify({ args: process.argv.slice(2), request }) + '\\n', { mode: 0o600 });
process.stdout.write(${JSON.stringify(JSON.stringify(reply))});
`, { mode: 0o700 });
    await chmod(executable, 0o700);
  }
  const nodeArgs = [];
  if (unexpected) {
    // Fault injection belongs solely to the unknown-error presentation test.
    // No production defect is inferred: simulate an unforeseen SDK exception
    // at the normal command boundary, without replacing the executable/run().
    const preload = join(directory, 'unexpected.mjs');
    await writeFile(preload, `import { FullDotClient } from ${JSON.stringify(advancedURL)};
FullDotClient.prototype.primary = async function () {
  const error = new Error(${JSON.stringify(`\x1b[31m${secret}\x1b[0m\n${token}`)});
  error.code = 'AUTH_SERVER_SECRET';
  error.details = { authorization: ${JSON.stringify(token)} };
  throw error;
};
`, { mode: 0o600 });
    nodeArgs.push('--import', preload);
  }
  nodeArgs.push(entrypoint, ...args, '--auth-file', authFile, ...(json ? ['--json'] : []), ...(literal ? ['--', ...literal] : []));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArgs, {
      cwd: directory,
      env: { PATH: directory, LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr, authFile }));
  });
  assert.equal(result.signal, null, 'the CLI must finish without a timeout or signal');
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${secret}|${token}|${accountId}`));
  let calls = [];
  try { calls = (await readFile(logFile, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...result, calls };
}

function outputError(result, { code, exit, message, json, details = {}, prefix = '' }) {
  assert.equal(result.code, exit);
  if (json) {
    assert.deepEqual(JSON.parse(result.stdout), { error: { code, message, ...details } });
    assert.equal(result.stderr, prefix, 'JSON error output has no human error or stack');
  } else {
    assert.equal(result.stdout, '', 'human errors do not pollute stdout');
    assert.equal(result.stderr, `${prefix}Dotter: ${message}\n`);
  }
}

function oneRead(result) {
  assert.equal(result.calls.length, 1, 'an error must not cause an automatic retry');
  const { args, request } = result.calls[0];
  assert.deepEqual(args, ['-I', httpHelper]);
  assert.equal(request.method, 'GET');
  assert.equal(request.url, 'https://chatgpt.com/backend-api/tbo/primary');
  assert.equal(request.headers.Authorization, `Bearer ${token}`);
  assert.equal(request.headers['ChatGPT-Account-Id'], accountId);
}

for (const json of [false, true]) {
  const mode = json ? 'JSON' : 'human';
  test(`binary CLI presents usage errors in ${mode} mode with exit 2 and no request`, async t => {
    const result = await cli(t, ['history', '--limit', '21'], { json, auth: 'missing' });
    outputError(result, { code: 'USAGE_ERROR', exit: 2, message: '--limit must be an integer from 1 to 20.', json });
    assert.deepEqual(result.calls, []);
  });

  test(`binary CLI strips terminal controls from ${mode} usage errors`, async t => {
    const option = '--bad\x1b[31mRED\x1b[0m\x1b]8;;https://invalid.example/\x07LINK\x1b]8;;\x07\r\t\x7f';
    const result = await cli(t, ['status', option], { json, auth: 'missing' });
    outputError(result, { code: 'USAGE_ERROR', exit: 2, message: 'Unknown option: --badREDLINK.', json });
    assert.doesNotMatch(result.stdout + result.stderr, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    assert.deepEqual(result.calls, []);
  });

  test(`binary CLI reports unreadable message input in ${mode} mode with exit 1 before authentication`, async t => {
    const result = await cli(t, ['send', '--file', 'missing-message.txt', '--room', roomId], { json, auth: 'missing' });
    outputError(result, { code: 'INPUT_ERROR', exit: 1, message: 'Could not read the message input. Check the file and its permissions.', json });
    assert.deepEqual(result.calls, []);
  });

  for (const [auth, code, message] of [
    ['missing', 'AUTH_MISSING', 'No Codex login found. Run dotter auth login.'],
    ['invalid', 'AUTH_INVALID', 'The Codex login file is not valid JSON. Run dotter auth login.'],
    ['api-key', 'AUTH_MODE', 'A ChatGPT Codex login is required. API-key login cannot read Dot messages.'],
  ]) {
    test(`binary CLI presents ${auth} authentication in ${mode} mode with exit 3`, async t => {
      const result = await cli(t, ['status'], { json, auth });
      outputError(result, { code, exit: 3, message, json, details: { authFile: result.authFile } });
      assert.deepEqual(result.calls, []);
    });
  }

  for (const response of [
    { label: 'rejected login', status: 401, code: 'AUTH_REJECTED', exit: 3, message: 'The server rejected this Codex login. Run dotter auth login.' },
    { label: 'forbidden API', status: 403, code: 'FORBIDDEN', exit: 4, message: 'This request is not permitted. Reads and sends may have different requirements.' },
    { label: 'HTML forbidden', status: 403, headers: { 'content-type': 'text/html' }, code: 'FORBIDDEN_HTML', exit: 4, message: 'The server returned an HTML 403. This may be an edge rejection; it does not prove the login is invalid. Try again later.' },
    { label: 'edge challenge', status: 403, headers: { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }, code: 'EDGE_CHALLENGE', exit: 4, message: 'The edge service requires a browser challenge. The CLI will not bypass it. Try again later or use ChatGPT normally.' },
    { label: 'rate limit', status: 429, code: 'RATE_LIMITED', exit: 1, message: 'The service rate-limited this request. Wait before trying again.' },
    { label: 'server error', status: 503, code: 'HTTP_ERROR', exit: 1, message: 'The API returned HTTP 503.' },
  ]) {
    test(`binary CLI routes ${response.label} to ${mode} output and its documented exit`, async t => {
      const result = await cli(t, ['status'], { json, ...response, value: { error: secret, access_token: token } });
      outputError(result, { ...response, json, details: { status: response.status } });
      oneRead(result);
    });
  }

  test(`binary CLI routes a network failure to ${mode} output with exit 5`, async t => {
    const result = await cli(t, ['status'], { json, envelope: { error: secret } });
    outputError(result, { code: 'NETWORK_ERROR', exit: 5, message: 'The HTTPS request failed before a complete response was received.', json, details: { delivery: 'unknown' } });
    oneRead(result);
  });

  test(`binary CLI reports a missing transport in ${mode} mode without trying a fallback`, async t => {
    const result = await cli(t, ['status'], { json, helper: false });
    outputError(result, { code: 'PYTHON_REQUIRED', exit: 1, message: 'Python 3 is required for the HTTPS transport. Install Python 3 and try again.', json, details: { delivery: 'not_sent' } });
    assert.deepEqual(result.calls, []);
  });

  test(`binary CLI sanitizes an unexpected exception in ${mode} mode with exit 1`, async t => {
    const result = await cli(t, ['status'], { json, unexpected: true });
    outputError(result, { code: 'UNEXPECTED', exit: 1, message: 'Unexpected failure. Run dotter --help or retry.', json });
    assert.deepEqual(result.calls, []);
  });
}

for (const json of [false, true]) {
  test(`binary CLI returns unavailable auth status with exit 3 ${json ? 'with' : 'without'} --json`, async t => {
    const result = await cli(t, ['auth', 'status'], { json, auth: 'missing' });
    assert.equal(result.code, 3);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { status: 'unavailable', mode: 'chatgpt', error: {
      code: 'AUTH_MISSING', message: 'No Codex login found. Run dotter auth login.', authFile: result.authFile,
    } });
    assert.deepEqual(result.calls, []);
  });
}

for (const json of [false, true]) {
  test(`binary CLI preserves not-sent delivery and the request key when Python is missing in ${json ? 'JSON' : 'human'} mode`, async t => {
    const result = await cli(t, ['send', 'synthetic message', '--room', roomId, '--key', key], { json, helper: false });
    const message = 'Python 3 is required for the HTTPS transport. Install Python 3 and try again.';
    const prefix = `Request key: ${key}\n`;
    if (json) outputError(result, { code: 'PYTHON_REQUIRED', exit: 1, message, json, prefix, details: { delivery: 'not_sent', idempotencyKey: key } });
    else {
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, `${prefix}Dotter: ${message}\nDelivery: not_sent. Request key: ${key}\n`);
    }
    assert.deepEqual(result.calls, []);
  });

  for (const response of [
    { label: 'forbidden response', status: 403, value: { error: secret }, code: 'FORBIDDEN', exit: 4, message: 'This request is not permitted. Reads and sends may have different requirements.', details: { status: 403 } },
    { label: 'lost response', envelope: { error: secret }, code: 'NETWORK_ERROR', exit: 5, message: 'The HTTPS request failed before a complete response was received.', details: {} },
    { label: 'unconfirmed acknowledgement', value: { token: secret }, code: 'INVALID_RESPONSE', exit: 1, message: 'The server did not return a message acknowledgment. Check history before trying again.', details: {} },
  ]) {
    test(`binary CLI preserves the send request key and uncertain delivery after ${response.label} in ${json ? 'JSON' : 'human'} mode`, async t => {
      const result = await cli(t, ['send', 'synthetic message', '--room', roomId, '--key', key], { json, ...response });
      assert.equal(result.code, response.exit);
      const prefix = `Request key: ${key}\n`;
      if (json) outputError(result, { ...response, json, prefix, details: { ...response.details, delivery: 'unknown', idempotencyKey: key } });
      else {
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `${prefix}Dotter: ${response.message}\nDelivery: unknown. Request key: ${key}\n`);
      }
      assert.equal(result.calls.length, 1, 'uncertain sends are never retried');
      const { request } = result.calls[0];
      assert.equal(request.method, 'POST');
      assert.equal(request.url, `https://chatgpt.com/backend-api/messaging/rooms/${roomId}/messages`);
      const body = JSON.parse(request.body);
      assert.equal(body.request_id, key);
      assert.equal(body.idempotency_token, key);
      assert.deepEqual(body.content, { text: 'synthetic message' });
    });
  }
}

test('binary CLI delivers literal --json after the argument terminator as message text', async t => {
  const result = await cli(t, ['send', '--room', roomId, '--key', key], { value: { id: 'synthetic_message_1' }, literal: ['--json'] });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, `Request key: ${key}\n`);
  assert.deepEqual(JSON.parse(result.stdout), { accepted: true, roomId, messageId: 'synthetic_message_1', idempotencyKey: key, createdAt: null });
  assert.equal(result.calls.length, 1);
  const { request } = result.calls[0];
  assert.equal(request.method, 'POST');
  assert.equal(request.url, `https://chatgpt.com/backend-api/messaging/rooms/${roomId}/messages`);
  assert.deepEqual(JSON.parse(request.body).content, { text: '--json' });
});

test('binary CLI does not claim delivery metadata when authentication fails before a send', async t => {
  const result = await cli(t, ['send', 'synthetic message', '--room', roomId, '--key', key], { auth: 'missing' });
  outputError(result, { code: 'AUTH_MISSING', exit: 3, message: 'No Codex login found. Run dotter auth login.', json: false, prefix: `Request key: ${key}\n` });
  assert.doesNotMatch(result.stderr, /Delivery:/);
  assert.deepEqual(result.calls, []);
});

// The -- terminator is consumed by the real parser, so flags before it remain
// flags and the exact string --json after it must be sent as message text.
for (const json of [false, true]) {
  test(`binary CLI ${json ? 'honors an actual JSON flag before' : 'does not treat literal --json after'} the argument terminator`, async t => {
    const result = await cli(t, ['send', '--room', roomId, '--key', key], { auth: 'missing', json, literal: ['--json'] });
    outputError(result, { code: 'AUTH_MISSING', exit: 3, message: 'No Codex login found. Run dotter auth login.', json,
      prefix: `Request key: ${key}\n`, details: { authFile: result.authFile } });
    assert.deepEqual(result.calls, []);
  });
}
