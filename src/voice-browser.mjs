/** Browser-only media controller, with dependencies injectable for deterministic tests. */
export function createBrowserVoiceSession({ api, mediaDevices, PeerConnection, listenOnly = false, onStatus = () => {}, onRemoteStream = () => {}, readyTimeoutMs = 30000 }) {
  if (typeof listenOnly !== 'boolean') throw new TypeError('listenOnly must be boolean.');
  let stream, pc, channel, closed = false, started = false, stopPromise, attached = false, muted = false, readyResolve, readyReject, readyTimer, disconnectTimer;
  const update = (state, message) => onStatus({ state, message });
  function releaseIfReady() {
    if (closed || !attached || pc?.connectionState !== 'connected' || channel?.readyState !== 'open') return;
    for (const track of stream?.getAudioTracks() ?? []) track.enabled = !muted;
    clearTimeout(readyTimer); readyResolve?.(); update('active', listenOnly ? 'Connected. Listening only; microphone disabled.' : muted ? 'Connected. Microphone muted.' : 'Connected. Speak naturally.');
  }
  async function stop(reason = 'ended') {
    if (stopPromise) return stopPromise;
    closed = true;
    // Publish the shared cleanup before callbacks can synchronously reenter.
    stopPromise = Promise.resolve().then(() => api('stop', {})).catch(() => { update('ended', `${listenOnly ? 'Listen-only connection closed.' : 'Microphone stopped.'} The CLI will clean up the remote call.`); });
    clearTimeout(readyTimer); clearTimeout(disconnectTimer); readyReject?.(new Error('Voice session ended.'));
    for (const track of stream?.getTracks() ?? []) track.stop();
    channel?.close(); pc?.close(); onRemoteStream(null);
    update('ended', reason === 'ended' ? 'Call ended.' : reason);
    return stopPromise;
  }
  async function start() {
    if (started || closed) throw new Error('This voice session has already been started.');
    started = true; update('starting', listenOnly ? 'Preparing listen-only connection…' : 'Requesting microphone access…');
    try {
      if (!PeerConnection || !listenOnly && !mediaDevices?.getUserMedia) throw new Error('This browser does not support voice calls.');
      if (!listenOnly) {
        stream = await mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
        if (closed) { for (const track of stream.getTracks()) track.stop(); return; }
        for (const track of stream.getAudioTracks()) track.enabled = false;
      }
      const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; readyTimer = setTimeout(() => reject(new Error('The voice connection timed out.')), readyTimeoutMs); });
      // A timeout or cancellation can precede any negotiation response.
      ready.catch(() => {});
      pc = new PeerConnection(); channel = pc.createDataChannel('oai-events');
      channel.onopen = releaseIfReady;
      channel.onclose = () => { if (!closed) void stop('Voice connection closed.'); };
      channel.onerror = () => { if (!closed) void stop('Voice connection failed.'); };
      channel.onmessage = event => { try { if (JSON.parse(event.data)?.type === 'error') void stop('The voice service reported an error.'); } catch {} };
      pc.ontrack = event => { if (!closed) onRemoteStream(event.streams?.[0] ?? new MediaStream([event.track])); };
      pc.onconnectionstatechange = () => {
        if (closed) return;
        if (pc.connectionState === 'connected') { clearTimeout(disconnectTimer); disconnectTimer = undefined; releaseIfReady(); }
        else if (pc.connectionState === 'failed') void stop('Voice connection failed.');
        else if (pc.connectionState === 'disconnected') disconnectTimer ??= setTimeout(() => { void stop('Voice connection disconnected.'); }, 10000);
      };
      // Match the native preparation's sendrecv media line without installing
      // a sender track. No microphone access or outgoing audio exists in this mode.
      if (listenOnly) pc.addTransceiver('audio', { direction: 'sendrecv' });
      else for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
      update('starting', 'Connecting to Dot…');
      const offer = await Promise.race([pc.createOffer(), ready]);
      if (closed) return;
      await Promise.race([pc.setLocalDescription(offer), ready]);
      if (closed) return;
      const allocation = await Promise.race([api('allocate', { sdp: pc.localDescription.sdp }), ready]);
      if (closed) return;
      await Promise.race([pc.setRemoteDescription({ type: 'answer', sdp: allocation.answer }), ready]);
      if (closed) return;
      // Readiness can expire or be cancelled while the broker is attaching.
      // Its result must not keep local media alive or revive a closed session.
      await Promise.race([api('attach', { callId: allocation.callId }), ready]);
      if (closed) return;
      attached = true; releaseIfReady(); await ready;
    } catch (error) {
      const message = error?.name === 'NotAllowedError' ? 'Microphone permission was not granted.' : error?.message || 'Voice connection failed.';
      await stop(message); throw error;
    }
  }
  return { start, stop, setMuted(value) { if (!listenOnly) { muted = Boolean(value); releaseIfReady(); } }, get closed() { return closed; } };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const token = window.location.hash.slice(1);
  window.history.replaceState(null, '', window.location.pathname);
  const status = document.querySelector('#status'), startButton = document.querySelector('#start'), muteButton = document.querySelector('#mute'), endButton = document.querySelector('#end'), audio = document.querySelector('#audio');
  const listenOnly = document.body.dataset.listenOnly === 'true';
  if (listenOnly) { startButton.textContent = 'Start listening'; muteButton.hidden = true; }
  let heartbeat, muted = false;
  const api = async (operation, body) => {
    const response = await fetch(`/api/${operation}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit', cache: 'no-store', redirect: 'error' });
    const value = await response.json(); if (!response.ok) throw new Error(value.error?.message || 'The CLI voice service rejected the request.'); return value;
  };
  const voice = createBrowserVoiceSession({ api, mediaDevices: navigator.mediaDevices, PeerConnection: window.RTCPeerConnection, listenOnly,
    onStatus({ state, message }) { status.textContent = message; startButton.disabled = state !== 'idle'; muteButton.disabled = state !== 'active'; endButton.disabled = state === 'ended'; if (state === 'ended') clearInterval(heartbeat); },
    onRemoteStream(stream) { audio.srcObject = stream; if (stream) audio.play().catch(() => { if (!voice.closed && audio.srcObject === stream) status.textContent = 'Connected. Click the page to allow speaker audio.'; }); },
  });
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { status.textContent = 'Open the fresh voice URL printed by the CLI.'; startButton.disabled = true; }
  else heartbeat = setInterval(() => { api('heartbeat', {}).catch(() => { void voice.stop('The CLI disconnected.'); }); }, 10000);
  startButton.addEventListener('click', () => { startButton.disabled = true; endButton.disabled = false; void voice.start().catch(() => {}); });
  muteButton.addEventListener('click', () => { muted = !muted; voice.setMuted(muted); muteButton.textContent = muted ? 'Unmute microphone' : 'Mute microphone'; });
  endButton.addEventListener('click', () => { void voice.stop(); });
  document.addEventListener('click', () => { if (audio.srcObject) void audio.play().catch(() => {}); });
  window.addEventListener('pagehide', () => { void voice.stop(); });
}
