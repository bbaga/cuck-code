"use strict";

// Runs a script check worker: the router side of a node with runner "script".
// The server gives its helpers as parameters, so this module needs no server
// state. The scripts run in script-runner.js.

const crypto = require("node:crypto");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { startScriptRun } = require("./script-runner");
const { InvocationCapture } = require("./handoff");

function git(args) {
  const r = spawnSync("git", args, { encoding: "utf8", timeout: 60000 });
  return { ok: !r.error && r.status === 0, text: r.error ? r.error.message : String(r.stderr || r.stdout || "").trim() };
}

// The folder of the check files of one worker.
function checkDir(lineDir, workerId) {
  return path.join(lineDir, "checks", workerId);
}

// Removes a detached clean tree. The caller decides what a failure means.
function removeTree(sourceWorktree, tree) {
  const removed = git(["-C", sourceWorktree, "worktree", "remove", "--force", tree]);
  const pruned = git(["-C", sourceWorktree, "worktree", "prune"]);
  return removed.ok && pruned.ok ? null : (removed.ok ? pruned.text : removed.text);
}

// deps: { saveLine, broadcast, workerClosed, appendTranscript, resolveNodeSettings, slog, lineDir }
function spawnScriptWorker(line, worker, deps) {
  const { saveLine, broadcast, workerClosed, appendTranscript, resolveNodeSettings, slog, lineDir } = deps;
  const invocationId = crypto.randomUUID();
  const runId = worker.runGeneration || 1;
  worker.runGeneration = runId;
  worker.activeInvocationId = invocationId;
  worker.lastError = null;
  saveLine(line);
  const capture = new InvocationCapture();
  const source = line.workers.get(worker.validates);
  const spec = worker.scriptSpec;
  const failRun = (message) => {
    slog("error", "script.run.failed", { lineId: line.id, workerId: worker.id, error: message });
    worker.child = null;
    worker.lastError = message;
    workerClosed(line, worker, null, null, capture, { invocationId, runId, outcome: "fail" });
  };

  const sourceWorktree = source ? source.worktreePath : worker.worktreePath;
  const base = path.join(checkDir(lineDir(line), worker.id), `run-${runId}`);
  let runRoot = sourceWorktree;
  let tree = null;
  if (spec.checkout === "clean") {
    tree = path.join(base, "tree");
    const added = git(["-C", sourceWorktree, "worktree", "add", "--detach", tree, worker.checkedCommit]);
    if (!added.ok) return failRun(`The clean worktree could not be created. ${added.text}`);
    runRoot = tree;
  }

  let handle;
  try {
    handle = startScriptRun({
      nodeId: worker.node, steps: spec.steps, failFast: spec.failFast, runRoot,
      checkout: spec.checkout, checkClean: spec.checkout === "worktree",
      repoName: worker.repo, branch: worker.branch, commit: worker.checkedCommit,
      env: { ...process.env, CUCK_LINE_ID: line.id, CUCK_WORKER_ID: worker.id,
        CUCK_SOURCE_ID: worker.validates, CUCK_REPO: worker.repo || "", CUCK_BRANCH: worker.branch || "",
        CUCK_WORKTREE: runRoot, CUCK_SOURCE_WORKTREE: sourceWorktree },
      timeLimitSec: resolveNodeSettings(line, worker.node).timeLimit,
      logDir: path.join(base, "logs"),
      hooks: {
        onEntry: (entry) => {
          if (typeof entry.at !== "number") entry.at = Date.now();
          capture.add(entry);
          appendTranscript(worker.transcript, entry);
          broadcast(line, "worker_entry", { workerId: worker.id, entry });
        },
        onStep: (results) => {
          worker.checkResults = results;
          saveLine(line);
          broadcast(line, "worker_check", { workerId: worker.id, checkResults: results });
        },
        onDone: (result) => {
          if (result.outcome !== "ok" && !worker.stopRequested) {
            worker.lastError = `The script check ended with outcome '${result.outcome}'.`;
          }
          workerClosed(line, worker, result.exitCode, result.signal, capture,
            { invocationId, runId, outcome: result.outcome });
        },
      },
    });
  } catch (error) {
    if (tree) removeTree(sourceWorktree, tree);
    return failRun(`The script check could not start. ${error && error.message ? error.message : error}`);
  }
  worker.child = handle;

  // The clean tree goes after every outcome. A failed removal is only logged.
  if (tree) {
    handle.done.then(() => {
      const problem = removeTree(sourceWorktree, tree);
      if (problem) slog("warn", "script.tree.remove.failed", { lineId: line.id, workerId: worker.id, tree, error: problem });
    });
  }
}

module.exports = { spawnScriptWorker, checkDir, removeTree };
