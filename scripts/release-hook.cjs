// Loaded only into the npm child started by release.mjs publish. npm retains
// its ordinary authentication and browser-based second-factor flow.
const assert = require('node:assert/strict');
const { readFileSync, writeFileSync } = require('node:fs');
const { createRequire } = require('node:module');
const { assertPublicationRequest } = require('./release-privacy.cjs');
const { assertNpmAdapter } = require('./release-npm.cjs');

function install() {
  const stateFile = process.env.DOTTER_RELEASE_STATE;
  assert.ok(stateFile, 'The guarded publisher requires a reviewed release state.');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.equal(assertNpmAdapter(process.argv[1]), state.npmVersion);
  const npmRequire = createRequire(process.argv[1]);
  assert.equal(npmRequire('../package.json').version, state.npmVersion, 'npm changed after release review.');
  const fetchPath = npmRequire.resolve('npm-registry-fetch');
  const original = npmRequire('npm-registry-fetch');
  let checked = 0;
  function guarded(uri, opts = {}) {
    // Authentication requests and registry reads go through unchanged. Never
    // inspect, copy or log their headers, tokens or response bodies.
    if (opts.method === 'PUT' && (uri === state.escapedName || opts.body?.versions)) {
      try {
        assert.equal(uri, state.escapedName);
        assertPublicationRequest(opts.body, state.expected);
      } catch {
        throw new Error('Publication blocked: final metadata or archive differs from the privacy-reviewed candidate.');
      }
      checked++;
      writeFileSync(state.receipt, JSON.stringify({ checked, archiveSha256: state.expected.sha256, metadataMatched: true }) + '\n', { mode: 0o600 });
    }
    return original(uri, opts);
  }
  Object.assign(guarded, original);
  require.cache[fetchPath].exports = guarded;
  process.on('exit', () => {
    if (process.exitCode === 0 && checked === 0) {
      process.stderr.write('Publication stopped: npm did not pass through the final metadata guard.\n');
      process.exitCode = 1;
    }
  });
}

try { install(); } catch {
  process.stderr.write('Publication blocked: reviewed npm adapter or release state is unavailable.\n');
  process.exit(1);
}
