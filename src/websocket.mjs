import WebSocket from 'ws';
import { DotError } from './errors.mjs';
import { assertResponseEncoding, classifyResponse } from './transport.mjs';

export const WEBSOCKET_CLOSE_GRACE_MS = 1000;

function errorEvent(error) {
  const event = new Event('error');
  Object.defineProperty(event, 'error', { value: error });
  return event;
}

// Own the Node transport so cancellation has a finite TCP lifetime even when
// the peer never acknowledges the closing handshake. The adapter preserves
// the browser event interface used by DotLive and injected WebSocket factories.
export function createWebSocket(url) {
  const native = new WebSocket(url, {
    closeTimeout: WEBSOCKET_CLOSE_GRACE_MS,
    handshakeTimeout: 30_000,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
    followRedirects: false,
  });
  const socket = new EventTarget();
  let rejectingHandshake = false, handshakeClassified = false, pendingClose, closeEmitted = false;
  Object.defineProperty(socket, 'readyState', { get: () => native.readyState });
  socket.send = value => native.send(value);
  socket.close = (...args) => native.close(...args);
  socket.terminate = () => native.terminate();
  native.on('open', () => socket.dispatchEvent(new Event('open')));
  native.on('message', (data, binary) => socket.dispatchEvent(new MessageEvent('message', { data: binary ? data : data.toString() })));
  const emitClose = value => {
    if (closeEmitted) return;
    closeEmitted = true;
    const event = new Event('close');
    for (const key of ['code', 'reason', 'wasClean']) Object.defineProperty(event, key, { value: value[key] });
    socket.dispatchEvent(event);
  };
  native.addEventListener('close', value => {
    if (rejectingHandshake && !handshakeClassified) pendingClose = value;
    else emitClose(value);
  });
  native.on('error', error => {
    if (rejectingHandshake) return;
    // Protocol/size validation is not a transient connection failure. Keep
    // signed URLs and low-level transport details out of the public error.
    const projected = typeof error?.code === 'string' && error.code.startsWith('WS_ERR_')
      ? new DotError('INVALID_STREAM', 'The live connection returned an invalid WebSocket frame.') : error;
    socket.dispatchEvent(errorEvent(projected));
  });
  native.on('unexpected-response', (_request, response) => {
    rejectingHandshake = true;
    const headers = new Headers();
    for (const [key, value] of Object.entries(response.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    let complete = false, size = 0;
    const chunks = [];
    const finish = error => {
      if (complete) return;
      complete = true; clearTimeout(timer);
      response.destroy();
      try { socket.dispatchEvent(errorEvent(error)); }
      finally {
        handshakeClassified = true;
        native.terminate();
        if (pendingClose) { emitClose(pendingClose); pendingClose = undefined; }
      }
    };
    const timer = setTimeout(() => finish(new DotError('INVALID_STREAM', 'The WebSocket handshake response did not finish in time.', { status: response.statusCode })), 1000);
    response.on('error', () => finish(new DotError('INVALID_STREAM', 'The WebSocket handshake response could not be read.', { status: response.statusCode })));
    response.on('aborted', () => finish(new DotError('INVALID_STREAM', 'The WebSocket handshake response ended early.', { status: response.statusCode })));
    try { assertResponseEncoding(response.statusCode, headers); }
    catch (error) { finish(error); return; }
    if (headers.get('cf-mitigated') === 'challenge') {
      finish(classifyResponse(response.statusCode, headers, '')); return;
    }
    // Read only a bounded refusal body so a body-only edge challenge also
    // stops reconnects. Never follow redirects or retain the signed URL.
    response.on('data', chunk => {
      size += chunk.length;
      if (size > 65536) finish(new DotError('INVALID_STREAM', 'The WebSocket handshake response exceeded its size limit.', { status: response.statusCode }));
      else chunks.push(chunk);
    });
    response.on('end', () => finish(classifyResponse(response.statusCode, headers, Buffer.concat(chunks).toString('utf8'))));
  });
  return socket;
}
