import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { assertArchiveHeader, scanArchive, scanMetadata } from '../scripts/release-privacy.cjs';

const header = () => ({ path: 'package/fixture.txt', type: 'File', uname: '', gname: '', linkpath: '' });
const privatePath = ['', 'home', 'synthetic-owner', 'project'].join('/');

test('portable archive headers reject owners, links, home paths and PAX identities', () => {
  assert.doesNotThrow(() => assertArchiveHeader(header()));
  for (const mutation of [
    { uname: 'synthetic-owner' }, { gname: 'synthetic-group' },
    { linkpath: 'synthetic-target' }, { type: 'SymbolicLink' },
    { path: '../fixture' }, { path: privatePath },
    { extended: { syntheticLocation: privatePath } },
    { globalExtended: { syntheticLocation: privatePath } },
  ]) assert.throws(() => assertArchiveHeader({ ...header(), ...mutation }));
});

test('metadata rejects relative and drive file URIs and encoded home paths', () => {
  for (const value of [
    ['file:', './synthetic-project'].join(''),
    ['file:', 'C:/synthetic/project'].join(''),
    encodeURIComponent(privatePath), encodeURIComponent(encodeURIComponent(privatePath)),
  ]) assert.throws(() => scanMetadata({ syntheticLocation: value }));
});

// A test-owned stream adapter exercises asynchronous error propagation and raw
// PAX metadata without depending on the maintainer's npm or a global tar module.
function parserFixture({ entry = header(), meta = undefined, content = 'Synthetic offline archive.' } = {}) {
  return { t(options) {
    const parser = new EventEmitter();
    parser.end = () => {
      if (meta) parser.emit('meta', meta);
      const stream = Object.assign(new EventEmitter(), entry);
      options.onReadEntry(stream);
      stream.emit('data', Buffer.from(content));
      stream.emit('end'); parser.emit('end');
    };
    return parser;
  } };
}

test('archive scanner checks stream headers, bytes and otherwise-discarded PAX fields', async () => {
  const clean = await scanArchive(Buffer.from('fixture'), parserFixture());
  assert.equal(clean.files, 1);
  for (const fixture of [
    { entry: { ...header(), uname: 'synthetic-owner' } },
    { content: privatePath },
    { meta: `80 synthetic.location=${privatePath}\n` },
    { entry: { ...header(), path: 'package/README.md' }, content: 'fixture@synthetic-private-mail.dev' },
  ]) await assert.rejects(scanArchive(Buffer.from('fixture'), parserFixture(fixture)));
});
