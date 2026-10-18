import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { validateActionForm } from '../src/action-forms.mjs';
const object = properties => ({ type: 'object', properties, additionalProperties: false });

test('local references, allOf and conditionals enforce the actual response', async () => {
  const schema = { ...object({ mode: { enum: ['one', 'many'] }, count: { $ref: '#/$defs/count' } }), required: ['mode', 'count'],
    $defs: { count: { allOf: [{ type: 'integer' }, { minimum: 1, maximum: 10 }] } },
    if: { properties: { mode: { const: 'one' } } }, then: { properties: { count: { const: 1 } } }, else: { properties: { count: { minimum: 2 } } } };
  for (const value of [{ mode: 'one', count: 1 }, { mode: 'many', count: 2 }]) assert.deepEqual(await validateActionForm(value, schema), value);
  for (const value of [{ mode: 'one', count: 2 }, { mode: 'many', count: 1 }, { mode: 'many', count: 1.5 }]) await assert.rejects(validateActionForm(value, schema), { code: 'INVALID_ARGUMENT' });
});

test('oneOf, anyOf, not and dependentRequired enforce cross-field rules', async () => {
  const schema = { type: 'object', properties: { a: { anyOf: [{ type: 'string' }, { type: 'integer' }] }, b: { type: 'boolean' }, c: {} },
    oneOf: [{ required: ['a'] }, { required: ['c'] }], not: { required: ['c', 'b'] }, dependentRequired: { a: ['b'] } };
  await validateActionForm({ a: 'yes', b: true }, schema); await validateActionForm({ c: 1 }, schema);
  for (const value of [{ a: 'yes' }, { a: 1, b: true, c: 2 }, { c: 1, b: false }]) await assert.rejects(validateActionForm(value, schema), { code: 'INVALID_ARGUMENT' });
});

test('2020-12 prefixItems, contains counts and unevaluatedProperties are supported', async () => {
  const schema = { allOf: [{ type: 'object', properties: { values: { type: 'array', prefixItems: [{ const: 'header' }], items: { type: 'integer' }, contains: { minimum: 3, type: 'integer' }, minContains: 1, maxContains: 1 } } }], unevaluatedProperties: false };
  await validateActionForm({ values: ['header', 1, 3] }, schema);
  await assert.rejects(validateActionForm({ values: ['header', 3, 4] }, schema), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(validateActionForm({ values: ['header', 3], extra: true }, schema), { code: 'INVALID_ARGUMENT' });
});

test('draft-07 and 2019-09 use their correct dialects', async () => {
  await validateActionForm({ x: [1, 'ok'] }, { $schema: 'http://json-schema.org/draft-07/schema#', ...object({ x: { type: 'array', items: [{ type: 'integer' }, { type: 'string' }], additionalItems: false } }) });
  await validateActionForm({ x: 1 }, { $schema: 'https://json-schema.org/draft/2019-09/schema', ...object({ x: { type: 'integer' } }) });
});

test('complex patterns run safely outside the CLI thread and can accept matching values', async () => {
  const schema = object({ x: { type: 'string', pattern: '^(?:AB|CD)-(\\d+)\\1$' } });
  await validateActionForm({ x: 'AB-1212' }, schema);
  await assert.rejects(validateActionForm({ x: 'CD-1234' }, schema), { code: 'INVALID_ARGUMENT' });
});

test('numeric multipleOf, propertyNames, patternProperties and string formats work', async () => {
  const schema = { type: 'object', propertyNames: { pattern: '^(amount|email|x[0-9]+)$' }, properties: { amount: { type: 'number', multipleOf: 0.5 }, email: { type: 'string', format: 'email' } }, patternProperties: { '^x': { type: 'boolean' } }, additionalProperties: false };
  await validateActionForm({ amount: 2.5, email: 'user@example.com', x1: true }, schema);
  for (const value of [{ amount: 2.2 }, { email: 'bad' }, { bad: true }, { x1: 'true' }]) await assert.rejects(validateActionForm(value, schema), { code: 'INVALID_ARGUMENT' });
});

test('schema defaults and coercion never alter the submitted response', async () => {
  const content = { x: 1 }; const schema = object({ x: { type: 'integer' }, y: { type: 'string', default: 'no' } });
  assert.deepEqual(await validateActionForm(content, schema), { x: 1 }); assert.deepEqual(content, { x: 1 });
  await assert.rejects(validateActionForm({ x: '1' }, schema), { code: 'INVALID_ARGUMENT' });
});

test('external references and unknown dialects fail without downloading a schema', async () => {
  await assert.rejects(validateActionForm({ x: 1 }, object({ x: { $ref: 'https://untrusted.example/schema' } })), { code: 'UNSUPPORTED_ACTION' });
  await assert.rejects(validateActionForm({}, { $schema: 'https://untrusted.example/dialect', type: 'object' }), { code: 'UNSUPPORTED_ACTION' });
});

test('resource choices remain bound to the exact requested options', async () => {
  const field = { type: 'array', items: { type: 'string', format: 'uri' }, 'x-openai-input': { type: 'resource', options: [{ uri: 'resource://one' }] } };
  await validateActionForm({ files: ['resource://one'] }, object({ files: field }));
  await assert.rejects(validateActionForm({ files: ['file:///private/file'] }, object({ files: { ...field, 'x-openai-input': { ...field['x-openai-input'], userOptions: { kind: 'file' } } } })), { code: 'INVALID_ARGUMENT' });
});

test('legacy image IDs are supported but local-path imports are not fabricated', async () => {
  const schema = object({ image: { type: 'openai/imagePicker', items: [{ id: 'image-1', title: 'One', image: 'data:image/png;base64,AA==' }], file: { accept: ['.png'] } } });
  await validateActionForm({ image: 'image-1' }, schema);
  await assert.rejects(validateActionForm({ image: 'file:///a.png' }, schema), { code: 'INVALID_ARGUMENT' });
});

test('schema literals are not rewritten as schemas', async () => {
  const literal = { type: 'openai/imagePicker', items: [] };
  await validateActionForm({ value: literal }, object({ value: { const: literal } }));
});

test('recursive references validate bounded nested data', async () => {
  const node = { type: 'object', properties: { next: { $ref: '#/$defs/node' }, value: { type: 'integer' } }, additionalProperties: false };
  await validateActionForm({ next: { next: { value: 1 } } }, { ...node, $defs: { node } });
});

test('reserved properties, prototypes, cycles, non-finite and overlong input fail before a worker', async () => {
  const recursive = {}; recursive.a = recursive;
  const inputs = [recursive, Object.assign(Object.create({ x: true }), { a: 1 }), { x: Infinity }, JSON.parse('{"__proto__":true}')];
  for (const content of inputs) await assert.rejects(validateActionForm(content, object({})), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(validateActionForm({ x: 'a'.repeat(64001) }, object({ x: {} })), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(validateActionForm({}, { type: 'object', description: 'a'.repeat(1024 * 1024) }), { code: 'INVALID_ARGUMENT' });
});

test('validation errors never include input secrets or schema enum literals', async () => {
  await assert.rejects(validateActionForm({ password: 'SECRET-INPUT' }, object({ password: { enum: ['SECRET-SCHEMA'] } })), error => error.code === 'INVALID_ARGUMENT' && !JSON.stringify(error).includes('SECRET') && !error.message.includes('SECRET'));
});

test('worker resources, abort, timeout and failure are bounded', async () => {
  let options; const fake = new EventEmitter(); fake.terminate = async () => { fake.terminated = true; };
  await assert.rejects(validateActionForm({}, object({}), { timeoutMs: 10, workerFactory: (_, value) => { options = value; return fake; } }), { code: 'FORM_VALIDATION_TIMEOUT' });
  assert.equal(fake.terminated, true); assert.equal(options.resourceLimits.maxOldGenerationSizeMb, 64); assert.deepEqual(options.execArgv, []);
  const controller = new AbortController(); const waiting = new EventEmitter(); waiting.terminate = async () => {};
  const promise = validateActionForm({}, object({}), { signal: controller.signal, workerFactory: () => waiting }); controller.abort(); await assert.rejects(promise, { name: 'AbortError' });
  const broken = new EventEmitter(); broken.terminate = async () => {};
  const failure = validateActionForm({}, object({}), { workerFactory: () => broken }); broken.emit('error', new Error('SECRET')); await assert.rejects(failure, { code: 'FORM_VALIDATION_FAILED' });
});

test('pathological regex is terminated while the main event loop remains responsive', async () => {
  let tick = false; const timer = setTimeout(() => { tick = true; }, 10);
  await assert.rejects(validateActionForm({ x: `${'a'.repeat(5000)}!` }, object({ x: { type: 'string', pattern: '^(a+)+$' } }), { timeoutMs: 100 }), { code: 'FORM_VALIDATION_TIMEOUT' });
  clearTimeout(timer); assert.equal(tick, true);
});

test('async schema extensions cannot masquerade as a successful validation', async () => {
  await assert.rejects(validateActionForm({ x: 1 }, { $async: true, ...object({ x: { type: 'string' } }) }), { code: 'UNSUPPORTED_ACTION' });
});
