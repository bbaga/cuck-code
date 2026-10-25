'use strict';

const { CURRENT_STATUSES, STATUSES } = require('./work-claims');
const { readableBy } = require('./work-requests');
const { eventsAfter } = require('./work-merge');
const { randomUUID } = require('node:crypto');
const { ID_PATTERN } = require('./work-registry');
const { createWriteRoutes } = require('./registry-write');

const PAGE_SIZE_MAX = 100;
const PAGE_SIZE_DEFAULT = 20;
const Q_MAX = 200;
const CLAIM_TEXT = ['title', 'summary', 'tags', 'repo', 'branch', 'contract'];
const ARCHIVE_TEXT = ['title', 'summary', 'tags', 'repo'];
const REQUEST_TEXT = ['subject', 'text'];

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

// Parse an optional integer query parameter; reject anything outside [min, max].
function intParam(url, name, min, max, fallback) {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) {
    throw new HttpError(400, `${name} must be an integer from ${min} to ${max}`);
  }
  return n;
}

function paging(url) {
  return { page: intParam(url, 'page', 1, 1e6, 1), pageSize: intParam(url, 'pageSize', 1, PAGE_SIZE_MAX, PAGE_SIZE_DEFAULT) };
}

function query(url) { return (url.searchParams.get('q') || '').slice(0, Q_MAX).toLowerCase(); }

// Match q only against the named fields (strings, or arrays of strings).
function matches(item, q, fields) {
  if (!q) return true;
  return fields.some(f => {
    const v = item[f];
    const list = Array.isArray(v) ? v : [v];
    return list.some(x => typeof x === 'string' && x.toLowerCase().includes(q));
  });
}

function statusFilter(url) {
  const raw = url.searchParams.get('status');
  if (raw === null || raw === '') return new Set(CURRENT_STATUSES);
  if (raw === 'all') return null;
  const list = raw.split(',').map(s => s.trim());
  const bad = list.find(s => !STATUSES.includes(s));
  if (bad !== undefined) throw new HttpError(400, `Unknown status: ${bad}`);
  return new Set(list);
}

function createRegistryRoutes({ store, lineExists = () => false, lineName = () => null, unavailable = null, now = Date.now, newId = randomUUID, onOutbox, refresh = null, staleness = null }) {
  const writer = createWriteRoutes({ store, lineExists, now, newId, onOutbox });
  const down = () => (typeof unavailable === 'function' ? unavailable() : unavailable);
  const withOwner = item => {
    const name = lineName(item.ownerLineId);
    return { ...item, ownerLineName: name === undefined ? null : name, ownerExists: !!lineExists(item.ownerLineId) };
  };

  function listResponse(snapshot, all, { page, pageSize }) {
    const start = (page - 1) * pageSize;
    return {
      items: all.slice(start, start + pageSize), page, pageSize, total: all.length,
      hasMore: start + pageSize < all.length, snapshotRevision: snapshot.revision,
    };
  }

  function claimList(snapshot, url, source, fields, useStatus) {
    const paged = paging(url);
    const statuses = useStatus ? statusFilter(url) : null;
    const lineId = url.searchParams.get('lineId');
    const repo = url.searchParams.get('repo');
    const q = query(url);
    const all = source.filter(c => (!statuses || statuses.has(c.status))
      && (!lineId || c.ownerLineId === lineId) && (!repo || c.repo === repo) && matches(c, q, fields)).map(withOwner);
    return listResponse(snapshot, all, paged);
  }

  function requireLineId(url) {
    const lineId = url.searchParams.get('lineId');
    if (!lineId) throw new HttpError(400, 'lineId is required');
    return lineId;
  }

  function count(items, key) {
    const out = {};
    for (const item of items) { const k = String(item[key]); out[k] = (out[k] || 0) + 1; }
    return out;
  }

  // Read routes only; write routes are in registry-write.js.
  function dispatch(snapshot, method, url, parts) {
    if (method !== 'GET') throw new HttpError(404, 'Registry route not found');
    const [, , name, id] = parts;
    const rest = parts.length;
    if (name === 'claims' && rest === 3) return claimList(snapshot, url, snapshot.claims, CLAIM_TEXT, true);
    if (name === 'claims' && rest === 4) {
      const live = snapshot.claims.find(c => c.id === id);
      if (live) return withOwner(live);
      const old = snapshot.archive.find(c => c.id === id);
      if (old) return { ...withOwner(old), archived: true };
      throw new HttpError(404, 'Claim not found');
    }
    if (name === 'archive' && rest === 3) return claimList(snapshot, url, snapshot.archive, ARCHIVE_TEXT, false);
    if (name === 'requests' && rest === 3) {
      const paged = paging(url);
      const lineId = requireLineId(url);
      const state = url.searchParams.get('state');
      const q = query(url);
      const all = snapshot.requests.filter(r => readableBy(r, lineId) && (!state || r.state === state) && matches(r, q, REQUEST_TEXT));
      return listResponse(snapshot, all, paged);
    }
    if (name === 'requests' && rest === 4) {
      const lineId = requireLineId(url);
      const request = snapshot.requests.find(r => r.id === id);
      if (!request) throw new HttpError(404, 'Request not found');
      if (!readableBy(request, lineId)) throw new HttpError(403, 'Request is not readable by this line');
      return request;
    }
    if (name === 'events' && rest === 3) {
      const after = intParam(url, 'after', 0, Number.MAX_SAFE_INTEGER, 0);
      const limit = intParam(url, 'limit', 1, PAGE_SIZE_MAX, PAGE_SIZE_MAX);
      try { return { ...eventsAfter(snapshot, after, limit), snapshotRevision: snapshot.revision }; }
      catch (error) { if (error instanceof RangeError) throw new HttpError(400, error.message); throw error; }
    }
    if (name === 'summary' && rest === 3) {
      const owners = {}; const repos = {};
      for (const c of snapshot.claims) {
        owners[c.ownerLineId] = (owners[c.ownerLineId] || 0) + 1;
        repos[c.repo] = (repos[c.repo] || 0) + 1;
      }
      return {
        claimsByStatus: count(snapshot.claims, 'status'), claimsByOwner: owners, claimsByRepo: repos,
        requestsByState: count(snapshot.requests, 'state'), archiveCount: snapshot.archive.length,
        snapshotRevision: snapshot.revision,
      };
    }
    throw new HttpError(404, 'Registry route not found');
  }

  function handle(req, res, url, parts, json) {
    if (parts[0] !== 'api' || parts[1] !== 'registry') return false;
    const off = down();
    if (off || !store) {
      json(res, 503, { error: off?.error || 'Work registry unavailable', code: 'REGISTRY_UNAVAILABLE', file: off?.file || null });
      return true;
    }
    if (parts.slice(3).some(p => !ID_PATTERN.test(p))) { json(res, 404, { error: 'Registry route not found' }); return true; }
    const refreshing = (refresh && refresh.route(req, parts)) || (staleness && staleness.route(req, parts));
    if (refreshing) {
      refreshing.then(out => json(res, out.status, out.body));
      return true;
    }
    if (req.method !== 'GET') {
      writer.handle(req, parts).then(out => json(res, out.status, out.body));
      return true;
    }
    store.readSnapshot()
      .then(snapshot => json(res, 200, dispatch(snapshot, req.method, url, parts)))
      .catch(error => {
        if (error instanceof HttpError) return json(res, error.status, { error: error.message, ...error.extra });
        if (error && error.code === 'REGISTRY_CORRUPT') {
          return json(res, 503, { error: 'Work registry is corrupt', code: 'REGISTRY_UNAVAILABLE', file: error.filePath || null });
        }
        return json(res, 500, { error: 'Registry read failed' });
      });
    return true;
  }

  return { handle, onLineDeleted: writer.onLineDeleted };
}

module.exports = { createRegistryRoutes };
