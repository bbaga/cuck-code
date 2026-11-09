"use strict";

// Runs the Claude Code CLI on another machine. The built-in claude argv,
// parser, resume and transcripts are reused. Only the command changes.
module.exports = (sdk) => sdk.extendBuiltin("claude", {
  id: "remote-claude",
  displayName: "Remote Claude",
  command: "./bin/remote-claude",
});
