import { readFile, writeFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = new URL('../', import.meta.url);
const link = file => `[${file}](../${file})`;

/** Validate the source/test map and render contributor-facing documentation. */
export async function buildCoverage({ check = false } = {}) {
  const [coverage, registry] = await Promise.all(['docs/coverage.json', 'src/v4-registry.json']
    .map(async file => JSON.parse(await readFile(new URL(file, root), 'utf8'))));
  const commands = new Map(coverage.commands.map(item => [item.command, item]));
  if (commands.size !== coverage.commands.length || commands.size !== Object.keys(registry).length) {
    throw new Error('Coverage command inventory is stale. Update docs/coverage.json.');
  }
  for (const [name, definition] of Object.entries(registry)) {
    const entry = commands.get(name);
    if (!entry || entry.commandSet !== definition.set || entry.method !== definition.method) {
      throw new Error(`Coverage mapping mismatch: ${name}`);
    }
    for (const file of [entry.implementation, entry.registration, ...entry.tests]) await access(new URL(file, root));
  }
  const lines = ['# Testing Dotter', '',
    'Run `npm run verify` to check JavaScript/Python syntax, generated documents and registry, the offline test suite, and installation from the npm tarball.', '',
    'Tests use synthetic responses and local fixtures. A passing suite does not prove that an undocumented service accepts every operation. See [contracts](contracts.md) for the boundaries.', '',
    'The [machine-readable source map](coverage.json) links each extended command to its implementation and tests. It contains no personal service-audit records.', '',
    '## Command sets', '', '| Area | Commands | Implementation | Tests |', '| --- | ---: | --- | --- |'];
  for (const set of coverage.extendedCommandSets) {
    lines.push(`| ${set.description} | ${set.commandCount} | ${link(set.implementation)} | ${set.tests.map(link).join(', ')} |`);
  }
  lines.push('', '## Established commands', '', '| Area | Commands | Tests |', '| --- | --- | --- |');
  for (const set of coverage.baseSurface) {
    lines.push(`| ${set.area} | ${set.surface.map(name => `\`${name}\``).join(', ')} | ${set.tests.map(link).join(', ')} |`);
  }
  lines.push('', '## Infrastructure', '', coverage.infrastructureTests.map(link).join(', '), '',
    'Regenerate documents after changing command definitions with `npm run registry`, `npm run docs`, and `npm run coverage:docs`.', '');
  const content = lines.join('\n');
  const target = new URL('docs/testing.md', root);
  if (check) {
    if (await readFile(target, 'utf8') !== content) throw new Error('Testing document is stale. Run npm run coverage:docs.');
  } else await writeFile(target, content);
  return commands.size;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Checked ${await buildCoverage({ check: process.argv.includes('--check') })} coverage mappings.`);
}
