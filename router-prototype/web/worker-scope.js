(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.workerScope = factory();
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function createScopeLoader({ lineId, fetchImpl, onChange = () => {}, resource = "scope" }) {
    const entries = new Map();
    function remove(id) {
      const entry = entries.get(id);
      entries.delete(id);
      if (entry) entry.controller.abort();
    }
    function read(worker) {
      let entry = entries.get(worker.id);
      if (entry && entry.revision === worker.scopeRevision) return entry;
      remove(worker.id);
      entry = { revision: worker.scopeRevision, state: "loading", data: null,
        controller: new AbortController() };
      entries.set(worker.id, entry);
      const url = worker.id === null ? `/api/lines/${encodeURIComponent(lineId)}/transcript`
        : `/api/lines/${encodeURIComponent(lineId)}/workers/${encodeURIComponent(worker.id)}/${resource}`;
      Promise.resolve().then(() => fetchImpl(url,
        { signal: entry.controller.signal, cache: "no-store" }))
        .then(async (response) => {
          if (!response.ok) throw new Error(`Scope request failed (${response.status})`);
          return response.json();
        })
        .then((data) => {
          if (entries.get(worker.id) !== entry) return;
          entry.state = "loaded";
          entry.data = data;
          onChange();
        })
        .catch(() => {
          if (entries.get(worker.id) !== entry) return;
          entry.state = "error";
          onChange();
        });
      return entry;
    }
    return { read, remove,
      retry(id) { if (entries.get(id)?.state === "error") remove(id); },
      retain(ids) { for (const id of entries.keys()) if (!ids.has(id)) remove(id); },
      clear() { for (const id of entries.keys()) remove(id); },
    };
  }
  function mergeHistoryEntries(saved, live) {
    const same = (a, b) => (a.entryId && a.entryId === b.entryId)
      || (a.role === b.role && a.text === b.text && a.sessionId === b.sessionId
        && Math.abs((a.at || 0) - (b.at || 0)) < 10_000);
    return saved.filter(entry => !live.some(other => same(entry, other))).concat(live)
      .sort((a, b) => (a.at || 0) - (b.at || 0));
  }
  return { createScopeLoader, mergeHistoryEntries };
});
