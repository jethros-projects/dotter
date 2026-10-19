import { MAX_HEADERS } from './request.mjs';

const ALLOWED = new Set(['content-type', 'content-disposition', 'cf-mitigated', 'cf-ray', 'retry-after', 'x-request-id',
  'x-openai-request-id', 'location', 'openai-root-thread-id', 'content-length', 'content-range', 'accept-ranges', 'content-encoding']);
const token = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
export const bodyChallenge = body => /\/cdn-cgi\/challenge-platform\/|_cf_chl_opt|enable javascript and cookies to continue/i.test(body.toString('latin1'));

export function responseHeaders(raw) {
  const fields = new Map();
  for (let index = 0; index < raw.length; index += 2) {
    const key = raw[index].toLowerCase(), value = raw[index + 1];
    if (!fields.has(key)) fields.set(key, []);
    fields.get(key).push(value);
  }
  const headers = {};
  for (const [key, values] of fields) if (ALLOWED.has(key)) headers[key] = key === 'content-encoding' ? values.join(', ') : values[0];
  const lengths = fields.get('content-length') ?? [], transfers = fields.get('transfer-encoding') ?? [];
  const framing = lengths.length <= 1 && (!lengths.length || /^\d+$/.test(lengths[0].trim()) && !transfers.length);
  return { headers, framing, fixed: lengths.length === 1 && !transfers.length,
    challenge: fields.get('cf-mitigated')?.length === 1 && fields.get('cf-mitigated')[0] === 'challenge' };
}

// llhttp rejects invalid lengths before emitting a response. Retain only the
// bounded initial header lineage so known refusals still win, even if split
// across packets. Never interpret this prefix as a successful/absent response.
export function headerProbe() {
  let pending = Buffer.alloc(0), consumed = 0, result, stopped = false, overflow = false;
  return {
    capture(bytes) {
      if (stopped) return;
      const remaining = MAX_HEADERS - consumed - pending.length;
      pending = Buffer.concat([pending, bytes.subarray(0, Math.max(0, remaining))]);
      while (true) {
        const end = pending.indexOf('\r\n\r\n');
        if (end < 0) {
          if (pending.length + consumed >= MAX_HEADERS) { stopped = true; overflow = true; }
          return;
        }
        const lines = pending.subarray(0, end).toString('latin1').split('\r\n');
        const status = /^HTTP\/1\.[01] ([1-5]\d\d)(?: [\x20-\x7e\x80-\xff]*)?$/.exec(lines.shift());
        const raw = [];
        if (!status || lines.some(line => {
          const colon = line.indexOf(':'), name = line.slice(0, colon), value = line.slice(colon + 1).trim();
          if (colon < 1 || !token.test(name) || /[\x00-\x08\x0a-\x1f\x7f]/.test(value)) return true;
          raw.push(name, value); return false;
        })) { stopped = true; return; }
        const code = Number(status[1]);
        if (code >= 200) { result = { status: code, ...responseHeaders(raw) }; stopped = true; return; }
        if (code === 101) { stopped = true; return; }
        consumed += end + 4;
        if (consumed >= MAX_HEADERS) { stopped = true; overflow = true; return; }
        pending = pending.subarray(end + 4);
        if (!pending.length) return;
      }
    },
    refusal() { return result && (result.challenge || result.status === 401 || result.status === 403) ? result : undefined; },
    get done() { return stopped; },
    get overflow() { return overflow; },
  };
}
