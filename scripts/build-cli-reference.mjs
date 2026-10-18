import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FULL_HELP } from '../src/help.mjs';
import { v4Commands } from '../src/v4-commands.mjs';

export async function buildReference({ check = false } = {}) {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const lines = [`# Dotter ${version} command reference`, '',
    'Generated from the installed command definitions. Run `npm run docs` after changing a command.', '',
    'All API commands accept `--auth-file PATH` and `--json`. Account-wide operations use the current login; commands requiring `--account` must receive its exact account selector. `--help` on an extended command prints its flags without reading credentials.', '',
    '## Established commands', '', '```text', FULL_HELP.split('\nExtended API commands:\n')[0].trim(), '```', '',
    'The extended definitions below replace any older synopsis for the same command, including Library browse, search, and folder moves.', '',
    `## Extended commands (${Object.keys(v4Commands).length})`, ''];
  const quote = value => `\`${String(value).replaceAll('`', '\\`').replaceAll('|', '\\|')}\``;
  for (const [name, item] of Object.entries(v4Commands)) {
    lines.push(`### ${name}`, '', item.description, '', '```sh',
      `dotter ${name}${item.positionals.map((field, i) => ` ${(item.minPositionals ?? item.positionals.length) <= i ? '[' + field.toUpperCase() + ']' : field.toUpperCase()}`).join('')}`, '```', '',
      '| Option | Value | Field |', '| --- | --- | --- |');
    for (const [flag, spec] of Object.entries(item.flags)) {
      const value = spec.type === 'boolean' ? `sets ${JSON.stringify(spec.value ?? true)}` : spec.type;
      lines.push(`| ${quote(flag)} | ${value} | ${quote(spec.target)} |`);
    }
    if (!Object.keys(item.flags).length) lines.push('| — | — | — |');
    lines.push('');
    if (item.specFields) lines.push(`Accepts ${quote("--spec FILE")} containing a JSON object with: ${item.specFields.map(quote).join(', ')}. Explicit flags and spec fields cannot provide the same value.`, '');
    if (item.required?.length) lines.push(`Required fields: ${item.required.map(quote).join(', ')}.`, '');
    if (item.defaults) lines.push(`Defaults: ${quote(JSON.stringify(item.defaults))}.`, '');
    if (item.confirmMatch?.length) lines.push(`Exact confirmation: ${item.confirmMatch.map(([confirm, target]) => `${quote(confirm)} must equal ${quote(target)}`).join('; ')}.`, '');
    if (item.stream) lines.push('Long-running command; Ctrl+C stops it. Optional `--duration SECONDS` bounds runtime. Event streams emit NDJSON; browser sessions require an explicit user action to connect or take control.', '');
    if (item.key) lines.push(`Uses a UUID request key in ${quote(item.key)}; the generated or supplied key is printed before the operation. No automatic mutation retries.`, '');
  }
  lines.push('## Input types', '',
    '- `json`: inline JSON, at most 256 KiB. `jsonFile`: a UTF-8 JSON file with the same limit; its top-level shape depends on the option. A `--spec` file must be an object.',
    '- `textFile`: a regular UTF-8 file of at most 1 MiB. `secretPath`: a private credential or callback file; only commands documenting stdin accept `-`.',
    '- `list`: comma-separated values. Boolean flags take no value; use the documented negative alias to select false.',
    '- Numbers are nonnegative; each operation applies its own integer/range checks. IDs must come from the corresponding account API.', '',
    'See [workflows](workflows.md) for examples and [contracts](contracts.md) for service limits. Testing and source/test mappings are documented in the source checkout.', '');
  const content = lines.join('\n'), target = new URL('../docs/commands.md', import.meta.url);
  if (check) { if (await readFile(target, 'utf8') !== content) throw new Error('CLI reference is stale. Run npm run docs.'); }
  else await writeFile(target, content);
  return Object.keys(v4Commands).length;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`Documented ${await buildReference({ check: process.argv.includes('--check') })} extended commands.`);
}
