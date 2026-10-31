window.adeTerm = {
  open(el, url) {
    const term = new Terminal({
      fontFamily: "JetBrains Mono, \"Symbols Nerd Font Mono\", \"MesloLGS NF\", \"Source Code Pro for Powerline\", \"Meslo LG M for Powerline\", ui-monospace, Menlo, monospace",
      fontSize: Math.round(parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.8125),
      cursorBlink: true,
      theme: (() => {
        const probe = document.createElement("span");
        probe.style.display = "none";
        el.appendChild(probe);
        // xterm does not read OKLCH, so sample a rendered pixel and convert it to RGB.
        const cv = document.createElement("canvas"); cv.width = cv.height = 1;
        const cx = cv.getContext("2d", { willReadFrequently: true });
        const v = (n) => {
          if (!getComputedStyle(el).getPropertyValue(n).trim()) return undefined;
          probe.style.color = `var(${n})`;
          const c = getComputedStyle(probe).color;
          cx.clearRect(0, 0, 1, 1); cx.fillStyle = "#000"; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1);
          const [r, g, b] = cx.getImageData(0, 0, 1, 1).data;
          return `rgb(${r}, ${g}, ${b})`;
        };
        const theme = { background: v("--term-bg") || "#1b1d22", foreground: v("--fg") || "#e6e6e6", cursor: v("--accent"), selectionBackground: v("--accent-soft") };
        probe.remove();
        return theme;
      })(),
    });
    const fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(el);
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
    const resize = () => {
      try { fit.fit(); } catch (_) {}
      send({ t: "resize", cols: term.cols, rows: term.rows });
    };
    ws.onopen = resize;
    ws.onmessage = (e) => term.write(new Uint8Array(e.data));
    term.onData((data) => send({ t: "input", data }));
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    return { dispose() { ro.disconnect(); ws.close(); term.dispose(); }, focus() { term.focus(); } };
  },
  dispose(h) { h && h.dispose(); },
  focus(h) { h && h.focus(); },
};
