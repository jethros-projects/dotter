import { Worker } from 'node:worker_threads';
import { DotError } from './errors.mjs';

const MAX_SCHEMA = 1024 * 1024;
const MAX_CONTENT = 64000;
const MAX_DEPTH = 64;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function fail(code, message, details) { throw new DotError(code, message, details); }
function cloneJson(value, depth = 0, seen = new Set()) {
  if (depth > MAX_DEPTH) fail('INVALID_ARGUMENT', 'The form schema or response is nested too deeply.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'object' || seen.has(value) || ![Object.prototype, Array.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_ARGUMENT', 'Form input must contain ordinary JSON data.');
  seen.add(value);
  const result = Array.isArray(value) ? value.map(entry => cloneJson(entry, depth + 1, seen)) : Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (RESERVED.has(key)) fail('INVALID_ARGUMENT', 'Form input contains a reserved property.');
    return [key, cloneJson(entry, depth + 1, seen)];
  }));
  seen.delete(value);
  return result;
}
function normalizeSchema(schema) {
  // Native legacy image selections are string IDs. File imports require a
  // separate native upload binding and must never be invented from a path.
  if (object(schema) && schema.type === 'openai/imagePicker') {
    if (!Array.isArray(schema.items) || schema.items.some(item => !object(item) || typeof item.id !== 'string')) fail('UNSUPPORTED_ACTION', 'The current image picker schema is invalid.');
    const { type, items, file, ...rest } = schema;
    return { ...rest, type: 'string', enum: items.map(item => item.id) };
  }
  if (object(schema)) {
    const output = { ...schema };
    for (const key of ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']) {
      if (object(schema[key])) output[key] = Object.fromEntries(Object.entries(schema[key]).map(([name, child]) => [name, normalizeSchema(child)]));
    }
    for (const key of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) if (Array.isArray(schema[key])) output[key] = schema[key].map(normalizeSchema);
    for (const key of ['not', 'if', 'then', 'else', 'additionalProperties', 'unevaluatedProperties', 'propertyNames', 'contains', 'items', 'additionalItems', 'unevaluatedItems']) {
      if (object(schema[key])) output[key] = normalizeSchema(schema[key]);
      else if (key === 'items' && Array.isArray(schema[key])) output[key] = schema[key].map(normalizeSchema);
    }
    return output;
  }
  return schema;
}

/** Validate the exact current server schema without mutating response values.
 * Local refs and all standard 2020-12 validation keywords are supported. Remote
 * refs are never fetched. Regex evaluation cannot block the main CLI thread.
 */
export async function validateActionForm(content, schema, { signal, timeoutMs = 5000, workerFactory = (url, options) => new Worker(url, options) } = {}) {
  signal?.throwIfAborted();
  if (!object(schema)) fail('UNSUPPORTED_ACTION', 'This form does not expose a JSON object schema.');
  if (!object(content)) fail('INVALID_ARGUMENT', 'The form response must be a JSON object.');
  const cleanContent = cloneJson(content), cleanSchema = normalizeSchema(cloneJson(schema));
  if (Buffer.byteLength(JSON.stringify(cleanContent)) > MAX_CONTENT || Buffer.byteLength(JSON.stringify(cleanSchema)) > MAX_SCHEMA) fail('INVALID_ARGUMENT', 'The form schema or response exceeds its size limit.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) fail('INVALID_ARGUMENT', 'Form validation timeout must be from 1 to 10000 ms.');
  return new Promise((resolve, reject) => {
    let worker, timer, settled = false;
    const finish = (error, successful = false) => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      worker?.terminate().catch(() => {});
      if (successful) resolve(cleanContent); else reject(error);
    };
    const abort = () => finish(signal.reason);
    try {
      worker = workerFactory(new URL('./action-form-worker.mjs', import.meta.url), { workerData: { schema: cleanSchema, content: cleanContent },
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }, execArgv: [] });
      worker.once('message', value => {
        if (value?.valid === true) finish(undefined, true);
        else if (value?.unsupported) finish(new DotError('UNSUPPORTED_ACTION', 'The request schema could not be validated locally. External schema references are not fetched.'));
        else finish(new DotError('INVALID_ARGUMENT', 'The response does not satisfy the current request schema.', {
          field: typeof value?.field === 'string' ? value.field.slice(0, 1024) : '', keyword: typeof value?.keyword === 'string' ? value.keyword : null }));
      });
      worker.once('error', () => finish(new DotError('FORM_VALIDATION_FAILED', 'Form validation could not complete safely.')));
      worker.once('exit', () => { if (!settled) finish(new DotError('FORM_VALIDATION_FAILED', 'Form validation ended before producing a result.')); });
      timer = setTimeout(() => finish(new DotError('FORM_VALIDATION_TIMEOUT', 'The form schema exceeded its validation time limit. No response was sent.')), timeoutMs);
      signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    } catch { finish(new DotError('FORM_VALIDATION_FAILED', 'Form validation could not start.')); }
  });
}
