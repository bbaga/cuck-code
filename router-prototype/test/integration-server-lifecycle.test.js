'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const start = source.indexOf('function integrationValidatorBrief(');
const end = source.indexOf('\nfunction sanitizeName', start);
const fnSource = source.slice(start, end);
const brief = fnSource.replace(/\s+/g, ' ');

// Build the real function from source; server.js starts a server when required.
const integrationValidatorBrief = new Function('PORT', `${fnSource}\nreturn integrationValidatorBrief;`)(7788);

test('integration brief requires a background server and rejects foreground startup', () => {
  assert.match(brief, /node router-prototype\/server\.js >router\.log 2>&1 & SERVER_PID=\$!/);
  assert.doesNotMatch(brief, /node router-prototype\/server\.js\s*\n\s*Wait/);
  assert.match(brief, /all standard\s+streams/);
});

test('integration brief requires explicit merge and commit ancestry checks', () => {
  assert.match(brief, /one explicit Git merge command/);
  assert.match(brief, /Do not use a shell loop/);
  assert.match(brief, /git merge <branch> --no-edit/);
  assert.match(brief, /Check the exit status of each command/);
  assert.match(brief, /Report the exact command, exit status, and stderr/);
  assert.match(brief, /git merge-base --is-ancestor <expected-commit> HEAD/);
  assert.match(brief, /Do not infer\s+success from silent output/);
});

test('integration brief requires isolated port, readiness, registration, and cleanup', () => {
  assert.match(brief, /free PORT other than 7788/);
  assert.match(brief, /private LINES_DIR/);
  assert.match(brief, /bounded timeout/);
  assert.match(brief, /worker \$\{workerId\}/);
  assert.match(brief, /kill "\$SERVER_PID" \|\| true/);
});

test('integrationValidatorBrief renders lifecycle steps for sample inputs', () => {
  const text = integrationValidatorBrief(
    { name: 'Demo' },
    [{ branch: 'feat/a', repo: 'primary' }],
    'Merge it',
    'worker-1',
    [{ name: 'primary', path: '/w' }, { name: 'api', url: 'git@x:api.git' }]
  ).replace(/\s+/g, ' ');
  assert.match(text, /INTEGRATION VALIDATOR \(id worker-1\) for factory line 'Demo'/);
  assert.match(text, /- feat\/a \(repo 'primary'\)/);
  assert.match(text, /remote git@x:api\.git/);
  assert.match(text, /worker worker-1\./);
  assert.match(text, /3\. For every other repo/);
  const single = integrationValidatorBrief({ name: 'D' }, [], '', 'w', [{ name: 'primary', path: '/w' }]);
  assert.match(single, /3\. No additional repositories/);
});
