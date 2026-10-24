"use strict";

function flushPendingValidationQueue(line, {
  capacity,
  runningCount,
  launch,
  onDiscard = () => {},
}) {
  const pending = line.pendingValidations;
  const result = { inspected: 0, launched: 0, discarded: 0, retained: 0, changed: false };
  if (!Array.isArray(pending) || pending.length === 0) return result;

  const originalOrder = pending.slice();
  const passLimit = pending.length;
  while (result.inspected < passLimit && pending.length > 0 && runningCount() < capacity) {
    const item = pending.shift();
    result.inspected += 1;
    const worker = line.workers.get(item.implWorkerId);
    if (!worker || worker.deleted) {
      result.discarded += 1;
      onDiscard(item, worker || null, "missing-worker");
      continue;
    }
    if (worker.status === "running") {
      pending.push(item);
      result.retained += 1;
      continue;
    }
    if (item.runId !== undefined && item.runId !== null
      && item.runId !== worker.runGeneration) {
      result.discarded += 1;
      onDiscard(item, worker, "superseded");
      continue;
    }
    try {
      launch(item, worker);
      result.launched += 1;
    } catch (error) {
      // Keep the exact item and stop this pass. A later lifecycle event can retry it.
      pending.unshift(item);
      result.retained += 1;
      result.launchError = error;
      break;
    }
  }

  result.changed = pending.length !== originalOrder.length
    || pending.some((item, index) => item !== originalOrder[index]);
  return result;
}

function removePendingValidations(pending, implWorkerId) {
  if (!Array.isArray(pending)) return [];
  const removed = [];
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (pending[index].implWorkerId === implWorkerId) {
      removed.unshift(...pending.splice(index, 1));
    }
  }
  return removed;
}

function serializePendingValidations(pending) {
  return Array.isArray(pending) ? pending.map((item) => ({ ...item })) : [];
}

function restorePendingValidations(pending) {
  return Array.isArray(pending) ? pending.map((item) => ({ ...item })) : [];
}

module.exports = {
  flushPendingValidationQueue,
  removePendingValidations,
  serializePendingValidations,
  restorePendingValidations,
};
