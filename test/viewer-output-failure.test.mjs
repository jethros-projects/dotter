import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { runRemoteControl } from '../src/remote-control.mjs';
import { runVoiceChat } from '../src/voice.mjs';
import { DotBrowserExtras } from '../src/browser-extras.mjs';

// Real loopback listeners, synthetic account/service, no browser or remote I/O.
const localRequest = (url, options = {}) => new Promise((resolve, reject) => {
  const req = request(url, { agent: false, timeout: 1000, ...options }, response => {
    response.resume(); response.once('end', () => resolve(response.statusCode));
    response.once('error', reject);
  });
  req.once('error', reject); req.once('timeout', () => req.destroy(new Error('Local probe timed out')));
  req.end(options.body);
});
for (const mode of ['remote', 'voice', 'qr', 'legacy']) {
  test(`${mode} launcher closes its loopback listener when output publication throws`, async () => {
    const failure = Object.assign(new Error('closed output fixture'), { code: 'EPIPE' });
    let url, outputCalls = 0, openCalls = 0; const serviceCalls = [];
    const client = { transport: {
      authLoader: async () => ({ accountId: 'account-fixture', accessToken: 'fixture' }),
      request: async (method, route) => {
        serviceCalls.push([method, route]);
        assert.equal(mode, 'legacy'); assert.equal(method, 'GET');
        assert.equal(route, '/backend-api/flora/browser/handoff');
        return { novnc_url: null };
      },
    } };
    const options = {
      expectedAccountId: 'account-fixture',
      output: { write(value) { outputCalls++; url = /http:\/\/127\.0\.0\.1:\d+\/#[A-Za-z0-9_-]+/.exec(value)?.[0]; throw failure; } },
      openBrowser: async () => { openCalls++; },
    };
    const invoke = mode === 'remote' ? () => runRemoteControl(client, { ...options, source: 'flora', conversationId: 'conversation-fixture' })
      : mode === 'voice' ? () => runVoiceChat(client, { ...options, dotId: 'dot-fixture' })
      : () => new DotBrowserExtras(client)[mode === 'qr' ? 'qrOpen' : 'handoffOpen']({ ...options, conversationId: 'conversation-fixture', ...(mode === 'qr' ? { challengeId: 'challenge-fixture' } : {}) });
    await assert.rejects(invoke(), error => error === failure);
    assert.equal(outputCalls, 1); assert.equal(openCalls, 0); assert.ok(url);
    assert.deepEqual(serviceCalls, mode === 'legacy' ? [['GET', '/backend-api/flora/browser/handoff']] : []);
    const parsed = new URL(url); let stillListening = false;
    try { stillListening = await localRequest(parsed.origin) === 200; }
    catch (error) { assert.equal(error.code, 'ECONNREFUSED'); }
    finally {
      // Cleanup also makes the regression safe when run against the old code.
      if (stillListening) await localRequest(parsed.origin + '/api/stop', {
        method: 'POST', headers: { Origin: parsed.origin, Authorization: `Bearer ${parsed.hash.slice(1)}`, 'Content-Type': 'application/json' }, body: '{}',
      });
    }
    assert.equal(stillListening, false, 'wrapper rejected but its local server was still listening');
  });
}
