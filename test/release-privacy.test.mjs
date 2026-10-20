import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  assertIdentity,
  assertManifest,
  assertPublicationRequest,
  readGitIdentities,
  scanMetadata,
} from '../scripts/release-privacy.cjs';

// Every identity, archive, address and path below is a synthetic offline fixture.
const name = '@jethros-projects/dotter';
const version = '0.6.3-next.3';
const commit = 'a'.repeat(40);
const noreply = 'jethros-projects@users.noreply.github.com';
const identity = { name: 'Jethro', email: noreply };
const options = { name, version, commit };
const bytes = Buffer.from('Synthetic release archive; no account or service data.\n');
const digest = (algorithm, encoding) => createHash(algorithm).update(bytes).digest(encoding);
const publicationOptions = {
  ...options,
  sha256: digest('sha256', 'hex'),
  integrity: `sha512-${digest('sha512', 'base64')}`,
  size: bytes.length,
};
const attachmentName = `${name}-${version}.tgz`;
const clone = value => structuredClone(value);

function manifest() {
  return {
    name,
    version,
    _id: `${name}@${version}`,
    description: 'Synthetic typed SDK and CLI fixture',
    license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/jethros-projects/dotter.git' },
    homepage: 'https://github.com/jethros-projects/dotter#readme',
    bugs: { url: 'https://github.com/jethros-projects/dotter/issues' },
    publishConfig: { access: 'public', tag: 'next' },
    gitHead: commit,
    readme: '# Synthetic fixture\n\nBuilt by Jethro and contributors.\n',
  };
}

function publication() {
  const publishedManifest = {
    ...manifest(),
    _id: `${name}@${version}`,
    _nodeVersion: '24.19.0',
    _npmVersion: '11.11.1',
    dist: {
      integrity: publicationOptions.integrity,
      shasum: digest('sha1', 'hex'),
      tarball: `http://registry.npmjs.org/${name}/-/${attachmentName}`,
    },
  };
  return {
    _id: name,
    name,
    description: publishedManifest.description,
    access: 'public',
    'dist-tags': { next: version },
    versions: { [version]: publishedManifest },
    _attachments: {
      [attachmentName]: {
        content_type: 'application/octet-stream',
        data: bytes.toString('base64'),
        length: bytes.length,
      },
    },
  };
}

function homePaths() {
  return [
    ['', 'Users', 'synthetic-owner', 'project'].join('/'),
    ['', 'home', 'synthetic-owner', 'project'].join('/'),
    ['C:', 'Users', 'synthetic-owner', 'project'].join('\\'),
    ['C:', 'Users', 'synthetic-owner', 'project'].join('/'),
    ['file:', '', '', 'private', 'synthetic-fixture'].join('/'),
  ];
}

test('release identities permit only the public aliases and their noreply addresses', async t => {
  for (const publicName of ['Jethro', 'jethros-projects']) {
    for (const email of [noreply, `12345+${noreply}`]) {
      await t.test(`${publicName}: ${email.includes('+') ? 'numeric ID' : 'plain noreply'}`, () => {
        assert.doesNotThrow(() => assertIdentity({ name: publicName, email }));
      });
    }
    assert.doesNotThrow(() => assertIdentity({ name: publicName }, { requireEmail: false }));
  }
});

test('release identities reject private names, missing identities and misleading noreply addresses', async t => {
  const rejected = [
    null,
    {},
    { email: noreply },
    { name: 'Synthetic Private Alias', email: noreply },
    { name: 'jethro', email: noreply },
    { name: 'JETHRO', email: noreply },
    { name: 'Jethro' },
    { name: 'Jethro', email: '' },
    { name: 'Jethro', email: 'synthetic-owner@example.com' },
    { name: 'Jethro', email: 'other-owner@users.noreply.github.com' },
    { name: 'Jethro', email: `letters+${noreply}` },
    { name: 'Jethro', email: 'jethros-projects@noreply.github.com' },
    { name: 'Jethro', email: `${noreply}.invalid` },
  ];
  for (const [index, value] of rejected.entries()) {
    await t.test(`invalid identity ${index + 1}`, () => {
      assert.throws(() => assertIdentity(value));
    });
  }
  assert.throws(() => assertIdentity(
    { name: 'Synthetic Private Alias' }, { requireEmail: false },
  ));
  assert.throws(() => assertIdentity(
    { name: 'Jethro', email: 'synthetic-owner@example.com' }, { requireEmail: false },
  ));
});

test('metadata accepts public identities and documented synthetic email domains', () => {
  assert.doesNotThrow(() => scanMetadata({
    author: identity,
    contributors: [{ name: 'jethros-projects', email: `12345+${noreply}` }],
    examples: ['fixture@example.com', 'fixture@service.test', 'fixture@service.invalid'],
    documentation: '$HOME is a placeholder; no absolute user directory is included.',
  }));
});

test('metadata scans arbitrary nested values for home paths and file URLs', async t => {
  for (const [index, unsafe] of homePaths().entries()) {
    await t.test(`synthetic path form ${index + 1}`, () => {
      assert.throws(() => scanMetadata({ extension: [{ opaqueKey: { value: unsafe } }] }));
    });
  }
  assert.throws(() => scanMetadata({ arbitrary: ['fixture@synthetic-private-mail.dev'] }));
  assert.throws(() => scanMetadata({ arbitrary: { [homePaths()[0]]: 'synthetic value' } }));
  assert.throws(() => scanMetadata({ 'fixture@synthetic-private-mail.dev': 'synthetic value' }));
});

test('metadata applies the identity policy to authors, committers and taggers', async t => {
  for (const field of ['author', 'committer', 'tagger']) {
    await t.test(field, () => {
      assert.doesNotThrow(() => scanMetadata({ nested: { [field]: identity } }));
      assert.throws(() => scanMetadata({
        nested: { [field]: { name: 'Synthetic Private Alias', email: 'fixture@example.com' } },
      }));
      assert.throws(() => scanMetadata({
        nested: { [field]: { name: 'Jethro', email: 'fixture@example.com' } },
      }));
    });
  }
});

test('manifest accepts clean metadata and approved public author attribution', () => {
  assert.doesNotThrow(() => assertManifest(manifest(), options));
  assert.doesNotThrow(() => assertManifest({ ...manifest(), author: identity }, options));
});

test('manifest rejects unsafe publish-only and source-location attributes', async t => {
  for (const key of ['_from', '_resolved', 'dist', 'tag', '_npmUser', '_unexpected']) {
    await t.test(key, () => {
      assert.throws(() => assertManifest({ ...manifest(), [key]: 'synthetic value' }, options));
    });
  }
});

test('manifest binds its name, version, commit, repository and preview channel', async t => {
  const mutations = [
    value => { value.name = '@synthetic-owner/other'; },
    value => { value.version = '0.0.0-test.0'; },
    value => { value.gitHead = 'b'.repeat(40); },
    value => { delete value.gitHead; },
    value => { value._id = `${name}@0.0.0-test.0`; },
    value => { delete value._id; },
    value => { value.repository.url = 'git+https://github.com/synthetic-owner/dotter.git'; },
    value => { value.repository.url = 'git+https://synthetic-user@github.com/jethros-projects/dotter.git'; },
    value => { value.homepage = 'https://example.com/other'; },
    value => { value.bugs.url = 'https://example.com/issues'; },
    value => { value.publishConfig.access = 'restricted'; },
    value => { value.publishConfig.tag = 'latest'; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    await t.test(`inconsistent manifest ${index + 1}`, () => {
      const value = manifest();
      mutate(value);
      assert.throws(() => assertManifest(value, options));
    });
  }
});

test('manifest scans unknown extension fields and README content', () => {
  assert.throws(() => assertManifest({
    ...manifest(), extension: { value: homePaths()[0] },
  }, options));
  assert.throws(() => assertManifest({
    ...manifest(), readme: 'Contact fixture@synthetic-private-mail.dev for help.',
  }, options));
});

test('publication request accepts only its exact verified attachment and prepared metadata', () => {
  assert.doesNotThrow(() => assertPublicationRequest(publication(), publicationOptions));
});

test('publication request rejects changed bytes, length, hashes and malformed base64', async t => {
  const mutations = [
    value => {
      value._attachments[attachmentName].data = Buffer.from('tampered fixture').toString('base64');
    },
    value => { value._attachments[attachmentName].length++; },
    value => { value._attachments[attachmentName].data += '!'; },
    value => { value._attachments[attachmentName].content_type = 'text/plain'; },
    value => { value.versions[version].dist.integrity = `sha512-${Buffer.alloc(64).toString('base64')}`; },
    value => { value.versions[version].dist.shasum = '0'.repeat(40); },
  ];
  for (const [index, mutate] of mutations.entries()) {
    await t.test(`invalid attachment ${index + 1}`, () => {
      const value = publication();
      mutate(value);
      assert.throws(() => assertPublicationRequest(value, publicationOptions));
    });
  }
  assert.throws(() => assertPublicationRequest(publication(), {
    ...publicationOptions, sha256: '0'.repeat(64),
  }));
  assert.throws(() => assertPublicationRequest(publication(), {
    ...publicationOptions, size: bytes.length + 1,
  }));
});

test('publication request rejects extra versions, channels, attachments and mismatched identities', async t => {
  const mutations = [
    value => { value.versions['0.0.0-test.0'] = clone(value.versions[version]); },
    value => { delete value.versions[version]; },
    value => { value['dist-tags'].latest = version; },
    value => { value['dist-tags'].next = '0.0.0-test.0'; },
    value => { delete value['dist-tags'].next; },
    value => { value._attachments['extra.tgz'] = clone(value._attachments[attachmentName]); },
    value => { delete value._attachments[attachmentName]; },
    value => { value.name = '@synthetic-owner/other'; },
    value => { value._id = '@synthetic-owner/other'; },
    value => { value.access = 'restricted'; },
    value => { value.versions[version].gitHead = 'b'.repeat(40); },
  ];
  for (const [index, mutate] of mutations.entries()) {
    await t.test(`inconsistent request ${index + 1}`, () => {
      const value = publication();
      mutate(value);
      assert.throws(() => assertPublicationRequest(value, publicationOptions));
    });
  }
});

test('publication request scans metadata at every level while limiting npm-added attributes', async t => {
  const mutations = [
    value => { value.extension = { opaque: homePaths()[0] }; },
    value => { value.versions[version].extension = { opaque: homePaths()[1] }; },
    value => { value.versions[version].dist.opaque = homePaths()[2]; },
    value => { value.versions[version]._nodeVersion = homePaths()[3]; },
    value => { value.versions[version]._from = 'synthetic source'; },
    value => { value.versions[version]._resolved = 'synthetic source'; },
    value => { value.versions[version]._npmUser = identity; },
    value => { value.versions[version]._unexpected = 'synthetic value'; },
    value => { value.versions[version].tag = 'next'; },
    value => { value.versions[version].author = { name: 'Synthetic Private Alias', email: noreply }; },
    value => { value._unexpected = 'synthetic value'; },
  ];
  for (const [index, mutate] of mutations.entries()) {
    await t.test(`unsafe request metadata ${index + 1}`, () => {
      const value = publication();
      mutate(value);
      assert.throws(() => assertPublicationRequest(value, publicationOptions));
    });
  }
});

async function gitFixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'dotter-release-privacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = (args, { author = identity, committer = identity } = {}) => execFileSync('git', [
    '-c', 'commit.gpgSign=false',
    '-c', 'tag.gpgSign=false',
    '-c', `core.hooksPath=${path.join(root, 'no-hooks')}`,
    ...args,
  ], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: path.join(root, 'no-global-config'),
      GIT_AUTHOR_NAME: author.name,
      GIT_AUTHOR_EMAIL: author.email,
      GIT_COMMITTER_NAME: committer.name,
      GIT_COMMITTER_EMAIL: committer.email,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  run(['init', '--quiet', '--initial-branch=main']);
  run(['commit', '--quiet', '--allow-empty', '-m', 'Synthetic public fixture']);
  return { root, run };
}

test('Git identity reader returns structured public author, committer and tagger identities', async t => {
  const { root, run } = await gitFixture(t);
  run(['tag', '--annotate', 'synthetic-public', '--message', 'Synthetic public tag']);
  const identities = await readGitIdentities(root);
  assert.ok(Array.isArray(identities));
  for (const kind of ['author', 'committer', 'tagger']) {
    assert.ok(identities.some(value => value.kind === kind), `missing ${kind}`);
  }
  for (const value of identities) {
    assert.match(value.object, /^[0-9a-f]{40,64}$/);
    assert.doesNotThrow(() => assertIdentity(value));
  }
});

test('Git identity reader includes a private committer even when the author is public', async t => {
  const { root, run } = await gitFixture(t);
  run(['commit', '--quiet', '--allow-empty', '-m', 'Synthetic private committer'], {
    committer: { name: 'Synthetic Private Alias', email: 'fixture@example.com' },
  });
  const identities = await readGitIdentities(root);
  const found = identities.find(value => value.kind === 'committer' && value.name === 'Synthetic Private Alias');
  assert.ok(found, 'committer must be read independently from author');
  assert.throws(() => assertIdentity(found));
});

test('Git identity reader checks reachable history rather than just HEAD', async t => {
  const { root, run } = await gitFixture(t);
  run(['commit', '--quiet', '--allow-empty', '-m', 'Synthetic private author'], {
    author: { name: 'Synthetic Private Alias', email: 'fixture@example.com' },
  });
  run(['commit', '--quiet', '--allow-empty', '-m', 'Synthetic public successor']);
  const identities = await readGitIdentities(root);
  const found = identities.find(value => value.kind === 'author' && value.name === 'Synthetic Private Alias');
  assert.ok(found, 'an earlier reachable author must remain visible');
  assert.throws(() => assertIdentity(found));
});

test('Git identity reader checks nested annotated taggers independently from commit identities', async t => {
  const { root, run } = await gitFixture(t);
  run(['tag', '--annotate', 'synthetic-inner', '--message', 'Synthetic private tagger'], {
    committer: { name: 'Jethro', email: 'fixture@example.com' },
  });
  run(['tag', '--annotate', 'synthetic-outer', 'synthetic-inner', '--message', 'Synthetic public outer tag']);
  run(['tag', '--delete', 'synthetic-inner']);
  const identities = await readGitIdentities(root);
  const found = identities.find(value => value.kind === 'tagger' && value.email === 'fixture@example.com');
  assert.ok(found, 'nested reachable tagger must remain visible after its direct ref is removed');
  assert.throws(() => assertIdentity(found));
});
