// In-view search (cmd/ctrl+F) over rendered DOM: matches are painted with the
// CSS Custom Highlight API so the view's own markup is never touched.
window.adeFind = (() => {
  const ALL = "ade-find", CUR = "ade-find-current";
  const MAX = 10000;
  let owner = null;

  function textNodes(root) {
    const out = [];
    const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => n.parentElement?.closest(".find-dock, [aria-hidden=true]")
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n);
    return out;
  }

  function search(root, q) {
    const st = root.__adeFind || (root.__adeFind = { ranges: [], cur: 0 });
    st.q = q;
    st.ranges = [];
    if (q) {
      const nodes = textNodes(root);
      const starts = [];
      let all = "";
      for (const n of nodes) { starts.push(all.length); all += n.data; }
      let hay = all.toLowerCase(), needle = q.toLowerCase();
      // Lowercasing changed lengths: offsets would no longer map, search case-sensitively.
      if (hay.length !== all.length) { hay = all; needle = q; }
      const at = (off) => {
        let lo = 0, hi = starts.length - 1;
        while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= off) lo = m; else hi = m - 1; }
        return [nodes[lo], off - starts[lo]];
      };
      for (let i = hay.indexOf(needle); i >= 0 && st.ranges.length < MAX; i = hay.indexOf(needle, i + needle.length)) {
        const r = document.createRange();
        const [a, ao] = at(i), [b, bo] = at(i + needle.length - 1);
        r.setStart(a, ao); r.setEnd(b, bo + 1);
        st.ranges.push(r);
      }
    }
    st.cur = Math.min(st.cur, Math.max(st.ranges.length - 1, 0));
    paint(root);
    return st.ranges.length;
  }

  function paint(root) {
    const st = root.__adeFind;
    if (!st || typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
    owner = root;
    CSS.highlights.set(ALL, new Highlight(...st.ranges));
    const c = st.ranges[st.cur];
    CSS.highlights.set(CUR, c ? new Highlight(c) : new Highlight());
  }

  // Makes match `i` current and scrolls it into view (only when off-screen).
  function go(root, i) {
    const st = root.__adeFind;
    if (!st || !st.ranges.length) return;
    st.cur = ((i % st.ranges.length) + st.ranges.length) % st.ranges.length;
    paint(root);
    const r = st.ranges[st.cur];
    const el = r.startContainer.parentElement;
    if (!el) return;
    const box = r.getBoundingClientRect();
    let p = el.parentElement, visible = true;
    for (; p && p !== document.documentElement; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (!/(auto|scroll)/.test(s.overflow + s.overflowY + s.overflowX)) continue;
      const pb = p.getBoundingClientRect();
      if (box.top < pb.top || box.bottom > pb.bottom || box.left < pb.left || box.right > pb.right) visible = false;
    }
    if (!visible) el.scrollIntoView({ block: "center", inline: "nearest" });
  }

  // Re-runs the search when the view re-renders; `cb(count)` reports the new count.
  function watch(root, cb) {
    unwatch(root);
    let t = 0;
    const mo = new MutationObserver((muts) => {
      if (muts.every((m) => m.target.closest?.(".find-dock") || m.target.parentElement?.closest(".find-dock"))) return;
      clearTimeout(t);
      t = setTimeout(() => { const st = root.__adeFind; if (st) cb(search(root, st.q)); }, 80);
    });
    mo.observe(root, { subtree: true, childList: true, characterData: true });
    root.__adeFindMo = mo;
  }

  function unwatch(root) {
    root.__adeFindMo?.disconnect();
    root.__adeFindMo = null;
  }

  function clear(root) {
    unwatch(root);
    delete root.__adeFind;
    if (owner === root && typeof CSS !== "undefined" && CSS.highlights) {
      CSS.highlights.delete(ALL);
      CSS.highlights.delete(CUR);
      owner = null;
    }
  }

  // Single-line text selected inside `root`, to prefill the search.
  function selectedText(root) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !root.contains(sel.anchorNode)) return "";
    const t = sel.toString();
    return t.includes("\n") ? "" : t;
  }

  return { search, go, watch, clear, selectedText };
})();
