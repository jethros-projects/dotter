import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { checkGitPrivacy } from '../scripts/git-privacy.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const publicEmail = 'jethros-projects@users.noreply.github.com';

test('local pre-push hook blocks private Git metadata and committed source before a bare push', async t => {
  const scratch = await mkdtemp(path.join(tmpdir(), 'dotter-prepush-'));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const checkout = path.join(scratch, 'checkout'), remote = path.join(scratch, 'remote.git');
  await mkdir(path.join(checkout, 'scripts'), { recursive: true });
  await mkdir(path.join(checkout, '.githooks'));
  for (const file of ['scripts/git-privacy.mjs', 'scripts/release-privacy.cjs', '.githooks/pre-push']) {
    await copyFile(path.join(project, file), path.join(checkout, file));
  }
  await chmod(path.join(checkout, '.githooks/pre-push'), 0o755);
  const env = { ...process.env, DOTTER_PRIVATE_TERMS: 'synthetic-owner', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(scratch, 'no-global-config'),
    GIT_AUTHOR_NAME: 'Jethro', GIT_AUTHOR_EMAIL: publicEmail,
    GIT_COMMITTER_NAME: 'Jethro', GIT_COMMITTER_EMAIL: publicEmail };
  const git = args => execFileSync('git', ['-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', ...args],
    { cwd: checkout, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '--quiet', '--initial-branch=main']);
  git(['init', '--quiet', '--bare', remote]);
  git(['config', '--local', 'core.hooksPath', '.githooks']);
  git(['add', '.']); git(['commit', '--quiet', '-m', 'Synthetic public source']);
  git(['remote', 'add', 'origin', remote]);
  const clean = git(['rev-parse', 'HEAD']);
  await checkGitPrivacy(checkout);
  git(['push', '--quiet', 'origin', 'main']);
  const remoteHead = () => git(['--git-dir', remote, 'rev-parse', 'refs/heads/main']);
  assert.equal(remoteHead(), clean);
  const blocked = () => {
    const result = spawnSync('git', ['push', '--quiet', 'origin', 'main'], { cwd: checkout, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Push blocked/);
    assert.equal(remoteHead(), clean, 'blocked source must not reach the bare remote');
  };
  execFileSync('git', ['-c', 'commit.gpgSign=false', 'commit', '--quiet', '--allow-empty', '-m', 'Synthetic private committer'],
    { cwd: checkout, env: { ...env, GIT_COMMITTER_NAME: 'Synthetic Private Alias' }, stdio: 'pipe' });
  blocked(); git(['reset', '--hard', clean]);
  execFileSync('git', ['-c', 'tag.gpgSign=false', 'tag', '--annotate', 'synthetic-private-tagger', '--message', 'Synthetic tag'],
    { cwd: checkout, env: { ...env, GIT_COMMITTER_NAME: 'Synthetic Private Alias' }, stdio: 'pipe' });
  blocked(); git(['tag', '--delete', 'synthetic-private-tagger']);
  await writeFile(path.join(checkout, 'synthetic.txt'), ['', 'home', 'synthetic-owner', 'project'].join('/'));
  git(['add', '.']); git(['commit', '--quiet', '-m', 'Synthetic private path']);
  blocked();
  // Even deleting the file cannot conceal the historical blob about to be shared.
  git(['rm', 'synthetic.txt']); git(['commit', '--quiet', '-m', 'Synthetic clean successor']);
  blocked();
});
