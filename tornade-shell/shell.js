// SPIKE (ADR 0003): frozen shell that downloads the app from the primary and boots it in place.
// Throwaway code: it exists to answer the spike's questions, not to ship.
//
// Modes:
//  - iroh (real use): connects to the instance through tornadePwa, pairs if `?pair=` is pending.
//  - direct (desktop only, `?direct=http://127.0.0.1:port`): plain HTTP to a local primary, to test
//    the download + in-place boot without iroh.
// On load, a pairing link in the URL (`?owner=…&pair=…`, from the primary's QR code) is stored and
// the shell connects right away; a known instance is also started right away (home screen launch).

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const t0 = performance.now();
const lines = [];
const log = (msg) => {
  const line = `${((performance.now() - t0) / 1000).toFixed(2).padStart(7)}s  ${msg}`;
  lines.push(line);
  console.log('[shell]', msg);
  const el = $('log');
  if (el) el.textContent = lines.join('\n');
};
const kb = (n) => `${(n / 1024).toFixed(0)} KiB`;
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const MIME = {
  html: 'text/html', js: 'text/javascript', mjs: 'text/javascript', wasm: 'application/wasm', css: 'text/css',
  svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon', json: 'application/json',
  webmanifest: 'application/manifest+json', woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf',
};
const mimeOf = (p) => MIME[p.split('.').pop().toLowerCase()] ?? 'application/octet-stream';

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

function acceptLink(text) {
  const q = new URLSearchParams(text.includes('?') ? text.split('?')[1] : text);
  const owner = q.get('owner') ?? (/^[0-9a-f]{64}$/i.test(text.trim()) ? text.trim() : null);
  if (!owner || !/^[0-9a-f]{64}$/i.test(owner)) return null;
  const prev = instances().find((x) => x.id === owner);
  upsert({ id: owner, pairing: q.get('pair') ?? prev?.pairing ?? null });
  localStorage.setItem(CURRENT, owner);
  return owner;
}

async function postLog(url, entries) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session: window.tornadeDevlog.session, entries }),
  });
  if (!r.ok) throw new Error(`spike-log: ${r.status}`);
}

// --- transport: `get(path)` returns a Response from the primary ---
async function transport() {
  // The shell's fields are gone once the app runs (background update): fall back to the URL / storage.
  const direct = ($('direct')?.value ?? params.get('direct') ?? '').trim().replace(/\/$/, '');
  if (direct) {
    log(`direct mode → ${direct}`);
    window.tornadeDevlog?.setSender((entries) => postLog(direct + '/api/pwa/spike-log', entries));
    return { mode: 'direct', origin: direct, get: (p) => fetch(direct + p, { cache: 'no-store' }) };
  }
  const owner = acceptLink(($('owner')?.value ?? '').trim()) ?? localStorage.getItem(CURRENT);
  if (!owner) throw new Error('no instance: paste the pairing link or an EndpointId');
  log(`iroh connection to ${owner.slice(0, 12)}…`);
  const tc = performance.now();
  await window.tornadePwa.connect(owner);
  log(`connected in ${(performance.now() - tc).toFixed(0)} ms, relay ${window.tornadePwa.homeRelay?.() ?? '?'}`);
  const inst = instances().find((x) => x.id === owner);
  if (inst?.pairing) {
    log('pairing…');
    const r = await fetch('/api/devices/pair', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: inst.pairing, user_agent: navigator.userAgent }),
    });
    // A QR code scanned twice: the code is single-use, but this device may already be paired with it.
    upsert({ id: owner, pairing: null });
    if (r.ok) log('paired');
    else log(`pairing refused (${r.status} ${await r.text()}), continuing in case this device is already paired`);
  }
  window.tornadeDevlog?.setSender((entries) => postLog('/api/pwa/spike-log', entries));
  return { mode: 'iroh', owner, get: (p) => window.tornadePwa.fetchPrimary(p) };
}

const keyOf = (tp) => (tp.mode === 'iroh' ? tp.owner.slice(0, 16) : 'direct');
const cacheName = (key, build) => `tornade-app-${key}-${build}`;
const prefixOf = (key, build) => new URL(`app/${key}/${build}/`, location.href).href;

// One file, gzip-compressed on the wire when the primary supports it (the relay is the bottleneck).
async function fetchFile(tp, f, stats) {
  const path = f.path.split('/').map(encodeURIComponent).join('/');
  if (stats.gz !== false && typeof DecompressionStream === 'function') {
    const r = await tp.get('/api/pwa/gz/' + path);
    if (r.ok) {
      stats.gz = true;
      const gz = await r.arrayBuffer();
      stats.wire += gz.byteLength;
      return new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    }
    if (r.status !== 404) throw new Error(`${f.path}: ${r.status}`);
    stats.gz = false;
    log('primary without /api/pwa/gz: uncompressed download');
  }
  const r = await tp.get('/' + path);
  if (!r.ok) throw new Error(`${f.path}: ${r.status}`);
  const buf = await r.arrayBuffer();
  stats.wire += buf.byteLength;
  return buf;
}

// --- download: manifest → missing files → SHA-256 check → Cache Storage ---
// `cleanup`: drop the other builds afterwards (not while an older build is running in this page).
async function download(tp, { cleanup = true } = {}) {
  const par = 4;
  const tm = performance.now();
  const res = await tp.get('/api/pwa/bundle');
  if (!res.ok) throw new Error(`/api/pwa/bundle: ${res.status} (primary too old?)`);
  const bundle = await res.json();
  const total = bundle.files.reduce((n, f) => n + f.size, 0);
  log(`manifest in ${(performance.now() - tm).toFixed(0)} ms : build ${bundle.build_id}, ${bundle.files.length} files, ${kb(total)}`);
  const big = bundle.files.find((f) => f.path.endsWith('.wasm') && f.size > 30 * 1024 * 1024);
  if (big) log(`⚠ ${big.path} is ${kb(big.size)}: debug bundle?`);

  const key = keyOf(tp);
  const prefix = prefixOf(key, bundle.build_id);
  const cache = await caches.open(cacheName(key, bundle.build_id));

  // Reuse identical files from any previous build of this instance (differential update).
  const previous = (await caches.keys()).filter((n) => n.startsWith(`tornade-app-${key}-`) && !n.endsWith(bundle.build_id));
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
  let reused = 0;
  for (const f of bundle.files) {
    const url = prefix + f.path;
    if (await cache.match(url)) continue;
    const old = bySha.get(f.sha256);
    if (old) { await cache.put(url, old.clone()); reused++; continue; }
    todo.push(f);
  }
  const bytes = todo.reduce((n, f) => n + f.size, 0);
  log(`${todo.length} files to download (${kb(bytes)}), ${reused} reused from a previous build`);

  const td = performance.now();
  let done = 0;
  let got = 0;
  const stats = { wire: 0, gz: undefined };
  const one = async (f) => {
    const t = performance.now();
    const buf = await fetchFile(tp, f, stats);
    const sha = hex(await crypto.subtle.digest('SHA-256', buf));
    if (sha !== f.sha256) throw new Error(`${f.path}: hash mismatch`);
    await cache.put(prefix + f.path, new Response(buf, { headers: { 'content-type': mimeOf(f.path), 'x-sha256': sha } }));
    done++; got += buf.byteLength;
    if (f.size > 100 * 1024 || done === todo.length) {
      log(`  ${f.path} ${kb(f.size)} in ${(performance.now() - t).toFixed(0)} ms (${done}/${todo.length})`);
    }
  };
  const queue = [...todo].sort((a, b) => b.size - a.size);
  await Promise.all(Array.from({ length: par }, async () => { while (queue.length) await one(queue.shift()); }));
  const s = (performance.now() - td) / 1000;
  if (todo.length) log(`downloaded ${kb(got)} (${kb(stats.wire)} on the wire${stats.gz ? ', gzip' : ''}) in ${s.toFixed(2)} s (${(stats.wire / 1024 / s).toFixed(0)} KiB/s)`);

  // Switch only once the set is complete, then drop the old builds.
  localStorage.setItem(`tornade.app.${key}`, bundle.build_id);
  if (cleanup) for (const name of previous) await caches.delete(name);
  saveResult({ mode: tp.mode, build: bundle.build_id, files: bundle.files.length, total, downloaded: got, wire: stats.wire, gzip: !!stats.gz, seconds: s });
  return { prefix, cache, bundle };
}

function saveResult(r) {
  const all = JSON.parse(localStorage.getItem('tornade.spike.results') || '[]');
  all.push({ at: new Date().toISOString(), ua: navigator.userAgent, standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true, ...r });
  localStorage.setItem('tornade.spike.results', JSON.stringify(all.slice(-20)));
}

// --- in-place boot ---
async function boot({ prefix, cache, bundle }, tp) {
  const tb = performance.now();
  const html = await (await cache.match(prefix + bundle.entry)).text();
  const doc = new DOMParser().parseFromString(html, 'text/html');

  // Hash-only history URLs would otherwise resolve against <base> (= the cached build path), and a
  // reload would then skip the shell. Keep them on the shell's own URL.
  const shellUrl = location.href.split('#')[0];
  for (const m of ['pushState', 'replaceState']) {
    const orig = history[m].bind(history);
    history[m] = (st, title, url) => orig(st, title, typeof url === 'string' && url.startsWith('#') ? shellUrl + url : url);
  }

  if (tp.mode === 'direct') {
    // Desktop test only: route the app's /api calls to the local primary.
    const nf = window.fetch;
    window.fetch = (input, opts) => {
      const u = new URL(input instanceof Request ? input.url : input, location.href);
      if (u.origin === location.origin && u.pathname.startsWith('/api/')) {
        return nf(tp.origin + u.pathname + u.search, opts);
      }
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
  document.getElementById('shell')?.remove();
  document.getElementById('shell-style')?.remove();

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
  for (const el of [...doc.body.childNodes]) document.body.append(document.importNode(el, true));
  log(`boot injected in ${(performance.now() - tb).toFixed(0)} ms`);
  window.__tornadeShell = { lines, bundle, prefix };
}

// One run at a time: the automatic start and a button press would otherwise download the same files
// twice in parallel and boot the app twice.
let running = false;
let booted = false;
async function run(withBoot) {
  if (running || booted) { log(running ? 'already running' : 'app already started: reload to run again'); return; }
  running = true;
  for (const id of ['go', 'dl', 'wipe']) $(id).disabled = true;
  try {
    if (!('caches' in window) || !crypto.subtle) throw new Error('Cache Storage / WebCrypto unavailable (insecure context?)');
    const tp = await transport();
    const app = await download(tp);
    if (withBoot) { booted = true; await boot(app, tp); }
  } catch (e) {
    log(`✖ ${e?.message ?? e}`);
  } finally {
    running = false;
    for (const id of ['go', 'dl', 'wipe']) if ($(id)) $(id).disabled = false;
  }
}

// --- immediate start from the cache, update in the background ---
// The last complete build of the current instance, if every file of it is still cached.
async function cachedApp(tp) {
  const key = keyOf(tp);
  const build = localStorage.getItem(`tornade.app.${key}`);
  if (!build || !(await caches.has(cacheName(key, build)))) return null;
  const cache = await caches.open(cacheName(key, build));
  const prefix = prefixOf(key, build);
  if (!(await cache.match(prefix + 'index.html'))) return null;
  return { prefix, cache, bundle: { build_id: build, entry: 'index.html' } };
}

// Builds of this instance other than `keep` (left over by a background update).
async function dropOtherBuilds(tp, keep) {
  const key = keyOf(tp);
  for (const n of await caches.keys()) {
    if (n.startsWith(`tornade-app-${key}-`) && n !== cacheName(key, keep)) await caches.delete(n);
  }
}

function showUpdateBanner() {
  if (document.getElementById('tornade-update')) return;
  const b = document.createElement('div');
  b.id = 'tornade-update';
  b.setAttribute('role', 'status');
  b.style.cssText = 'position:fixed;left:50%;bottom:calc(16px + env(safe-area-inset-bottom));transform:translateX(-50%);z-index:2147483647;display:flex;gap:12px;align-items:center;padding:10px 14px;border-radius:10px;background:#24242b;color:#e6e6ea;font:14px system-ui,sans-serif;box-shadow:0 4px 20px #0008';
  b.innerHTML = '<span>A new version of Tornade is ready.</span>';
  const btn = document.createElement('button');
  btn.textContent = 'Reload';
  btn.style.cssText = 'font:inherit;padding:6px 12px;border:0;border-radius:6px;background:#6fa7ee;color:#16161a;cursor:pointer';
  btn.onclick = () => location.reload();
  b.append(btn);
  document.body.append(b);
}

async function startFromCache(tp) {
  const app = await cachedApp(tp);
  if (!app) return false;
  log(`starting build ${app.bundle.build_id} from the cache`);
  running = true;
  booted = true;
  try {
    await boot(app, tp);
  } catch (e) {
    booted = false;
    throw e;
  } finally {
    running = false;
  }
  dropOtherBuilds(tp, app.bundle.build_id).catch(() => {});
  // Meanwhile: connect (the app does too, on the same link) and fetch a newer build if any.
  (async () => {
    try {
      const live = await transport();
      const next = await download(live, { cleanup: false });
      if (next.bundle.build_id !== app.bundle.build_id) {
        log(`update ${next.bundle.build_id} downloaded, ready on reload`);
        showUpdateBanner();
      } else {
        log('build up to date');
      }
    } catch (e) {
      log(`background update failed: ${e?.message ?? e}`);
    }
  })();
  return true;
}

// --- UI wiring ---
if ('serviceWorker' in navigator) {
  // tornade-pwa.js registers sw.js too; the registration is idempotent.
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((e) => log(`sw: ${e}`));
}
// Pairing link from the QR code: store it, then drop the secret from the address bar and history.
const linked = params.has('owner') ? acceptLink(location.search) : null;
if (linked) {
  log(`pairing link received for ${linked.slice(0, 12)}…`);
  const keep = params.get('direct') ? `?direct=${encodeURIComponent(params.get('direct'))}` : '';
  history.replaceState(null, '', location.pathname + keep + location.hash);
}
$('owner').value = localStorage.getItem(CURRENT) ?? '';
$('direct').value = params.get('direct') ?? '';
$('go').onclick = () => run(true);
$('dl').onclick = () => run(false);
$('copy').onclick = () => navigator.clipboard.writeText((window.tornadeDevlog?.text() ?? lines.join('\n')) + '\n\n' + localStorage.getItem('tornade.spike.results')).then(() => log('log copied'));
$('send').onclick = () => (window.tornadeDevlog?.flush() ?? Promise.resolve()).then(() => log(`log sent (session ${window.tornadeDevlog?.session})`));
$('wipe').onclick = async () => {
  for (const n of await caches.keys()) if (n.startsWith('tornade-app-')) await caches.delete(n);
  log('cache cleared');
};
log(`shell ready (${navigator.userAgent.split(') ')[0]})`);
log(`DecompressionStream gzip: ${typeof DecompressionStream === 'function' ? 'yes' : 'no'}`);
navigator.storage?.persisted?.().then((p) => log(`persistent storage: ${p ? 'yes' : 'no'}`));
const pendingPairing = instances().some((x) => x.id === localStorage.getItem(CURRENT) && x.pairing);
const known = params.get('direct')
  ? { mode: 'direct', origin: params.get('direct').replace(/\/$/, '') }
  : localStorage.getItem(CURRENT) ? { mode: 'iroh', owner: localStorage.getItem(CURRENT) } : null;
if (known && !pendingPairing && !params.has('nocache')) {
  startFromCache(known).then((started) => { if (!started) run(true); }).catch((e) => { log(`✖ ${e?.message ?? e}`); run(true); });
} else if (linked || known) run(true);
else log('no instance yet: scan the QR code shown by Tornade on your computer, or paste its pairing link');
