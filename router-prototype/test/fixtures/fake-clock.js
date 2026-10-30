"use strict";

/**
 * Create a synchronous clock for timer tests.
 *
 * `now` is the current numeric time. setTimeout(callback, delay) returns a
 * handle, and clearTimeout(handle) cancels it. advance(ms) moves time forward
 * and runs callbacks due at or before the new time. Equal-time callbacks run
 * in insertion order. A callback may schedule more callbacks during advance.
 * This fixture never creates or waits for a real timer.
 */
function createFakeClock(start = 0) {
  let current = start;
  let nextHandle = 1;
  let nextOrder = 1;
  const timers = new Map();

  function setTimeoutFake(callback, delay = 0) {
    if (typeof callback !== "function") throw new TypeError("callback must be a function");
    const value = Number(delay);
    if (!Number.isFinite(value)) throw new TypeError("delay must be finite");
    const handle = nextHandle++;
    timers.set(handle, {
      callback,
      due: current + Math.max(0, value),
      order: nextOrder++,
      cancelled: false,
    });
    return handle;
  }

  function clearTimeoutFake(handle) {
    const timer = timers.get(handle);
    if (timer) timer.cancelled = true;
  }

  function advance(milliseconds) {
    const value = Number(milliseconds);
    if (!Number.isFinite(value) || value < 0) throw new RangeError("advance requires a non-negative finite number");
    const target = current + value;
    while (true) {
      const due = [...timers.entries()]
        .filter(([, timer]) => !timer.cancelled && timer.due <= target)
        .sort((a, b) => a[1].due - b[1].due || a[1].order - b[1].order)[0];
      if (!due) break;
      const [handle, timer] = due;
      timers.delete(handle);
      if (timer.cancelled) continue;
      current = timer.due;
      timer.callback();
    }
    current = target;
  }

  return {
    get now() { return current; },
    setTimeout: setTimeoutFake,
    clearTimeout: clearTimeoutFake,
    advance,
  };
}

module.exports = { createFakeClock };
