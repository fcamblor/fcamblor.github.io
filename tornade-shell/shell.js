// SPIKE (ADR 0003): frozen shell that downloads the app from the primary and boots it in place.
// Throwaway code: it exists to answer the spike's questions, not to ship.
//
// Modes:
//  - iroh (real use): connects to the instance through tornadePwa, pairs if `?pair=` is pending.
//  - direct (desktop only, `?direct=http://127.0.0.1:port`): plain HTTP to a local primary, to test
//    the download + in-place boot without iroh.
// Options: `?par=N` parallel downloads, `?auto=1` boots on load if a build is cached.

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

// --- transport: `get(path)` returns a Response from the primary ---
async function transport() {
  const direct = $('direct').value.trim().replace(/\/$/, '');
  if (direct) {
    log(`mode direct → ${direct}`);
    return { mode: 'direct', origin: direct, get: (p) => fetch(direct + p, { cache: 'no-store' }) };
  }
  const owner = acceptLink($('owner').value.trim()) ?? localStorage.getItem(CURRENT);
  if (!owner) throw new Error('aucune instance : colle le lien d’appairage ou un EndpointId');
  log(`connexion iroh à ${owner.slice(0, 12)}…`);
  const tc = performance.now();
  await window.tornadePwa.connect(owner);
  log(`connecté en ${(performance.now() - tc).toFixed(0)} ms`);
  const inst = instances().find((x) => x.id === owner);
  if (inst?.pairing) {
    log('appairage…');
    const r = await fetch('/api/devices/pair', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: inst.pairing, user_agent: navigator.userAgent }),
    });
    if (!r.ok) throw new Error(`appairage refusé : ${r.status} ${await r.text()}`);
    upsert({ id: owner, pairing: null });
    log('appairé');
  }
  return { mode: 'iroh', owner, get: (p) => window.tornadePwa.fetchPrimary(p) };
}

// --- download: manifest → missing files → SHA-256 check → Cache Storage ---
async function download(tp) {
  const par = Math.max(1, Number($('par').value) || 4);
  const tm = performance.now();
  const res = await tp.get('/api/pwa/bundle');
  if (!res.ok) throw new Error(`/api/pwa/bundle : ${res.status} (primary trop ancien ?)`);
  const bundle = await res.json();
  const total = bundle.files.reduce((n, f) => n + f.size, 0);
  log(`manifest en ${(performance.now() - tm).toFixed(0)} ms : build ${bundle.build_id}, ${bundle.files.length} fichiers, ${kb(total)}`);
  const big = bundle.files.find((f) => f.path.endsWith('.wasm') && f.size > 30 * 1024 * 1024);
  if (big) log(`⚠ ${big.path} fait ${kb(big.size)} : bundle debug ?`);

  const key = `${tp.mode === 'iroh' ? tp.owner.slice(0, 16) : 'direct'}`;
  const prefix = new URL(`app/${key}/${bundle.build_id}/`, location.href).href;
  const cache = await caches.open(`tornade-app-${key}-${bundle.build_id}`);

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
  log(`${todo.length} fichiers à télécharger (${kb(bytes)}), ${reused} repris d’un build précédent`);

  const td = performance.now();
  let done = 0;
  let got = 0;
  const one = async (f) => {
    const t = performance.now();
    const r = await tp.get('/' + f.path.split('/').map(encodeURIComponent).join('/'));
    if (!r.ok) throw new Error(`${f.path} : ${r.status}`);
    const buf = await r.arrayBuffer();
    const sha = hex(await crypto.subtle.digest('SHA-256', buf));
    if (sha !== f.sha256) throw new Error(`${f.path} : empreinte invalide`);
    await cache.put(prefix + f.path, new Response(buf, { headers: { 'content-type': mimeOf(f.path), 'x-sha256': sha } }));
    done++; got += buf.byteLength;
    if (f.size > 100 * 1024 || done === todo.length) {
      log(`  ${f.path} ${kb(f.size)} en ${(performance.now() - t).toFixed(0)} ms (${done}/${todo.length})`);
    }
  };
  const queue = [...todo].sort((a, b) => b.size - a.size);
  await Promise.all(Array.from({ length: par }, async () => { while (queue.length) await one(queue.shift()); }));
  const s = (performance.now() - td) / 1000;
  if (todo.length) log(`téléchargé ${kb(got)} en ${s.toFixed(2)} s (${(got / 1024 / s).toFixed(0)} KiB/s, //${par})`);

  // Switch only once the set is complete, then drop the old builds.
  localStorage.setItem(`tornade.app.${key}`, bundle.build_id);
  for (const name of previous) await caches.delete(name);
  saveResult({ mode: tp.mode, build: bundle.build_id, files: bundle.files.length, total, downloaded: got, seconds: s, par });
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
  log(`boot injecté en ${(performance.now() - tb).toFixed(0)} ms`);
  window.__tornadeShell = { lines, bundle, prefix };
}

async function run(withBoot) {
  try {
    if (!('caches' in window) || !crypto.subtle) throw new Error('Cache Storage / WebCrypto indisponible (contexte non sécurisé ?)');
    const tp = await transport();
    const app = await download(tp);
    if (withBoot) await boot(app, tp);
  } catch (e) {
    log(`✖ ${e?.message ?? e}`);
  }
}

// --- UI wiring ---
if ('serviceWorker' in navigator) {
  // tornade-pwa.js registers sw.js too; the registration is idempotent.
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((e) => log(`sw : ${e}`));
}
$('owner').value = location.search.includes('owner=') ? location.search : (localStorage.getItem(CURRENT) ?? '');
$('direct').value = params.get('direct') ?? '';
if (params.get('par')) $('par').value = params.get('par');
$('go').onclick = () => run(true);
$('dl').onclick = () => run(false);
$('copy').onclick = () => navigator.clipboard.writeText(lines.join('\n') + '\n\n' + localStorage.getItem('tornade.spike.results')).then(() => log('log copié'));
$('wipe').onclick = async () => {
  for (const n of await caches.keys()) if (n.startsWith('tornade-app-')) await caches.delete(n);
  log('cache vidé');
};
log(`shell prêt (${navigator.userAgent.split(') ')[0]})`);
log(`DecompressionStream gzip : ${typeof DecompressionStream === 'function' ? 'oui' : 'non'}`);
navigator.storage?.persisted?.().then((p) => log(`stockage persistant : ${p ? 'oui' : 'non'}`));
if (params.get('auto') === '1') run(true);
