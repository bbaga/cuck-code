const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const PORT = Number(process.env.PORT || 7788);
const LINES_DIR = path.resolve(process.env.LINES_DIR || "./lines");
const INDEX_HTML = path.join(__dirname, "web", "index.html");

const lines = new Map();

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

function readBody(req, cb) {
  let data = "";
  req.on("data", (c) => { data += c; if (data.length > 1e6) req.destroy(); });
  req.on("end", () => {
    try { cb(null, JSON.parse(data || "{}")); } catch { cb(new Error("invalid JSON")); }
  });
}

function pump(line) {
  if (line.status === "running" || line.queue.length === 0) return;
  const { text } = line.queue.shift();
  line.status = "running";
  broadcast(line, "status", { status: line.status });

  const args = line.sessionId ? ["--resume", line.sessionId] : [];
  args.push("--workdir", line.workdir, "--trust", "--agent", "accept-edits",
    "--output", "streaming", "--time-limit", "900", "-p", text);
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
    if (code !== 0) {
      broadcast(line, "error", { message: stderr.slice(-500) || `vibe exited with code ${code}` });
    }
    line.status = "idle";
    broadcast(line, "status", { status: line.status });
    pump(line);
  });
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
      const line = { id, name: body.name, sessionId: null, workdir, status: "idle",
        queue: [{ text: body.prompt }], clients: new Set(), transcript: [] };
      lines.set(id, line);
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

  if (req.method === "GET" && url.pathname === "/api/lines") {
    return json(res, 200, { lines: [...lines.values()].map((l) => ({
      id: l.id, name: l.name, status: l.status, queueDepth: l.queue.length, sessionId: l.sessionId,
    })) });
  }

  if (req.method === "GET" && parts[0] === "api" && parts[1] === "lines" && parts[3] === "events") {
    const line = lines.get(parts[2]);
    if (!line) return json(res, 404, { error: "no such line" });
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache",
      "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    line.clients.add(res);
    sseSend(res, "state", { id: line.id, name: line.name, status: line.status,
      sessionId: line.sessionId, transcript: line.transcript.slice(-50) });
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
    for (const res of line.clients) res.end();
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.listen(PORT, () => console.log(`router listening on http://localhost:${PORT}`));
