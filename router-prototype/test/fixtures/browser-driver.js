'use strict';
// Minimal headless Chrome driver over the DevTools Protocol. Built-in APIs only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const START_TIMEOUT_MS = 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser(options) {
  for (const candidate of [options.chromePath, process.env.CHROME_BIN, MAC_CHROME]) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  const err = new Error('No browser found. Set CHROME_BIN or pass options.chromePath.');
  err.code = 'BROWSER_UNAVAILABLE';
  throw err;
}

async function readDevToolsPort(dir, proc) {
  const file = path.join(dir, 'DevToolsActivePort');
  const end = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < end) {
    if (proc.exitCode !== null) throw new Error(`browser exited early with code ${proc.exitCode}`);
    try {
      const port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]);
      if (port > 0) return port;
    } catch {}
    await sleep(50);
  }
  throw new Error('timeout waiting for DevToolsActivePort');
}

const KEYS = { Escape: { code: 'Escape', vk: 27 }, Enter: { code: 'Enter', vk: 13, text: '\r' } };

async function openPage(url, options = {}) {
  const exe = findBrowser(options);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-driver-'));
  const proc = spawn(exe, ['--headless=new', '--remote-debugging-port=0', '--no-first-run',
    '--no-default-browser-check', `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore', detached: true });
  let ws = null; let closing = null;
  const pending = new Map(); const seen = []; const blockedIds = new Set(); const urlById = new Map(); let nextId = 1;
  const exited = new Promise((r) => proc.once('exit', r));

  function close() {
    if (closing) return closing;
    closing = (async () => {
      try { if (ws) ws.close(); } catch {}
      if (proc.exitCode === null) {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
        await exited;
      }
      for (const { reject } of pending.values()) reject(new Error('page closed'));
      pending.clear();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    })();
    return closing;
  }

  try {
    const port = await readDevToolsPort(dir, proc);
    const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' });
    if (!res.ok) throw new Error(`cannot open page target: HTTP ${res.status}`);
    const target = await res.json();
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('DevTools WebSocket failed')), { once: true });
    });
    let onLoad = null;
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id); pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result);
      } else if (msg.method === 'Network.requestWillBeSent') {
        seen.push(msg.params.request.url); urlById.set(msg.params.requestId, msg.params.request.url);
      } else if (msg.method === 'Network.loadingFailed' && msg.params.blockedReason) blockedIds.add(msg.params.requestId);
      else if (msg.method === 'Page.loadEventFired' && onLoad) onLoad();
    });
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = nextId++; pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
    for (const domain of ['Page', 'Runtime', 'Network']) await send(`${domain}.enable`);
    const loaded = new Promise((resolve, reject) => {
      onLoad = resolve; setTimeout(() => reject(new Error('page load timeout')), START_TIMEOUT_MS).unref();
    });
    if (options.initScript) await send('Page.addScriptToEvaluateOnNewDocument', { source: options.initScript });
    await send('Page.navigate', { url });
    await loaded;

    async function evaluate(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text);
      }
      return r.result.value;
    }
    async function press(key, { modifiers = 0, repeat = false } = {}) {
      const known = KEYS[key];
      if (!known && [...key].length !== 1) throw new Error(`unsupported key: ${key}`);
      const text = known ? known.text : key;
      const base = { key, modifiers, code: known ? known.code : undefined,
        windowsVirtualKeyCode: known ? known.vk : key.toUpperCase().charCodeAt(0), autoRepeat: repeat };
      await send('Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', text });
      await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp', autoRepeat: false });
    }
    const setViewport = (width, height) => send('Emulation.setDeviceMetricsOverride',
      { width, height, deviceScaleFactor: 1, mobile: false });
    return { evaluate, press, setViewport, requests: () => [...seen],
      blocked: () => [...blockedIds].map((id) => urlById.get(id)), close, browser: exe };
  } catch (err) {
    await close();
    throw err;
  }
}

module.exports = { openPage };
