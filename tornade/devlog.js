// Debug mode of the hosted PWA launcher (`?debug`): device-side log capture, loaded first
// (classic script) so it sees everything: console calls, uncaught errors, rejected promises, page lifecycle, service worker
// messages, slow or failing fetches. Entries are kept in localStorage (they survive a crash or a
// reload) and shipped to the primary (POST /api/pwa/device-log) once a transport is available.
(() => {
  const KEY = 'tornade.devlog.pending';
  const MAX = 3000;
  const session = `${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}`;
  const all = []; // this page's entries, sent or not (for "Copy log")
  let pending = [];
  try { pending = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { pending = []; }
  const t0 = performance.now();
  let saveTimer = null;
  const save = () => {
    saveTimer = null;
    try { localStorage.setItem(KEY, JSON.stringify(pending.slice(-MAX))); } catch { /* quota */ }
  };
  const fmt = (a) => {
    if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ''}`;
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a); } catch { return String(a); }
  };
  // High-volume lines that say nothing about a failure: dropping them keeps the upload (which
  // shares the phone's link) close to real time. Still shown in the browser console.
  const NOISE = [
    /target=iroh_webrtc_transport::browser_runtime::stream /, // one per stream open/close
    /relay\.n0\.iroh\.link\.\/ping failed .*AbortError/, // relay probes cancelled on purpose
    /outside a reactive tracking context/, // Leptos dev warning
  ];
  const push = (level, args) => {
    const msg = args.map(fmt).join(' ').slice(0, 4000);
    if (NOISE.some((re) => re.test(msg))) return;
    const entry = { session, at: new Date().toISOString(), t: Math.round(performance.now() - t0), level, url: location.href, msg };
    pending.push(entry);
    all.push(entry);
    if (all.length > MAX) all.shift();
    if (pending.length > MAX) pending.splice(0, pending.length - MAX);
    saveTimer ??= setTimeout(save, 300);
  };

  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => { push(level, args); orig(...args); };
  }
  addEventListener('error', (e) => {
    if (e.target && e.target !== window) push('error', [`resource failed: <${e.target.tagName?.toLowerCase()}> ${e.target.src || e.target.href || ''}`]);
    else push('error', [`uncaught: ${e.message} @ ${e.filename}:${e.lineno}:${e.colno}`, e.error ?? '']);
  }, true);
  addEventListener('unhandledrejection', (e) => push('error', ['unhandled rejection:', e.reason ?? '']));
  for (const ev of ['pageshow', 'pagehide', 'online', 'offline', 'freeze', 'resume']) addEventListener(ev, (e) => push('event', [ev, e.persisted ? '(bfcache)' : '']));
  document.addEventListener('visibilitychange', () => { push('event', [`visibility ${document.visibilityState}`]); if (document.visibilityState === 'hidden') { save(); flush(); } });
  navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.type === 'devlog') push('sw', [e.data.msg]); });

  // Fetch timings: failures and anything slower than 1 s (the log route itself is skipped).
  const nf = window.fetch.bind(window);
  window.fetch = async (input, opts) => {
    const url = typeof input === 'string' ? input : input?.url ?? String(input);
    if (url.includes('/api/pwa/device-log')) return nf(input, opts);
    const t = performance.now();
    try {
      const r = await nf(input, opts);
      const ms = performance.now() - t;
      if (!r.ok || ms > 1000) push(r.ok ? 'net' : 'warn', [`${opts?.method ?? input?.method ?? 'GET'} ${url} → ${r.status} in ${ms.toFixed(0)} ms`]);
      return r;
    } catch (e) {
      push('error', [`fetch ${url} failed after ${(performance.now() - t).toFixed(0)} ms:`, e]);
      throw e;
    }
  };

  // Shipping: `sender(entries)` posts a batch; set by the launcher once connected to the primary.
  let sender = null;
  let busy = false;
  async function flush() {
    if (!sender || busy || !pending.length) return;
    busy = true;
    const batch = pending.slice(0, 500);
    try {
      await sender(batch);
      pending.splice(0, batch.length);
      save();
    } catch (e) {
      console.warn('[devlog] upload failed', e?.message ?? e);
    } finally {
      busy = false;
    }
    if (pending.length && sender) setTimeout(flush, 200);
  }
  setInterval(flush, 5000);

  window.tornadeDevlog = {
    session,
    entries: () => pending.slice(),
    text: () => all.map((e) => `${e.at} +${e.t}ms [${e.level}] ${e.msg}`).join('\n'),
    setSender(fn) { sender = fn; push('info', ['[devlog] upload enabled']); flush(); },
    flush,
  };
  push('info', [`[devlog] session ${session} · ${navigator.userAgent} · standalone=${matchMedia('(display-mode: standalone)').matches || navigator.standalone === true}`]);
})();
