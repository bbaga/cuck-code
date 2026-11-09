'use strict';

// Keeps docs/harness-plugins.md and the example plugins the same, and checks
// that the guide names every method of the v1 interface.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const guide = fs.readFileSync(path.join(ROOT, 'docs', 'harness-plugins.md'), 'utf8');
const EXAMPLES = path.join(ROOT, 'docs', 'examples', 'harness-plugins');

// Each example block follows a line with the file name in backticks.
const EXAMPLE_FILES = ['echo/index.js', 'remote-claude/index.js', 'remote-claude/bin/remote-claude'];

function blockAfter(name) {
  const m = new RegExp('^`' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '`:\\n\\n```\\w*\\n([\\s\\S]*?)```', 'm').exec(guide);
  return m ? m[1] : null;
}

for (const name of EXAMPLE_FILES) {
  test(`the guide block for ${name} equals the example file`, () => {
    const block = blockAfter(name);
    assert.notEqual(block, null, `no code block after "${name}"`);
    assert.equal(block, fs.readFileSync(path.join(EXAMPLES, name), 'utf8'));
  });
}

test('the guide names every interface method', () => {
  const src = fs.readFileSync(path.join(ROOT, 'harness-interface.js'), 'utf8');
  for (const list of ['REQUIRED_METHODS', 'PROVIDER_METHODS', 'OPTIONAL_METHODS']) {
    const m = new RegExp(list + ' = \\[(.*?)\\]').exec(src);
    assert.ok(m, `${list} not found`);
    const names = [...m[1].matchAll(/"(\w+)"/g)].map((x) => x[1]);
    assert.ok(names.length > 0);
    for (const name of names) assert.ok(guide.includes(name), `${name} missing in the guide`);
  }
});
