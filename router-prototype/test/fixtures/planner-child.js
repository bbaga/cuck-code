"use strict";

const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

/**
 * Create a child-process-shaped fixture without starting a process.
 *
 * `signal: true` makes kill() return false. Any other value makes kill()
 * return true. kill() always records the requested signal in signals.
 * `close` is the default first argument for emitClose(). `error` is the
 * default error for emitError(). Neither event occurs until explicitly emitted.
 */
function createFakeChild({ close = 0, error = new Error("fake child error"), signal = false } = {}) {
  const events = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const signals = [];

  return {
    stdout,
    stderr,
    signals,
    on(event, listener) {
      events.on(event, listener);
      return this;
    },
    once(event, listener) {
      events.once(event, listener);
      return this;
    },
    kill(requestedSignal) {
      signals.push(requestedSignal);
      return !signal;
    },
    emitClose(code = close, emittedSignal = null) {
      events.emit("close", code, emittedSignal);
    },
    emitError(value = error) {
      events.emit("error", value);
    },
  };
}

module.exports = { createFakeChild };
