'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const VERSION = 1;
const PAGE_SIZE_MAX = 100;
const TITLE_MAX = 200;
const SUMMARY_MAX = 2000;
const TAG_MAX = 40;
const EMPTY = () => ({ version: VERSION, revision: 0, claims: [], requests: [], archive: [], events: [], outbox: [], eventCursor: 0 });
const queues = new Map();

function validate(snapshot) {
  if (!snapshot || snapshot.version !== VERSION || !Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0 ||
      !Array.isArray(snapshot.claims) || !Array.isArray(snapshot.requests) || !Array.isArray(snapshot.archive) ||
      !Array.isArray(snapshot.events) || !Array.isArray(snapshot.outbox) || !Number.isSafeInteger(snapshot.eventCursor)) {
    throw new Error('Invalid work registry snapshot');
  }
  return snapshot;
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

function createStore(filePath) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('filePath is required');
  let state;
  const key = path.resolve(filePath);
  if (!queues.has(key)) queues.set(key, Promise.resolve());
  async function load() {
    if (state) return;
    try { state = validate(JSON.parse(await fs.readFile(filePath, 'utf8'))); }
    catch (error) {
      if (error.code === 'ENOENT') { state = EMPTY(); return; }
      throw new Error(`Cannot load work registry at ${filePath}: ${error.message}`, { cause: error });
    }
  }
  async function readSnapshot() {
    await load();
    return structuredClone(state);
  }
  function transact(expectedSnapshotRevision, mutation) {
    const queue = queues.get(key);
    const operation = queue.then(async () => {
      await load();
      try { state = validate(JSON.parse(await fs.readFile(filePath, 'utf8'))); }
      catch (error) {
        if (error.code !== 'ENOENT') throw new Error(`Cannot load work registry at ${filePath}: ${error.message}`, { cause: error });
      }
      if (expectedSnapshotRevision !== state.revision) return { ok: false, stale: true, revision: state.revision };
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
      return { ok: true, revision: state.revision, result };
    });
    queues.set(key, operation.catch(() => {}));
    return operation;
  }
  async function createClaim(expectedRevision, input) {
    const claim = cleanClaim(input);
    const id = input.id || randomUUID();
    return transact(expectedRevision, snapshot => {
      if (snapshot.claims.some(item => item.id === id)) throw new Error(`Claim already exists: ${id}`);
      const item = { ...claim, id, revision: 1, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      snapshot.claims.push(item);
      return structuredClone(item);
    });
  }
  async function updateClaim(expectedRevision, id, expectedClaimRevision, patch) {
    const changes = cleanClaim(patch);
    return transact(expectedRevision, snapshot => {
      const item = snapshot.claims.find(entry => entry.id === id);
      if (!item) throw new Error(`Claim not found: ${id}`);
      if (item.revision !== expectedClaimRevision) throw new Error(`Stale claim revision: ${item.revision}`);
      Object.assign(item, changes, { revision: item.revision + 1, updatedAt: new Date().toISOString() });
      return structuredClone(item);
    });
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
  return { readSnapshot, transact, createClaim, updateClaim, listClaims, searchClaims };
}

module.exports = { createStore };
