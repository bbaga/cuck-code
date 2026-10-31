"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const rendererPath = path.resolve(__dirname, "../../web/markdown-renderer.js");
const renderer = fs.readFileSync(rendererPath);
const page = Buffer.from(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Markdown fixture</title><link rel="icon" href="data:,fixture"></head>
<body><main id="markdown-root" aria-label="Markdown preview"></main>
<script src="/web/markdown-renderer.js"></script>
<script>
window.renderFixture = function (source) {
  var root = document.getElementById("markdown-root");
  while (root.firstChild) root.removeChild(root.firstChild);
  root.appendChild(window.markdownRenderer.renderMarkdown(document, String(source == null ? "" : source)));
  return root;
};
</script></body></html>`);

function startMarkdownFixture({ port = 0 } = {}) {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    if (request.method !== "GET") {
      response.writeHead(404); response.end(); return;
    }
    if (request.url === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-length": page.length });
      response.end(page); return;
    }
    if (request.url === "/web/markdown-renderer.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "content-length": renderer.length });
      response.end(renderer); return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });

  return new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port }, () => {
      server.removeListener("error", onError);
      const address = server.address();
      resolve({
        url: `http://127.0.0.1:${address.port}/`,
        close: () => new Promise((done, fail) => {
          server.close(error => { if (error) fail(error); else done(); });
          for (const socket of sockets) socket.destroy();
        }),
      });
    });
  });
}

module.exports = { startMarkdownFixture };

if (require.main === module) {
  startMarkdownFixture({ port: Number(process.env.PORT || 0) }).then(({ url, close }) => {
    process.stdout.write(`${url}\nPress Ctrl-C to close the fixture.\n`);
    const shutdown = async () => { await close(); process.exit(0); };
    process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  }).catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
}
