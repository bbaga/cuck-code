// The side panels of the visual editor: the pipeline panel, the node panel and the arrow panel.
// The top half is pure logic that the Node tests require(); the DOM code below it starts only in a
// browser. Each change is a function of the model that goes to pipelineCanvas.applyChange.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(null);
  else root.pipelineInspector = factory(root);
})(typeof self !== "undefined" ? self : this, function (win) {
  const DEBOUNCE_MS = 400;
  const EFFORTS = ["low", "medium", "high"];
  const FIELD_TYPES = ["string", "text", "enum", "instance", "instances", "repo", "commit"];
  const CUSTOM = "__custom";

  // An unset value: undefined, "", an empty list or an empty object.
  function isEmpty(value) {
    if (value === undefined || value === null || value === "") return true;
    if (Array.isArray(value)) return value.length === 0;
    return typeof value === "object" && Object.keys(value).length === 0;
  }

  // The model with one key of one node set; an empty value removes the key. The key order stays.
  function setNodeKey(model, id, key, value) {
    const nodes = model.nodes.map((node) => {
      if (node.id !== id) return node;
      const next = { ...node };
      if (isEmpty(value)) delete next[key]; else next[key] = value;
      return next;
    });
    return { ...model, nodes };
  }

  // The same for the keys of the pipeline: name, description, start and "defaults.prompt".
  function setPipelineKey(model, key, value) {
    if (key === "defaults.prompt") {
      const defaults = { ...(model.defaults || {}) };
      if (isEmpty(value)) delete defaults.prompt; else defaults.prompt = value;
      return { ...model, defaults };
    }
    if (key === "description") return { ...model, description: isEmpty(value) ? null : value };
    return { ...model, [key]: value };
  }

  // A new id in nodes, edges, start, and in the "checks" and "after" of the other nodes.
  function renameNode(model, oldId, newId) {
    const swap = (id) => (id === oldId ? newId : id);
    const nodes = model.nodes.map((node) => {
      const next = node.id === oldId ? { ...node, id: newId } : { ...node };
      for (const key of ["checks", "after"]) if (Array.isArray(next[key])) next[key] = next[key].map(swap);
      return next;
    });
    const edges = model.edges.map((e) => ({ ...e, from: swap(e.from), to: swap(e.to) }));
    return { ...model, nodes, edges, start: swap(model.start) };
  }

  // The message for a bad new id, or "".
  function idProblem(model, oldId, newId, idPattern) {
    if (idPattern && !new RegExp(idPattern).test(newId)) return "The id must match " + idPattern;
    if (newId !== oldId && model.nodes.some((n) => n.id === newId)) return "The id '" + newId + "' is taken";
    return "";
  }

  // The value of a prompt control: nothing, a text, or { file }.
  function promptValue(mode, text) {
    if (mode === "none" || !text) return undefined;
    return mode === "file" ? { file: text } : text;
  }

  const promptMode = (prompt) => (prompt === undefined || prompt === null ? "none" : typeof prompt === "object" ? "file" : "text");
  const promptText = (prompt) => (promptMode(prompt) === "file" ? prompt.file : typeof prompt === "string" ? prompt : "");

  // The "fields" map of a node as rows (a row has the name and every key of the declaration), and back.
  const rowsFromFields = (fields) => Object.entries(fields || {}).map(([name, decl]) => ({ name, ...decl }));
  function fieldsFromRows(rows) {
    const fields = {};
    for (const { name, ...decl } of rows) {
      const kept = Object.fromEntries(Object.entries(decl).filter(([, v]) => !isEmpty(v)));
      if (name) fields[name] = kept;
    }
    return fields;
  }

  // A name that no entry of `taken` uses: base, base-2, base-3 ...
  function freeName(base, taken) {
    let name = base;
    for (let i = 2; taken.includes(name); i++) name = base + "-" + i;
    return name;
  }

  const splitList = (text) => text.split(",").map((s) => s.trim()).filter(Boolean);
  const api = { DEBOUNCE_MS, isEmpty, setNodeKey, setPipelineKey, renameNode, idProblem, promptValue, promptMode, promptText,
    rowsFromFields, fieldsFromRows, freeName, splitList };
  if (!win || typeof document === "undefined") return api;

  // ---- DOM (browser only) ----
  let state = { model: null, selection: null, readOnly: false };
  let seq = 0;
  let cache = null; // { palette, harnesses }, loaded one time
  const promptModes = {}; // the mode that the user chose for a prompt that has no value yet

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== false) node.setAttribute(k, v === true ? "" : v);
    node.append(...children.filter((c) => c !== undefined && c !== null));
    return node;
  }

  async function loadCache() {
    if (cache) return cache;
    const get = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [palette, harnesses] = await Promise.all([get("/api/pipelines/palette"), get("/api/harnesses")]);
    cache = { palette: palette || { nodeTypes: [], nodeKeys: { keys: [], checkouts: [], maxRoundsLimit: 10 } },
      harnesses: win.pipelineUI.filterInstalled(harnesses && harnesses.harnesses) };
    return cache;
  }

  const change = (fn) => win.pipelineCanvas.applyChange(fn);
  const ro = () => state.readOnly;
  let counter = 0;

  // A labelled control. `make(id)` builds the input. `key` identifies it to restore the focus after a redraw.
  function labelled(text, key, make) {
    const id = "ins-" + ++counter;
    const input = make(id);
    input.setAttribute("data-k", key);
    if (ro()) input.disabled = true;
    return el("div", { class: "insRow" }, el("label", { for: id }, text), input);
  }

  // Text input or textarea. Typing applies after a pause; leaving the input applies at once.
  function textControl(text, key, value, apply, opts) {
    const o = opts || {};
    return labelled(text, key, (id) => {
      const input = el(o.multiline ? "textarea" : "input", { id, type: o.multiline ? undefined : (o.type || "text"), rows: o.multiline ? 4 : undefined,
        min: o.min, max: o.max, step: o.step, placeholder: o.placeholder });
      input.value = value === undefined || value === null ? "" : String(value);
      let timer = null;
      const fire = () => { timer = null; apply(input.value); };
      input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(fire, DEBOUNCE_MS); });
      input.addEventListener("change", () => { if (timer) { clearTimeout(timer); fire(); } });
      return input;
    });
  }

  // A select. options: [value, label]. A change applies at once.
  function selectControl(text, key, value, options, apply) {
    return labelled(text, key, (id) => {
      const select = el("select", { id }, ...options.map(([v, l]) => el("option", { value: v }, l)));
      select.value = value;
      select.addEventListener("change", () => apply(select.value, select));
      return select;
    });
  }

  function checkList(text, key, ids, chosen, apply) {
    const set = el("fieldset", { class: "insSet" }, el("legend", {}, text));
    if (!ids.length) set.append(el("p", { class: "hint" }, "No other nodes."));
    ids.forEach((id, i) => {
      const box = el("input", { type: "checkbox", id: "ins-" + ++counter, "data-k": key + "." + i });
      box.checked = (chosen || []).includes(id);
      box.disabled = ro();
      box.addEventListener("change", () => apply(ids.filter((other, j) => (j === i ? box.checked : set.querySelectorAll("input")[j].checked))));
      set.append(el("div", { class: "insCheck" }, box, el("label", { for: box.id }, id)));
    });
    return set;
  }

  // The mode select (none, text, file) with a textarea or a path input below it.
  function promptControl(text, key, prompt, apply) {
    const kept = promptModes[key];
    let mode = promptMode(prompt) === "none" && kept ? kept : promptMode(prompt);
    const box = el("div", { class: "insGroup" });
    const draw = () => {
      box.textContent = "";
      const modeSelect = selectControl(text + " mode", key, mode, [["none", "None"], ["text", "Text"], ["file", "File"]], (value) => {
        mode = promptModes[key] = value;
        draw();
        // The text or the path of the old mode goes to the new mode. With no text, the model stays as it is.
        if (value === "none") apply(undefined);
        else if (!isEmpty(prompt)) apply(promptValue(mode, promptText(prompt)));
        box.querySelector("[data-k]").focus();
      });
      box.append(modeSelect);
      if (mode !== "none") {
        box.append(textControl(text + (mode === "file" ? " file path" : " text"), key + "." + mode, promptText(prompt),
          (value) => apply(promptValue(mode, value)), { multiline: mode === "text" }));
      }
    };
    draw();
    return box;
  }

  function modelControl(node, harnesses, key) {
    const options = win.pipelineUI.modelOptionsForPhase({ harnesses, harnessId: node.harness, piDetail: null });
    const known = options.some((o) => o.value === node.model);
    let custom = node.model !== undefined && !known;
    const box = el("div", { class: "insGroup" });
    const draw = () => {
      box.textContent = "";
      const value = custom ? CUSTOM : node.model || "";
      box.append(selectControl("model", key, value, [["", "(not set)"], ...options.map((o) => [o.value, o.label]), [CUSTOM, "Other (type a name)"]], (v) => {
        custom = v === CUSTOM;
        if (custom) { draw(); box.querySelector("input").focus(); } else apply(v);
      }));
      if (custom) box.append(textControl("model name", key + ".text", node.model, apply));
    };
    const apply = (v) => change((m) => setNodeKey(m, node.id, "model", v.trim()));
    draw();
    return box;
  }

  // A button row editor: `rows` are objects; `draw(row, index)` gives the controls of one row.
  function listEditor(title, key, rows, newRow, update, drawRow) {
    const set = el("fieldset", { class: "insSet" }, el("legend", {}, title));
    rows.forEach((row, i) => {
      const item = el("fieldset", { class: "insItem" }, el("legend", {}, title + " " + (i + 1)));
      item.append(...drawRow(row, i, (patch) => update(rows.map((r, j) => (j === i ? patch(r) : r)))));
      const remove = el("button", { type: "button", class: "secondary", "data-k": key + "." + i + ".remove", disabled: ro() }, "Remove " + title.toLowerCase() + " " + (i + 1));
      remove.addEventListener("click", () => update(rows.filter((r, j) => j !== i)));
      item.append(remove);
      set.append(item);
    });
    const add = el("button", { type: "button", class: "secondary", "data-k": key + ".add", disabled: ro() }, "Add " + title.toLowerCase());
    add.addEventListener("click", () => update([...rows, newRow(rows)]));
    set.append(add);
    return set;
  }

  // Sets or clears one key of a row object.
  const withKey = (row, k, v) => { const next = { ...row }; if (isEmpty(v)) delete next[k]; else next[k] = v; return next; };

  function fieldsEditor(node) {
    const rows = rowsFromFields(node.fields);
    const update = (next) => change((m) => setNodeKey(m, node.id, "fields", fieldsFromRows(next)));
    return listEditor("Field", "node.fields", rows, (all) => ({ name: freeName("field", all.map((r) => r.name)), description: "", type: "string" }), update,
      (row, i, edit) => {
        const k = "node.fields." + i + ".";
        const text = (label, name, opts) => textControl(label, k + name, row[name], (v) => edit((r) => withKey(r, name, v)), opts);
        const number = (v) => (v === "" ? undefined : Number(v));
        return [text("Field name", "name"), text("Description", "description"),
          selectControl("Type", k + "type", row.type || "string", FIELD_TYPES.map((t) => [t, t]), (v) => edit((r) => withKey(r, "type", v))),
          textControl("Max length", k + "maxLength", row.maxLength, (v) => edit((r) => withKey(r, "maxLength", number(v))), { type: "number", min: 1 }),
          text("Pattern", "pattern"),
          textControl("Values (comma separated)", k + "values", (row.values || []).join(", "), (v) => edit((r) => withKey(r, "values", splitList(v)))),
          text("Node", "node"),
          labelled("Optional", k + "optional", (id) => {
            const box = el("input", { type: "checkbox", id });
            box.checked = row.optional === true;
            box.addEventListener("change", () => edit((r) => withKey(r, "optional", box.checked || undefined)));
            return box;
          })];
      });
  }

  function scriptsEditor(node) {
    const scripts = node.scripts || [];
    const update = (next) => change((m) => setNodeKey(m, node.id, "scripts", next));
    return listEditor("Script", "node.scripts", scripts, (all) => ({ name: freeName("script", all.map((s) => s.name)), run: "" }), update,
      (script, i, edit) => {
        const k = "node.scripts." + i + ".";
        const text = (label, name, opts) => textControl(label, k + name, script[name], (v) => edit((r) => withKey(r, name, v)), opts);
        const env = Object.entries(script.env || {}).map(([name, value]) => ({ name, value }));
        const setEnv = (rows) => edit((r) => withKey(r, "env", Object.fromEntries(rows.filter((e) => e.name).map((e) => [e.name, e.value]))));
        return [text("Script name", "name"), text("Command", "run"), text("Working directory", "cwd"),
          textControl("Timeout", k + "timeout", script.timeout, (v) => edit((r) => withKey(r, "timeout", v === "" ? undefined : Number(v))), { type: "number", min: 1 }),
          textControl("Repos (comma separated)", k + "repos", (script.repos || []).join(", "), (v) => edit((r) => withKey(r, "repos", splitList(v)))),
          listEditor("Variable", k + "env", env, (all) => ({ name: freeName("VAR", all.map((e) => e.name)), value: "" }), setEnv,
            (row, j, editEnv) => [
              textControl("Variable name", k + "env." + j + ".name", row.name, (v) => editEnv((e) => ({ ...e, name: v.toUpperCase() }))),
              textControl("Variable value", k + "env." + j + ".value", row.value, (v) => editEnv((e) => ({ ...e, value: v })))])];
      });
  }

  function triState(text, key, value, apply) {
    const current = value === true ? "yes" : value === false ? "no" : "";
    return selectControl(text, key, current, [["", "(not set)"], ["yes", "Yes"], ["no", "No"]], (v) => apply(v === "" ? undefined : v === "yes"));
  }

  function nodePanel(node, model, cache) {
    const { palette, harnesses } = cache;
    const set = (key) => (v) => change((m) => setNodeKey(m, node.id, key, v));
    const setNumber = (key) => (v) => set(key)(v === "" ? undefined : Number(v));
    const others = model.nodes.map((n) => n.id).filter((id) => id !== node.id);
    const type = palette.nodeTypes.find((t) => t.name === node.type);
    const known = palette.nodeKeys.keys;
    const problem = el("p", { class: "insErr", role: "alert" });
    const panel = el("div", { class: "insPanel" }, el("h2", {}, "Node " + node.id), problem);

    const idControl = textControl("id", "node.id", node.id, (v) => {
      const bad = idProblem(model, node.id, v, palette.nodeKeys.idPattern);
      problem.textContent = bad;
      if (bad || v === node.id) return;
      change((m) => renameNode(m, node.id, v)).then(() => renameLayout(model.name, node.id, v));
    });
    panel.append(idControl);
    panel.append(selectControl("type", "node.type", node.type || "", [...(type ? [] : [[node.type || "", node.type || "(none)"]]),
      ...palette.nodeTypes.map((t) => [t.name, t.name])], set("type")));
    panel.append(selectControl("harness", "node.harness", node.harness || "", [["", "(not set)"], ...harnesses.map((h) => [h.id, h.label || h.id]),
      ...(node.harness && !harnesses.some((h) => h.id === node.harness) ? [[node.harness, node.harness]] : [])], set("harness")));
    panel.append(modelControl(node, harnesses, "node.model"));
    panel.append(selectControl("effort", "node.effort", node.effort || "", [["", "(not set)"], ...EFFORTS.map((e) => [e, e])], set("effort")));
    panel.append(textControl("timeLimit (minutes, above 0)", "node.timeLimit", node.timeLimit, setNumber("timeLimit"), { type: "number", min: 1 }));
    panel.append(textControl("maxContext (tokens, at least 1000)", "node.maxContext", node.maxContext, setNumber("maxContext"), { type: "number", min: 1000 }));
    panel.append(promptControl("prompt", "node.prompt", node.prompt, set("prompt")));
    panel.append(fieldsEditor(node));
    panel.append(checkList("checks", "node.checks", others, node.checks, set("checks")));
    panel.append(checkList("after", "node.after", others, node.after, set("after")));
    panel.append(textControl("maxRounds (1 to " + palette.nodeKeys.maxRoundsLimit + ")", "node.maxRounds", node.maxRounds, setNumber("maxRounds"),
      { type: "number", min: 1, max: palette.nodeKeys.maxRoundsLimit }));
    if (type && type.runner === "script") {
      const section = el("section", { class: "insSection", "aria-label": "Script settings" }, el("h3", {}, "Script settings"));
      section.append(scriptsEditor(node), triState("failFast", "node.failFast", node.failFast, set("failFast")),
        triState("required", "node.required", node.required, set("required")),
        selectControl("checkout", "node.checkout", node.checkout || "", [["", "(not set)"], ...palette.nodeKeys.checkouts.map((c) => [c, c])], set("checkout")));
      panel.append(section);
    }
    const unknown = Object.keys(node).filter((k) => k !== "id" && !known.includes(k));
    if (unknown.length) {
      const list = el("ul", { class: "insUnknown" });
      for (const k of unknown) list.append(el("li", {}, el("span", { class: "warn" }, "Unknown key "), el("code", {}, k + ": " + JSON.stringify(node[k]))));
      panel.append(el("section", { "aria-label": "Unknown keys" }, el("h3", {}, "Keys the editor does not know"), list));
    }
    return panel;
  }

  // The layout of the canvas is kept by node id. Move the entries of the old id to the new id.
  function renameLayout(pipeline, oldId, newId) {
    const storeKey = win.pipelineCanvas.LAYOUT_KEY + pipeline;
    try {
      const layout = JSON.parse(localStorage.getItem(storeKey));
      if (!layout || !layout.nodes || !layout.nodes[oldId]) return;
      layout.nodes[newId] = layout.nodes[oldId];
      delete layout.nodes[oldId];
      const arrows = {};
      for (const [k, v] of Object.entries(layout.arrows || {})) {
        arrows[k.replace(/^([^>]*?)->([^:]*):/, (all, from, to) => (from === oldId ? newId : from) + "->" + (to === oldId ? newId : to) + ":")] = v;
      }
      layout.arrows = arrows;
      localStorage.setItem(storeKey, JSON.stringify(layout));
    } catch { /* the layout is optional */ }
  }

  function pipelinePanel(model) {
    const panel = el("div", { class: "insPanel" }, el("h2", {}, "Pipeline"));
    panel.append(el("p", { class: "insName" }, el("strong", {}, "name: "), model.name,
      el("span", { class: "hint" }, " (use Duplicate to rename)")));
    panel.append(textControl("description", "pipe.description", model.description, (v) => change((m) => setPipelineKey(m, "description", v)), { multiline: true }));
    panel.append(selectControl("start", "pipe.start", model.start, model.nodes.map((n) => [n.id, n.id]), (v) => change((m) => setPipelineKey(m, "start", v))));
    panel.append(promptControl("defaults.prompt", "pipe.prompt", (model.defaults || {}).prompt, (v) => change((m) => setPipelineKey(m, "defaults.prompt", v))));
    return panel;
  }

  function arrowPanel(sel, model) {
    const edge = model.edges.find((e) => e.from === sel.from && e.to === sel.to);
    const others = edge ? edge.interactions.filter((i) => i !== sel.interaction) : [];
    const panel = el("div", { class: "insPanel" }, el("h2", {}, "Arrow"),
      el("dl", { class: "insDl" }, el("dt", {}, "from"), el("dd", {}, sel.from), el("dt", {}, "to"), el("dd", {}, sel.to),
        el("dt", {}, "interaction"), el("dd", {}, sel.interaction),
        el("dt", {}, "other interactions"), el("dd", {}, others.length ? others.join(", ") : "none")));
    if (typeof win.pipelineCanvas.openInteractionDialog === "function" && !ro()) {
      const button = el("button", { type: "button", "data-k": "arrow.edit" }, "Edit interactions");
      button.addEventListener("click", () => win.pipelineCanvas.openInteractionDialog(sel.from, sel.to));
      panel.append(button);
    }
    return panel;
  }

  async function render(selection, model) {
    const host = document.getElementById("inspectorHost");
    if (!host) return;
    state = { ...state, model, selection };
    const mine = ++seq;
    const data = await loadCache();
    if (mine !== seq) return;
    const active = host.contains(document.activeElement) ? document.activeElement : null;
    const focus = active && { k: active.getAttribute("data-k"), start: active.selectionStart, end: active.selectionEnd };
    host.textContent = "";
    counter = 0;
    const node = selection && selection.kind === "node" && model.nodes.find((n) => n.id === selection.id);
    host.append(node ? nodePanel(node, model, data) : selection && selection.kind === "arrow" ? arrowPanel(selection, model) : pipelinePanel(model));
    if (focus && focus.k) {
      const target = host.querySelector("[data-k=\"" + focus.k + "\"]");
      if (target) {
        target.focus({ preventScroll: true });
        if (focus.start !== null && focus.start !== undefined && target.setSelectionRange) {
          try { target.setSelectionRange(focus.start, focus.end); } catch { /* not a text input */ }
        }
      }
    }
  }

  // The page calls show() after it mounts the canvas, for the panel of an empty selection.
  function show(model, readOnly) {
    state.readOnly = !!readOnly;
    for (const k of Object.keys(promptModes)) delete promptModes[k];
    return render(null, JSON.parse(JSON.stringify(model)));
  }

  win.pipelineCanvas.onSelectionChange((selection, model) => render(selection, model));
  return Object.assign(api, { show });
});
