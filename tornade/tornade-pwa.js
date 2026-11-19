import init, { connect as irohConnect } from './pkg/tornade_iroh_web.js';

const isApi = (u) => u.origin === location.origin && u.pathname.startsWith('/api/');
let ready = null;
let connectedOwner = null;
let currentLink = null;
let wasm = null;
const loadWasm = () => (wasm ??= init({ module_or_path: new URL('./pkg/tornade_iroh_web_bg.wasm', import.meta.url) }));

const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, opts) => {
  // Check the URL before building a Request: `new Request(request)` consumes the original body,
  // which then breaks the native fetch of non-API requests (iroh's pkarr PUT, for one).
  const url = new URL(input instanceof Request ? input.url : String(input), location.href);
  if (!isApi(url) || !ready) return nativeFetch(input, opts);
  const req = new Request(input, opts);
  const link = await ready;
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : new Uint8Array(await req.arrayBuffer());
  let r;
  try {
    r = await link.fetch(req.method, url.pathname + url.search, [...req.headers], body);
  } catch (e) {
    // Like a native fetch: callers (gloo-net) expect an Error, the wasm side may throw a string.
    throw e instanceof Error ? e : new TypeError(`iroh fetch failed: ${e}`);
  }
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

// The website's frozen contract with the app (ADR 0003, "Launcher contract"). Keep it this small:
// anything else belongs in the app, which is downloaded from the primary and evolves freely.
//   - fetch / WebSocket to `/api/…` go to the connected primary (above);
//   - `tornadePwa.connect(owner)`, `fetchPrimary(path)`, `homeRelay()`;
//   - `window.tornadeInstallPrompt`: Chromium's `beforeinstallprompt` event, which fires once and
//     possibly before the app mounts, so it is kept here; `tornade-installable` signals changes.
window.tornadeInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  window.tornadeInstallPrompt = e;
  window.dispatchEvent(new Event('tornade-installable'));
});
window.addEventListener('appinstalled', () => {
  window.tornadeInstallPrompt = null;
  window.dispatchEvent(new Event('tornade-installable'));
});

window.tornadePwa = {
  /** Connects to the `owner` instance; subsequent /api/… calls are routed to it. */
  async connect(owner) {
    // The app started by the launcher reuses the launcher's connection.
    if (ready && connectedOwner === owner) return ready;
    await loadWasm();
    connectedOwner = owner;
    ready = irohConnect(owner, undefined);
    try { currentLink = await ready; } catch (e) { ready = null; connectedOwner = null; throw e; }
  },
  /** GET any path of the connected primary (static files included), for the launcher. */
  async fetchPrimary(path) {
    if (!ready) throw new Error('not connected');
    const r = await (await ready).fetch('GET', path, [], undefined);
    return new Response(r.body, { status: r.status, headers: r.headers });
  },
  /** The relay this device goes through (browsers only reach the primary through a relay). */
  homeRelay() { return currentLink?.home_relay?.() ?? null; },
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js', { scope: './' }).catch((e) => console.warn('sw', e));
