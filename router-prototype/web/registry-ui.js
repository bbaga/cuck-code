// Read-only global Registry dashboard: pure helpers plus DOM code.
// Loaded in the browser via <script> and in Node tests via require().
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.registryUI = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const STATUSES = ["planned", "active", "available", "superseded", "stale", "merged"];
  const FILTERS = [{ value: "current", label: "current" }, { value: "all", label: "all" }]
    .concat(STATUSES.map((s) => ({ value: s, label: s })));
  const POLL_MS = 15000;
  const MAX_ERRORS = 3;

  function statusQuery(filter) {
    if (filter === "current") return "";
    return STATUSES.includes(filter) || filter === "all" ? filter : "";
  }
  function listUrl(kind, { filter, q, page, pageSize }) {
    const p = new URLSearchParams();
    if (kind === "claims") {
      const s = statusQuery(filter);
      if (s) p.set("status", s);
      if (q && q.trim()) p.set("q", q.trim());
    }
    p.set("page", String(page || 1));
    p.set("pageSize", String(pageSize || 25));
    return "/api/registry/" + kind + "?" + p.toString();
  }
  function pagingLabel(r) {
    if (!r || !r.total) return "page 1 of 1 (0 total)";
    const pages = Math.max(1, Math.ceil(r.total / r.pageSize));
    return "page " + r.page + " of " + pages + " (" + r.total + " total)";
  }
  const shortCommit = (c) => (c ? String(c).slice(0, 8) : "-");
  function mergeCheckLabel(m) {
    if (!m || !m.checkedAt) return "never checked";
    if (m.verified) return "verified";
    return "unverified" + (m.reason ? ": " + m.reason : m.error ? ": " + m.error : "");
  }
  function claimRow(c) {
    const badges = [];
    if (c.status === "stale" || c.staleReason) badges.push("stale: " + (c.staleReason || "unknown"));
    if (c.unverified) badges.push("unverified");
    return {
      id: c.id,
      title: c.title || "",
      status: c.status || "",
      owner: (c.ownerLineName || c.ownerLineId || "-") + (c.ownerExists === false ? " (deleted owner)" : ""),
      repo: c.repo || "-",
      branch: c.branch || "-",
      commit: shortCommit(c.commit),
      revision: c.revision == null ? "-" : String(c.revision),
      updated: c.updatedAt || "-",
      mergeCheck: mergeCheckLabel(c.mergeCheck),
      badges,
    };
  }
  function archiveRow(a) {
    const e = a.mergeEvidence || {};
    return {
      id: a.id,
      title: a.title || "",
      mergedAt: a.mergedAt || "-",
      repository: e.repositoryUrl || a.repo || "-",
      targetBranch: e.targetBranch || "-",
      strategy: e.strategy || "-",
      pullRequest: e.pullRequest == null ? "-"
        : typeof e.pullRequest === "object" ? "#" + (e.pullRequest.number ?? "?") : "#" + e.pullRequest,
      commit: shortCommit(e.commit || a.commit),
      checkedAt: e.checkedAt || "-",
    };
  }
  const shouldRefetch = (shown, ev) => Number.isFinite(ev) && (!Number.isFinite(shown) || ev > shown);

  function createConnection() {
    const s = { label: "offline", errors: 0, polling: false };
    return {
      state: s,
      onOpen() { s.label = "live"; s.errors = 0; s.polling = false; return s; },
      onError() {
        s.errors += 1;
        s.label = s.errors >= MAX_ERRORS ? "offline" : "reconnecting";
        if (s.errors >= MAX_ERRORS) s.polling = true;
        return s;
      },
      onUnavailable() { s.label = "offline"; s.polling = true; return s; },
    };
  }

  function createToggle(hideLines, showLines, onOpen, onClose) {
    const t = { open: false };
    return {
      get open() { return t.open; },
      show() { if (t.open) return; t.open = true; hideLines(); onOpen(); },
      hide() { if (!t.open) return; t.open = false; showLines(); onClose(); },
      toggle() { if (t.open) this.hide(); else this.show(); },
    };
  }

  function mount(doc, container, opts) {
    const win = opts.window || {};
    const fetchFn = opts.fetch;
    const st = { kind: "claims", filter: "current", q: "", page: 1, result: null,
      revision: null, summary: null, error: "", refreshed: "", es: null, timer: null, poll: null };
    const conn = createConnection();
    const el = (tag, text, cls) => {
      const n = doc.createElement(tag);
      if (text != null) n.textContent = text;
      if (cls) n.className = cls;
      return n;
    };
    const summaryBar = el("div", null, "regSummary");
    const connLabel = el("span", null, "regConn");
    connLabel.setAttribute("role", "status");
    const errLine = el("div", null, "regError");
    errLine.setAttribute("role", "alert");
    const tabs = el("div", null, "regTabs");
    const tabBtns = {};
    for (const k of ["claims", "archive"]) {
      const b = el("button", k === "claims" ? "Claims" : "Archive");
      b.addEventListener("click", () => { st.kind = k; st.page = 1; load(); });
      tabBtns[k] = b;
      tabs.append(b);
    }
    const sel = el("select");
    sel.setAttribute("aria-label", "Status filter");
    for (const f of FILTERS) { const o = el("option", f.label); o.value = f.value; sel.append(o); }
    sel.addEventListener("change", () => { st.filter = sel.value; st.page = 1; load(); });
    const search = el("input");
    search.type = "search";
    search.setAttribute("aria-label", "Search claims");
    let deb = null;
    search.addEventListener("input", () => {
      win.clearTimeout(deb);
      deb = win.setTimeout(() => { st.q = search.value; st.page = 1; load(); }, 300);
    });
    const tableWrap = el("div", null, "regTableWrap");
    const prev = el("button", "Previous");
    const next = el("button", "Next");
    const pageLabel = el("span");
    prev.addEventListener("click", () => { st.page -= 1; load(); });
    next.addEventListener("click", () => { st.page += 1; load(); });
    const pager = el("div", null, "regPager");
    pager.append(prev, pageLabel, next);
    const controls = el("div", null, "regControls");
    controls.append(sel, search, connLabel);
    container.replaceChildren(el("h2", "Registry"), summaryBar, errLine, tabs, controls, tableWrap, pager);

    const CLAIM_COLS = ["Title", "Status", "Owner line", "Repo", "Branch", "Commit", "Rev", "Updated", "Merge check"];
    const ARCH_COLS = ["Title", "Merged at", "Repository", "Target branch", "Strategy", "PR", "Commit", "Checked"];
    function render() {
      sel.hidden = search.hidden = st.kind !== "claims";
      for (const k of Object.keys(tabBtns)) tabBtns[k].setAttribute("aria-pressed", String(k === st.kind));
      const claims = st.kind === "claims";
      const items = (st.result && st.result.items) || [];
      const table = el("table");
      const hr = el("tr");
      for (const c of claims ? CLAIM_COLS : ARCH_COLS) { const th = el("th", c); th.scope = "col"; hr.append(th); }
      const thead = el("thead");
      thead.append(hr);
      table.append(thead);
      const body = el("tbody");
      for (const it of items) {
        const tr = el("tr");
        if (claims) {
          const r = claimRow(it);
          const status = el("td", r.status);
          for (const b of r.badges) status.append(" ", el("span", b, "regBadge"));
          tr.append(el("td", r.title), status, el("td", r.owner), el("td", r.repo), el("td", r.branch),
            el("td", r.commit), el("td", r.revision), el("td", r.updated), el("td", r.mergeCheck));
        } else {
          const r = archiveRow(it);
          tr.append(el("td", r.title), el("td", r.mergedAt), el("td", r.repository), el("td", r.targetBranch),
            el("td", r.strategy), el("td", r.pullRequest), el("td", r.commit), el("td", r.checkedAt));
        }
        body.append(tr);
      }
      table.append(body);
      const empty = st.failed ? "Could not load " + st.kind
        : st.result && !items.length ? (claims ? "No claims match" : "No archived items") : "";
      tableWrap.replaceChildren(empty ? el("p", empty) : table);
      pageLabel.textContent = pagingLabel(st.result);
      prev.disabled = !st.result || st.page <= 1;
      next.disabled = !st.result || !st.result.hasMore;
      const sm = st.summary;
      summaryBar.textContent = sm
        ? STATUSES.map((s) => s + ": " + ((sm.claimsByStatus || {})[s] || 0)).join(" | ")
          + " | archive: " + (sm.archiveCount || 0) + " | revision: " + (sm.snapshotRevision ?? "-")
        : "";
      connLabel.textContent = conn.state.label + (st.refreshed ? " (last refresh " + st.refreshed + ")" : "");
      errLine.textContent = st.error;
      errLine.hidden = !st.error;
    }
    async function getJson(url) {
      const res = await fetchFn(url);
      let body = null;
      try { body = await res.json(); } catch (_) { body = null; }
      if (!res.ok) {
        const msg = body && typeof body.error === "string" ? body.error : "";
        throw new Error(body && body.code ? body.code + (msg ? ": " + msg : "")
          : msg || "HTTP " + res.status);
      }
      return body;
    }
    function fail(err) {
      st.error = "Registry error: " + err.message;
      st.failed = true;
      st.result = null;
    }
    async function load() {
      try {
        const [list, sum] = await Promise.all([
          getJson(listUrl(st.kind, st)), getJson("/api/registry/summary")]);
        st.result = list; st.summary = sum; st.error = ""; st.failed = false;
        st.revision = sum.snapshotRevision;
        st.refreshed = new Date().toLocaleTimeString();
      } catch (err) {
        fail(err);
      }
      render();
    }
    function schedule() {
      win.clearTimeout(st.timer);
      st.timer = win.setTimeout(load, 300);
    }
    function startPolling() {
      if (st.poll) return;
      st.poll = win.setInterval(async () => {
        try {
          const sum = await getJson("/api/registry/summary");
          if (st.failed || shouldRefetch(st.revision, sum.snapshotRevision)) await load();
        } catch (err) { fail(err); render(); }
      }, POLL_MS);
    }
    function stopPolling() { win.clearInterval(st.poll); st.poll = null; }
    function connect() {
      if (!opts.EventSource) { conn.onUnavailable(); startPolling(); render(); return; }
      const es = new opts.EventSource("/api/registry/stream");
      st.es = es;
      es.addEventListener("hello", () => { conn.onOpen(); stopPolling(); load(); });
      es.addEventListener("registry", (ev) => {
        let d = null;
        try { d = JSON.parse(ev.data); } catch (_) { return; }
        conn.onOpen();
        if (shouldRefetch(st.revision, d && d.revision)) schedule();
        else render();
      });
      es.onerror = () => { if (conn.onError().polling) startPolling(); render(); };
    }
    function disconnect() {
      if (st.es) st.es.close();
      st.es = null;
      stopPolling();
      win.clearTimeout(st.timer);
      conn.state.label = "offline"; conn.state.errors = 0; conn.state.polling = false;
    }
    return { start() { render(); connect(); load(); }, stop: disconnect, load, state: st };
  }

  return { STATUSES, FILTERS, POLL_MS, statusQuery, listUrl, pagingLabel, shortCommit, mergeCheckLabel,
    claimRow, archiveRow, shouldRefetch, createConnection, createToggle, mount };
});
