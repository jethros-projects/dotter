import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { run } from '../src/cli.mjs';
import { DotError } from '../src/errors.mjs';

for (const [name, argv, hook] of [
  ['polling', ['watch'], 'watch'],
  ['native events', ['events', 'watch'], 'v3Invoke'],
  ['account summary', ['account', 'summary', 'stream', '--account', 'account_1'], 'v4Invoke'],
]) {
  test(`${name} preserves a real failure racing with cancellation`, async () => {
    const signals = new EventEmitter(), output = [];
    const fail = async () => { signals.emit('SIGINT'); throw new DotError('NETWORK_ERROR', 'The final response was incomplete.', { delivery: 'unknown' }); };
    const deps = { signals, stdout: { write(value) { output.push(value); } }, stderr: { write() {} },
      createClient: async () => ({ watch: fail }), ...(hook === 'watch' ? {} : { [hook]: fail }) };
    await assert.rejects(run(argv, deps), error => error.code === 'NETWORK_ERROR' && error.details.delivery === 'unknown');
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
    assert.deepEqual(output, []);
  });
}
