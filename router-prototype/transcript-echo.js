"use strict";

function userEntry(text, at = Date.now()) {
  return { type: "message", role: "user", content: text, at };
}

function routerEntry(text, at = Date.now()) {
  return { type: "message", role: "user", origin: "router", content: text, at };
}

// Record one planner request in the transcript. A user request shows its raw
// text; any other request is a router message. `raw` is the text the user typed.
function recordRequestEntry(line, request, { append, broadcast }) {
  if (!request || typeof request.text !== "string") return null;
  const entry = request.fromUser ? userEntry(request.userText) : routerEntry(request.text);
  append(line.transcript, entry);
  broadcast(line, "entry", entry);
  return entry;
}

// The planner prompt is not an answer. Drop role user entries that a harness
// repeats from the prompt, so each message shows once.
function isPromptEcho(entry) {
  return !!entry && entry.type === "message" && entry.role === "user";
}

module.exports = { userEntry, routerEntry, recordRequestEntry, isPromptEcho };
