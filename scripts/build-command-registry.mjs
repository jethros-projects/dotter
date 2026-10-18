import { readdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const allowedTypes = new Set(['string','boolean','number','path','secretPath','json','jsonFile','textFile','list']);
export async function buildRegistry({ check = false } = {}) {
  const registry = {};
  for (const file of (await readdir(path.join(root, 'src/command-sets'))).filter(name => name.endsWith('.mjs')).sort()) {
    const set = await import(pathToFileURL(path.join(root, 'src/command-sets', file)));
    if (typeof set.createClient !== 'function' || !set.commands || typeof set.commands !== 'object') throw new Error(`Invalid command set: ${file}`);
    for (const [name, item] of Object.entries(set.commands)) {
      if (registry[name]) throw new Error(`Duplicate command: ${name}`);
      if (!/^[a-z][a-z0-9 -]*$/.test(name) || typeof item.method !== 'string' || !Array.isArray(item.positionals ?? [])) throw new Error(`Invalid command: ${name}`);
      for (const [flag, field] of Object.entries(item.flags ?? {})) {
        if (!/^--[a-z][a-z0-9-]*$/.test(flag) || !allowedTypes.has(field.type) || typeof field.target !== 'string') throw new Error(`Invalid option in ${name}`);
      }
      registry[name] = { ...item, positionals: item.positionals ?? [], flags: item.flags ?? {}, set: file.replace(/\.mjs$/, '') };
    }
  }
  const stable = Object.fromEntries(Object.entries(registry).sort(([a],[b]) => a.localeCompare(b)));
  const content = JSON.stringify(stable, null, 2) + '\n';
  const target = path.join(root, 'src/v4-registry.json');
  if (check) { if (await readFile(target, 'utf8') !== content) throw new Error('Command registry is stale. Run npm run registry.'); }
  else await writeFile(target, content);
  return stable;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const registry = await buildRegistry({ check: process.argv.includes('--check') });
  console.log(`Validated ${Object.keys(registry).length} extended CLI commands.`);
}
