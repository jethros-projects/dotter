import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { assertNpmAdapter } from '../scripts/release-npm.cjs';

// All npm trees and publication data are synthetic, offline fixtures.
const reviewedFiles = [
  'lib/commands/publish.js',
  'node_modules/libnpmpublish/lib/publish.js',
  'node_modules/npm-registry-fetch/lib/index.js',
];
const hook = fileURLToPath(new URL('../scripts/release-hook.cjs', import.meta.url));
const adapter = fileURLToPath(new URL('../scripts/release-npm.cjs', import.meta.url));
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') =>
  createHash(algorithm).update(bytes).digest(encoding);
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  }
  return value;
};

async function scratch(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dotter-release-hook-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function syntheticNpm(t, version = '11.11.1') {
  const root = path.join(await scratch(t), 'npm');
  const cli = path.join(root, 'bin/npm-cli.js');
  await mkdir(path.dirname(cli), { recursive: true });
  await writeFile(cli, '// Synthetic CLI placeholder; never executed.\n');
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'npm', version }));
  for (const relative of reviewedFiles) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, '// Synthetic source, deliberately different from reviewed npm.\n');
  }
  const fetchRoot = path.join(root, 'node_modules/npm-registry-fetch');
  await writeFile(path.join(fetchRoot, 'package.json'), JSON.stringify({
    name: 'npm-registry-fetch', main: 'lib/index.js',
  }));
  await writeFile(path.join(fetchRoot, 'lib/index.js'),
    'module.exports = () => { throw new Error("Synthetic recorder was not installed."); };\n');
  return { root, cli };
}

function fixture() {
  const name = '@jethros-projects/dotter';
  const version = '0.6.3-next.3';
  const commit = 'a'.repeat(40);
  const bytes = Buffer.from('Synthetic hook integration archive.\n');
  const integrity = `sha512-${hash(bytes, 'sha512', 'base64')}`;
  const attachmentName = `${name}-${version}.tgz`;
  const body = {
    _id: name,
    name,
    description: 'Synthetic guarded publication fixture',
    access: 'public',
    'dist-tags': { next: version },
    versions: {
      [version]: {
        _id: `${name}@${version}`,
        name,
        version,
        description: 'Synthetic guarded publication fixture',
        gitHead: commit,
        repository: { type: 'git', url: 'git+https://github.com/jethros-projects/dotter.git' },
        homepage: 'https://github.com/jethros-projects/dotter#readme',
        bugs: { url: 'https://github.com/jethros-projects/dotter/issues' },
        publishConfig: { access: 'public', tag: 'next' },
        _nodeVersion: '24.19.0',
        _npmVersion: '11.11.1',
        dist: {
          integrity,
          shasum: hash(bytes, 'sha1'),
          tarball: `http://registry.npmjs.org/${name}/-/${attachmentName}`,
        },
      },
    },
    _attachments: {
      [attachmentName]: {
        content_type: 'application/octet-stream',
        data: bytes.toString('base64'),
        length: bytes.length,
      },
    },
  };
  const { _attachments, ...metadata } = body;
  return {
    npmVersion: '11.11.1',
    escapedName: '@jethros-projects%2fdotter',
    expected: {
      name, version, commit, integrity,
      sha256: hash(bytes), size: bytes.length,
      metadataSha256: hash(JSON.stringify(canonical(metadata))),
    },
    testRequest: body,
  };
}

// Each subprocess owns the module-cache hook and its process-exit assertion.
// Socket creation and credential/config reads fail before any real I/O occurs.
const exerciseHook = String.raw`
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire, syncBuiltinESMExports } = require('node:module');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
let networkAttempts = 0, forbiddenFileReads = 0;
const denyNetwork = () => { networkAttempts++; throw new Error('Synthetic hook test forbids network access.'); };
http.request = http.get = https.request = https.get = denyNetwork;
net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = denyNetwork;
globalThis.fetch = denyNetwork;
const checkRead = file => {
  if (/(?:^|[\/])(?:[.]?npmrc|[.]netrc|auth[.]json|credentials(?:[.]json)?|config[.]toml)$/i.test(String(file))) {
    forbiddenFileReads++;
    throw new Error('Synthetic hook test forbids credential/config reads.');
  }
};
for (const key of ['readFileSync', 'readFile', 'openSync', 'open']) {
  const original = fs[key];
  fs[key] = (file, ...rest) => { checkRead(file); return original(file, ...rest); };
}
const readPromise = fs.promises.readFile;
fs.promises.readFile = (file, ...rest) => { checkRead(file); return readPromise(file, ...rest); };
syncBuiltinESMExports();
const npmRequire = createRequire(process.argv[1]);
const fetchPath = npmRequire.resolve('npm-registry-fetch');
const original = npmRequire(fetchPath);
const calls = [];
const recorder = (uri, opts) => {
  calls.push({ uri, method: opts.method, body: opts.body });
  return Promise.resolve({ status: 201, synthetic: true });
};
Object.assign(recorder, original);
require.cache[fetchPath].exports = recorder;
const state = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
process.env.DOTTER_RELEASE_STATE = process.argv[3];
const scenario = process.argv[4];
const adapterPath = require.resolve(process.argv[5]);
require(adapterPath);
let adapterChecks = 0;
require.cache[adapterPath].exports = {
  assertNpmAdapter(npmCli) {
    adapterChecks++;
    assert.equal(npmCli, process.argv[1]);
    assert.equal(calls.length, 0, 'Adapter gate must run before any registry call.');
    if (scenario === 'adapter-drift') throw new Error('Synthetic adapter rejected source drift.');
    return '11.11.1';
  },
};
(async () => {
  if (scenario === 'adapter-drift') {
    process.once('exit', code => {
      assert.equal(code, 1, 'Adapter rejection must terminate publication.');
      assert.equal(calls.length, 0);
      assert.equal(adapterChecks, 1);
      assert.equal(networkAttempts, 0);
      assert.equal(forbiddenFileReads, 0);
      process.stdout.write(JSON.stringify({ calls: calls.length, adapterChecks, networkAttempts, forbiddenFileReads, scenario }));
    });
    require(process.argv[2]);
    throw new Error('Rejected adapter unexpectedly installed its publication hook.');
  } else {
    require(process.argv[2]);
    const guarded = npmRequire(fetchPath);
    assert.notEqual(guarded, recorder);
    const good = state.testRequest;
    if (scenario !== 'clean') {
      const bad = structuredClone(good);
      const version = state.expected.version;
      let uri = state.escapedName;
      if (scenario === 'metadata') bad.versions[version]._from = 'synthetic source';
      else if (scenario === 'metadata-drift') bad.description = 'Changed synthetic description';
      else if (scenario === 'attachment') {
        const key = Object.keys(bad._attachments)[0];
        const bytes = Buffer.from(bad._attachments[key].data, 'base64');
        bytes[0] ^= 1;
        bad._attachments[key].data = bytes.toString('base64');
      } else if (scenario === 'wrong-uri') uri = '@synthetic-owner%2fother';
      else if (scenario === 'missing-versions') delete bad.versions;
      else if (scenario === 'empty-versions') bad.versions = {};
      else throw new Error('Unknown synthetic scenario.');
      assert.throws(() => guarded(uri, { method: 'PUT', body: bad }));
      assert.equal(calls.length, 0, 'Rejected request reached the registry recorder.');
      assert.equal(fs.existsSync(state.receipt), false, 'Rejected request wrote a success receipt.');
    }
    const result = await guarded(state.escapedName, { method: 'PUT', body: good });
    assert.equal(result.synthetic, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].uri, state.escapedName);
    assert.equal(calls[0].body, good);
    const receipt = JSON.parse(fs.readFileSync(state.receipt, 'utf8'));
    assert.deepEqual(receipt, {
      checked: 1, archiveSha256: state.expected.sha256, metadataMatched: true,
    });
  }
  assert.equal(adapterChecks, 1, 'Hook must invoke its npm adapter gate.');
  assert.equal(networkAttempts, 0);
  assert.equal(forbiddenFileReads, 0);
  process.stdout.write(JSON.stringify({ calls: calls.length, adapterChecks, networkAttempts, forbiddenFileReads, scenario }));
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

async function runHook(t, scenario) {
  const { cli: npmCli } = await syntheticNpm(t);
  const root = await scratch(t);
  const stateFile = path.join(root, 'state.json');
  const state = { ...fixture(), receipt: path.join(root, 'receipt.json') };
  await writeFile(stateFile, JSON.stringify(state), { mode: 0o600 });
  const child = spawnSync(process.execPath, [
    '--input-type=commonjs', '-e', exerciseHook,
    npmCli, hook, stateFile, scenario, adapter,
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(child.error, undefined);
  assert.equal(child.status, scenario === 'adapter-drift' ? 1 : 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.networkAttempts, 0);
  assert.equal(result.forbiddenFileReads, 0);
  assert.equal(result.adapterChecks, 1);
  assert.equal(result.calls, scenario === 'adapter-drift' ? 0 : 1);
}

test('real release adapter rejects a synthetic npm source tree with an otherwise accepted version', async t => {
  const npm = await syntheticNpm(t);
  assert.throws(() => assertNpmAdapter(npm.cli), /source changed/i);
});

test('real release adapter rejects an unreviewed npm version', async t => {
  const npm = await syntheticNpm(t, '11.11.2');
  assert.throws(() => assertNpmAdapter(npm.cli), /11[.]11[.]1/);
});

test('final publication hook forwards a clean reviewed PUT to the synthetic recorder', async t => {
  await runHook(t, 'clean');
});

test('final publication hook blocks altered or incomplete PUTs before the recorder', async t => {
  for (const scenario of ['metadata', 'metadata-drift', 'attachment', 'wrong-uri', 'missing-versions', 'empty-versions']) {
    await t.test(scenario, async child => runHook(child, scenario));
  }
});

test('final publication hook rejects npm source drift before reaching any registry implementation', async t => {
  await runHook(t, 'adapter-drift');
});
