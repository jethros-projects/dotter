const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { userInfo } = require('node:os');

const PUBLIC_NAME = 'Jethro';
const PUBLIC_LOGIN = 'jethros-projects';
const HOME_PATH = /\/(?:Users|home)\/[^\s/"'<>]+|[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/]|file:(?:\/|\.{1,2}[\\/]|[A-Za-z]:)/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const NOREPLY = /^(?:\d+\+)?jethros-projects@users\.noreply\.github\.com$/i;
const EXAMPLE_EMAIL = /@(?:[^@.]+\.)*(?:example\.(?:com|org|net)|[^@.]+\.(?:test|invalid))$/i;
const commonUsers = new Set(['runner', 'root', 'node', 'user', 'admin', 'administrator', 'codex', 'ubuntu', 'build', 'git', 'jethro', PUBLIC_LOGIN]);
const hash = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding);

function privateTerms() {
  const username = userInfo().username.toLowerCase();
  const local = username.length >= 5 && !commonUsers.has(username) ? [username] : [];
  return [...local, ...(process.env.DOTTER_PRIVATE_TERMS ?? '').split('\n').filter(Boolean)];
}

function scanText(value, { privateTerms: terms = privateTerms(), metadata = false, source = false } = {}) {
  // URL-encoded metadata is still public metadata. Decode a bounded number of
  // layers without requiring arbitrary documentation to be valid URL syntax.
  for (let pass = 0; pass < 3; pass++) {
    assert.ok((source || !HOME_PATH.test(value)) && !(metadata && value.toLowerCase().includes('file' + ':')), 'Publication data contains a local path or file URL.');
    assert.ok(!terms.some(term => term && value.toLowerCase().includes(term.toLowerCase())), 'Publication data contains a local private identity.');
    if (metadata) for (const email of value.match(EMAIL) ?? []) {
      assert.ok(NOREPLY.test(email) || EXAMPLE_EMAIL.test(email), 'Publication data contains an unapproved email address.');
    }
    const decoded = value.replace(/(?:%[0-9a-f]{2})+/gi, part => {
      try { return decodeURIComponent(part); } catch { return part; }
    });
    if (decoded === value) break;
    value = decoded;
  }
}

function assertIdentity(identity, { requireEmail = true } = {}) {
  assert.ok(identity && typeof identity === 'object', 'Identity must be structured public metadata.');
  assert.ok([PUBLIC_NAME, PUBLIC_LOGIN].includes(identity.name), 'Identity must use the approved public alias.');
  if (identity.email === undefined && !requireEmail) return;
  assert.ok(typeof identity.email === 'string' && NOREPLY.test(identity.email), 'Identity must use the approved GitHub noreply address.');
}

function scanMetadata(value, { privateTerms: terms = privateTerms() } = {}) {
  const seen = new Set();
  function visit(item) {
    if (typeof item === 'string') {
      scanText(item, { privateTerms: terms, metadata: true });
    } else if (item && typeof item === 'object') {
      assert.ok(!seen.has(item), 'Publication metadata must not contain cycles.');
      seen.add(item);
      for (const [key, child] of Object.entries(item)) {
        if (['author', 'committer', 'tagger', '_npmUser'].includes(key)) assertIdentity(child, { requireEmail: false });
        if (['contributors', 'maintainers'].includes(key)) {
          assert.ok(Array.isArray(child));
          for (const identity of child) assertIdentity(identity, { requireEmail: false });
        }
        visit(key); visit(child);
      }
      seen.delete(item);
    }
  }
  visit(value);
}

function assertManifest(manifest, expected, { final = false } = {}) {
  assert.ok(manifest && typeof manifest === 'object');
  assert.equal(manifest.name, expected.name); assert.equal(manifest.version, expected.version);
  assert.equal(manifest._id, `${expected.name}@${expected.version}`);
  assert.equal(manifest.gitHead, expected.commit, 'Publication must identify the reviewed sanitized commit.');
  assert.deepEqual(manifest.repository, { type: 'git', url: 'git+https://github.com/jethros-projects/dotter.git' });
  assert.equal(manifest.homepage, 'https://github.com/jethros-projects/dotter#readme');
  assert.deepEqual(manifest.bugs, { url: 'https://github.com/jethros-projects/dotter/issues' });
  assert.deepEqual(manifest.publishConfig, { access: 'public', tag: 'next' });
  const allowed = new Set(final ? ['_id', '_nodeVersion', '_npmVersion'] : ['_id']);
  for (const key of Object.keys(manifest)) {
    assert.ok(!key.startsWith('_') || allowed.has(key), 'Unexpected internal publication metadata.');
  }
  assert.ok(!Object.hasOwn(manifest, 'tag'), 'A manifest tag must not override the reviewed release channel.');
  assert.equal(Object.hasOwn(manifest, 'dist'), final, 'Unexpected distribution metadata.');
  if (manifest.author !== undefined) assertIdentity(manifest.author, { requireEmail: false });
  for (const key of ['contributors', 'maintainers']) {
    if (manifest[key] === undefined) continue;
    assert.ok(Array.isArray(manifest[key]));
    for (const identity of manifest[key]) assertIdentity(identity, { requireEmail: false });
  }
  scanMetadata(manifest);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

function publicMetadata(body) {
  const { _attachments, ...metadata } = body;
  return metadata;
}

function assertPublicationRequest(body, expected) {
  assert.deepEqual(Object.keys(body).sort(), ['_attachments', '_id', 'access', 'description', 'dist-tags', 'name', 'versions']);
  assert.equal(body.name, expected.name); assert.equal(body._id, expected.name);
  assert.equal(body.access, 'public');
  assert.deepEqual(body['dist-tags'], { next: expected.version });
  assert.deepEqual(Object.keys(body.versions), [expected.version]);
  const manifest = body.versions[expected.version];
  assertManifest(manifest, expected, { final: true });
  assert.deepEqual(Object.keys(manifest.dist).sort(), ['integrity', 'shasum', 'tarball']);
  const url = new URL(manifest.dist.tarball);
  assert.ok(['http:', 'https:'].includes(url.protocol)); assert.equal(url.hostname, 'registry.npmjs.org');
  assert.equal(url.username + url.password + url.search + url.hash, '');
  assert.equal(url.pathname, `/${expected.name}/-/${expected.name}-${expected.version}.tgz`);
  const attachments = Object.entries(body._attachments);
  assert.equal(attachments.length, 1);
  const [name, attachment] = attachments[0];
  assert.equal(name, `${expected.name}-${expected.version}.tgz`);
  assert.deepEqual(Object.keys(attachment).sort(), ['content_type', 'data', 'length']);
  assert.equal(attachment.content_type, 'application/octet-stream');
  assert.equal(typeof attachment.data, 'string');
  const bytes = Buffer.from(attachment.data, 'base64');
  assert.equal(bytes.toString('base64'), attachment.data, 'Archive must use canonical base64.');
  assert.equal(bytes.length, expected.size); assert.equal(attachment.length, expected.size);
  assert.equal(hash(bytes), expected.sha256, 'Publication archive differs from the reviewed archive.');
  assert.equal(manifest.dist.integrity, expected.integrity);
  assert.equal(manifest.dist.integrity, `sha512-${hash(bytes, 'sha512', 'base64')}`);
  assert.equal(manifest.dist.shasum, hash(bytes, 'sha1'));
  scanMetadata(publicMetadata(body));
  if (expected.metadataSha256) {
    assert.equal(hash(JSON.stringify(canonical(publicMetadata(body)))), expected.metadataSha256, 'Publication metadata changed after review.');
  }
}

function readGitIdentities(root) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const names = git(['rev-list', '--objects', '--all']).split('\n').filter(Boolean).map(line => line.split(' ')[0]);
  const objectTypes = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    cwd: root, input: names.join('\n') + '\n', encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  const identities = [];
  for (const record of objectTypes.split('\n').filter(Boolean)) {
    const [object, type] = record.split(' ');
    if (!['commit', 'tag'].includes(type)) continue;
    const header = git(['cat-file', type, object]).split('\n\n')[0];
    for (const kind of type === 'commit' ? ['author', 'committer'] : ['tagger']) {
      const line = header.split('\n').find(line => line.startsWith(`${kind} `));
      const match = line?.match(/^[a-z]+ (.+) <([^<>]+)> \d+ [+-]\d{4}$/);
      assert.ok(match, 'Reachable Git metadata has an invalid or missing identity.');
      identities.push({ kind, name: match[1], email: match[2], object });
    }
  }
  assert.ok(identities.length > 0);
  return identities;
}

function assertArchiveHeader(entry) {
  assert.ok(!entry.path.startsWith('/') && !entry.path.split('/').includes('..'), 'Unsafe archive entry path.');
  assert.ok(['File', 'Directory'].includes(entry.type), 'Archive links and special files are forbidden.');
  assert.ok(!entry.uname && !entry.gname && !entry.linkpath, 'Archive must omit local owner, group and link names.');
  scanMetadata({ path: entry.path, extended: entry.extended, globalExtended: entry.globalExtended });
}

async function scanArchive(bytes, tar) {
  let files = 0, total = 0;
  const entries = [];
  let failure;
  const parser = tar.t({ strict: true, onReadEntry(entry) {
    try { assertArchiveHeader(entry); } catch (error) { failure ??= error; }
    const chunks = [];
    entry.on('data', chunk => {
      total += chunk.length;
      if (total > 100 * 1024 * 1024) { failure ??= new Error('Archive exceeds the review limit.'); return; }
      chunks.push(chunk);
    });
    entry.on('end', () => {
      if (failure || entry.type !== 'File') return;
      try {
        files++;
        const text = Buffer.concat(chunks).toString('utf8');
        scanText(text);
        if (entry.path === 'package/package.json') scanMetadata(JSON.parse(text));
        if (entry.path === 'package/README.md') scanMetadata(text);
        entries.push(entry.path);
      } catch (error) { failure ??= error; }
    });
  } });
  parser.on('meta', text => {
    try { scanMetadata(text); } catch (error) { failure ??= error; }
  });
  await new Promise((resolve, reject) => { parser.on('error', reject); parser.on('end', resolve); parser.end(bytes); });
  if (failure) throw failure;
  assert.ok(files > 0); return { files, bytes: total, entries };
}

module.exports = { assertIdentity, scanText, scanMetadata, assertManifest, assertPublicationRequest, readGitIdentities, assertArchiveHeader, scanArchive, hash, canonical, publicMetadata };
