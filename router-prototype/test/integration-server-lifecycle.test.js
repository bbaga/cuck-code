'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const start = source.indexOf('function integrationValidatorBrief(');
const end = source.indexOf('\nfunction sanitizeName', start);
assert.ok(start >= 0, 'start marker "function integrationValidatorBrief(" not found in server.js');
assert.ok(end > start, 'end marker "\\nfunction sanitizeName" not found after the brief function');
const fnSource = source.slice(start, end);
const brief = fnSource.replace(/\s+/g, ' ');

// Build the real function from source; server.js starts a server when required.
const integrationValidatorBrief = new Function('PORT', `${fnSource}\nreturn integrationValidatorBrief;`)(7788);

test('integration brief requires a background server and rejects foreground startup', () => {
  assert.match(brief, /node router-prototype\/server\.js >router\.log 2>&1 & SERVER_PID=\$!/);
  assert.doesNotMatch(brief, /node router-prototype\/server\.js\s*\n\s*Wait/);
  assert.match(brief, /all standard\s+streams/);
});

test('integration brief bootstraps the private line before registration', () => {
  assert.match(brief, /Seed the private line state before you start the isolated router/);
  assert.match(brief, /Create the directory <private-dir>\/\$\{line\.id\}/);
  assert.match(brief, /line\.json/);
  assert.match(brief, /integration worker record with id \$\{workerId\}/);
  assert.match(brief, /role\\?\"?:\\?\"?validator/);
  assert.match(brief, /kind\\?\"?:\\?\"?integration/);
  assert.match(brief, /POST \/api\/protocol\/lines\/\$\{line\.id\}\/inventory/);
  assert.match(brief, /Never remove\s+or modify the live LINES_DIR/);
});

test('integration brief requires headless browsers for testing and evidence', () => {
  assert.match(brief, /Every browser used for UI\/UX testing, acceptance testing, showcase\s+capture, or related evidence MUST be launched in headless mode/);
  assert.match(brief, /cannot affect the user's desktop or session/);
});

test('integration brief requires explicit merge and commit ancestry checks', () => {
  assert.match(brief, /one explicit Git merge command/);
  assert.match(brief, /Do not use a shell loop/);
  assert.match(brief, /git -C <repository directory> merge --no-edit <commit>/);
  assert.match(brief, /Check the exit status of each command/);
  assert.match(brief, /Report the exact command, exit status, and stderr/);
  assert.match(brief, /git -C <repository directory> merge-base --is-ancestor <commit> HEAD/);
  assert.match(brief, /Do not infer\s+success from silent output/);
});

test('integration brief requires isolated port, readiness, registration, and cleanup', () => {
  assert.match(brief, /free PORT other than 7788/);
  assert.match(brief, /private LINES_DIR/);
  assert.match(brief, /bounded timeout/);
  assert.match(brief, /worker \$\{workerId\}/);
  assert.match(brief, /kill "\$SERVER_PID" \|\| true/);
});

test('integrationValidatorBrief renders the recorded commits per repository', () => {
  const manifest = [
    { name: 'web', url: 'https://github.com/o/web.git', worktreePath: '/wt/int/web', baseBranch: 'main', baseSha: 'a'.repeat(40),
      branches: [{ name: 'impl-a', branch: 'feat/a', sha: 'b'.repeat(40) }, { name: 'impl-b', branch: 'feat/b', sha: 'c'.repeat(40) }] },
    { name: 'api', url: null, worktreePath: '/wt/int/api', baseBranch: 'master', baseSha: 'd'.repeat(40),
      branches: [{ name: 'impl-c', branch: 'feat/c', sha: 'e'.repeat(40) }] },
  ];
  const text = integrationValidatorBrief({ id: 'line-42', name: 'Demo' }, manifest, 'Merge it', 'worker-1', 'integration/x-1')
    .replace(/\s+/g, ' ');
  assert.match(text, /INTEGRATION VALIDATOR \(id worker-1\) for factory line 'Demo'/);
  assert.match(text, /Repository 'web' \(remote https:\/\/github\.com\/o\/web\.git\) Directory: \/wt\/int\/web/);
  assert.match(text, /Repository 'api' \(no remote\) Directory: \/wt\/int\/api/);
  assert.match(text, new RegExp(`Integration branch integration/x-1, created from main at ${'a'.repeat(40)}`));
  assert.match(text, new RegExp(`- ${'b'.repeat(40)} \\(branch feat/a, implementor 'impl-a'\\) - ${'c'.repeat(40)} \\(branch feat/b`));
  assert.match(text, new RegExp(`- ${'e'.repeat(40)} \\(branch feat/c, implementor 'impl-c'\\)`));
  assert.match(text, /Do not merge other commits/);
  assert.match(text, /worker worker-1\./);
  assert.match(text, /lines\/line-42\/inventory/);
  assert.doesNotMatch(text, /\$LINE_ID/);
  assert.doesNotMatch(text, /primary/);
  assert.doesNotMatch(text, /git clone/);
});
