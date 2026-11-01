---
name: report
description: Deliver the result of a finished run to the instance that started it.
effect: deliver
trigger: complete
target: starter
---
{{#outcome.done}}IMPLEMENTOR REPORT - '{{from.name}}' (workerId {{from.id}}, {{from.harness}} session {{from.session}}, branch {{from.branch}}) finished.

REPORT BODY (complete):
{{report}}

Now give the acceptance criteria for the validation of this work.
Start a validator with the criteria. If the work needs no validation, accept it.{{/outcome.done}}{{#outcome.pass}}{{#from.type.validator}}VALIDATION REPORT - validator '{{from.name}}' checked the work of implementor '{{source.name}}' (workerId {{source.id}}, {{source.harness}} session {{source.session}}, branch {{from.branch}}).

REPORT BODY (complete):
{{report}}

FINAL VERDICT: PASS.

Decide: accept the work, send follow-up instructions to the original implementor (POST /api/protocol/workers/{{source.id}}/continue with {"prompt": ...}), or spawn a new implementor with a corrected prompt.{{/from.type.validator}}{{#from.type.integration}}INTEGRATION REPORT - integration validator '{{from.name}}' finished. The merged result is on branch {{from.branch}} in its worktree; main/master is untouched.

REPORT BODY (complete):
{{report}}

FINAL VERDICT: PASS.

Decide: report completion to the user, or route fixes to the ORIGINAL implementors (continue endpoint) and start a new integration validator after they pass again.{{/from.type.integration}}{{/outcome.pass}}{{#outcome.reject}}{{#from.type.validator}}VALIDATION REPORT - validator '{{from.name}}' checked the work of implementor '{{source.name}}' (workerId {{source.id}}, {{source.harness}} session {{source.session}}, branch {{from.branch}}).

REPORT BODY (complete):
{{report}}

FINAL VERDICT: FAIL.

Decide: accept the work, send follow-up instructions to the original implementor (POST /api/protocol/workers/{{source.id}}/continue with {"prompt": ...}), or spawn a new implementor with a corrected prompt.{{/from.type.validator}}{{#from.type.integration}}INTEGRATION REPORT - integration validator '{{from.name}}' finished. The merged result is on branch {{from.branch}} in its worktree; main/master is untouched.

REPORT BODY (complete):
{{report}}

FINAL VERDICT: FAIL.

Decide: report completion to the user, or route fixes to the ORIGINAL implementors (continue endpoint) and start a new integration validator after they pass again.{{/from.type.integration}}{{/outcome.reject}}{{#outcome.missing}}{{#from.type.validator}}VALIDATION REPORT - validator '{{from.name}}' checked the work of implementor '{{source.name}}' (workerId {{source.id}}, {{source.harness}} session {{source.session}}, branch {{from.branch}}).

REPORT BODY (complete):
{{report}}

DIAGNOSTIC: no explicit final VERDICT: PASS or VERDICT: FAIL line was found, or this run did not complete successfully.

Decide: accept the work, send follow-up instructions to the original implementor (POST /api/protocol/workers/{{source.id}}/continue with {"prompt": ...}), or spawn a new implementor with a corrected prompt.{{/from.type.validator}}{{#from.type.integration}}INTEGRATION REPORT - integration validator '{{from.name}}' finished. The merged result is on branch {{from.branch}} in its worktree; main/master is untouched.

REPORT BODY (complete):
{{report}}

DIAGNOSTIC: no explicit final VERDICT: PASS or VERDICT: FAIL line was found, or this run did not complete successfully.

Decide: report completion to the user, or route fixes to the ORIGINAL implementors (continue endpoint) and start a new integration validator after they pass again.{{/from.type.integration}}{{/outcome.missing}}{{#outcome.timeout}}{{#from.type.implementor}}WORKER TIMEOUT - worker hit the run time limit and was interrupted. Its session and its work are intact. Continue the ORIGINAL session so it can finish: POST /api/protocol/workers/{{from.id}}/continue with {"prompt":"Finish the work from where the run was interrupted. Then report."}. After it completes, the validation loop runs as usual.{{/from.type.implementor}}{{#from.type.validator}}VALIDATOR TIMEOUT - the validator hit the run time limit and was interrupted. Validators are fresh sessions each time: the implementor work is unchanged, decide how to proceed (usually nothing - validation repeats after the next implementor completion).{{/from.type.validator}}{{#from.type.integration}}INTEGRATION TIMEOUT - integration validator '{{from.name}}' hit the run time limit. The merged work is on branch {{from.branch}}. Decide how to proceed.{{/from.type.integration}}

RUN OUTPUT (complete):
{{report}}{{#from.error}}

FAILURE DETAIL:
{{from.error}}{{/from.error}}{{/outcome.timeout}}{{#outcome.failed}}{{#from.type.implementor}}WORKER FAILURE - '{{from.name}}' (workerId {{from.id}}, session {{from.session}}): {{from.harness}} failed (see FAILURE DETAIL). Decide whether to restart it with a corrected prompt (new name, e.g. {{from.name}}-2) or to proceed without it.{{/from.type.implementor}}{{#from.type.validator}}VALIDATOR FAILURE - validator '{{from.name}}' (checking implementor '{{source.name}}', workerId {{source.id}}) failed (see FAILURE DETAIL). Decide how to proceed.{{/from.type.validator}}{{#from.type.integration}}INTEGRATION STOPPED/FAILED - integration validator '{{from.name}}' did not complete. Its worktree may be partially merged. Decide how to proceed.{{/from.type.integration}}

RUN OUTPUT (complete):
{{report}}{{#from.error}}

FAILURE DETAIL:
{{from.error}}{{/from.error}}{{/outcome.failed}}{{#outcome.stopped}}{{#from.type.implementor}}WORKER STOPPED - '{{from.name}}' (workerId {{from.id}}, session {{from.session}}) was stopped (user request or timeout). Decide whether to restart it with an updated prompt (new name) or to proceed.{{/from.type.implementor}}{{#from.type.validator}}VALIDATOR STOPPED - validator '{{from.name}}' (checking implementor '{{source.name}}', workerId {{source.id}}) was stopped. Decide how to proceed.{{/from.type.validator}}{{#from.type.integration}}INTEGRATION STOPPED/FAILED - integration validator '{{from.name}}' did not complete. Its worktree may be partially merged. Decide how to proceed.{{/from.type.integration}}

RUN OUTPUT (complete):
{{report}}{{#from.error}}

FAILURE DETAIL:
{{from.error}}{{/from.error}}{{/outcome.stopped}}