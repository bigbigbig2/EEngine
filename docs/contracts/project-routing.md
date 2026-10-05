---
id: project-routing
kind: contract
status: frozen
owners:
  - platform
version: 5
consumers:
  - tools/vibe.mjs
  - AGENTS.md
invariants:
  - every routed code path has one primary owner
  - daily navigation is independent of acceptance metadata
validation:
  - node tools/vibe.mjs context <path>
  - node --check tools/vibe.mjs
state: current
verifies:
  - tools/vibe.mjs
  - tools/vibe-acceptance.mjs
  - tools/vibe-lib.mjs
---
# Project Routing

`project/domains/*.yaml` owns path-to-domain routing. The highest specificity match is primary; ties are ambiguous. `currentDocs` points to the declared documentation, while the active workstream provides the current slice. Source code remains the implementation authority.

Daily `node tools/vibe.mjs context <path>` reads domain/workstream navigation without checks, browser registry or evidence. `context --all` explicitly uses the expanded model. Navigation is not permission or proof of implementation.

`verify --module` runs engine typecheck/build and only explicitly named targeted tests. `verify --full` currently runs catalog checks and suites; it does not schedule matched browser cases. `registry` generates runtime case input, and `doctor` checks model/registry structure.

The claim layer and vibe evidence/status/case commands are retired. Cases run through `validation/src/runner/run-case.mjs`; source/contract relationships remain navigation, not claim policies.

Both context modes use tools/project-navigation.mjs. Renderer design/execution come from the active workstream's authority; missing or historical targets are rejected. Paused workstreams are listed separately from current modules. Navigation remains independent of acceptance artifacts.
