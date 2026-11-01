"use strict";

// Only one positive process ID can be signalled. 0 and negative values
// address process groups or every process of the user. PID 1, the router,
// and its parent are never valid targets.
function isSignalablePid(pid, self = process) {
  return Number.isInteger(pid) && pid > 1 && pid !== self.pid && pid !== self.ppid;
}

module.exports = { isSignalablePid };
