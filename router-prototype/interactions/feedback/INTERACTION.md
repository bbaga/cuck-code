---
name: feedback
description: Send follow-up instructions to an existing instance. It resumes its session.
effect: deliver
trigger: request
target: chosen
fields:
  instructions:
    description: The corrected or additional instructions, written for the instance.
    type: text
    maxLength: 20000
---
Follow-up instructions from the planner (write them in ASD-STE100):
{{instructions}}

When done, reply with a report: what you changed, files changed, how you verified it, open issues. That report goes back to the planner verbatim.