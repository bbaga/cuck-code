"use strict";

// Fake `pi` and `vibe` executables for router tests. Shared by
// harness-api.test.js and the harness characterization script.
const fs = require("node:fs");
const path = require("node:path");

const PI_CATALOG = [
  "Provider  Model",
  "--------------------",
  "anthropic   claude-sonnet-4",
  "openai      gpt-5",
].join("\n");

function writeFakeClis(binDir, tmpDir) {
  const piLogPath = path.join(tmpDir, "pi-calls.log");
  const failFlag = path.join(tmpDir, "pi-auth-fails");
  const listFailFlag = path.join(tmpDir, "pi-list-fails");
  const pi = `#!/bin/sh
printf '%s\\n' "$@" >> "${piLogPath}"
printf -- '---\\n' >> "${piLogPath}"
if [ "$1" = "--version" ]; then echo "pi 0.87.1"; exit 0; fi
if [ "$1" = "--list-models" ]; then
  if [ -e "${listFailFlag}" ]; then echo "Failed to load catalog"; exit 1; fi
  printf '${PI_CATALOG.replace(/\n/g, "\\n")}\\n'
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "check" ]; then
  if [ -e "${failFlag}" ]; then echo "not logged in"; exit 1; fi
  echo '{"loginHint":"run pi /login","apiKey":"sk-secret"}'
  exit 0
fi
exit 1
`;
  const vibe = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "vibe 3.0.2"; exit 0; fi
exit 1
`;
  fs.writeFileSync(path.join(binDir, "pi"), pi, { mode: 0o755 });
  fs.writeFileSync(path.join(binDir, "vibe"), vibe, { mode: 0o755 });
  return { piLogPath, failFlag, listFailFlag };
}

module.exports = { writeFakeClis, PI_CATALOG };
