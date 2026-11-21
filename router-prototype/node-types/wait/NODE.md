---
name: wait
description: Waits until each member task arrives with a PASS, then starts the next step or reports to the planner.
runner: wait
session: fresh
workspace: none
outcome: verdict
coordinator: false
fields:
  members:
    description: The chain head instances this batch waits for. Give their names or ids, separated by commas.
    type: instances
---
This node waits for its member tasks. No agent runs.
