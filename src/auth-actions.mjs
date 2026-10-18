import { spawn } from 'node:child_process';
import path from 'node:path';
import { authStatus } from './auth.mjs';
import { DotError } from './errors.mjs';
import { VERSION } from './version.mjs';

// Official Codex app-server account/read, not private desktop IPC. Codex owns
// OAuth renewal and atomic cache updates; no refresh token crosses this API.
export async function refreshLogin({ authFile, spawnImpl = spawn, status = authStatus, timeoutMs = 30_000 } = {}) {
  if (authFile && path.basename(authFile) !== 'auth.json') throw new DotError('INVALID_ARGUMENT', 'Refresh requires a Codex home auth.json file, not an arbitrary imported cache.');
  await new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl('codex', ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'],
      env: authFile ? { ...process.env, CODEX_HOME: path.dirname(path.resolve(authFile)) } : process.env }); }
    catch { reject(new DotError('AUTH_REFRESH_FAILED', 'Could not start Codex app-server.')); return; }
    let settled = false, buffer = '', stage = 'initialize';
    const done = error => {
      if (settled) return; settled = true; clearTimeout(timer); child.kill();
      error ? reject(error) : resolve();
    };
    const timer = setTimeout(() => done(new DotError('AUTH_REFRESH_TIMEOUT', 'Codex did not finish refreshing the login.')), timeoutMs);
    child.on('error', () => done(new DotError('AUTH_REFRESH_FAILED', 'Could not start Codex app-server. Check that Codex is installed.')));
    child.on('exit', () => { if (!settled) done(new DotError('AUTH_REFRESH_FAILED', 'Codex stopped before refreshing the login.')); });
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 1_000_000) return done(new DotError('AUTH_REFRESH_FAILED', 'Codex returned too much data.'));
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let message; try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && stage === 'initialize') {
          if (message.error) return done(new DotError('AUTH_REFRESH_FAILED', 'Codex refused initialization.'));
          stage = 'account';
          child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');
          child.stdin.write(JSON.stringify({ id: 2, method: 'account/read', params: { refreshToken: true } }) + '\n');
        } else if (message.id === 2 && stage === 'account') {
          if (message.error || !message.result?.account) return done(new DotError('AUTH_REFRESH_FAILED', 'Codex could not refresh the managed login. Run auth login.'));
          done();
        }
      }
    });
    child.stdin.write(JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'dotter', version: VERSION } } }) + '\n');
  });
  const result = await status({ authFile });
  if (result.status !== 'ready') throw new DotError('AUTH_REFRESH_UNUSABLE', 'Codex responded, but this CLI still cannot read a usable file-based login. Check auth status or run auth login.');
  return { refreshed: true, ...result };
}
