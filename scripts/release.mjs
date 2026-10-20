import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import privacy from './release-privacy.cjs';
import { assertNpmAdapter } from './release-npm.cjs';
import { checkGitPrivacy } from './git-privacy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const { assertIdentity, assertManifest, assertPublicationRequest, scanArchive,
  readGitIdentities, hash, canonical, publicMetadata } = privacy;

export async function prepareRelease({ npmCli, output = undefined } = {}) {
  // Pin the reviewed npm implementation: changing it requires updating this
  // adapter and its synthetic regression tests before publishing.
  assert.ok(npmCli, 'Run this through npm run release:check or npm run release:publish.');
  npmCli = await realpath(npmCli);
  const npmRequire = createRequire(npmCli);
  const npmVersion = assertNpmAdapter(npmCli);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
  assert.equal(git(['rev-parse', '--is-shallow-repository']), 'false', 'Release checks require the complete Git history and tags.');
  assert.equal(git(['status', '--porcelain']), '', 'Commit and review all source changes before preparing a release.');
  const commit = git(['rev-parse', 'HEAD']);
  for (const identity of readGitIdentities(root)) assertIdentity(identity);
  await checkGitPrivacy(root);
  const source = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(source.name, '@jethros-projects/dotter');
  assert.match(source.version, /^\d+\.\d+\.\d+-next\.\d+$/, 'This publisher supports the preview channel only.');
  const expected = { name: source.name, version: source.version, commit };
  const destination = output ? path.resolve(output) : path.join(root, 'work/releases', source.version);
  assert.ok(destination !== root, 'Release artifacts must have their own directory.');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  const PackageJson = npmRequire('@npmcli/package-json');
  const pack = npmRequire('libnpmpack');
  const npa = npmRequire('npm-package-arg');
  const tar = npmRequire('tar');
  const prepare = async () => (await (await PackageJson.fix(root, { changes: [] })).prepare()).content;
  const manifest = await prepare();
  assertManifest(manifest, expected);
  const options = {
    access: 'public', defaultTag: 'next', registry: 'https://registry.npmjs.org/',
    ignoreScripts: true, dryRun: true, prefix: root, progress: false,
    cache: path.join(destination, 'cache'), npmVersion, provenance: false,
  };
  const spec = npa(root);
  const bytes = await pack(spec, options);
  const repeated = await pack(spec, options);
  assert.ok(bytes.equals(repeated), 'Release directory changed while packing.');
  assert.deepEqual(await prepare(), manifest, 'Publication metadata changed while packing.');
  const archiveScan = await scanArchive(bytes, tar);
  expected.sha256 = hash(bytes); expected.size = bytes.length;
  expected.integrity = `sha512-${hash(bytes, 'sha512', 'base64')}`;

  // Capture only a synthetic final request. This API path reads no npm
  // authentication settings and performs no registry operation.
  const fetchPath = npmRequire.resolve('npm-registry-fetch');
  const original = npmRequire('npm-registry-fetch');
  let captured;
  const mock = async (_uri, opts) => {
    assert.equal(opts.method, 'PUT'); assert.equal(captured, undefined);
    captured = opts.body; return { status: 201 };
  };
  mock.pickRegistry = original.pickRegistry;
  npmRequire.cache[fetchPath].exports = mock;
  try {
    const publisher = npmRequire.resolve('libnpmpublish/lib/publish.js');
    delete npmRequire.cache[publisher];
    await npmRequire(publisher)(manifest, bytes, options);
  } finally { npmRequire.cache[fetchPath].exports = original; }
  assertPublicationRequest(captured, expected);
  expected.metadataSha256 = hash(JSON.stringify(canonical(publicMetadata(captured))));
  const filename = source.name.slice(1).replace('/', '-') + '-' + source.version + '.tgz';
  await writeFile(path.join(destination, filename), bytes);
  await writeFile(path.join(destination, 'publication-metadata.json'), JSON.stringify(publicMetadata(captured), null, 2) + '\n');
  const report = {
    state: 'checked-not-published', ...expected, npmVersion, archiveFiles: archiveScan.files,
    gitIdentities: 'passed', metadataPrivacy: 'passed', archivePrivacy: 'passed',
    repackByteIdentical: true, registryAccountMetadataNotCovered: true,
  };
  await writeFile(path.join(destination, 'verification.json'), JSON.stringify(report, null, 2) + '\n');
  assert.equal(git(['status', '--porcelain']), '', 'Release preparation changed source files.');
  return { destination, npmCli, npmVersion, expected, escapedName: npa(source.name).escapedName, report };
}

async function main(args) {
  const [mode, ...rest] = args;
  assert.ok(['check', 'publish'].includes(mode), 'Use release:check or release:publish. Tarball arguments are forbidden.');
  assert.ok(rest.length === 0 || rest.length === 2 && rest[0] === '--output', 'Only --output DIRECTORY is supported. Tarball publication is forbidden.');
  const release = await prepareRelease({ npmCli: process.env.npm_execpath, output: rest[1] });
  console.log(JSON.stringify(release.report));
  if (mode === 'check') return;
  const stateFile = path.join(release.destination, 'publish-state.json');
  const receipt = path.join(release.destination, 'publish-receipt.json');
  await rm(receipt, { force: true });
  await writeFile(stateFile, JSON.stringify({
    npmVersion: release.npmVersion, escapedName: release.escapedName,
    expected: release.expected, receipt,
  }), { mode: 0o600 });
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        '--require', fileURLToPath(new URL('./release-hook.cjs', import.meta.url)),
        release.npmCli, 'publish', '.', '--access', 'public', '--tag', 'next',
        '--ignore-scripts', '--registry=https://registry.npmjs.org/',
      ], { cwd: root, stdio: 'inherit', env: { ...process.env, DOTTER_RELEASE_STATE: stateFile } });
      child.once('error', reject); child.once('close', code => resolve(code ?? 1));
    });
    assert.equal(code, 0, 'npm publication did not complete. Check the registry before retrying.');
    const checked = JSON.parse(await readFile(receipt, 'utf8'));
    assert.ok(checked.checked > 0 && checked.metadataMatched);
    console.log('npm accepted the guarded publication. Verify registry metadata and archive after scanning completes.');
  } finally { await rm(stateFile, { force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2)).catch(() => {
    // Do not print failing metadata, paths, identities or auth response bodies.
    console.error('Release check failed. Review the local candidate and release guide; nothing should be retried automatically.');
    process.exitCode = 1;
  });
}
