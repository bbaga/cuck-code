---
name: script-check
description: Runs the scripts of its pipeline node in the worktree of the instance it checks, CI style, and gives a verdict. No agent runs.
runner: script
session: fresh
workspace: source
outcome: verdict
coordinator: false
---
This node runs the scripts of its pipeline node. No agent runs.
