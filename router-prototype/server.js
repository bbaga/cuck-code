const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");

const PORT = Number(process.env.PORT || 7788);
const LINES_DIR = path.resolve(process.env.LINES_DIR || "./lines");
const AUTO_APPROVE = process.env.LINE_AUTO_APPROVE !== "0";
const INDEX_HTML = path.join(__dirname, "web", "index.html");
const WORKER_CAP = 8;
const UI_PORT_BASE = Number(process.env.UI_PORT_BASE || 4100);
const UI_TEST_SLOTS = Number(process.env.UI_TEST_SLOTS || 1);
const PLANNER_TIME_LIMIT = Number(process.env.PLANNER_TIME_LIMIT || 1800);
const WORKER_TIME_LIMIT = Number(process.env.WORKER_TIME_LIMIT || 3600);

// ---- structured logging with size-based rotation ----
const LOG_DIR = path.join(__dirname, "logs");
const LOG_FILE = path.join(LOG_DIR, "router.log");
const LOG_MAX_BYTES = Number(process.env.LOG_MAX_BYTES || 1024 * 1024);
const LOG_KEEP = Number(process.env.LOG_KEEP || 5);
let logStream = null;
let logBytes = 0;

function preview(text, n) {
  const s = String(text == null ? "" : text);
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function slog(level, event, fields) {
  const entry = { t: new Date().toISOString(), level, event, ...fields };
  const line = JSON.stringify(entry) + "\n";
  const bytes = Buffer.byteLength(line);
  if (logBytes + bytes > LOG_MAX_BYTES) {
    try { if (logStream) logStream.end(); } catch {}
    for (let i = LOG_KEEP - 1; i >= 1; i--) {
      try { fs.renameSync(`${LOG_FILE}.${i}`, `${LOG_FILE}.${i + 1}`); } catch {}
    }
    try { fs.renameSync(LOG_FILE, `${LOG_FILE}.1`); } catch {}
    logStream = null;
    logBytes = 0;
  }
  if (!logStream) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    try { logBytes = fs.statSync(LOG_FILE).size; } catch { logBytes = 0; }
    logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
  }
  logStream.write(line);
  logBytes += bytes;
  if (level === "error" || level === "warn") console.log(line.trim());
  return entry;
}

const portByWorker = new Map();
const uiSlots = { held: new Set(), waiters: [] };

function portFor(workerId) {
  if (!portByWorker.has(workerId)) {
    let p = UI_PORT_BASE + portByWorker.size;
    while ([...portByWorker.values()].includes(p)) p += 1;
    portByWorker.set(workerId, p);
    slog("info", "port.assigned", { workerId, port: p });
  }
  return portByWorker.get(workerId);
}

function releaseUiSlot(workerId) {
  const wasHeld = uiSlots.held.has(workerId);
  uiSlots.held.delete(workerId);
  if (wasHeld) slog("info", "slot.released", { workerId });
  for (let i = uiSlots.waiters.length - 1; i >= 0; i--) {
    if (uiSlots.waiters[i].workerId === workerId) {
      clearTimeout(uiSlots.waiters[i].timer);
      const w = uiSlots.waiters.splice(i, 1)[0];
      json(w.res, 409, { error: "worker stopped while waiting for a UI test slot" });
    }
  }
  while (uiSlots.held.size < UI_TEST_SLOTS && uiSlots.waiters.length) {
    const w = uiSlots.waiters.shift();
    clearTimeout(w.timer);
    uiSlots.held.add(w.workerId);
    json(w.res, 200, { acquired: true });
  }
}

function dockerRun(args, cb) {
  let child;
  try { child = spawn("docker", args, { stdio: ["ignore", "pipe", "ignore"] }); }
  catch { return cb(null); }
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  child.on("error", () => cb && cb(null));
  child.on("close", () => cb && cb(out.trim()));
}

function removeContainers(filter, cb) {
  dockerRun(["ps", "-aq", "--filter", filter], (ids) => {
    if (!ids) return cb && cb(false);
    const list = ids.split(/\s+/).filter(Boolean);
    if (!list.length) return cb && cb(false);
    slog("info", "docker.cleanup", { filter, count: list.length });
    dockerRun(["rm", "-fv", ...list], () => cb && cb(true));
  });
}

function cleanupWorkerContainers(workerId) {
  removeContainers(`label=cuck.worker=${workerId}`);
}

function sweepWorkerContainers() {
  removeContainers("label=cuck.worker");
}

// ---- line inventory: processes and containers started by stages ----

function reconcileInventory(line, cb) {
  dockerRun(["ps", "-a", "--filter", `label=cuck.line=${line.id}`,
    "--format", "{{.ID}}\t{{.Names}}\t{{.Label \"cuck.worker\"}}"], (out) => {
    if (out != null) {
      const seen = new Set();
      for (const row of out.split("\n").filter(Boolean)) {
        const [cid, cname, cworker] = row.split("\t");
        seen.add(cid);
        const existing = [...line.inventory.values()]
          .find((i) => i.kind === "container" && i.ref === cid);
        if (!existing) {
          const id = crypto.randomUUID();
          line.inventory.set(id, { id, kind: "container", name: cname || cid.slice(0, 12),
            by: cworker || "planner", ref: cid, keep: false, status: "running",
            startedAt: Date.now() });
          saveLine(line);
          slog("info", "inventory.discovered", { lineId: line.id, itemId: id,
            container: cname || cid.slice(0, 12), by: cworker || "planner" });
        }
      }
      for (const item of line.inventory.values()) {
        if (item.kind === "container" && !seen.has(item.ref)) item.status = "stopped";
      }
    }
    for (const item of line.inventory.values()) {
      if (item.kind === "process" && item.status === "running") {
        try { process.kill(item.ref, 0); } catch { item.status = "stopped"; }
      }
    }
    cb && cb();
  });
}

function killItem(item) {
  if (item.status !== "running") return false;
  slog("info", "inventory.killed", { kind: item.kind, name: item.name,
    ref: item.ref, by: item.by, keep: item.keep });
  if (item.kind === "container") {
    dockerRun(["rm", "-fv", item.ref]);
  } else {
    try { process.kill(item.ref, "SIGTERM"); } catch {}
  }
  item.status = "stopped";
  item.keep = false;
  return true;
}

function cleanupStage(line, by) {
  // containers belonging to this stage, unless the user kept them
  dockerRun(["ps", "-aq", "--filter", `label=cuck.line=${line.id}`,
    "--format", "{{.ID}}\t{{.Label \"cuck.worker\"}}"], (out) => {
    if (!out) return;
    const kept = new Set([...line.inventory.values()]
      .filter((i) => i.keep && i.kind === "container").map((i) => i.ref));
    for (const row of out.split("\n").filter(Boolean)) {
      const [cid, cworker] = row.split("\t");
      if ((cworker || "planner") !== by) continue;
      if (kept.has(cid)) continue;
      dockerRun(["rm", "-fv", cid]);
    }
  });
  for (const item of line.inventory.values()) {
    if (item.kind === "process" && item.by === by && item.status === "running" && !item.keep) {
      try { process.kill(item.ref, "SIGTERM"); } catch {}
      item.status = "stopped";
    }
  }
  saveLine(line);
}

function frontendToolsBlock(workerId, implId, lineId) {
  return `
## Browser, port, and docker tools (frontend persona)
- Your session has its own playwright browser (MCP tools). No other
  worker shares your browser.
- If you serve the app, allocate a port first (idempotent):
  curl -s http://localhost:${PORT}/api/protocol/workers/${workerId}/port
  -> {"port": <number>}. Serve the app on that port. Record the port
  in ui.port at the repo root.
- You may run the app inside a docker container. Publish it on your
  allocated port, with both labels:
  docker run --label cuck.line=${lineId} --label cuck.worker=${workerId} -p <port>:<containerPort> ...
  Name containers uniquely with your worker id. Stop and remove them
  when you are done (docker rm -f <name>); the router force-removes
  any container still carrying your labels when your run ends or the
  line is deleted.
- If the app depends on docker itself (compose, builds, nested
  containers), run it inside a docker-in-docker container:
  docker run -d --privileged --label cuck.line=${lineId} --label cuck.worker=${workerId} --name <name>-dind docker:27-dind
  Wait for the daemon before use: docker exec <name>-dind docker info
  Use docker exec for the docker work inside it. A --privileged
  container is not a security boundary: use it only for trusted
  project code. Everything nested
  inside dies with the labeled container. Never mount the host docker
  socket (-v /var/run/docker.sock:...): containers started through a
  shared socket escape the label cleanup.
${implId ? `- The implementor's app port: read ui.port at the repo root, or call
  curl -s http://localhost:${PORT}/api/protocol/workers/${implId}/port
  If the app is not running, you may start it yourself (directly or in
  a docker container) on that port.` : ""}
- Before browser tests, acquire a UI test slot (other validators may run
  at the same time):
  curl -s -X POST http://localhost:${PORT}/api/protocol/workers/${workerId}/uitest
  200 = acquired (the call waits up to 120 s while others hold slots);
  408 = timeout, wait and try again.
- Release the slot when your tests end:
  curl -s -X POST http://localhost:${PORT}/api/protocol/workers/${workerId}/uitest/release
- The slot frees itself automatically if your process stops.
- If you cannot acquire a slot, prefer parallel-safe scenarios instead:
  unique ports, isolated containers or headless browsers, no shared
  fixtures.`;
}
const IMPL_MODEL = process.env.IMPLEMENTOR_MODEL || "glm-5-3-flash";
const VAL_MODEL = process.env.VALIDATOR_MODEL || "glm-5-3";

const lines = new Map();

function plannerBrief(name, lineId, userPrompt, port) {
  return `You are the PLANNER of factory line '${name}' (id ${lineId}).
${userPrompt}

## Factory protocol
1. Write the plan to plan.md in your workdir (markdown, including a
   mermaid diagram of the task graph: nodes are implementor tasks,
   edges are dependencies, parallel tasks on separate branches).
   Your workdir is a git repo - commit the plan.
2. After writing plan.md, reply with a short summary and STOP. Do not
   spawn workers: the user reviews the plan in the UI and the router
   blocks worker spawning until approval. If you receive PLAN FEEDBACK,
   revise plan.md and wait again.
3. When you receive PLAN APPROVED, spawn implementor workers with curl:
   curl -s -X POST http://localhost:${port}/api/protocol/lines/${lineId}/workers \\
     -H 'Content-Type: application/json' \\
     -d '{"name":"<worker-name>","persona":"backend|frontend","repo":"<repo-name>","prompt":"<full instructions>"}'
   The "repo" field is optional and selects the repository the worker
   works in (default "primary" - your workdir). A line can work across
   several repositories: register additional ones with
   curl -s -X POST http://localhost:${port}/api/protocol/lines/${lineId}/repos \\
     -H 'Content-Type: application/json' \\
     -d '{"name":"<repo-name>","url":"<clone url>"}'
   The router clones the repo. List the registered repos:
   GET http://localhost:${port}/api/protocol/lines/${lineId}/repos
   Rules: spawn independent tasks in parallel (several curl calls);
   worker prompts must be SELF-CONTAINED (workers share no context
   with you): include the repo state, the task, file paths, acceptance
   criteria, and that they must commit their work in their worktree.
   In every worker prompt, order the implementor to do all work in its
   own git worktree and to NEVER use the shared checkout. Order every
   implementor to report the location of its worktree (the output of
   git rev-parse --show-toplevel) in its final report. You must give
   that worktree location to the validator that checks the work.
   Test scope: implementors and validators run UNIT TESTS only. They
   must NOT run integration tests. The CI pipelines of the repository
   run the integration tests. Only the integration validator runs
   integration tests locally.
   Choose the persona per task: "backend" for architecture, data,
   APIs, and logic; "frontend" for user interfaces, pages, and
   interaction. The validator of each worker uses the same persona.
   Worker names are unique per line. After spawning, end your turn and
   wait: worker completions arrive as new prompts (WORKER REPORT...).
4. On each WORKER REPORT / FAILURE / STOPPED prompt: assess, then
   decide and act - spawn follow-up workers, restart a failed task
   under a NEW name with a corrected prompt, or conclude. You may call
   GET http://localhost:${port}/api/protocol/lines/${lineId}/workers to
   check statuses. Never invent worker results you were not told.
5. Validation loop: when an implementor finishes, you receive an
   IMPLEMENTOR REPORT and a request for acceptance criteria. Reply
   with a numbered list of criteria only (imperative steps). If the
   work needs no validation, reply with SKIP VALIDATION. A validator
   then checks the work against your criteria and you receive a
   VALIDATION REPORT with a VERDICT line.
   The verdict may carry CI results: the validator opens a draft
   pull request for the implementor branch and waits for the
   repository CI pipelines.
   On VERDICT: PASS you can accept the work or plan follow-up work.
   On VERDICT: FAIL (local or CI) the revised task goes back to the
   ORIGINAL implementor with the failure feedback:
   - send follow-up instructions to the ORIGINAL implementor session
     (it keeps its worktree and its memory):
     curl -s -X POST http://localhost:${port}/api/protocol/workers/<workerId>/continue \\
       -H 'Content-Type: application/json' \\
       -d '{"prompt":"<corrected instructions>"}'
     The implementor runs again; validation repeats after it finishes.
   - or spawn a new implementor with a corrected prompt (new name).
   Use the workerId and session id given in each report.
   NEVER commit to or push the main/master branch yourself. You plan
   and coordinate only; integration merging happens in the
   integration validator.
6. Integration: when ALL implementor validators report VERDICT: PASS,
   start the integration validator:
   curl -s -X POST http://localhost:${port}/api/protocol/lines/${lineId}/integration \
     -H 'Content-Type: application/json' \
     -d '{"prompt":"<integration and acceptance test instructions>"}'
   It merges all feature branches on top of master in its own worktree,
   runs the acceptance tests, and records a video per use case as
   structured evidence. You receive an INTEGRATION REPORT with the
   verdict. On VERDICT: FAIL, route fixes to the ORIGINAL implementors
   (continue endpoint), then start a new integration validator.
   On VERDICT: PASS, report completion to the user.

## Container and process hygiene
If you start any docker container, always set this label on it:
--label cuck.line=${lineId}
If the project depends on docker itself, start a docker-in-docker
container with the label and run your docker work inside it:
docker run -d --privileged --label cuck.line=${lineId} --name <name>-dind docker:27-dind
Wait for the daemon before use: docker exec <name>-dind docker info
Everything started inside the dind container dies with it when the
router kills the labeled container. A --privileged container is not
a security boundary: use it only for trusted project code. Do NOT mount the host docker
socket instead: containers started through a shared socket escape
the label cleanup.
If you start a background process that outlives your commands (for
example a dev server), register it:
curl -s -X POST http://localhost:${port}/api/protocol/lines/${lineId}/inventory \\
  -H 'Content-Type: application/json' \\
  -d '{"kind":"process","pid":<pid>,"name":"<what it is>"}'
The router kills registered processes and removes labeled containers
when your run ends, when the factory line is deleted, and on router
restart. Only an explicit user request keeps an item alive. Stop and
remove your containers yourself when you finish with them
(docker rm -f <name>).

## Language rule (ASD-STE100)
Write every worker prompt and every written communication with
implementors in ASD-STE100 Simplified Technical English:
- Use only approved words, each only in its approved part of speech.
- Keep sentences short: a maximum of 20 words. One topic per sentence.
- Write procedures as separate numbered steps. One action per step.
- Use the imperative in instructions ("Write the file.", not "The file
  should be written.").
- Use the active voice. Use the present tense for procedures; use the
  past tense only for events that occurred.
- Do not use "-ing" forms as verbs. Do not use noun clusters of more
  than three nouns. Do not use a word that has several meanings.
- Do not use idioms, metaphors, or jargon.`;
}

const PERSONAS = ["backend", "frontend"];

// A factory line can work across several repositories. The line
// workdir itself is the "primary" repo; the planner registers
// additional repos through the protocol (cloned under
// lines/<lineId>/repos/<name>). A repo's remote may exist even when it
// was never recorded (the planner can add an origin during its run),
// so remotes are detected at spawn time instead of being trusted.

function primaryRepo(line) {
  return { name: "primary", path: line.workdir, url: line.repoUrl || null };
}

// Detect the real remote of a repo path instead of trusting stored values.
function effectiveRepoUrl(repoPath) {
  try {
    const r = spawnSync("git", ["-C", repoPath, "remote", "get-url", "origin"],
      { encoding: "utf8" });
    if (r.status === 0 && r.stdout && r.stdout.trim()) return r.stdout.trim();
  } catch {}
  return null;
}

// Resolve a repo by name ("primary"/undefined = the line workdir).
// Returns {name, path, url} or null for an unknown name.
function resolveRepo(line, name) {
  if (!name || name === "primary") {
    const p = primaryRepo(line);
    return { name: p.name, path: p.path, url: p.url || effectiveRepoUrl(p.path) };
  }
  const repo = (line.repos || new Map()).get(String(name));
  if (!repo) return null;
  return { name: repo.name, path: repo.path, url: repo.url || effectiveRepoUrl(repo.path) };
}

function repoList(line) {
  const list = [resolveRepo(line, "primary")];
  for (const r of (line.repos || new Map()).values()) {
    list.push({ name: r.name, path: r.path, url: r.url || effectiveRepoUrl(r.path) });
  }
  return list;
}

const IMPL_PERSONA = {
  backend: `Your persona: backend / architecture.
Priorities:
- Keep the architecture layered and the domain logic correct.
- Keep the data model and its integrity correct. Keep API contracts
  clear and stable.
- Write error handling for every failure path you add.
- Add unit tests for the logic you change. Do not run integration
  tests: the CI pipelines of the repository run them.
Verify the work: run the build and the unit tests you added.`,
  frontend: `Your persona: frontend / UX.
Priorities:
- Build a usable, accessible interface: semantic HTML, labels for
  inputs, keyboard operation, sufficient contrast.
- Keep the visual language consistent with the existing pages.
- Make the layout responsive. Keep the state handling correct.
Verify the work: run the app and check the rendering. Use the
playwright browser tools (browser_navigate, browser_snapshot,
browser_click) for a smoke pass of the pages you touched. Keep the
browser console free of errors.`,
};

const VAL_PERSONA = {
  backend: `Your validation persona: backend / architecture.
Check with extra care: layer boundaries, the data model, API contract
consistency, error paths, test coverage of the changed logic, and dead
code.`,
  frontend: `Your validation persona: frontend / UX.
Check with extra care: correct rendering, layout at different widths,
labels and keyboard access, console errors, and the flows a user
performs. Run headless UI tests with the playwright browser tools on
the changed pages when the work includes a user interface.`,
};

function containersBlock(workerId, lineId) {
  return `
## Container and process hygiene
If you start any docker container, always set both labels on it:
--label cuck.line=${lineId} --label cuck.worker=${workerId}
If the project depends on docker itself (docker compose, image
builds, nested containers), start a docker-in-docker container with
both labels and run your docker work inside it:
docker run -d --privileged --label cuck.line=${lineId} --label cuck.worker=${workerId} --name <name>-dind docker:27-dind
Wait for the daemon before use: docker exec <name>-dind docker info
Then use docker exec for docker commands inside it. A --privileged
container is not a security boundary: use it only for trusted project
code. Everything
started inside the dind container dies with it when the router kills
the labeled container. Do NOT mount the host docker socket
(-v /var/run/docker.sock:...) instead: containers started through a
shared socket escape the label cleanup.
If you start a background process that outlives your commands (for
example a dev server), register it:
curl -s -X POST http://localhost:${PORT}/api/protocol/lines/${lineId}/inventory \\
  -H 'Content-Type: application/json' \\
  -d '{"kind":"process","pid":<pid>,"name":"<what it is>","worker":"${workerId}"}'
The router kills registered processes and removes labeled containers
when your run ends, when the factory line is deleted, and on router
restart. Only an explicit user request keeps an item alive. Stop and
remove your containers yourself when you finish with them
(docker rm -f <name>).`;
}

function remoteBlockImplementor(repoUrl) {
  if (!repoUrl) return "";
  return `
## Remote work
The repository has a remote (origin): ${repoUrl}
Confirm it first: git remote get-url origin. If that command fails,
the remote is gone: skip the remote steps and say so in your report.
Commit your work with clear messages. When your task is done, push
your branch to the remote:
git push -u origin HEAD
Report the branch name with: git rev-parse --abbrev-ref HEAD`;
}

function workerBrief(name, lineName, prompt, persona, workerId, lineId, repo) {
  const repoUrl = repo && repo.url ? repo.url : null;
  return `You are implementor worker '${name}' (id ${workerId}) on factory line '${lineName}'.
Your repository for this task: '${repo ? repo.name : "primary"}'${repoUrl ? ` (remote: ${repoUrl})` : " (no remote)"}.
A factory line can work across several repositories - work ONLY in the
repository named above.
You run inside your own git worktree of that repository - all work
happens here, do not touch other directories. NEVER use the shared
checkout: every file you read or write must be inside your worktree.
Commit your work with clear messages.
Test scope: run UNIT TESTS only. Do NOT run integration tests. The CI
pipelines of the repository run the integration tests.
${containersBlock(workerId, lineId)}${remoteBlockImplementor(repoUrl)}

${IMPL_PERSONA[persona] || IMPL_PERSONA.backend}
${persona === "frontend" ? frontendToolsBlock(workerId, null, lineId) : ""}

Task from the planner:
${prompt}

Write your report back in ASD-STE100 Simplified Technical English: use
only approved words, keep sentences short (a maximum of 20 words), one
topic per sentence, the active voice, numbered steps for procedures,
and no idioms or jargon.

When done, reply with a concise report: what you implemented, files
changed, how you verified it (which unit tests you ran), the LOCATION
OF YOUR WORKTREE (the output of: git rev-parse --show-toplevel), and
any open issues. That report goes back to the planner verbatim. The
planner gives your worktree location to the validator that checks
your work.`;
}

function remoteBlockValidator(repoUrl, implName) {
  if (!repoUrl) return "";
  return `
## Remote validation and CI
The implementor branch in your workdir has a remote (origin): ${repoUrl}
Confirm it first: git remote get-url origin. If that command fails,
there is no remote: skip this section and validate locally only.
After the local criteria validation:
1. Make sure the branch is on the remote:
   git fetch origin
   If origin/<branch> is missing or behind your local branch, push:
   git push -u origin HEAD
2. Open a DRAFT pull request:
   gh pr create --draft --title "${implName}" --head <branch> --fill
   (If the repository already has an open PR for this branch, use it.)
3. Wait for the CI pipelines of the pull request (up to 20 minutes).
   Poll with: gh pr checks
   Use: gh pr checks --json for machine-readable results.
4. Report the outcome:
   - All checks pass: include the PR url and "CI: PASS". VERDICT: PASS.
   - Checks fail: attach the failed check names and the failure log
     excerpts (gh run view <run-id> --log-failed), write "CI: FAIL".
     VERDICT: FAIL.
5. Do not mark the PR ready for review. Leave it as a draft.`;
}

function validatorBrief(implName, report, criteria, persona, workerId, implId, lineId, repoName, repoUrl) {
  return `You are the VALIDATOR (id ${workerId}) for the work of implementor '${implName}' (id ${implId}).
Your workdir is the implementor's git worktree in repository '${repoName || "primary"}'${repoUrl ? ` (remote: ${repoUrl})` : " (no remote)"}.
The implementor reported its location to the planner; the planner
passed it to you. Do not change the implementation. You check the work
only.
Test scope: run UNIT TESTS only. Do NOT run integration tests. The
integration tests run in the CI pipelines of the repository (see the
CI section below when a remote exists).
${containersBlock(workerId, lineId)}${remoteBlockValidator(repoUrl, implName)}

${VAL_PERSONA[persona] || VAL_PERSONA.backend}
${persona === "frontend" ? frontendToolsBlock(workerId, implId, lineId) : ""}

The implementor reported:
${report}

The planner gave these acceptance criteria:
${criteria}

Tasks:
1. Check the work against each criterion. For each criterion, record
   PASS or FAIL with one sentence of evidence.
2. You may run the code and the UNIT TESTS. Do not run integration
   tests: the CI pipelines run them. You may run code inside docker
   containers; publish ports only on your allocated port (see the
   frontend tools block when present). You may run headless UI tests
   with the playwright browser tools (browser_navigate,
   browser_snapshot, browser_click, browser_type).
3. Reply with a VALIDATION REPORT: one line per criterion with PASS or
   FAIL, then a final line "VERDICT: PASS" or "VERDICT: FAIL".
Write the report in ASD-STE100 Simplified Technical English (approved
words, short sentences, one topic per sentence, active voice, no
idioms).`;
}


function integrationValidatorBrief(line, branchEntries, instructions, workerId, repos) {
  const primary = repos.find((r) => r.name === "primary") || { url: null };
  const extraRepos = repos.filter((r) => r.name !== "primary");
  return `You are the INTEGRATION VALIDATOR (id ${workerId}) for factory line '${line.name}'.
This line works across ${repos.length} repositor${repos.length === 1 ? "y" : "ies"}:
${repos.map((r) => `- '${r.name}': ${r.url ? `remote ${r.url}` : `local clone at ${r.path}`}`).join("\n")}
Your workdir is a dedicated worktree of the 'primary' repository on a
fresh integration branch created from its main branch. You NEVER
commit to main/master and you NEVER push to any remote. All merging
happens on your integration branches.
You are the ONLY stage that runs integration tests locally: the
implementors and the validators run unit tests only. Run the full
acceptance and integration test suites here.

The feature branches to merge (one per implementor):
${branchEntries.map((e) => `- ${e.branch} (repo '${e.repo}')`).join("\n")}

Instructions from the planner:
${instructions}

Procedure:
1. For the 'primary' repo: merge each of its feature branches on top
   of your integration branch, one by one:
   git merge <branch> --no-edit
   Resolve conflicts yourself, keeping both features where possible.
   If a conflict cannot be resolved sensibly, stop and report it.
${extraRepos.length ? `2. For EVERY other repo in the list: make your own copy inside
   your workdir (git clone <remote or path> <repo-name>), create a
   local integration branch from its main branch, and merge its
   feature branches there the same way. Never push to their remotes.` : "2. No additional repositories are registered for this line."}
3. When all branches are merged, run ALL acceptance tests and verify
   everything works together. Build and run the project if needed.
4. For EACH use case you test, record a video of the test case running.
   Use playwright with video recording enabled: in a playwright test use
   video: 'on' (or npx playwright test --video=on); in a raw playwright
   script enable recordVideo on the browser context, for example
   browser.newContext({ recordVideo: { dir: 'evidence' } }).
   Save each video as a separate file under evidence/ in your workdir
   (for example evidence/use-case-login.webm).
5. IMPORTANT: close the browser context (or let the playwright
   test run finish) BEFORE you register the video file. A video that
   is still recording is not finalized: it has no duration and will
   not play. Register only files that are complete (usually larger
   than 10 KB).
6. Register every evidence video with the router:
   curl -s -X POST http://localhost:${PORT}/api/protocol/workers/${workerId}/evidence \
     -H 'Content-Type: application/json' \
     -d '{"useCase":"<one line describing the use case>","file":"evidence/<file>.webm"}'
   The file path is relative to your workdir. Register each use case
   as you complete it.
7. Reply with an INTEGRATION REPORT: branches merged (per repo),
   conflicts resolved (per branch, one line), acceptance test results,
   the list of registered evidence use cases, then a final line
   "VERDICT: PASS" or "VERDICT: FAIL".
Write the report in ASD-STE100 Simplified Technical English.`;
}

function sanitizeName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9-]/g, "");
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(obj));
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(line, event, data) {
  for (const res of line.clients) {
    try { sseSend(res, event, data); } catch {}
  }
}

function saveLine(line) {
  if (line.deleted) return;
  try {
    fs.writeFileSync(path.join(line.workdir, "line.json"),
      JSON.stringify({ id: line.id, name: line.name, sessionId: line.sessionId,
        repoUrl: line.repoUrl || null,
        repos: [...(line.repos || new Map()).values()].map((r) => ({
          name: r.name, url: r.url, path: r.path })),
        started: line.started, planApproved: line.planApproved,
        inventory: [...(line.inventory || new Map()).values()].map((i) => ({
          id: i.id, kind: i.kind, name: i.name, by: i.by, ref: i.ref,
          keep: i.keep, status: i.status })),
        evidence: [...(line.evidence || new Map()).values()].map((e) => ({
          id: e.id, useCase: e.useCase, path: e.path, name: e.name, by: e.by, at: e.at })),
        workers: [...line.workers.values()].map((w) => ({
          id: w.id, name: w.name, sessionId: w.sessionId, branch: w.branch, status: w.status,
          role: w.role, validates: w.validates, persona: w.persona || "backend",
          repo: w.repo || "primary", worktreePath: w.worktreePath,
          kind: w.kind || "standard", verdict: w.verdict || null })) }));
  } catch {}
}

function readBody(req, cb) {
  let data = "";
  req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
  req.on("end", () => {
    try { cb(null, JSON.parse(data || "{}")); } catch { cb(new Error("invalid JSON")); }
  });
}

function enqueue(line, text) {
  line.queue.push({ text });
  pump(line);
}

const WAKE_PREFIXES = ["IMPLEMENTOR REPORT", "VALIDATION REPORT", "VALIDATOR FAILURE",
  "VALIDATOR STOPPED", "WORKER FAILURE", "WORKER STOPPED", "PLAN APPROVED"];

function isWake(text) {
  return typeof text === "string" && WAKE_PREFIXES.some((p) => text.startsWith(p));
}


function entryText(entry) {
  if (typeof entry.text === "string") return entry.text;
  if (Array.isArray(entry.content)) {
    return entry.content.filter((p) => p && p.type === "text").map((p) => p.text).join("");
  }
  return "";
}

function pump(line) {
  if (line.deleted || line.status === "running" || line.queue.length === 0) return;
  const { text } = line.queue.shift();
  line.lastRun = text;
  line.status = "running";
  broadcast(line, "status", { status: line.status });
  const t0 = Date.now();
  slog("info", "planner.run.start", { lineId: line.id, resume: !!line.sessionId,
    chars: text.length, prompt: preview(text, 400) });

  const args = line.sessionId ? ["--resume", line.sessionId] : [];
  args.push("--workdir", line.workdir, "--trust", "--agent", "accept-edits",
    "--output", "streaming", "--time-limit", String(PLANNER_TIME_LIMIT));
  if (AUTO_APPROVE) args.push("--auto-approve");
  args.push("-p", text);
  const child = spawn("vibe", args, { stdio: ["ignore", "pipe", "pipe"] });
  line.child = child;

  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const raw = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let entry;
      try { entry = JSON.parse(raw); } catch { continue; }
      if (!entry || typeof entry !== "object") continue;
      if (!line.sessionId && entry.sessionId) line.sessionId = entry.sessionId;
      line.transcript.push(entry);
      if (line.transcript.length > 500) line.transcript.shift();
      slog("debug", "planner.entry", { lineId: line.id, type: entry.type,
        role: entry.role || null, chars: raw.length, text: preview(entryText(entry), 200) });
      broadcast(line, "entry", entry);
    }
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { stderr = (stderr + c).slice(-2000); });

  child.on("close", (code) => {
    line.child = null;
    if (line.deleted) return;
    slog("info", "planner.run.end", { lineId: line.id, code, ms: Date.now() - t0,
      stderr: code !== 0 ? preview(stderr, 300) : undefined });
    cleanupStage(line, "planner");
    saveLine(line);
    if (code !== 0) {
      broadcast(line, "error", { message: stderr.slice(-500) || `vibe exited with code ${code}` });
      if (isWake(line.lastRun)) {
        line.wakeRetries = line.wakeRetries || {};
        const attempts = (line.wakeRetries[line.lastRun] || 0);
        if (attempts < 2) {
          line.wakeRetries[line.lastRun] = attempts + 1;
          line.queue.unshift({ text: line.lastRun });
          slog("warn", "wake.retry", { lineId: line.id, attempt: attempts + 1,
            wake: preview(line.lastRun, 200) });
        } else {
          slog("error", "wake.dropped", { lineId: line.id, wake: preview(line.lastRun, 200) });
          broadcast(line, "error", {
            message: "dropped a wake message after repeated planner failures: "
              + line.lastRun.slice(0, 120) });
        }
      }
    }
    if (code === 0 && typeof line.lastRun === "string"
      && line.lastRun.startsWith("IMPLEMENTOR REPORT")) {
      const m = line.lastRun.match(/workerId ([a-f0-9-]+)/);
      const implWorker = m ? line.workers.get(m[1]) : null;
      if (implWorker) {
        const criteria = reportText(line.transcript);
        const skip = criteria.trim().toUpperCase().startsWith("SKIP VALIDATION");
        slog("info", "planner.decision", { lineId: line.id,
          decision: skip ? "skip-validation" : "spawn-validator",
          criteria: preview(criteria, 400) });
        if (!skip) {
          spawnValidator(line, implWorker, criteria);
        }
      }
    }
    line.lastRun = null;
    line.status = "idle";
    broadcast(line, "status", { status: line.status });
    pump(line);
  });
}

function reportText(transcript) {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const entry = transcript[i];
    if (entry && entry.type === "message" && entry.role === "assistant") {
      const c = entry.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.filter((p) => p && p.type === "text").map((p) => p.text).join("");
      return "";
    }
  }
  return "";
}

function spawnWorker(line, worker, prompt, model, resume) {
  slog("info", "worker.run.start", { lineId: line.id, workerId: worker.id,
    name: worker.name, role: worker.role, model,
    resume: !!(resume && worker.sessionId), chars: prompt.length });
  const args = resume && worker.sessionId ? ["--resume", worker.sessionId] : [];
  args.push("--workdir", worker.worktreePath, "--trust", "--agent", "accept-edits",
    "--output", "streaming", "--time-limit", String(WORKER_TIME_LIMIT));
  if (AUTO_APPROVE) args.push("--auto-approve");
  args.push("-p", prompt);
  const child = spawn("vibe", args, { stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, VIBE_ACTIVE_MODEL: model } });
  worker.child = child;

  let buf = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const raw = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let entry;
      try { entry = JSON.parse(raw); } catch { continue; }
      if (!entry || typeof entry !== "object") continue;
      if (!worker.sessionId && entry.sessionId) worker.sessionId = entry.sessionId;
      worker.transcript.push(entry);
      slog("debug", "worker.entry", { lineId: line.id, workerId: worker.id,
        type: entry.type, role: entry.role || null, chars: raw.length,
        text: preview(entryText(entry), 200) });
      broadcast(line, "worker_entry", { workerId: worker.id, entry });
    }
  });

  child.on("close", (code) => workerClosed(line, worker, code));
}

function workerClosed(line, worker, code) {
  worker.child = null;
  const timedOut = code === 3 && !worker.stopRequested;
  if (worker.stopRequested) worker.status = "stopped";
  else if (code === 0) worker.status = "completed";
  else if (timedOut) worker.status = "stopped";
  else worker.status = "failed";
  cleanupStage(line, worker.id);
  if (uiSlots.held.has(worker.id) || uiSlots.waiters.some((w) => w.workerId === worker.id)) {
    releaseUiSlot(worker.id);
  }
  if (line.deleted) return;
  broadcast(line, "worker_status", { workerId: worker.id, status: worker.status,
    verdict: worker.verdict || null });
  saveLine(line);
  const sid = worker.sessionId || "unknown";
  const report = reportText(worker.transcript);
  if (worker.role === "validator") {
    worker.verdict = /\bVERDICT:\s*FAIL\b/i.test(report) ? "fail"
      : /\bVERDICT:\s*PASS\b/i.test(report) ? "pass" : null;
  }
  slog("info", "worker.closed", { lineId: line.id, workerId: worker.id, name: worker.name,
    role: worker.role, status: worker.status, verdict: worker.verdict || undefined,
    reportChars: report.length,
    report: preview(report, 300) });
  if (worker.role === "validator" && worker.kind === "integration") {
    if (worker.status === "completed") {
      enqueue(line, `INTEGRATION REPORT - integration validator '${worker.name}' finished: ${report}. The merged result is on branch ${worker.branch} in its worktree; main/master is untouched. Decide: report completion to the user, or route fixes to the ORIGINAL implementors (continue endpoint) and start a new integration validator after they pass again.`);
    } else if (timedOut) {
      enqueue(line, `INTEGRATION TIMEOUT - integration validator '${worker.name}' hit the run time limit. The merged work is on branch ${worker.branch}. Decide how to proceed.`);
    } else {
      enqueue(line, `INTEGRATION STOPPED/FAILED - integration validator '${worker.name}' did not complete. Its worktree may be partially merged. Decide how to proceed.`);
    }
  } else if (worker.role === "validator") {
    const impl = line.workers.get(worker.validates);
    const implName = impl ? impl.name : "unknown";
    const implId = worker.validates || "unknown";
    const implSession = impl ? (impl.sessionId || "unknown") : "unknown";
    if (worker.status === "completed") {
      enqueue(line, `VALIDATION REPORT - validator '${worker.name}' checked the work of implementor '${implName}' (workerId ${implId}, vibe session ${implSession}, branch ${worker.branch}): ${report}. Decide: accept the work, send follow-up instructions to the original implementor (POST /api/protocol/workers/${implId}/continue with {"prompt": ...}), or spawn a new implementor with a corrected prompt.`);
    } else if (timedOut) {
      enqueue(line, `VALIDATOR TIMEOUT - the validator hit the run time limit and was interrupted. Validators are fresh sessions each time: the implementor work is unchanged, decide how to proceed (usually nothing - validation repeats after the next implementor completion).`);
    } else if (worker.status === "failed") {
      enqueue(line, `VALIDATOR FAILURE - validator '${worker.name}' (checking implementor '${implName}', workerId ${implId}) exited non-zero. Decide how to proceed.`);
    } else {
      enqueue(line, `VALIDATOR STOPPED - validator '${worker.name}' (checking implementor '${implName}', workerId ${implId}) was stopped. Decide how to proceed.`);
    }
  } else if (worker.status === "completed") {
    enqueue(line, `IMPLEMENTOR REPORT - '${worker.name}' (workerId ${worker.id}, vibe session ${sid}, branch ${worker.branch}) finished: ${report}.
Now give the acceptance criteria for the validation of this work.
Reply with a numbered list of criteria only. Use the imperative. If
the work needs no validation, reply with SKIP VALIDATION.`);
  } else if (timedOut) {
    enqueue(line, `WORKER TIMEOUT - worker hit the run time limit and was interrupted. Its session and its work are intact. Continue the ORIGINAL session so it can finish: POST /api/protocol/workers/${worker.id}/continue with {"prompt":"Finish the work from where the run was interrupted. Then report."}. After it completes, the validation loop runs as usual.`);
  } else if (worker.status === "failed") {
    enqueue(line, `WORKER FAILURE - '${worker.name}' (workerId ${worker.id}, session ${sid}): vibe exited non-zero. Decide whether to restart it with a corrected prompt (new name, e.g. ${worker.name}-2) or to proceed without it.`);
  } else {
    enqueue(line, `WORKER STOPPED - '${worker.name}' (workerId ${worker.id}, session ${sid}) was stopped (user request or timeout). Decide whether to restart it with an updated prompt (new name) or to proceed.`);
  }
}

function spawnValidator(line, implWorker, criteria) {
  let name = `validator-${implWorker.name}`;
  let n = 2;
  while ([...line.workers.values()].some((w) => w.name === name)) {
    name = `validator-${implWorker.name}-${n++}`;
  }
  const id = crypto.randomUUID();
  const repo = resolveRepo(line, implWorker.repo);
  const repoName = repo ? repo.name : "primary";
  const repoUrl = repo ? repo.url : null;
  const worker = { id, lineId: line.id, name,
    role: "validator", validates: implWorker.id, persona: implWorker.persona || "backend",
    kind: "standard", repo: repoName,
    prompt: validatorBrief(implWorker.name, reportText(implWorker.transcript), criteria,
      implWorker.persona || "backend", id, implWorker.id, line.id, repoName, repoUrl),
    sessionId: null, worktreePath: implWorker.worktreePath, branch: implWorker.branch,
    status: "running", stopRequested: false, child: null, transcript: [] };
  line.workers.set(id, worker);
  saveLine(line);
  slog("info", "validator.spawned", { lineId: line.id, validatorId: id,
    implementorId: implWorker.id, persona: worker.persona });
  broadcast(line, "worker_spawned", { worker: { id, name, branch: worker.branch,
    status: worker.status, role: worker.role, validates: worker.validates,
    persona: worker.persona } });
  spawnWorker(line, worker, worker.prompt, VAL_MODEL);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);
  const t0 = Date.now();
  res.on("finish", () => slog("info", "http", {
    method: req.method, path: url.pathname, status: res.statusCode,
    ms: Date.now() - t0,
  }));

  if (req.method === "POST" && url.pathname === "/api/lines") {
    readBody(req, (err, body) => {
      body = body || {};
      if (err) return json(res, 400, { error: "invalid JSON" });
      const name = typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : `Draft line ${[...lines.values()].filter((l) => /^Draft line/.test(l.name)).length + 1}`;
      const repoUrl = typeof body.repoUrl === "string" && body.repoUrl.trim()
        ? body.repoUrl.trim() : null;
      const id = crypto.randomUUID();
      const workdir = path.join(LINES_DIR, id);
      if (repoUrl) {
        const clone = spawnSync("git", ["clone", repoUrl, workdir], { encoding: "utf8" });
        if (clone.error) return json(res, 500, { error: `git is not available: ${clone.error.message}` });
        if (clone.status !== 0) return json(res, 500, { error: "git clone failed", stderr: clone.stderr });
      } else {
        fs.mkdirSync(workdir, { recursive: true });
        const init = spawnSync("git", ["-C", workdir, "init"], { encoding: "utf8" });
        if (init.error) return json(res, 500, { error: `git is not available: ${init.error.message}` });
        if (init.status !== 0) return json(res, 500, { error: "git init failed", stderr: init.stderr });
        const head = spawnSync("git", ["-C", workdir, "rev-parse", "--verify", "HEAD"], { encoding: "utf8" });
        if (head.status !== 0) {
          const commit = spawnSync("git", ["-C", workdir, "-c", "user.name=router", "-c", "user.email=router@localhost",
            "commit", "--allow-empty", "-m", "init"], { encoding: "utf8" });
          if (commit.status !== 0) return json(res, 500, { error: "git commit failed", stderr: commit.stderr });
        }
      }
      const line = { id, name, sessionId: null, workdir, status: "standby",
        repoUrl, started: false, planApproved: false, workers: new Map(),
        repos: new Map(),
        inventory: new Map(),
        queue: [], clients: new Set(), transcript: [] };
      lines.set(id, line);
      saveLine(line);
      slog("info", "line.created", { lineId: id, name, repoUrl });
      json(res, 201, { id, name });
    });
    return;
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "lines" && parts[3] === "prompts") {
    const line = lines.get(parts[2]);
    if (!line) return json(res, 404, { error: "no such line" });
    readBody(req, (err, body) => {
      if (err || !body || typeof body.text !== "string" || !body.text.trim()) {
        return json(res, 400, { error: "expected {text}" });
      }
      let text = body.text;
      let kind = "plain";
      if (!line.started) {
        line.started = true;
        kind = "initial";
        text = plannerBrief(line.name, line.id, body.text, PORT);
      } else if (!line.planApproved) {
        try {
          fs.accessSync(path.join(line.workdir, "plan.md"));
          kind = "feedback";
          text = `PLAN FEEDBACK from the user: ${body.text}. Revise plan.md accordingly. Do not spawn workers yet.`;
        } catch {}
      }
      line.queue.push({ text });
      const position = line.queue.length;
      slog("info", "line.prompt", { lineId: line.id, kind, chars: text.length,
        prompt: preview(body.text, 2000) });
      pump(line);
      json(res, 202, { queued: true, position });
    });
    return;
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "lines" && parts[3] === "plan") {
    const line = lines.get(parts[2]);
    if (!line) return json(res, 404, { error: "no such line" });
    let content = null;
    try { content = fs.readFileSync(path.join(line.workdir, "plan.md"), "utf8"); } catch {}
    return json(res, 200, { exists: content !== null, approved: line.planApproved, content });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "lines" && parts[3] === "approve") {
    const line = lines.get(parts[2]);
    if (!line) return json(res, 404, { error: "no such line" });
    line.planApproved = true;
    saveLine(line);
    enqueue(line, "PLAN APPROVED by the user. Spawn your implementor workers now per the plan and the protocol. After spawning, end your turn and wait for worker reports.");
    slog("info", "line.approved", { lineId: line.id });
    return json(res, 202, { approved: true });
  }

  if (req.method === "DELETE" && parts[0] === "api" && parts[1] === "lines" && parts.length === 3) {
    const line = lines.get(parts[2]);
    if (!line) return json(res, 404, { error: "no such line" });
    line.deleted = true;
    line.queue.length = 0;
    const runningWorkers = [...line.workers.values()].filter((w) => w.child).length;
    if (line.child) line.child.kill("SIGTERM");
    slog("info", "line.delete", { lineId: line.id, runningWorkers,
      plannerKilled: !!line.child });
    for (const w of line.workers.values()) {
      if (w.child) {
        w.stopRequested = true;
        w.child.kill("SIGTERM");
      }
      if (uiSlots.held.has(w.id) || uiSlots.waiters.some((x) => x.workerId === w.id)) {
        releaseUiSlot(w.id);
      }
    }
    const keptRefs = new Set([...line.inventory.values()]
      .filter((i) => i.keep && i.kind === "container").map((i) => i.ref));
    dockerRun(["ps", "-aq", "--filter", `label=cuck.line=${line.id}`, "--format", "{{.ID}}"],
      (out) => {
        if (!out) return;
        const kill = out.split(/\s+/).filter((c) => c && !keptRefs.has(c));
        if (kill.length) dockerRun(["rm", "-fv", ...kill]);
      });
    for (const item of line.inventory.values()) {
      if (item.keep) continue;
      if (item.kind === "process" && item.status === "running") {
        try { process.kill(item.ref, "SIGTERM"); } catch {}
        item.status = "stopped";
      }
    }
    for (const res2 of line.clients) { try { res2.end(); } catch {} }
    line.clients.clear();
    lines.delete(line.id);
    for (const p of [line.workdir, path.join(LINES_DIR, "worktrees", line.id)]) {
      try { fs.rmSync(p, { recursive: true, force: true }); } catch {}
    }
    return json(res, 202, { deleted: true });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "protocol" && parts[2] === "lines"
    && parts[4] === "inventory") {
    const line = lines.get(parts[3]);
    if (!line) return json(res, 404, { error: "no such line" });
    readBody(req, (err, body) => {
      if (err || !body || body.kind !== "process" || !Number.isInteger(body.pid)
        || typeof body.name !== "string" || !body.name.trim()) {
        return json(res, 400, { error: "expected {kind: 'process', pid, name}" });
      }
      try { process.kill(body.pid, 0); } catch {
        return json(res, 400, { error: "no such process" });
      }
      const id = crypto.randomUUID();
      line.inventory.set(id, { id, kind: "process", name: body.name.trim(),
        by: typeof body.worker === "string" ? body.worker : "planner",
        ref: body.pid, keep: false, status: "running", startedAt: Date.now() });
      saveLine(line);
      slog("info", "inventory.registered", { lineId: line.id, itemId: id,
        kind: "process", pid: body.pid, name: body.name.trim() });
      json(res, 201, { itemId: id });
    });
    return;
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "lines" && parts[3] === "inventory") {
    const line = lines.get(parts[2]);
    if (!line) return json(res, 404, { error: "no such line" });
    return reconcileInventory(line, () =>
      json(res, 200, { items: [...line.inventory.values()] }));
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "lines" && parts[3] === "inventory"
    && parts[4] === "kill-all") {
    const line = lines.get(parts[2]);
    if (!line) return json(res, 404, { error: "no such line" });
    let n = 0;
    for (const item of line.inventory.values()) {
      if (!item.keep && killItem(item)) n += 1;
    }
    saveLine(line);
    slog("info", "inventory.killall", { lineId: line.id, killed: n });
    return json(res, 202, { killed: n });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "lines" && parts[3] === "inventory"
    && (parts[5] === "kill" || parts[5] === "keep")) {
    const line = lines.get(parts[2]);
    if (!line) return json(res, 404, { error: "no such line" });
    const item = line.inventory.get(parts[4]);
    if (!item) return json(res, 404, { error: "no such item" });
    if (parts[5] === "keep") {
      return readBody(req, (err, body) => {
        if (err || !body) return json(res, 400, { error: "expected {keep}" });
        item.keep = !!body.keep;
        saveLine(line);
        slog("info", "inventory.keep", { lineId: line.id, itemId: item.id,
          name: item.name, keep: item.keep });
        json(res, 202, { keep: item.keep });
      });
    }
    killItem(item);
    saveLine(line);
    return json(res, 202, { killed: true });
  }

  if (parts[0] === "api" && parts[1] === "protocol" && parts[2] === "lines"
    && parts[4] === "repos" && (req.method === "GET" || req.method === "POST")) {
    const line = lines.get(parts[3]);
    if (!line) return json(res, 404, { error: "no such line" });
    if (req.method === "GET") {
      return json(res, 200, { repos: repoList(line).map((r) => ({
        name: r.name, url: r.url, path: r.path })) });
    }
    readBody(req, (err, body) => {
      if (err || !body || typeof body.name !== "string" || !body.name.trim()
        || typeof body.url !== "string" || !body.url.trim()) {
        return json(res, 400, { error: "expected {name, url}" });
      }
      const name = body.name.trim();
      const sName = sanitizeName(name);
      if (!sName || sName === "primary") {
        return json(res, 400, { error: "repo name must contain [a-zA-Z0-9-] and must not be 'primary'" });
      }
      if (!line.repos) line.repos = new Map();
      if (line.repos.has(sName)) {
        return json(res, 409, { error: `repo '${sName}' is already registered` });
      }
      const dest = path.join(LINES_DIR, line.id, "repos", sName);
      const clone = spawnSync("git", ["clone", body.url.trim(), dest], { encoding: "utf8" });
      if (clone.error) return json(res, 500, { error: `git is not available: ${clone.error.message}` });
      if (clone.status !== 0) return json(res, 500, { error: "git clone failed", stderr: clone.stderr });
      line.repos.set(sName, { name: sName, url: body.url.trim(), path: dest });
      saveLine(line);
      slog("info", "repo.registered", { lineId: line.id, name: sName, url: body.url.trim() });
      json(res, 201, { name: sName, path: dest });
    });
    return;
  }

  if (parts[0] === "api" && parts[1] === "protocol" && parts[2] === "lines" && parts[4] === "workers"
    && (req.method === "GET" || req.method === "POST")) {
    const line = lines.get(parts[3]);
    if (!line) return json(res, 404, { error: "no such line" });
    if (req.method === "GET") {
      return json(res, 200, { workers: [...line.workers.values()].map((w) => ({
        id: w.id, name: w.name, status: w.status, sessionId: w.sessionId, branch: w.branch,
        role: w.role, validates: w.validates, persona: w.persona || "backend",
        kind: w.kind || "standard", verdict: w.verdict || null,
      })) });
    }
    if (!line.planApproved) return json(res, 409, { error: "plan not approved" });
    readBody(req, (err, body) => {
      if (err || !body || typeof body.name !== "string" || !body.name
        || typeof body.prompt !== "string") {
        return json(res, 400, { error: "expected {name, prompt}" });
      }
      const persona = body.persona === undefined || body.persona === null
        ? "backend" : body.persona;
      if (!PERSONAS.includes(persona)) {
        return json(res, 400, { error: `persona must be one of: ${PERSONAS.join(", ")}` });
      }
      const repoName = body.repo === undefined || body.repo === null || body.repo === ""
        ? "primary" : body.repo;
      const repo = resolveRepo(line, repoName);
      if (!repo) {
        return json(res, 404, { error: `no such repo: '${repoName}'. Register it first with POST /api/protocol/lines/${line.id}/repos` });
      }
      for (const w of line.workers.values()) {
        if (w.name === body.name) return json(res, 409, { error: `worker '${body.name}' already exists` });
      }
      if (line.workers.size >= WORKER_CAP) {
        return json(res, 409, { error: `worker cap reached (${WORKER_CAP})` });
      }
      const sName = sanitizeName(body.name);
      if (!sName) return json(res, 400, { error: "worker name must contain [a-zA-Z0-9-]" });
      const id = crypto.randomUUID();
      const branch = `${line.id.slice(0, 8)}/${sName}`;
      const worktreePath = repo.name === "primary"
        ? path.join(LINES_DIR, "worktrees", line.id, sName)
        : path.join(LINES_DIR, "worktrees", line.id, repo.name, sName);
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      const wt = spawnSync("git", ["-C", repo.path, "worktree", "add", "-b", branch, worktreePath],
        { encoding: "utf8" });
      if (wt.error) return json(res, 500, { error: `git is not available: ${wt.error.message}` });
      if (wt.status !== 0) return json(res, 500, { error: "git worktree add failed", stderr: wt.stderr });
      const worker = { id, lineId: line.id, name: body.name,
        role: "implementor", validates: null, persona, kind: "standard", repo: repo.name,
        prompt: workerBrief(body.name, line.name, body.prompt, persona, id, line.id, repo),
        sessionId: null, worktreePath, branch, status: "running", stopRequested: false,
        child: null, transcript: [] };
      line.workers.set(id, worker);
      saveLine(line);
      slog("info", "worker.spawned", { lineId: line.id, workerId: id,
        name: body.name, persona, branch, repo: repo.name, repoUrl: repo.url || undefined });
      spawnWorker(line, worker, worker.prompt, IMPL_MODEL);
      broadcast(line, "worker_spawned", { worker: { id, name: worker.name, branch, status: worker.status, role: worker.role, validates: null, persona, repo: repo.name } });
      json(res, 201, { workerId: id, branch, worktree: worktreePath, repo: repo.name });
    });
    return;
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "protocol" && parts[2] === "workers"
    && parts[4] === "stop") {
    let line = null, worker = null;
    for (const l of lines.values()) {
      const w = l.workers.get(parts[3]);
      if (w) { line = l; worker = w; break; }
    }
    if (!worker) return json(res, 404, { error: "no such worker" });
    slog("info", "worker.stop", { lineId: line.id, workerId: worker.id,
      name: worker.name, role: worker.role, wasRunning: !!worker.child });
    if (worker.child) {
      worker.stopRequested = true;
      worker.child.kill("SIGTERM");
    } else {
      const sid = worker.sessionId || "unknown";
      enqueue(line, `WORKER STOPPED - '${worker.name}' (workerId ${worker.id}, session ${sid}) was stopped (user request or timeout). Decide whether to restart it with an updated prompt (new name) or to proceed.`);
    }
    return json(res, 202, { stopped: true });
  }

  function findWorker(id) {
    for (const l of lines.values()) {
      const w = l.workers.get(id);
      if (w) return w;
    }
    return null;
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "protocol" && parts[2] === "workers"
    && parts[4] === "port") {
    const worker = findWorker(parts[3]);
    if (!worker) return json(res, 404, { error: "no such worker" });
    return json(res, 200, { port: portFor(worker.id) });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "protocol" && parts[2] === "workers"
    && parts[4] === "uitest" && parts.length === 5) {
    const worker = findWorker(parts[3]);
    if (!worker) return json(res, 404, { error: "no such worker" });
    if (worker.status !== "running") {
      return json(res, 409, { error: "worker is not running" });
    }
    if (uiSlots.held.has(worker.id)) return json(res, 200, { acquired: true, already: true });
    if (uiSlots.held.size < UI_TEST_SLOTS) {
      uiSlots.held.add(worker.id);
      slog("info", "slot.acquired", { workerId: worker.id, waited: false });
      return json(res, 200, { acquired: true });
    }
    const waiter = { workerId: worker.id, res,
      timer: setTimeout(() => {
        const i = uiSlots.waiters.indexOf(waiter);
        if (i !== -1) uiSlots.waiters.splice(i, 1);
        json(res, 408, { error: "timeout acquiring UI test slot - wait and try again" });
      }, 120000) };
    uiSlots.waiters.push(waiter);
    slog("info", "slot.waiting", { workerId: worker.id, waiters: uiSlots.waiters.length });
    return;
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "protocol" && parts[2] === "workers"
    && parts[4] === "uitest" && parts[5] === "release") {
    const worker = findWorker(parts[3]);
    if (!worker) return json(res, 404, { error: "no such worker" });
    releaseUiSlot(worker.id);
    return json(res, 202, { released: true });
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "protocol" && parts[2] === "lines"
    && parts[4] === "integration") {
    const line = lines.get(parts[3]);
    if (!line) return json(res, 404, { error: "no such line" });
    if (!line.planApproved) return json(res, 409, { error: "plan not approved" });
    readBody(req, (err, body) => {
      if (err || !body || typeof body.prompt !== "string" || !body.prompt.trim()) {
        return json(res, 400, { error: "expected {prompt}" });
      }
      const branchEntries = [...line.workers.values()]
        .filter((w) => w.role === "implementor" && w.kind !== "integration")
        .map((w) => ({ repo: w.repo || "primary", branch: w.branch }));
      if (!branchEntries.length) return json(res, 409, { error: "no feature branches to integrate" });
      let name = "integration-validator";
      let n = 2;
      while ([...line.workers.values()].some((w) => w.name === name)) {
        name = `integration-validator-${n++}`;
      }
      const id = crypto.randomUUID();
      const worktreePath = path.join(LINES_DIR, "worktrees", line.id,
        sanitizeName(name) + "-" + id.slice(0, 8));
      const branch = `integration/${sanitizeName(name)}-${id.slice(0, 8)}`;
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      const wt = spawnSync("git", ["-C", line.workdir, "worktree", "add", "-b", branch, worktreePath, "HEAD"],
        { encoding: "utf8" });
      if (wt.error) return json(res, 500, { error: `git is not available: ${wt.error.message}` });
      if (wt.status !== 0) return json(res, 500, { error: "git worktree add failed", stderr: wt.stderr });
      const worker = { id, lineId: line.id, name, kind: "integration",
        role: "validator", validates: null, persona: "backend", repo: "primary",
        prompt: integrationValidatorBrief(line, branchEntries, body.prompt, id, repoList(line)),
        sessionId: null, worktreePath, branch, status: "running", stopRequested: false,
        child: null, transcript: [] };
      line.workers.set(id, worker);
      saveLine(line);
      slog("info", "integration.spawned", { lineId: line.id, validatorId: id,
        branches: branchEntries.map((e) => `${e.repo}:${e.branch}`) });
      broadcast(line, "worker_spawned", { worker: { id, name, branch, status: worker.status,
        role: worker.role, validates: null, persona: worker.persona, kind: "integration" } });
      spawnWorker(line, worker, worker.prompt, VAL_MODEL);
      json(res, 201, { validatorId: id, branch,
        branches: branchEntries.map((e) => ({ repo: e.repo, branch: e.branch })),
        worktree: worktreePath });
    });
    return;
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "protocol" && parts[2] === "workers"
    && parts[4] === "evidence") {
    let line = null, worker = null;
    for (const l of lines.values()) {
      const w = l.workers.get(parts[3]);
      if (w) { line = l; worker = w; break; }
    }
    if (!worker) return json(res, 404, { error: "no such worker" });
    readBody(req, (err, body) => {
      if (err || !body || typeof body.useCase !== "string" || !body.useCase.trim()
        || typeof body.file !== "string" || !body.file.trim()) {
        return json(res, 400, { error: "expected {useCase, file}" });
      }
      const abs = path.resolve(worker.worktreePath, body.file.trim());
      if (!abs.startsWith(path.resolve(worker.worktreePath))) {
        return json(res, 400, { error: "file must be inside your workdir" });
      }
      if (!fs.existsSync(abs)) return json(res, 400, { error: "no such file: " + body.file });
      const stat = fs.statSync(abs);
      if (stat.size === 0) return json(res, 400, { error: "video file is empty (0 bytes) - recording was never finalized. Close the browser context before registering." });
      if (stat.size < 1024) return json(res, 400, { error: "video file is suspiciously small (" + stat.size + " bytes) - register only finalized recordings" });
      const id = crypto.randomUUID();
      if (!line.evidence) line.evidence = new Map();
      line.evidence.set(id, { id, useCase: body.useCase.trim(), path: abs,
        name: path.basename(abs), by: worker.id, at: Date.now() });
      saveLine(line);
      slog("info", "evidence.registered", { lineId: line.id, evidenceId: id,
        useCase: preview(body.useCase, 120), file: body.file.trim(), by: worker.name });
      json(res, 201, { evidenceId: id });
    });
    return;
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "lines" && parts[3] === "evidence"
    && parts.length === 4) {
    const line = lines.get(parts[2]);
    if (!line) return json(res, 404, { error: "no such line" });
    const items = [...(line.evidence || new Map()).values()].map((e) => ({
      id: e.id, useCase: e.useCase, name: e.name, at: e.at,
      video: `/api/lines/${line.id}/evidence/${e.id}/video`,
    }));
    return json(res, 200, { items });
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "lines" && parts[3] === "evidence"
    && parts.length === 6 && parts[5] === "video") {
    const line = lines.get(parts[2]);
    if (!line) return json(res, 404, { error: "no such line" });
    const item = (line.evidence || new Map()).get(parts[4]);
    if (!item) return json(res, 404, { error: "no such evidence" });
    if (!fs.existsSync(item.path)) return json(res, 404, { error: "evidence file is gone" });
    const size = fs.statSync(item.path).size;
    const range = req.headers.range;
    if (range) {
      const m = range.match(/bytes=(\d+)-(\d*)/);
      const start = m ? Number(m[1]) : 0;
      const end = (m && m[2]) ? Math.min(Number(m[2]), size - 1) : size - 1;
      if (start >= size) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, {
        "Content-Type": "video/webm",
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
      });
      fs.createReadStream(item.path, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "video/webm",
      "Content-Length": size,
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-cache",
    });
    fs.createReadStream(item.path).pipe(res);
    return;
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "protocol" && parts[2] === "workers"
    && parts[4] === "continue") {
    let line = null, worker = null;
    for (const l of lines.values()) {
      const w = l.workers.get(parts[3]);
      if (w) { line = l; worker = w; break; }
    }
    if (!worker) return json(res, 404, { error: "no such worker" });
    if (worker.role === "validator") {
      return json(res, 409, { error: "validators are fresh each run - spawn a new task instead" });
    }
    if (worker.child) return json(res, 409, { error: "worker is currently running" });
    for (const w of line.workers.values()) {
      if (w.role === "validator" && w.validates === worker.id && w.status === "running") {
        return json(res, 409, { error: "a validator is still checking this implementor" });
      }
    }
    if (!worker.sessionId) return json(res, 409, { error: "worker has no session yet" });
    readBody(req, (err, body) => {
      if (err || !body || typeof body.prompt !== "string" || !body.prompt.trim()) {
        return json(res, 400, { error: "expected {prompt}" });
      }
      const prompt = `Follow-up instructions from the planner (write them in ASD-STE100):
${body.prompt}

When done, reply with a report: what you changed, files changed, how you verified it, open issues. That report goes back to the planner verbatim.`;
      worker.status = "running";
      worker.stopRequested = false;
      broadcast(line, "worker_status", { workerId: worker.id, status: "running" });
      saveLine(line);
      slog("info", "worker.continued", { lineId: line.id, workerId: worker.id,
        chars: body.prompt.length, prompt: preview(body.prompt, 400) });
      spawnWorker(line, worker, prompt, IMPL_MODEL, true);
      json(res, 202, { queued: true });
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/lines") {
    return json(res, 200, { lines: [...lines.values()].map((l) => ({
      id: l.id, name: l.name, status: l.status, queueDepth: l.queue.length,
      sessionId: l.sessionId, started: l.started, workers: l.workers.size,
    })) });
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "lines" && parts[3] === "events") {
    const line = lines.get(parts[2]);
    if (!line) return json(res, 404, { error: "no such line" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
      "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    line.clients.add(res);
    slog("info", "sse.open", { lineId: line.id, clients: line.clients.size });
    sseSend(res, "state", { id: line.id, name: line.name, status: line.status,
      sessionId: line.sessionId, started: line.started,
      transcript: line.transcript.slice(-50),
      planApproved: line.planApproved,
      workers: [...line.workers.values()].map((w) => ({
        id: w.id, name: w.name, status: w.status, branch: w.branch, role: w.role,
        validates: w.validates, persona: w.persona || "backend", kind: w.kind || "standard",
        verdict: w.verdict || null,
      })) });
    req.on("close", () => {
      line.clients.delete(res);
      slog("info", "sse.close", { lineId: line.id, clients: line.clients.size });
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    try {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fs.readFileSync(INDEX_HTML));
    } catch {
      return json(res, 404, { error: "not found" });
    }
    return;
  }

  json(res, 404, { error: "not found" });
});

setInterval(() => {
  for (const line of lines.values()) {
    for (const res of line.clients) {
      try { res.write(": ping\n\n"); } catch {}
    }
  }
}, 25000).unref();

function shutdown() {
  slog("info", "server.shutdown", { lines: lines.size });
  for (const line of lines.values()) {
    if (line.child) line.child.kill("SIGTERM");
    for (const w of line.workers.values()) if (w.child) w.child.kill("SIGTERM");
    for (const res of line.clients) res.end();
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function loadLines() {
  fs.mkdirSync(LINES_DIR, { recursive: true });
  for (const entry of fs.readdirSync(LINES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(LINES_DIR, entry.name, "line.json"), "utf8"));
      const workers = new Map();
      for (const w of meta.workers || []) {
        if (w.role === "validator") continue;
        workers.set(w.id, { id: w.id, lineId: meta.id, name: w.name,
          role: w.role === "validator" && w.kind === "integration" ? "validator" : "implementor",
          validates: null, prompt: null, kind: w.kind || "standard", verdict: w.verdict || null,
          persona: PERSONAS.includes(w.persona) ? w.persona : "backend",
          repo: w.repo || "primary",
          sessionId: w.sessionId,
          worktreePath: w.worktreePath
            || path.join(LINES_DIR, "worktrees", meta.id, sanitizeName(w.name)),
          branch: w.branch, status: w.status === "running" ? "stopped" : w.status,
          stopRequested: false, child: null, transcript: [] });
      }
      for (const w of meta.workers || []) {
        if (w.role !== "validator") continue;
        const impl = workers.get(w.validates);
        if (!impl && w.kind !== "integration") continue;
        workers.set(w.id, { id: w.id, lineId: meta.id, name: w.name,
          role: "validator", validates: w.validates, prompt: null, kind: w.kind || "standard", verdict: w.verdict || null,
          persona: PERSONAS.includes(w.persona) ? w.persona : "backend",
          repo: w.repo || (impl ? impl.repo : "primary"),
          sessionId: w.sessionId,
          worktreePath: w.worktreePath
            || (impl ? impl.worktreePath
              : path.join(LINES_DIR, "worktrees", meta.id, sanitizeName(w.name))),
          branch: w.branch,
          status: w.status === "running" ? "stopped" : w.status,
          stopRequested: false, child: null, transcript: [] });
      }
      const started = meta.started === true || !!meta.sessionId;
      const inventory = new Map();
      for (const i of meta.inventory || []) {
        inventory.set(i.id, { id: i.id, kind: i.kind, name: i.name, by: i.by,
          ref: i.ref, keep: !!i.keep, status: "stopped" });
      }
      const line = { id: meta.id, name: meta.name, sessionId: meta.sessionId,
        repoUrl: meta.repoUrl || null,
        repos: new Map((meta.repos || []).map((r) => [r.name,
          { name: r.name, url: r.url, path: r.path }])),
        workdir: path.join(LINES_DIR, entry.name),
        status: started ? "idle" : "standby", queue: [],
        started,
        planApproved: meta.planApproved === true, workers, inventory,
        evidence: new Map((meta.evidence || []).map((e) => [e.id, e])),
        clients: new Set(), transcript: [] };
      lines.set(meta.id, line);
      const hadRunning = (meta.workers || []).some((w) => w.status === "running");
      if (hadRunning) {
        slog("info", "boot.stale-running", { lineId: meta.id,
          workers: (meta.workers || []).filter((w) => w.status === "running").map((w) => w.name) });
        saveLine(line);
      }
    } catch {}
  }
}

loadLines();
sweepWorkerContainers();
removeContainers("label=cuck.line");
slog("info", "server.boot", { lines: lines.size,
  workers: [...lines.values()].reduce((n, l) => n + l.workers.size, 0),
  port: PORT, logMaxBytes: LOG_MAX_BYTES, logKeep: LOG_KEEP });
server.listen(PORT, () => slog("info", "server.listen", { port: PORT }));
