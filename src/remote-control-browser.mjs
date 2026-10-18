/** Browser WebRTC controller. No microphone or local-screen capture is requested. */
const SPECIAL = { Backspace: 65288, Tab: 65289, Enter: 65293, Escape: 65307, Delete: 65535, Insert: 65379,
  Home: 65360, End: 65367, PageUp: 65365, PageDown: 65366, ArrowLeft: 65361, ArrowUp: 65362, ArrowRight: 65363, ArrowDown: 65364,
  Shift: 65505, Control: 65507, Alt: 65513, Meta: 65511, AltGraph: 65027, CapsLock: 65509, NumLock: 65407, ScrollLock: 65300 };
export function keysymForEvent(event, platform = '') {
  let key = SPECIAL[event.key];
  if (/^F(?:[1-9]|1\d|2[0-4])$/.test(event.key)) key = 65469 + Number(event.key.slice(1));
  if (key == null && typeof event.key === 'string' && [...event.key].length === 1) {
    const value = event.key.codePointAt(0); key = value <= 255 ? value : 0x01000000 | value;
  }
  if (key == null) return null;
  if (event.location === 2 && ['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) key++;
  if (/(Mac|iPhone|iPod|iPad)/i.test(platform)) key = ({ 65511: 65507, 65515: 65513, 65516: 65515, 65513: 65406, 65514: 65027 })[key] ?? key;
  return key;
}
/** Verified Neko binary framing: opcode, uint16 payload length, little-endian payload. */
export function encodeRemoteInput(kind, value) {
  if (kind === 'move' || kind === 'scroll') {
    const scroll = kind === 'scroll', low = scroll ? -32768 : 0, high = scroll ? 32767 : 65535;
    if (![value.x, value.y].every(number => Number.isInteger(number) && number >= low && number <= high)) throw new Error('Remote coordinates are out of range.');
    const data = new ArrayBuffer(7), view = new DataView(data); view.setUint8(0, scroll ? 2 : 1); view.setUint16(1, 4, true);
    (scroll ? view.setInt16 : view.setUint16).call(view, 3, value.x, true); (scroll ? view.setInt16 : view.setUint16).call(view, 5, value.y, true); return data;
  }
  if (!['down', 'up'].includes(kind) || !Number.isSafeInteger(value.key) || value.key <= 0 || value.key > 0xffffffff) throw new Error('Remote key is out of range.');
  const data = new ArrayBuffer(11), view = new DataView(data); view.setUint8(0, kind === 'down' ? 3 : 4); view.setUint16(1, 8, true); view.setBigUint64(3, BigInt(value.key), true); return data;
}
export function remoteCoordinates(event, element) {
  const box = element.getBoundingClientRect(), width = element.videoWidth, height = element.videoHeight;
  if (!(box.width > 0 && box.height > 0 && width > 0 && height > 0 && width <= 65535 && height <= 65535)) return null;
  const scale = Math.min(box.width / width, box.height / height), visibleWidth = width * scale, visibleHeight = height * scale;
  const x = event.clientX - box.left - (box.width - visibleWidth) / 2, y = event.clientY - box.top - (box.height - visibleHeight) / 2;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > visibleWidth || y > visibleHeight) return null;
  return { x: Math.min(width - 1, Math.round(x / scale)), y: Math.min(height - 1, Math.round(y / scale)) };
}
export function createBrowserRemoteSession({ api, PeerConnection, platform = '', onStatus = () => {}, onRemoteStream = () => {}, onClipboard = () => {}, readClipboard, writeClipboard, hasFocus = () => true, readyTimeoutMs = 30000, controlTimeoutMs = 15000, outcomeTimeoutMs = 1000, clipboardTimeoutMs = 200, createStream = tracks => new MediaStream(tracks) }) {
  let peer, channel, started = false, closed = false, active = false, mode = 'observing', requested = false, controlAuthorized = false, handoffPending = false, handoffSent = false;
  let configured = false, remoteHandoff, readyTimer, controlTimer, disconnectTimer, readyResolve, readyReject, stopPromise;
  let playback = false, framePresented = false, successReported = false, outcomeAck, outcomeTimer, clipboardSync = false, clipboardAck, clipboardTimer, keyQueue = Promise.resolve(), lastLocalClipboard, inputEpoch = 0;
  const pressed = new Set(), pressedCodes = new Map(), mouseKeys = new Set();
  const status = (state, message) => onStatus({ state, mode, message });
  const json = value => { if (channel?.readyState !== 'open') throw new Error('The remote data channel is closed.'); channel.send(JSON.stringify(value)); };
  function releaseControl(notifyRemote = true) {
    inputEpoch++; keyQueue = Promise.resolve();
    const usable = channel?.readyState === 'open';
    if (usable && mode === 'controlling') for (const key of pressed) { try { channel.send(encodeRemoteInput('up', { key })); } catch {} }
    pressed.clear(); pressedCodes.clear(); mouseKeys.clear(); requested = false; controlAuthorized = false; clearTimeout(controlTimer); mode = 'observing';
    clipboardAck?.(); clipboardAck = null; clearTimeout(clipboardTimer);
    if (usable && notifyRemote) { try { json({ event: 'control/release' }); } catch {} }
    if (active && !closed) status('active', 'Viewing. Take control to use mouse and keyboard.');
  }
  function maybeReady() {
    if (closed || !configured || peer?.connectionState !== 'connected' || channel?.readyState !== 'open') return;
    if (remoteHandoff && !handoffSent) { handoffSent = true; handoffPending = true; json({ event: 'browser/handoff', conversation_id: remoteHandoff.conversationId, tab_id: remoteHandoff.tabId }); status('connecting', 'Waiting for the selected browser tab…'); }
    if (handoffPending) return;
    active = true; clearTimeout(readyTimer); readyResolve?.(); status('active', 'Viewing. Take control to use mouse and keyboard.');
    reportSuccess();
  }
  function reportSuccess() {
    if (!closed && active && playback && framePresented && !successReported && channel?.readyState === 'open') {
      json({ client: 'codex', event: 'browser/client_outcome', outcome: 'success', reason: 'video_playing' }); successReported = true;
    }
  }
  function videoPlaying() { if (!closed) { playback = true; reportSuccess(); } }
  function videoFrame() { if (!closed) { framePresented = true; reportSuccess(); } }
  function videoPaused() { playback = false; framePresented = false; }
  function stop(reason = 'Remote session ended.', errorReason) {
    if (stopPromise) return stopPromise;
    let finish;
    stopPromise = new Promise(resolve => { finish = resolve; });
    closed = true; active = false;
    void (async () => {
      try {
        releaseControl(); clearTimeout(readyTimer); clearTimeout(disconnectTimer); readyReject?.(new Error('Remote session ended.'));
        try { onRemoteStream(null); } catch {}
        try { onClipboard(''); } catch {}
        try { status('ended', reason); } catch {}
        clipboardSync = false;
        let ack;
        if (errorReason && ['video_error', 'connection_error', 'handoff_error'].includes(errorReason) && channel?.readyState === 'open') {
          ack = new Promise(resolve => { outcomeAck = resolve; outcomeTimer = setTimeout(resolve, outcomeTimeoutMs); });
          try { json({ client: 'codex', event: 'browser/client_outcome', outcome: 'error', reason: errorReason }); } catch { outcomeAck?.(); }
        }
        if (ack) await ack;
      } finally {
        clearTimeout(outcomeTimer); outcomeAck = null;
        try { channel?.close(); } catch {}
        try { peer?.close(); } catch {}
        try { await api('stop', {}); } catch {}
      }
    })().then(finish, finish);
    return stopPromise;
  }
  function inputFailed() { void stop('The remote input channel failed.', 'connection_error'); return false; }
  function receive(event) {
    if (typeof event.data !== 'string' || event.data.length > 1024 * 1024) return;
    let value; try { value = JSON.parse(event.data); } catch { return; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    if (value.event === 'browser/client_outcome/ack') { outcomeAck?.(); return; }
    if (closed) return;
    switch (value.event) {
      case 'control/locked':
        if (mode === 'controlling' && active) return;
        if (!requested || !controlAuthorized || !active || handoffPending) { json({ event: 'control/release' }); return; }
        mode = 'controlling'; requested = false; clearTimeout(controlTimer); status('active', 'You have control. Return control when finished.'); break;
      case 'control/release': releaseControl(false); break;
      case 'control/clipboard':
        if (typeof value.text === 'string' && value.text.length <= 1024 * 1024) {
          onClipboard(value.text); lastLocalClipboard = undefined; clipboardAck?.(); clipboardAck = null; clearTimeout(clipboardTimer);
          if (clipboardSync && mode === 'controlling' && hasFocus() && typeof writeClipboard === 'function') {
            const epoch = inputEpoch;
            void (async () => {
              try { await writeClipboard(value.text); }
              catch { if (!closed && active && mode === 'controlling' && clipboardSync && epoch === inputEpoch) status('active', 'The browser did not allow clipboard synchronization.'); }
            })();
          }
        } break;
      case 'browser/handoff/ready': if (handoffPending) { handoffPending = false; maybeReady(); } break;
      case 'browser/handoff/error': if (handoffPending) void stop('The selected browser tab could not be opened.', 'handoff_error'); break;
      case 'error': void stop('The remote service reported an error.', 'connection_error'); break;
      // Native passkey providers require the app bridge. Refuse requests instead
      // of letting them hang or attempting to read hardware credentials.
      case 'browser/webauthn/request': if (typeof value.request?.request_id === 'string') json({ event: 'browser/webauthn/response', request_id: value.request.request_id, approved: false }); break;
    }
  }
  async function start() {
    if (started || closed) throw new Error('This remote session has already been started.');
    started = true; status('connecting', 'Connecting to the remote computer…');
    try {
      if (!PeerConnection) throw new Error('This browser does not support WebRTC.');
      peer = new PeerConnection(); peer.addTransceiver('audio', { direction: 'recvonly' }); peer.addTransceiver('video', { direction: 'recvonly' });
      channel = peer.createDataChannel(''); channel.binaryType = 'arraybuffer'; channel.onmessage = receive; channel.onopen = maybeReady;
      channel.onclose = () => { if (!closed) void stop('The remote data channel closed.'); }; channel.onerror = () => { if (!closed) void stop('The remote data channel failed.', 'connection_error'); };
      peer.ontrack = event => { if (!closed) { videoPaused(); onRemoteStream(event.streams?.[0] ?? createStream([event.track])); event.track.onended = () => { if (!closed) void stop('The remote media stream ended.', 'video_error'); }; } };
      peer.onconnectionstatechange = () => {
        if (closed) return;
        if (peer.connectionState === 'connected') { clearTimeout(disconnectTimer); disconnectTimer = null; maybeReady(); }
        else if (peer.connectionState === 'failed') void stop('The remote connection failed.', 'connection_error');
        else if (peer.connectionState === 'disconnected' && disconnectTimer == null) {
          active = false; videoPaused(); releaseControl(); status('connecting', 'Reconnecting to the remote computer…');
          disconnectTimer = setTimeout(() => { void stop('The remote connection disconnected.', 'connection_error'); }, 10000);
        }
      };
      const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; readyTimer = setTimeout(() => reject(new Error('The remote connection timed out.')), readyTimeoutMs); }); ready.catch(() => {});
      const connect = (async () => {
        const offer = await peer.createOffer(); if (closed) return;
        await peer.setLocalDescription(offer); if (closed) return;
        const result = await api('connect', { sdp: peer.localDescription.sdp }); if (closed) return;
        remoteHandoff = result.handoff; configured = true;
        await peer.setRemoteDescription({ type: 'answer', sdp: result.answer }); maybeReady();
      })();
      await Promise.all([connect, ready]);
    } catch (error) { await stop('The remote connection could not start.', 'connection_error'); throw error; }
  }
  async function requestControl() {
    if (!active || closed || peer?.connectionState !== 'connected' || handoffPending || requested || mode === 'controlling') return false;
    const epoch = inputEpoch;
    requested = true; mode = 'requesting'; status('active', 'Checking the selected account…');
    try { await api('authorize', {}); }
    catch { if (!closed && requested && epoch === inputEpoch) await stop('The selected account could not be verified. Reopen the session with the intended login.'); return false; }
    if (closed || !active || !requested || epoch !== inputEpoch) return false;
    if (peer?.connectionState !== 'connected' || channel?.readyState !== 'open') { releaseControl(); return false; }
    controlAuthorized = true;
    try { json({ event: 'control/request' }); } catch { return inputFailed(); }
    status('active', 'Requesting control…');
    controlTimer = setTimeout(() => { releaseControl(); if (!closed) status('active', 'Control request timed out. You are still viewing.'); }, controlTimeoutMs); return true;
  }
  const canInput = event => active && !closed && peer?.connectionState === 'connected' && mode === 'controlling' && channel?.readyState === 'open' && event?.isTrusted === true;
  function sendKeyNow(event) {
    if (!canInput(event) || !['keydown', 'keyup'].includes(event.type) || event.isComposing) return false;
    const down = event.type === 'keydown', code = event.code ?? event.key;
    const key = (!down ? pressedCodes.get(code) : null) ?? keysymForEvent(event, platform); if (key == null) return false;
    channel.send(encodeRemoteInput(down ? 'down' : 'up', { key }));
    if (down) { pressed.add(key); pressedCodes.set(code, key); } else { pressed.delete(key); pressedCodes.delete(code); } return true;
  }
  function sendKey(event) {
    if (!canInput(event) || !['keydown', 'keyup'].includes(event.type) || event.isComposing) return false;
    if (!clipboardSync) {
      try { return sendKeyNow(event); }
      catch { return inputFailed(); }
    }
    const epoch = inputEpoch, snapshot = { isTrusted: true, type: event.type, key: event.key, code: event.code, location: event.location, isComposing: false, ctrlKey: event.ctrlKey, metaKey: event.metaKey };
    keyQueue = keyQueue.then(async () => {
      if (!canInput(snapshot) || epoch !== inputEpoch) return;
      if (!clipboardSync) { sendKeyNow(snapshot); return; }
      if (snapshot.type === 'keydown' && snapshot.key?.toLowerCase() === 'v' && (snapshot.ctrlKey || snapshot.metaKey) && hasFocus() && typeof readClipboard === 'function') {
        let text;
        try { text = await readClipboard(); }
        catch { if (canInput(snapshot) && epoch === inputEpoch && clipboardSync) status('active', 'The browser did not allow clipboard reading. Paste the text using the transfer controls.'); }
        if (!canInput(snapshot) || epoch !== inputEpoch || !clipboardSync || !hasFocus()) return;
        if (typeof text === 'string' && text.length <= 1024 * 1024 && text !== lastLocalClipboard) {
          const ack = new Promise(resolve => { clipboardAck = resolve; clipboardTimer = setTimeout(resolve, clipboardTimeoutMs); });
          json({ event: 'control/clipboard', text }); lastLocalClipboard = text; await ack; clearTimeout(clipboardTimer); clipboardAck = null;
        }
      }
      if (canInput(snapshot) && epoch === inputEpoch) sendKeyNow(snapshot);
    }).catch(() => { if (!closed && epoch === inputEpoch) inputFailed(); });
    return true;
  }
  function setClipboardSync(enabled, event) {
    if (typeof enabled !== 'boolean' || event?.isTrusted !== true || closed) return false;
    clipboardSync = enabled; lastLocalClipboard = undefined;
    if (!enabled) { clipboardAck?.(); clipboardAck = null; clearTimeout(clipboardTimer); }
    return true;
  }
  function sendPointer(event, element) {
    try { return sendPointerNow(event, element); } catch { return inputFailed(); }
  }
  function sendPointerNow(event, element) {
    if (!canInput(event) || !['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'lostpointercapture', 'wheel'].includes(event.type)) return false;
    // Pointer capture delivers release/cancellation even outside the rendered
    // video. Release held buttons before considering coordinates so a drag
    // cannot leave the remote mouse pressed at the last valid position.
    if (event.type === 'pointercancel' || event.type === 'lostpointercapture') {
      const released = mouseKeys.size > 0;
      for (const key of mouseKeys) { channel.send(encodeRemoteInput('up', { key })); pressed.delete(key); }
      mouseKeys.clear(); return released;
    }
    if (['pointerdown', 'pointerup'].includes(event.type) && (!Number.isInteger(event.button) || event.button < 0 || event.button > 4)) return false;
    if (event.type === 'wheel' && ![event.deltaX, event.deltaY].every(Number.isFinite)) return false;
    const key = event.button === 3 ? 269025062 : event.button === 4 ? 269025063 : event.button + 1;
    const point = remoteCoordinates(event, element);
    if (event.type === 'pointerup') {
      if (!mouseKeys.has(key)) return false;
      if (point) channel.send(encodeRemoteInput('move', point));
      channel.send(encodeRemoteInput('up', { key })); pressed.delete(key); mouseKeys.delete(key); return true;
    }
    if (!point) return false;
    channel.send(encodeRemoteInput('move', point));
    if (['pointerdown', 'pointerup'].includes(event.type)) {
      channel.send(encodeRemoteInput('down', { key })); pressed.add(key); mouseKeys.add(key);
    } else if (event.type === 'wheel') {
      const factor = event.deltaMode === 0 ? 1 : 19, clamp = value => Math.max(-10, Math.min(10, Math.round(-value * factor)));
      channel.send(encodeRemoteInput('scroll', { x: clamp(event.deltaX), y: clamp(event.deltaY) }));
    }
    return true;
  }
  function sendClipboard(text, event) {
    if (!canInput(event) || typeof text !== 'string' || text.length > 1024 * 1024) return false;
    try { json({ event: 'control/clipboard', text }); return true; } catch { return inputFailed(); }
  }
  return { start, stop, requestControl, releaseControl, sendKey, sendPointer, sendClipboard, setClipboardSync, videoPlaying, videoFrame, videoPaused, videoError: () => stop('The remote video failed.', 'video_error'), get mode() { return mode; }, get closed() { return closed; } };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const capability = location.hash.slice(1); history.replaceState(null, '', location.pathname);
  const $ = selector => document.querySelector(selector), video = $('#video'), status = $('#status'), start = $('#start'), control = $('#control'), end = $('#end'), audio = $('#sound'), send = $('#send-clipboard'), copy = $('#copy-clipboard'), clipboard = $('#clipboard'), sync = $('#sync-clipboard');
  let heartbeat, frameCallback, remoteClipboard = '', sound = false;
  const api = async (operation, body) => {
    const response = await fetch(`/api/${operation}`, { method: 'POST', headers: { Authorization: `Bearer ${capability}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit', cache: 'no-store', redirect: 'error' });
    const value = await response.json(); if (!response.ok) throw new Error(value.error?.message || 'The local remote-session service rejected the request.'); return value;
  };
  const session = createBrowserRemoteSession({ api, PeerConnection: window.RTCPeerConnection, platform: navigator.platform, readClipboard: () => navigator.clipboard.readText(), writeClipboard: text => navigator.clipboard.writeText(text), hasFocus: () => document.hasFocus() && !document.hidden,
    onStatus(value) { status.textContent = value.message; start.disabled = value.state !== 'idle'; end.disabled = value.state === 'ended'; control.disabled = value.state !== 'active' || value.mode === 'requesting'; control.textContent = value.mode === 'controlling' ? 'Return control' : 'Take control'; send.disabled = value.mode !== 'controlling'; audio.disabled = value.state !== 'active'; if (value.state === 'ended') { clearInterval(heartbeat); copy.disabled = true; clipboard.value = ''; remoteClipboard = ''; } },
    onRemoteStream(stream) { if (frameCallback != null) video.cancelVideoFrameCallback?.(frameCallback); frameCallback = null; video.srcObject = stream; if (stream) void video.play().catch(() => {}); },
    onClipboard(text) { remoteClipboard = text; copy.disabled = !text; },
  });
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) { status.textContent = 'Use the fresh remote-session URL printed by the CLI.'; start.disabled = true; }
  else heartbeat = setInterval(() => { api('heartbeat', {}).catch(() => { void session.stop('The CLI disconnected or its account changed.'); }); }, 10000);
  start.addEventListener('click', event => { if (!event.isTrusted) return; start.disabled = true; end.disabled = false; void session.start().catch(() => {}); });
  control.addEventListener('click', event => { if (!event.isTrusted) return; if (session.mode === 'controlling') session.releaseControl(); else void session.requestControl(); video.focus(); });
  end.addEventListener('click', event => { if (event.isTrusted) void session.stop(); });
  audio.addEventListener('click', event => { if (!event.isTrusted) return; sound = !sound; video.muted = !sound; audio.textContent = sound ? 'Mute audio' : 'Enable audio'; if (sound) void video.play().catch(() => {}); });
  video.addEventListener('playing', () => {
    session.videoPlaying();
    if (typeof video.requestVideoFrameCallback === 'function') { frameCallback = video.requestVideoFrameCallback(() => { frameCallback = null; if (!document.hidden && video.videoWidth > 0 && video.videoHeight > 0 && !video.paused) session.videoFrame(); }); }
    else if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 && !document.hidden) session.videoFrame();
  });
  for (const name of ['pause', 'waiting', 'stalled', 'emptied']) video.addEventListener(name, () => session.videoPaused());
  video.addEventListener('error', () => { void session.videoError(); });
  sync.addEventListener('change', event => { if (!session.setClipboardSync(sync.checked, event)) sync.checked = false; });
  for (const name of ['keydown', 'keyup']) video.addEventListener(name, event => { if (session.sendKey(event)) event.preventDefault(); });
  for (const name of ['pointerdown', 'pointerup', 'pointermove', 'pointercancel', 'lostpointercapture', 'wheel']) video.addEventListener(name, event => { if (session.sendPointer(event, video)) { event.preventDefault(); if (name === 'pointerdown') { video.focus(); video.setPointerCapture(event.pointerId); } } }, { passive: false });
  video.addEventListener('contextmenu', event => { if (session.mode === 'controlling') event.preventDefault(); });
  window.addEventListener('blur', () => session.releaseControl());
  document.addEventListener('visibilitychange', () => { if (document.hidden) session.releaseControl(); });
  send.addEventListener('click', event => { if (session.sendClipboard(clipboard.value, event)) status.textContent = 'Text sent to the remote clipboard. Paste it in the remote window when ready.'; });
  copy.addEventListener('click', async event => { if (!event.isTrusted || !remoteClipboard) return; try { await navigator.clipboard.writeText(remoteClipboard); status.textContent = 'Remote clipboard text copied.'; } catch { status.textContent = 'The browser did not allow clipboard writing.'; } });
  window.addEventListener('pagehide', () => { void session.stop(); });
}
