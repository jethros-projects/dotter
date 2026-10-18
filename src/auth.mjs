import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { DotError } from './errors.mjs';

export function authPath({ authFile, env = process.env, home = homedir() } = {}) {
  return path.resolve(authFile ?? path.join(env.CODEX_HOME || path.join(home, '.codex'), 'auth.json'));
}

function expiration(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return Number.isFinite(payload.exp) ? payload.exp * 1000 : null;
  } catch { return null; }
}

// Read the Codex cache in place. Never copy it, modify it, refresh it, or return
// the refresh/id tokens. The CLI delegates login and renewal to Codex itself.
export async function loadAuth(options = {}) {
  const file = authPath(options);
  let source;
  try { source = await (options.readFile ?? readFile)(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new DotError('AUTH_MISSING', 'No Codex login found. Run dotter auth login.', { authFile: file });
    throw new DotError('AUTH_UNREADABLE', 'Cannot read the Codex login file.', { authFile: file });
  }
  let data;
  try { data = JSON.parse(source); }
  catch { throw new DotError('AUTH_INVALID', 'The Codex login file is not valid JSON. Run dotter auth login.', { authFile: file }); }
  const tokens = data?.tokens;
  if ((data?.auth_mode && data.auth_mode !== 'chatgpt') || typeof tokens?.access_token !== 'string' || !tokens.access_token) {
    throw new DotError('AUTH_MODE', 'A ChatGPT Codex login is required. API-key login cannot read Dot messages.', { authFile: file });
  }
  if (/[\r\n]/.test(tokens.access_token) || (tokens.account_id != null && (typeof tokens.account_id !== 'string' || /[\r\n]/.test(tokens.account_id)))) {
    throw new DotError('AUTH_INVALID', 'The Codex login contains invalid credential data.', { authFile: file });
  }
  const expiresAt = expiration(tokens.access_token);
  if (expiresAt !== null && expiresAt <= (options.now ?? Date.now)()) {
    throw new DotError('AUTH_EXPIRED', 'The cached Codex login has expired. Run dotter auth login or let Codex renew it.', { authFile: file });
  }
  return { accessToken: tokens.access_token, accountId: tokens.account_id || null, expiresAt, authFile: file };
}

export async function authStatus(options = {}) {
  try {
    const auth = await loadAuth(options);
    return { status: 'ready', mode: 'chatgpt', authFile: auth.authFile,
      hasAccountSelector: Boolean(auth.accountId),
      accountId: auth.accountId,
      expiresAt: auth.expiresAt === null ? null : new Date(auth.expiresAt).toISOString() };
  } catch (error) {
    if (!(error instanceof DotError)) throw error;
    return { status: 'unavailable', mode: 'chatgpt', ...error.toJSON() };
  }
}
