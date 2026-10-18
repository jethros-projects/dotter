import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
    assert.match(file, /^(?:bin\/|src\/|examples\/|node_modules\/|docs\/(?:workflows|commands|contracts|architecture)\.md$|(?:package\.json|README\.md|LICENSE|CONTRIBUTING\.md|SECURITY\.md|THIRD_PARTY_NOTICES\.md)$)/,
      `Unexpected package file: ${file}`);
  }
  assert.ok(artifact.files.some(file => file.path === 'bin/dotter.mjs'));
  assert.ok(!artifact.files.some(file => file.path.includes('dot-chat')));
  const prefix = path.join(temporary, 'installed');
  execute('npm', ['install', '--prefix', prefix, '--offline', '--ignore-scripts', '--no-audit', '--no-fund', path.join(temporary, artifact.filename)]);
  const packageRoot = path.join(prefix, 'node_modules', 'dotter-cli');
  const cli = path.join(prefix, 'node_modules', '.bin', 'dotter');
  const pkg = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  assert.equal(execute(process.execPath, [cli, '--version']).trim(), pkg.version);
  assert.match(execute(process.execPath, [cli]), /Usage: dotter/);
  assert.match(execute(process.execPath, [cli, 'help', 'send']), /dotter send TEXT/);
  assert.match(execute(process.execPath, [cli, 'auth', '--help']), /dotter auth login/);
  assert.match(execute(process.execPath, [cli, 'library', '--help']), /dotter library browse/);
  assert.match(execute(process.execPath, [cli, 'library', 'browse', '--help']), /--directory/);
  assert.match(execute(process.execPath, [cli, '--help-all']), /Extended API commands/);
  assert.ok(JSON.parse(execute(process.execPath, [cli, 'capabilities'])));
  execute(process.execPath, ['--input-type=module', '--eval', "await import('dotter-cli')"], prefix);
  const unavailable = spawnSync(process.execPath, [cli, 'auth', 'status', '--json'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(unavailable.status, 3);
  assert.equal(JSON.parse(unavailable.stdout).status, 'unavailable');
  console.log(`Package smoke passed: ${artifact.filename}; isolated install, help, capabilities, public import, and missing-auth behavior.`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
