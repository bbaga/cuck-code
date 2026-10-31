"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);

// Exercise a real Git HTTP authentication failure without contacting GitHub or
// using the developer's repositories, credentials, or terminal.
test("router children fail without credentials instead of prompting for a login", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "router-git-auth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const server = http.createServer((req, res) => {
    res.writeHead(401, { "WWW-Authenticate": 'Basic realm="test"' });
    res.end("Authentication required");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const routerPath = path.resolve(__dirname, "../server.js");
  const url = `http://127.0.0.1:${server.address().port}/private.git`;
  const script = `
    require(${JSON.stringify(routerPath)});
    const { spawnSync } = require("node:child_process");
    const result = spawnSync("git", ["-c", "credential.helper=", "-c", "core.askPass=",
      "ls-remote", ${JSON.stringify(url)}], { encoding: "utf8", timeout: 3000 });
    console.log(JSON.stringify({
      prompt: process.env.GIT_TERMINAL_PROMPT,
      interactive: process.env.GCM_INTERACTIVE,
      status: result.status, stderr: result.stderr, error: result.error?.code,
    }));
    process.exit(0);
  `;
  const { stdout } = await execFileAsync(process.execPath, ["-e", script], {
    cwd: root,
    timeout: 10000,
    env: {
      ...process.env,
      HOME: root, XDG_CONFIG_HOME: root, GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: path.join(root, "no-gitconfig"),
      GIT_TERMINAL_PROMPT: "1", GCM_INTERACTIVE: "Always",
      GIT_ASKPASS: "", SSH_ASKPASS: "", LC_ALL: "C",
      LINES_DIR: path.join(root, "lines"),
    },
  });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.prompt, "0");
  assert.equal(result.interactive, "Never");
  assert.equal(result.error, undefined);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /terminal prompts disabled/);
});
