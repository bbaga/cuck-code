'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The instructions live in the integration-validator node type (they were in server.js before D9).
const serverSource = fs.readFileSync(path.join(__dirname, '..', 'node-types', 'integration-validator', 'NODE.md'), 'utf8');

function registrationExample() {
  const match = serverSource.match(/-d '({"kind":"showcase".*?})'/);
  assert.ok(match, 'showcase registration example is missing');
  return JSON.parse(match[1]);
}

test('instructions require one complete continuous capture', () => {
  assert.match(serverSource, /one complete showcase for this integration attempt/);
  assert.match(serverSource, /one browser context/);
  assert.match(serverSource, /one continuous WebM recording/);
  assert.match(serverSource, /Do not stop the recording/);
  assert.match(serverSource, /significant step/);
  assert.match(serverSource, /screenshots in demonstration\s+order/);
  assert.match(serverSource, /each screenshot paired with its matching title/);
  assert.match(serverSource, /Close the browser context before registration/);
  assert.match(serverSource, /failed showcase capture/);
  assert.match(serverSource, /short clips/);
  assert.match(serverSource, /ffmpeg program must be available/);
  assert.match(serverSource, /Restart the router after/);
});

test('registration example has the exact versioned showcase shape', () => {
  const request = registrationExample();
  assert.deepEqual(Object.keys(request), ['kind', 'version', 'useCase', 'file', 'steps']);
  assert.equal(request.kind, 'showcase');
  assert.equal(request.version, 1);
  assert.equal(request.useCase, '<complete demonstration title>');
  assert.equal(request.file, 'evidence/showcase.webm');
  assert.deepEqual(request.steps, [{
    title: '<step title>',
    explanation: '<visible proof and feature>',
    screenshot: 'evidence/step-1.png',
  }]);
  assert.ok(request.file.startsWith('evidence/'));
  assert.ok(!path.isAbsolute(request.file));
  assert.ok(!request.file.split('/').includes('..'));
  for (const step of request.steps) {
    assert.ok(step.screenshot.startsWith('evidence/'));
    assert.ok(!path.isAbsolute(step.screenshot));
    assert.ok(!step.screenshot.split('/').includes('..'));
  }
});

test('instructions use the worker evidence endpoint and preserve ordered steps', () => {
  assert.match(serverSource, /POST \{\{router\.url\}\}\/api\/protocol\/workers\/\{\{instance\.id\}\}\/evidence/);
  assert.match(serverSource, /Use paths relative to your workdir/);
  assert.match(serverSource, /screenshots in demonstration\s+order/);
  assert.match(serverSource, /accepted A|362eff17942182a62baf05ef12423afa2dbf6613/);
  assert.match(serverSource, /POST.*evidenceId.*attemptId|evidenceId.*attemptId/);
  assert.match(serverSource, /GET.*items.*history.*currentAttemptId.*currentAttemptIds|items.*history.*currentAttemptId.*currentAttemptIds/);
  assert.match(serverSource, /router owns attempt identity/);
  assert.match(serverSource, /Current evidence is in items/);
  assert.match(serverSource, /Older evidence is in history/);
  assert.match(serverSource, /tied to this attempt|attempt association/);
});
