import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertIdentity, readGitIdentities, scanText, scanMetadata } from './release-privacy.cjs';

// Maintainer publication gate, independent of npm, network and credentials.
export async function checkGitPrivacy(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  assert.equal(git(['rev-parse', '--is-shallow-repository']).trim(), 'false', 'Privacy review requires full history and tags.');
  const identities = readGitIdentities(root);
  for (const identity of identities) assertIdentity(identity);
  // Check committed blobs on every local ref, including an earlier file removed
  // from HEAD. A later clean commit cannot conceal a previously committed path.
  const records = git(['rev-list', '--objects', '--all']).trim().split('\n');
  for (const record of records) scanText(record, { source: true });
  const objects = records.map(line => line.split(' ')[0]);
  const types = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    cwd: root, input: objects.join('\n') + '\n', encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  for (const line of types.trim().split('\n')) {
    const [object, type] = line.split(' ');
    if (['blob', 'commit', 'tag'].includes(type)) scanText(git(['cat-file', type, object]), { source: true });
  }
  // Also inspect current tracked edits before they are committed or pushed.
  for (const file of git(['ls-files', '-z']).split('\0').filter(Boolean)) {
    const content = await readFile(path.join(root, file));
    scanText(file, { source: true }); scanText(content.toString('utf8'), { source: true });
    if (file === 'package.json') scanMetadata(JSON.parse(content));
  }
  return { identities: identities.length, sourcePrivacy: 'passed' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
    console.log(JSON.stringify(await checkGitPrivacy(root)));
  } catch {
    console.error('Push blocked: review public Git identities, source paths and complete history with the release guide.');
    process.exitCode = 1;
  }
}
