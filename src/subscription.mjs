import { DotterError } from './sdk-error.mjs';

// A bounded, single-consumer queue. Overflow is an explicit terminal error;
// callers can reload history using the last completely consumed native cursor.
export function createSubscription({ controller, capacity = 256, cleanup = () => {} }) {
  const queue = [];
  let pending, ended = false, failure, cursor = null, readySettled = false;
  let resolveDone, rejectDone, resolveReady, rejectReady;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  done.catch(() => {}); ready.catch(() => {});
  const settle = (error, discard = false) => {
    if (ended) return;
    ended = true; failure = error;
    if (discard) queue.length = 0;
    cleanup();
    if (!readySettled) {
      readySettled = true;
      rejectReady(error ?? (controller.signal.aborted
        ? new DotterError('ABORTED', 'The stream was cancelled before it became ready.')
        : new DotterError('OPERATION_FAILED', 'The stream ended before it became ready.')));
    }
    if (error) { queue.length = 0; rejectDone(error); } else resolveDone();
    if (pending) { const waiter = pending; pending = undefined; if (error) waiter.reject(error); else waiter.resolve({ done: true, value: undefined }); }
  };
  const subscription = {
    done, ready,
    get cursor() { return cursor; },
    async cancel() { queue.length = 0; controller.abort(); settle(); await done.catch(() => {}); },
    [Symbol.asyncIterator]() { return this; },
    next() {
      if (queue.length) {
        const value = queue.shift();
        if (value.type === 'cursor') cursor = value.anchor;
        return Promise.resolve({ done: false, value });
      }
      if (ended) return failure ? Promise.reject(failure) : Promise.resolve({ done: true, value: undefined });
      if (pending) return Promise.reject(new DotterError('INVALID_ARGUMENT', 'Only one pending stream read is supported.'));
      return new Promise((resolve, reject) => { pending = { resolve, reject }; });
    },
    async return() { await this.cancel(); return { done: true, value: undefined }; },
  };
  return {
    subscription,
    finish: settle,
    push(event) {
      if (ended || controller.signal.aborted) return;
      if (event.type === 'ready' && !readySettled) { readySettled = true; resolveReady(); }
      if (pending) { const waiter = pending; pending = undefined; if (event.type === 'cursor') cursor = event.anchor; waiter.resolve({ done: false, value: event }); }
      else if (queue.length < capacity) queue.push(event);
      else { const error = new DotterError('RESYNC_REQUIRED', 'The event buffer filled. Read history and start a new watch.'); controller.abort(error); settle(error); }
    },
  };
}
