import init, { connect as irohConnect, device_id } from './pkg/tornade_iroh_web.js';

const isApi = (u) => u.origin === location.origin && u.pathname.startsWith('/api/');
let ready = null;
let connectedOwner = null;
let wasm = null;
const loadWasm = () => (wasm ??= init({ module_or_path: new URL('./pkg/tornade_iroh_web_bg.wasm', import.meta.url) }));

const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, opts) => {
  const req = new Request(input, opts);
  const url = new URL(req.url, location.href);
  if (!isApi(url) || !ready) return nativeFetch(input, opts);
  const link = await ready;
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : new Uint8Array(await req.arrayBuffer());
  const r = await link.fetch(req.method, url.pathname + url.search, [...req.headers], body);
  return new Response([101, 204, 205, 304].includes(r.status) ? null : r.body, { status: r.status, headers: r.headers });
};

const NativeWebSocket = window.WebSocket;

class IrohWebSocket extends EventTarget {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  #sock = null;
  constructor(path) {
    super();
    this.url = path; this.readyState = 0; this.binaryType = 'blob'; this.protocol = ''; this.extensions = '';
    this.bufferedAmount = 0;
    this.onopen = this.onmessage = this.onclose = this.onerror = null;
    this.#start(path);
  }
  async #start(path) {
    try {
      const link = await ready;
      this.#sock = await link.websocket(path);
      if (this.readyState !== 0) return this.#sock.close(1000, '');
      this.readyState = 1;
      this.#emit(new Event('open'));
      for (;;) {
        const m = await this.#sock.next();
        if (m.kind === 'close') { this.#closed(m.code ?? 1006, m.reason ?? ''); return; }
        let data = m.data;
        if (m.kind === 'binary') data = this.binaryType === 'arraybuffer' ? m.data.buffer : new Blob([m.data]);
        this.#emit(new MessageEvent('message', { data }));
      }
    } catch (e) {
      console.warn('iroh websocket', e);
      this.#emit(new Event('error'));
      this.#closed(1006, String(e));
    }
  }
  #emit(ev) {
    this.dispatchEvent(ev);
    this[`on${ev.type}`]?.(ev);
  }
  #closed(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#emit(new CloseEvent('close', { code, reason, wasClean: code === 1000 }));
  }
  send(data) {
    if (this.readyState !== 1) throw new DOMException('WebSocket is not open', 'InvalidStateError');
    if (typeof data === 'string') return void this.#sock.send_text(data);
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (bytes) return void this.#sock.send_binary(bytes);
    if (data instanceof Blob) data.arrayBuffer().then((b) => this.#sock?.send_binary(new Uint8Array(b)));
  }
  close(code = 1000, reason = '') {
    if (this.readyState >= 2) return;
    const wasOpen = this.readyState === 1;
    this.readyState = 2;
    if (wasOpen) this.#sock.close(code, reason).finally(() => this.#closed(code, reason));
    else this.#closed(code, reason);
  }
}

window.WebSocket = function (url, protocols) {
  const u = new URL(url, location.href);
  const apiOrigin = u.host === location.host && u.pathname.startsWith('/api/');
  if (apiOrigin && ready) return new IrohWebSocket(u.pathname + u.search);
  return new NativeWebSocket(url, protocols);
};
Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, prototype: NativeWebSocket.prototype });

const b64u = (s) => {
  const b = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

// Chromium fires `beforeinstallprompt` once, possibly before the wasm app mounts: keep it
// for the in-app install banner, which listens to `tornade-installable` for late arrivals.
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  window.dispatchEvent(new Event('tornade-installable'));
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  window.dispatchEvent(new Event('tornade-installable'));
});

window.tornadePwa = {
  canInstall() { return installPrompt !== null; },
  /** Shows the native install dialog; resolves to true when the user accepted. */
  async install() {
    const p = installPrompt;
    if (!p) return false;
    installPrompt = null;
    await p.prompt();
    const { outcome } = await p.userChoice;
    window.dispatchEvent(new Event('tornade-installable'));
    return outcome === 'accepted';
  },
  /** Connects the PWA to the `owner` instance; subsequent /api/… calls are routed to it. */
  async connect(owner) {
    // SPIKE (ADR 0003): the app booted by the shell reuses the shell's connection.
    if (ready && connectedOwner === owner) return ready;
    await loadWasm();
    connectedOwner = owner;
    ready = irohConnect(owner, undefined);
    try { await ready; } catch (e) { ready = null; connectedOwner = null; throw e; }
  },
  /** SPIKE (ADR 0003): GET any path of the connected primary (static files included). */
  async fetchPrimary(path) {
    if (!ready) throw new Error('not connected');
    const r = await (await ready).fetch('GET', path, [], undefined);
    return new Response(r.body, { status: r.status, headers: r.headers });
  },
  async deviceId() { await loadWasm(); return device_id(); },
  standalone() { return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; },
  pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; },
  /** Web Push subscription (iOS requires a user gesture): JSON to send to the instance. */
  async subscribePush(vapidPublicKey) {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') throw new Error('notifications denied');
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (sub && sub.options?.applicationServerKey) {
      const cur = new Uint8Array(sub.options.applicationServerKey);
      const want = b64u(vapidPublicKey);
      if (cur.length !== want.length || cur.some((b, i) => b !== want[i])) { await sub.unsubscribe(); sub = null; }
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64u(vapidPublicKey) });
    return JSON.stringify(sub.toJSON());
  },
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((e) => console.warn('sw', e));
