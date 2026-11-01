"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  DEFAULT_AUTO_TOKENS, newContextStats, restoreContextStats, recordTurn, resetForFreshSession,
  contextSize, contextView, shouldAutoCompact, parseAutoThreshold, compactionPrompt,
  acceptSummary, handoffBlock, workerReseedPrompt,
} = require("../compaction");
const { fallbackPhaseSettings, validateNodeSettings } = require("../pipeline-config");
const { loadBuiltinPipeline } = require("../line-graph");
const { createHarness } = require("../harness");
const { vibeContextTokens, codexContextTokens, sessionContextTokens } = require("../context-probe");
const { parseContextSize, formatTokens } = require("../web/pipeline-ui");

test("context size prefers harness tokens over the character estimate", () => {
  const stats = newContextStats();
  recordTurn(stats, { promptChars: 4000, outputChars: 4000 });
  assert.strictEqual(contextSize(stats), 2000);
  assert.strictEqual(contextView(stats, 0).estimated, true);
  recordTurn(stats, { promptChars: 10, outputChars: 10, tokens: 52000 });
  assert.strictEqual(contextSize(stats), 52000);
  assert.deepStrictEqual(contextView(stats, 100000),
    { tokens: 52000, estimated: false, turns: 2, compactions: 0, threshold: 100000 });
});

test("auto compaction triggers at the threshold, never when off or after a failed attempt", () => {
  const stats = newContextStats();
  recordTurn(stats, { tokens: 49999 });
  assert.strictEqual(shouldAutoCompact(stats, 50000), false);
  recordTurn(stats, { tokens: 50000 });
  assert.strictEqual(shouldAutoCompact(stats, 50000), true);
  assert.strictEqual(shouldAutoCompact(stats, 0), false);
  stats.autoFailed = true;
  assert.strictEqual(shouldAutoCompact(stats, 50000), false);
});

test("a fresh session resets the stats and counts the compaction", () => {
  const stats = newContextStats();
  recordTurn(stats, { tokens: 90000 });
  stats.autoFailed = true;
  const next = resetForFreshSession(resetForFreshSession(stats));
  assert.deepStrictEqual(next, { tokens: null, chars: 0, turns: 0, compactions: 2, autoFailed: false });
});

test("restoreContextStats tolerates missing and malformed data", () => {
  assert.deepStrictEqual(restoreContextStats(undefined), newContextStats());
  assert.deepStrictEqual(restoreContextStats({ tokens: -1, chars: "x", turns: 1.5, autoFailed: "yes" }),
    newContextStats());
  assert.deepStrictEqual(restoreContextStats({ tokens: 10, chars: 20, turns: 3, compactions: 1, autoFailed: true }),
    { tokens: 10, chars: 20, turns: 3, compactions: 1, autoFailed: true });
});

test("parseAutoThreshold reads the env default", () => {
  assert.strictEqual(parseAutoThreshold(undefined), DEFAULT_AUTO_TOKENS);
  assert.strictEqual(parseAutoThreshold(""), DEFAULT_AUTO_TOKENS);
  assert.strictEqual(parseAutoThreshold("0"), 0);
  assert.strictEqual(parseAutoThreshold("80000"), 80000);
  assert.throws(() => parseAutoThreshold("200K"), /COMPACT_AUTO_TOKENS/);
  assert.throws(() => parseAutoThreshold("-1"), /COMPACT_AUTO_TOKENS/);
});

test("summaries and reseed prompts keep the brief, the summary, and the new instructions in order", () => {
  assert.strictEqual(acceptSummary("  short "), null);
  const summary = "Goal: add login. Done: API route. Next: UI form. Branch line/x.";
  assert.strictEqual(acceptSummary(`\n${summary}\n`), summary);
  assert.match(compactionPrompt("planner"), /worker you spawned/);
  assert.match(compactionPrompt("implementor"), /what you changed/);
  const prompt = workerReseedPrompt("BRIEF", summary, "FOLLOW-UP");
  assert.ok(prompt.indexOf("BRIEF") < prompt.indexOf(summary));
  assert.ok(prompt.indexOf(summary) < prompt.indexOf("FOLLOW-UP"));
  assert.ok(prompt.includes(handoffBlock(summary)));
});

test("pipeline maxContext is set per resumed phase and falls back to the env default", () => {
  const withContext = { strict: true, maxContext: true };
  assert.strictEqual(validateNodeSettings("n", { maxContext: 200000 }, withContext), null);
  assert.match(validateNodeSettings("n", { maxContext: 50000 }, { strict: true, maxContext: false }), /not supported/);
  assert.match(validateNodeSettings("n", { maxContext: 500 }, withContext), /at least 1000/);
  assert.match(validateNodeSettings("n", { maxContext: "200K" }, withContext), /integer number of tokens/);
  const graph = loadBuiltinPipeline("default", require("node:fs"), require("node:path").join(__dirname, ".."));
  const line = { graph, nodeSettings: { planner: { maxContext: 200000 } } };
  const env = { COMPACT_AUTO_TOKENS: "90000" };
  assert.strictEqual(fallbackPhaseSettings(line, "planner", env).maxContext, 200000);
  assert.strictEqual(fallbackPhaseSettings(line, "implementor", env).maxContext, 90000);
  assert.strictEqual(fallbackPhaseSettings(line, "validator", env).maxContext, undefined);
  assert.strictEqual(fallbackPhaseSettings({}, "planner", { COMPACT_AUTO_TOKENS: "0" }).maxContext, 0);
});

test("claude and pi adapters report the latest context size", () => {
  const claude = createHarness("claude");
  claude.normalize({ type: "assistant", message: { role: "assistant", content: [],
    usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 40 } } });
  assert.strictEqual(claude.contextTokens, 3250);
  claude.normalize({ type: "assistant", message: { role: "assistant", content: [], usage: { input_tokens: 0 } } });
  assert.strictEqual(claude.contextTokens, 3250);

  const pi = createHarness("pi");
  pi.normalize({ type: "message_end", message: { role: "user", content: "x", usage: { input: 999 } } });
  assert.strictEqual(pi.contextTokens, null);
  pi.normalize({ type: "message_end", message: { role: "assistant", content: [],
    usage: { input: 5, cacheRead: 1000, cacheWrite: 20, output: 7 } } });
  assert.strictEqual(pi.contextTokens, 1032);
  assert.strictEqual(createHarness("vibe").contextTokens, null);
});

test("vibe and codex context sizes come from their session files", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ctx-probe-"));
  try {
    const vibeId = "b18cbd93-3d63-d844-7dfb-0928b2058c48";
    const vibeDir = path.join(home, "vibe", "logs", "session", "session_20260926_080200_b18cbd93");
    fs.mkdirSync(vibeDir, { recursive: true });
    fs.writeFileSync(path.join(vibeDir, "meta.json"),
      JSON.stringify({ session_id: vibeId, stats: { context_tokens: 28745 } }));
    const env = { VIBE_HOME: path.join(home, "vibe"), CODEX_HOME: path.join(home, "codex") };
    assert.strictEqual(vibeContextTokens(vibeId, env), 28745);
    assert.strictEqual(vibeContextTokens("b18cbd93-0000-0000-0000-000000000000", env), null);

    const codexId = "01a17cbb-6cd8-7351-8f27-8dbf177f2bc8";
    const codexDir = path.join(home, "codex", "sessions", "2026", "10", "27");
    fs.mkdirSync(codexDir, { recursive: true });
    const tokenCount = (input, output) => JSON.stringify({ type: "event_msg", payload: { type: "token_count",
      info: { last_token_usage: { input_tokens: input, cached_input_tokens: input - 1, output_tokens: output } } } });
    fs.writeFileSync(path.join(codexDir, `rollout-2026-10-27T10-00-00-${codexId}.jsonl`),
      [tokenCount(1000, 10), JSON.stringify({ type: "event_msg", payload: { type: "agent_message" } }),
        tokenCount(225967, 306), ""].join("\n"));
    assert.strictEqual(codexContextTokens(codexId, env), 226273);
    assert.strictEqual(sessionContextTokens("codex", codexId, env), 226273);
    assert.strictEqual(sessionContextTokens("codex", "missing", env), null);
    assert.strictEqual(sessionContextTokens("claude", codexId, env), null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("the create form reads max context in thousands", () => {
  assert.strictEqual(parseContextSize(""), null);
  assert.strictEqual(parseContextSize("200K"), 200000);
  assert.strictEqual(parseContextSize("50k"), 50000);
  assert.strictEqual(parseContextSize(" 200 "), 200000);
  assert.strictEqual(parseContextSize("1M"), 1000000);
  assert.strictEqual(parseContextSize("1.5m"), 1500000);
  assert.ok(Number.isNaN(parseContextSize("lots")));
  assert.ok(Number.isNaN(parseContextSize("0.5")));
  assert.strictEqual(formatTokens(950), "950");
  assert.strictEqual(formatTokens(52400), "52K");
  assert.strictEqual(formatTokens(1200000), "1.2M");
});
