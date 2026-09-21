---
id: project-routing
kind: contract
status: frozen
owners: 
  - platform
version: 1
consumers: 
  - tools/vibe.mjs
  - AGENTS.md
invariants: 
  - every existing changed file has a domain
  - primary owner is explicit
validation: 
  - node tools/vibe.mjs verify --changed
  - OEngine/tests/guard/check-runners.test.mjs
---
# Project Routing

`project/domains/*.yaml` is the path router. Each domain has one `primaryOwner`; overlapping paths may remain related, but equal-strength matches must be resolved by making one pattern more specific. `project/claims/*.yaml` states durable, cross-owner claims and names the watch paths, required checks, and allowed declarations. `checks/checks.yaml` describes executable or built-in checks.

The source is read with the YAML parser; duplicate keys and parse warnings are errors. `node tools/vibe.mjs context <path>` prints the route. `node tools/vibe.mjs verify --changed` regenerates the validation registry and fails when a changed file has no domain route or has an unresolved primary-owner tie.

## Checks

`checks/checks.yaml` and `checks/guards/*.yaml` declare *what* each check asserts, including the `config` parameters that used to be hard-coded. `tools/check-runners.mjs` owns *how* it runs and is bound through the check's `runner` field. A check whose `runner` is not registered is a model error, and an unknown runner can never report `passed`.

The verification level is derived from the product surface a change can touch. Only `OEngine/src/**` and `validation/**` are considered: `OEngine/tests/**`, `OEngine/tools/**`, `tools/**`, `checks/**`, `project/**`, and `docs/**` are tooling, so a test-file edit is L1 even when its filename names a lifecycle concept.

`verify` distinguishes topology from verification coverage. Exit `0` means the checks passed and nothing required was skipped; exit `1` means a check failed, a changed path is unowned, or a route is ambiguous; exit `2` means the checks passed but the changed surface requires browser cases that this command does not launch. `--allow-not-run` accepts that gap explicitly, and the unrun case ids are always listed on stderr.
