// Pure view-model helpers for Registry filters, details, events and breakdowns.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.registryUIExtra = factory();
})(typeof self !== "undefined" ? self : this, function () {
  const EVENTS_SHOWN = 20;
  const EVENTS_MAX = 50;
  const dash = (v) => (v == null || v === "" ? "-" : String(v));

  function detailsModel(it) {
    const m = it.mergeCheck || {};
    const e = it.mergeEvidence || {};
    const rows = [
      ["Commit", dash(it.commit)], ["Branch", dash(it.branch)], ["Contract", dash(it.contract)],
      ["Tags", Array.isArray(it.tags) && it.tags.length ? it.tags.join(", ") : "-"],
      ["Revision", dash(it.revision)], ["Created", dash(it.createdAt)], ["Updated", dash(it.updatedAt)],
      ["Confirmed", dash(it.confirmedAt)], ["Stale reason", dash(it.staleReason)], ["Stale at", dash(it.staleAt)],
      ["Branch checked", dash(it.branchCheckedAt)], ["Branch confirmed", dash(it.branchConfirmedAt)],
    ];
    if (it.archived) {
      rows.push(["Archived", "yes"], ["Merged at", dash(it.mergedAt)], ["Target branch", dash(e.targetBranch)],
        ["Strategy", dash(e.strategy)], ["Evidence checked", dash(e.checkedAt)]);
    } else {
      rows.push(["Merge verified", m.checkedAt ? (m.verified ? "yes" : "no") : "never checked"],
        ["Merge reason", dash(m.reason)], ["Merge error", dash(m.error)], ["Merge checked", dash(m.checkedAt)]);
    }
    return rows;
  }

  // Prepend newer events (newest first), drop duplicate ids, keep at most `cap`.
  function mergeEvents(current, incoming, cap = EVENTS_MAX) {
    const seen = new Set((current || []).map((e) => e.id));
    const fresh = [];
    for (const e of (incoming || []).slice().sort((a, b) => (b.cursor || 0) - (a.cursor || 0))) {
      if (e.id != null && seen.has(e.id)) continue;
      seen.add(e.id);
      fresh.push(e);
    }
    return fresh.concat(current || []).slice(0, cap);
  }
  const lastCursor = (events) => events.reduce((m, e) => Math.max(m, Number.isFinite(e.cursor) ? e.cursor : 0), 0);
  const eventRow = (e) => ({ time: dash(e.at), type: dash(e.type),
    subject: dash(e.title || e.claimId || e.requestId), reason: dash(e.reason) });

  const countList = (map, name) => Object.keys(map || {}).sort()
    .map((k) => name(k) + ": " + map[k]);
  function breakdown(sm, lines) {
    const names = {};
    for (const l of lines || []) names[l.id] = l.name || l.id;
    return { owners: countList(sm && sm.claimsByOwner, (k) => names[k] || k),
      repos: countList(sm && sm.claimsByRepo, (k) => k) };
  }
  const repoOptions = (sm) => Object.keys((sm && sm.claimsByRepo) || {}).sort();

  return { EVENTS_SHOWN, EVENTS_MAX, detailsModel, mergeEvents, lastCursor, eventRow, breakdown, repoOptions };
});
