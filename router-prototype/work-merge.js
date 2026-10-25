'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { lookupIdempotent, rememberIdempotent } = require('./work-registry');
const execFileAsync = promisify(execFile);
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PAGE_MAX = 100;
const COMMIT = /^[0-9a-f]{40}$/i;

const stableId = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
const iso = now => new Date(now).toISOString();

function cleanRepoUrl(value) {
  if (typeof value !== 'string') throw new TypeError('Repository URL is required');
  const url = value.startsWith('git@github.com:')
    ? `https://github.com/${value.slice('git@github.com:'.length)}` : value;
  let parsed;
  try { parsed = new URL(url); } catch { throw new TypeError('Invalid repository URL'); }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.search || parsed.hash || parsed.username || parsed.password) throw new TypeError('Untrusted repository URL');
  const parts = parsed.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_.-]+$/.test(part))) throw new TypeError('Invalid repository URL');
  return `https://github.com/${parts.join('/')}.git`;
}

async function git(repoPath, args) {
  return (await execFileAsync('git', ['-C', repoPath, ...args], { timeout: 15000, maxBuffer: 1024 * 1024 })).stdout.trim();
}

// Never throws. Returns verified evidence or { verified:false, reason, error, checkedAt }.
async function verifyMerge({ repoPath, repositoryUrl, commit, targetBranch, strategy = 'merge', pullRequest, checkPullRequest, gitCommand = git, now = Date.now() } = {}) {
  const checkedAt = iso(now);
  const fail = (reason, error = null) => ({ verified: false, reason, error, checkedAt });
  if (!COMMIT.test(commit || '') || !/^[A-Za-z0-9._/-]+$/.test(targetBranch || '') || targetBranch.includes('..')) return fail('invalid_claim');
  try {
    const expected = cleanRepoUrl(repositoryUrl);
    const actual = cleanRepoUrl(await gitCommand(repoPath, ['remote', 'get-url', 'origin']));
    if (expected !== actual) return fail('repository_mismatch');
    const remote = await gitCommand(repoPath, ['ls-remote', '--symref', 'origin', 'HEAD']);
    const head = remote.match(/^ref:\s+refs\/heads\/([^\n]+)\s+HEAD$/m)?.[1];
    if (!head) return fail('default_branch_unknown');
    if (targetBranch !== head) return fail('target_not_default_branch');
    const target = `refs/remotes/origin/${targetBranch}`;
    await gitCommand(repoPath, ['fetch', '--no-tags', 'origin', `+refs/heads/${targetBranch}:${target}`]);
    const base = { verified: true, repositoryUrl: expected, targetBranch, defaultBranch: head, commit, strategy, checkedAt };
    if (strategy === 'merge') {
      try { await gitCommand(repoPath, ['merge-base', '--is-ancestor', commit, target]); }
      catch (error) {
        // Exit code 1 means "not an ancestor"; any other failure is a check error.
        if (error.code === 1) return fail('commit_not_reachable');
        throw error;
      }
      return { ...base, pullRequest: null };
    }
    if (!['squash', 'rebase'].includes(strategy) || typeof checkPullRequest !== 'function') return fail('unsupported_strategy');
    const pr = await checkPullRequest({ repositoryUrl: expected, targetBranch, commit, pullRequest });
    if (!pr || pr.verified !== true || pr.merged !== true || pr.base !== targetBranch || pr.repositoryUrl !== expected || pr.commit !== commit || !Number.isSafeInteger(pr.number)) return fail('pull_request_unverified');
    return { ...base, pullRequest: pr.number };
  } catch (error) {
    return fail('check_failed', error.message);
  }
}

function captureClaim(snapshot, id) {
  const claim = snapshot.claims.find(item => item.id === id);
  return claim ? { id: claim.id, revision: claim.revision, commit: claim.commit } : null;
}

const matches = (claim, captured) => Boolean(claim) && claim.revision === captured.revision && claim.commit === captured.commit;

// Records a failed check without bumping claim.revision (background check must not stale the owner).
function recordCheck(snapshot, captured, result, now = Date.now()) {
  const claim = snapshot.claims.find(item => item.id === captured.id);
  if (!matches(claim, captured)) return { ok: false, reason: 'stale_claim' };
  claim.mergeCheck = { verified: false, reason: result?.reason || 'unverified', error: result?.error ?? null, checkedAt: result?.checkedAt || iso(now) };
  claim.unverified = true;
  return { ok: true };
}

function applyMerge(snapshot, captured, evidence, now = Date.now()) {
  const claim = snapshot.claims.find(item => item.id === captured.id);
  const eventId = stableId(`${captured.id}:${captured.revision}:${captured.commit}:merged`);
  const key = `${captured.id}:${captured.revision}:${captured.commit}`;
  if (lookupIdempotent(snapshot, 'merge', key, eventId).hit || snapshot.events.some(item => item.id === eventId)) return { ok: true, duplicate: true, eventId };
  if (!matches(claim, captured)) return { ok: false, reason: 'stale_claim' };
  if (!evidence || evidence.verified !== true) return { ok: false, reason: 'unverified' };
  if (evidence.commit !== claim.commit) return { ok: false, reason: 'commit_mismatch' };
  const at = iso(now);
  const cursor = snapshot.eventCursor + 1;
  snapshot.claims = snapshot.claims.filter(item => item.id !== claim.id);
  snapshot.archive.push({ ...claim, status: 'merged', mergedAt: at, mergeEvidence: evidence });
  snapshot.events.push({ id: eventId, cursor, type: 'claim.merged', claimId: claim.id, ownerLineId: claim.ownerLineId, claimRevision: claim.revision, commit: claim.commit, title: claim.title, at });
  snapshot.eventCursor = cursor;
  const lines = new Set();
  for (const request of snapshot.requests.filter(item => item.claimId === claim.id)) {
    lines.add(request.sourceLineId);
    lines.add(request.targetLineId);
  }
  lines.delete(claim.ownerLineId);
  lines.delete(undefined);
  for (const lineId of lines) {
    snapshot.outbox.push({ noticeId: `${eventId}:${lineId}`, type: 'claim.merged', recipientLineId: lineId, claimId: claim.id, eventId, title: claim.title, createdAt: at });
  }
  rememberIdempotent(snapshot, 'merge', key, eventId, { eventId });
  return { ok: true, eventId };
}

function purgeExpired(snapshot, now = Date.now()) {
  const cutoff = now - RETENTION_MS;
  const keep = field => item => Date.parse(item[field]) >= cutoff;
  const archive = snapshot.archive.length;
  const events = snapshot.events.length;
  snapshot.archive = snapshot.archive.filter(keep('mergedAt'));
  snapshot.events = snapshot.events.filter(keep('at'));
  return { archive: archive - snapshot.archive.length, events: events - snapshot.events.length };
}

function eventsAfter(snapshot, cursor = 0, limit = PAGE_MAX) {
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new RangeError('cursor must be a non-negative integer');
  const size = Math.min(Number.isSafeInteger(limit) && limit > 0 ? limit : PAGE_MAX, PAGE_MAX);
  const oldest = snapshot.events.length ? snapshot.events[0].cursor : snapshot.eventCursor + 1;
  const tooOld = cursor < oldest - 1;
  const rest = snapshot.events.filter(item => item.cursor > cursor);
  const items = rest.slice(0, size);
  return { items, nextCursor: items.length ? items[items.length - 1].cursor : cursor, hasMore: rest.length > items.length, tooOld };
}

class Refusal extends Error {
  constructor(result) { super(result.reason); this.result = result; }
}

async function reconcile(store, claimId, options = {}) {
  const attempts = Number.isSafeInteger(options.maxAttempts) && options.maxAttempts > 0 ? options.maxAttempts : 3;
  try {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const snapshot = await store.readSnapshot();
      const captured = captureClaim(snapshot, claimId);
      if (!captured) {
        const done = snapshot.archive.find(item => item.id === claimId && item.status === 'merged');
        return done ? { ok: true, merged: false, reason: 'already_merged' } : { ok: false, reason: 'claim_not_found' };
      }
      const now = options.now ?? Date.now();
      const evidence = await verifyMerge({ ...options, commit: captured.commit, now });
      const outcome = await store.transact(snapshot.revision, next => {
        const applied = evidence.verified ? applyMerge(next, captured, evidence, now) : recordCheck(next, captured, evidence, now);
        if (!applied.ok) throw new Refusal(applied);
        return applied;
      }).catch(error => { if (error instanceof Refusal) return { refused: error.result }; throw error; });
      if (outcome.stale) continue;
      if (outcome.refused) {
        if (outcome.refused.reason === 'stale_claim') continue;
        return { ok: false, reason: outcome.refused.reason };
      }
      if (!evidence.verified) return { ok: true, merged: false, reason: evidence.reason };
      return { ok: true, merged: true, eventId: outcome.result.eventId };
    }
    return { ok: false, reason: 'stale_snapshot' };
  } catch (error) {
    return { ok: false, reason: 'store_error', error: error.message };
  }
}

module.exports = { RETENTION_MS, captureClaim, cleanRepoUrl, stableId, verifyMerge, recordCheck, applyMerge, purgeExpired, eventsAfter, reconcile };
