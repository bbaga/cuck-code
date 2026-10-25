"use strict";

const CLAIM_FIELDS = new Set(["repo", "branch", "commit", "title", "summary", "tags", "status"]);
const STATUSES = new Set(["active", "blocked", "merged", "released", "abandoned"]);
const PAGE_MAX = 100;
const TEXT_MAX = 2000;

function handleRegistryRoute(req, res, url, parts, deps) {
  const { getStore, lines, enqueue, json, readBody } = deps;
  let openRequest, transitionRequest;
  try { ({ openRequest, transitionRequest } = deps.getRequestRules ? deps.getRequestRules() : require("./work-requests")); }
  catch (error) { json(res, 500, { error: `Request rules unavailable: ${error.message}` }); return; }
  const store = getStore();
  const fail = error => json(res, error.status || (error.code === "INVALID_REQUEST" || error instanceof TypeError || error instanceof RangeError ? 400 : 500), { error: error.message, ...(error.currentRevision != null ? { currentRevision: error.currentRevision } : {}) });
  const body = fn => readBody(req, (error, data) => error ? json(res, 400, { error: error.message }) : Promise.resolve().then(() => fn(data)).catch(fail));
  const route = parts[2];
  Promise.resolve().then(async () => {
    const snapshot = await store.readSnapshot();
    if (req.method === "GET" && ["claims", "archive", "requests"].includes(route)) {
      const page = boundedInteger(url.searchParams.get("page"), 1, 1000000, 1);
      const pageSize = boundedInteger(url.searchParams.get("pageSize"), 1, PAGE_MAX, 20);
      let items = route === "claims" ? snapshot.claims : route === "archive" ? snapshot.archive : snapshot.requests;
      const lineId = url.searchParams.get("lineId"), status = url.searchParams.get("status");
      const q = (url.searchParams.get("q") || "").slice(0, 500).toLocaleLowerCase();
      items = items.filter(x => (!lineId || route === "requests" ? !lineId || x.sourceLineId === lineId || x.targetLineId === lineId : x.ownerLineId === lineId) && (!status || x.status === status) && (!q || JSON.stringify(x).toLocaleLowerCase().includes(q)));
      const start = (page - 1) * pageSize;
      return json(res, 200, { items: items.slice(start, start + pageSize), page, pageSize, total: items.length, hasMore: start + pageSize < items.length, snapshotRevision: snapshot.revision });
    }
    if (req.method === "GET" && route === "events") {
      const after = boundedInteger(url.searchParams.get("after"), 0, Number.MAX_SAFE_INTEGER, 0);
      const items = snapshot.events.filter(x => x.cursor > after).slice(0, 100);
      return json(res, 200, { items, nextCursor: items.length ? items.at(-1).cursor : after });
    }
    if (req.method === "POST" && route === "lines" && parts[3] && parts[4] === "claims") return body(data => claim(data, parts[3], null));
    if (req.method === "PATCH" && route === "lines" && parts[3] && parts[4] === "claims" && parts[5]) return body(data => claim(data, parts[3], parts[5]));
    if (req.method === "POST" && route === "lines" && parts[3] && parts[4] === "requests") return body(data => requestChange(data, parts[3], null));
    if (req.method === "PATCH" && route === "lines" && parts[3] && parts[4] === "requests" && parts[5]) return body(data => requestChange(data, parts[3], parts[5]));
    if (req.method === "POST" && route === "refresh") return body(data => refresh(data));
    return json(res, 404, { error: "Registry route not found" });
  }).catch(fail);
  function stale(result) { return json(res, result.stale ? 409 : 200, result.stale ? { error: "Stale snapshot revision", snapshotRevision: result.revision } : result.result); }
  async function claim(data, lineId, id) {
    if (!lines.has(lineId)) return json(res, 404, { error: "Line not found" });
    if (!Number.isSafeInteger(data.expectedSnapshotRevision)) throw new TypeError("expectedSnapshotRevision is required");
    if (id ? !validPatch(data.patch) || !Number.isSafeInteger(data.expectedRevision) : !validClaim(data.claim)) throw new TypeError("Invalid claim fields");
    const result = await store.transact(data.expectedSnapshotRevision, state => {
      const item = id ? state.claims.find(x => x.id === id && x.ownerLineId === lineId) : null;
      if (id && (!item || item.revision !== data.expectedRevision)) throw Object.assign(new Error(`Stale claim revision: ${item ? item.revision : "missing"}`), { status: 409, currentRevision: item && item.revision });
      if (item) Object.assign(item, data.patch, { revision: item.revision + 1, updatedAt: new Date().toISOString() });
      else { Object.assign(data.claim, { ownerLineId: lineId, revision: 1, status: data.claim.status || "active", updatedAt: new Date().toISOString() }); state.claims.push(data.claim); }
      return item || data.claim;
    });
    return stale(result);
  }
  async function requestChange(data, lineId, id) {
    if (!lines.has(lineId)) return json(res, 404, { error: "Line not found" });
    if (!Number.isSafeInteger(data.expectedSnapshotRevision)) throw new TypeError("expectedSnapshotRevision is required");
    const result = await store.transact(data.expectedSnapshotRevision, state => {
      if (!id) { const opened = openRequest({ ...data, existingRequests: state.requests }, lineId, key => lines.has(key)); if (!state.requests.some(x => x.id === opened.request.id)) state.requests.push(opened.request); state.outbox.push(...opened.effects); return opened.request; }
      const item = state.requests.find(x => x.id === id), changed = transitionRequest(item, data, lineId);
      Object.assign(item, changed.request); state.outbox.push(...changed.effects); return item;
    });
    if (result.stale) return stale(result);
    await deliverOutbox(store, lines, enqueue);
    return stale(result);
  }
  async function refresh(data) {
    if (!data || !data.evidence || typeof data.evidence.repoPath !== "string" || typeof data.evidence.repositoryUrl !== "string" || typeof data.evidence.targetBranch !== "string" || typeof data.evidence.strategy !== "string") throw new TypeError("Verified remote evidence fields are required");
    if (!Array.isArray(data.claimIds) || data.claimIds.length > 20) throw new TypeError("claimIds must contain at most 20 IDs");
    const merge = deps.getMerge ? deps.getMerge() : require("./work-merge");
    const results = [];
    for (const claimId of data.claimIds) {
      const snap = await store.readSnapshot(), item = snap.claims.find(x => x.id === claimId);
      if (!item) { results.push({ claimId, verified: false }); continue; }
      const evidence = await merge.verifyMerge({ ...data.evidence, commit: item.commit });
      if (!evidence.verified) { results.push({ claimId, verified: false }); continue; }
      const done = await store.transact(snap.revision, state => { const current = state.claims.find(x => x.id === claimId); if (!current || current.revision !== item.revision) return false; const transitioned = merge.transition(state, merge.captureClaim(state, claimId), evidence); if (!transitioned.ok) return false; Object.assign(state, transitioned.snapshot); return true; });
      results.push({ claimId, verified: !!done.result });
    }
    return json(res, 200, { results });
  }
}
function boundedInteger(raw, min, max, fallback) { if (raw == null) return fallback; const n = Number(raw); return Number.isSafeInteger(n) ? Math.min(max, Math.max(min, n)) : fallback; }
function validPatch(patch) { return !!patch && !Array.isArray(patch) && typeof patch === "object" && Object.keys(patch).length > 0 && Object.keys(patch).every(key => CLAIM_FIELDS.has(key)) && validClaim(patch, true); }
function validClaim(claim, partial = false) {
  if (!claim || Array.isArray(claim) || typeof claim !== "object" || Object.keys(claim).some(key => !CLAIM_FIELDS.has(key))) return false;
  if (claim.status != null && !STATUSES.has(claim.status)) return false;
  if (!partial && ["repo", "branch", "commit"].some(key => typeof claim[key] !== "string" || !claim[key].trim() || claim[key].length > 500)) return false;
  return ["title", "summary"].every(key => claim[key] == null || typeof claim[key] === "string" && claim[key].length <= TEXT_MAX) && (claim.tags == null || Array.isArray(claim.tags) && claim.tags.length <= 50 && claim.tags.every(tag => typeof tag === "string" && tag.length <= 40));
}
async function deliverOutbox(store, lines, send) {
  const snapshot = await store.readSnapshot();
  for (const notice of snapshot.outbox) {
    if (notice.deliveredAt || !notice.id || !notice.targetLineId) continue;
    const target = lines.get(notice.targetLineId);
    if (!target) continue;
    send(target, `WORK REQUEST NOTICE ${notice.id}: ${notice.type} ${notice.requestId}`);
    const saved = await store.transact(snapshot.revision, state => { const current = state.outbox.find(x => x.id === notice.id); if (current) current.deliveredAt = new Date().toISOString(); });
    if (saved.stale) return;
  }
}
module.exports = { handleRegistryRoute, validClaim, validPatch, boundedInteger, deliverOutbox };
