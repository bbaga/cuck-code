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
     -d '{"name":"<worker-name>","prompt":"<full instructions>"}'
   Rules: spawn independent tasks in parallel (several curl calls);
   worker prompts must be SELF-CONTAINED (workers share no context
   with you): include the repo state, the task, file paths, acceptance
   criteria, and that they must commit their work in their worktree.
   Worker names are unique per line. After spawning, end your turn and
   wait: worker completions arrive as new prompts (WORKER REPORT...).
4. On each WORKER REPORT / FAILURE / STOPPED prompt: assess, then
   decide and act - spawn follow-up workers, restart a failed task
   under a NEW name with a corrected prompt, or conclude. You may call
   GET http://localhost:${port}/api/protocol/lines/${lineId}/workers to
   check statuses. Never invent worker results you were not told.`;
}

function workerBrief(name, lineName, prompt) {
  return `You are implementor worker '${name}' on factory line '${lineName}'.
You run inside your own git worktree - all work happens here, do not
touch other directories. Commit your work with clear messages.

Task from the planner:
${prompt}

When done, reply with a concise report: what you implemented, files
changed, how you verified it, and any open issues. That report goes
back to the planner verbatim.`;
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
        planApproved: line.planApproved,
        workers: [...line.workers.values()].map((w) => ({
          id: w.id, name: w.name, sessionId: w.sessionId, branch: w.branch, status: w.status,
        })) }));
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

function pump(line) {
  if (line.status === "running" || line.queue.length === 0) return;
  const { text } = line.queue.shift();
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
    }
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

function spawnWorker(line, worker) {
  const args = ["--workdir", worker.worktreePath, "--trust", "--agent", "accept-edits",
    "--output", "streaming", "--time-limit", "900"];
  if (AUTO_APPROVE) args.push("--auto-approve");
  args.push("-p", worker.prompt);
  const child = spawn("vibe", args, { stdio: ["ignore", "pipe", "pipe"] });
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
  if (worker.status === "completed") {
    enqueue(line, `WORKER REPORT - '${worker.name}' (workerId ${worker.id}, vibe session ${sid}, branch ${worker.branch}) finished: ${reportText(worker.transcript)}`);
  } else if (worker.status === "failed") {
    enqueue(line, `WORKER FAILURE - '${worker.name}' (workerId ${worker.id}, session ${sid}): vibe exited non-zero. Decide whether to restart it with a corrected prompt (new name, e.g. ${worker.name}-2) or to proceed without it.`);
  } else {
    enqueue(line, `WORKER STOPPED - '${worker.name}' (workerId ${worker.id}, session ${sid}) was stopped (user request or timeout). Decide whether to restart it with an updated prompt (new name) or to proceed.`);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "POST" && url.pathname === "/api/lines") {
    readBody(req, (err, body) => {
      if (err || !body || typeof body.name !== "string" || typeof body.prompt !== "string") {
        return json(res, 400, { error: "expected {name, prompt}" });
      }
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
      const line = { id, name: body.name, sessionId: null, workdir, status: "idle",
        planApproved: false, workers: new Map(),
        queue: [{ text: plannerBrief(body.name, id, body.prompt, PORT) }],
        clients: new Set(), transcript: [] };
      lines.set(id, line);
      saveLine(line);
      pump(line);
      json(res, 201, { id });
    });
    return;
  }

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "lines" && parts[3] === "prompts") {
    const line = lines.get(parts[2]);
    if (!line) return json(res, 404, { error: "no such line" });
    readBody(req, (err, body) => {
      if (err || !body || typeof body.text !== "string") return json(res, 400, { error: "expected {text}" });
      line.queue.push({ text: body.text });
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

  if (req.method === "POST" && parts[0] === "api" && parts[1] === "lines" && parts[3] === "feedback") {
    const line = lines.get(parts[2]);
    if (!line) return json(res, 404, { error: "no such line" });
    readBody(req, (err, body) => {
      if (err || !body || typeof body.text !== "string" || !body.text.trim()) {
        return json(res, 400, { error: "expected {text}" });
      }
      enqueue(line, `PLAN FEEDBACK from the user: ${body.text}. Revise plan.md accordingly. Do not spawn workers yet.`);
      json(res, 202, { queued: true });
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
      })) });
    }
    if (!line.planApproved) return json(res, 409, { error: "plan not approved" });
    readBody(req, (err, body) => {
      if (err || !body || typeof body.name !== "string" || !body.name
        || typeof body.prompt !== "string") {
        return json(res, 400, { error: "expected {name, prompt}" });
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
        prompt: workerBrief(body.name, line.name, body.prompt),
        sessionId: null, worktreePath, branch, status: "running", stopRequested: false,
        child: null, transcript: [] };
      line.workers.set(id, worker);
      saveLine(line);
      spawnWorker(line, worker);
      broadcast(line, "worker_spawned", { worker: { id, name: worker.name, branch, status: worker.status } });
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

  if (req.method === "GET" && url.pathname === "/api/lines") {
    return json(res, 200, { lines: [...lines.values()].map((l) => ({
      id: l.id, name: l.name, status: l.status, queueDepth: l.queue.length,
      sessionId: l.sessionId, workers: l.workers.size,
    })) });
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "lines" && parts[3] === "events") {
    const line = lines.get(parts[2]);
    if (!line) return json(res, 404, { error: "no such line" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
      "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    line.clients.add(res);
    sseSend(res, "state", { id: line.id, name: line.name, status: line.status,
      sessionId: line.sessionId, transcript: line.transcript.slice(-50),
      planApproved: line.planApproved,
      workers: [...line.workers.values()].map((w) => ({
        id: w.id, name: w.name, status: w.status, branch: w.branch,
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
        workers.set(w.id, { id: w.id, lineId: meta.id, name: w.name, prompt: null,
          sessionId: w.sessionId, worktreePath: path.join(LINES_DIR, "worktrees", meta.id, sanitizeName(w.name)),
          branch: w.branch, status: w.status === "running" ? "stopped" : w.status,
          stopRequested: false, child: null, transcript: [] });
      }
      lines.set(meta.id, { id: meta.id, name: meta.name, sessionId: meta.sessionId,
        workdir: path.join(LINES_DIR, entry.name), status: "idle", queue: [],
        planApproved: meta.planApproved === true, workers,
        clients: new Set(), transcript: [] });
    } catch {}
  }
}

loadLines();
server.listen(PORT, () => console.log(`router listening on http://localhost:${PORT}`));
