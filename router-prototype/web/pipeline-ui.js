// Pure helpers for the pipeline config UI. No DOM access.
// Loaded in the browser via <script> and in Node tests via require().
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.pipelineUI = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const PHASE_ROWS = [
    { key: "planner" },
    { key: "implementor" },
    { key: "validator" },
    { key: "integration" },
  ];

  const EFFORT_LEVELS = ["low", "medium", "high"];

  // Phases whose sessions are resumed and take a maxContext setting.
  const CONTEXT_PHASES = ["planner", "implementor"];

  // Parse a max context size typed in thousands: "200K", "50k", "1M",
  // "1.5M", or a bare "200" (read as 200K). Returns tokens, null for an
  // empty value, or NaN for anything else.
  function parseContextSize(text) {
    const raw = String(text === undefined || text === null ? "" : text).trim();
    if (!raw) return null;
    const m = raw.match(/^(\d+(?:\.\d+)?)\s*([kKmM]?)$/);
    if (!m) return NaN;
    const unit = m[2].toLowerCase() === "m" ? 1000000 : 1000;
    const tokens = Math.round(Number(m[1]) * unit);
    return tokens >= 1000 ? tokens : NaN;
  }

  // Compact token count for display: 950, 12K, 1.2M.
  function formatTokens(n) {
    if (!Number.isFinite(n) || n < 1000) return String(Math.max(0, Math.round(n || 0)));
    if (n < 1000000) return Math.round(n / 1000) + "K";
    return (Math.round(n / 100000) / 10) + "M";
  }

  const PI_HARNESS_ID = "pi";
  const VIBE_HARNESS_ID = "vibe";
  const CLAUDE_HARNESS_ID = "claude";

  function filterInstalled(harnesses) {
    return (harnesses || []).filter((h) => h && h.installed === true);
  }

  function findHarness(harnesses, id) {
    if (!Array.isArray(harnesses) || typeof id !== "string") return null;
    return harnesses.find((h) => h && h.id === id) || null;
  }

  // Normalize a {value,label} list (or plain strings) into clean options.
  // Drops empty values, trims, dedupes by value, and defaults label to value.
  function normalizeOptions(list) {
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(list) ? list : []) {
      if (item === null || item === undefined) continue;
      const rawValue = typeof item === "string" ? item : item.value;
      const rawLabel = typeof item === "string" ? item : item.label;
      if (typeof rawValue !== "string" || rawValue.trim() === "") continue;
      const value = rawValue.trim();
      if (seen.has(value)) continue;
      seen.add(value);
      const label =
        typeof rawLabel === "string" && rawLabel.trim() !== "" ? rawLabel.trim() : value;
      out.push({ value, label });
    }
    return out;
  }

  // Merge option lists; first occurrence of a value wins.
  function mergeModelOptions(...lists) {
    return normalizeOptions(lists.flat());
  }

  // VIBE_MODELS is the documented comma-separated environment variable for
  // extra Vibe model choices. The server may forward it as modelsEnv.
  function parseCommaSeparatedModels(raw) {
    if (typeof raw !== "string") return [];
    return normalizeOptions(raw.split(","));
  }

  function authModeOptions(harnesses, harnessId) {
    return normalizeOptions(
      findHarness(harnesses, harnessId) &&
        findHarness(harnesses, harnessId).authModes,
    );
  }

  function baseModelOptions(harnesses, harnessId) {
    const entry = findHarness(harnesses, harnessId);
    return mergeModelOptions(
      normalizeOptions(entry && entry.models),
      parseCommaSeparatedModels(entry && entry.modelsEnv),
    );
  }

  function piDetailModels(piDetail) {
    return normalizeOptions(piDetail && piDetail.models);
  }

  // Model choices for one phase row. Pi shows only the selected provider's
  // qualified models from its detail response; Vibe and Claude show base
  // metadata models; other harnesses contribute nothing beyond the default
  // option.
  function modelOptionsForPhase({ harnesses, harnessId, piDetail }) {
    if (harnessId === PI_HARNESS_ID) {
      return piDetail ? piDetailModels(piDetail) : [];
    }
    if (harnessId === VIBE_HARNESS_ID || harnessId === CLAUDE_HARNESS_ID) {
      return baseModelOptions(harnesses, harnessId);
    }
    return [];
  }

  function piDetailUrl(provider) {
    return "/api/harnesses/pi?provider=" + encodeURIComponent(provider);
  }

  // Human-readable auth state and login hint from a Pi detail response.
  function piAuthStatusText(detail) {
    if (!detail || typeof detail !== "object") return "";
    const hint =
      typeof detail.loginHint === "string" ? detail.loginHint.trim() : "";
    const suffix = hint ? " - " + hint : "";
    if (detail.auth === "ok") return "pi auth ok" + suffix;
    if (detail.auth === "missing") return "pi auth missing - run " + (hint || "pi /login");
    return "pi auth unknown" + suffix;
  }

  // Pure decision for one phase row's auth mode select. A non-Pi harness
  // always resets the select to the empty default, so a stale selected
  // value cannot survive a harness change.
  function authModeSelectState({ harnessId, options, currentValue }) {
    if (harnessId !== PI_HARNESS_ID) {
      return { hidden: true, disabled: true, options: [], value: "" };
    }
    const opts = normalizeOptions(options);
    const value = opts.some((o) => o.value === currentValue) ? currentValue : "";
    return { hidden: false, disabled: false, options: opts, value };
  }

  // Pure decision for applying a Pi detail response. Call it after every
  // asynchronous boundary (fetch and response.json()) with a fresh
  // isCurrent check, so a stale response never touches newer state.
  function piDetailApply({ isCurrent, ok, status, data }) {
    if (!isCurrent) return { apply: false };
    if (!ok) {
      const error =
        data && typeof data.error === "string" && data.error.trim() !== ""
          ? data.error
          : null;
      return {
        apply: true,
        statusText: error || "Pi detail failed (HTTP " + status + ")",
        models: [],
        piDetail: null,
      };
    }
    const detail = data && typeof data === "object" ? data : null;
    if (!detail) return { apply: false };
    return {
      apply: true,
      statusText: piAuthStatusText(detail),
      models: piDetailModels(detail),
      piDetail: detail,
    };
  }

  // Monotonic request tokens: a response may only touch the UI while its
  // token is still current, so an older response cannot overwrite a newer
  // selection.
  function createRequestTracker() {
    let current = 0;
    return {
      next() {
        current += 1;
        return current;
      },
      isCurrent(token) {
        return token === current;
      },
    };
  }

  // Fetch a Pi detail response and gate it against the request token at
  // both asynchronous boundaries: immediately after fetch resolves (before
  // the status is read or the body parses) and again after the body parses
  // (before the caller applies it). A stale response is never parsed.
  async function fetchPiDetail({ url, fetchImpl, isCurrent, token }) {
    let res;
    try {
      res = await fetchImpl(url);
    } catch (err) {
      return { stage: "fetch-error", current: isCurrent(token), error: String(err) };
    }
    if (!isCurrent(token)) return { stage: "stale-after-fetch" };
    const ok = res.ok;
    const status = res.status;
    const data = await res.json().catch(() => (ok ? null : {}));
    return { stage: "parsed", current: isCurrent(token), ok, status, data };
  }

  // Full reset for a phase row: used when the harness changes. Keeps the
  // row's request tracker so in-flight fetches can be invalidated.
  function clearHarnessState(state) {
    return {
      tracker: state && state.tracker ? state.tracker : createRequestTracker(),
      authMode: "",
      model: "",
      models: [],
      piDetail: null,
      statusText: "",
    };
  }

  // Provider-specific reset: used when the auth mode changes. Keeps the
  // chosen auth mode but drops models, detail, and status text.
  function clearProviderState(state) {
    return {
      tracker: state && state.tracker ? state.tracker : createRequestTracker(),
      authMode: state && typeof state.authMode === "string" ? state.authMode : "",
      model: "",
      models: [],
      piDetail: null,
      statusText: "",
    };
  }

  function buildPipelinePayload(rows) {
    const pipeline = {};
    let any = false;
    for (const { key } of PHASE_ROWS) {
      const row = (rows && rows[key]) || {};
      const phase = {};
      for (const field of ["harness", "model", "effort", "timeLimit", "maxContext"]) {
        const v = row[field];
        if (v !== undefined && v !== null && String(v).trim() !== "") {
          phase[field] = typeof v === "number" ? v : String(v).trim();
          any = true;
        }
      }
      if (Object.keys(phase).length) pipeline[key] = phase;
    }
    return any ? pipeline : null;
  }

  // A validator counts as failed when its status is "failed" or its
  // verdict is "fail". Non-objects are never failed.
  function isFailedValidator(w) {
    if (!w || typeof w !== "object") return false;
    return w.status === "failed" || w.verdict === "fail";
  }

  // Pure decision for hiding a validator row. Only validators hide, and
  // only when the hide-failed flag is on. Integration validators get the
  // same treatment as other validators.
  function shouldHideValidator(w, hideFailed) {
    if (hideFailed !== true) return false;
    if (!w || typeof w !== "object") return false;
    if ((w.role || "implementor") !== "validator") return false;
    return isFailedValidator(w);
  }

  // Integration graph nodes remain visible while running and after stopping.
  // A failed node follows the existing hide-failed toggle.
  function shouldShowIntegrationValidator(w, hideFailed) {
    if (!w || typeof w !== "object") return false;
    return w.kind === "integration"
      && (w.role || "implementor") === "validator"
      && !shouldHideValidator(w, hideFailed);
  }

  function buildGraphLanes(workers, hideFailed) {
    const list = Array.isArray(workers) ? workers : [];
    const implementors = list.filter((w) => w && (w.role || "implementor") !== "validator");
    const validators = list.filter((w) => w && (w.role || "implementor") === "validator"
      && w.kind !== "integration" && !shouldHideValidator(w, hideFailed));
    const integrations = list.filter((w) => shouldShowIntegrationValidator(w, hideFailed));
    const assigned = new Set(implementors.map((w) => w.id));
    const lanes = implementors.map((worker) => {
      const grouped = validators.filter((v) => v.validates === worker.id);
      grouped.forEach((v) => assigned.add(v.id));
      return { worker, validators: grouped, rowCount: Math.max(1, grouped.length) };
    });
    const orphans = validators.filter((v) => !assigned.has(v.id));
    let row = 0;
    lanes.forEach((lane, index) => { lane.startRow = row; row += lane.rowCount; if (index < lanes.length - 1) row++; });
    const orphanStartRow = orphans.length ? row + (lanes.length ? 1 : 0) : null;
    if (orphans.length) row = orphanStartRow + orphans.length;
    const integrationStartRow = integrations.length ? row + (row ? 1 : 0) : null;
    if (integrations.length) row = integrationStartRow + integrations.length;
    return { lanes, orphans, orphanStartRow, integrations, integrationStartRow, totalRows: row };
  }

  function previewSelectionKey(workerId) {
    return "preview:" + String(workerId);
  }

  function isPassingIntegration(worker) {
    return !!worker && worker.kind === "integration" && worker.role === "validator"
      && worker.status === "completed" && String(worker.verdict || "").toLowerCase() === "pass";
  }

  function previewSelectionExists(workers, selected) {
    if (typeof selected !== "string" || !selected.startsWith("preview:")) return false;
    return (workers || []).some((worker) => worker && worker.kind === "integration"
      && previewSelectionKey(worker.id) === selected);
  }

  // Read-only preview contract adapter. Unknown or stale data is never eligible.
  function previewForIntegration(worker, preview) {
    if (!worker || worker.kind !== "integration" || !preview || typeof preview !== "object") return null;
    const passing = worker.status === "completed" && String(worker.verdict || "").toLowerCase() === "pass";
    const eligible = passing && preview.availability === "available" && preview.stale !== true
      && preview.eligible === true && Array.isArray(preview.steps);
    return { ...preview, eligible, steps: Array.isArray(preview.steps) ? preview.steps : [] };
  }

  function mapPreviewPayload(payload, worker) {
    if (!payload || typeof payload !== "object" || !isPassingIntegration(worker)) return null;
    const steps = Array.isArray(payload.steps) ? payload.steps
      : Array.isArray(payload.instructions) ? payload.instructions : [];
    const preview = {
      ...payload,
      sourceRevision: payload.sourceRevision || payload.source_revision || payload.revision || null,
      projectDirectory: payload.projectDirectory || payload.project_directory || null,
      expectedUrl: payload.expectedUrl || payload.expected_url || payload.url || null,
      availability: payload.availability || (payload.available === false ? "unavailable"
        : payload.stale === true ? "unavailable" : payload.eligible === true ? "available" : "unavailable"),
      stale: payload.stale === true,
      eligible: payload.eligible === true,
      steps: steps.map((step) => typeof step === "string" ? { text: step } : step),
    };
    return previewForIntegration(worker, preview);
  }

  async function fetchLinePreview({ lineId, fetchImpl, isCurrent = () => true }) {
    let response;
    try { response = await fetchImpl("/api/lines/" + encodeURIComponent(lineId) + "/preview"); }
    catch (error) { return isCurrent() ? { ok: false, availability: "unavailable", message: "Preview request failed." } : { stale: true }; }
    if (!isCurrent()) return { stale: true };
    if (response.status === 404) return { ok: false, availability: "unavailable", message: "No preview data is available for this line (HTTP 404)." };
    if (!response.ok) return { ok: false, availability: "unavailable", message: "Preview request failed (HTTP " + response.status + ")." };
    let payload;
    try { payload = await response.json(); } catch { payload = null; }
    if (!isCurrent()) return { stale: true };
    return payload && typeof payload === "object"
      ? { ok: true, payload }
      : { ok: false, availability: "unavailable", message: "Preview response was invalid." };
  }

  // Decide how the prompt field handles a keyboard event.
  function promptKeyAction({ key, shiftKey = false, isComposing = false, keyCode } = {}) {
    if (isComposing || keyCode === 229) return "ignore";
    if (key !== "Enter") return "ignore";
    return shiftKey ? "newline" : "send";
  }

  function sanitizePreviewCommand(value) {
    if (typeof value !== "string") return "";
    let text = value.replace(/\r/g, "").split("\n").filter((line) => !/^\s*(?:\$|#|> )\s*/.test(line)).join("\n");
    text = text.replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY)[A-Z0-9_]*)\s*=\s*\S+/gi, "$1=[REDACTED]")
      .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, "[REDACTED]");
    return text;
  }

  function authBadge(entry) {
    if (!entry || entry.installed !== true) return "not installed";
    if (entry.auth === "ok") return "ok";
    if (entry.auth === "missing") return "missing";
    return "unknown";
  }

  // Evidence is current only when the API identifies its integration attempt.
  // Never infer currentness from timestamps, and keep all other records in history.
  function selectEvidenceAttempt(response) {
    const data = response && typeof response === "object" ? response : {};
    let currentAttemptId = typeof data.currentAttemptId === "string" && data.currentAttemptId
      ? data.currentAttemptId : null;
    const ids = data.currentAttemptIds && typeof data.currentAttemptIds === "object"
      ? Object.values(data.currentAttemptIds).filter((id) => typeof id === "string" && id) : [];
    const uniqueIds = [...new Set(ids)];
    if (!currentAttemptId && uniqueIds.length === 1) currentAttemptId = uniqueIds[0];
    const items = Array.isArray(data.items) ? data.items : [];
    const historyItems = Array.isArray(data.history) ? data.history : [];
    const current = currentAttemptId ? items.filter((item) => item && item.attemptId === currentAttemptId) : [];
    const primary = current.filter((item) => item.kind === "showcase" && item.version === 1)
      .slice().sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")))[0] || null;
    return { currentAttemptId, ambiguous: !currentAttemptId && uniqueIds.length > 1,
      primary, history: [...items.filter((item) => item !== primary), ...historyItems] };
  }

  function clampEvidenceStep(step, length) {
    if (!Number.isFinite(step) || length <= 0) return 0;
    return Math.max(0, Math.min(Math.floor(step), length - 1));
  }

  function evidencePollIsCurrent(st, lineId, generation, selectedLine, currentState) {
    return selectedLine === lineId && currentState === st && generation === st.evidenceGen;
  }

  // This is the production evidence renderer. The page delegates to this
  // function so unit tests exercise the same DOM path as the browser.
  function renderEvidence(st, response) {
    const doc = st.evPane.ownerDocument || document;
    const pane = st.evPane;
    const selection = selectEvidenceAttempt(response);
    const showcase = selection.primary;
    const previous = st.evidenceState || { itemId: null, step: 0, time: 0 };
    const steps = showcase && Array.isArray(showcase.steps) ? showcase.steps : [];
    const selected = showcase && previous.itemId === showcase.id
      ? clampEvidenceStep(previous.step, steps.length) : 0;
    st.evidenceState = { itemId: showcase ? showcase.id : null, step: selected,
      time: showcase && previous.itemId === showcase.id ? previous.time : 0 };
    if (!showcase) {
      if (st.evidenceView && st.evidenceView.kind === "showcase") { st.evidenceView.box.remove(); st.evidenceView = null; }
      const message = selection.ambiguous ? "Current evidence attempt is ambiguous; history is shown below." : "No evidence registered for this line yet.";
      if (!st.emptyView || st.emptyView.text !== message) {
        if (st.emptyView) st.emptyView.node.remove();
        const empty = doc.createElement("div"); empty.className = "pEmpty"; empty.textContent = message;
        pane.appendChild(empty); st.emptyView = { node: empty, text: message };
      }
    } else {
      if (st.emptyView) { st.emptyView.node.remove(); st.emptyView = null; }
      if (!st.evidenceView || st.evidenceView.itemId !== showcase.id) {
      pane.innerHTML = "";
      const box = doc.createElement("section"); box.className = "evCase evShowcase";
      const heading = doc.createElement("h2"); heading.className = "uc";
      const meta = doc.createElement("div"); meta.className = "meta";
      const video = doc.createElement("video"); video.controls = true; video.preload = "metadata";
      const videoUnavailable = doc.createElement("div"); videoUnavailable.className = "pEmpty"; videoUnavailable.textContent = "Video unavailable for this showcase.";
      video.addEventListener("loadedmetadata", () => { if (st.evidenceState) video.currentTime = st.evidenceState.time || 0; });
      video.addEventListener("timeupdate", () => { if (st.evidenceState) st.evidenceState.time = video.currentTime; });
      box.append(heading, meta, video, videoUnavailable);
      const slide = doc.createElement("div"); slide.className = "evSlides";
      const copy = doc.createElement("div"); copy.className = "evCopy";
      const title = doc.createElement("h3"); const explanation = doc.createElement("p"); copy.append(title, explanation);
      slide.append(copy); box.append(slide);
      const nav = doc.createElement("div"); nav.className = "evNav";
      const prev = doc.createElement("button"); prev.type = "button"; prev.textContent = "Previous";
      const counter = doc.createElement("span"); counter.className = "evCounter";
      const next = doc.createElement("button"); next.type = "button"; next.textContent = "Next";
      prev.addEventListener("click", () => { st.evidenceState.step--; renderEvidence(st, st.evidenceResponse); });
      next.addEventListener("click", () => { st.evidenceState.step++; renderEvidence(st, st.evidenceResponse); });
      nav.append(prev, counter, next); box.append(nav); pane.appendChild(box);
      st.evidenceView = { kind: "showcase", itemId: showcase.id, box, heading, meta, video, videoUnavailable, videoUrl: null, slide, copy, title, explanation, prev, counter, next, slideKey: null };
      }
    }
    if (showcase) {
      const view = st.evidenceView;
      view.heading.textContent = showcase.useCase || "Feature demonstration";
      view.meta.textContent = new Date(showcase.at).toLocaleString() + " - " + (showcase.name || "showcase");
      if (view.videoUrl !== (showcase.video || "")) {
        view.videoUrl = showcase.video || ""; view.video.src = view.videoUrl;
        view.video.hidden = !view.videoUrl; view.videoUnavailable.hidden = Boolean(view.videoUrl);
      }
      const step = steps[selected];
      const slideKey = selected + "|" + (step && step.screenshot || "");
      if (view.slideKey !== slideKey) {
        view.slide.innerHTML = "";
        if (step && step.screenshot) {
          const image = doc.createElement("img"); image.className = "evShot"; image.alt = step.title || "Demonstration screenshot";
          const missing = doc.createElement("div"); missing.className = "pEmpty"; missing.textContent = "Screenshot unavailable."; missing.hidden = true;
          image.addEventListener("error", () => { image.hidden = true; missing.hidden = false; }); image.src = step.screenshot;
          view.slide.append(image, view.copy, missing); view.image = image; view.imageMissing = missing;
        } else {
          const missing = doc.createElement("div"); missing.className = "pEmpty"; missing.textContent = "Screenshot unavailable for this step.";
          view.slide.append(missing, view.copy); view.image = null; view.imageMissing = missing;
        }
        view.slideKey = slideKey;
      }
      view.title.textContent = step ? (step.title || "Untitled step") : "Screenshots unavailable";
      view.explanation.textContent = step ? (step.explanation || "No explanation provided.") : "This showcase has no screenshot steps.";
      view.prev.disabled = selected === 0; view.next.disabled = selected >= steps.length - 1;
      view.counter.textContent = steps.length ? (selected + 1) + " of " + steps.length : "No steps";
    }
    const legacy = selection.history;
    const historyKey = legacy.map((item) => item.id || item.at || item.name).join("|");
    if (legacy.length && (!st.historyView || st.historyView.key !== historyKey || !st.historyView.node.isConnected)) {
      const history = doc.createElement("section"); history.className = "evHistory";
      const heading = doc.createElement("h3"); heading.textContent = showcase ? "Previous evidence" : "Evidence history"; history.appendChild(heading);
      for (const item of legacy) {
        const box = doc.createElement("article"); box.className = "evLegacy";
        const name = doc.createElement("div"); name.className = "uc"; name.textContent = item.useCase || "Legacy recording";
        const meta = doc.createElement("div"); meta.className = "meta"; meta.textContent = new Date(item.at).toLocaleString() + " - " + (item.name || "evidence"); box.append(name, meta);
        if (item.video) { const oldVideo = doc.createElement("video"); oldVideo.controls = true; oldVideo.preload = "metadata"; oldVideo.src = item.video; box.appendChild(oldVideo); }
        else { const empty = doc.createElement("div"); empty.className = "pEmpty"; empty.textContent = "Video unavailable."; box.appendChild(empty); }
        history.appendChild(box);
      }
      if (st.historyView) st.historyView.node.replaceWith(history); else pane.appendChild(history);
      st.historyView = { key: historyKey, node: history };
    } else if (!legacy.length && st.historyView) { st.historyView.node.remove(); st.historyView = null; }
  }

  return {
    PHASE_ROWS,
    EFFORT_LEVELS,
    CONTEXT_PHASES,
    parseContextSize,
    formatTokens,
    PI_HARNESS_ID,
    VIBE_HARNESS_ID,
    CLAUDE_HARNESS_ID,
    filterInstalled,
    findHarness,
    normalizeOptions,
    mergeModelOptions,
    parseCommaSeparatedModels,
    authModeOptions,
    baseModelOptions,
    piDetailModels,
    modelOptionsForPhase,
    piDetailUrl,
    piAuthStatusText,
    authModeSelectState,
    piDetailApply,
    createRequestTracker,
    fetchPiDetail,
    clearHarnessState,
    clearProviderState,
    buildPipelinePayload,
    authBadge,
    previewForIntegration,
    isPassingIntegration,
    previewSelectionKey,
    previewSelectionExists,
    mapPreviewPayload,
    fetchLinePreview,
    sanitizePreviewCommand,
    promptKeyAction,
    isFailedValidator,
    shouldHideValidator,
    shouldShowIntegrationValidator,
    buildGraphLanes,
    selectEvidenceAttempt,
    clampEvidenceStep,
    renderEvidenceFromState: renderEvidence,
    evidencePollIsCurrent,
  };
});
