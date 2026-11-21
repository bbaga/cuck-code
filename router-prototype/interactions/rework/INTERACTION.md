---
name: rework
description: Send the checker report back to the implementor whose work the checker checked.
effect: deliver
trigger: complete
target: source
when: [reject, missing]
fallback: false
---
REWORK REQUEST - checker '{{from.name}}' (node {{from.node}}) rejected your latest run.

CHECKER REPORT (complete):
{{report}}

Fix every problem in the report. Commit the fixes in your worktree. Then reply with a report: what you changed, files changed, how you verified it, open issues. The router sends your report to the checker again.
