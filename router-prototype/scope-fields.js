function scopeText(value) {
  if (value == null || value === "") return null;
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map((item, i) => `${i + 1}. ${scopeText(item) || ""}`).join("\n");
  }
  if (typeof value === "object") {
    return Object.entries(value).map(([k, v]) => `${k}: ${scopeText(v) || ""}`).join("\n");
  }
  return String(value);
}

// `workers` is the line's worker Map (id -> worker); it resolves validatesName.
function scopeFields(w, workers) {
  const fields = { prompt: null, criteria: null, validates: null, validatesName: null };
  if (!w) return fields;
  if (w.role === "validator" && w.kind === "integration") {
    fields.prompt = scopeText(w.prompt);
  } else if (w.role === "validator") {
    fields.criteria = scopeText(w.validationCriteria);
    if (w.validates) {
      const impl = workers && typeof workers.get === "function" ? workers.get(w.validates) : null;
      fields.validates = w.validates;
      fields.validatesName = impl ? impl.name || null : null;
    }
  } else {
    fields.prompt = scopeText(w.prompt);
  }
  return fields;
}

module.exports = { scopeFields, scopeText };
