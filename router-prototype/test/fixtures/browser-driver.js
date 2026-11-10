'use strict';
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

const LOCK_DIR = path.join(os.tmpdir(), 'cuck-browser-launch.lock');
const LOCK_PID_FILE = path.join(LOCK_DIR, 'pid');
const LOCK_NO_PID_GRACE_MS = 5000;
const LOCK_WAIT_LIMIT_MS = 180000;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Remove a lock whose owner is gone. A lock without a pid file is young: the owner is still writing it.
function removeStaleLock() {
  let pid = NaN;
  try { pid = Number(fs.readFileSync(LOCK_PID_FILE, 'utf8')); } catch {}
  if (Number.isInteger(pid) && pid > 0) {
    if (pidAlive(pid)) return;
  } else {
    try { if (Date.now() - fs.statSync(LOCK_DIR).mtimeMs < LOCK_NO_PID_GRACE_MS) return; } catch { return; }
  }
  fs.rmSync(LOCK_DIR, { recursive: true, force: true });
}

async function acquireLaunchLock() {
  const end = Date.now() + LOCK_WAIT_LIMIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      fs.writeFileSync(LOCK_PID_FILE, String(process.pid));
      return;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    removeStaleLock();
    if (Date.now() > end) throw new Error(`timeout waiting for the browser launch lock ${LOCK_DIR} after ${LOCK_WAIT_LIMIT_MS} ms`);
    await sleep(50);
  }
}

function releaseLaunchLock() {
  fs.rmSync(LOCK_DIR, { recursive: true, force: true });
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

function chromeArgs(dir) {
  const args = ['--headless=new', '--remote-debugging-port=0', '--no-first-run',
    '--no-default-browser-check', `--user-data-dir=${dir}`];
  if (process.platform === 'linux') args.push('--disable-dev-shm-usage', '--disable-gpu', '--no-sandbox');
  return [...args, 'about:blank'];
}

function killProcessGroup(proc) {
  try { process.kill(-proc.pid, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch {} }
}

// One spawn attempt. The START_TIMEOUT_MS clock starts inside readDevToolsPort, after the lock is held.
async function launchOnce(exe) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-driver-'));
  const proc = spawn(exe, chromeArgs(dir), { stdio: 'ignore', detached: true });
  const exited = new Promise((r) => proc.once('exit', r));
  try {
    return { proc, dir, exited, port: await readDevToolsPort(dir, proc) };
  } catch (err) {
    killProcessGroup(proc);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    throw err;
  }
}

// Launches Chrome one process at a time per machine. A dead start gets one more launch with a new profile.
async function launchChrome(exe) {
  await acquireLaunchLock();
  try {
    try {
      return await launchOnce(exe);
    } catch (first) {
      try {
        return await launchOnce(exe);
      } catch (second) {
        throw new Error(`${second.message} (first launch failed: ${first.message})`);
      }
    }
  } finally {
    releaseLaunchLock();
  }
}

const KEYS = {
  Escape: { code: 'Escape', vk: 27 }, Enter: { code: 'Enter', vk: 13, text: '\r' },
  ArrowUp: { code: 'ArrowUp', vk: 38 }, ArrowDown: { code: 'ArrowDown', vk: 40 },
};

async function openPage(url, options = {}) {
  const exe = findBrowser(options);
  const { proc, dir, exited, port } = await launchChrome(exe);
  let ws = null; let closing = null;
  const pending = new Map(); const seen = []; const blockedIds = new Set(); const urlById = new Map(); let nextId = 1;
  const commandTimeoutMs = options.commandTimeoutMs || 15000;
  const killGroup = () => killProcessGroup(proc);
  const onExit = () => { killGroup(); try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} };
  const signalHandlers = ['SIGTERM', 'SIGINT'].map((sig) => {
    const handler = () => {
      onExit(); process.off(sig, handler);
      // Re-raise only when no other handler would end the process.
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    };
    process.on(sig, handler);
    return [sig, handler];
  });
  process.on('exit', onExit);

  function close() {
    if (closing) return closing;
    closing = (async () => {
      for (const [sig, handler] of signalHandlers) process.off(sig, handler);
      process.off('exit', onExit);
      try { if (ws) ws.close(); } catch {}
      if (proc.exitCode === null) { killGroup(); await exited; }
      for (const { reject } of pending.values()) reject(new Error('page closed'));
      pending.clear();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    })();
    return closing;
  }

  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT', signal: AbortSignal.timeout(START_TIMEOUT_MS) });
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
    const send = (method, params = {}, timeoutMs = commandTimeoutMs) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id); reject(new Error(`CDP ${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); } });
      try { ws.send(JSON.stringify({ id, method, params })); } catch (e) { pending.get(id).reject(e); pending.delete(id); }
    });
    for (const domain of ['Page', 'Runtime', 'Network']) await send(`${domain}.enable`);
    const loaded = new Promise((resolve, reject) => {
      onLoad = resolve; setTimeout(() => reject(new Error('page load timeout')), START_TIMEOUT_MS).unref();
    });
    if (options.initScript) await send('Page.addScriptToEvaluateOnNewDocument', { source: options.initScript });
    await send('Page.navigate', { url });
    await loaded;

    async function evaluate(expression, timeoutMs) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error((d.exception && (d.exception.description || d.exception.value)) || d.text);
      }
      return r.result.value;
    }
    async function waitFor(expression, { timeoutMs = 10000, intervalMs = 50 } = {}) {
      const end = Date.now() + timeoutMs; let last;
      while (Date.now() < end) {
        try { last = await evaluate(expression, Math.min(commandTimeoutMs, Math.max(100, end - Date.now()))); if (last) return last; }
        catch (e) { last = e.message; }
        await sleep(intervalMs);
      }
      throw new Error(`waitFor timed out after ${timeoutMs} ms: ${expression} (last: ${JSON.stringify(last)})`);
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
    const screenshot = async (file) => {
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    };
    // type: mousePressed | mouseMoved | mouseReleased. Real input, so pointer capture works.
    const mouse = (type, x, y) => send('Input.dispatchMouseEvent',
      { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    return { evaluate, waitFor, press, mouse, setViewport, screenshot, requests: () => [...seen],
      blocked: () => [...blockedIds].map((id) => urlById.get(id)), close, browser: exe, pid: proc.pid };
  } catch (err) {
    await close();
    throw err;
  }
}

module.exports = { openPage };
