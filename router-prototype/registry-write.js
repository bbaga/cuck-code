'use strict';

// Registry write routes. All rules live in work-claims.js and work-requests.js;
// this module reads the body, runs one transaction and maps the result to HTTP.
const { lookupIdempotent, rememberIdempotent } = require('./work-registry');
const claimRules = require('./work-claims');
const requestRules = require('./work-requests');

const BODY_MAX = 64 * 1024;

// Thrown inside a mutation to abort the transaction without a write.
class Abort extends Error {
  constructor(status, body) { super(body.error || 'abort'); this.status = status; this.body = body; }
}

const ruleBody = r => ({ error: r.message, code: r.code, ...(r.currentRevision !== undefined ? { currentRevision: r.currentRevision } : {}) });
const abortRule = r => { throw new Abort(r.status, ruleBody(r)); };
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', chunk => {
      if (failed) return;
      size += chunk.length;
      if (size > BODY_MAX) { failed = true; chunks.length = 0; reject(new Abort(400, { error: 'Body is larger than 64 KB', code: 'BODY_TOO_LARGE' })); return; }
      chunks.push(chunk);
    });
    req.on('error', () => { if (!failed) { failed = true; reject(new Abort(400, { error: 'Cannot read body', code: 'INVALID_JSON' })); } });
    req.on('end', () => {
      if (failed) return;
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null');
        if (!isObject(body)) throw new Error('not an object');
        resolve(body);
      } catch { reject(new Abort(400, { error: 'Body must be a JSON object', code: 'INVALID_JSON' })); }
    });
  });
}

function createWriteRoutes({ store, lineExists, now, newId, onOutbox = () => {} }) {
  const eventId = () => newId();

  // Append a rule event with a unique id and the next cursor.
  function appendEvent(snapshot, event) {
    const item = { ...event, id: eventId(), cursor: ++snapshot.eventCursor };
    snapshot.events.push(item);
    return item;
  }

  // Run mutation(draft) in a serialized transaction. Item-level revisions guard the writes,
  // so the snapshot revision check is skipped (null).
  const run = mutation => store.transact(null, mutation);
  // Run a mutation that appends outbox entries, then ask for delivery (not awaited).
  const runNotifying = async mutation => {
    const out = await run(mutation);
    try { onOutbox(); } catch (error) { console.error(`registry delivery trigger failed: ${error && error.message}`); }
    return out;
  };

  const findClaim = (snapshot, id) => {
    const claim = snapshot.claims.find(c => c.id === id);
    if (!claim) throw new Abort(404, { error: 'Claim not found', code: 'NOT_FOUND' });
    return claim;
  };

  function checkExpected(body, item) {
    if (!Number.isSafeInteger(body.expectedRevision)) {
      throw new Abort(400, { error: 'expectedRevision must be an integer', code: 'INVALID_FIELD' });
    }
    if (body.expectedRevision !== item.revision) {
      throw new Abort(409, { error: 'Item changed; read it again', code: 'STALE_REVISION', currentRevision: item.revision });
    }
  }

  function checkKey(key) {
    if (key !== undefined && (typeof key !== 'string' || key.length < 1 || key.length > 128)) {
      throw new Abort(400, { error: 'idempotencyKey must be a string of 1 to 128 characters', code: 'INVALID_FIELD' });
    }
  }

  const stableFingerprint = o => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k]]));

  function replaceById(list, item) { list[list.findIndex(x => x.id === item.id)] = item; }

  // Update a live claim through a rule function and bump its revision.
  const claimUpdate = (lineId, claimId, body, apply) => run(snapshot => {
    const claim = findClaim(snapshot, claimId);
    const { expectedRevision, ...rest } = body;
    const r = apply(claim, rest);
    if (!r.ok) abortRule(r);
    checkExpected(body, claim);
    const next = { ...r.claim, revision: claim.revision + 1 };
    replaceById(snapshot.claims, next);
    return { status: 200, body: { claim: next, snapshotRevision: snapshot.revision + 1 } };
  });

  const routes = {
    createClaim: (lineId, body) => run(snapshot => {
      const { idempotencyKey, ...input } = body;
      checkKey(idempotencyKey);
      const scope = `claim:${lineId}`;
      const fingerprint = stableFingerprint(input);
      if (idempotencyKey !== undefined) {
        const found = lookupIdempotent(snapshot, scope, idempotencyKey, fingerprint);
        if (found.conflict) throw new Abort(409, { error: 'This idempotencyKey was used with a different claim', code: 'IDEMPOTENCY_CONFLICT' });
        if (found.hit) {
          const stored = snapshot.claims.find(c => c.id === found.result.claimId) || snapshot.archive.find(c => c.id === found.result.claimId);
          if (!stored) throw new Abort(404, { error: 'Stored claim for this idempotencyKey was not found', code: 'NOT_FOUND' });
          throw new Abort(200, { claim: stored, snapshotRevision: snapshot.revision });
        }
      }
      const r = claimRules.validateNewClaim(input, lineId, now());
      if (!r.ok) abortRule(r);
      const claim = { ...r.claim, id: newId(), revision: 1 };
      snapshot.claims.push(claim);
      if (idempotencyKey !== undefined) rememberIdempotent(snapshot, scope, idempotencyKey, fingerprint, { claimId: claim.id });
      return { status: 201, body: { claim, snapshotRevision: snapshot.revision + 1 } };
    }),
    patchClaim: (lineId, claimId, body) => claimUpdate(lineId, claimId, body,
      (claim, patch) => claimRules.applyOwnerPatch(claim, patch, lineId, now())),
    renewClaim: (lineId, claimId, body) => claimUpdate(lineId, claimId, body,
      (claim, rest) => claimRules.renewClaim(claim, lineId, now(), rest)),
    supersedeClaim: (lineId, claimId, body) => claimUpdate(lineId, claimId, body,
      (claim, rest) => claimRules.supersedeClaim(claim, lineId, now(), rest)),
    openRequest: (lineId, body) => runNotifying(snapshot => {
      const t = now();
      const r = requestRules.openRequest(body, lineId, { snapshot, lineExists, now: t, newId });
      if (!r.ok) abortRule(r);
      if (r.replay) throw new Abort(200, { request: r.request, snapshotRevision: snapshot.revision });
      snapshot.requests.push(r.request);
      rememberIdempotent(snapshot, r.idempotency.scope, r.idempotency.key, r.idempotency.fingerprint, r.idempotency.result);
      for (const notice of r.effects) snapshot.outbox.push({ ...notice, createdAt: t, deliveredAt: null });
      return { status: 201, body: { request: r.request, snapshotRevision: snapshot.revision + 1 } };
    }),
    transitionRequest: (lineId, requestId, body) => runNotifying(snapshot => {
      const request = snapshot.requests.find(r => r.id === requestId);
      if (!request) throw new Abort(404, { error: 'Request not found', code: 'NOT_FOUND' });
      const t = now();
      const r = requestRules.transitionRequest(request, body, lineId, { now: t });
      if (!r.ok) abortRule(r);
      replaceById(snapshot.requests, r.request);
      for (const notice of r.effects) snapshot.outbox.push({ ...notice, createdAt: t, deliveredAt: null });
      return { status: 200, body: { request: r.request, snapshotRevision: snapshot.revision + 1 } };
    })
  };

  // Match a write route; returns a function (body) => Promise<{status, body}> or null.
  function match(method, parts) {
    const [, , scope, lineId, name, id, action] = parts;
    if (scope !== 'lines' || !lineId) return null;
    const n = parts.length;
    if (method === 'POST' && name === 'claims' && n === 5) return b => routes.createClaim(lineId, b);
    if (method === 'PATCH' && name === 'claims' && n === 6) return b => routes.patchClaim(lineId, id, b);
    if (method === 'POST' && name === 'claims' && n === 7 && action === 'renew') return b => routes.renewClaim(lineId, id, b);
    if (method === 'POST' && name === 'claims' && n === 7 && action === 'supersede') return b => routes.supersedeClaim(lineId, id, b);
    if (method === 'POST' && name === 'requests' && n === 5) return b => routes.openRequest(lineId, b);
    if (method === 'PATCH' && name === 'requests' && n === 6) return b => routes.transitionRequest(lineId, id, b);
    return null;
  }

  // Resolve to { status, body }. Never throws and never returns a stack trace.
  async function handle(req, parts) {
    const op = match(req.method, parts);
    if (!op) return { status: 404, body: { error: 'Registry route not found' } };
    if (!lineExists(parts[3])) return { status: 404, body: { error: 'Line does not exist', code: 'UNKNOWN_LINE' } };
    try {
      const body = await readJson(req);
      const out = await op(body);
      return out.result || out;
    } catch (error) {
      if (error instanceof Abort) return { status: error.status, body: error.body };
      if (error && error.code === 'REGISTRY_CORRUPT') {
        return { status: 503, body: { error: 'Work registry is corrupt', code: 'REGISTRY_UNAVAILABLE', file: error.filePath || null } };
      }
      console.error(`registry write failed: ${error && error.message}`);
      return { status: 500, body: { error: 'Registry write failed' } };
    }
  }

  // Apply the line-deletion rules in one transaction. Safe to run twice.
  async function onLineDeleted(lineId) {
    await run(snapshot => {
      const t = now();
      const open = snapshot.requests.filter(r => !r.orphaned);
      const u = claimRules.onLineDeleted({ claims: snapshot.claims, requests: open }, lineId, t);
      for (const c of u.claimUpdates) replaceById(snapshot.claims, { ...c, revision: c.revision + 1 });
      for (const r of u.requestUpdates) replaceById(snapshot.requests, { ...r, revision: r.revision + 1 });
      if (!u.events.length) throw new Abort(200, {});
      for (const e of u.events) appendEvent(snapshot, e);
    }).catch(error => { if (!(error instanceof Abort && error.status === 200)) throw error; });
    try { onOutbox(); } catch (error) { console.error(`registry delivery trigger failed: ${error && error.message}`); }
  }

  return { handle, onLineDeleted, appendEvent };
}

module.exports = { createWriteRoutes, BODY_MAX };
