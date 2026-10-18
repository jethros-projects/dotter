import { setTimeout as delay } from 'node:timers/promises';
import { DotError } from './errors.mjs';
import { createWebSocket } from './websocket.mjs';
import { taskSubscriptionTopic } from './task-subscription.mjs';
import { streamSSE, internalStreamCallback, isInternalStreamCallback, streamConsumerCallback } from './stream-http.mjs';
import { projectTaskRecord, taskId, taskText, taskTime, taskHidden } from './task-records.mjs';

const MAX_FRAME = 1024 * 1024;
const id = value => typeof value === 'string' && /^[A-Za-z0-9_.~:-]{1,1024}$/.test(value);
const text = value => typeof value === 'string' ? value.slice(0, 64000) : null;
const hidden = value => !value || value.deleted_at != null || value.hidden || value.is_hidden || value.is_visually_hidden_from_conversation || value.is_user_visible === false || value.metadata?.hidden || value.metadata?.is_hidden || value.metadata?.is_visually_hidden_from_conversation
  || value.metadata?.deleted_at != null || value.metadata?.is_user_visible === false
  || (value.channel != null && !['final', 'commentary'].includes(value.channel)) || (value.metadata?.channel != null && !['final', 'commentary'].includes(value.metadata.channel))
  || (value.recipient != null && value.recipient !== 'all') || (value.metadata?.recipient != null && value.metadata.recipient !== 'all');
const aborted = signal => { if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError'); };
const authSubject = auth => {
  if (typeof auth.userId === 'string') return auth.userId;
  try { const claim = JSON.parse(Buffer.from(auth.accessToken.split('.')[1], 'base64url').toString('utf8')); return typeof claim.sub === 'string' ? claim.sub : null; } catch { return null; }
};
// Classification takes precedence over HTTP status: an edge challenge can use
// a transient-looking status without being safe to reconnect automatically.
const retryable = error => error instanceof DotError && (['NETWORK_ERROR', 'LIVE_DISCONNECTED', 'STREAM_TIMEOUT', 'TASK_SUBSCRIPTION_CHANGED'].includes(error.code)
  || error.code === 'RATE_LIMITED' && error.details?.status === 429
  || error.code === 'HTTP_ERROR' && (error.details?.status === 408 || error.details?.status === 429 || error.details?.status >= 500));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const CALLBACKS = ['onReady', 'onPayload', 'onResync', 'onDisconnect', 'onOffset', 'beforeSubscribe', 'resolveTopic'];
function internalLiveCallbacks(options) {
  for (const name of CALLBACKS) if (typeof options[name] === 'function') options[name] = internalStreamCallback(options[name]);
  return options;
}
const protectLiveCallback = callback => isInternalStreamCallback(callback) ? callback : streamConsumerCallback(callback, 'LIVE_CALLBACK_ERROR');

// The account-wide native task feed is separate from room/task message feeds.
// Its schema contains only visible task summaries, never execution transcripts.
export function normalizeTaskEvent(event, { dotId, taskId: selectedTaskId } = {}) {
  if (!record(event) || event.type !== 'task-upsert' || taskHidden(event) || !record(event.payload) || taskHidden(event.payload)) return null;
  const { payload } = event, update = payload.update;
  if (!taskId(payload.tbo_id) || payload.tbo_id !== dotId) return null;
  let task;
  try { task = projectTaskRecord(payload.task, { dotId, complete: true }); } catch { return null; }
  if (!task || selectedTaskId !== undefined && task.id !== selectedTaskId) return null;
  // Drop the full event if its update is private, since latest_update may repeat it.
  if (update !== null && (!record(update) || taskHidden(update) || !taskId(update.id)
      || update.task_id !== task.id || !taskText(update.text, 64000) || !taskTime(update.created_at))) return null;
  return { type: 'task-upsert', dotId,
    task: { id: task.id, title: task.title, description: task.description, status: task.status,
      latestUpdate: task.latest_update, emoji: task.emoji, createdAt: task.created_at, updatedAt: task.updated_at },
    update: update === null ? null : { id: update.id, taskId: task.id, text: update.text, createdAt: update.created_at } };
}

export function validateWebSocketURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new DotError('INVALID_STREAM_URL', 'The API returned an invalid live connection URL.'); }
  if (url.protocol !== 'wss:' || url.port || url.username || url.password || url.hash
      || !['chatgpt.com', 'openai.com'].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) {
    throw new DotError('INVALID_STREAM_URL', 'The API returned an unsupported live connection host.');
  }
  return url.toString();
}

export function normalizeActivity(item) {
  if (hidden(item) || !id(item.thread_id)) return null;
  return { threadId: item.thread_id, parentThreadId: id(item.parent_thread_id) ? item.parent_thread_id : null,
    title: text(item.title), emoji: text(item.emoji),
    status: ['in_progress', 'completed'].includes(item.status) ? item.status : null,
    outcome: ['succeeded', 'failed', 'interrupted'].includes(item.outcome) ? item.outcome : null,
    createdAt: typeof item.created_at === 'number' || typeof item.created_at === 'string' ? item.created_at : null,
    updatedAt: typeof item.updated_at === 'number' || typeof item.updated_at === 'string' ? item.updated_at : null,
    preview: !hidden(item.preview) && text(item.preview.text) && item.preview.text.trim() !== '::SKIP_COMPLETION::' ? { turnId: id(item.preview.turn_id) ? item.preview.turn_id : null, text: text(item.preview.text) } : null };
}

export function normalizeRoomLive(payload) {
  if (payload?.type !== 'calpico-room-live-state' || payload.version !== 1 || !id(payload.room_id)
      || !id(payload.subscription_id) || !Number.isSafeInteger(payload.revision) || payload.revision < 0 || !Array.isArray(payload.threads)) return null;
  return { type: 'room-live', roomId: payload.room_id, revision: payload.revision,
    threads: payload.threads.slice(0, 100).filter(item => !hidden(item) && id(item.thread_id)).map(item => ({
      threadId: item.thread_id, streamState: ['attaching', 'attached'].includes(item.stream_state) ? item.stream_state : null,
      turnId: id(item.turn_id) ? item.turn_id : null,
      turnStatus: ['in_progress', 'completed', 'failed', 'interrupted'].includes(item.turn_status) ? item.turn_status : null,
      active: typeof item.is_active === 'boolean' ? item.is_active : null,
      computerStatus: ['using_computer', 'stopped_using_computer'].includes(item.computer_status) ? item.computer_status : null,
      activity: item.activity_status && !hidden(item.activity_status) ? { type: text(item.activity_status.status_type), label: text(item.activity_status.status_label) } : null
    })) };
}

export class DotLive {
  constructor(client, { webSocketFactory = createWebSocket, streamRequest = streamSSE, sleep = delay, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.client = client; this.webSocketFactory = webSocketFactory; this.streamRequest = streamRequest; this.sleep = sleep;
    this.setTimer = setTimer; this.clearTimer = clearTimer;
  }
  async pinAccount({ requireSubject = false } = {}) {
    const transport = this.client.transport;
    const initial = await transport.authLoader({ authFile: transport.authFile });
    const accountId = initial.accountId, subject = authSubject(initial);
    if (typeof accountId !== 'string' || !accountId) throw new DotError('AUTH_ACCOUNT_MISSING', 'Live streams require a Codex login with a selected account.');
    if (requireSubject && (typeof subject !== 'string' || !subject)) throw new DotError('AUTH_USER_MISSING', 'Task-state streams require a Codex login with a known user identity.');
    transport.assertIdentity?.(initial);
    const authLoader = async options => {
      const auth = await transport.authLoader(options);
      if (auth.accountId !== accountId || subject !== null && authSubject(auth) !== subject) throw new DotError('ACCOUNT_CHANGED', 'The current Codex account differs from the live stream account.');
      transport.assertIdentity?.(auth);
      return auth;
    };
    const pinnedTransport = Object.create(transport);
    pinnedTransport.authLoader = authLoader;
    pinnedTransport.request = async (method, route, options = {}) => {
      await authLoader({ authFile: transport.authFile });
      return transport.request(method, route, { ...options, expectedAccountId: accountId });
    };
    const client = Object.create(this.client); client.transport = pinnedTransport;
    return { accountId, client, transport: pinnedTransport,
      assert: () => authLoader({ authFile: transport.authFile }),
      call: async (method, options) => { await authLoader({ authFile: transport.authFile }); return client[method](options); } };
  }
  async listActivity(options = {}) { return this.readActivity(await this.pinAccount(), options); }
  async readActivity(context, { dotId, limit = 20, cursor, signal } = {}) {
    if (!dotId) dotId = (await context.call('primary', { signal })).id;
    if (!id(dotId) || !Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor != null && (typeof cursor !== 'string' || cursor.length > 4096))) throw new DotError('INVALID_ARGUMENT', 'Use a Dot ID, a limit from 1 to 100, and a valid cursor.');
    const result = await context.transport.request('GET', `/backend-api/tbo/${encodeURIComponent(dotId)}/activity`, { query: { limit, cursor }, signal });
    if (!Array.isArray(result.data)) throw new DotError('INVALID_RESPONSE', 'The activity response did not contain a data array.');
    return { dotId, items: result.data.map(normalizeActivity).filter(Boolean), nextCursor: typeof result.next_cursor === 'string' ? result.next_cursor : null };
  }
  async taskEvents({ dotId, taskId: selectedTaskId, signal, onEvent = () => {}, onReady = () => {}, reconnect = true } = {}) {
    onEvent = streamConsumerCallback(onEvent, 'LIVE_CALLBACK_ERROR');
    onReady = streamConsumerCallback(onReady, 'LIVE_CALLBACK_ERROR');
    if (dotId !== undefined && !taskId(dotId) || selectedTaskId !== undefined && !taskId(selectedTaskId)) throw new DotError('INVALID_ARGUMENT', 'Use a valid Dot ID and optional task ID.');
    aborted(signal);
    const context = await this.pinAccount({ requireSubject: true });
    if (dotId === undefined) dotId = (await context.call('primary', { signal })).id;
    if (!taskId(dotId)) throw new DotError('INVALID_RESPONSE', 'The primary selection did not contain a valid Dot ID.');
    const seen = new Set();
    return this.subscribe(internalLiveCallbacks({ context, topic: 'tbo-tasks', signal, reconnect,
      onReady: async state => {
        await context.assert();
        if (!signal?.aborted) await onReady({ connected: state.connected, ready: true, phase: 'subscribed', recovered: state.recovered,
          dotId, ...(selectedTaskId === undefined ? {} : { taskId: selectedTaskId }), feed: 'task-state' });
      },
      // The native feed has no snapshot message. Explicitly report an offset gap;
      // callers can reconcile with `tasks`, rather than treating readiness as data.
      onResync: async () => {
        await context.assert();
        if (!signal?.aborted) await onEvent({ type: 'task-resync', dotId, ...(selectedTaskId === undefined ? {} : { taskId: selectedTaskId }) });
      },
      onPayload: async value => {
        await context.assert();
        if (signal?.aborted) return;
        const event = normalizeTaskEvent(value, { dotId, taskId: selectedTaskId });
        if (!event) return;
        const key = JSON.stringify([event.dotId, event.task.id, event.task.updatedAt, event.update?.id ?? null]);
        if (seen.has(key)) return;
        seen.add(key); while (seen.size > 1000) seen.delete(seen.values().next().value);
        await onEvent(event);
      }
    }));
  }
  // Subscription offsets recover missed frames. A failed recovery triggers a
  // fresh visible-history read; no private raw message payload is emitted.
  async watch({ roomId, all = false, taskId, signal, onEvent = () => {}, onReady = () => {}, reconnect = true } = {}) {
    onEvent = streamConsumerCallback(onEvent, 'LIVE_CALLBACK_ERROR');
    onReady = streamConsumerCallback(onReady, 'LIVE_CALLBACK_ERROR');
    if (all && (roomId || taskId)) throw new DotError('INVALID_ARGUMENT', 'Use one room or all rooms; task events require a single room.');
    if (taskId != null && !id(taskId)) throw new DotError('INVALID_ARGUMENT', 'Use a valid task ID.');
    const context = await this.pinAccount();
    if (!all) { await context.assert(); roomId = await context.client.resolveRoom(roomId, signal); }
    const group = taskId ? new AbortController() : null;
    if (group) signal = signal ? AbortSignal.any([signal, group.signal]) : group.signal;
    const seen = new Map(), anchors = new Map();
    // Native task and room feeds run together. Serialize both so their history
    // recovery and duplicate detection share one contiguous cursor.
    let dispatch = Promise.resolve();
    const enqueue = work => { const next = dispatch.then(work); dispatch = next.catch(() => {}); return next; };
    const deliver = async (result, room, recovered) => {
      await context.assert();
      for (const message of result.messages) {
        if (signal?.aborted) return;
        const key = `${room}:${message.id}`, version = JSON.stringify(message);
        if (seen.get(key) === version) continue;
        seen.set(key, version);
        await onEvent({ type: 'message', roomId: room, message, recovered });
      }
      while (seen.size > 5000) seen.delete(seen.keys().next().value);
    };
    const drain = async (room, recovered) => {
      const anchor = anchors.get(room);
      if (!anchor) {
        const latest = await context.call('history', { roomId: room, limit: 20, taskId, signal });
        await deliver(latest, room, recovered); anchors.set(room, latest.newestItemId);
        return false;
      }
      let cursor = anchor, newest = anchor; const cursors = new Set(); let complete = false;
      for (let page = 0; page < 100; page++) {
        const result = await context.call('history', { roomId: room, limit: 20, taskId, after: cursor, signal });
        await deliver(result, room, recovered); newest = result.newestItemId ?? newest;
        if (!result.nextCursor) { complete = true; break; }
        if (cursors.has(result.nextCursor)) throw new DotError('CURSOR_LOOP', 'The API repeated a live recovery cursor.');
        cursors.add(result.nextCursor); cursor = result.nextCursor;
      }
      if (!complete) throw new DotError('PAGE_LIMIT', 'Live recovery exceeded 100 history pages.');
      // Only a completely consumed forward traversal advances this watermark.
      // A targeted around-read or a recent snapshot can jump over unseen rows.
      anchors.set(room, newest);
      return true;
    };
    const resync = async room => {
      if (await drain(room, true)) {
        const latest = await context.call('history', { roomId: room, limit: 20, taskId, signal });
        await deliver(latest, room, true);
      }
    };
    const emitMessages = async (room, around, recovered = false) => {
      // Keep the contiguous watermark current during healthy sessions too.
      // Otherwise a later failed websocket recovery must replay the entire
      // session and can exceed the bounded recovery page count.
      await drain(room, recovered);
      if (around) {
        const result = await context.call('history', { roomId: room, limit: 20, taskId, around, signal });
        await deliver(result, room, recovered);
      }
    };
    const rooms = async () => all ? [...new Set((await context.call('listDots', { signal })).map(dot => dot.roomId).filter(Boolean))] : [roomId];
    const common = internalLiveCallbacks({ context, signal, reconnect,
      onReady: state => onReady({ connected: state.connected, ready: true, phase: 'subscribed', recovered: state.recovered, roomId: roomId ?? null, all, ...(taskId ? { taskId, feed: 'task' } : {}) }),
      onResync: () => enqueue(async () => { await onEvent({ type: 'resync', roomId: roomId ?? null, ...(taskId ? { taskId } : {}) }); for (const room of await rooms()) await resync(room); }),
      onDisconnect: () => onEvent({ type: 'typing-reset', roomId: roomId ?? null }),
      onPayload: event => enqueue(async () => {
        const payload = event?.payload;
        if (!payload || typeof event.type !== 'string') return;
        const room = event.type === 'calpico-room-update' ? payload.room?.id : payload.room_id;
        if (!id(room) || (!all && room !== roomId)) return;
        if (event.type === 'calpico-message-add' || event.type === 'calpico-message-update') {
          const messageId = payload.message_id ?? payload.message?.id;
          const eventTask = payload.message?.task_id ?? payload.task_id;
          if (taskId && eventTask != null && eventTask !== taskId) return;
          await emitMessages(room, id(messageId) ? messageId : undefined); return;
        }
        if (event.type === 'calpico-is-responding-heartbeat' && payload.source?.role === 'user' && id(payload.source.account_user_id)) {
          await onEvent({ type: 'typing', roomId: room, accountUserId: payload.source.account_user_id, typing: payload.typing !== false });
        } else if (event.type === 'calpico-room-read-receipt' && id(payload.account_user_id)) {
          await onEvent({ type: 'read-receipt', roomId: room, accountUserId: payload.account_user_id, lastReadAt: text(payload.last_read_at), updatedAt: text(payload.read_cursor_updated_at) });
        } else if (event.type === 'calpico-room-read') await onEvent({ type: 'read', roomId: room, lastReadAt: text(payload.last_read_at) });
        else if (['calpico-room-update', 'calpico-room-metadata-update', 'calpico-room-leave'].includes(event.type)) {
          await onEvent({ type: event.type === 'calpico-room-leave' ? 'leave' : 'room', roomId: room,
            ...(id(payload.room?.aeon_id) ? { dotId: payload.room.aeon_id } : {}) });
        }
      }) });
    if (!taskId) return this.subscribe({ ...common, topic: all ? 'calpico-chatgpt-messaging-all' : 'calpico-chatgpt-messaging' });
    const resolveTaskTopic = async () => {
      const value = await context.transport.request('GET', `/backend-api/messaging/rooms/${encodeURIComponent(roomId)}/tasks/${encodeURIComponent(taskId)}/subscription`, { signal });
      return taskSubscriptionTopic(value, { roomId, taskId });
    };
    const taskFeed = this.subscribe(internalLiveCallbacks({ ...common, resolveTopic: resolveTaskTopic,
      beforeSubscribe: async topic => {
        if (await resolveTaskTopic() !== topic) throw new DotError('TASK_SUBSCRIPTION_CHANGED', 'The task event subscription changed; reconnecting to the current topic.');
      } }));
    const roomFeed = this.subscribe(internalLiveCallbacks({ ...common, topic: 'calpico-chatgpt-messaging', onReady: () => {},
      onPayload: event => {
        if (event?.type === 'calpico-is-responding-heartbeat') return;
        if (['calpico-message-add', 'calpico-message-update'].includes(event?.type)
            && (event.payload?.message?.task_id ?? event.payload?.task_id) !== taskId) return;
        return common.onPayload(event);
      } }));
    try { await Promise.all([taskFeed, roomFeed]); }
    catch (error) { group.abort(); await Promise.allSettled([taskFeed, roomFeed]); throw error; }
    finally { group.abort(); }
  }
  async activity({ dotId, signal, onEvent = () => {}, onReady = () => {}, reconnect = true } = {}) {
    onEvent = streamConsumerCallback(onEvent, 'LIVE_CALLBACK_ERROR');
    onReady = streamConsumerCallback(onReady, 'LIVE_CALLBACK_ERROR');
    const context = await this.pinAccount();
    if (!dotId) dotId = (await context.call('primary', { signal })).id;
    if (!id(dotId)) throw new DotError('INVALID_ARGUMENT', 'Use a valid Dot ID.');
    let failures = 0;
    while (!signal?.aborted) {
      let snapshot = false, watchdog, timeoutError;
      const controller = new AbortController();
      const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
      try {
        await context.assert();
        const expired = new Promise((_, reject) => {
          watchdog = this.setTimer(() => {
            timeoutError = new DotError('STREAM_TIMEOUT', 'The activity stream did not provide a snapshot within 60 seconds.');
            controller.abort(timeoutError); reject(timeoutError);
          }, 60000);
        });
        const stream = this.streamRequest(context.transport, 'GET', `/backend-api/tbo/${encodeURIComponent(dotId)}/activity/stream`, { signal: combined,
          onReady: internalStreamCallback(async value => { aborted(combined); await context.assert(); await onReady({ ...value, dotId, ready: false, phase: 'connected' }); }),
          onEvent: internalStreamCallback(async event => {
            aborted(combined); await context.assert();
            if (!['snapshot', 'upsert', 'remove'].includes(event.event)) return;
            let data;
            try { data = JSON.parse(event.data); } catch { throw new DotError('INVALID_STREAM', 'The activity stream contained invalid JSON.'); }
            if (event.event === 'snapshot') {
              if (!data || !Array.isArray(data.data)) throw new DotError('INVALID_STREAM', 'The activity snapshot did not contain a data array.');
              snapshot = true; failures = 0; this.clearTimer(watchdog);
              const page = await this.readActivity(context, { dotId, limit: 5, signal: combined });
              await onReady({ connected: true, ready: true, phase: 'snapshot', dotId });
              aborted(combined);
              await onEvent({ type: 'activity-snapshot', ...page });
            } else if (event.event === 'upsert' || event.event === 'remove') {
              if (!snapshot) throw new DotError('INVALID_STREAM', 'Activity updates arrived before a snapshot.');
              if (event.event === 'remove' && id(data.thread_id)) await onEvent({ type: 'activity-remove', dotId, threadId: data.thread_id });
              else if (event.event === 'upsert') { const item = normalizeActivity(data); if (item) await onEvent({ type: 'activity-upsert', dotId, item }); }
            }
          }) });
        await Promise.race([stream, expired]);
        if (!snapshot) throw new DotError('INVALID_STREAM', 'The activity stream ended before its snapshot.');
        if (!reconnect) return;
      } catch (error) { if (signal?.aborted) return; const failure = timeoutError ?? error; if (!reconnect || !retryable(failure)) throw failure; }
      finally { this.clearTimer(watchdog); controller.abort(); }
      if (signal?.aborted) return;
      if (++failures > 20) throw new DotError('LIVE_DISCONNECTED', 'The activity stream exhausted its reconnect attempts.');
      await this.sleep(Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5)), undefined, { signal });
    }
  }
  async roomLive({ roomId, signal, onEvent = () => {}, onReady = () => {}, reconnect = true } = {}) {
    onEvent = streamConsumerCallback(onEvent, 'LIVE_CALLBACK_ERROR');
    onReady = streamConsumerCallback(onReady, 'LIVE_CALLBACK_ERROR');
    const context = await this.pinAccount();
    roomId = await context.client.resolveRoom(roomId, signal);
    let subscription, revision = -1, pending = new Map(), streamController, streamPromise, watchdog, stateReady = false;
    const emit = async payload => {
      if (payload.subscription_id !== subscription || payload.revision <= revision) return;
      revision = payload.revision;
      if (payload.type === 'calpico-room-live-error') throw new DotError(payload.code === 'temporarily_unavailable' ? 'LIVE_DISCONNECTED' : 'ROOM_UNAVAILABLE', 'The room live stream is unavailable.');
      const state = normalizeRoomLive(payload); if (state) {
        this.clearTimer(watchdog); await context.assert();
        if (!stateReady) { stateReady = true; await onReady({ connected: true, ready: true, phase: 'state', roomId }); }
        if (!signal?.aborted) await onEvent(state);
      }
    };
    try {
      return await this.subscribe(internalLiveCallbacks({ context, topic: `calpico-room-live:${roomId}`, signal, reconnect,
        onDisconnect: () => { this.clearTimer(watchdog); streamController?.abort(); subscription = undefined; revision = -1; stateReady = false; pending.clear(); },
        onReady: async state => {
          streamController?.abort(); streamPromise?.catch(() => {});
          this.clearTimer(watchdog);
          streamController = new AbortController();
          const combined = signal ? AbortSignal.any([signal, streamController.signal]) : streamController.signal;
          await context.assert();
          watchdog = this.setTimer(() => {
            const error = new DotError('STREAM_TIMEOUT', 'The room live stream did not provide matching state within 30 seconds.');
            streamController.abort(error); state.fail(error);
          }, 30000);
          streamPromise = this.streamRequest(context.transport, 'POST', `/backend-api/messaging/rooms/${roomId}/live`, { signal: combined,
            onEvent: internalStreamCallback(async event => {
              aborted(combined); await context.assert();
              let data; try { data = JSON.parse(event.data); } catch { throw new DotError('INVALID_STREAM', 'The room live stream contained invalid JSON.'); }
              if (data.type !== 'calpico-room-live-ready' || data.version !== 1 || data.room_id !== roomId || !id(data.subscription_id)) throw new DotError('INVALID_STREAM', 'The room live subscription reply was invalid.');
              if (subscription && subscription !== data.subscription_id) throw new DotError('INVALID_STREAM', 'The room live subscription changed unexpectedly.');
              subscription = data.subscription_id; await onReady({ connected: state.connected, ready: false, phase: 'subscribed', recovered: state.recovered, roomId });
              const queued = pending.get(subscription); pending.clear(); if (queued) await emit(queued);
            }) });
          // Handling this here avoids unhandled rejections; subscribe is told
          // immediately so its socket is closed and retried with a fresh pair.
          streamPromise.then(() => { if (!combined.aborted) state.fail(new DotError('LIVE_DISCONNECTED', 'The room live subscription ended.')); }, error => { if (!combined.aborted) state.fail(error); });
        },
        onPayload: async event => {
          const payload = event?.type === 'calpico-room-live' ? event.payload : null;
          if (!payload || payload.room_id !== roomId || !id(payload.subscription_id) || !Number.isSafeInteger(payload.revision)) return;
          if (subscription) return emit(payload);
          const old = pending.get(payload.subscription_id);
          if (!old || old.revision < payload.revision) pending.set(payload.subscription_id, payload);
          while (pending.size > 4) pending.delete(pending.keys().next().value);
        }, onResync: () => {} }));
    } finally { this.clearTimer(watchdog); streamController?.abort(); /* A custom transport may ignore cancellation; suppress its late rejection. */ streamPromise?.catch(() => {}); }
  }
  async subscribe({ context, topic, resolveTopic, beforeSubscribe, signal, reconnect = true, onReady = () => {}, onPayload = () => {}, onResync = () => {}, onDisconnect = () => {} }) {
    onReady = protectLiveCallback(onReady); onPayload = protectLiveCallback(onPayload);
    onResync = protectLiveCallback(onResync); onDisconnect = protectLiveCallback(onDisconnect);
    if (resolveTopic) resolveTopic = protectLiveCallback(resolveTopic);
    if (beforeSubscribe) beforeSubscribe = protectLiveCallback(beforeSubscribe);
    context ??= await this.pinAccount();
    let offset, failures = 0, previousTopic;
    while (!signal?.aborted) {
      try {
        if (resolveTopic) topic = await resolveTopic();
        if (previousTopic != null && topic !== previousTopic) offset = undefined;
        previousTopic = topic;
        const response = await context.transport.request('GET', '/backend-api/celsius/ws/user', { signal });
        const url = validateWebSocketURL(response.websocket_url);
        await context.assert();
        await this.socketSession(url, internalLiveCallbacks({ topic, offset, signal, beforeSubscribe: async () => { await context.assert(); await beforeSubscribe?.(topic); },
          onReady: async state => { failures = 0; await onReady(state); },
          onOffset: value => { offset = value; },
          onPayload: async value => { await context.assert(); await onPayload(value); },
          onResync: async () => { await context.assert(); await onResync(); } }));
        if (!reconnect || signal?.aborted) return;
      } catch (error) { if (signal?.aborted) return; if (!reconnect || !retryable(error)) throw error; }
      await onDisconnect();
      if (++failures > 20) throw new DotError('LIVE_DISCONNECTED', 'The live connection exhausted its reconnect attempts.');
      await this.sleep(Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5)), undefined, { signal });
    }
  }
  async socketSession(url, { topic, offset, signal, beforeSubscribe, onReady, onOffset, onPayload, onResync }) {
    onReady = protectLiveCallback(onReady); onOffset = protectLiveCallback(onOffset);
    onPayload = protectLiveCallback(onPayload); onResync = protectLiveCallback(onResync);
    if (beforeSubscribe) beforeSubscribe = protectLiveCallback(beforeSubscribe);
    aborted(signal);
    let socket;
    try { socket = this.webSocketFactory(url); } catch { throw new DotError('LIVE_DISCONNECTED', 'The live connection could not be opened.'); }
    let chain = Promise.resolve(), settled = false, subscribed = false, timer, queuedBytes = 0, pendingFrames = 0;
    return new Promise((resolve, reject) => {
      const finish = error => {
        if (settled) return; settled = true; this.clearTimer(timer);
        signal?.removeEventListener('abort', abort);
        for (const [name, handler] of Object.entries(handlers)) socket.removeEventListener(name, handler);
        try { socket.close(); } catch {}
        chain.catch(() => {}).then(() => error ? reject(error instanceof DotError ? error : new DotError('INVALID_STREAM', 'The live connection failed unexpectedly.')) : resolve());
      };
      const abort = () => finish();
      const queue = work => { chain = chain.then(() => settled ? undefined : work()).catch(finish); };
      const message = async record => {
        if (!record || typeof record !== 'object') return;
        if (record.type === 'message' && record.topic_id === topic) {
          await onPayload(record.payload);
          if (typeof record.offset === 'string' && record.offset.length <= 4096) await onOffset(record.offset);
        } else if (record.id === 2) {
          const reply = record.reply;
          if (subscribed || reply?.type !== 'subscribe' || reply.topic_id !== topic || typeof reply.recovered !== 'boolean'
              || (reply.catchups != null && (!Array.isArray(reply.catchups) || reply.catchups.length > 1000))) throw new DotError('INVALID_STREAM', 'The live subscription reply was invalid.');
          subscribed = true; this.clearTimer(timer);
          await onReady({ connected: true, recovered: reply.recovered, fail: finish });
          if (settled) return;
          if (reply.recovered) for (const item of reply.catchups ?? []) await message(item);
          if (typeof reply.last_offset === 'string' && reply.last_offset.length <= 4096) await onOffset(reply.last_offset);
          if (!offset || !reply.recovered) await onResync();
        }
      };
      const handlers = {
        open: () => queue(async () => {
          await beforeSubscribe?.();
          if (settled) return;
          try { socket.send(JSON.stringify([{ id: 1, command: { type: 'connect', presence: { type: 'presence', state: 'background' } } },
            { id: 2, command: { type: 'subscribe', topic_id: topic, ...(offset ? { offset } : {}) } }])); }
          catch { finish(new DotError('LIVE_DISCONNECTED', 'The live subscription could not be sent.')); }
        }),
        message: event => {
          if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > MAX_FRAME) return finish(new DotError('INVALID_STREAM', 'The live connection returned an oversized or binary frame.'));
          const bytes = Buffer.byteLength(event.data);
          queuedBytes += bytes; pendingFrames++;
          if (queuedBytes > 8 * MAX_FRAME || pendingFrames > 100) return finish(new DotError('STREAM_TOO_LARGE', 'The live connection exceeded its pending event limit.'));
          queue(async () => {
            try {
              let records; try { records = JSON.parse(event.data); } catch { throw new DotError('INVALID_STREAM', 'The live connection returned invalid JSON.'); }
              if (!Array.isArray(records)) return;
              if (records.length > 1000) throw new DotError('INVALID_STREAM', 'The live frame contained too many events.');
              for (const record of records) { if (settled) break; await message(record); }
            } finally { queuedBytes -= bytes; pendingFrames--; }
          });
        },
        error: event => queue(() => finish(event?.error instanceof DotError ? event.error : new DotError('LIVE_DISCONNECTED', 'The live connection ended unexpectedly.'))),
        close: () => queue(() => finish(subscribed ? undefined : new DotError('LIVE_DISCONNECTED', 'The live connection closed before subscribing.')))
      };
      for (const [name, handler] of Object.entries(handlers)) socket.addEventListener(name, handler);
      signal?.addEventListener('abort', abort, { once: true });
      timer = this.setTimer(() => finish(new DotError('STREAM_TIMEOUT', 'The live connection did not subscribe within 30 seconds.')), 30000);
      if (signal?.aborted) abort();
    });
  }
}
