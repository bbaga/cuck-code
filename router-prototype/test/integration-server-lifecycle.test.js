'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const start = source.indexOf('function integrationValidatorBrief(');
const end = source.indexOf('\nfunction sanitizeName', start);
const brief = source.slice(start, end);

test('integration brief requires a background server and rejects foreground startup', () => {
  assert.match(brief, /node router-prototype\/server\.js >router\.log 2>&1 & SERVER_PID=\$!/);
  assert.doesNotMatch(brief, /node router-prototype\/server\.js\s*\n\s*Wait/);
  assert.match(brief, /all standard\s+streams/);
});

test('integration brief requires isolated port, readiness, registration, and cleanup', () => {
  assert.match(brief, /free PORT other than 7788/);
  assert.match(brief, /private LINES_DIR/);
  assert.match(brief, /bounded timeout/);
  assert.match(brief, /worker \$\{workerId\}/);
  assert.match(brief, /kill "\$SERVER_PID" \|\| true/);
});
