---
name: accept
description: Record that the coordinator accepts the latest run of an instance without a check.
effect: accept
trigger: request
target: chosen
fields:
  instance:
    description: The instance whose latest run is accepted.
    type: instance
  reason:
    description: Why the work needs no check.
    type: string
---
