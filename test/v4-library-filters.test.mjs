import assert from 'node:assert/strict';
import test from 'node:test';
import { CliError } from '../src/commands.mjs';
import { run } from '../src/cli.mjs';
import { parseV4Args, prepareV4Options, runV4Command, v4Commands } from '../src/v4-commands.mjs';

const parse = argv => parseV4Args(argv[0], argv.slice(1));
const buffer = () => ({ text: '', write(value) { this.text += value; return true; } });
const cases = [
  ['library browse', [], '--files-and-folders', '--folders-only', 'foldersOnly'],
  ['library browse', [], '--exclude-files', '--include-files', 'includeFiles'],
  ['library browse', [], '--exclude-saved-entities', '--include-saved-entities', 'includeSavedEntities'],
  ['library browse', [], '--exclude-provider-roots', '--include-provider-roots', 'includeProviderRoots'],
  ['library browse', [], '--exclude-pages', '--include-pages', 'includePages'],
  ['library browse', [], '--exclude-sites', '--include-sites', 'includeSites'],
  ['library browse', [], '--exclude-folder-counts', '--include-folder-counts', 'includeFolderCounts'],
  ['library browse', [], '--exclude-onedrive', '--include-onedrive', 'includeOneDrive'],
  ['library browse', [], '--no-hydrate-folder-thumbnails', '--hydrate-folder-thumbnails', 'hydrateFolderThumbnails'],
  ['library search', [], '--not-trash', '--trash', 'trash'],
  ['library search', [], '--exclude-native-files', '--include-native-files', 'includeNativeFiles'],
  ['library search', [], '--exclude-uploaded-files', '--include-uploaded-files', 'includeUploadedFiles'],
  ['library search', [], '--exclude-imagegen-files', '--include-imagegen-files', 'includeImagegenFiles'],
  ['library search', [], '--exclude-saved-entities', '--include-saved-entities', 'includeSavedEntities'],
  ['library search', [], '--exclude-pages', '--include-pages', 'includePages'],
  ['library search', [], '--exclude-sites', '--include-sites', 'includeSites'],
  ['library search', [], '--include-space-roots', '--exclude-space-roots', 'excludeSpaceRoots'],
  ['library providers materialize', ['external-gdrive:file:ABCDE', 'Report'], '--no-index', '--index', 'indexForRetrieval'],
  ['library global-search', ['report'], '--exclude-sites', '--include-sites', 'includeSites'],
  ['library global-search', ['report'], '--exclude-pages', '--include-pages', 'includePages'],
  ['library global-search', ['report'], '--exclude-space-files', '--include-space-files', 'includeSpaceFiles'],
  ['library references thumbnail', ['ref-1'], '--no-overwrite', '--overwrite', 'overwrite']
];

for (const [name, positionals, inverse, positive, field] of cases) {
  test(`${name} preserves explicit false from ${inverse} through dispatch`, async () => {
    const definition = v4Commands[name];
    assert.deepEqual(definition.flags[inverse], { target: field, type: 'boolean', value: false });
    const options = await prepareV4Options(parse([...name.split(' '), ...positionals, inverse]));
    assert.equal(options[field], false);
    let captured;
    await runV4Command({}, options, { stdout: buffer(), stderr: buffer(), v4Invoke: async (set, method, args) => { captured = args; return {}; } });
    assert.equal(captured[field], false);
    // False must remain distinct from omission, including default-true options.
    assert.equal(parse([...name.split(' '), ...positionals])[field], undefined);
    for (const flags of [[positive, inverse], [inverse, positive]]) {
      assert.throws(() => parse([...name.split(' '), ...positionals, ...flags]), CliError);
    }
  });
}

async function invoke(argv) {
  const calls = [];
  const transport = { async request(method, route, options) { calls.push({ method, route, options }); return { items: [], cursor: null }; } };
  await run(argv, { createClient: async () => ({ transport }), stdout: buffer(), stderr: buffer() });
  return calls;
}

test('browse exclusions reach exact false-valued API query fields', async () => {
  const [call] = await invoke(['library', 'browse', '--exclude-files', '--exclude-saved-entities', '--exclude-provider-roots', '--exclude-pages', '--no-hydrate-folder-thumbnails']);
  assert.equal(call.method, 'GET');
  assert.equal(call.options.query.include_files, false);
  assert.equal(call.options.query.include_saved_entities, false);
  assert.equal(call.options.query.include_provider_roots, false);
  assert.equal(call.options.query.include_pages, false);
  assert.equal(call.options.query.hydrate_folder_thumbnails, false);
  assert.equal(call.options.query.include_hidden_files, false);
});

test('native file search exclusions reach the JSON body without being omitted', async () => {
  const [call] = await invoke(['library', 'search', '--exclude-native-files', '--exclude-uploaded-files', '--exclude-imagegen-files', '--exclude-saved-entities', '--exclude-pages', '--include-space-roots']);
  assert.equal(call.method, 'POST');
  for (const field of ['include_native_files', 'include_uploaded_files', 'include_imagegen_files', 'include_saved_entities', 'include_pages', 'exclude_space_roots']) assert.equal(call.options.body[field], false, field);
  assert.equal(call.options.body.include_hidden_files, false);
});

test('global search can request Pages without associated Space files', async () => {
  const [call] = await invoke(['library', 'global-search', 'review', '--include-pages', '--page-source', 'space', '--exclude-space-files']);
  assert.equal(call.route, '/backend-api/global/search');
  const space = call.options.body.source_requests.find(value => value.type === 'space');
  assert.ok(space, 'Page search should remain enabled');
  assert.equal(space.include_files, false);
});

test('omitting the inverse option keeps default Space file inclusion', async () => {
  const [call] = await invoke(['library', 'global-search', 'review', '--include-pages']);
  const space = call.options.body.source_requests.find(value => value.type === 'space');
  assert.ok(space);
  assert.equal(Object.hasOwn(space, 'include_files'), false);
});
