'use strict';

// Merge refresh: verifies claims against the remote default branch of the owner's
// registered repository. The repository comes from the line, never from the caller.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { cleanRepoUrl, reconcile, recordCheck, captureClaim, purgeExpired } = require('./work-merge');
const { repoIdentity } = require('./line-repos');
const execFileAsync = promisify(execFile);

const BODY_MAX = 64 * 1024;
const FORBIDDEN = ['repoPath', 'repositoryUrl', 'targetBranch', 'strategy'];
const DEFAULT_LIMITS = { maxClaims: 20, recheckMs: 30 * 60 * 1000, gitTimeoutMs: 15000, ghTimeoutMs: 20000 };
const SWEEP_STATUSES = new Set(['active', 'available']);

const iso = ms => new Date(ms).toISOString();
const errorText = error => String(error && error.message !== undefined ? error.message : error);

function safeClean(url) {
  try { return cleanRepoUrl(url); } catch { return null; }
}

// repos: the owner line's registered repos [{ name, path, url }]. claimRepo is the
// stored repository identity (or a repo name on older claims).
// Returns { repoPath, repositoryUrl } or null.
function matchRepo(repos, claimRepo) {
  const wanted = safeClean(claimRepo);
  const identity = repoIdentity(claimRepo);
  const hit = (repos || []).find(r => r && (r.name === claimRepo
    || (wanted && safeClean(r.url) === wanted) || (identity && repoIdentity(r.url) === identity)));
  const repositoryUrl = hit && (safeClean(hit.url) || safeClean(repoIdentity(hit.url)));
  return hit && hit.path && repositoryUrl ? { repoPath: hit.path, repositoryUrl } : null;
}

async function defaultGit(repoPath, args) {
  return (await execFileAsync('git', ['-C', repoPath, ...args], { timeout: DEFAULT_LIMITS.gitTimeoutMs, maxBuffer: 1024 * 1024 })).stdout.trim();
}

// Returns evidence for a merged PR whose head equals the claim commit, else null. Throws when gh fails.
async function ghCheckPullRequest({ repositoryUrl, targetBranch, commit }) {
  const name = repositoryUrl.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '');
  const args = ['pr', 'list', '--repo', name, '--state', 'merged', '--base', targetBranch,
    '--json', 'number,headRefOid,baseRefName,mergedAt', '--limit', '50'];
  const { stdout } = await execFileAsync('gh', args, { timeout: DEFAULT_LIMITS.ghTimeoutMs, maxBuffer: 1024 * 1024 });
  const list = JSON.parse(stdout);
  if (!Array.isArray(list)) throw new Error('unexpected gh output');
  const pr = list.find(item => item && item.headRefOid === commit && item.baseRefName === targetBranch && item.mergedAt);
  return pr ? { verified: true, merged: true, base: targetBranch, repositoryUrl, commit, number: pr.number } : null;
}

function withTimeout(promise, ms, label) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    const fail = (message, code) => { if (!failed) { failed = true; reject(Object.assign(new Error(message), { code })); } };
    req.on('data', chunk => {
      size += chunk.length;
      if (size > BODY_MAX) { chunks.length = 0; fail('Body is larger than 64 KB', 'BODY_TOO_LARGE'); return; }
      chunks.push(chunk);
    });
    req.on('error', () => fail('Cannot read body', 'INVALID_JSON'));
    req.on('end', () => {
      if (failed) return;
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        const body = text.trim() ? JSON.parse(text) : {};
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
        resolve(body);
      } catch { fail('Body must be a JSON object', 'INVALID_JSON'); }
    });
  });
}

function createRefresh({ store, resolveRepo = () => null, gitCommand = defaultGit, checkPullRequest, deliver = () => {}, now = Date.now, log = () => {}, limits = {} }) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  let running = false;

  const git = (repoPath, args) => withTimeout(Promise.resolve().then(() => gitCommand(repoPath, args)), lim.gitTimeoutMs, 'git');
  const triggerDeliver = () => {
    try { Promise.resolve(deliver()).catch(error => log('registry.refresh.deliver_failed', { error: errorText(error) })); }
    catch (error) { log('registry.refresh.deliver_failed', { error: errorText(error) }); }
  };

  // Records an unverified result. recordCheck does not change the claim revision.
  async function recordFailure(claimId, reason, error = null) {
    const at = iso(now());
    await store.transact(null, snap => {
      const captured = captureClaim(snap, claimId);
      return captured ? recordCheck(snap, captured, { reason, error, checkedAt: at }, now()) : { ok: false, reason: 'claim_not_found' };
    });
    return { ok: true, merged: false, reason };
  }

  async function check(claim) {
    const target = resolveRepo(claim);
    if (!target) return recordFailure(claim.id, 'repo-not-registered');
    let branch;
    try {
      const out = await git(target.repoPath, ['ls-remote', '--symref', 'origin', 'HEAD']);
      branch = out.match(/^ref:\s+refs\/heads\/([^\n]+)\s+HEAD$/m)?.[1];
    } catch (error) { return recordFailure(claim.id, 'default_branch_unknown', errorText(error)); }
    if (!branch) return recordFailure(claim.id, 'default_branch_unknown');
    const base = { ...target, targetBranch: branch, gitCommand: git, now: now() };
    const first = await reconcile(store, claim.id, { ...base, strategy: 'merge' });
    if (first.reason !== 'commit_not_reachable') return first;
    if (typeof checkPullRequest !== 'function') return recordFailure(claim.id, 'pr-check-unavailable');
    let unavailable = null;
    const guarded = async arg => {
      try { return await withTimeout(Promise.resolve().then(() => checkPullRequest(arg)), lim.ghTimeoutMs, 'gh'); }
      catch (error) { unavailable = errorText(error); return null; }
    };
    const second = await reconcile(store, claim.id, { ...base, strategy: 'squash', checkPullRequest: guarded });
    return unavailable !== null ? recordFailure(claim.id, 'pr-check-unavailable', unavailable) : second;
  }

  // Never throws. Does not trigger delivery.
  async function refreshOne(claimId) {
    const checkedAt = iso(now());
    try {
      const snap = await store.readSnapshot();
      const claim = snap.claims.find(item => item.id === claimId);
      if (!claim) return { ...(await reconcile(store, claimId, { now: now() })), repo: null, checkedAt };
      return { ...(await check(claim)), repo: claim.repo, checkedAt };
    } catch (error) {
      log('registry.refresh.failed', { claimId, error: errorText(error) });
      try { await recordFailure(claimId, 'check_failed', errorText(error)); } catch { /* store is down */ }
      return { ok: false, merged: false, reason: 'check_failed', error: errorText(error), repo: null, checkedAt };
    }
  }

  async function refreshClaim(claimId) {
    const result = await refreshOne(claimId);
    if (result.merged) triggerDeliver();
    return result;
  }

  // Returns null when a sweep already runs.
  async function sweep() {
    if (running) return null;
    running = true;
    const summary = { checked: 0, merged: 0, unverified: 0, skipped: 0, purged: 0 };
    try {
      const at = now();
      const snap = await store.readSnapshot();
      const due = [];
      for (const claim of snap.claims) {
        if (!SWEEP_STATUSES.has(claim.status)) continue;
        const last = Date.parse(claim.mergeCheck && claim.mergeCheck.checkedAt);
        if (Number.isFinite(last) && at - last < lim.recheckMs) summary.skipped++;
        else due.push(claim);
      }
      summary.skipped += Math.max(0, due.length - lim.maxClaims);
      for (const claim of due.slice(0, lim.maxClaims)) {
        const result = await refreshOne(claim.id);
        summary.checked++;
        if (result.merged) summary.merged++;
        else if (result.ok) summary.unverified++;
        else summary.skipped++;
      }
      try {
        // Dry run on a copy: write only when something expires.
        const dry = purgeExpired(structuredClone(await store.readSnapshot()), now());
        if (dry.archive + dry.events > 0) {
          const out = await store.transact(null, next => purgeExpired(next, now()));
          const gone = out && out.result;
          summary.purged = gone ? gone.archive + gone.events : 0;
        }
      } catch (error) { log('registry.refresh.purge_failed', { error: errorText(error) }); }
      if (summary.merged > 0) triggerDeliver();
    } catch (error) {
      log('registry.refresh.sweep_failed', { error: errorText(error) });
    } finally { running = false; }
    return summary;
  }

  // HTTP side. Returns null when the route is not a refresh route, else a promise of { status, body }.
  function route(req, parts) {
    const one = parts.length === 5 && parts[2] === 'claims' && parts[4] === 'refresh';
    const all = parts.length === 3 && parts[2] === 'refresh';
    if (req.method !== 'POST' || !(one || all)) return null;
    return readBody(req).then(async body => {
      const bad = FORBIDDEN.find(name => Object.prototype.hasOwnProperty.call(body, name));
      if (bad) return { status: 400, body: { error: `${bad} is not accepted`, code: 'FORBIDDEN_FIELD' } };
      if (one) {
        const result = await refreshClaim(parts[3]);
        if (result.reason === 'claim_not_found') return { status: 404, body: { error: 'Claim not found' } };
        return { status: 200, body: { result } };
      }
      const summary = await sweep();
      return summary ? { status: 200, body: { summary } } : { status: 202, body: { started: true } };
    }).catch(error => {
      if (error && (error.code === 'INVALID_JSON' || error.code === 'BODY_TOO_LARGE')) return { status: 400, body: { error: error.message, code: error.code } };
      log('registry.refresh.route_failed', { error: errorText(error) });
      return { status: 500, body: { error: 'Registry refresh failed' } };
    });
  }

  return { refreshClaim, sweep, route };
}

module.exports = { createRefresh, matchRepo, ghCheckPullRequest, DEFAULT_LIMITS };
