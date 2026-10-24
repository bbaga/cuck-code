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

  function filterInstalled(harnesses) {
    return (harnesses || []).filter((h) => h && h.installed === true);
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

  function authBadge(entry) {
    if (!entry || entry.installed !== true) return "not installed";
    if (entry.auth === "ok") return "ok";
    if (entry.auth === "missing") return "missing";
    return "unknown";
  }

  return { PHASE_ROWS, EFFORT_LEVELS, filterInstalled, buildPipelinePayload, authBadge };
});
