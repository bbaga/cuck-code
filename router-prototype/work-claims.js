'use strict';

// Pure claim lifecycle rules. No IO; callers pass `now` as epoch ms.
const { ID_PATTERN } = require('./work-registry');

const DAY_MS = 24 * 60 * 60 * 1000;
const STATUSES = ['planned', 'active', 'available', 'superseded', 'stale', 'merged'];
const OWNER_STATUSES = ['planned', 'active', 'available', 'superseded'];
const ROUTER_STATUSES = ['stale', 'merged'];
const CURRENT_STATUSES = ['planned', 'active', 'available'];
const STALE_AGE_MS = 14 * DAY_MS;
const BRANCH_GRACE_MS = DAY_MS;
const TOMBSTONE_RETENTION_MS = 30 * DAY_MS;

const NEW_FIELDS = ['title', 'summary', 'tags', 'repo', 'branch', 'commit', 'contract', 'status'];
const PATCH_FIELDS = ['title', 'summary', 'tags', 'contract', 'branch', 'commit', 'status'];
const SERVER_FIELDS = ['ownerLineId', 'id', 'revision'];

const fail = (status, code, message) => ({ ok: false, status, code, message });
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function text(value, name, min, max) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    return fail(400, 'INVALID_FIELD', `${name} must be a string of ${min} to ${max} characters`);
  }
  return null;
}

const VALIDATORS = {
  title: v => text(v, 'title', 1, 200),
  summary: v => text(v, 'summary', 0, 2000),
  contract: v => text(v, 'contract', 0, 4000),
  repo: v => text(v, 'repo', 1, 200),
  branch: v => text(v, 'branch', 1, 200)
    || (/\s/.test(v) || v.includes('..') ? fail(400, 'INVALID_FIELD', 'branch must have no whitespace and no ".."') : null),
  commit: v => (typeof v === 'string' && /^[0-9a-f]{40}$/.test(v) ? null : fail(400, 'INVALID_FIELD', 'commit must be 40 lowercase hex characters')),
  tags: v => {
    if (!Array.isArray(v) || v.length > 20) return fail(400, 'INVALID_FIELD', 'tags must be an array of at most 20 strings');
    for (const t of v) { const e = text(t, 'tag', 1, 40); if (e) return e; }
    return null;
  }
};

const normalize = (name, v) => (name === 'tags' ? [...new Set(v.map(t => t.toLowerCase()))] : v);

function checkStatusValue(status) {
  if (status === 'stale' || status === 'merged') return fail(403, 'FORBIDDEN_STATUS', `Owners cannot set status "${status}"`);
  if (!OWNER_STATUSES.includes(status)) return fail(400, 'INVALID_STATUS', 'status is not valid');
  return null;
}

function validateNewClaim(input, ownerLineId, now) {
  if (!isObject(input)) return fail(400, 'INVALID_BODY', 'Claim must be an object');
  for (const k of SERVER_FIELDS) {
    if (has(input, k)) return fail(400, 'FORBIDDEN_FIELD', `${k} is set by the router`);
  }
  if (input.status === 'stale' || input.status === 'merged') {
    return fail(403, 'FORBIDDEN_STATUS', `Owners cannot set status "${input.status}"`);
  }
  for (const k of Object.keys(input)) {
    if (!NEW_FIELDS.includes(k)) return fail(400, 'UNKNOWN_FIELD', `Unknown field: ${k}`);
  }
  for (const k of ['title', 'repo', 'branch', 'commit']) {
    if (!has(input, k)) return fail(400, 'MISSING_FIELD', `${k} is required`);
  }
  const status = has(input, 'status') ? input.status : 'planned';
  const statusError = checkStatusValue(status);
  if (statusError) return statusError;
  if (status === 'superseded') return fail(400, 'INVALID_STATUS', 'A new claim cannot start as superseded');
  const claim = { summary: '', tags: [], contract: '' };
  for (const k of NEW_FIELDS) {
    if (k === 'status' || !has(input, k)) continue;
    const e = VALIDATORS[k](input[k]);
    if (e) return e;
    claim[k] = normalize(k, input[k]);
  }
  return { ok: true, claim: { ...claim, status, ownerLineId, createdAt: now, updatedAt: now, confirmedAt: now } };
}

function checkOwner(claim, actorLineId) {
  return claim.ownerLineId === actorLineId ? null : fail(403, 'NOT_OWNER', 'Only the owner line can change this claim');
}

const terminal = claim => (['superseded', 'merged'].includes(claim.status)
  ? fail(409, 'TERMINAL', `A ${claim.status} claim cannot change`) : null);

function applyOwnerPatch(claim, patch, actorLineId, now) {
  const early = checkOwner(claim, actorLineId) || terminal(claim);
  if (early) return early;
  if (!isObject(patch)) return fail(400, 'INVALID_BODY', 'Patch must be an object');
  for (const k of Object.keys(patch)) {
    if (!PATCH_FIELDS.includes(k)) return fail(400, 'UNKNOWN_FIELD', `Unknown field: ${k}`);
  }
  if (has(patch, 'status')) {
    const e = checkStatusValue(patch.status);
    if (e) return e;
  }
  if (claim.status === 'stale' && (Object.keys(patch).length !== 1 || patch.status !== 'superseded')) {
    return fail(409, 'STALE_CLAIM', 'A stale claim can only be renewed or superseded');
  }
  const next = { ...claim };
  for (const k of Object.keys(patch)) {
    if (k === 'status') continue;
    const e = VALIDATORS[k](patch[k]);
    if (e) return e;
    next[k] = normalize(k, patch[k]);
  }
  if (has(patch, 'status')) next.status = patch.status;
  if (next.branch !== claim.branch || next.commit !== claim.commit) {
    delete next.branchConfirmedAt;
    delete next.branchCheckedAt;
    next.branchChangedAt = now;
  }
  next.updatedAt = now;
  return { ok: true, claim: next };
}

function renewClaim(claim, actorLineId, now, { status } = {}) {
  const early = checkOwner(claim, actorLineId) || terminal(claim);
  if (early) return early;
  if (status !== undefined && !CURRENT_STATUSES.includes(status)) {
    return fail(400, 'INVALID_STATUS', 'Renew status must be planned, active or available');
  }
  const next = { ...claim, status: status || (claim.status === 'stale' ? 'active' : claim.status), confirmedAt: now, updatedAt: now };
  delete next.staleReason;
  delete next.staleAt;
  return { ok: true, claim: next };
}

function supersedeClaim(claim, actorLineId, now, { byClaimId } = {}) {
  const early = checkOwner(claim, actorLineId) || terminal(claim);
  if (early) return early;
  if (byClaimId !== undefined && (typeof byClaimId !== 'string' || !ID_PATTERN.test(byClaimId))) {
    return fail(400, 'INVALID_ID', 'byClaimId is not a valid ID');
  }
  const next = { ...claim, status: 'superseded', updatedAt: now };
  if (byClaimId !== undefined) next.supersededBy = byClaimId;
  return { ok: true, claim: next };
}

function evaluateStaleness(claim, { now, ownerExists, branchConfirmedAt, branchCheckedAt } = {}) {
  if (!CURRENT_STATUSES.includes(claim.status)) return { stale: false };
  if (ownerExists === false) return { stale: true, reason: 'owner-gone' };
  const checked = typeof branchCheckedAt === 'number';
  const confirmed = typeof branchConfirmedAt === 'number';
  const since = claim.branchChangedAt ?? claim.createdAt;
  if (checked && !confirmed && now - since > BRANCH_GRACE_MS) return { stale: true, reason: 'branch-missing' };
  if (now - claim.confirmedAt > STALE_AGE_MS) return { stale: true, reason: 'age' };
  return { stale: false };
}

function markStale(claim, reason, now) {
  return {
    claim: { ...claim, status: 'stale', staleReason: reason, staleAt: now, updatedAt: now },
    event: { type: 'claim.stale', claimId: claim.id, ownerLineId: claim.ownerLineId, reason, at: now }
  };
}

function retireClaim(claim, reason, now) {
  if (claim.status === 'merged') return fail(409, 'MERGED_CLAIM', 'Merged claims are archived, not retired');
  return {
    ok: true,
    tombstone: { claimId: claim.id, ownerLineId: claim.ownerLineId, title: claim.title, status: claim.status, reason, retiredAt: now },
    event: { type: 'claim.retired', claimId: claim.id, ownerLineId: claim.ownerLineId, reason, at: now }
  };
}

function purgeTombstones(tombstones, now) {
  return tombstones.filter(t => now - t.retiredAt <= TOMBSTONE_RETENTION_MS);
}

function onLineDeleted({ claims = [], requests = [] }, lineId, now) {
  const claimUpdates = [];
  const requestUpdates = [];
  const events = [];
  for (const claim of claims) {
    if (claim.ownerLineId !== lineId || !CURRENT_STATUSES.includes(claim.status)) continue;
    const marked = markStale(claim, 'owner-gone', now);
    claimUpdates.push(marked.claim);
    events.push(marked.event);
  }
  for (const request of requests) {
    if (!['open', 'accepted'].includes(request.state)) continue;
    if (request.sourceLineId !== lineId && request.targetLineId !== lineId) continue;
    requestUpdates.push({ ...request, orphaned: true, orphanedAt: now });
    events.push({ type: 'request.orphaned', requestId: request.id, lineId, at: now });
  }
  return { claimUpdates, requestUpdates, events };
}

module.exports = {
  STATUSES, OWNER_STATUSES, ROUTER_STATUSES, CURRENT_STATUSES,
  STALE_AGE_MS, BRANCH_GRACE_MS, TOMBSTONE_RETENTION_MS,
  validateNewClaim, applyOwnerPatch, renewClaim, supersedeClaim,
  evaluateStaleness, markStale, retireClaim, purgeTombstones, onLineDeleted
};
