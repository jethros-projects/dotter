import { parentPort, workerData } from 'node:worker_threads';
import Ajv from 'ajv';
import Ajv2019 from 'ajv/dist/2019.js';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

// Schemas are data, not code. No custom functions, async loaders, filesystem or
// network loaders are installed. Compilation and regexes run only in this
// memory-limited, time-limited disposable worker.
try {
  const { schema, content } = workerData;
  const draft = schema?.$schema;
  const Class = draft?.includes('draft-07') || draft?.includes('draft-06') ? Ajv
    : draft?.includes('2019-09') ? Ajv2019 : Ajv2020;
  const validator = new Class({ strict: false, allErrors: false, ownProperties: true,
    coerceTypes: false, useDefaults: false, removeAdditional: false, validateFormats: true,
    code: { optimize: false }, logger: false });
  addFormats(validator);
  validator.addKeyword({ keyword: 'x-openai-input', schemaType: 'object',
    validate(input, value) {
      if (input.type !== 'resource' || !Array.isArray(input.options)) return false;
      const supplied = Array.isArray(value) ? value : [value];
      // The Dot messaging runtime does not expose a local-upload handback.
      // Accept only resources that came from this exact pending request.
      return supplied.every(uri => typeof uri === 'string' && input.options.some(option => option?.uri === uri));
    }, errors: false });
  const validate = validator.compile(schema);
  if (validate.$async) throw new Error('Async schemas are unsupported');
  const valid = validate(content);
  if (valid) parentPort.postMessage({ valid: true });
  else {
    const issue = validate.errors?.[0];
    parentPort.postMessage({ valid: false, field: issue?.instancePath ?? '', keyword: issue?.keyword ?? null });
  }
} catch {
  parentPort.postMessage({ unsupported: true });
}
