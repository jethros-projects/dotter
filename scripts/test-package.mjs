import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { typecheck } from './typecheck.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), 'dotter-package-'));
const env = { ...process.env, HOME: path.join(temporary, 'home'),
  CODEX_HOME: path.join(temporary, 'codex'), DOTTER_STATE_DIR: path.join(temporary, 'state'),
  npm_config_cache: path.join(temporary, 'npm-cache') };

function execute(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${command} failed:\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

try {
  const [artifact] = JSON.parse(execute('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', temporary]));
  for (const { path: file } of artifact.files) {
    assert.match(file, /^(?:bin\/|src\/|examples\/|node_modules\/|scripts\/e2e-sdk(?:-checks)?\.mjs$|docs\/assets\/(?:dotter-terminal\.png|README\.md)$|docs\/(?:workflows|commands|contracts|architecture|SDK|agents|releasing|security-2026-10)\.md$|(?:package\.json|README\.md|AGENTS\.md|LICENSE|CONTRIBUTING\.md|SECURITY\.md|THIRD_PARTY_NOTICES\.md)$)/,
      `Unexpected package file: ${file}`);
  }
  assert.ok(artifact.files.some(file => file.path === 'bin/dotter.mjs'));
  assert.ok(artifact.files.some(file => file.path === 'src/runtime.mjs'));
  assert.ok(artifact.files.some(file => file.path === 'scripts/e2e-sdk-checks.mjs'));
  for (const document of ['README.md', 'AGENTS.md', 'docs/SDK.md', 'docs/agents.md', 'docs/releasing.md', 'docs/security-2026-10.md', 'docs/assets/README.md', 'docs/assets/dotter-terminal.png']) {
    assert.ok(artifact.files.some(file => file.path === document), `Missing package documentation: ${document}`);
  }
  assert.ok(!artifact.files.some(file => file.path.includes('dot-chat')));
  const prefix = path.join(temporary, 'installed');
  await mkdir(prefix, { recursive: true });
  await writeFile(path.join(prefix, 'package.json'), JSON.stringify({ name: 'dotter-consumer', private: true, type: 'module' }));
  execute('npm', ['install', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temporary, artifact.filename)]);
  const packageRoot = path.join(prefix, 'node_modules', '@jethros-projects/dotter');
  const cli = path.join(prefix, 'node_modules', '.bin', 'dotter');
  const pkg = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, '^22.23.4 || ^24.22.1 || ^26.12.1');
  const unsupportedPreload = `data:text/javascript,${encodeURIComponent("Object.defineProperty(process.versions, 'node', { value: '24.22.0' });")}`;
  for (const target of ['@jethros-projects/dotter', '@jethros-projects/dotter/advanced']) {
    execute(process.execPath, ['--import', unsupportedPreload, '--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      await assert.rejects(import(${JSON.stringify(target)}), { code: 'UNSUPPORTED_NODE_VERSION' });
    `], prefix);
  }
  const unsupportedCli = spawnSync(process.execPath, ['--import', unsupportedPreload, cli, 'status', '--json'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(unsupportedCli.status, 1);
  assert.equal(unsupportedCli.stderr, '');
  assert.equal(JSON.parse(unsupportedCli.stdout).error.code, 'UNSUPPORTED_NODE_VERSION');
  assert.equal(execute(process.execPath, [cli, '--version']).trim(), pkg.version);
  assert.match(execute(process.execPath, [cli]), /Usage: dotter/);
  assert.match(execute(process.execPath, [cli, 'help', 'send']), /dotter send TEXT/);
  assert.match(execute(process.execPath, [cli, 'auth', '--help']), /dotter auth login/);
  assert.match(execute(process.execPath, [cli, 'library', '--help']), /dotter library browse/);
  assert.match(execute(process.execPath, [cli, 'library', 'browse', '--help']), /--directory/);
  assert.match(execute(process.execPath, [cli, '--help-all']), /Extended API commands/);
  assert.ok(JSON.parse(execute(process.execPath, [cli, 'capabilities'])));
  execute(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    const sdk = await import('@jethros-projects/dotter');
    const advanced = await import('@jethros-projects/dotter/advanced');
    assert.equal(typeof sdk.createClient, 'function');
    assert.equal(typeof sdk.DotterClient, 'function');
    assert.equal(typeof sdk.DotterError, 'function');
    assert.equal(typeof advanced.FullDotClient, 'function');
    const client = sdk.createClient();
    assert.ok(client instanceof sdk.DotterClient);
    assert.ok(client.capabilities());
    await client.close();
    await client.close();
    const metadata = await import('@jethros-projects/dotter/package.json', { with: { type: 'json' } });
    assert.equal(metadata.default.version, ${JSON.stringify(pkg.version)});
  `], prefix);
  const consumer = path.join(prefix, 'type-consumer');
  await cp(path.join(root, 'test/types'), consumer, { recursive: true });
  await typecheck(prefix, consumer);
  const unavailable = spawnSync(process.execPath, [cli, 'auth', 'status', '--json'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(unavailable.status, 3);
  assert.equal(JSON.parse(unavailable.stdout).status, 'unavailable');
  const liveGate = spawnSync(process.execPath, [path.join(packageRoot, 'scripts/e2e-sdk.mjs')], {
    env: { ...env, DOTTER_E2E_CONFIRM: '0' }, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(liveGate.status, 2);
  assert.match(liveGate.stderr, /Live E2E is opt-in/);
  console.log(`Package smoke passed: ${artifact.filename}; isolated install, help, capabilities, typed SDK and advanced exports, strict packed-package consumer, and missing-auth behavior.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
