import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { DotError } from './errors.mjs';
import { invalid, requestOptions, MAX_HEADERS } from './http-node/request.mjs';
import { verifiedFile } from './http-node/file.mjs';
import { bodyChallenge, headerProbe, responseHeaders } from './http-node/response.mjs';

const failed = () => new DotError('NETWORK_ERROR', 'The HTTPS request failed before a complete response was received.', { delivery: 'unknown' });
const tooLarge = () => new DotError('RESPONSE_TOO_LARGE', 'The HTTPS response exceeded its size limit.', { delivery: 'unknown' });
const closed = delivery => new DotError('CLOSED', 'The HTTPS transport is closed.', { delivery });
const response = (status, headers, body) => new Response([204, 205, 304].includes(status) ? null : body, { status, headers });

/** One ordinary HTTPS request. No redirects, cookies, proxies, retries, or decoding. */
export async function nodeFetch(url, options = {}, { requestImpl = httpsRequest, getAgent, lifetimeSignal } = {}) {
  let selected;
  try { selected = requestOptions(url, options); }
  catch (error) { throw error instanceof DotError ? error : invalid('The HTTPS request could not be validated.'); }
  const signal = lifetimeSignal ? selected.signal ? AbortSignal.any([selected.signal, lifetimeSignal]) : lifetimeSignal : selected.signal;
  let file, started = false;
  try {
    signal?.throwIfAborted();
    if (selected.bodyFile != null) file = await verifiedFile(selected.bodyFile, { ...selected, signal });
    signal?.throwIfAborted();
    return await new Promise((resolve, reject) => {
      let req, incoming, socket, settled = false, timer, uploadFinished = !file, uploadTask, sentBytes = 0, responseFailed, remoteEOF = false, flushed;
      const probe = headerProbe();
      const onRemoteEnd = () => { remoteEOF = true; };
      const capture = bytes => {
        probe.capture(bytes);
        if (probe.done) socket?.removeListener('data', capture);
        if (probe.overflow) finish(failed());
      };
      const cleanup = () => {
        clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
        socket?.removeListener('data', capture);
        socket?.removeListener('end', onRemoteEnd);
      };
      const finish = (value, success = false) => {
        if (settled) return;
        settled = true; cleanup();
        success ? resolve(value) : reject(value);
        // Node returns complete, drained responses to their Agent. Destroy any
        // connection whose response was stopped early or could not be trusted.
        if (!(success && incoming?.complete && incoming.readableEnded && req?.writableFinished)) {
          incoming?.destroy(); req?.destroy();
        }
      };
      const onAbort = () => finish(signal.reason);
      const networkError = error => {
        if (settled) return;
        // Parser errors can occur after a valid response prefix was emitted.
        // Let that owner retain its bounded refusal/challenge prefix.
        if (incoming) { responseFailed ? responseFailed() : finish(failed()); return; }
        const refusal = error?.code?.startsWith('HPE_') && probe.refusal();
        if (refusal && uploadFinished) {
          try { return finish(response(refusal.status, refusal.headers, Buffer.alloc(0)), true); } catch {}
        }
        finish(failed());
      };
      const receiveBody = res => {
        incoming = res;
        if (settled) { res.destroy(); return; }
        if (!uploadFinished || !Number.isInteger(res.statusCode) || res.statusCode < 200 || res.statusCode > 599) {
          finish(file && !uploadFinished ? new DotError('FILE_CHANGED', 'The upload source was not completely transmitted.', { delivery: 'unknown' }) : failed()); return;
        }
        const selectedHeaders = responseHeaders(res.rawHeaders), { headers, challenge, framing, fixed } = selectedHeaders;
        let size = 0;
        const chunks = [];
        const drain = () => {
          let bytes;
          while (!settled && (bytes = res.read()) !== null) {
            size += bytes.length;
            if (size > selected.maximum) { finish(tooLarge()); return; }
            chunks.push(bytes);
          }
        };
        const complete = () => {
          if (settled) return;
          try { finish(response(res.statusCode, headers, Buffer.concat(chunks)), true); } catch { finish(failed()); }
        };
        const incomplete = () => {
          if (settled) return;
          // llhttp may reject a later chunk before the readable event for an
          // already decoded prefix runs. Drain only the parser's queued bytes.
          drain(); if (settled) return;
          const body = Buffer.concat(chunks);
          // Refusals cannot become safe to retry. Complete absence and success
          // require valid framing; a confirmed body challenge remains definitive.
          if (res.statusCode === 401 || res.statusCode === 403
              || [404, 410].includes(res.statusCode) && bodyChallenge(body)
              || remoteEOF && fixed && framing && res.statusCode >= 300 && ![404, 410].includes(res.statusCode)) complete();
          else finish(failed());
        };
        responseFailed = incomplete;
        res.on('error', incomplete);
        res.on('aborted', incomplete);
        res.on('close', () => { if (!res.complete) incomplete(); });
        if (challenge) { complete(); return; }
        if (!framing) { incomplete(); return; }
        res.on('readable', drain);
        res.on('end', () => res.complete ? complete() : incomplete());
      };
      const receive = res => {
        if (!file) {
          // A complete success cannot certify a buffered upload while its
          // outgoing bytes are still queued. Refusals/challenges stay prompt.
          if (selected.body?.length && !req.writableFinished && res.statusCode >= 200 && res.statusCode < 300
              && !responseHeaders(res.rawHeaders).challenge) {
            incoming = res; res.pause(); res.on('error', () => {});
            flushed.then(() => receiveBody(res), () => {});
          } else receiveBody(res);
          return;
        }
        incoming = res;
        // A peer may respond as soon as the final write reaches its socket,
        // while our final filesystem check is still pending. Pause the body
        // until that check and request completion have both settled.
        res.pause(); res.on('error', () => {});
        if (sentBytes !== file.length) {
          finish(new DotError('FILE_CHANGED', 'The upload source was not completely transmitted.', { delivery: 'unknown' })); return;
        }
        uploadTask.then(async () => {
          if (settled) return;
          await file.check(); receiveBody(res);
        }).catch(error => finish(error instanceof DotError || signal?.aborted ? error : failed()));
      };
      try {
        const headers = { ...selected.headers };
        if (file || selected.body !== undefined) {
          for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-length') delete headers[key];
          headers['Content-Length'] = String(file?.length ?? selected.body.length);
        }
        file?.start();
        const agent = getAgent ? getAgent() : false;
        started = true;
        req = requestImpl(selected.url, { method: selected.method, headers, agent,
          maxHeaderSize: MAX_HEADERS, insecureHTTPParser: false, rejectUnauthorized: true }, receive);
        // Node otherwise silently drops headers after its default count limit.
        // The explicit byte limit bounds collection without hiding encodings.
        req.maxHeadersCount = 0;
        req.on('error', networkError);
        if (selected.body?.length) {
          flushed = new Promise((resolve, reject) => {
            req.once('finish', resolve);
            req.once('error', reject);
            req.once('close', () => { if (!req.writableFinished) reject(failed()); });
          });
          flushed.catch(networkError);
        }
        req.once('socket', value => {
          socket = value; socket.prependListener('data', capture); socket.once('end', onRemoteEnd);
        });
        // An upgrade is neither an ordinary response nor permission to switch protocols.
        req.on('upgrade', (_res, upgraded) => { upgraded.destroy(); finish(failed()); });
        timer = setTimeout(() => responseFailed ? responseFailed() : finish(failed()), selected.timeoutMs);
        timer.unref?.();
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) { onAbort(); return; }
        if (!file) { req.end(selected.body); return; }
        const write = bytes => new Promise((written, rejected) => req.write(bytes, error => error ? rejected(error) : written()));
        uploadTask = (async () => {
          for await (const bytes of file.chunks()) {
            if (settled) return;
            sentBytes += bytes.length;
            await write(bytes);
          }
          if (settled) return;
          await file.check();
          await new Promise((ended, rejected) => {
            req.once('finish', () => { uploadFinished = true; ended(); });
            req.once('error', rejected); req.end();
          });
        })();
        uploadTask.catch(error => finish(error instanceof DotError || signal?.aborted ? error : failed()));
      } catch { finish(failed()); }
    });
  } catch (error) {
    if (lifetimeSignal?.aborted && signal?.reason === lifetimeSignal.reason && error === signal.reason) throw closed(started ? 'unknown' : 'not_sent');
    throw error;
  } finally { await file?.close(); }
}

/** A client-owned pool. Construction and closing an unused pool perform no I/O. */
export function createNodeFetch({ requestImpl = httpsRequest, AgentImpl = HttpsAgent } = {}) {
  let agent, closing, isClosed = false;
  const lifetime = new AbortController(), pending = new Set();
  const getAgent = () => {
    lifetime.signal.throwIfAborted();
    return agent ??= new AgentImpl({ keepAlive: true, maxSockets: 8, maxTotalSockets: 16,
      maxFreeSockets: 2, timeout: 10000, maxCachedSessions: 32 });
  };
  const fetch = (url, options) => {
    if (isClosed) return Promise.reject(closed('not_sent'));
    const operation = nodeFetch(url, options, { requestImpl, getAgent, lifetimeSignal: lifetime.signal });
    pending.add(operation);
    operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  };
  fetch.close = () => {
    if (!closing) {
      isClosed = true;
      closing = Promise.resolve().then(async () => {
        lifetime.abort(new DotError('CLOSED', 'The HTTPS transport is closed.'));
        await Promise.allSettled([...pending]);
        const owned = agent; agent = undefined; owned?.destroy();
      });
    }
    return closing;
  };
  return fetch;
}
