// Hosted PWA launcher (ADR 0003). The website only serves this page, the iroh client and the service
// worker; the app itself comes from the user's primary:
//   1. the QR code opens `…/tornade/?owner=…&pair=…`: the link is stored, the device paired;
//   2. the app files are downloaded from the primary (gzip, by ranges, SHA-256 checked) into Cache
//      Storage under ./app/<instance>/<build>/, then the app is started in this page;
//   3. later launches start the cached build at once and fetch a newer one in the background.
// Debug mode (`?debug`): devlog.js captures everything and uploads it to the primary.

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const debug = !!window.tornadeDevlog;
const dlog = (...a) => { if (debug) console.log('[launcher]', ...a); };

// --- i18n: frontend/locales/*/launcher.json, inlined into i18n.js at build time ---
const LANG = (navigator.language || 'en').toLowerCase().startsWith('fr') ? 'fr' : 'en';
const STRINGS = window.TORNADE_LAUNCHER_I18N ?? {};
const t = (key, vars = {}) =>
  (STRINGS[LANG]?.[key] ?? STRINGS.en?.[key] ?? key).replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => vars[k] ?? '');
const mb = new Intl.NumberFormat(LANG, { style: 'unit', unit: 'megabyte', maximumFractionDigits: 1, minimumFractionDigits: 1 });
const fmtBytes = (n) => mb.format(n / 1e6);

document.documentElement.lang = LANG;
for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);

// --- localStorage schema shared with frontend/src/pwa.rs (must stay byte-compatible) ---
const INSTANCES = 'tornade.instances';
const CURRENT = 'tornade.instance';
const instances = () => { try { return JSON.parse(localStorage.getItem(INSTANCES) || '[]'); } catch { return []; } };
const upsert = (i) => {
  const list = instances();
  const k = list.findIndex((x) => x.id === i.id);
  if (k >= 0) list[k] = { ...list[k], ...i }; else list.push({ name: '', pairing: null, push_key: null, ...i });
  localStorage.setItem(INSTANCES, JSON.stringify(list));
};
const nameOf = (id) => instances().find((x) => x.id === id)?.name || t('your_tornade');

function acceptLink(text) {
  const q = new URLSearchParams(text.includes('?') ? text.split('?')[1] : text);
  const owner = q.get('owner') ?? (/^[0-9a-f]{64}$/i.test(text.trim()) ? text.trim() : null);
  if (!owner || !/^[0-9a-f]{64}$/i.test(owner)) return null;
  const prev = instances().find((x) => x.id === owner);
  upsert({ id: owner, pairing: q.get('pair') ?? prev?.pairing ?? null });
  localStorage.setItem(CURRENT, owner);
  return owner;
}

// --- view ---
const view = $('launcher');
function setState(state) { view.dataset.state = state; }
function setStatus(text) { $('status').textContent = text; }
function setProgress(done, total) {
  if (total == null) { delete view.dataset.progress; return; }
  const p = total ? Math.min(1, done / total) : 1;
  view.dataset.progress = '';
  view.style.setProperty('--p', p.toFixed(4));
  $('progress').setAttribute('aria-valuenow', String(Math.round(p * 100)));
  $('bytes').textContent = t('progress', { done: fmtBytes(done), total: fmtBytes(total) });
}
function showError(title, body, detail) {
  setProgress(null);
  $('error-title').textContent = title;
  $('error-body').textContent = body ?? '';
  $('error-detail').textContent = detail ?? '';
  setState('error');
  $('retry').focus({ focusVisible: false });
}

// --- transport: `get(path)` returns a Response from the primary ---
class Unreachable extends Error {}

async function postLog(url, entries) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: window.tornadeDevlog.session, entries }),
  });
  if (!r.ok) throw new Error(`device-log: ${r.status}`);
}

async function transport(target) {
  if (target.mode === 'direct') {
    // Desktop test against a local primary (`?direct=http://127.0.0.1:port`), plain HTTP.
    if (debug) window.tornadeDevlog.setSender((e) => postLog(target.origin + '/api/pwa/device-log', e));
    return { ...target, get: (p) => fetch(target.origin + p, { cache: 'no-store' }) };
  }
  const { owner } = target;
  setStatus(t('connecting', { name: nameOf(owner) }));
  const tc = performance.now();
  try {
    await window.tornadePwa.connect(owner);
  } catch (e) {
    throw new Unreachable(e?.message ?? String(e));
  }
  dlog(`connected in ${(performance.now() - tc).toFixed(0)} ms, relay ${window.tornadePwa.homeRelay?.() ?? '?'}`);
  const inst = instances().find((x) => x.id === owner);
  if (inst?.pairing) {
    setStatus(t('pairing'));
    const r = await fetch('/api/devices/pair', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: inst.pairing, user_agent: navigator.userAgent }),
    });
    // The code is single-use: a QR code scanned twice is refused, but this device may already be
    // paired with it. If it is not, the app shows its own "pair again" screen.
    upsert({ id: owner, pairing: null });
    dlog(r.ok ? 'paired' : `pairing refused (${r.status}), continuing`);
  }
  if (debug) window.tornadeDevlog.setSender((e) => postLog('/api/pwa/device-log', e));
  return { ...target, get: (p) => window.tornadePwa.fetchPrimary(p) };
}

// --- cache layout ---
const keyOf = (tp) => (tp.mode === 'iroh' ? tp.owner.slice(0, 16) : 'direct');
const cacheName = (key, build) => `tornade-app-${key}-${build}`;
const prefixOf = (key, build) => new URL(`app/${key}/${build}/`, location.href).href;
const MIME = {
  html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', wasm: 'application/wasm', css: 'text/css',
  svg: 'image/svg+xml', png: 'image/png', webp: 'image/webp', ico: 'image/x-icon', json: 'application/json',
  webmanifest: 'application/manifest+json', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf',
};
const mimeOf = (p) => MIME[p.split('.').pop().toLowerCase()] ?? 'application/octet-stream';
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

// --- download: manifest → missing files → gzip ranges → SHA-256 check → Cache Storage ---
const PARALLEL = 4;
const RANGE = 512 * 1024;

async function download(tp, { cleanup = true, onProgress = () => {} } = {}) {
  const tm = performance.now();
  const res = await tp.get('/api/pwa/bundle');
  if (!res.ok) throw new Error(`/api/pwa/bundle: ${res.status}`);
  const bundle = await res.json();
  dlog(`manifest in ${(performance.now() - tm).toFixed(0)} ms: build ${bundle.build_id}, ${bundle.files.length} files`);

  const key = keyOf(tp);
  const prefix = prefixOf(key, bundle.build_id);
  const cache = await caches.open(cacheName(key, bundle.build_id));

  // Reuse identical files from previous builds of this instance (differential update).
  const previous = (await caches.keys()).filter((n) => n.startsWith(`tornade-app-${key}-`) && n !== cacheName(key, bundle.build_id));
  const bySha = new Map();
  for (const name of previous) {
    const c = await caches.open(name);
    for (const req of await c.keys()) {
      const r = await c.match(req);
      const sha = r?.headers.get('x-sha256');
      if (sha) bySha.set(sha, r);
    }
  }
  const todo = [];
  for (const f of bundle.files) {
    const url = prefix + f.path;
    if (await cache.match(url)) continue;
    const old = bySha.get(f.sha256);
    if (old) { await cache.put(url, old.clone()); continue; }
    todo.push(f);
  }

  const gz = typeof DecompressionStream === 'function' && bundle.files.every((f) => f.gz_size > 0);
  const total = todo.reduce((n, f) => n + (gz ? f.gz_size : f.size), 0);
  let received = 0;
  onProgress(0, total);
  const td = performance.now();

  // Work items: gzip ranges of every missing file (largest first), or whole raw files.
  const parts = new Map();
  const tasks = [];
  for (const f of [...todo].sort((a, b) => b.size - a.size)) {
    if (!gz) { tasks.push({ f }); continue; }
    const n = Math.max(1, Math.ceil(f.gz_size / RANGE));
    parts.set(f.path, { chunks: new Array(n), left: n });
    for (let i = 0; i < n; i++) tasks.push({ f, i, from: i * RANGE, to: Math.min(f.gz_size, (i + 1) * RANGE) });
  }

  const store = async (f, raw) => {
    const sha = hex(await crypto.subtle.digest('SHA-256', raw));
    if (sha !== f.sha256) throw new Error(`${f.path}: hash mismatch`);
    await cache.put(prefix + f.path, new Response(raw, { headers: { 'content-type': mimeOf(f.path), 'x-sha256': sha } }));
  };
  const work = async ({ f, i, from, to }) => {
    if (i === undefined) {
      const r = await tp.get('/' + encPath(f.path));
      if (!r.ok) throw new Error(`${f.path}: ${r.status}`);
      const raw = await r.arrayBuffer();
      received += raw.byteLength;
      onProgress(received, total);
      return store(f, raw);
    }
    const r = await tp.get(`/api/pwa/gz/${encPath(f.path)}?from=${from}&to=${to}`);
    if (!r.ok) throw new Error(`${f.path}: ${r.status}`);
    const chunk = await r.arrayBuffer();
    received += chunk.byteLength;
    onProgress(received, total);
    const p = parts.get(f.path);
    p.chunks[i] = chunk;
    if (--p.left > 0) return;
    const raw = await new Response(new Blob(p.chunks).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    parts.delete(f.path);
    return store(f, raw);
  };
  await Promise.all(Array.from({ length: PARALLEL }, async () => { while (tasks.length) await work(tasks.shift()); }));
  if (todo.length) {
    const s = (performance.now() - td) / 1000;
    dlog(`downloaded ${todo.length} files, ${fmtBytes(received)} on the wire${gz ? ' (gzip)' : ''} in ${s.toFixed(2)} s`);
  }

  // Switch only once the set is complete; older builds go unless one is still running in this page.
  localStorage.setItem(`tornade.app.${key}`, bundle.build_id);
  if (cleanup) for (const name of previous) await caches.delete(name);
  return { prefix, cache, bundle };
}

// --- in-place start of the downloaded app ---
async function boot({ prefix, cache, bundle }, tp) {
  const tb = performance.now();
  const html = await (await cache.match(prefix + bundle.entry)).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Hash-only history URLs would otherwise resolve against <base> (the cached build path), and a
  // reload would then skip the launcher. Keep them on the launcher's own URL.
  const selfUrl = location.href.split('#')[0];
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m].bind(history);
    history[m] = (st, title, url) => orig(st, title, typeof url === 'string' && url.startsWith('#') ? selfUrl + url : url);
  }

  if (tp.mode === 'direct') {
    // Desktop test only: route the app's /api calls to the local primary.
    const nf = window.fetch;
    window.fetch = (input, opts) => {
      const u = new URL(input instanceof Request ? input.url : input, location.href);
      if (u.origin === location.origin && u.pathname.startsWith('/api/')) return nf(tp.origin + u.pathname + u.search, opts);
      return nf(input, opts);
    };
    const NWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      const u = new URL(url, location.href);
      if (u.host === location.host && u.pathname.startsWith('/api/')) url = tp.origin.replace(/^http/, 'ws') + u.pathname + u.search;
      return new NWS(url, protocols);
    };
    Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, prototype: NWS.prototype });
  } else {
    window.__TORNADE_PWA__ = true;
  }

  const base = document.createElement('base');
  base.href = prefix;
  document.head.prepend(base);
  // Add the app's boot loader before removing the launcher: the mark stays on screen, same place.
  for (const el of [...doc.body.childNodes]) document.body.append(document.importNode(el, true));
  // Re-create head elements: cloned <script> nodes do not run, so build fresh ones, in order.
  for (const el of [...doc.head.children]) {
    if (el.tagName === 'BASE' || (el.tagName === 'LINK' && el.rel === 'manifest')) continue;
    if (el.tagName !== 'SCRIPT') { document.head.append(document.importNode(el, true)); continue; }
    const s = document.createElement('script');
    for (const a of el.attributes) if (a.name !== 'integrity') s.setAttribute(a.name, a.value);
    s.textContent = el.textContent;
    if (el.src && el.type !== 'module') {
      s.async = false;
      await new Promise((ok, ko) => { s.onload = ok; s.onerror = () => ko(new Error(`script ${el.getAttribute('src')}`)); document.head.append(s); });
    } else {
      document.head.append(s);
    }
  }
  // The app's loader normally fades in after a delay; here it replaces a mark already on screen.
  const keep = document.createElement('style');
  keep.textContent = '#boot-loader { animation: none !important; opacity: 1 !important; }';
  document.head.append(keep);
  $('launcher')?.remove();
  $('launcher-style')?.remove();
  dlog(`app started in ${(performance.now() - tb).toFixed(0)} ms`);
}

// --- first run / no cache: connect, download with progress, start ---
let running = false;
let started = false;

async function run(target) {
  if (running || started) return;
  running = true;
  setState('loading');
  setProgress(null);
  try {
    const tp = await transport(target);
    setStatus(t('preparing'));
    const app = await download(tp, {
      onProgress: (done, total) => {
        if (!total) return;
        setStatus(t('downloading'));
        setProgress(done, total);
      },
    });
    setStatus(t('starting'));
    started = true;
    await boot(app, tp);
  } catch (e) {
    started = false;
    dlog('failed:', e);
    if (e instanceof Unreachable) {
      showError(t('unreachable_title', { name: nameOf(target.owner) }), t('unreachable_body'), e.message);
    } else {
      showError(t('failed_title'), null, e?.message ?? String(e));
    }
  } finally {
    running = false;
  }
}

// --- later launches: the cached build at once; newer builds only when the user asks (see below) ---
async function cachedApp(tp) {
  const key = keyOf(tp);
  const build = localStorage.getItem(`tornade.app.${key}`);
  if (!build || !(await caches.has(cacheName(key, build)))) return null;
  const cache = await caches.open(cacheName(key, build));
  const prefix = prefixOf(key, build);
  if (!(await cache.match(prefix + 'index.html'))) return null;
  return { prefix, cache, bundle: { build_id: build, entry: 'index.html' } };
}

async function dropOtherBuilds(tp, keep) {
  const key = keyOf(tp);
  for (const n of await caches.keys()) {
    if (n.startsWith(`tornade-app-${key}-`) && n !== cacheName(key, keep)) await caches.delete(n);
  }
}

async function startFromCache(target) {
  const app = await cachedApp(target);
  if (!app) return false;
  dlog(`starting build ${app.bundle.build_id} from the cache`);
  started = true;
  try {
    await boot(app, target);
  } catch (e) {
    started = false;
    throw e;
  }
  dropOtherBuilds(target, app.bundle.build_id).catch(() => {});
  // !!! NEVER download a newer build here, or anywhere without a human asking for it. !!!
  // Every byte goes through an n0 relay, which rate-limits; a dev primary changes build at each
  // save, so an automatic download would run at each start and get the device rate-limited.
  // The running app detects new builds and lets the user choose: prepare in the background,
  // or reload now (frontend/src/pwa.rs, `UpdateBanner`; ADR 0003, boot sequence step 6).
  return true;
}

// --- debug mode: logs at hand on the device ---
// Own stylesheet, self-contained: the launcher's is removed when the app starts, and the buttons
// must stay usable over the app (top right, small, above everything).
const DEBUG_CSS = `
#debug { position: fixed; z-index: 2147483647; right: 8px; top: calc(8px + env(safe-area-inset-top)); display: flex; gap: 6px; opacity: .75; }
#debug button { padding: 4px 8px; border: 1px solid #555; border-radius: 6px; background: #222; color: #ddd; font: 12px system-ui, sans-serif; cursor: pointer; }
#debug-log { position: fixed; z-index: 2147483647; inset: calc(44px + env(safe-area-inset-top)) 8px auto; max-height: 50vh; overflow: auto; margin: 0; padding: 10px; border: 1px solid #555; border-radius: 6px; background: #111; color: #eee; font: 11px/1.45 ui-monospace, monospace; white-space: pre-wrap; }`;

function debugTools() {
  const style = document.createElement('style');
  style.id = 'debug-style';
  style.textContent = DEBUG_CSS;
  document.head.append(style);
  const box = document.createElement('div');
  box.id = 'debug';
  const pre = document.createElement('pre');
  pre.id = 'debug-log';
  pre.hidden = true;
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.textContent = t('logs');
  toggle.onclick = () => { pre.hidden = !pre.hidden; pre.textContent = window.tornadeDevlog.text(); pre.scrollTop = pre.scrollHeight; };
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = t('copy_logs');
  copy.onclick = () => navigator.clipboard.writeText(window.tornadeDevlog.text()).then(() => { copy.textContent = t('copied'); setTimeout(() => { copy.textContent = t('copy_logs'); }, 1500); });
  box.append(toggle, copy);
  document.body.append(pre, box);
}

// --- start ---
async function main() {
  if (debug) debugTools();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((e) => dlog('sw:', e));
  if (!('caches' in window) || !crypto.subtle) {
    showError(t('failed_title'), t('unsupported'));
    return;
  }

  // Pairing link from the QR code: store it, then drop the secret from the address bar and history.
  if (params.has('owner')) {
    acceptLink(location.search);
    const keep = new URLSearchParams();
    for (const k of ['direct']) if (params.get(k)) keep.set(k, params.get(k));
    const q = keep.toString();
    history.replaceState(null, '', location.pathname + (q ? `?${q}` : '') + location.hash);
  }

  const owner = localStorage.getItem(CURRENT);
  const target = params.get('direct')
    ? { mode: 'direct', origin: params.get('direct').replace(/\/$/, '') }
    : owner ? { mode: 'iroh', owner } : null;

  $('retry').onclick = () => target && run(target);
  $('paste-toggle').onclick = () => {
    const open = $('paste').classList.toggle('open');
    $('paste-toggle').setAttribute('aria-expanded', String(open));
    if (open) $('paste-input').focus();
  };
  $('paste').onsubmit = (e) => {
    e.preventDefault();
    const id = acceptLink($('paste-input').value.trim());
    $('paste').setAttribute('aria-invalid', String(!id));
    if (id) run({ mode: 'iroh', owner: id });
  };

  if (!target) { setState('welcome'); return; }
  const pendingPairing = target.mode === 'iroh' && instances().some((x) => x.id === target.owner && x.pairing);
  if (!pendingPairing) {
    try {
      if (await startFromCache(target)) return;
    } catch (e) {
      dlog('cached start failed:', e);
    }
  }
  run(target);
}

main();
