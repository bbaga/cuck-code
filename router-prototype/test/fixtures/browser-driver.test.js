'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const { startDashboardFixture } = require('./dashboard-browser');
const { openPage } = require('./browser-driver');

test('browser driver', async (t) => {
  const listDirs = () => new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('browser-driver-')));
  const before = listDirs();
  const fx = await startDashboardFixture();
  let page;
  try { page = await openPage(fx.url); } catch (err) {
    await fx.close();
    if (err.code === 'BROWSER_UNAVAILABLE') return t.skip(err.message);
    throw err;
  }
  try {
    assert.equal(await page.evaluate('document.readyState'), 'complete');
    assert.match(await page.evaluate('document.title'), /\S/);
    assert.equal(await page.evaluate('Promise.resolve(6 * 7)'), 42);
    await assert.rejects(page.evaluate('throw new Error("boom")'), /boom/);
    await page.evaluate(`window.keys = []; document.addEventListener('keydown', (e) => keys.push(e.key + ':' + e.repeat))`);
    await page.press('Escape'); await page.press('a'); await page.press('Enter');
    assert.deepEqual(await page.evaluate('keys'), ['Escape:false', 'a:false', 'Enter:false']);
    await page.setViewport(640, 480);
    assert.equal(await page.evaluate('window.innerWidth'), 640);
    assert.ok(page.requests().some((u) => u.startsWith(fx.url)));
  } finally {
    await page.close();
    await fx.close();
  }
  await page.close();
  assert.deepEqual([...listDirs()].filter((n) => !before.has(n)), []);
});
