"use strict";

const BODY_MAX = 1_000_000;

class BodyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function hasBody(req) {
  return Number(req.headers["content-length"] || 0) > 0
    || req.headers["transfer-encoding"] !== undefined;
}

function isJsonType(value) {
  return String(value || "").split(";")[0].trim().toLowerCase() === "application/json";
}

// Read one JSON object. An empty body is {}. The promise settles one time.
function readJsonBody(req, maxBytes = BODY_MAX) {
  return new Promise((resolve, reject) => {
    if (hasBody(req) && !isJsonType(req.headers["content-type"])) {
      req.resume();
      reject(new BodyError(415, "Content-Type must be application/json"));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(new BodyError(status, message));
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) return fail(413, "request body is too large");
      chunks.push(chunk);
    });
    req.on("error", () => fail(400, "cannot read request body"));
    req.on("close", () => fail(400, "request closed before its body was complete"));
    req.on("end", () => {
      if (settled) return;
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {
        return fail(400, "invalid JSON");
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return fail(400, "body must be a JSON object");
      }
      settled = true;
      resolve(body);
    });
  });
}

// Run handler(null, body) one time. A body error goes to respond with its
// own status. A handler error goes to onError and never reaches the process.
function withJsonBody(req, res, handler, { respond, onError }) {
  return readJsonBody(req).then((body) => handler(null, body), (err) => {
    if (!(err instanceof BodyError)) throw err;
    respond(res, err.status, { error: err.message });
  }).catch((err) => onError(req, res, err));
}

module.exports = { BodyError, readJsonBody, withJsonBody };
