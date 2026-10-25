'use strict';

// Staleness sweep: marks abandoned claims stale, retires long-stale ones, purges old tombstones.
// Rules live in work-claims.js. A claim is never labeled merged here.
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { CURRENT_STATUSES, TOMBSTONE_RETENTION_MS, evaluateStaleness, markStale, retireClaim, purgeTombstones } = require('./work-claims');
const execFileAsync = promisify(execFile);

const DEFAULT_LIMITS = { maxClaims: 50, maxBranchChecks: 20, recheckMs: 6 * 60 * 60 * 1000, gitTimeoutMs: 15000 };
const errorText = error => String(error && error.message !== undefined ? error.message : error);

async function defaultGit(repoPath, args) {
  return (await execFileAsync('git', ['-C', repoPath, ...args], { timeout: DEFAULT_LIMITS.gitTimeoutMs, maxBuffer: 1024 * 1024 })).stdout.trim();
}

function withTimeout(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('git timed out')), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

function createStalenessSweep({ store, getLine, resolveRepo = () => null, gitCommand = defaultGit, now = Date.now, log = () => {}, limits = {} }) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  let running = false;

  function appendEvent(snapshot, event) {
    snapshot.events.push({ ...event, id: randomUUID(), cursor: ++snapshot.eventCursor });
  }

  // Returns 'confirmed', 'missing' or 'unknown'. Never throws.
  async function checkBranch(claim) {
    try {
      const target = resolveRepo(claim);
      if (!target || !target.repoPath) return 'unknown';
      const ref = `refs/heads/${claim.branch}`;
      const out = await withTimeout(Promise.resolve().then(() => gitCommand(target.repoPath, ['ls-remote', '--heads', 'origin', ref])), lim.gitTimeoutMs);
      const found = String(out).split('\n').some(line => line.trim().split(/\s+/)[1] === ref);
      return found ? 'confirmed' : 'missing';
    } catch (error) {
      log('registry.staleness.branch_check_failed', { claimId: claim.id, error: errorText(error) });
      return 'unknown';
    }
  }

  // Applies fn(snapshot, claim) only if the claim still has the evaluated revision and status.
  async function guarded(claim, fn) {
    try {
      const out = await store.transact(null, snap => {
        const current = snap.claims.find(item => item.id === claim.id);
        if (!current || current.revision !== claim.revision || current.status !== claim.status) return false;
        fn(snap, current);
        return true;
      });
      return Boolean(out && out.result);
    } catch (error) {
      log('registry.staleness.apply_failed', { claimId: claim.id, error: errorText(error) });
      return false;
    }
  }

  async function evaluate(claim, at, summary, budget) {
    const values = { branchCheckedAt: claim.branchCheckedAt, branchConfirmedAt: claim.branchConfirmedAt };
    const due = !(typeof claim.branchCheckedAt === 'number' && at - claim.branchCheckedAt < lim.recheckMs);
    let ownerCheck = true;
    try { const line = getLine(claim.ownerLineId); ownerCheck = Boolean(line && !line.deleted); } catch (error) {
      log('registry.staleness.owner_check_failed', { claimId: claim.id, error: errorText(error) });
      return;
    }
    if (ownerCheck && due && budget.left > 0) {
      budget.left--;
      summary.branchChecked++;
      const state = await checkBranch(claim);
      if (state !== 'unknown') {
        values.branchCheckedAt = at;
        if (state === 'confirmed') values.branchConfirmedAt = at;
        // Background data: the claim revision stays the same.
        await guarded(claim, (snap, current) => {
          current.branchCheckedAt = values.branchCheckedAt;
          if (values.branchConfirmedAt !== undefined) current.branchConfirmedAt = values.branchConfirmedAt;
        });
        claim = { ...claim, ...values };
      }
    }
    const verdict = evaluateStaleness(claim, { now: at, ownerExists: ownerCheck, ...values });
    if (!verdict.stale) return;
    const applied = await guarded(claim, (snap, current) => {
      const marked = markStale(current, verdict.reason, at);
      snap.claims[snap.claims.indexOf(current)] = { ...marked.claim, revision: current.revision + 1 };
      appendEvent(snap, marked.event);
    });
    if (applied) summary.markedStale++;
  }

  async function retire(claim, at, summary) {
    const applied = await guarded(claim, (snap, current) => {
      const out = retireClaim(current, 'expired', at);
      if (!out.ok) throw new Error(out.code);
      snap.claims.splice(snap.claims.indexOf(current), 1);
      snap.tombstones.push(out.tombstone);
      appendEvent(snap, out.event);
    });
    if (applied) summary.retired++;
  }

  // Returns null when a sweep already runs. Never throws.
  async function sweep() {
    if (running) return null;
    running = true;
    const summary = { checked: 0, branchChecked: 0, markedStale: 0, retired: 0, purgedTombstones: 0 };
    try {
      const at = now();
      const snap = await store.readSnapshot();
      const budget = { left: lim.maxBranchChecks };
      const current = snap.claims.filter(c => CURRENT_STATUSES.includes(c.status))
        .sort((a, b) => (a.updatedAt ?? 0) - (b.updatedAt ?? 0)).slice(0, lim.maxClaims);
      for (const claim of current) {
        summary.checked++;
        try { await evaluate(claim, at, summary, budget); }
        catch (error) { log('registry.staleness.claim_failed', { claimId: claim.id, error: errorText(error) }); }
      }
      const old = snap.claims.filter(c => c.status === 'stale' && typeof c.staleAt === 'number' && at - c.staleAt > TOMBSTONE_RETENTION_MS);
      for (const claim of old) await retire(claim, at, summary);
      try {
        const out = await store.transact(null, next => {
          const kept = purgeTombstones(next.tombstones, at);
          const gone = next.tombstones.length - kept.length;
          next.tombstones = kept;
          return gone;
        });
        summary.purgedTombstones = (out && out.result) || 0;
      } catch (error) { log('registry.staleness.purge_failed', { error: errorText(error) }); }
    } catch (error) {
      log('registry.staleness.sweep_failed', { error: errorText(error) });
    } finally { running = false; }
    return summary;
  }

  // Returns null when the route is not the sweep route, else a promise of { status, body }.
  function route(req, parts) {
    if (req.method !== 'POST' || parts.length !== 4 || parts[2] !== 'staleness' || parts[3] !== 'sweep') return null;
    req.resume();
    return sweep().then(
      summary => (summary ? { status: 200, body: { summary } } : { status: 202, body: { started: true } }),
      error => { log('registry.staleness.route_failed', { error: errorText(error) }); return { status: 500, body: { error: 'Staleness sweep failed' } }; });
  }

  return { sweep, route };
}

module.exports = { createStalenessSweep, DEFAULT_LIMITS };
