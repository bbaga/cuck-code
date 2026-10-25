'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const VERSION = 1;
const PAGE_SIZE_MAX = 100;
const TITLE_MAX = 200;
const SUMMARY_MAX = 2000;
const TAG_MAX = 40;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const IDEMPOTENCY_MAX = 1000;
const EMPTY = () => ({ version: VERSION, revision: 0, claims: [], requests: [], archive: [], events: [], outbox: [], eventCursor: 0, tombstones: [], idempotency: [] });
const queues = new Map();

function storeError(message, code, status, extra = {}) {
  return Object.assign(new Error(message), { code, ...(status ? { status } : {}), ...extra });
}

function assertId(id) {
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) throw storeError('Invalid ID: use 1 to 64 letters, digits, "_" or "-"', 'INVALID_ID', 400);
  return id;
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isCount = value => Number.isSafeInteger(value) && value >= 0;

function validate(snapshot) {
  const fail = reason => { throw new Error(`Invalid work registry snapshot: ${reason}`); };
  if (!isObject(snapshot)) fail('not an object');
  if (snapshot.version !== VERSION) fail('unsupported version');
  if (!isCount(snapshot.revision)) fail('revision must be a non-negative integer');
  if (!isCount(snapshot.eventCursor)) fail('eventCursor must be a non-negative integer');
  for (const name of ['claims', 'requests', 'archive', 'events', 'outbox', 'tombstones', 'idempotency']) {
    if (!Array.isArray(snapshot[name])) fail(`${name} must be an array`);
    snapshot[name].forEach((item, index) => { if (!isObject(item)) fail(`${name}[${index}] must be an object`); });
  }
  for (const name of ['claims', 'requests', 'archive', 'events']) {
    snapshot[name].forEach((item, index) => { if (typeof item.id !== 'string') fail(`${name}[${index}].id must be a string`); });
  }
  for (const name of ['claims', 'requests']) {
    snapshot[name].forEach((item, index) => { if (!Number.isSafeInteger(item.revision) || item.revision < 1) fail(`${name}[${index}].revision must be an integer >= 1`); });
  }
  return snapshot;
}

function lookupIdempotent(snapshot, scope, key, fingerprint) {
  const entry = snapshot.idempotency.find(item => item.scope === scope && item.key === key);
  if (!entry) return { hit: false };
  if (entry.fingerprint !== fingerprint) return { conflict: true };
  return { hit: true, result: structuredClone(entry.result) };
}

function rememberIdempotent(snapshot, scope, key, fingerprint, result) {
  for (const [name, value] of [['scope', scope], ['key', key], ['fingerprint', fingerprint]]) {
    if (typeof value !== 'string' || !value) throw new TypeError(`Idempotency ${name} must be a non-empty string`);
  }
  snapshot.idempotency = snapshot.idempotency.filter(item => !(item.scope === scope && item.key === key));
  snapshot.idempotency.push({ scope, key, fingerprint, result: structuredClone(result ?? null) });
  if (snapshot.idempotency.length > IDEMPOTENCY_MAX) snapshot.idempotency.splice(0, snapshot.idempotency.length - IDEMPOTENCY_MAX);
}

function cleanClaim(input) {
  if (!input || typeof input !== 'object') throw new TypeError('Claim must be an object');
  const title = input.title;
  const summary = input.summary ?? '';
  const tags = input.tags ?? [];
  if (typeof title !== 'string' || !title.trim() || title.length > TITLE_MAX) throw new TypeError(`Title must contain 1 to ${TITLE_MAX} characters`);
  if (typeof summary !== 'string' || summary.length > SUMMARY_MAX) throw new TypeError(`Summary must contain at most ${SUMMARY_MAX} characters`);
  if (!Array.isArray(tags) || tags.length > 50 || tags.some(t => typeof t !== 'string' || !t.trim() || t.length > TAG_MAX)) throw new TypeError('Tags must be strings of bounded length');
  return { title: title.trim(), summary, tags: [...new Set(tags.map(t => t.trim()))] };
}

function createStore(filePath, { onCommit } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('filePath is required');
  let state;
  const listeners = onCommit ? [onCommit] : [];
  const key = path.resolve(filePath);
  if (!queues.has(key)) queues.set(key, Promise.resolve());
  async function readDisk() {
    try { return validate(JSON.parse(await fs.readFile(filePath, 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT') return EMPTY();
      throw storeError(`Cannot load work registry at ${filePath}: ${error.message}`, 'REGISTRY_CORRUPT', 500, { filePath, cause: error });
    }
  }
  async function load() {
    state = await readDisk();
    return structuredClone(state);
  }
  async function readSnapshot() {
    return load();
  }
  // expectedSnapshotRevision null skips the snapshot revision check. The mutation still runs
  // in the serialized queue on the freshly reloaded disk snapshot.
  function transact(expectedSnapshotRevision, mutation) {
    const queue = queues.get(key);
    const operation = queue.then(async () => {
      state = await readDisk();
      if (expectedSnapshotRevision !== null && expectedSnapshotRevision !== state.revision) return { ok: false, stale: true, revision: state.revision };
      if (typeof mutation !== 'function') throw new TypeError('mutation must be a function');
      const next = structuredClone(state);
      const result = await mutation(next);
      next.revision = state.revision + 1;
      validate(next);
      const dir = path.dirname(filePath);
      await fs.mkdir(dir, { recursive: true });
      const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
      let handle;
      try {
        handle = await fs.open(temp, 'wx');
        await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`);
        await handle.sync();
        await handle.close();
        handle = null;
        await fs.rename(temp, filePath);
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        await fs.unlink(temp).catch(() => {});
        throw new Error(`Cannot write work registry at ${filePath}: ${error.message}`, { cause: error });
      }
      state = next;
      for (const fn of listeners) {
        try { fn({ revision: next.revision, eventCursor: next.eventCursor }); } catch { /* a listener never affects the commit */ }
      }
      return { ok: true, revision: state.revision, result };
    });
    queues.set(key, operation.catch(() => {}));
    return operation;
  }
  async function createClaim(expectedRevision, input) {
    const claim = cleanClaim(input);
    const id = input.id === undefined ? randomUUID() : assertId(input.id);
    return transact(expectedRevision, snapshot => {
      if (snapshot.claims.some(item => item.id === id)) throw storeError(`Claim already exists: ${id}`, 'ALREADY_EXISTS', 409);
      const item = { ...claim, id, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      snapshot.claims.push(item);
      return structuredClone(item);
    });
  }
  async function updateClaim(expectedRevision, id, expectedClaimRevision, patch) {
    assertId(id);
    const changes = cleanClaim(patch);
    try {
      return await transact(expectedRevision, snapshot => {
        const item = snapshot.claims.find(entry => entry.id === id);
        if (!item) throw storeError(`Claim not found: ${id}`, 'NOT_FOUND', 404);
        if (item.revision !== expectedClaimRevision) throw storeError(`Stale claim revision: ${item.revision}`, 'STALE_REVISION', 409, { currentRevision: item.revision });
        Object.assign(item, changes, { revision: item.revision + 1, updatedAt: new Date().toISOString() });
        return structuredClone(item);
      });
    } catch (error) {
      // A stale claim revision is an expected conflict: return it and write nothing.
      if (error.code === 'STALE_REVISION') return { ok: false, conflict: true, currentRevision: error.currentRevision };
      throw error;
    }
  }
  async function listClaims({ page = 1, pageSize = 20 } = {}) {
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE_MAX) throw new RangeError('Invalid page or pageSize');
    const claims = (await readSnapshot()).claims;
    const start = (page - 1) * pageSize;
    return { items: claims.slice(start, start + pageSize), page, pageSize, total: claims.length, hasMore: start + pageSize < claims.length };
  }
  async function searchClaims(query, { page = 1, pageSize = 20 } = {}) {
    if (typeof query !== 'string' || query.length > 500) throw new TypeError('Search query must be a string of at most 500 characters');
    const needle = query.trim().toLocaleLowerCase();
    const claims = (await readSnapshot()).claims.filter(item => !needle || [item.title, item.summary, ...item.tags].some(value => value.toLocaleLowerCase().includes(needle)));
    if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > PAGE_SIZE_MAX) throw new RangeError('Invalid page or pageSize');
    const start = (page - 1) * pageSize;
    return { items: claims.slice(start, start + pageSize), page, pageSize, total: claims.length, hasMore: start + pageSize < claims.length };
  }
  function addCommitListener(fn) {
    if (typeof fn !== 'function') throw new TypeError('listener must be a function');
    listeners.push(fn);
  }
  return { load, readSnapshot, transact, onCommit: addCommitListener, createClaim, updateClaim, listClaims, searchClaims };
}

module.exports = { createStore, rememberIdempotent, lookupIdempotent, ID_PATTERN, IDEMPOTENCY_MAX };
