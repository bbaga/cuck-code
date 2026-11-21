---
name: arrive
description: Record that the task chain reached the wait node with a PASS.
effect: arrive
trigger: complete
target: waiter
when: [done, pass]
fallback: false
---
