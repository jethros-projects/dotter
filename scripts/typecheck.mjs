import assert from 'node:assert/strict';
import { readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));

/** Compile the same strict consumer against either the checkout or its packed install. */
export async function typecheck(directory = root, fixtures = path.join(root, 'test/types')) {
  const files = (await readdir(fixtures)).filter(file => /\.(?:[cm]?ts)$/.test(file));
  assert.ok(files.length > 0, 'At least one public TypeScript consumer fixture is required.');
  const config = path.join(directory, '.dotter-typecheck.json');
  await writeFile(config, JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext',
      lib: ['ES2022', 'DOM'], strict: true, noEmit: true,
      exactOptionalPropertyTypes: true, noUncheckedIndexedAccess: true,
      skipLibCheck: false,
    },
    files: files.map(file => path.join(fixtures, file)),
  }, null, 2));
  try {
    const result = spawnSync(process.execPath, [compiler, '--project', config], {
      cwd: directory, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `Strict TypeScript consumer failed:\n${result.stdout}\n${result.stderr}`);
  } finally {
    const { rm } = await import('node:fs/promises');
    await rm(config, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await typecheck();
  console.log('Strict TypeScript public API consumer passed.');
}
