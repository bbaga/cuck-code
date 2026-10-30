// Per-line Work view: publish/maintain claims, open and answer requests.
// Loaded in the browser via <script> and in Node tests via require().
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(root);
  else root.registryLine = factory(root);
})(typeof self !== "undefined" ? self : this, function (root) {
  const HEX40 = /^[0-9a-f]{40}$/;
  const OWNER_STATUSES = ["planned", "active", "available"];
  const trim = (v) => (v == null ? "" : String(v).trim());
  const tagList = (s) => trim(s).split(",").map((t) => t.trim()).filter(Boolean);
  const validCommit = (c) => HEX40.test(c || "");

  // Which claim actions the rules allow: superseded/merged are read-only, stale only renews or supersedes.
  function claimActions(status) {
    if (status === "superseded" || status === "merged") return [];
    return status === "stale" ? ["renew", "supersede"] : ["edit", "renew", "supersede"];
  }
  function requestActions(r, lineId) {
    if (!r || r.orphaned || r.targetLineId !== lineId) return [];
    return r.state === "open" ? ["accept", "decline"] : r.state === "accepted" ? ["fulfill"] : [];
  }

  function validateClaim(f) {
    if (!trim(f.title)) return "title is required";
    if (!trim(f.repo)) return "repo is required";
    if (!trim(f.branch)) return "branch is required";
    if (!validCommit(trim(f.commit))) return "commit must be 40 lowercase hex characters";
    return "";
  }
  function claimFields(f) {
    const o = { title: trim(f.title), summary: trim(f.summary), tags: tagList(f.tags),
      branch: trim(f.branch), commit: trim(f.commit), contract: trim(f.contract), status: f.status };
    if (!OWNER_STATUSES.includes(o.status)) delete o.status;
    for (const k of ["summary", "contract"]) if (!o[k]) delete o[k];
    return o;
  }
  const createClaimBody = (f, key) => ({ ...claimFields(f), repo: trim(f.repo), idempotencyKey: key });
  const editClaimBody = (f, revision) => ({ expectedRevision: revision, ...claimFields(f), summary: trim(f.summary), contract: trim(f.contract) });
  const renewBody = (revision, status) => (status ? { expectedRevision: revision, status } : { expectedRevision: revision });
  function supersedeBody(revision, byClaimId) {
    const id = trim(byClaimId);
    return id ? { expectedRevision: revision, byClaimId: id } : { expectedRevision: revision };
  }
  function validateRequest(f) {
    if (!trim(f.targetLineId)) return "target line is required";
    if (!trim(f.subject)) return "subject is required";
    if (!trim(f.text)) return "text is required";
    return "";
  }
  const createRequestBody = (f, key) => {
    const b = { targetLineId: trim(f.targetLineId), subject: trim(f.subject), text: trim(f.text), idempotencyKey: key };
    if (trim(f.claimId)) b.claimId = trim(f.claimId);
    return b;
  };
  function validateFulfil(f) {
    if (trim(f.claimId)) return "";
    if (!trim(f.branch)) return "pick a claim or enter a branch";
    return validCommit(trim(f.commit)) ? "" : "commit must be 40 lowercase hex characters";
  }
  function answerBody(state, revision, ref) {
    const b = { state, expectedRevision: revision };
    if (state === "fulfilled" && ref) {
      if (trim(ref.claimId)) b.reference = { claimId: trim(ref.claimId) };
      else {
        b.reference = { branch: trim(ref.branch), commit: trim(ref.commit) };
        if (trim(ref.contract)) b.reference.contract = trim(ref.contract);
      }
    }
    return b;
  }

  // One idempotency key per distinct submission; the same body on retry reuses it.
  function createKeeper(newId) {
    const gen = newId || (() => (root && root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID()
      : "k-" + Date.now().toString(36) + Math.random().toString(36).slice(2)));
    let sig = null, key = null;
    return { get(body) { const s = JSON.stringify(body); if (s !== sig) { sig = s; key = gen(); } return key; },
      clear() { sig = null; key = null; } };
  }

  function mapError(status, body) {
    const b = body || {};
    const code = b.code || b.error || "ERROR";
    if (status === 503 || code === "REGISTRY_UNAVAILABLE") return { message: "REGISTRY_UNAVAILABLE", panel: true, reload: false };
    if (status === 409 && code === "STALE_REVISION") return { message: "Changed elsewhere — reloaded", panel: false, reload: true };
    return { message: b.error && b.code ? b.code + ": " + b.error : String(code), panel: false, reload: false };
  }

  function mount(doc, container, opts) {
    const fetchFn = opts.fetch, lineId = opts.lineId;
    const enc = encodeURIComponent;
    const base = "/api/registry/lines/" + enc(lineId);
    const st = { claims: [], incoming: [], outgoing: [], lines: [], repos: [], targetClaims: [], editing: null, fulfilling: null, failed: {} };
    const claimKey = createKeeper(opts.newId), reqKey = createKeeper(opts.newId);
    const el = (tag, text, cls) => { const n = doc.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };
    const msg = () => { const n = el("div", "", "workMsg"); n.setAttribute("role", "alert"); return n; };
    const notice = msg();
    const claimsBox = el("div"), inBox = el("div"), outBox = el("div"), pubBox = el("form"), reqBox = el("form");
    container.replaceChildren(notice, el("h3", "My claims"), claimsBox, el("h3", "Publish claim"), pubBox,
      el("h3", "Incoming requests"), inBox, el("h3", "Outgoing requests"), outBox, el("h3", "New request"), reqBox);

    const field = (form, label, tag, value) => {
      const wrap = el("label", label + " "); const inp = el(tag || "input");
      if (value != null) inp.value = value;
      wrap.append(inp); form.append(wrap); return inp;
    };
    const select = (form, label, options, value) => {
      const s = field(form, label, "select", value);
      for (const [v, t] of options) { const o = el("option", t); o.value = v; s.append(o); }
      s.value = value == null ? (options[0] ? options[0][0] : "") : value; return s;
    };
    const lineName = (id) => (st.lines.find((l) => l.id === id) || {}).name || id;

    async function api(method, url, body, out) {
      try {
        const res = await fetchFn(url, body === undefined ? { method } : { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        let data = null;
        try { data = await res.json(); } catch { /* no body */ }
        if (res.ok) { if (out) out.textContent = ""; notice.textContent = ""; return { ok: true, data }; }
        const m = mapError(res.status, data);
        if (m.reload) await load(); // rows are rebuilt, so the note goes to the panel
        (m.panel || m.reload ? notice : out || notice).textContent = m.message;
        return { ok: false };
      } catch (e) { notice.textContent = "Network error: " + e.message; return { ok: false }; }
    }
    async function read(url) {
      try {
        const r = await fetchFn(url);
        let d = null;
        try { d = await r.json(); } catch { /* no body */ }
        if (!r.ok) { const m = mapError(r.status, d); notice.textContent = d && d.code && d.error ? d.code + ": " + d.error : m.message; return null; }
        return d;
      } catch (e) { notice.textContent = "Load failed: " + e.message; return null; }
    }

    function claimRow(c) {
      const li = el("li", [c.title, c.status, "rev " + c.revision, c.branch, String(c.commit || "").slice(0, 8)].join(" · "));
      li.setAttribute("data-claim-id", c.id);
      const out = msg(); const acts = claimActions(c.status);
      const btn = (name, label, fn) => { const b = el("button", label); b.type = "button"; b.addEventListener("click", fn); li.append(" ", b); };
      if (acts.includes("edit")) btn("edit", "Edit", () => { st.editing = c.id; renderClaims(); });
      if (acts.includes("renew")) btn("renew", "Renew", async () => { if ((await api("POST", base + "/claims/" + enc(c.id) + "/renew", renewBody(c.revision), out)).ok) load(); });
      if (acts.includes("supersede")) {
        const by = el("input"); by.setAttribute("aria-label", "Superseded by claim id (optional)"); by.placeholder = "by claim id";
        btn("supersede", "Supersede", async () => { if ((await api("POST", base + "/claims/" + enc(c.id) + "/supersede", supersedeBody(c.revision, by.value), out)).ok) load(); });
        li.append(" ", by);
      }
      li.append(out);
      if (st.editing === c.id && acts.includes("edit")) li.append(editForm(c, out));
      return li;
    }
    function editForm(c, out) {
      const f = el("form");
      const i = { title: field(f, "Title", "input", c.title), summary: field(f, "Summary", "input", c.summary || ""),
        tags: field(f, "Tags", "input", (c.tags || []).join(", ")), branch: field(f, "Branch", "input", c.branch),
        commit: field(f, "Commit", "input", c.commit), contract: field(f, "Contract", "input", c.contract || ""),
        status: select(f, "Status", OWNER_STATUSES.map((s) => [s, s]), OWNER_STATUSES.includes(c.status) ? c.status : "active") };
      const save = el("button", "Save"); save.type = "submit"; f.append(save);
      f.addEventListener("submit", async (e) => {
        if (e.preventDefault) e.preventDefault();
        const v = Object.fromEntries(Object.entries(i).map(([k, n]) => [k, n.value]));
        const bad = validateClaim({ ...v, repo: c.repo });
        if (bad) { out.textContent = bad; return; }
        if ((await api("PATCH", base + "/claims/" + enc(c.id), editClaimBody(v, c.revision), out)).ok) { st.editing = null; load(); }
      });
      return f;
    }
    function requestRow(r, incoming) {
      const other = incoming ? r.sourceLineId : r.targetLineId;
      const li = el("li", [r.subject, lineName(other), r.state, r.orphaned ? "orphaned" : "", "rev " + r.revision].filter(Boolean).join(" · "));
      li.setAttribute("data-request-id", r.id);
      if (!incoming) return li;
      const out = msg(); const acts = requestActions(r, lineId);
      const answer = async (state, ref) => { if ((await api("PATCH", base + "/requests/" + enc(r.id), answerBody(state, r.revision, ref), out)).ok) { st.fulfilling = null; load(); } };
      for (const [a, label, state] of [["accept", "Accept", "accepted"], ["decline", "Decline", "declined"]]) {
        if (acts.includes(a)) { const b = el("button", label); b.type = "button"; b.addEventListener("click", () => answer(state)); li.append(" ", b); }
      }
      if (acts.includes("fulfill")) {
        const b = el("button", "Mark fulfilled"); b.type = "button";
        b.addEventListener("click", () => { st.fulfilling = r.id; renderRequests(); }); li.append(" ", b);
      }
      li.append(out);
      if (st.fulfilling === r.id) {
        const f = el("form");
        const cl = select(f, "Claim", [["", "(none — use branch + commit)"]].concat(st.claims.filter((c) => c.status !== "superseded").map((c) => [c.id, c.title])), "");
        const br = field(f, "Branch"), cm = field(f, "Commit"), ct = field(f, "Contract");
        const ok = el("button", "Fulfil"); ok.type = "submit"; f.append(ok);
        f.addEventListener("submit", (e) => {
          if (e.preventDefault) e.preventDefault();
          const ref = { claimId: cl.value, branch: br.value, commit: cm.value, contract: ct.value };
          const bad = validateFulfil(ref);
          if (bad) out.textContent = bad; else answer("fulfilled", ref);
        });
        li.append(f);
      }
      return li;
    }
    function list(box, items, make, empty, failed) {
      if (failed) return box.replaceChildren(el("p", failed));
      if (!items.length) return box.replaceChildren(el("p", empty));
      const ul = el("ul"); ul.append(...items.map(make)); box.replaceChildren(ul);
    }
    const renderClaims = () => list(claimsBox, st.claims, claimRow, "No claims yet.", st.failed.claims && "Could not load claims");
    const renderRequests = () => {
      list(inBox, st.incoming, (r) => requestRow(r, true), "No incoming requests.", st.failed.requests && "Could not load requests");
      list(outBox, st.outgoing, (r) => requestRow(r, false), "No outgoing requests.", st.failed.requests && "Could not load requests");
    };

    function buildPublish() {
      const f = pubBox; const out = msg();
      const repoNames = st.repos.map((r) => r.name);
      const repoSel = select(f, "Repo", repoNames.map((n) => [n, n]).concat([["", "(other — type below)"]]), repoNames[0] || "");
      const repoTxt = field(f, "Repo (free text)");
      const i = { title: field(f, "Title"), summary: field(f, "Summary"), tags: field(f, "Tags (comma list)"),
        branch: field(f, "Branch"), commit: field(f, "Commit (40 hex)"), contract: field(f, "Contract"),
        status: select(f, "Status", OWNER_STATUSES.map((s) => [s, s]), "active") };
      const go = el("button", "Publish"); go.type = "submit"; f.append(go, out);
      f.addEventListener("submit", async (e) => {
        if (e.preventDefault) e.preventDefault();
        const v = Object.fromEntries(Object.entries(i).map(([k, n]) => [k, n.value]));
        v.repo = trim(repoTxt.value) || repoSel.value;
        const bad = validateClaim(v);
        if (bad) { out.textContent = bad; return; }
        if ((await api("POST", base + "/claims", createClaimBody(v, claimKey.get(v)), out)).ok) { claimKey.clear(); for (const n of Object.values(i)) if (n !== i.status) n.value = ""; load(); }
      });
    }
    function buildRequest() {
      const f = reqBox; const out = msg();
      const others = st.lines.filter((l) => l.id !== lineId).map((l) => [l.id, l.name || l.id]);
      const target = select(f, "Target line", [["", "(choose)"]].concat(others), "");
      const claimSel = select(f, "Claim reference (optional)", [["", "(none)"]], "");
      const subject = field(f, "Subject"), text = field(f, "Text", "textarea");
      target.addEventListener("change", async () => {
        const d = target.value ? await read("/api/registry/claims?lineId=" + enc(target.value) + "&status=all") : null;
        claimSel.replaceChildren(...[["", "(none)"]].concat(((d && d.items) || []).filter((c) => c.status !== "superseded").map((c) => [c.id, c.title])).map(([v, t]) => { const o = el("option", t); o.value = v; return o; }));
        claimSel.value = "";
      });
      const go = el("button", "Send request"); go.type = "submit"; f.append(go, out);
      f.addEventListener("submit", async (e) => {
        if (e.preventDefault) e.preventDefault();
        const v = { targetLineId: target.value, subject: subject.value, text: text.value, claimId: claimSel.value };
        const bad = validateRequest(v);
        if (bad) { out.textContent = bad; return; }
        if ((await api("POST", base + "/requests", createRequestBody(v, reqKey.get(v)), out)).ok) { reqKey.clear(); subject.value = ""; text.value = ""; load(); }
      });
    }

    let built = false;
    async function load() {
      const q = "lineId=" + enc(lineId);
      const [cl, inc, ls, rp] = await Promise.all([
        read("/api/registry/claims?" + q + "&status=all&pageSize=100"), read("/api/registry/requests?" + q + "&pageSize=100"),
        built ? null : read("/api/lines"), built ? null : read("/api/protocol/lines/" + enc(lineId) + "/repos")]);
      st.editing = null; st.fulfilling = null; st.failed = { claims: !cl, requests: !inc };
      if (cl) st.claims = (cl.items || []).filter((c) => c.ownerLineId === lineId || !c.ownerLineId);
      if (inc) {
        const all = inc.items || [];
        st.incoming = all.filter((r) => r.targetLineId === lineId); st.outgoing = all.filter((r) => r.sourceLineId === lineId);
      }
      if (!built && ls) { st.lines = ls.lines || []; st.repos = (rp && rp.repos) || []; built = true; buildPublish(); buildRequest(); }
      renderClaims(); renderRequests();
    }
    return { start: load, load, state: st };
  }

  return { HEX40, OWNER_STATUSES, validCommit, claimActions, requestActions, validateClaim, createClaimBody, editClaimBody,
    renewBody, supersedeBody, validateRequest, createRequestBody, validateFulfil, answerBody, createKeeper, mapError, mount };
});
