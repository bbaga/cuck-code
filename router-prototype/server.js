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
     -d '{"name":"<worker-name>","persona":"backend|frontend","prompt":"<full instructions>"}'
   Rules: spawn independent tasks in parallel (several curl calls);
   worker prompts must be SELF-CONTAINED (workers share no context
   with you): include the repo state, the task, file paths, acceptance
   criteria, and that they must commit their work in their worktree.
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
   On VERDICT: PASS you can accept the work or plan follow-up work.
   On VERDICT: FAIL you can:
   - send follow-up instructions to the ORIGINAL implementor session
     (it keeps its worktree and its memory):
     curl -s -X POST http://localhost:${port}/api/protocol/workers/<workerId>/continue \\
       -H 'Content-Type: application/json' \\
       -d '{"prompt":"<corrected instructions>"}'
     The implementor runs again; validation repeats after it finishes.
   - or spawn a new implementor with a corrected prompt (new name).
   Use the workerId and session id given in each report.

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

const IMPL_PERSONA = {
  backend: `Your persona: backend / architecture.
Priorities:
- Keep the architecture layered and the domain logic correct.
- Keep the data model and its integrity correct. Keep API contracts
  clear and stable.
- Write error handling for every failure path you add.
- Add tests: unit tests for logic, integration tests for contracts.
Verify the work: run the build and the tests you added.`,
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

function workerBrief(name, lineName, prompt, persona) {
  return `You are implementor worker '${name}' on factory line '${lineName}'.
You run inside your own git worktree - all work happens here, do not
touch other directories. Commit your work with clear messages.

${IMPL_PERSONA[persona] || IMPL_PERSONA.backend}

Task from the planner:
${prompt}

Write your report back in ASD-STE100 Simplified Technical English: use
only approved words, keep sentences short (a maximum of 20 words), one
topic per sentence, the active voice, numbered steps for procedures,
and no idioms or jargon.

When done, reply with a concise report: what you implemented, files
changed, how you verified it, and any open issues. That report goes
back to the planner verbatim.`;
}

function validatorBrief(implName, report, criteria, persona) {
  return `You are the VALIDATOR for the work of implementor '${implName}'.
Your workdir is the implementor's git worktree. Do not change the
implementation. You check the work only.

${VAL_PERSONA[persona] || VAL_PERSONA.backend}

The implementor reported:
${report}

The planner gave these acceptance criteria:
${criteria}

Tasks:
1. Check the work against each criterion. For each criterion, record
   PASS or FAIL with one sentence of evidence.
2. You may run the code and the tests. You may run headless UI tests
   with the playwright browser tools (browser_navigate,
   browser_snapshot, browser_click, browser_type).
3. Reply with a VALIDATION REPORT: one line per criterion with PASS or
   FAIL, then a final line "VERDICT: PASS" or "VERDICT: FAIL".
Write the report in ASD-STE100 Simplified Technical English (approved
words, short sentences, one topic per sentence, active voice, no
idioms).`;
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
  try {
    fs.writeFileSync(path.join(line.workdir, "line.json"),
      JSON.stringify({ id: line.id, name: line.name, sessionId: line.sessionId,
        started: line.started, planApproved: line.planApproved,
        workers: [...line.workers.values()].map((w) => ({
          id: w.id, name: w.name, sessionId: w.sessionId, branch: w.branch, status: w.status,
          role: w.role, validates: w.validates, persona: w.persona || "backend" })) }));
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

function pump(line) {
  if (line.status === "running" || line.queue.length === 0) return;
  const { text } = line.queue.shift();
  line.lastRun = text;
  line.status = "running";
  broadcast(line, "status", { status: line.status });

  const args = line.sessionId ? ["--resume", line.sessionId] : [];
  args.push("--workdir", line.workdir, "--trust", "--agent", "accept-edits",
    "--output", "streaming", "--time-limit", "900");
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
      broadcast(line, "entry", entry);
    }
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (c) => { stderr = (stderr + c).slice(-2000); });

  child.on("close", (code) => {
    line.child = null;
    saveLine(line);
    if (code !== 0) {
      broadcast(line, "error", { message: stderr.slice(-500) || `vibe exited with code ${code}` });
      if (isWake(line.lastRun)) {
        line.wakeRetries = line.wakeRetries || {};
        const attempts = (line.wakeRetries[line.lastRun] || 0);
        if (attempts < 2) {
          line.wakeRetries[line.lastRun] = attempts + 1;
          line.queue.unshift({ text: line.lastRun });
        } else {
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
        if (!criteria.trim().toUpperCase().startsWith("SKIP VALIDATION")) {
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
  const args = resume && worker.sessionId ? ["--resume", worker.sessionId] : [];
  args.push("--workdir", worker.worktreePath, "--trust", "--agent", "accept-edits",
    "--output", "streaming", "--time-limit", "900");
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
      broadcast(line, "worker_entry", { workerId: worker.id, entry });
    }
  });

  child.on("close", (code) => workerClosed(line, worker, code));
}

function workerClosed(line, worker, code) {
  worker.child = null;
  if (worker.stopRequested) worker.status = "stopped";
  else if (code === 0) worker.status = "completed";
  else worker.status = "failed";
  broadcast(line, "worker_status", { workerId: worker.id, status: worker.status });
  saveLine(line);
  const sid = worker.sessionId || "unknown";
  const report = reportText(worker.transcript);
  if (worker.role === "validator") {
    const impl = line.workers.get(worker.validates);
    const implName = impl ? impl.name : "unknown";
    const implId = worker.validates || "unknown";
    const implSession = impl ? (impl.sessionId || "unknown") : "unknown";
    if (worker.status === "completed") {
      enqueue(line, `VALIDATION REPORT - validator '${worker.name}' checked the work of implementor '${implName}' (workerId ${implId}, vibe session ${implSession}, branch ${worker.branch}): ${report}. Decide: accept the work, send follow-up instructions to the original implementor (POST /api/protocol/workers/${implId}/continue with {"prompt": ...}), or spawn a new implementor with a corrected prompt.`);
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
  const worker = { id, lineId: line.id, name,
    role: "validator", validates: implWorker.id, persona: implWorker.persona || "backend",
    prompt: validatorBrief(implWorker.name, reportText(implWorker.transcript), criteria, implWorker.persona),
    sessionId: null, worktreePath: implWorker.worktreePath, branch: implWorker.branch,
    status: "running", stopRequested: false, child: null, transcript: [] };
  line.workers.set(id, worker);
  saveLine(line);
  broadcast(line, "worker_spawned", { worker: { id, name, branch: worker.branch,
    status: worker.status, role: worker.role, persona: worker.persona } });
  spawnWorker(line, worker, worker.prompt, VAL_MODEL);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "POST" && url.pathname === "/api/lines") {
    readBody(req, (err, body) => {
      body = body || {};
      if (err) return json(res, 400, { error: "invalid JSON" });
      const name = typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : `Draft line ${[...lines.values()].filter((l) => /^Draft line/.test(l.name)).length + 1}`;
      const id = crypto.randomUUID();
      const workdir = path.join(LINES_DIR, id);
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
      const line = { id, name, sessionId: null, workdir, status: "standby",
        started: false, planApproved: false, workers: new Map(),
        queue: [], clients: new Set(), transcript: [] };
      lines.set(id, line);
      saveLine(line);
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
      if (!line.started) {
        line.started = true;
        text = plannerBrief(line.name, line.id, body.text, PORT);
      } else if (!line.planApproved) {
        try {
          fs.accessSync(path.join(line.workdir, "plan.md"));
          text = `PLAN FEEDBACK from the user: ${body.text}. Revise plan.md accordingly. Do not spawn workers yet.`;
        } catch {}
      }
      line.queue.push({ text });
      const position = line.queue.length;
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
    return json(res, 202, { approved: true });
  }

  if (parts[0] === "api" && parts[1] === "protocol" && parts[2] === "lines" && parts[4] === "workers"
    && (req.method === "GET" || req.method === "POST")) {
    const line = lines.get(parts[3]);
    if (!line) return json(res, 404, { error: "no such line" });
    if (req.method === "GET") {
      return json(res, 200, { workers: [...line.workers.values()].map((w) => ({
        id: w.id, name: w.name, status: w.status, sessionId: w.sessionId, branch: w.branch,
        role: w.role, validates: w.validates, persona: w.persona || "backend",
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
      const worktreePath = path.join(LINES_DIR, "worktrees", line.id, sName);
      fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
      const wt = spawnSync("git", ["-C", line.workdir, "worktree", "add", "-b", branch, worktreePath],
        { encoding: "utf8" });
      if (wt.error) return json(res, 500, { error: `git is not available: ${wt.error.message}` });
      if (wt.status !== 0) return json(res, 500, { error: "git worktree add failed", stderr: wt.stderr });
      const worker = { id, lineId: line.id, name: body.name,
        role: "implementor", validates: null, persona,
        prompt: workerBrief(body.name, line.name, body.prompt, persona),
        sessionId: null, worktreePath, branch, status: "running", stopRequested: false,
        child: null, transcript: [] };
      line.workers.set(id, worker);
      saveLine(line);
      spawnWorker(line, worker, worker.prompt, IMPL_MODEL);
      broadcast(line, "worker_spawned", { worker: { id, name: worker.name, branch, status: worker.status, role: worker.role, persona } });
      json(res, 201, { workerId: id, branch, worktree: worktreePath });
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
    if (worker.child) {
      worker.stopRequested = true;
      worker.child.kill("SIGTERM");
    } else {
      const sid = worker.sessionId || "unknown";
      enqueue(line, `WORKER STOPPED - '${worker.name}' (workerId ${worker.id}, session ${sid}) was stopped (user request or timeout). Decide whether to restart it with an updated prompt (new name) or to proceed.`);
    }
    return json(res, 202, { stopped: true });
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
    sseSend(res, "state", { id: line.id, name: line.name, status: line.status,
      sessionId: line.sessionId, started: line.started,
      transcript: line.transcript.slice(-50),
      planApproved: line.planApproved,
      workers: [...line.workers.values()].map((w) => ({
        id: w.id, name: w.name, status: w.status, branch: w.branch, role: w.role,
        persona: w.persona || "backend",
      })) });
    req.on("close", () => line.clients.delete(res));
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
          role: "implementor", validates: null, prompt: null,
          persona: PERSONAS.includes(w.persona) ? w.persona : "backend",
          sessionId: w.sessionId, worktreePath: path.join(LINES_DIR, "worktrees", meta.id, sanitizeName(w.name)),
          branch: w.branch, status: w.status === "running" ? "stopped" : w.status,
          stopRequested: false, child: null, transcript: [] });
      }
      for (const w of meta.workers || []) {
        if (w.role !== "validator") continue;
        const impl = workers.get(w.validates);
        if (!impl) continue;
        workers.set(w.id, { id: w.id, lineId: meta.id, name: w.name,
          role: "validator", validates: w.validates, prompt: null,
          persona: PERSONAS.includes(w.persona) ? w.persona : "backend",
          sessionId: w.sessionId, worktreePath: impl.worktreePath, branch: w.branch,
          status: w.status === "running" ? "stopped" : w.status,
          stopRequested: false, child: null, transcript: [] });
      }
      const started = meta.started === true || !!meta.sessionId;
      lines.set(meta.id, { id: meta.id, name: meta.name, sessionId: meta.sessionId,
        workdir: path.join(LINES_DIR, entry.name),
        status: started ? "idle" : "standby", queue: [],
        started,
        planApproved: meta.planApproved === true, workers,
        clients: new Set(), transcript: [] });
    } catch {}
  }
}

loadLines();
server.listen(PORT, () => console.log(`router listening on http://localhost:${PORT}`));
