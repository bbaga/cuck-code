'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadNodeType } = require('../node-types');
const { render } = require('../template');
const { golden } = require('./fixtures/golden-file');

// The text of the integration-validator type, rendered with the same values the
// removed integrationValidatorBrief() was called with. The golden file
// test/fixtures/golden/integration-lifecycle-recorded-commits.txt holds that
// function's output (produced by a one-off script before D9 removed it).
const root = path.join(__dirname, '..');
const type = loadNodeType(path.join(root, 'node-types', 'integration-validator'), (f) => fs.readFileSync(f, 'utf8'));

function integrationValidatorBrief(line, manifest, instructions, workerId, branch) {
  return render(type.body, {
    line: { id: line.id, name: line.name },
    instance: { id: workerId },
    router: { url: 'http://localhost:7788' },
    integration: {
      branch,
      repos: manifest.map((r) => ({ name: r.name, url: r.url, worktreePath: r.worktreePath,
        baseBranch: r.baseBranch || 'HEAD', baseSha: r.baseSha, branches: r.branches })),
    },
    instructions,
  });
}

const brief = integrationValidatorBrief({ id: 'line-42', name: 'Demo' }, [], 'Merge it', 'worker-1', 'integration/x-1')
  .replace(/\s+/g, ' ');

test('integration brief requires a background server and rejects foreground startup', () => {
  assert.match(brief, /node router-prototype\/server\.js >router\.log 2>&1 & SERVER_PID=\$!/);
  assert.doesNotMatch(brief, /node router-prototype\/server\.js\s*\n\s*Wait/);
  assert.match(brief, /all standard\s+streams/);
});

test('integration brief bootstraps the private line before registration', () => {
  assert.match(brief, /Seed the private line state before you start the isolated router/);
  assert.match(brief, /Create the directory <private-dir>\/line-42/);
  assert.match(brief, /line\.json/);
  assert.match(brief, /integration worker record with id worker-1/);
  assert.match(brief, /role\\?\"?:\\?\"?validator/);
  assert.match(brief, /kind\\?\"?:\\?\"?integration/);
  assert.match(brief, /POST \/api\/protocol\/lines\/line-42\/inventory/);
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
  assert.match(brief, /worker worker-1/);
  assert.match(brief, /kill "\$SERVER_PID" \|\| true/);
});

test('integrationValidatorBrief renders the recorded commits per repository', () => {
  const manifest = [
    { name: 'web', url: 'https://github.com/o/web.git', worktreePath: '/wt/int/web', baseBranch: 'main', baseSha: 'a'.repeat(40),
      branches: [{ name: 'impl-a', branch: 'feat/a', sha: 'b'.repeat(40) }, { name: 'impl-b', branch: 'feat/b', sha: 'c'.repeat(40) }] },
    { name: 'api', url: null, worktreePath: '/wt/int/api', baseBranch: 'master', baseSha: 'd'.repeat(40),
      branches: [{ name: 'impl-c', branch: 'feat/c', sha: 'e'.repeat(40) }] },
  ];
  const full = integrationValidatorBrief({ id: 'line-42', name: 'Demo' }, manifest, 'Merge it', 'worker-1', 'integration/x-1');
  assert.equal(full, golden('integration-lifecycle-recorded-commits'));
  const text = full.replace(/\s+/g, ' ');
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
