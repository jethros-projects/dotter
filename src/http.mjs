import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DotError } from './errors.mjs';

const helper = fileURLToPath(new URL('./http.py', import.meta.url));
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const MAX_BYTES = 100 * 1024 * 1024;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalidResponse = () => new DotError('NETWORK_ERROR', 'The HTTPS transport returned an invalid response.', { delivery: 'unknown' });

function helperResponse(envelope, maximum) {
  if (!record(envelope)) throw invalidResponse();
  if (Object.hasOwn(envelope, 'error')) {
    if (typeof envelope.error !== 'string' || !envelope.error || ['status', 'headers', 'body'].some(key => Object.hasOwn(envelope, key))) throw invalidResponse();
    const code = ['RESPONSE_TOO_LARGE', 'FILE_CHANGED', 'INVALID_FILE'].includes(envelope.error) ? envelope.error : 'NETWORK_ERROR';
    // Only source validation can establish that no request bytes were sent.
    // Network and response errors cannot become safe-to-retry from an envelope.
    const delivery = ['FILE_CHANGED', 'INVALID_FILE'].includes(code) && ['not_sent', 'unknown'].includes(envelope.delivery)
      ? envelope.delivery : 'unknown';
    throw new DotError(code, code === 'FILE_CHANGED' ? 'The upload source changed; no further request was sent.'
      : code === 'INVALID_FILE' ? 'The upload source could not be read as a verified regular file.'
      : 'The HTTPS request failed before a complete response was received.', { delivery });
  }
  if (!Number.isInteger(envelope.status) || envelope.status < 200 || envelope.status > 599
    || typeof envelope.body !== 'string' || !record(envelope.headers)) throw invalidResponse();
  const names = new Set();
  for (const [name, value] of Object.entries(envelope.headers)) {
    if (typeof value !== 'string' || names.has(name.toLowerCase())) throw invalidResponse();
    names.add(name.toLowerCase());
  }
  // Buffer.from(base64) silently ignores malformed characters and padding.
  // Accept only the canonical encoding emitted by the Python helper.
  // Avoid repeated-group regexes here: large valid downloads can exceed the
  // regexp engine's stack. Re-encoding below also verifies exact padding.
  if (envelope.body.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(envelope.body)) throw invalidResponse();
  const body = Buffer.from(envelope.body, 'base64');
  if (body.toString('base64') !== envelope.body) throw invalidResponse();
  if (body.length > maximum) throw new DotError('RESPONSE_TOO_LARGE', 'The HTTPS response exceeded its size limit.', { delivery: 'unknown' });
  try { return new Response([204, 205, 304].includes(envelope.status) ? null : body, { status: envelope.status, headers: envelope.headers }); }
  catch { throw invalidResponse(); }
}

// Use the same standard-library transport that was verified against this API.
// Sensitive headers are sent through stdin, not argv, the environment, or disk.
export function pythonFetch(url, options = {}, { spawnImpl = spawn } = {}) {
  if (!record(options)) return Promise.reject(new DotError('INVALID_ARGUMENT', 'HTTPS request options must be an object.', { delivery: 'not_sent' }));
  if (options.signal?.aborted) return Promise.reject(options.signal.reason);
  return new Promise((resolve, reject) => {
    const maximum = options.maxBytes === undefined ? DEFAULT_MAX_BYTES : options.maxBytes;
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > MAX_BYTES
      || options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 600000)) {
      reject(new DotError('INVALID_ARGUMENT', 'Invalid HTTPS response limit or timeout.', { delivery: 'not_sent' })); return;
    }
    if (options.body != null && options.bodyFile != null) {
      reject(new DotError('INVALID_ARGUMENT', 'Only one HTTPS request body may be supplied.', { delivery: 'not_sent' })); return;
    }
    let input;
    try {
      input = JSON.stringify({ url: String(url), method: options.method, headers: options.headers,
        ...(typeof options.body === 'string' ? { body: options.body } : options.body != null ? { bodyBase64: Buffer.from(options.body).toString('base64') } : {}),
        ...(options.bodyFile === undefined ? {} : { bodyFile: options.bodyFile }),
        maxBytes: options.maxBytes, timeoutMs: options.timeoutMs, signedFile: options.signedFile === true,
        signedUpload: options.signedUpload === true, realtimeSdp: options.realtimeSdp === true,
        ...(options.azureMultipart === undefined ? {} : { azureMultipart: options.azureMultipart }) });
    } catch { reject(new DotError('INVALID_ARGUMENT', 'The HTTPS request could not be serialized.', { delivery: 'not_sent' })); return; }
    const maxEnvelope = Math.ceil(maximum * 4 / 3) + 65536;
    let settled = false, size = 0;
    const chunks = [];
    let child, spawned = false;
    const stop = () => {
      try { child?.stdin?.destroy(); } catch {}
      try { child?.stdout?.destroy(); } catch {}
      try { child?.kill(); } catch {}
    };
    const finish = (value, success = false) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener('abort', onAbort);
      success ? resolve(value) : reject(value);
    };
    const onAbort = () => { finish(options.signal.reason); stop(); };
    const startError = (error, synchronous = false) => {
      if (settled) return;
      if (error?.code === 'ENOENT' && !spawned) finish(new DotError('PYTHON_REQUIRED', 'Python 3 is required for the HTTPS transport. Install Python 3 and try again.', { delivery: 'not_sent' }));
      else if (error?.name === 'AbortError') {
        finish(options.signal?.aborted ? options.signal.reason : error);
      }
      else finish(new DotError('NETWORK_ERROR', 'The HTTPS transport could not complete the request.', { delivery: synchronous ? 'not_sent' : 'unknown' }));
      stop();
    };
    try { child = spawnImpl('python3', ['-I', helper], { stdio: ['pipe', 'pipe', 'ignore'], signal: options.signal }); }
    catch (error) { startError(error, true); return; }
    child.once('spawn', () => { spawned = true; });
    child.on('error', startError);
    child.stdin.on('error', () => { if (settled) return; finish(new DotError('NETWORK_ERROR', 'The HTTPS request pipe failed.', { delivery: 'unknown' })); stop(); });
    child.stdout.on('error', () => { if (settled) return; finish(new DotError('NETWORK_ERROR', 'The HTTPS response pipe failed.', { delivery: 'unknown' })); stop(); });
    child.stdout.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > maxEnvelope) {
        finish(new DotError('RESPONSE_TOO_LARGE', 'The HTTPS response exceeded its size limit.', { delivery: 'unknown' }));
        stop();
      } else chunks.push(chunk);
    });
    child.on('close', code => {
      if (settled) return;
      if (code !== 0) return finish(new DotError('NETWORK_ERROR', 'The HTTPS transport stopped before returning a response.', { delivery: 'unknown' }));
      let envelope;
      try { envelope = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { return finish(invalidResponse()); }
      try { finish(helperResponse(envelope, maximum), true); }
      catch (error) { finish(error); }
    });
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) { onAbort(); return; }
    try { child.stdin.end(input); }
    catch { finish(new DotError('NETWORK_ERROR', 'The HTTPS request pipe failed.', { delivery: 'unknown' })); stop(); }
  });
}
