"use strict";

// The router controls agents that run with full user permissions. A request
// from a web page on another site must not reach a route.
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function allowedHosts(extra) {
  const names = String(extra || "").split(",")
    .map((name) => name.trim().toLowerCase()).filter(Boolean);
  return new Set([...LOOPBACK_HOSTS, ...names]);
}

function hostnameOf(authority) {
  try { return new URL(`http://${authority}`).hostname; } catch { return null; }
}

// Returns null when the request may continue, or { status, error } when not.
function guardRequest(req, allowed) {
  const authority = String(req.headers.host || req.headers[":authority"] || "").toLowerCase();
  const hostname = authority && hostnameOf(authority);
  if (!hostname || !allowed.has(hostname)) return { status: 403, error: "host not allowed" };
  if (SAFE_METHODS.has(req.method)) return null;
  if (req.headers["sec-fetch-site"] === "cross-site") return { status: 403, error: "cross-site request" };
  const origin = req.headers.origin;
  if (origin === undefined) return null;
  let originHost = null;
  try { originHost = new URL(origin).host; } catch {}
  if (originHost !== authority) return { status: 403, error: "origin not allowed" };
  return null;
}

module.exports = { allowedHosts, guardRequest };
