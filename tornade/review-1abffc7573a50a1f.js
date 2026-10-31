window.adeReview = (() => {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const block = (n) => (n && (n.nodeType === 1 ? n : n.parentElement))?.closest("[data-l0]");

  function selection(root) {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
    const r = sel.getRangeAt(0);
    if (!root.contains(r.commonAncestorContainer)) return null;
    const a = block(r.startContainer), b = block(r.endContainer);
    if (!a || !b) return null;
    const text = sel.toString();
    if (!norm(text)) return null;
    const before = document.createRange();
    before.setStart(a, 0); before.setEnd(r.startContainer, r.startOffset);
    const after = document.createRange();
    after.setStart(r.endContainer, r.endOffset); after.setEndAfter(b.lastChild || b);
    const rects = r.getClientRects();
    const last = rects.length ? rects[rects.length - 1] : r.getBoundingClientRect();
    return {
      text,
      msg: a.closest("[data-msg]")?.dataset.msg || "",
      l0: +a.dataset.l0,
      l1: Math.max(+b.dataset.l1, +a.dataset.l0),
      prefix: before.toString().slice(-40),
      suffix: after.toString().slice(0, 40),
      x: last.right, y: last.bottom,
    };
  }

  function hasSelection() { const s = window.getSelection(); return !!s && !s.isCollapsed; }

  function clear() { window.getSelection()?.removeAllRanges(); }

  function mark(els, quote, id) {
    const q = norm(quote);
    if (!q) return false;
    const nodes = [];
    for (const el of els) {
      const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => n.parentElement.closest(".cl-num, .cl-mark, mark") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
      });
      for (let n; (n = w.nextNode());) nodes.push(n);
      nodes.push(null);
    }
    let flat = "", map = [], space = true;
    for (const n of nodes) {
      const t = n ? n.data : " ";
      for (let i = 0; i < t.length; i++) {
        if (/\s/.test(t[i])) { if (!space) { flat += " "; map.push([n, i]); space = true; } }
        else { flat += t[i]; map.push([n, i]); space = false; }
      }
    }
    const at = flat.indexOf(q);
    if (at < 0) return false;
    const [sn, so] = map[at], [en, eo] = map[at + q.length - 1];
    let on = false;
    for (const n of nodes) {
      if (!n) continue;
      if (n === sn) on = true;
      if (!on) continue;
      const s = n === sn ? so : 0, e = n === en ? eo + 1 : n.data.length;
      if (e > s && n.data.slice(s, e).trim()) {
        let mid = n;
        if (s > 0) mid = n.splitText(s);
        if (e - s < mid.data.length) mid.splitText(e - s);
        const m = document.createElement("mark");
        m.className = "cmark"; m.dataset.thread = id;
        mid.parentNode.insertBefore(m, mid); m.appendChild(mid);
      }
      if (n === en) break;
    }
    return true;
  }

  function unmark(root) {
    root.querySelectorAll("mark.cmark").forEach((m) => { m.replaceWith(...m.childNodes); });
    root.normalize();
  }

  function reveal(id) {
    const el = document.getElementById(id);
    if (!el) return false;
    el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
    const ta = el.querySelector("textarea");
    if (ta && el.dataset.focus === "1") ta.focus({ preventScroll: true });
    return true;
  }

  function hover(root, id, on) {
    root.querySelectorAll(`[data-thread="${CSS.escape(id)}"]`).forEach((e) => e.classList.toggle("hot", on));
  }

  return { selection, hasSelection, clear, mark, unmark, reveal, hover };
})();
