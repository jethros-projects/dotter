/** A small browser-like test clock, independent of experimental Node MockTimers. */
export function installClock(t, { intervals = false } = {}) {
  if (typeof t?.after !== 'function') throw new TypeError('A test context with after() is required.');
  if (typeof intervals !== 'boolean') throw new TypeError('intervals must be boolean.');
  const names = ['setTimeout', 'clearTimeout', ...(intervals ? ['setInterval', 'clearInterval'] : [])];
  const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const scheduled = new Map();
  let now = 0, nextHandle = 1, restored = false;
  const duration = value => {
    const number = Number(value ?? 0);
    return Number.isFinite(number) && number > 0 ? Math.min(Math.floor(number), 2_147_483_647) : 0;
  };
  function schedule(callback, delay, repeat, args) {
    if (typeof callback !== 'function') throw new TypeError('The timer callback must be a function.');
    const interval = repeat ? Math.max(1, duration(delay)) : null;
    const handle = nextHandle++;
    scheduled.set(handle, { handle, callback, args, at: now + (interval ?? duration(delay)), interval });
    return handle;
  }
  const clear = handle => { scheduled.delete(handle); };
  const replacements = {
    setTimeout: (callback, delay, ...args) => schedule(callback, delay, false, args),
    clearTimeout: clear,
    ...(intervals ? { setInterval: (callback, delay, ...args) => schedule(callback, delay, true, args), clearInterval: clear } : {}),
  };
  for (const [name, value] of Object.entries(replacements)) {
    Object.defineProperty(globalThis, name, { configurable: true, enumerable: originals.get(name)?.enumerable ?? true, writable: true, value });
  }
  function restore() {
    if (restored) return;
    restored = true; scheduled.clear();
    for (const name of names) {
      const original = originals.get(name);
      if (original) Object.defineProperty(globalThis, name, original);
      else delete globalThis[name];
    }
  }
  t.after(restore);
  return {
    tick(milliseconds) {
      if (restored) throw new Error('The test clock has been restored.');
      if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new RangeError('tick requires a nonnegative finite duration.');
      const target = now + milliseconds;
      if (!Number.isFinite(target)) throw new RangeError('The test clock duration overflowed.');
      let calls = 0;
      for (;;) {
        let next;
        for (const timer of scheduled.values()) {
          if (timer.at <= target && (!next || timer.at < next.at || timer.at === next.at && timer.handle < next.handle)) next = timer;
        }
        if (!next) break;
        if (++calls > 100_000) throw new Error('The test clock exceeded its callback limit.');
        now = next.at;
        if (next.interval === null) scheduled.delete(next.handle);
        else next.at += next.interval;
        Reflect.apply(next.callback, globalThis, next.args);
      }
      now = target;
    },
    get scheduledCount() { return scheduled.size; },
    get createdCount() { return nextHandle - 1; },
    get now() { return now; },
    restore,
  };
}
