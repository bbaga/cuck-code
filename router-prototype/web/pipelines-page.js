// The pipelines page (/pipelines). The top half is pure logic that the Node tests
// require(); the DOM code below it is thin and starts only in a browser.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(null);
  else root.pipelinesPage = factory(root);
})(typeof self !== "undefined" ? self : this, function (win) {
  const VALIDATE_DELAY_MS = 400;
  const NAME_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
  const LAYER_ORDER = { managed: 0, user: 1, "built-in": 2 };

  // clock = { setTimeout, clearTimeout }. Only the last call() runs, `delay` ms after it.
  function createDebouncer(clock, delay) {
    let id = null;
    const cancel = () => { if (id !== null) { clock.clearTimeout(id); id = null; } };
    return {
      call(fn) { cancel(); id = clock.setTimeout(() => { id = null; fn(); }, delay === undefined ? VALIDATE_DELAY_MS : delay); },
      cancel,
    };
  }

  // The state of the Save button. errors: the last validation answer (null = not known yet).
  function saveState({ errors, dirty, validating, saving }) {
    if (saving) return { disabled: true, reason: "Saving..." };
    if (!dirty) return { disabled: true, reason: "No changes to save." };
    if (validating || !Array.isArray(errors)) return { disabled: true, reason: "Checking the text..." };
    if (errors.length) return { disabled: true, reason: "Fix the errors first." };
    return { disabled: false, reason: "" };
  }

  const errorLines = (errors) => (Array.isArray(errors) ? errors : []).map((e) => e.rule + ": " + e.message);

  function nameProblem(name) {
    return typeof name === "string" && NAME_RE.test(name) ? null
      : "A name has 1-60 characters of a-z, 0-9 and '-', and starts with a letter or digit.";
  }

  const GROUPS = [
    { key: "pipelines", title: "Pipelines", kind: "pipeline" },
    { key: "nodeTypes", title: "Node types", kind: "node-types" },
    { key: "interactions", title: "Interactions", kind: "interactions" },
  ];

  // The left column: three groups, each sorted by layer (managed first) and name.
  function groupItems(listing) {
    const data = listing || {};
    const rank = (layer) => (LAYER_ORDER[layer] === undefined ? 9 : LAYER_ORDER[layer]);
    return GROUPS.map((g) => {
      const items = (Array.isArray(data[g.key]) ? data[g.key] : []).map((it) => ({
        kind: g.kind, name: it.name, layer: it.layer, editable: g.kind === "pipeline" && it.editable === true,
        problems: Array.isArray(it.problems) ? it.problems : [],
        warn: Array.isArray(it.problems) && it.problems.length > 0,
      }));
      items.sort((a, b) => (rank(a.layer) - rank(b.layer)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return { key: g.key, title: g.title, items };
    });
  }

  function toolbarState(item) {
    const pipeline = !!item && item.kind === "pipeline";
    const editable = pipeline && item.editable === true;
    return { editor: editable, duplicate: pipeline, save: editable, delete: editable };
  }

  // The validate answer's graph in the shape layoutGraph takes (see pipeline-ui.js):
  // nodes by id, and the { effect, trigger } of every interaction on its edges.
  function layoutInput(graph) {
    if (!graph || !Array.isArray(graph.nodes)) return null;
    const nodes = {};
    for (const n of graph.nodes) nodes[n.id] = { type: n.type, phase: n.phase };
    const kinds = graph.kinds || {};
    const edges = (graph.edges || []).map((e) => {
      const k = {};
      for (const name of e.interactions || []) if (kinds[name]) k[name] = kinds[name];
      return { ...e, kinds: k };
    });
    return { start: graph.start || (graph.nodes[0] && graph.nodes[0].id), nodes, edges };
  }

  const api = { VALIDATE_DELAY_MS, createDebouncer, saveState, errorLines, nameProblem, groupItems, toolbarState, layoutInput };
  if (!win || typeof document === "undefined") return api;

  // ---- DOM (browser only) ----
  const SVGNS = "http://www.w3.org/2000/svg";
  const $ = (id) => document.getElementById(id);
  const pipelineUI = win.pipelineUI;
  const state = { listing: null, selected: null, text: "", savedText: "", errors: null,
    validating: false, saving: false, seq: 0, confirmDelete: false };
  const debouncer = createDebouncer(win, VALIDATE_DELAY_MS);

  function h(tag, attrs, ...kids) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "text") node.textContent = v; else node.setAttribute(k, v);
    }
    for (const kid of kids) if (kid) node.append(kid);
    return node;
  }

  async function call(method, url, body) {
    const res = await fetch(url, { method, headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    return { status: res.status, ok: res.ok, data };
  }

  const itemUrl = (it) => (it.kind === "pipeline" ? "/api/pipelines/" + encodeURIComponent(it.name)
    : "/api/pipelines/" + it.kind + "/" + encodeURIComponent(it.name));
  const selectedItem = () => {
    if (!state.selected || !state.listing) return null;
    return groupItems(state.listing).flatMap((g) => g.items)
      .find((i) => i.kind === state.selected.kind && i.name === state.selected.name) || null;
  };
  const layerClass = (layer) => "layer " + String(layer || "").replace(/[^a-z]/g, "");

  function say(text, isError) {
    const box = $("status");
    box.textContent = text || "";
    box.className = isError ? "status bad" : "status";
  }

  // ---- left column ----
  function renderList() {
    const host = $("listHost");
    host.textContent = "";
    for (const g of groupItems(state.listing)) {
      const section = h("section", { "aria-labelledby": "grp-" + g.key, "data-group": g.key });
      section.append(h("h2", { id: "grp-" + g.key, text: g.title + " (" + g.items.length + ")" }));
      const ul = h("ul", { class: "items" });
      for (const it of g.items) {
        const on = !!state.selected && state.selected.kind === it.kind && state.selected.name === it.name;
        const btn = h("button", { type: "button", class: "item" + (on ? " on" : ""), "data-kind": it.kind, "data-name": it.name,
          "aria-current": on ? "true" : "false" });
        btn.append(h("span", { class: "iname", text: it.name }));
        if (it.warn) {
          btn.append(h("span", { class: "warn", "aria-hidden": "true", text: "⚠" }), h("span", { class: "sr", text: " has problems" }));
        }
        btn.append(h("span", { class: layerClass(it.layer), text: it.layer }));
        btn.addEventListener("click", () => open(it.kind, it.name));
        ul.append(h("li", {}, btn));
      }
      if (!g.items.length) ul.append(h("li", { class: "none", text: "None" }));
      section.append(ul);
      host.append(section);
    }
    const problems = (state.listing && state.listing.problems) || [];
    if (problems.length) {
      const box = h("div", { class: "catprob" }, h("h2", { text: "Files that did not load" }));
      for (const p of problems) box.append(h("p", { text: p.layer + ": " + p.path + " - " + p.errors.join("; ") }));
      host.append(box);
    }
  }

  async function loadList() {
    const r = await call("GET", "/api/pipelines");
    if (!r.ok) { say("Could not load the list (" + r.status + ").", true); return; }
    state.listing = r.data;
    renderList();
  }

  // ---- inline name form (Duplicate / New) ----
  function nameForm(host, { label, submitText, initial, onSubmit }) {
    host.textContent = "";
    const input = h("input", { type: "text", id: "nameInput", autocomplete: "off", spellcheck: "false", value: initial || "" });
    const err = h("p", { class: "err", role: "alert" });
    const cancel = h("button", { type: "button", class: "secondary", text: "Cancel" });
    const form = h("form", { class: "nameForm" }, h("label", { for: "nameInput", text: label }), input,
      h("button", { type: "submit", text: submitText }), cancel, err);
    cancel.addEventListener("click", () => { host.textContent = ""; });
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const name = input.value.trim();
      const bad = nameProblem(name);
      if (bad) { err.textContent = bad; input.focus(); return; }
      err.textContent = "";
      const message = await onSubmit(name);
      if (message) { err.textContent = message; input.focus(); } else host.textContent = "";
    });
    host.append(form);
    input.focus();
  }

  async function duplicate(sourceName, newName) {
    const r = await call("POST", "/api/pipelines/" + encodeURIComponent(sourceName) + "/duplicate", { newName });
    if (!r.ok) return (r.data && r.data.error) || "Duplicate failed (" + r.status + ").";
    await loadList();
    await open("pipeline", newName);
    say("Created '" + newName + "' in the managed layer.");
    return null;
  }

  // ---- right column ----
  async function open(kind, name) {
    debouncer.cancel();
    state.seq++;
    state.selected = { kind, name };
    state.confirmDelete = false;
    state.errors = null; state.validating = false; state.saving = false;
    renderList();
    say("");
    const r = await call("GET", itemUrl({ kind, name }));
    if (!state.selected || state.selected.name !== name || state.selected.kind !== kind) return;
    if (!r.ok) { $("detail").textContent = ""; say("Could not open '" + name + "' (" + r.status + ").", true); return; }
    const item = selectedItem() || { kind, name, layer: r.data.layer, editable: !!r.data.editable, problems: r.data.errors || [] };
    state.text = state.savedText = r.data.text;
    renderDetail(item);
    if (toolbarState(item).editor) runValidation();
    else if (kind === "pipeline" && r.data.resolved) drawGraph(layoutInput(graphOfResolved(r.data.resolved)));
  }

  // The resolved definition of a read-only pipeline, as a preview graph.
  function graphOfResolved(resolved) {
    const kinds = {};
    for (const e of resolved.edges) {
      for (const n of e.interactions) {
        const it = resolved.interactions && resolved.interactions[n];
        kinds[n] = { effect: it ? it.effect || null : null, trigger: it ? it.trigger || null : null };
      }
    }
    return { start: resolved.start, kinds,
      nodes: Object.entries(resolved.nodes).map(([id, n]) => ({ id, type: n.type, phase: null })),
      edges: resolved.edges };
  }

  function renderDetail(item) {
    const bar = toolbarState(item);
    const d = $("detail");
    d.textContent = "";
    d.append(h("div", { class: "dhead" }, h("h2", { id: "dtitle", text: item.name }), h("span", { class: layerClass(item.layer), text: item.layer })));
    if (item.problems && item.problems.length) {
      const box = h("div", { class: "problems", role: "group", "aria-label": "Problems of this item" }, h("strong", { text: "⚠ Problems" }));
      for (const line of errorLines(item.problems)) box.append(h("p", { text: line }));
      d.append(box);
    }
    const actions = h("div", { class: "actions" });
    const nameHost = h("div", { id: "nameHost" });
    if (bar.duplicate) {
      const btn = h("button", { type: "button", id: "dupBtn", class: bar.editor ? "secondary" : "", text: bar.editor ? "Duplicate" : "Duplicate to edit" });
      btn.addEventListener("click", () => nameForm(nameHost, { label: "Name of the copy", submitText: "Create copy",
        initial: item.name + "-copy", onSubmit: (n) => duplicate(item.name, n) }));
      actions.append(btn);
    }
    if (bar.save) {
      const saveBtn = h("button", { type: "button", id: "saveBtn", text: "Save" });
      saveBtn.addEventListener("click", save);
      const del = h("button", { type: "button", id: "delBtn", class: "danger", text: "Delete" });
      del.addEventListener("click", () => { state.confirmDelete = true; renderDelete(); $("delYes").focus(); });
      actions.append(saveBtn, del, h("span", { id: "delHost" }), h("span", { id: "saveWhy", class: "why", "aria-live": "polite" }));
    }
    d.append(actions, nameHost);
    if (bar.editor) {
      const ta = h("textarea", { id: "editor", class: "editor", spellcheck: "false", rows: "16", "aria-label": "Pipeline YAML text",
        autocapitalize: "off", autocomplete: "off", wrap: "off" });
      ta.value = state.text;
      ta.addEventListener("input", () => {
        state.text = ta.value; state.errors = null; state.validating = true;
        updateSave(); say("");
        debouncer.call(runValidation);
      });
      d.append(ta, h("ul", { id: "errors", class: "errors", role: "alert" }));
      updateSave();
    } else {
      d.append(h("pre", { id: "source", class: "source", tabindex: "0", "aria-label": "Source text of " + item.name + " (read-only)", text: state.text }));
    }
    if (item.kind === "pipeline") {
      d.append(h("h3", { text: "Graph" }), h("div", { id: "graphBox", class: "graphBox" }),
        h("div", { class: "edgesText" }, h("ul", { id: "edgesList" })));
    }
  }

  function renderDelete() {
    const host = $("delHost");
    if (!host) return;
    host.textContent = "";
    if (!state.confirmDelete) return;
    const yes = h("button", { type: "button", id: "delYes", class: "danger", text: "Yes, delete" });
    const no = h("button", { type: "button", id: "delNo", class: "secondary", text: "Cancel" });
    yes.addEventListener("click", remove);
    no.addEventListener("click", () => { state.confirmDelete = false; renderDelete(); $("delBtn").focus(); });
    host.append(h("span", { class: "why", role: "alert", text: "Delete '" + state.selected.name + "'?" }), yes, no);
  }

  function updateSave() {
    const btn = $("saveBtn");
    if (!btn) return;
    const s = saveState({ errors: state.errors, dirty: state.text !== state.savedText, validating: state.validating, saving: state.saving });
    btn.disabled = s.disabled;
    $("saveWhy").textContent = s.disabled ? s.reason : "";
  }

  function showErrors() {
    const list = $("errors");
    if (!list) return;
    list.textContent = "";
    for (const line of errorLines(state.errors)) list.append(h("li", { text: line }));
  }

  async function runValidation() {
    const seq = ++state.seq;
    state.validating = true; updateSave();
    const r = await call("POST", "/api/pipelines/validate", { text: state.text });
    if (seq !== state.seq) return; // a newer edit, or another item
    state.validating = false;
    if (!r.ok) {
      state.errors = [{ rule: "HTTP", message: (r.data && r.data.error) || "validation failed (" + r.status + ")" }];
    } else {
      state.errors = r.data.errors;
      if (r.data.graph) drawGraph(layoutInput(r.data.graph)); // else keep the last good graph
    }
    showErrors();
    updateSave();
  }

  async function save() {
    const name = state.selected.name;
    state.saving = true; updateSave();
    const r = await call("PUT", "/api/pipelines/" + encodeURIComponent(name), { text: state.text });
    state.saving = false;
    if (!r.ok) {
      state.errors = (r.data && r.data.errors) || [{ rule: "HTTP", message: (r.data && r.data.error) || "save failed" }];
      showErrors(); updateSave(); say("Not saved.", true);
      return;
    }
    state.savedText = state.text;
    updateSave();
    say("Saved '" + name + "'.");
    await loadList();
  }

  async function remove() {
    const name = state.selected.name;
    const r = await call("DELETE", "/api/pipelines/" + encodeURIComponent(name));
    if (!r.ok) { say((r.data && r.data.error) || "Delete failed (" + r.status + ").", true); return; }
    debouncer.cancel();
    state.seq++;
    state.selected = null; state.confirmDelete = false;
    $("detail").textContent = "";
    $("detail").append(h("p", { class: "hint", text: "Select an item on the left." }));
    await loadList();
    say("Deleted '" + name + "'.");
  }

  // ---- graph drawing: layoutGraph of pipeline-ui.js, SVG like the line Pipeline tab ----
  function drawGraph(input) {
    const box = $("graphBox");
    if (!box) return;
    box.textContent = "";
    const list = $("edgesList");
    if (list) list.textContent = "";
    const layout = input ? pipelineUI.layoutGraph(input) : { nodes: [], edges: [] };
    if (!layout.nodes.length) { box.append(h("p", { class: "hint", text: "No graph yet." })); return; }
    const el = (name, attrs, text) => {
      const node = document.createElementNS(SVGNS, name);
      for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const svg = el("svg", { class: "pipeGraph", role: "img", width: layout.width, height: layout.height,
      viewBox: "0 0 " + layout.width + " " + layout.height,
      "aria-label": "Pipeline graph: " + layout.nodes.length + " nodes, " + layout.edges.length + " edges. The edges follow as a text list." });
    svg.append(el("title", {}, "Pipeline graph"));
    const defs = el("defs");
    const marker = el("marker", { id: "pgArrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
    marker.append(el("path", { d: "M0 0 L10 5 L0 10 z", class: "pgArrowHead" }));
    defs.append(marker); svg.append(defs);
    const edgeLayer = el("g", { class: "pgEdges" });
    const labelLayer = el("g", { class: "pgLabels" });
    for (const edge of layout.edges) {
      if (!edge) continue;
      edgeLayer.append(el("path", { d: edge.path, class: "pgEdge" + (edge.dashed ? " dashed" : ""), "marker-end": "url(#pgArrow)" }));
      labelLayer.append(el("text", { x: edge.labelX, y: edge.labelY, class: "pgEdgeLabel", "text-anchor": "middle", "dominant-baseline": "central" }, edge.label));
    }
    svg.append(edgeLayer);
    for (const n of layout.nodes) {
      const g = el("g", { class: "pgNode" + (n.id === input.start ? " start" : ""), "data-node": n.id });
      g.append(el("rect", { x: n.x, y: n.y, width: n.width, height: n.height, rx: 6 }),
        el("text", { x: n.x + 10, y: n.y + 28, class: "pgNodeId" }, n.id),
        el("text", { x: n.x + 10, y: n.y + 48, class: "pgNodeType" }, n.type || ""));
      svg.append(g);
    }
    svg.append(labelLayer);
    box.append(svg);
    if (list) for (const line of pipelineUI.edgeTextLines(input)) list.append(h("li", { text: line }));
  }

  function init() {
    $("newBtn").addEventListener("click", () => nameForm($("newHost"), { label: "Name of the new pipeline (a copy of minimal)",
      submitText: "Create", initial: "", onSubmit: (n) => duplicate("minimal", n) }));
    $("detail").append(h("p", { class: "hint", text: "Select an item on the left." }));
    loadList();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
  return api;
});
