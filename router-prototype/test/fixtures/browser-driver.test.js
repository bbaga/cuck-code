'use strict';
const { test } = require('node:test');
const { spawn } = require('node:child_process');
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

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test('timeouts reject and waitFor reports the last result', async (t) => {
  const fx = await startDashboardFixture();
  let page;
  try { page = await openPage(fx.url, { commandTimeoutMs: 500 }); } catch (err) {
    await fx.close();
    if (err.code === 'BROWSER_UNAVAILABLE') return t.skip(err.message);
    throw err;
  }
  try {
    await assert.rejects(page.evaluate('new Promise(() => {})'), /Runtime\.evaluate timed out/);
    await assert.rejects(page.evaluate('new Promise(() => {})', 200), /timed out after 200 ms/);
    assert.equal(await page.waitFor('document.readyState === "complete" && 7'), 7);
    await assert.rejects(page.waitFor('window.nothing', { timeoutMs: 300 }), /window\.nothing.*last: undefined/);
  } finally { await page.close(); await fx.close(); }
});

test('SIGTERM to the parent kills the browser group and removes the directory', async (t) => {
  const script = `const { openPage } = require(${JSON.stringify(require.resolve('./browser-driver'))});
    openPage('about:blank').then((p) => console.log(JSON.stringify({ pid: p.pid })),
      (e) => { console.log(JSON.stringify({ code: e.code })); process.exit(0); });
    setInterval(() => {}, 1000);`;
  const known = new Set(fs.readdirSync(os.tmpdir()));
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  const line = await new Promise((resolve) => child.stdout.once('data', (d) => resolve(JSON.parse(String(d)))));
  if (line.code === 'BROWSER_UNAVAILABLE') return t.skip('no browser');
  assert.ok(alive(-line.pid));
  const exited = new Promise((resolve) => child.once('exit', (code, sig) => resolve(sig || code)));
  child.kill('SIGTERM');
  await exited;
  const end = Date.now() + 5000;
  while (alive(-line.pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  assert.equal(alive(-line.pid), false);
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('browser-driver-') && !known.has(n)), []);
});
