---
name: handoff
description: Start the next checkers of the task chain when the run passes.
effect: create
trigger: complete
target: new
when: [done, pass]
fallback: false
---
