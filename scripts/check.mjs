import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildRegistry } from './build-command-registry.mjs';
import { buildReference } from './build-cli-reference.mjs';
import { buildCoverage } from './build-coverage.mjs';

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(file));
    else if (entry.isFile()) result.push(file);
  }
  return result;
}
const root = fileURLToPath(new URL('../', import.meta.url));
const sources = (await Promise.all(['src', 'bin', 'scripts'].map(name => files(path.join(root, name))))).flat();
for (const file of sources.filter(name => /\.[cm]?js$/.test(name))) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
const python = spawnSync('python3', ['-I', '-c', 'import ast,pathlib,sys; [ast.parse(pathlib.Path(p).read_text()) for p in sys.argv[1:]]', ...sources.filter(name => name.endsWith('.py'))], { stdio: 'inherit' });
if (python.error) console.error('Could not start python3 for the Python syntax check.');
if (python.status !== 0) process.exit(python.status ?? 1);
await buildRegistry({ check: true });
await buildReference({ check: true });
await buildCoverage({ check: true });
console.log('Syntax and command registry checks passed.');
