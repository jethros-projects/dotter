import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertSupportedNode } from '../src/runtime.mjs';

const entrypoint = fileURLToPath(new URL('../bin/dotter.mjs', import.meta.url));
const targets = ['../src/index.mjs', '../src/native.mjs'].map(value => new URL(value, import.meta.url).href);
const supported = ['22.23.4', '24.22.1', '26.12.1'];
const unsupported = ['22.23.3', '24.22.0', '26.12.0'];
const message = version => `Dotter requires a security-patched Node.js release: 22.23.4+, 24.22.1+, or 26.12.1+ on the corresponding major. Found Node.js ${version}. Upgrade Node.js: https://nodejs.org/en/download`;

function child(version, args) {
  // Simulate only runtime version metadata. Network, TLS, credentials, and the
  // real package entrypoints remain intact in a fresh process.
  const preload = `data:text/javascript,${encodeURIComponent(`Object.defineProperty(process.versions, 'node', { value: ${JSON.stringify(version)} });`)}`;
  const result = spawnSync(process.execPath, ['--import', preload, ...args], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.signal, null);
  return result;
}

test('runtime gate accepts each patched floor and later releases in that major', () => {
  for (const version of [...supported, '22.23.5', '22.24.0', '24.22.2', '24.23.0', '26.12.2', '26.13.0']) {
    assert.equal(assertSupportedNode(version), undefined, version);
  }
});

test('runtime gate rejects vulnerable, EOL, future, prerelease, and malformed versions', () => {
  for (const version of [...unsupported, '22.22.999', '24.21.999', '26.11.999',
    '18.20.0', '20.99.0', '21.99.0', '23.99.0', '25.99.0', '27.0.0', '28.0.0',
    '24.22.1-rc.1', '24.22.1+build', 'v24.22.1', '024.22.1', '24.22', '', null,
    '24.22.1\n', '24.22.1\r', '24.22.1\r\n', '24.22.1\u001b[31m', '9007199254740992.1.1']) {
    assert.throws(() => assertSupportedNode(version), { code: 'UNSUPPORTED_NODE_VERSION' }, String(version));
  }
});

test('runtime diagnostics redact malformed version metadata', () => {
  for (const version of ['24.22.1\nprivate-value', '24.22.1\u001b[31m', null, {}]) {
    assert.throws(() => assertSupportedNode(version), { code: 'UNSUPPORTED_NODE_VERSION', message: message('unknown') });
  }
});

for (const version of [...unsupported, '25.99.0', '28.0.0']) {
  test(`public SDK imports reject Node ${version} with the stable startup error`, () => {
    for (const target of targets) {
      const result = child(version, ['--input-type=module', '--eval', `
        try {
          await import(${JSON.stringify(target)});
          process.exitCode = 9;
        } catch (error) {
          process.stdout.write(JSON.stringify({ code: error.code, message: error.message }));
        }
      `]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), { code: 'UNSUPPORTED_NODE_VERSION', message: message(version) });
    }
  });
}

for (const version of unsupported) {
  test(`CLI rejects Node ${version} safely before normal command handling`, () => {
    for (const args of [['--help'], ['status', '--json'], ['send', '--file', 'missing-input.txt']]) {
      const result = child(version, [entrypoint, ...args]);
      assert.equal(result.status, 1);
      if (args.includes('--json')) {
        assert.equal(result.stderr, '');
        assert.deepEqual(JSON.parse(result.stdout), { error: { code: 'UNSUPPORTED_NODE_VERSION', message: message(version) } });
      } else {
        assert.equal(result.stdout, '');
        assert.equal(result.stderr, `Dotter: ${message(version)}\n`);
      }
      assert.doesNotMatch(result.stdout + result.stderr, /file:\/\/|\bat .*\.mjs:|missing-input|AUTH_/);
    }
  });
}

for (const version of supported) {
  test(`patched Node ${version} permits SDK construction and CLI help offline`, () => {
    const sdk = child(version, ['--input-type=module', '--eval', `
      const { createClient } = await import(${JSON.stringify(targets[0])});
      const advanced = await import(${JSON.stringify(targets[1])});
      let authCalls = 0;
      const client = createClient({ auth: { load() { authCalls++; throw new Error('unexpected authentication'); } } });
      client.capabilities();
      await client.close();
      if (authCalls !== 0 || typeof advanced.FullDotClient !== 'function') process.exitCode = 8;
    `]);
    assert.equal(sdk.status, 0, sdk.stderr);
    assert.equal(sdk.stderr, '');
    const cli = child(version, [entrypoint, '--help']);
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(cli.stderr, '');
    assert.match(cli.stdout, /Usage: dotter/);
  });
}
