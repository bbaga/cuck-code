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

  const PI_HARNESS_ID = "pi";
  const VIBE_HARNESS_ID = "vibe";

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
  // qualified models from its detail response; Vibe shows base metadata
  // models; other harnesses contribute nothing beyond the default option.
  function modelOptionsForPhase({ harnesses, harnessId, piDetail }) {
    if (harnessId === PI_HARNESS_ID) {
      return piDetail ? piDetailModels(piDetail) : [];
    }
    if (harnessId === VIBE_HARNESS_ID) {
      return baseModelOptions(harnesses, VIBE_HARNESS_ID);
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
      for (const field of ["harness", "model", "effort", "timeLimit"]) {
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

  function authBadge(entry) {
    if (!entry || entry.installed !== true) return "not installed";
    if (entry.auth === "ok") return "ok";
    if (entry.auth === "missing") return "missing";
    return "unknown";
  }

  return {
    PHASE_ROWS,
    EFFORT_LEVELS,
    PI_HARNESS_ID,
    VIBE_HARNESS_ID,
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
    isFailedValidator,
    shouldHideValidator,
  };
});
