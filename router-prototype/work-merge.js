'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const execFileAsync = promisify(execFile);
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const COMMIT = /^[0-9a-f]{40}$/i;

function stableId(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

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

async function verifyMerge({ repoPath, repositoryUrl, commit, targetBranch, strategy, pullRequest, checkPullRequest }) {
  if (!COMMIT.test(commit || '') || !/^[A-Za-z0-9._/-]+$/.test(targetBranch || '') || targetBranch.includes('..')) return { verified: false, reason: 'invalid_claim' };
  try {
    const expected = cleanRepoUrl(repositoryUrl);
    const actual = cleanRepoUrl(await git(repoPath, ['remote', 'get-url', 'origin']));
    if (expected !== actual) return { verified: false, reason: 'repository_mismatch' };
    const remote = await git(repoPath, ['ls-remote', '--symref', 'origin', 'HEAD']);
    const head = remote.match(/^ref:\s+refs\/heads\/([^\n]+)\s+HEAD$/m)?.[1];
    if (!head) return { verified: false, reason: 'default_branch_unknown' };
    if (targetBranch !== head) return { verified: false, reason: 'target_not_default_branch' };
    const target = `refs/remotes/origin/${targetBranch}`;
    await git(repoPath, ['fetch', '--no-tags', 'origin', `+refs/heads/${targetBranch}:${target}`]);
    if (strategy === 'merge') {
      await git(repoPath, ['merge-base', '--is-ancestor', commit, target]);
      return { verified: true, defaultBranch: head, targetBranch, strategy };
    }
    if (!['squash', 'rebase'].includes(strategy) || typeof checkPullRequest !== 'function') return { verified: false, reason: 'unsupported_strategy' };
    const evidence = await checkPullRequest({ repositoryUrl: expected, targetBranch, commit, pullRequest });
    if (!evidence || evidence.verified !== true || evidence.merged !== true || evidence.base !== targetBranch || !Number.isSafeInteger(evidence.number)) return { verified: false, reason: 'pull_request_unverified' };
    return { verified: true, defaultBranch: head, targetBranch, strategy, pullRequest: evidence.number };
  } catch (error) {
    return { verified: false, reason: 'check_failed', error: error.message };
  }
}

function transition(snapshot, captured, result, { now = Date.now(), dependentNoticeIds = [] } = {}) {
  const claim = snapshot.claims.find(item => item.id === captured.id);
  if (!claim || claim.revision !== captured.revision || claim.commit !== captured.commit) return { ok: false, reason: 'stale_claim' };
  if (!result || result.verified !== true) return { ok: false, reason: 'unverified' };
  const timestamp = new Date(now).toISOString();
  const archived = { ...claim, mergedAt: timestamp, mergeEvidence: result };
  const eventId = stableId(`${claim.id}:${captured.revision}:${captured.commit}:merged`);
  const event = { id: eventId, cursor: snapshot.eventCursor + 1, type: 'claim.merged', claimId: claim.id, claimRevision: claim.revision, commit: claim.commit, at: timestamp };
  const notices = [...new Set(dependentNoticeIds)].map(id => ({ id, eventId }));
  return { ok: true, snapshot: {
    ...snapshot, claims: snapshot.claims.filter(item => item.id !== claim.id),
    archive: [...snapshot.archive, archived].filter(item => Date.parse(item.mergedAt || item.archivedAt || item.createdAt) >= now - RETENTION_MS),
    events: [...snapshot.events, event].filter(item => Date.parse(item.at) >= now - RETENTION_MS),
    outbox: [...snapshot.outbox, ...notices], eventCursor: event.cursor
  } };
}

function captureClaim(snapshot, id) {
  const claim = snapshot.claims.find(item => item.id === id);
  return claim ? { id: claim.id, revision: claim.revision, commit: claim.commit } : null;
}

async function reconcile(store, claimId, options) {
  const snapshot = await store.readSnapshot();
  const captured = captureClaim(snapshot, claimId);
  if (!captured) return { ok: false, reason: 'claim_not_found' };
  const result = await verifyMerge({ ...options, commit: captured.commit });
  const proposed = transition(snapshot, captured, result, options);
  if (!proposed.ok) return proposed;
  return store.transact(snapshot.revision, next => {
    const final = transition(next, captured, result, options);
    if (!final.ok) throw new Error(final.reason);
    Object.assign(next, final.snapshot);
    return { eventId: stableId(`${captured.id}:${captured.revision}:${captured.commit}:merged`) };
  });
}

module.exports = { RETENTION_MS, captureClaim, cleanRepoUrl, stableId, transition, verifyMerge, reconcile };
