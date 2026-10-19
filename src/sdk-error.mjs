const nativeErrors = new WeakMap();
// Only the CLI presentation boundary uses this compatibility projection. Native
// exceptions are never properties on public SDK errors or serialized results.
export function cliError(error) { return nativeErrors.get(error) ?? error; }

export const ErrorCode = Object.freeze(Object.fromEntries([
  'INVALID_ARGUMENT', 'AUTH_REQUIRED', 'AUTH_FAILED', 'UNSUPPORTED_OPERATION', 'NETWORK_ERROR',
  'TIMEOUT', 'ABORTED', 'CLOSED', 'RESYNC_REQUIRED', 'OPERATION_FAILED',
].map(code => [code, code])));

const messages = {
  AUTH_REQUIRED: 'A ChatGPT Codex login is required. Run dotter auth login or provide an auth loader.',
  AUTH_FAILED: 'Authentication failed or the signed-in account changed.',
  UNSUPPORTED_OPERATION: 'This operation is not supported by the service or transport.',
  NETWORK_ERROR: 'The service request failed. Check history before retrying a write.',
  TIMEOUT: 'The operation timed out. Check history before retrying a write.',
  ABORTED: 'The operation was cancelled. Check history before retrying a write.',
  CLOSED: 'The client is closed. Create a new client to continue.',
  RESYNC_REQUIRED: 'The event stream needs resynchronization. Read history and start a new watch.',
  OPERATION_FAILED: 'The operation failed. Inspect the service state before retrying a write.',
};

export class DotterError extends Error {
  constructor(code, message, details = {}) {
    super(message ?? messages[code] ?? 'The input is invalid.');
    this.name = 'DotterError';
    this.code = code;
    this.details = Object.freeze({ ...details });
    for (const key of ['status', 'requestId', 'receipt', 'deliveryState', 'nativeCode']) {
      if (details[key] !== undefined) this[key] = details[key];
    }
  }
  toJSON() { return { error: { code: this.code, message: this.message, ...this.details } }; }
}

export function sdkError(error, signal) {
  if (error instanceof DotterError) return error;
  if (signal?.aborted) return signal.reason instanceof DotterError ? signal.reason : new DotterError('ABORTED');
  const nativeCode = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : undefined;
  let code = 'OPERATION_FAILED';
  if (/^INVALID_|^FILE_|^UNSAFE_|^MISSING_|^CURSOR_LOCKED$/.test(nativeCode ?? '')) code = 'INVALID_ARGUMENT';
  if (nativeCode === 'INVALID_RESPONSE') code = 'OPERATION_FAILED';
  if (/^AUTH_(?:MISSING|EXPIRED|MODE|ACCOUNT_REQUIRED)$/.test(nativeCode ?? '')) code = 'AUTH_REQUIRED';
  else if (/^AUTH_|^ACCOUNT_CHANGED$/.test(nativeCode ?? '')) code = 'AUTH_FAILED';
  if (/^UNSUPPORTED/.test(nativeCode ?? '')) code = 'UNSUPPORTED_OPERATION';
  if (nativeCode === 'NETWORK_ERROR' || nativeCode === 'HTTP_ERROR') code = 'NETWORK_ERROR';
  if (nativeCode === 'CLOSED') code = 'CLOSED';
  if (nativeCode === 'TIMEOUT' || nativeCode === 'NETWORK_ERROR' && error?.message === 'The API request timed out.') code = 'TIMEOUT';
  if (error?.name === 'TimeoutError') code = 'TIMEOUT';
  if (error?.name === 'AbortError') code = 'ABORTED';
  if (['CURSOR_LOOP', 'PAGE_LIMIT'].includes(nativeCode)) code = 'RESYNC_REQUIRED';
  const details = {};
  if (nativeCode) details.nativeCode = nativeCode;
  if (Number.isInteger(error?.details?.status) && error.details.status >= 100 && error.details.status <= 599) details.status = error.details.status;
  if (error?.details?.delivery === 'unknown') details.deliveryState = 'unknown';
  if (error?.details?.delivery === 'not_sent') details.deliveryState = 'not_sent';
  if (typeof error?.details?.idempotencyKey === 'string' && /^[0-9a-f-]{36}$/i.test(error.details.idempotencyKey)) details.requestId = error.details.idempotencyKey;
  const result = new DotterError(code, undefined, details);
  if (error instanceof Error) nativeErrors.set(result, error);
  return result;
}
