if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  const capability = location.hash.slice(1); history.replaceState(null, '', location.pathname);
  const $ = id => document.getElementById(id), status = $('status'), start = $('start'), end = $('end'), image = $('qr'), frame = $('viewer'), mode = document.body.dataset.mode;
  let timer, heartbeat, ended = false;
  const api = async operation => {
    const response = await fetch(`/api/${operation}`, { method: 'POST', headers: { Authorization: `Bearer ${capability}`, 'Content-Type': 'application/json' }, body: '{}', credentials: 'omit', cache: 'no-store', redirect: 'error' });
    const value = await response.json(); if (!response.ok) throw new Error(value.error?.message || 'The local viewer request failed.'); return value;
  };
  function clear() { ended = true; clearTimeout(timer); clearInterval(heartbeat); image.removeAttribute('src'); image.hidden = true; frame.removeAttribute('src'); frame.hidden = true; start.disabled = true; end.disabled = true; }
  async function poll() {
    try {
      const value = await api('poll'); if (ended) return;
      if (value.disappeared) { image.removeAttribute('src'); image.hidden = true; status.textContent = 'The QR challenge disappeared. Return to the original sign-in request to continue.'; return; }
      image.hidden = !value.available; if (value.image) image.src = value.image;
      status.textContent = value.available ? value.hasRotated ? 'The QR code rotated. Scan the current code with the service’s app or your camera.' : 'Scan the QR code with the service’s app or your camera.' : 'Waiting for the sign-in QR code…';
      timer = setTimeout(poll, 2000);
    } catch (error) { clear(); status.textContent = error.message; }
  }
  start.addEventListener('click', async event => {
    if (!event.isTrusted || ended) return; start.disabled = true; end.disabled = false;
    if (mode === 'qr') { void poll(); return; }
    try {
      const value = await api('connect'); if (ended) return;
      if (!value.available) { status.textContent = 'No legacy viewer is available for this browser. Use the WebRTC viewer.'; return; }
      frame.src = value.viewer; frame.hidden = false; status.textContent = 'Legacy remote browser loaded. Its own controls govern input.';
    } catch (error) { clear(); status.textContent = error.message; }
  });
  end.addEventListener('click', event => { if (event.isTrusted) { clear(); status.textContent = 'Viewer closed.'; void api('stop').catch(() => {}); } });
  if (!/^[A-Za-z0-9_-]{43}$/.test(capability)) { clear(); status.textContent = 'Use the fresh local viewer URL printed by the CLI.'; }
  else heartbeat = setInterval(() => { api('heartbeat').catch(() => { clear(); status.textContent = 'The CLI disconnected or its account changed.'; }); }, 10000);
  window.addEventListener('pagehide', () => { clear(); void api('stop').catch(() => {}); });
}
