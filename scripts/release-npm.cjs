const assert = require('node:assert/strict');
const { readFileSync, realpathSync } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

// Public npm source fingerprints, not personal data. Re-review the adapter and
// its offline request tests before accepting a different npm implementation.
const reviewed = {
  'lib/commands/publish.js': 'a2935f57c4b5224167c7de30eef29bff05f7cd136e6177a534ce4ac87334f3b8',
  'node_modules/libnpmpublish/lib/publish.js': '39b4994968f6699004c0200ae12cadf328c8d838534315c1978672bf3dd15401',
  'node_modules/npm-registry-fetch/lib/index.js': '9757d6aa767884be9e566ebfeaca76c94d80bbea854b41a42ce8648feb2fca42',
};

function assertNpmAdapter(npmCli) {
  const root = path.resolve(path.dirname(realpathSync(npmCli)), '..');
  assert.equal(JSON.parse(readFileSync(path.join(root, 'package.json'))).version, '11.11.1', 'Release adapter requires reviewed npm 11.11.1.');
  for (const [file, digest] of Object.entries(reviewed)) {
    assert.equal(createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex'), digest, 'npm source changed; publication must be reviewed again.');
  }
  return '11.11.1';
}

module.exports = { assertNpmAdapter };
