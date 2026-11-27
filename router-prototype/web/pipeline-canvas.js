// The visual editor of the pipelines page: a palette, a canvas with nodes, anchors and arrows.
// The top half is pure logic that the Node tests require(); the DOM code below it starts only
// in a browser. The canvas edits a model; the page turns the model into YAML text.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(null);
  else root.pipelineCanvas = factory(root);
})(typeof self !== "undefined" ? self : this, function (win) {
  const NODE_SIZE = { width: 190, height: 68 };
  const ANCHORS = ["top", "right", "bottom", "left"];
  const OUTWARD = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };
  const OFFSET_STEP = 8;
  const GRID = { x: 20, y: 20, stepX: 230, stepY: 100, columns: 4 };
  const LAYOUT_KEY = "duck.pipelineCanvas.";
  const NODE_TYPE_MIME = "application/x-duck-node-type";

  const arrowKey = (from, to, name) => from + "->" + to + ":" + name;
  const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

  // The id of a new node: the type name, then "<type>-2", "<type>-3" ... It must match idPattern.
  function nextNodeId(model, typeName, idPattern) {
    const taken = new Set(model.nodes.map((n) => n.id));
    const re = idPattern ? new RegExp(idPattern) : null;
    const free = (id) => !taken.has(id) && (!re || re.test(id));
    if (free(typeName)) return typeName;
    let id = typeName;
    for (let i = 2; i < 1000 && !free(id = typeName + "-" + i); i++) { /* try the next number */ }
    return id;
  }

  // The 4 anchor points of a box: the middle of each side.
  function anchorPoints(box) {
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    return { top: { x: cx, y: box.y }, right: { x: box.x + box.width, y: cy },
      bottom: { x: cx, y: box.y + box.height }, left: { x: box.x, y: cy } };
  }

  // The anchor pair with the shortest distance. Two arrows of one node to itself use right and top.
  function nearestAnchorPair(boxA, boxB) {
    if (boxA === boxB) return { fromAnchor: "right", toAnchor: "top" };
    const pa = anchorPoints(boxA), pb = anchorPoints(boxB);
    let best = null;
    for (const fromAnchor of ANCHORS) {
      for (const toAnchor of ANCHORS) {
        const distance = Math.hypot(pa[fromAnchor].x - pb[toAnchor].x, pa[fromAnchor].y - pb[toAnchor].y);
        if (!best || distance < best.distance) best = { fromAnchor, toAnchor, distance };
      }
    }
    return { fromAnchor: best.fromAnchor, toAnchor: best.toAnchor };
  }

  const GROUP_DEFS = [
    { key: "planner", title: "Planner types", test: (t) => t.coordinator === true },
    { key: "worker", title: "Worker types", test: (t) => t.workspace === "own-worktree" },
    { key: "checker", title: "Checker types", test: (t) => t.workspace === "source" || t.workspace === "integration" },
    { key: "other", title: "Other types", test: () => true },
  ];

  // The palette groups in a fixed order; "Base types" is last. Empty groups are left out.
  function paletteGroups(palette) {
    const groups = [...GROUP_DEFS, { key: "base", title: "Base types" }].map((g) => ({ key: g.key, title: g.title, types: [] }));
    for (const type of (palette && palette.nodeTypes) || []) {
      const index = type.base ? groups.length - 1 : GROUP_DEFS.findIndex((g) => g.test(type));
      groups[index].types.push(type);
    }
    for (const g of groups) g.types.sort((a, b) => compare(a.name, b.name));
    return groups.filter((g) => g.types.length);
  }

  // One arrow for each interaction of each edge.
  function arrowsOf(model) {
    return model.edges.flatMap((edge) => edge.interactions.map((interaction) => (
      { key: arrowKey(edge.from, edge.to, interaction), from: edge.from, to: edge.to, interaction })));
  }

  // The anchors of each arrow (stored, or the nearest pair) and its offset at both ends.
  // layout = { nodes: { id: box }, arrows: { key: { fromAnchor, toAnchor } } }. At one anchor the arrows
  // are sorted by other node id, interaction name, direction, and spread by 8 px around the anchor.
  function anchorOffsets(arrows, layout) {
    const routes = {};
    const ends = {};
    for (const a of arrows) {
      const stored = layout.arrows && layout.arrows[a.key];
      const pair = stored && stored.fromAnchor && stored.toAnchor ? stored : nearestAnchorPair(layout.nodes[a.from], layout.nodes[a.to]);
      routes[a.key] = { fromAnchor: pair.fromAnchor, toAnchor: pair.toAnchor, fromOffset: 0, toOffset: 0, rank: 0 };
      (ends[a.from + "/" + pair.fromAnchor] = ends[a.from + "/" + pair.fromAnchor] || []).push({ a, other: a.to, dir: "out" });
      (ends[a.to + "/" + pair.toAnchor] = ends[a.to + "/" + pair.toAnchor] || []).push({ a, other: a.from, dir: "in" });
    }
    for (const list of Object.values(ends)) {
      list.sort((p, q) => compare(p.other, q.other) || compare(p.a.interaction, q.a.interaction) || compare(p.dir, q.dir));
      list.forEach(({ a, dir }, i) => {
        const route = routes[a.key];
        route[dir === "out" ? "fromOffset" : "toOffset"] = (i - (list.length - 1) / 2) * OFFSET_STEP;
        if (dir === "out") route.rank = i;
      });
    }
    return routes;
  }

  // The point of an anchor, moved along its side by `offset`.
  function offsetPoint(box, anchor, offset) {
    const p = anchorPoints(box)[anchor];
    return anchor === "top" || anchor === "bottom" ? { x: p.x + offset, y: p.y } : { x: p.x, y: p.y + offset };
  }

  // A curve that leaves p1 away from its side and arrives at p2 from outside its side.
  // The label sits on the curve at parameter t.
  function arrowCurve(p1, anchor1, p2, anchor2, t) {
    const reach = Math.max(40, Math.hypot(p2.x - p1.x, p2.y - p1.y) / 3);
    const c1 = { x: p1.x + OUTWARD[anchor1][0] * reach, y: p1.y + OUTWARD[anchor1][1] * reach };
    const c2 = { x: p2.x + OUTWARD[anchor2][0] * reach, y: p2.y + OUTWARD[anchor2][1] * reach };
    const at = (k) => {
      const u = 1 - t;
      return u ** 3 * p1[k] + 3 * u * u * t * c1[k] + 3 * u * t * t * c2[k] + t ** 3 * p2[k];
    };
    return { d: `M${p1.x} ${p1.y} C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${p2.x} ${p2.y}`, labelX: at("x"), labelY: at("y") };
  }

  // The first free cell of the grid, row by row.
  function nextFreePosition(boxes) {
    for (let row = 0; ; row++) {
      for (let col = 0; col < GRID.columns; col++) {
        const pos = { x: GRID.x + col * GRID.stepX, y: GRID.y + row * GRID.stepY };
        if (!boxes.some((b) => Math.abs(b.x - pos.x) < NODE_SIZE.width && Math.abs(b.y - pos.y) < NODE_SIZE.height)) return pos;
      }
    }
  }

  const withModel = (model, parts) => ({ ...model, ...parts });
  const addNode = (model, id, type) => withModel(model, { nodes: [...model.nodes, { id, type }] });

  // Removes a node and all its edges. `start` keeps its value: the validator then shows R1.
  function removeNode(model, id) {
    return withModel(model, { nodes: model.nodes.filter((n) => n.id !== id),
      edges: model.edges.filter((e) => e.from !== id && e.to !== id) });
  }

  // Removes one interaction of an edge. The edge goes away when it has no interaction left.
  function removeArrow(model, from, to, name) {
    const edges = model.edges.map((e) => (e.from === from && e.to === to
      ? { ...e, interactions: e.interactions.filter((i) => i !== name) } : e)).filter((e) => e.interactions.length);
    return withModel(model, { edges });
  }

  const sameEdge = (from, to) => (e) => e.from === from && e.to === to;

  // Adds names to the edge from -> to. The edge is made when it is missing; a name is never added twice.
  function addInteractions(model, from, to, names) {
    const edge = model.edges.find(sameEdge(from, to));
    const old = edge ? edge.interactions : [];
    const added = [...new Set(names)].filter((n) => !old.includes(n));
    if (!edge) return withModel(model, { edges: [...model.edges, { from, to, interactions: added }] });
    return withModel(model, { edges: model.edges.map((e) => (e === edge ? { ...e, interactions: [...old, ...added] } : e)) });
  }

  // Sets the interactions of the edge from -> to. An empty list removes the edge.
  function setInteractions(model, from, to, names) {
    const wanted = [...new Set(names)];
    if (!wanted.length) return withModel(model, { edges: model.edges.filter((e) => !sameEdge(from, to)(e)) });
    const edge = model.edges.find(sameEdge(from, to));
    if (!edge) return addInteractions(model, from, to, wanted);
    const kept = edge.interactions.filter((n) => wanted.includes(n));
    return withModel(model, { edges: model.edges.map((e) => (e === edge ? { ...e, interactions: [...kept, ...wanted.filter((n) => !kept.includes(n))] } : e)) });
  }

  // Stores the anchors of the arrows that are new on from -> to. Old arrows keep their anchors.
  function rememberAnchors(layout, from, to, names, pair) {
    const arrows = { ...layout.arrows };
    for (const name of names) {
      const key = arrowKey(from, to, name);
      if (!arrows[key]) arrows[key] = { fromAnchor: pair.fromAnchor, toAnchor: pair.toAnchor };
    }
    return { ...layout, arrows };
  }

  // The stored layout without the entries of nodes and arrows that are not in the model.
  function pruneLayout(layout, model) {
    const ids = new Set(model.nodes.map((n) => n.id));
    const keys = new Set(arrowsOf(model).map((a) => a.key));
    const keep = (map, ok) => Object.fromEntries(Object.entries(map).filter(([k]) => ok(k)));
    return { nodes: keep(layout.nodes, (id) => ids.has(id)), arrows: keep(layout.arrows, (k) => keys.has(k)) };
  }

  // The input of pipelineUI.layoutGraph: the column of a node is its distance from the start node.
  function layoutInput(model) {
    const columns = {};
    const queue = [model.start];
    columns[model.start] = 0;
    while (queue.length) {
      const id = queue.shift();
      for (const e of model.edges) if (e.from === id && columns[e.to] === undefined) { columns[e.to] = columns[id] + 1; queue.push(e.to); }
    }
    const nodes = Object.fromEntries(model.nodes.map((n) => [n.id, { ...n }]));
    for (const id of Object.keys(nodes)) if (columns[id] === undefined) columns[id] = 0;
    return { start: model.start, nodes, columns,
      relations: model.edges.map((e) => ({ from: e.from, to: e.to, kind: "interaction", interactions: e.interactions })) };
  }

  const api = { NODE_SIZE, LAYOUT_KEY, NODE_TYPE_MIME, arrowKey, nextNodeId, anchorPoints, nearestAnchorPair, paletteGroups,
    arrowsOf, anchorOffsets, offsetPoint, arrowCurve, nextFreePosition, addNode, removeNode, removeArrow, addInteractions, setInteractions, rememberAnchors, pruneLayout, layoutInput };
  if (!win || typeof document === "undefined") return api;

  // ---- DOM (browser only) ----
  const SVGNS = "http://www.w3.org/2000/svg";
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const listeners = [];
  let inst = null; // the mounted canvas, or null

  // "svg:g" makes an SVG element, "div" an HTML element.
  function make(tag, attrs, content) {
    const node = tag.startsWith("svg:") ? document.createElementNS(SVGNS, tag.slice(4)) : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    if (typeof content === "string") node.textContent = content;
    else if (content) node.append(content);
    return node;
  }

  function readLayout(name) {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LAYOUT_KEY + name)); } catch { /* no stored layout */ }
    return { nodes: (saved && saved.nodes) || {}, arrows: (saved && saved.arrows) || {} };
  }

  function saveLayout() {
    try { localStorage.setItem(LAYOUT_KEY + inst.name, JSON.stringify(inst.layout)); } catch { /* storage is optional */ }
  }

  const sameSelection = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function notify() {
    for (const cb of listeners) cb(inst.selection, clone(inst.model), applyChange);
  }

  function select(selection) {
    if (sameSelection(inst.selection, selection)) return;
    inst.selection = selection;
    markSelection();
    notify();
  }

  function markSelection() {
    const sel = inst.selection;
    for (const g of inst.svg.querySelectorAll("[data-node]")) g.classList.toggle("sel", !!sel && sel.kind === "node" && sel.id === g.dataset.node);
    for (const g of inst.svg.querySelectorAll("[data-arrow]")) {
      g.classList.toggle("sel", !!sel && sel.kind === "arrow" && arrowKey(sel.from, sel.to, sel.interaction) === g.dataset.arrow);
    }
  }

  // Sets the new model, redraws, and gives it to the page, which writes the text.
  function commit(model) {
    inst.model = model;
    inst.layout = pruneLayout(inst.layout, model);
    const sel = inst.selection;
    if (sel && sel.kind === "node" && !model.nodes.some((n) => n.id === sel.id)) inst.selection = null;
    if (sel && sel.kind === "arrow" && !arrowsOf(model).some((a) => a.key === arrowKey(sel.from, sel.to, sel.interaction))) inst.selection = null;
    saveLayout();
    draw();
    notify();
    return Promise.resolve(inst.onModelChange(model));
  }

  // fn gets a copy of the model and returns the new model.
  function applyChange(fn) {
    if (!inst || inst.readOnly) return Promise.resolve();
    const next = fn(clone(inst.model));
    return next ? commit(next) : Promise.resolve();
  }

  function addNodeAt(type, pos) {
    const id = nextNodeId(inst.model, type, inst.palette && inst.palette.nodeKeys && inst.palette.nodeKeys.idPattern);
    inst.layout.nodes[id] = { x: Math.max(0, Math.round(pos.x)), y: Math.max(0, Math.round(pos.y)) };
    inst.selection = { kind: "node", id };
    return commit(addNode(inst.model, id, type));
  }

  function deleteSelection() {
    const s = inst.selection;
    if (!s || inst.readOnly) return;
    commit(s.kind === "node" ? removeNode(inst.model, s.id) : removeArrow(inst.model, s.from, s.to, s.interaction));
  }

  // The boxes of all nodes. A node without a stored position gets its place from layoutGraph.
  function nodeBoxes() {
    const missing = inst.model.nodes.filter((n) => !inst.layout.nodes[n.id]);
    const defaults = {};
    if (missing.length) for (const n of win.pipelineUI.layoutGraph(layoutInput(inst.model)).nodes) defaults[n.id] = { x: n.x, y: n.y };
    const boxes = {};
    for (const n of inst.model.nodes) {
      const pos = inst.layout.nodes[n.id] || defaults[n.id] || { x: GRID.x, y: GRID.y };
      if (missing.includes(n) && !inst.readOnly) inst.layout.nodes[n.id] = pos;
      boxes[n.id] = { ...pos, ...NODE_SIZE };
    }
    return boxes;
  }

  function startDrag(ev, id) {
    if (inst.readOnly || ev.button !== 0) return;
    const origin = { ...inst.layout.nodes[id] };
    const onMove = (e) => {
      inst.layout.nodes[id] = { x: Math.max(0, Math.round(origin.x + e.clientX - ev.clientX)),
        y: Math.max(0, Math.round(origin.y + e.clientY - ev.clientY)) };
      draw();
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      saveLayout();
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  }

  function drawNode(node, box) {
    const start = node.id === inst.model.start;
    const g = make("svg:g", { class: "pgNode cvNode" + (start ? " start" : ""), "data-node": node.id, tabindex: "0", role: "button",
      "aria-label": "Node " + node.id + ", type " + node.type + (start ? ", start node" : "") });
    g.append(make("svg:rect", { x: box.x, y: box.y, width: box.width, height: box.height, rx: 6 }),
      make("svg:text", { x: box.x + 10, y: box.y + 21, class: "pgNodeId" }, node.id),
      make("svg:text", { x: box.x + 10, y: box.y + 38, class: "pgNodeType" }, node.type || ""));
    if (start) g.append(make("svg:text", { x: box.x + 10, y: box.y + 55, class: "pgNodeCfg" }, "▶ start"));
    const points = anchorPoints(box);
    for (const anchor of ANCHORS) {
      g.append(make("svg:circle", { class: "cvAnchor", "data-anchor": anchor, cx: points[anchor].x, cy: points[anchor].y, r: 6 }));
    }
    g.addEventListener("pointerdown", (ev) => {
      const anchor = ev.target.closest("[data-anchor]");
      if (anchor) { startConnection(ev, node.id, anchor.dataset.anchor); return; } // an anchor never moves the node
      select({ kind: "node", id: node.id });
      g.focus({ preventScroll: true });
      startDrag(ev, node.id);
    });
    g.addEventListener("click", (ev) => { if (!ev.target.closest("[data-anchor]")) select({ kind: "node", id: node.id }); });
    return g;
  }

  function drawArrow(a, route, boxes) {
    const p1 = offsetPoint(boxes[a.from], route.fromAnchor, route.fromOffset);
    const p2 = offsetPoint(boxes[a.to], route.toAnchor, route.toOffset);
    const curve = arrowCurve(p1, route.fromAnchor, p2, route.toAnchor, 0.3 + 0.1 * (route.rank % 5));
    const style = win.pipelineUI.choreoStyle({ interactions: [a.interaction] });
    const g = make("svg:g", { class: "cvArrow", "data-arrow": a.key, "data-from": a.from, "data-to": a.to, "data-interaction": a.interaction,
      tabindex: "0", role: "button", "aria-label": "Arrow " + a.interaction + " from " + a.from + " to " + a.to });
    g.append(make("svg:path", { d: curve.d, class: win.pipelineUI.edgeClassName({ kind: "interaction", style, dashed: style === "rework" }),
      "marker-end": "url(#cvArrowHead)" }),
    make("svg:path", { d: curve.d, class: "cvHit" }),
    make("svg:text", { x: curve.labelX, y: curve.labelY, class: "pgEdgeLabel", "text-anchor": "middle", "dominant-baseline": "central" }, a.interaction));
    g.addEventListener("click", () => {
      select({ kind: "arrow", from: a.from, to: a.to, interaction: a.interaction });
      g.focus({ preventScroll: true });
    });
    g.addEventListener("dblclick", () => openInteractionDialog(a.from, a.to));
    return g;
  }

  function draw() {
    const hadFocus = inst.canvasHost.contains(document.activeElement);
    const boxes = nodeBoxes();
    const all = Object.values(boxes);
    const width = Math.max(600, ...all.map((b) => b.x + b.width + 40));
    const height = Math.max(360, ...all.map((b) => b.y + b.height + 40));
    const svg = make("svg:svg", { class: "pipeGraph cvSvg", width, height, viewBox: "0 0 " + width + " " + height,
      "aria-label": "Pipeline canvas: " + inst.model.nodes.length + " nodes" });
    const marker = make("svg:marker", { id: "cvArrowHead", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto" });
    marker.append(make("svg:path", { d: "M0 0 L10 5 L0 10 z", class: "pgArrowHead" }));
    svg.append(make("svg:defs"));
    svg.firstChild.append(marker);
    const arrows = arrowsOf(inst.model).filter((a) => boxes[a.from] && boxes[a.to]);
    const routes = anchorOffsets(arrows, { nodes: boxes, arrows: inst.layout.arrows });
    for (const a of arrows) svg.append(drawArrow(a, routes[a.key], boxes));
    for (const n of inst.model.nodes) svg.append(drawNode(n, boxes[n.id]));
    svg.addEventListener("click", (ev) => { if (ev.target === svg) select(null); });
    inst.box.textContent = "";
    inst.box.append(svg);
    inst.svg = svg;
    markSelection();
    if (hadFocus && inst.selection) {
      const sel = inst.selection;
      const key = sel.kind === "node" ? "[data-node=\"" + sel.id + "\"]" : "[data-arrow=\"" + arrowKey(sel.from, sel.to, sel.interaction) + "\"]";
      const target = svg.querySelector(key);
      if (target) target.focus({ preventScroll: true });
    }
  }

  // ---- Connections: a drag from an anchor, or the "c" key ----
  const svgPoint = (ev) => { const r = inst.svg.getBoundingClientRect(); return { x: ev.clientX - r.left, y: ev.clientY - r.top }; };

  function removeTemp() {
    if (inst.temp) inst.temp.remove();
    inst.temp = null;
  }

  function markTarget(id) {
    for (const g of inst.svg.querySelectorAll("[data-node]")) g.classList.toggle("target", g.dataset.node === id);
    for (const c of inst.svg.querySelectorAll(".cvAnchor.drop")) c.classList.remove("drop");
  }

  // The anchor of another node under the pointer, or null.
  function anchorUnder(ev, fromId) {
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    const anchor = el && el.closest && el.closest("[data-anchor]");
    const node = anchor && anchor.closest("[data-node]");
    return node && node.dataset.node !== fromId ? { anchor, node: node.dataset.node } : null;
  }

  function startConnection(ev, fromId, fromAnchor) {
    if (inst.readOnly || ev.button !== 0) return;
    ev.preventDefault();
    removeTemp();
    const start = anchorPoints(nodeBoxes()[fromId])[fromAnchor];
    const temp = make("svg:path", { class: "cvTemp", d: "M" + start.x + " " + start.y });
    inst.svg.append(temp);
    inst.temp = temp;
    const finish = (e, drop) => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onCancel);
      document.removeEventListener("keydown", onKey);
      const hit = drop && anchorUnder(e, fromId);
      markTarget(null);
      if (!hit) { removeTemp(); return; }
      const end = anchorPoints(nodeBoxes()[hit.node])[hit.anchor.dataset.anchor];
      temp.setAttribute("d", "M" + start.x + " " + start.y + " L" + end.x + " " + end.y);
      openInteractionDialog(fromId, hit.node, { fromAnchor, toAnchor: hit.anchor.dataset.anchor });
    };
    const onMove = (e) => {
      const p = svgPoint(e);
      temp.setAttribute("d", "M" + start.x + " " + start.y + " L" + p.x + " " + p.y);
      markTarget(null);
      const hit = anchorUnder(e, fromId);
      if (hit) hit.anchor.classList.add("drop");
    };
    const onUp = (e) => finish(e, true);
    const onCancel = (e) => finish(e, false);
    const onKey = (e) => { if (e.key === "Escape") finish(e, false); };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
    document.addEventListener("keydown", onKey);
  }

  // The keyboard path: "c" on a selected node, arrow keys choose the target, Enter opens the dialog.
  function startKeyConnection(fromId) {
    const targets = inst.model.nodes.map((n) => n.id).filter((id) => id !== fromId);
    inst.connect = { from: fromId, targets, index: 0 };
    markTarget(targets[0]);
    inst.canvasHost.setAttribute("aria-live", "polite");
  }

  function endKeyConnection() {
    inst.connect = null;
    markTarget(null);
  }

  function connectKey(ev) {
    const c = inst.connect;
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[ev.key];
    if (dir) {
      ev.preventDefault();
      c.index = (c.index + dir + c.targets.length) % c.targets.length;
      markTarget(c.targets[c.index]);
    } else if (ev.key === "Enter") {
      ev.preventDefault();
      const boxes = nodeBoxes();
      const to = c.targets[c.index];
      endKeyConnection();
      openInteractionDialog(c.from, to, nearestAnchorPair(boxes[c.from], boxes[to]));
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      endKeyConnection();
    } else return false;
    return true;
  }

  // ---- The interaction dialog ----
  async function post(url, body) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error((data && (data.error || (data.errors && data.errors.map((e) => e.message).join("; ")))) || "The request failed (" + res.status + ").");
    return data;
  }

  // pair is given for a new connection (the anchors of the drag). Without pair the dialog edits the pair from -> to.
  async function openInteractionDialog(from, to, pair) {
    if (!inst || inst.readOnly) return;
    const edit = !pair;
    const dialog = make("dialog", { class: "cvDialog", "aria-labelledby": "cvDlgTitle" });
    const form = make("form", { method: "dialog" });
    const list = make("div", { class: "cvChoices" });
    const error = make("p", { class: "cvDlgError", role: "alert" });
    const ok = make("button", { type: "submit", class: "cvOk" }, "OK");
    const cancel = make("button", { type: "button", class: "secondary cvCancel" }, "Cancel");
    form.append(make("h2", { id: "cvDlgTitle" }, "What type of interaction does this arrow represent?"),
      make("p", { class: "hint" }, from + " → " + to), list, error, make("div", { class: "cvDlgBar" }));
    form.lastChild.append(ok, cancel);
    dialog.append(form);
    ok.disabled = true;
    const close = () => { dialog.close(); dialog.remove(); removeTemp(); };
    cancel.addEventListener("click", close);
    dialog.addEventListener("cancel", (ev) => { ev.preventDefault(); close(); });
    document.body.append(dialog);
    dialog.showModal();
    const boxes = () => [...list.querySelectorAll("input:not(:disabled)")];
    const refresh = () => { ok.disabled = !edit && !boxes().some((b) => b.checked); };
    list.addEventListener("change", refresh);
    try {
      const { text } = await post("/api/pipelines/text", { model: inst.model, baseText: "" });
      const r = await post("/api/pipelines/edge-options", { text, from, to });
      const item = (name, description, checked, disabled, note) => {
        const input = make("input", { type: "checkbox", value: name });
        input.checked = checked;
        input.disabled = disabled;
        const label = make("label", { class: "cvChoice" });
        label.append(input, make("strong", {}, name), make("span", { class: "hint" }, note || description || ""));
        return label;
      };
      for (const c of r.current) list.append(item(c, "", true, !edit, edit ? "" : "already on this arrow"));
      for (const o of r.options) list.append(item(o.name, o.description, false, false));
      if (!r.options.length && (!edit || !r.current.length)) {
        list.prepend(make("p", {}, "No interaction is valid between " + from + " and " + to + "."));
        ok.hidden = true;
        cancel.textContent = "Close";
      }
      refresh();
      (boxes()[0] || cancel).focus();
      form.addEventListener("submit", (ev) => {
        ev.preventDefault();
        const names = boxes().filter((b) => b.checked).map((b) => b.value);
        const added = names.filter((n) => !r.current.includes(n));
        if (pair) inst.layout = rememberAnchors(inst.layout, from, to, added, pair);
        const fn = edit ? (m) => setInteractions(m, from, to, names) : (m) => addInteractions(m, from, to, names);
        dialog.close();
        dialog.remove();
        removeTemp();
        applyChange(fn);
      });
    } catch (e) {
      error.textContent = e.message;
      cancel.focus();
    }
  }

  function onCanvasKey(ev) {
    if (inst.connect && connectKey(ev)) return;
    const selected = inst.selection;
    if (ev.key === "Enter" && selected && selected.kind === "arrow" && ev.target.closest("[data-arrow]")) {
      ev.preventDefault();
      openInteractionDialog(selected.from, selected.to);
      return;
    }
    if (ev.key === "c" && selected && selected.kind === "node" && !inst.readOnly && inst.model.nodes.length > 1) {
      ev.preventDefault();
      startKeyConnection(selected.id);
      return;
    }
    if (ev.key === "Delete" || ev.key === "Backspace") { ev.preventDefault(); deleteSelection(); return; }
    const sel = inst.selection;
    const step = { ArrowLeft: [-10, 0], ArrowRight: [10, 0], ArrowUp: [0, -10], ArrowDown: [0, 10] }[ev.key];
    if (!step || !sel || sel.kind !== "node" || inst.readOnly) return;
    ev.preventDefault();
    const pos = inst.layout.nodes[sel.id];
    inst.layout.nodes[sel.id] = { x: Math.max(0, pos.x + step[0]), y: Math.max(0, pos.y + step[1]) };
    saveLayout();
    draw();
  }

  function renderPalette(host, palette) {
    host.textContent = "";
    host.append(make("h2", {}, "Node types"));
    if (!palette) { host.append(make("p", { class: "hint" }, "The palette is not available.")); return; }
    for (const group of paletteGroups(palette)) {
      const list = make("ul", { class: "cvPalList" });
      for (const type of group.types) {
        const item = make("button", { type: "button", class: "cvPalItem", draggable: "true", "data-type": type.name, title: type.description || "" }, type.name);
        item.addEventListener("dragstart", (ev) => { ev.dataTransfer.setData(NODE_TYPE_MIME, type.name); ev.dataTransfer.effectAllowed = "copy"; });
        item.addEventListener("keydown", (ev) => {
          if (ev.key !== "Enter" && ev.key !== " ") return;
          ev.preventDefault();
          addNodeAt(type.name, nextFreePosition(Object.values(nodeBoxes())));
        });
        list.append(make("li", {}, item));
      }
      const section = make("section", { "aria-label": group.title });
      section.append(make("h3", {}, group.title), list);
      host.append(section);
    }
  }

  const KINDS = [["interaction", "Interaction"], ["handoff", "Handoff"], ["rework", "Rework (FAIL)"], ["arrive", "Arrive (PASS)"]];

  // Shows the model in the three parts of #visualHost. onModelChange(model) writes the text.
  function mount({ paletteHost, canvasHost, model, name, palette, readOnly, onModelChange }) {
    const box = make("div", { class: "cvBox", tabindex: "-1" });
    const legend = make("ul", { class: "cvLegend", "aria-label": "Arrow kinds" });
    for (const [kind, text] of KINDS) legend.append(make("li", { class: "cvKey " + kind }, text));
    legend.querySelectorAll("li").forEach((li) => li.prepend(make("span", { class: "pgSwatch", "aria-hidden": "true" })));
    canvasHost.textContent = "";
    canvasHost.append(legend, box);
    paletteHost.hidden = !!readOnly;
    if (!readOnly) renderPalette(paletteHost, palette);
    inst = { model: clone(model), name, palette, readOnly: !!readOnly, onModelChange: onModelChange || (() => {}),
      layout: readLayout(name), selection: null, connect: null, temp: null, paletteHost, canvasHost, box, svg: null };
    canvasHost.onkeydown = onCanvasKey;
    box.ondragover = (ev) => { if (!inst.readOnly) ev.preventDefault(); };
    box.ondrop = (ev) => {
      const type = ev.dataTransfer && ev.dataTransfer.getData(NODE_TYPE_MIME);
      if (inst.readOnly || !type) return;
      ev.preventDefault();
      const rect = inst.svg.getBoundingClientRect();
      addNodeAt(type, { x: ev.clientX - rect.left - NODE_SIZE.width / 2, y: ev.clientY - rect.top - NODE_SIZE.height / 2 });
    };
    draw();
  }

  function unmount() { inst = null; }

  const onSelectionChange = (cb) => { listeners.push(cb); };
  return Object.assign(api, { mount, unmount, onSelectionChange, applyChange, openInteractionDialog });
});
