# Pipeline graphs: task list

This list breaks down `pipeline-graph-design.md` into tasks. The text uses
ASD-STE100 Simplified Technical English. Read the design document before you
start a task. The design document is the reference for all names and rules.

## Rules for every task

1. Do one task in one branch. Use the branch name `pg/<task id>`, for example `pg/A2`.
2. Do not start a task before all tasks in its "Depends on" line are merged.
3. Write the tests of the task first. Then write the code.
4. Run all tests from the repository root before you open a pull request:
   `node --test --test-timeout=60000 router-prototype/test/*.test.js`
5. Run the build check: `node router-prototype/scripts/validate-build.js`.
6. All tests must pass. Do not change an old test to make it pass, unless the task tells you to change it.
7. Add each new production `.js` file to `PRODUCTION_SCRIPTS` in `router-prototype/scripts/validate-build.js`.
8. Put new modules in `router-prototype/`. Put new tests in `router-prototype/test/`.
9. A module in phase A must not read files directly. Give it a `readFile` function or file text as an argument, unless the task says otherwise. This makes tests simple.
10. Keep the user-visible text of prompts the same, unless the task tells you to change it.
11. If a step is not clear, stop. Ask the reviewer. Do not guess.

## Order

| Phase | Tasks | Result |
|---|---|---|
| A. Formats | A1–A15 | Loaders, templates, field checks and built-in files. The router does not use them yet. |
| B. Graph-driven router | B1–B6 | The router uses the `default` pipeline. The behavior does not change. |
| C. Strict interactions | C1–C9 | The interaction API, the field checks, `accept`, generated protocol text. |
| D. Plugins, migration, UI | D1–D9 | Plugin layers, preset migration, pipelines API, new UI, cleanup. |

Phase A tasks A2, A3 and A4 can run in parallel after A1. Each later task names its dependencies.

---

## Phase A. Formats

### A1. Add the `yaml` package

Depends on: none.
Files: `router-prototype/package.json` (new), `router-prototype/package-lock.json` (new), `.github/workflows/ci.yml`, `README.md` (root).

1. Make `router-prototype/package.json`. Set `"name": "cuck-router"`, `"private": true`, and no scripts.
2. In `router-prototype/`, run `npm install --save-exact yaml@2`.
3. Make sure that `package-lock.json` is in `router-prototype/`. Commit it.
4. Make sure that `node_modules/` stays in `.gitignore`. It is there now. Do not remove it.
5. In `.github/workflows/ci.yml`, add a step before "Run unit tests":
   `run: npm ci` with `working-directory: router-prototype`.
6. In the root `README.md`, add one line to the setup steps: "Run `npm ci` in `router-prototype/`."

Done when:
- `node -e "require('./router-prototype/node_modules/yaml')"` runs without an error.
- The CI run on the pull request passes.

### A2. Template engine

Depends on: A1.
Files: `router-prototype/template.js` (new), `router-prototype/test/template.test.js` (new).

The engine is a small subset of mustache. It has no logic and no HTML escape.

1. Export `parseTemplate(text)`. It returns a tree of nodes:
   - `{ type: "text", value }`
   - `{ type: "var", name }` for `{{name}}` and `{{a.b}}`.
   - `{ type: "section", name, inverted, children }` for `{{#name}}...{{/name}}` and `{{^name}}...{{/name}}`.
2. Accept names that match `^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$`. Any other text between `{{` and `}}` is an error.
3. Throw a `TemplateError` for these faults: a section that is not closed, a close tag with a different name, a close tag with no open tag, a bad name. The error must have `line` and `column` (1-based).
4. Export `placeholders(text)`. It returns `{ vars: Set, sections: Map }`:
   - `vars` holds every name that is used as a value.
   - `sections` maps each section name to `{ inverted: boolean }`.
   - For each `var`, record the names of all sections that contain it. Rule A4.5 uses this.
5. Export `render(text, values)`:
   - A `var` inserts `String(value)`.
   - A dotted name reads nested objects.
   - A missing value is an error (`TemplateError` with the name). The engine never inserts an empty string for a missing value.
   - A normal section renders its children once when the value is truthy and not an array.
   - A normal section renders its children once per item when the value is an array. Inside the section, the item's own fields take priority over outer names.
   - An inverted section renders its children when the value is missing, `false`, `null`, `""` or `[]`.
6. Keep the module free of I/O.

Tests (one test each):
- Plain text stays the same.
- `{{a}}` and `{{a.b}}` insert values.
- Missing value throws and names the variable.
- Section with `true`, with `false`, with a list of three items.
- Inverted section with a missing value and with a value.
- Nested sections.
- Each parse fault from step 3 throws, with the correct line and column.
- `placeholders()` lists vars, sections and the sections that contain each var.

Done when: all tests pass.

### A3. Frontmatter reader

Depends on: A1.
Files: `router-prototype/frontmatter.js` (new), `router-prototype/test/frontmatter.test.js` (new).

1. Export `splitFrontmatter(text, fileName)`. The file must start with a line `---`. A second line `---` ends the header.
2. Return `{ header, body, bodyLine }`. `header` is the parsed YAML object. `bodyLine` is the 1-based line number where the body starts.
3. Parse the header with `require("yaml").parse`. Use the option `{ prettyErrors: true }`.
4. Throw `FormatError` with `file`, `line` and `message` for these faults: no first `---`, no second `---`, YAML syntax error, a header that is not a mapping.
5. Export `parseYamlFile(text, fileName)`. It parses a full YAML file and throws the same `FormatError` on faults.

Tests: one test for each fault in step 4, one good file, and an empty body.

Done when: all tests pass.

### A4. Field declarations and value checks

Depends on: A1.
Files: `router-prototype/fields.js` (new), `router-prototype/test/fields.test.js` (new).

1. Export `ROUTER_VARIABLES`, a list of name patterns: `line.*`, `node.*`, `instance.*`, `from.*`, `repo.url`, `repo.name`, `router.url`, `source.name`, `source.report`, `report`, `outcome`. Export `isRouterVariable(name)`.
2. Export `checkDeclaration(name, decl)`. It returns a list of error strings. Rules:
   - `description` is a required string, 1 to 300 characters.
   - `type` is one of `string`, `text`, `enum`, `commit`, `instance`, `repo`.
   - `string`: optional `maxLength` (default 200), optional `pattern` (a valid RegExp source).
   - `text`: optional `maxLength` (default 20000).
   - `enum`: `values` is a required non-empty list of strings.
   - `instance`: optional `node` (a node id).
   - `optional` is `true` or missing.
   - Any other key is an error.
   - A name that `isRouterVariable` accepts is an error.
3. Export `checkValues(declared, body)`. `declared` maps a field name to `{ decl, requiredBy }`. It returns `{ missing, invalid, unexpected }`:
   - `missing`: `[{ field, description, requiredBy }]` for a required field that is absent or blank after trim.
   - `invalid`: `[{ field, reason }]` for a wrong type, too long, no pattern match, or a value not in `values`.
   - `unexpected`: names in `body` that are not declared.
   - A router variable name in `body` goes into `unexpected` with the reason "set by the router".
4. Do not check `instance`, `repo` and `commit` against the line here. Only check that they are non-empty strings. Task C3 adds the line checks.
5. Rule for templates. Export `checkOptionalUse(name, decl, sectionsAround)`. An optional field may appear only inside a section with its own name. Return an error string if this is not true.

Tests: each rule in step 2, each result list in step 3, and the rule in step 5.

Done when: all tests pass.

### A5. Node type loader

Depends on: A2, A3, A4.
Files: `router-prototype/node-types.js` (new), `router-prototype/test/node-types.test.js` (new).

1. Export `loadNodeType(dirName, readFile)`. It reads `<dirName>/NODE.md` through `readFile(path)`.
2. Allowed header keys: `name`, `description`, `extends`, `session`, `workspace`, `outcome`, `coordinator`, `requires`, `fields`. Any other key is an error.
3. `name` must equal the folder name and match `^[a-z][a-z0-9-]{0,63}$`.
4. Allowed values:
   - `session`: `resume`, `fresh`.
   - `workspace`: `coordinator`, `own-worktree`, `source`, `integration`.
   - `outcome`: `none`, `verdict`.
   - `coordinator`: boolean.
   - `requires`: list with only `accepted-work`.
5. Check each `fields` entry with `checkDeclaration`.
6. Parse the body with `parseTemplate`. Report template errors with the real file line (`bodyLine + line - 1`).
7. Export `resolveTypes(types)`. `types` is a map from name to the loaded type. For each type:
   - Follow `extends` to the root. A missing parent is an error. A loop is an error that names all types in the loop.
   - Behavior keys: the child value wins. A root type without `session`, `workspace` or `outcome` is an error.
   - `fields`: merge parent first. A child may not change a parent field (same name, different declaration).
   - `body`: parent body, one empty line, child body.
8. After step 7, check every resolved body:
   - Each var that is not a router variable must be in the merged `fields`. If not, the error is "declare field `<name>` in NODE.md fields".
   - Each optional field must pass `checkOptionalUse`.
9. Each error must name the file, and the line when known.

Tests: a good type, each bad header key or value, an `extends` chain of three, a missing parent, an `extends` loop, an undeclared placeholder, an optional field outside its section, a child that changes a parent field.

Done when: all tests pass.

### A6. Interaction loader

Depends on: A2, A3, A4.
Files: `router-prototype/interactions.js` (new), `router-prototype/test/interactions.test.js` (new).

1. Export `loadInteraction(dirName, readFile)`. It reads `<dirName>/INTERACTION.md`.
2. Allowed header keys: `name`, `description`, `effect`, `trigger`, `target`, `fields`.
3. Allowed values and pairs:
   - `effect`: `create`, `deliver`, `accept`.
   - `trigger`: `request`, `complete`.
   - `target`: `new`, `chosen`, `starter`, `source`.
   - `create` needs `target: new`. `deliver` needs `chosen`, `starter` or `source`. `accept` needs `chosen`.
   - `target: chosen` needs `trigger: request`.
   - `effect: accept` is allowed only when the loader runs with `{ builtIn: true }`.
4. Check `fields` with `checkDeclaration`.
5. Parse the body as a template. For `effect: accept`, the body must be empty.
6. For `trigger: complete`, every var in the body must be a router variable, and `fields` must be empty. The error is "a complete-triggered interaction has no caller: use router variables only".
7. For `trigger: request`, apply the same rule as A5 step 8.

Tests: one good file per effect, each bad pair from step 3, a plugin that uses `accept`, the rule in step 6.

Done when: all tests pass.

### A7. Pipeline file parser

Depends on: A2, A3, A4.
Files: `router-prototype/pipelines.js` (new), `router-prototype/test/pipelines.test.js` (new).

1. Export `parsePipeline(text, fileName, readFile)`. It returns `{ name, description, start, defaults, nodes, edges }`.
2. Allowed top keys: `name`, `description`, `start`, `defaults`, `nodes`, `edges`. `defaults` allows only `prompt`.
3. Each node: `type` (required), `harness`, `model`, `effort`, `timeLimit`, `maxContext`, `prompt`, `fields`, `checks`.
   - Check `harness`, `model`, `effort`, `timeLimit`, `maxContext` with the rules in `validatePipelineConfig` (`pipeline-config.js`). Move the shared rule code into a function that both modules use. Do not copy it.
   - The `maxContext` rule must use the node type later (B2). Here, accept it for any node.
   - Node ids match `^[A-Za-z][A-Za-z0-9-]{0,63}$`.
4. `prompt` is a string, or `{ file: <relative path> }`.
   - For `file`, resolve the path against the folder of the pipeline file. Refuse a path that goes outside that folder (after `path.resolve`). Read it with `readFile`.
   - Parse the prompt text as a template.
5. `fields` entries: check with `checkDeclaration`.
6. `checks` is a list of node ids.
7. Edges: each item is a string. Parse it with this grammar:
   - `<side> -> <side>: <name>[, <name>...]`
   - `<side>` is a node id, or `[id, id, ...]`.
   - Expand lists to all pairs.
   - Return edges as `{ from, to, interactions: [names] }`.
   - Two edges for the same pair are an error. Join them in the file instead.
8. Each error names the file. For an edge, give the edge text and its index.

Tests: a full good file, each bad top key, a bad node key, a prompt file outside the folder, an edge with lists, each edge syntax fault, a duplicate pair.

Done when: all tests pass.

### A8. Pipeline rules

Depends on: A5, A6, A7.
Files: `router-prototype/pipeline-rules.js` (new), `router-prototype/test/pipeline-rules.test.js` (new).

1. Export `checkPipeline(pipeline, types, interactions)`. `types` are resolved (A5). It returns a list of `{ rule, message }`. An empty list means the pipeline is good.
2. Write one function per rule from the design document, "Validation rules for a pipeline":
   - R1: one start node, and it exists.
   - R2: every node is reachable from the start node. Follow edges whose interaction has `effect: create`.
   - R3: the create edges have no cycle. Name the nodes in the cycle.
   - R4: every node except the start node has an edge with a `trigger: complete` interaction. Follow those edges, and treat `target: starter` as the node that starts it (through create edges). Every path must end at the start node.
   - R5: in v1, edges with `trigger: request` interactions must have `from` = the start node.
   - R6: a `deliver` edge needs a target type with `session: resume`. For `target: starter`, check the starter node type.
   - R7: every node `fields` entry must pass A4. Every caller var in `defaults.prompt` and the node `prompt` must be declared in the node `fields` or the type `fields`. Optional fields only inside their own sections.
   - R8: unknown type, unknown interaction, unknown node in an edge or in `checks`.
   - R9: a node with `checks` must have a type with `workspace: source`. Each checked node must have a type with `workspace: own-worktree`.
3. Run all rules. Do not stop at the first error.

Tests: one good pipeline. For each rule, one bad pipeline that breaks only that rule.

Done when: all tests pass.

### A9. Required fields of a call

Depends on: A8.
Files: `router-prototype/call-fields.js` (new), `router-prototype/test/call-fields.test.js` (new).

1. Export `requiredFields(resolved, interactionName, toNodeId)`. `resolved` is the output of A10. It returns a map `field -> { decl, requiredBy }`.
2. Build the map in this order. Each entry records where it came from:
   1. Caller vars of the interaction body: `requiredBy: "interaction <name>"`.
   2. For `effect: create`: caller vars of the target type body, `defaults.prompt` and the node `prompt`: `requiredBy: "node type <type>"` or `"pipeline node <id>"`.
   3. Effect fields:
      - `instance` (type `instance`) for `target: chosen`.
      - `repo` (type `repo`) and optional `base` (type `string`) for workspace `own-worktree`.
      - `source` (type `instance`, `node` = the `checks` nodes) for workspace `source`.
      - `name` (optional `string`) for every `create`.
3. If two sources declare one field in different ways, throw. This is a pipeline error, and A10 must report it at load time.
4. Export `checkCall(resolved, interactionName, toNodeId, body)`. It returns `{ ok, missing, invalid, unexpected, expected }`. Use `checkValues`. `expected` maps each field to a short text, for example `"text, required"`.

Tests: `start` on an implementor needs `task` and `repo`. `start` on a validator needs `criteria` and `source`. `feedback` needs `instance` and `instructions`. A node `prompt` with `{{riskLevel}}` adds `riskLevel`. A body with an extra key and a router variable gives `unexpected`.

Done when: all tests pass.

### A10. Resolve a pipeline

Depends on: A8, A9.
Files: `router-prototype/resolve-pipeline.js` (new), `router-prototype/test/resolve-pipeline.test.js` (new).

1. Export `resolvePipelineDefinition(name, catalog)`. `catalog` has `{ types, interactions, pipelines }`, each a map from name to `{ text or folder, layer }`.
2. Load the pipeline. Load only the types and interactions it uses, with their parents.
3. Run `checkPipeline`. For every request-triggered edge, run `requiredFields` for each target to find conflicts.
4. If there are errors, throw `PipelineError` with the full error list.
5. Return a plain JSON object. It must contain all text it needs. Later, `line.json` stores it, and the router must not read plugin files again:
   `{ name, layer, start, defaults, nodes: { id: { type, settings, prompt, fields, checks } }, edges, types: { name: resolvedType }, interactions: { name: interaction } }`.
6. Test that `JSON.parse(JSON.stringify(result))` equals `result`.

Done when: all tests pass.

### A11. Built-in implementor types

Depends on: A10.
Files: `router-prototype/node-types/implementor/NODE.md`, `.../backend-implementor/NODE.md`, `.../frontend-implementor/NODE.md` (all new), `router-prototype/test/builtin-prompts.test.js` (new).

1. Copy the text of `workerBrief()` in `server.js` into `implementor/NODE.md`. Copy the text of `IMPL_PERSONA.backend` and `IMPL_PERSONA.frontend` into the persona files. Copy `frontendToolsBlock()` into `frontend-implementor`.
2. Replace each `${...}` expression with a placeholder.
   - Use router variables where the value comes from the router.
   - Use declared fields where the planner gives the value (`task`, `trackerTicket`).
3. Replace each `${cond ? a : b}` with a section, or with a section and an inverted section.
4. Set the header: `implementor`: `session: resume`, `workspace: own-worktree`, `outcome: none`, `coordinator: false`. Persona types: `extends: implementor`.
5. Write `builtin-prompts.test.js`.
   - Get the old functions from `server.js` source. Use the method in `test/integration-server-lifecycle.test.js`. Do not `require("server.js")`, because that starts the server.
   - For three input sets (no remote, remote, tracker ticket), render the new template and call the old function.
   - The two strings must be equal.
6. If a difference is only white space, change the template, not the test.

Done when: the equality test passes for both personas and all three input sets.

### A12. Built-in validator types

Depends on: A11.
Files: `node-types/validator/NODE.md`, `node-types/backend-validator/NODE.md`, `node-types/frontend-validator/NODE.md`, `test/builtin-prompts.test.js`.

1. Do the steps of A11 for `validatorBrief()`, `VAL_PERSONA` and `frontendToolsBlock()`.
2. Header for `validator`: `session: fresh`, `workspace: source`, `outcome: verdict`.
3. `criteria` is a declared field of type `text`. `source.report` and `source.name` are router variables.
4. Add equality tests for the remote and the no-remote case.

Done when: the equality tests pass.

### A13. Built-in integration validator type

Depends on: A11.
Files: `node-types/integration-validator/NODE.md`, `test/builtin-prompts.test.js`.

1. Do the steps of A11 for `integrationValidatorBrief()`.
2. The per-repo list uses a section over the router variable `integration.repos`, with a nested section over `branches`. Add `integration.*` to `ROUTER_VARIABLES` in `fields.js`.
3. Header: `session: fresh`, `workspace: integration`, `outcome: verdict`, `requires: [accepted-work]`.
4. `instructions` is a declared field of type `text`. It holds the planner's integration instructions.
5. Add an equality test with the manifest from `test/integration-server-lifecycle.test.js`.

Done when: the equality test passes.

### A14. Built-in planner type

Depends on: A11.
Files: `node-types/planner/NODE.md`, `test/builtin-prompts.test.js`.

1. Do the steps of A11 for `plannerBrief()`.
2. Mark the protocol part with HTML comments: put `<!-- protocol:start -->` before "## Factory protocol" and `<!-- protocol:end -->` after the integration step. Task C8 replaces this part with generated text.
3. Header: `session: resume`, `workspace: coordinator`, `outcome: none`, `coordinator: true`.
4. The user's first prompt is the declared field `task`.
5. The renderer must remove HTML comments before it compares. Add this to the test, not to `template.js`.
6. Add an equality test with and without a tracker ticket.

Done when: the equality test passes.

### A15. Built-in interactions and pipelines

Depends on: A12, A13, A14.
Files: `router-prototype/interactions/{start,feedback,report,accept}/INTERACTION.md`, `router-prototype/pipelines/default.yaml`, `router-prototype/pipelines/minimal.yaml` (all new), `test/builtin-pipelines.test.js` (new).

1. Write the four interactions as the table "Built-in interactions" in the design document shows.
   - `feedback`: copy the follow-up text from the `/continue` handler in `server.js`.
   - `report`: copy the wake text from `buildImplementorNotification`, `buildValidationNotification` and `buildIntegrationNotification` in `handoff.js`. Use sections on `outcome` and `from.type` to keep one template.
2. Write `default.yaml` and `minimal.yaml` as the design document shows. Add `checks:` to the validator nodes.
3. Write a test that resolves both pipelines with only the built-in files. The error list must be empty.

Done when: the test passes and the full suite passes.

---

## Phase B. Graph-driven router

The router behavior must not change in this phase. All existing tests must pass without changes, unless a task tells you to change a test.

### B1. Store the graph on a line, and migrate old lines

Depends on: A15.
Files: `router-prototype/line-graph.js` (new), `server.js`, `test/line-graph.test.js` (new).

1. In `line-graph.js`, export `PHASE_TYPES`:
   `{ planner: "planner", implementor: "implementor", validator: "validator", integration: "integration-validator" }`.
2. Export `phaseOfType(resolved, typeName)`. Follow `extends` to the root type, and return the phase for that root.
3. Export `migrateLine(meta, resolvedDefault)`. It returns a new meta object:
   - If `meta.graph` exists, return `meta` unchanged.
   - Set `graph` to `resolvedDefault`.
   - Set `nodeSettings`. For each `meta.pipeline[phase]`, copy the settings to every node whose type maps to that phase.
   - For each worker, set `node`. Use the mapping in the design document, section "Migration from the current configuration".
   - For each implementor with `validationSkipped`, add `acceptedRuns: [{ runId, invocationId, by: "migration" }]`.
   - Keep `pipeline` for one release. B6 reads it for the old API view.
4. In `loadLines()` in `server.js`, call `migrateLine()` after `JSON.parse`. The next `saveLine()` writes the new form. Add `graph`, `nodeSettings`, `node` and `acceptedRuns` to `saveLine()`.
5. Load the `default` pipeline one time at boot with `resolvePipelineDefinition`. Read built-in files only in this task.
6. In `POST /api/lines`, set `line.graph` to the resolved `default` pipeline.

Tests:
- `migrateLine` with an old line that has phase settings, two implementors (backend, frontend), their validators and one integration validator.
- A new line has `graph.name === "default"`.

Done when: these tests pass and the full suite passes.

### B2. Node settings replace phase settings

Depends on: B1.
Files: `pipeline-config.js`, `spawn-plan.js`, `server.js`, `test/pipeline-config.test.js`.

1. In `pipeline-config.js`, export `resolveNodeSettings(line, nodeId, env)`.
   - The order is: code defaults for the phase of the node type, then the env vars for that phase, then the pipeline file node settings, then `line.nodeSettings[nodeId]`.
   - Keep the same harness and model rule as `resolvePipeline()`: an env model applies only to the env harness.
2. Allow `maxContext` only for node types with `session: resume`.
3. Change `resolvePipeline(line, env)` so that it returns the old per-phase view. For each phase, use the first node of that phase in pipeline order. Old callers keep working.
4. In `server.js`, replace each `resolvePipeline(line)[phase]` for a worker with `resolveNodeSettings(line, worker.node)`. Replace `phaseForWorker` calls that select settings.
5. For the planner, use the start node.

Tests: the existing `pipeline-config` tests pass. Add tests for env defaults per phase, for node settings that win, and for `maxContext` on a fresh node.

Done when: all tests pass.

### B3. Workers belong to nodes

Depends on: B1.
Files: `server.js`, `test/line-repos-api.test.js`.

1. On every worker that the router makes, set `node`:
   - `/workers`: `backend-impl` or `frontend-impl`, by `persona`.
   - `spawnValidator`: the validator node whose `checks` has the implementor's node.
   - `/integration`: the node of type `integration-validator`.
2. If no node fits, return 500 with the text "pipeline has no node for <role>". Do not guess.
3. Add `node` to the worker objects in `GET /api/protocol/lines/:id/workers` and in the dashboard state.
4. Extend `test/line-repos-api.test.js`: the seeded implementor must get `node: "backend-impl"` after the load.

Done when: all tests pass.

### B4. Prompts from templates

Depends on: B2, B3.
Files: `router-prototype/prompt-builder.js` (new), `server.js`, `test/prompt-builder.test.js` (new).

1. In `prompt-builder.js`, export `buildPrompt(resolved, nodeId, routerValues, callerValues)`. It returns one string with these parts, in this order:
   1. The type body (parents first).
   2. `defaults.prompt`.
   3. The node `prompt`.
   Join the parts with one empty line. Leave out empty parts.
2. Router rules (step 1 of "How a node's prompt is built") are already in the current brief text. Do not add them two times in this task.
3. In `server.js`, replace the calls to `workerBrief`, `validatorBrief`, `integrationValidatorBrief` and `plannerBrief` with `buildPrompt`. Fill `routerValues` from the line and the worker. Fill `callerValues` from the request body.
4. Keep the old functions until C8. The equality tests in `builtin-prompts.test.js` use them.
5. Keep the delivery as today: the prompt is the first turn.

Tests: `buildPrompt` with a node `prompt` and `defaults.prompt`. The full suite must pass. It contains tests that read the brief text.

Done when: all tests pass.

### B5. Use the trusted system prompt channel

Depends on: B4.
Files: `server.js`, `spawn-plan.js`, `test/spawn-plan.test.js`.

1. Split the result of `buildPrompt` into two parts:
   - The role part: the type and extension text.
   - The task part: the caller's `task`, `criteria` or `instructions`, and the source report.
   Add a template marker `<!-- task -->` to the built-in types at the split point.
2. If `harness.systemPromptChannel` is not null, pass the role part as `systemPrompt` to `planWorkerRun` / `planPlannerRun`. Pass only the task part as the prompt.
3. If the channel is null (vibe), send both parts in the first turn, as today.
4. On a resumed session, send the system prompt again on every run, because the CLI does not keep it. On a reseed after compaction, do the same.

Tests: one test per harness id. Check the plan arguments.

Done when: all tests pass.

### B6. API compatibility for settings

Depends on: B2.
Files: `server.js`, `test/pipeline-api.test.js` (new).

1. `POST /api/lines` accepts:
   - `pipelineName` (default `"default"`).
   - `nodeSettings` (a map from node id to settings).
   - The old `pipeline` (a map from phase to settings). Map it to `nodeSettings` with `PHASE_TYPES`.
2. If the body has both `nodeSettings` and `pipeline`, return 400.
3. `PUT /api/lines/:id/pipeline` accepts `{ nodeSettings }` or the old `{ pipeline }`.
4. `GET /api/lines/:id` and the dashboard state return `graph` (name, start, nodes, edges), `nodeSettings`, the effective settings per node, and the old `pipeline` view.
5. A node id in `nodeSettings` that is not in the graph is a 400 error.

Tests: each body shape and each error, through the router (use `test/fixtures/router-process.js`).

Done when: all tests pass.

---

## Phase C. Strict interactions

### C1. Move instance creation into functions

Depends on: B3.
Files: `server.js`, `router-prototype/instances.js` (new, if the code is large).

1. Move the creation code out of the HTTP handlers into three functions. Each returns `{ instance }` or `{ status, error }`:
   - `createOwnWorktree(line, nodeId, fields)` from `POST /workers`.
   - `createSourceChecker(line, nodeId, sourceInstance, fields)` from `spawnValidator`.
   - `createIntegration(line, nodeId, fields)` from `POST /integration`.
2. Add `createCoordinator()` only if the start node needs it. In v1 it does not: the line makes the planner.
3. The HTTP handlers call the new functions. Their responses stay the same.
4. Do not change behavior.

Done when: the full suite passes without test changes.

### C2. The interaction endpoint

Depends on: A9, C1.
Files: `server.js`, `test/interactions-api.test.js` (new).

1. Add `POST /api/protocol/lines/:id/interactions/:name`.
2. Do the checks in this order:
   1. Unknown line: 404.
   2. Unknown interaction name in the line graph: 404.
   3. The interaction has `trigger: complete`: 405 with "the router performs this interaction".
   4. Find the target node: `to` for `target: new`, the node of `instance` for `target: chosen`. Unknown: 404.
   5. Edge check: the edge `<start node> -> <target node>` must list the interaction. If not, return 403 with `code: "NO_EDGE"` and `allowed`, the list of interactions this caller can use.
   6. Field check with `checkCall`. If not ok, return 400 with `code: "INTERACTION_FIELDS"` and the response shape from the design document.
   7. The plan must be approved for `effect: create` and `deliver`. Use the same rule as `/workers`.
3. Perform the effect. For `create`, call the function for the workspace of the target type (C1).
4. Return 201 for `create` with `{ instance }`, 202 for `deliver`, and 200 for `accept`.

Tests: one test for each status in step 2, a good `start` of an implementor, and a 400 that lists two missing fields and one unexpected field.

Done when: all tests pass.

### C3. Check field values against the line

Depends on: C2.
Files: `call-fields.js`, `server.js`, `test/interactions-api.test.js`.

1. Add `checkLineValues(line, required, body)`. Add its problems to `invalid`:
   - `instance`: the instance must exist on this line and must not be running. If `decl.node` is set, the instance must belong to one of those nodes.
   - `repo`: the repo must be registered on the line.
   - `commit`: it must be 40 lowercase hex characters, and it must exist in the repo of the call (`git cat-file -e <sha>^{commit}`).
2. Call it in C2 step 2.6, after `checkCall`.

Tests: each rule with a good and a bad value.

Done when: all tests pass.

### C4. The `deliver` effect

Depends on: C2.
Files: `server.js`.

1. Move the code of `POST /api/protocol/workers/:id/continue` into `deliverToInstance(line, instance, message)`.
2. In C2, for `effect: deliver`, render the interaction body with the fields and router values. Call `deliverToInstance`.
3. Keep the `/continue` route. It calls `deliverToInstance`. C9 changes it to an alias.

Tests: `feedback` through the new endpoint makes the implementor run again with the rendered text.

Done when: all tests pass.

### C5. The `accept` effect and the integration rule

Depends on: C2.
Files: `server.js`, `line-repos.js`, `test/line-repos.test.js`.

1. For `effect: accept`, add `{ runId, invocationId, by: "planner", reason, at }` to `instance.acceptedRuns`. Use the current run. Save the line.
2. Refuse `accept` for an instance that is running (409).
3. Change `integrationSelection()` in `line-repos.js`. An instance is accepted when one of these is true for its latest run:
   - `acceptedRuns` has an entry for the run.
   - A checker instance with `source` = this instance has `verdict: pass` for the run.
4. Keep the old `validationSkipped` check until D9. Migrated lines use it.
5. Use the workspace kind, not the role, to find which instances need acceptance: every instance of a node with `workspace: own-worktree`.

Tests: update the `integrationSelection` tests for `acceptedRuns`. Add a test for an `accept` of an old run.

Done when: all tests pass.

### C6. Reports as interactions

Depends on: C4.
Files: `server.js`, `handoff.js`, `planner-request.js`, `test/handoff.test.js`.

1. When an instance's run ends, find the edges from its node with a `trigger: complete` interaction.
2. For each one, render the interaction body with router values (`from.*`, `report`, `outcome`) and deliver it to the target (`starter` or `source`).
3. `outcome` is `pass`, `reject` or `missing` for a type with `outcome: verdict`. It is `done`, `failed`, `stopped` or `timeout` for other types. The current failure, stop and timeout texts in `workerClosed()` must move into the `report` template as sections.
4. New implementor reports no longer ask the planner for criteria. The planner now calls `start` on a validator node, or `accept`. The report text tells the planner this.
5. In-flight requests: a queued planner request with a criteria `source` from before this change keeps the old path through `completePlannerCriteria`. Mark new report requests with `flow: "interactions"`. Use the old path only for requests without this mark.
6. Update the tests that check the old report text. This task is allowed to change them. Each change must only change the text, not the meaning of the test.

Done when: all tests pass.

### C7. Introspection

Depends on: C3.
Files: `server.js`, `test/interactions-api.test.js`.

1. Add `GET /api/protocol/lines/:id/interactions`.
2. Return `{ caller, interactions: [{ name, description, effect, target, to: [{ node, fields: expected }] }] }` for the start node.
3. Use `requiredFields` for each target, so the fields are the same fields that C2 enforces.

Tests: the result for the `default` graph lists `start` to four nodes, `feedback` to two nodes and `accept` to two nodes, with the correct fields.

Done when: all tests pass.

### C8. Generated protocol section

Depends on: C7.
Files: `prompt-builder.js`, `node-types/planner/NODE.md`, `server.js`, `test/prompt-builder.test.js`, `test/builtin-prompts.test.js`.

1. Export `protocolSection(resolved, nodeId, routerUrl)`:
   - For the start node: one block per allowed interaction and target. Each block gives the exact `curl` call and the field list with descriptions.
   - For other nodes: one sentence that says where the report goes.
2. Write the text in ASD-STE100. Use the existing planner text as the model.
3. Remove the text between `<!-- protocol:start -->` and `<!-- protocol:end -->` in `planner/NODE.md`. Put `{{protocol}}` in its place, and add `protocol` to `ROUTER_VARIABLES`.
4. `buildPrompt` fills `protocol` from `protocolSection`.
5. Remove the old brief functions from `server.js`. Remove their equality tests. Keep tests that check important sentences of the new text.
6. Update `test/planner-brief-registry.test.js` and other tests that read planner text. Check the meaning, not the exact old words.

Done when: all tests pass. A planner prompt for `review-gate.yaml` lists only `start`, `feedback` and `accept` for the nodes that have those edges.

### C9. Old routes become aliases

Depends on: C5, C6.
Files: `server.js`, `README.md`.

1. `POST /api/protocol/lines/:id/workers` calls the interaction code with `start`. Map `persona` to the node. Map `prompt` to `task`.
2. `POST /api/protocol/workers/:id/continue` calls `feedback`. Map `prompt` to `instructions`.
3. `POST /api/protocol/lines/:id/integration` calls `start` on the integration node. Map `prompt` to `instructions`.
4. Keep the old response shapes.
5. Add a `Deprecation: true` header to these responses.
6. In `README.md`, mark these routes as deprecated, with the new call.

Done when: all old route tests pass without changes.

---

## Phase D. Plugins, migration, UI

### D1. Plugin layers

Depends on: A10.
Files: `router-prototype/plugin-catalog.js` (new), `server.js`, `test/plugin-catalog.test.js` (new).

1. Export `buildCatalog({ managedDir, userDir, builtInDir, readDir, readFile })`.
2. Layers, highest priority first: managed (`<LINES_DIR>/plugins`), user (`$CUCK_HOME` or `~/.cuck`), built-in (`router-prototype/`).
3. In each layer, read `node-types/*/NODE.md`, `interactions/*/INTERACTION.md` and `pipelines/*.yaml`.
4. A non-built-in file with a built-in name is an error. A name in two non-built-in layers: the higher layer wins, and the catalog records a `shadowed` note.
5. A file that fails to load does not stop the catalog. Record `{ layer, path, errors }` in `catalog.problems`. A pipeline that uses a broken file fails at resolve time.
6. In `server.js`, build the catalog at boot. Rebuild it after each write through the pipelines API (D3).
7. `POST /api/lines` with `pipelineName` resolves from the catalog.
8. Tests use temporary folders. Set `CUCK_HOME` for the user layer.

Tests: one file per layer, a shadowed name, a built-in name in the user layer, a broken file in `problems`.

Done when: all tests pass.

### D2. Migrate presets

Depends on: D1, B6.
Files: `router-prototype/preset-migration.js` (new), `server.js`, `test/preset-migration.test.js` (new).

1. Export `migratePresets({ presetsFile, managedDir, defaultPipelineText, fs })`. Run it at boot, before `buildCatalog`.
2. If `pipeline-presets.json` does not exist, do nothing.
3. For each preset:
   - Make a file name: lowercase, `[a-z0-9-]` only, at most 60 characters.
   - If the name is empty or already used, add `-2`, `-3`, and so on.
   - Write `<managedDir>/pipelines/<file>.yaml`. It is the default pipeline with `name: <file>`, `description: "Migrated from preset '<old name>'"`, and the preset settings on the mapped nodes (`PHASE_TYPES`).
4. Write each file to a temporary name first, then rename it.
5. When all files are written, rename `pipeline-presets.json` to `pipeline-presets.json.migrated`.
6. Write one boot log line for each preset with the old and the new name.
7. If an error occurs, keep the old file. Remove the files that this run wrote. Log the error. The router continues.
8. Make the old routes `/api/pipeline-presets*` return 410 with `{ error, use: "/api/pipelines" }`.

Tests: two presets, a name collision, an unsafe name, an error that rolls back, a second boot that does nothing.

Done when: all tests pass.

### D3. Pipelines API

Depends on: D1.
Files: `server.js`, `router-prototype/pipelines-api.js` (new), `test/pipelines-api.test.js` (new).

1. `GET /api/pipelines`: list pipelines, node types and interactions. Each item has `{ name, description, layer, editable, problems }`. `editable` is true only for the managed layer.
2. `GET /api/pipelines/:name`: `{ name, layer, editable, text, resolved, errors }`. `text` is the YAML source. `resolved` is null when `errors` is not empty.
3. `POST /api/pipelines/validate` with `{ text }`: parse and resolve without a write. Return `{ errors, graph }`. `graph` has nodes and edges for the preview.
4. `PUT /api/pipelines/:name` with `{ text }`:
   - Write to the managed layer only.
   - The `name` in the text must equal `:name`.
   - Refuse text with errors (400 with the error list).
   - Write to a temporary file, then rename it.
   - Rebuild the catalog.
5. `DELETE /api/pipelines/:name`: managed layer only. Lines that use it keep their own copy.
6. `POST /api/pipelines/:name/duplicate` with `{ newName }`: copy any pipeline to the managed layer with the new name.
7. Limit `text` to 256 KB.
8. Pipeline names match `^[a-z0-9][a-z0-9-]{0,59}$`.
9. Only pipelines can be edited in v1. Node types and interactions are read-only in the API.

Tests: each route, each error, and a PUT to a built-in name (403).

Done when: all tests pass.

### D4. Create panel

Depends on: D3, B6.
Files: `web/index.html`, `web/pipeline-ui.js`, `test/pipeline-ui.test.js`.

1. Replace the preset bar in the create panel with a pipeline picker (`<select>`). Fill it from `GET /api/pipelines`. Show `name — description (layer)`. Select `default` first.
2. Change `createPipelineForm()`. It must take a node list, not `PHASE_ROWS`. Make one row per node, with the node id and type as the row title.
3. Rows for `session: fresh` types have no max-context control.
4. When the picker changes, fetch `GET /api/pipelines/:name`, then rebuild the rows.
5. On "Create", send `{ name, repoUrl, pipelineName, nodeSettings }`.
6. Add the button "Save as pipeline":
   - Ask for a name.
   - Call `POST /api/pipelines/:name/duplicate`.
   - Read the new text, put the form settings into the node entries, and call `PUT`.
   - Show the errors from the server.
7. Move pure logic (the rows from a graph, the settings to the body) into `pipeline-ui.js`. Test it there. Keep DOM code in `index.html`.
8. Keep `PHASE_ROWS` in `pipeline-ui.js` until D9. Old code paths may use it.

Tests: the rows for `default` and for `review-gate`, the request body, and the fresh-session rule.

Done when: all tests pass. A manual check in the browser shows the picker and the rows. Attach a screenshot to the pull request.

### D5. Pipeline tab of a line

Depends on: D4.
Files: `web/index.html`, `web/pipeline-ui.js`, `test/pipeline-ui.test.js`.

1. Add a graph view to the pipeline tab. Use inline SVG. Do not add a library.
2. Layout:
   - Column = the longest path from the start node over create edges. The start node is column 0.
   - Row = the order of the nodes in the file, inside each column.
   - Put this layout function in `pipeline-ui.js`. It must be pure, and it must have tests.
3. Draw one arrow per edge. Label it with the interaction names. Draw `complete`-triggered edges with a dashed line.
4. Under the graph, show the effective settings per node and the form from D4 for this line.
   - Save with `PUT /api/lines/:id/pipeline {nodeSettings}`.
   - The graph structure is read-only here. Show the text "The pipeline structure of a line does not change after creation."
5. Remove the old per-phase summary rows.
6. Make sure that the view works in light and dark theme, and at 375 px width.

Tests: the layout function for `default`, `minimal` and `review-gate`.

Done when: all tests pass. Attach screenshots (light, dark, 375 px) to the pull request.

### D6. Pipelines page

Depends on: D3, D5.
Files: `web/pipelines.html` (new), `web/pipelines-page.js` (new), `server.js` (serve the files), `scripts/validate-build.js`, `test/pipelines-page.test.js` (new).

1. Serve `/pipelines` from `web/pipelines.html`. Add a link to it in the main sidebar.
2. Left side: the lists from `GET /api/pipelines`, in three groups (pipelines, node types, interactions). Show the layer, and show problems with a warning mark.
3. Right side for a read-only item: the source text and a "Duplicate to edit" button (pipelines only).
4. Right side for a managed pipeline: a `<textarea>` editor and the graph preview (reuse the D5 layout function and SVG code).
   - After the user stops typing for 400 ms, call `POST /api/pipelines/validate`.
   - Show the errors under the editor. Show the rule id and the message.
   - Show the graph from the last good result.
5. "Save" calls `PUT`. Disable "Save" while there are errors.
6. "Delete" asks for confirmation, then calls `DELETE`.
7. Add the new web files to `PRODUCTION_SCRIPTS` and `REQUIRED_WEB_ASSETS`.

Tests: the pure logic (the debounce rule, the save state from an error list) in `pipelines-page.test.js`.

Done when: all tests pass. Attach a screen recording of one edit with an error, a fix and a save.

### D7. End-to-end plugin example

Depends on: C8, D1.
Files: `router-prototype/test/fixtures/plugins/` (new), `test/plugin-e2e.test.js` (new), `test/fixtures/router-process.js`.

1. In `test/fixtures/plugins/node-types/security-reviewer/NODE.md`, write the type from the design document.
2. In `test/fixtures/plugins/pipelines/review-gate.yaml`, write the pipeline from the design document. Add a node `prompt` with a `{{riskLevel}}` field.
3. Add a fake `vibe` command to the router fixture, in the same way as the fake `docker` command. It writes the lines of `test/fixtures/vibe.jsonl` and ends with exit code 0. Let a test choose the final text, for example `VERDICT: FAIL`.
4. Start the router with `CUCK_HOME=test/fixtures/plugins`. Make a line with `pipelineName: "review-gate"` and approve the plan.
5. Check these steps through the API:
   1. `start` on `A` without `repo` returns 400 and lists `task` and `repo`.
   2. `start` on `A` with all fields returns 201.
   3. The planner gets the report of `A`.
   4. `start` on `B` without `riskLevel` returns 400, and `riskLevel` is in `missing` with its description.
   5. `start` on `B` with all fields returns 201, and `B` ends with `VERDICT: FAIL`.
   6. The planner gets a report with outcome `reject`.
   7. `feedback` to `A` returns 202.
   8. `feedback` to `B` returns 403 `NO_EDGE`.

Done when: the test passes in CI.

### D8. Documentation

Depends on: D6, D7.
Files: `router-prototype/README.md`, `router-prototype/docs/pipeline-graph-design.md`.

1. Add a README section "Pipelines, node types and interactions". It must contain: the file formats, the plugin layers, the strict call rules with one error example, and the pipelines page.
2. Add a section "Write a node type". Use `security-reviewer` as the example.
3. Mark the old API routes and the presets API as deprecated, with the replacement for each.
4. Change the status line of the design document to "Implemented".

Done when: the reviewer accepts the text.

### D9. Remove the old code (next release)

Depends on: all other tasks, and one released version with the deprecation headers.
Files: `server.js`, `planner-request.js`, `pipeline-config.js`, `web/pipeline-ui.js`, `line-graph.js`, tests.

1. Remove `completePlannerCriteria`, the criteria parse path, and requests without `flow: "interactions"`.
2. Remove the `/api/pipeline-presets*` routes.
3. Remove the old `pipeline` request shape and the old per-phase `GET` view.
4. Remove `PHASE_ROWS` and `resolvePipeline`'s phase view.
5. Remove `validationSkipped` support. Before you remove it, make sure that the boot migration converted it to `acceptedRuns` on all lines.
6. Keep `migrateLine` for lines older than this release.

Done when: all tests pass. No code refers to the removed names (`git grep` returns nothing).
