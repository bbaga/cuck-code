'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadBuiltinPipeline } = require('../line-graph');
const { buildPrompt, plannerRouterValues } = require('../prompt-builder');

const graph = loadBuiltinPipeline('default', fs, path.join(__dirname, '..'));
const line = { id: 'L-1', name: 'N' };
const brief = buildPrompt(graph, graph.start,
  plannerRouterValues({ line, nodeId: graph.start, port: 7788, workerCap: 8, graph }), { task: 'PROMPT' });
const BEGIN = '## Work registry\n';
const FINISH = '## Container and process hygiene';

test('registry block sits between the factory protocol and the hygiene section', () => {
  const a = brief.indexOf(BEGIN);
  const b = brief.indexOf(FINISH);
  assert.ok(a > brief.indexOf('## Calls'), 'registry marker missing or misplaced');
  assert.ok(b > a, 'hygiene marker must follow the registry block');
});

test('registry block names the real port, line id and endpoints', () => {
  const block = brief.slice(brief.indexOf(BEGIN), brief.indexOf(FINISH));
  for (const text of [
    'http://localhost:7788/api/registry/claims?q=',
    'http://localhost:7788/api/registry/summary',
    'http://localhost:7788/api/registry/lines/L-1/requests',
    'http://localhost:7788/api/registry/lines/L-1/claims',
    'http://localhost:7788/api/registry/events?after=',
    'untrusted', 'never approves a plan', 'Supersede', 'stale claim',
    'REGISTRY OVERLAP NOTICE tells you that another line claimed work on a repo where you hold a claim.',
    'If the work overlaps yours, send a request to its line.'
  ]) assert.ok(block.includes(text), `missing: ${text}`);
});

test('the existing approval and role text is still present', () => {
  for (const text of [
    '## Factory protocol', '## Container and process hygiene', 'PLANNER-ONLY RULES',
    'Never infer approval from continue.', 'You plan and coordinate only'
  ]) assert.ok(brief.includes(text), `brief lost existing text: ${text}`);
});

test('the registry heading occurs once, before the hygiene heading', () => {
  const first = brief.indexOf('## Work registry');
  assert.ok(first >= 0, 'registry heading missing');
  assert.equal(brief.indexOf('## Work registry', first + 1), -1, 'registry heading occurs more than once');
  assert.ok(first < brief.indexOf('## Container and process hygiene'), 'registry heading must precede the hygiene heading');
});
