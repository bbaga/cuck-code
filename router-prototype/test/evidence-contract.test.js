'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const { validateShowcase } = require('../evidence');

test('integration instructions require one continuous showcase and significant screenshots', () => {
  assert.match(serverSource, /one complete showcase for this integration attempt/);
  assert.match(serverSource, /one browser context/);
  assert.match(serverSource, /one continuous WebM recording/);
  assert.match(serverSource, /Do not stop the recording/);
  assert.match(serverSource, /significant step/);
  assert.match(serverSource, /Close the browser context before registration/);
  assert.match(serverSource, /failed showcase capture/);
  assert.match(serverSource, /short clips/);
});

test('instruction example is the exact showcase producer contract', () => {
  assert.match(serverSource, /"kind":"showcase","version":1/);
  assert.match(serverSource, /"useCase":"<complete demonstration title>"/);
  assert.match(serverSource, /"steps":\[\{.*"title".*"explanation".*"screenshot"/);
  assert.match(serverSource, /\/api\/protocol\/workers\/\$\{workerId\}\/evidence/);
  assert.match(serverSource, /ffmpeg program must be available/);
});

test('showcase validation requires ordered proof steps and finalized WebM', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-contract-'));
  try {
    fs.writeFileSync(path.join(root, 'showcase.webm'), Buffer.alloc(2048, 1));
    fs.writeFileSync(path.join(root, 'step.png'), Buffer.alloc(128, 1));
    assert.throws(() => validateShowcase(root, { kind: 'showcase', version: 1,
      useCase: 'Demo', file: 'showcase.webm', steps: [] }), /nonempty/);
    assert.throws(() => validateShowcase(root, { kind: 'showcase', version: 1,
      useCase: 'Demo', file: 'showcase.webm', steps: [{ title: 'Step', explanation: '', screenshot: 'step.png' }] }), /explanation/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
