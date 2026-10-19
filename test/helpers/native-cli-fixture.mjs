import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Keep the executable, SDK, request validation, and Node HTTP wire path real.
// Only the final socket destination changes: no request can reach the service.
export async function nativeCliFixture(t, {
  prefix = 'dot-native-cli-', status = 200,
  headers = { 'content-type': 'application/json' }, value = {}, raw,
  networkFailure = false, respond,
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const logFile = join(directory, 'requests.ndjson');
  const calls = [];
  const connections = [];
  const bySocket = new WeakMap();
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const call = { request: {
        method: request.method,
        url: `https://${request.headers.host}${request.url}`,
        headers: request.headers,
        ...(body ? { body } : {}),
      }, connectionId: bySocket.get(request.socket).id, closed: false };
      calls.push(call);
      appendFileSync(logFile, `${JSON.stringify(call)}\n`, { mode: 0o600 });
      request.socket.once('close', () => { call.closed = true; });
      if (respond) { respond(call.request, response); return; }
      if (networkFailure) { request.socket.destroy(); return; }
      response.writeHead(status, headers);
      response.end(raw ?? JSON.stringify(value));
    });
  });
  server.on('connection', socket => {
    const connection = { id: connections.length + 1, closed: false };
    connections.push(connection);
    bySocket.set(socket, connection);
    socket.once('close', () => { connection.closed = true; });
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const preload = join(directory, 'loopback.mjs');
  await writeFile(preload, `import https from 'node:https';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
// Match the pooled agent to the redirected HTTP socket destination.
https.Agent = http.Agent;
https.request = function (url, options, receive) {
  const target = new URL(url);
  if (target.origin !== 'https://chatgpt.com' || !target.pathname.startsWith('/backend-api/')) {
    throw new Error('The offline CLI fixture forbids this destination.');
  }
  const destination = new URL('http://127.0.0.1:${server.address().port}');
  destination.pathname = target.pathname;
  destination.search = target.search;
  return http.request(destination, { ...options, headers: { ...options.headers, Host: target.host } }, receive);
};
syncBuiltinESMExports();
`, { mode: 0o600 });
  return {
    directory,
    calls,
    connections,
    logFile,
    nodeArgs: ['--import', preload],
    env: { PATH: directory, LANG: 'C.UTF-8' },
    run: nodeArgs => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', preload, ...nodeArgs], {
        cwd: directory,
        // No Python or other executables are available through PATH.
        env: { PATH: directory, LANG: 'C.UTF-8' },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10_000,
      });
      let stdout = '', stderr = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
    }),
  };
}
