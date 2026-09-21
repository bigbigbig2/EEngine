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
---
# Project Routing

`project/domains/*.yaml` is the path router. Each domain has one `primaryOwner`; overlapping paths may remain related, but equal-strength matches must be resolved by making one pattern more specific. `project/claims/*.yaml` states durable, cross-owner claims and names the watch paths, required checks, and allowed declarations. `checks/checks.yaml` describes executable or built-in checks.

The source is read with the YAML parser; duplicate keys and parse warnings are errors. `node tools/vibe.mjs context <path>` prints the route. `node tools/vibe.mjs verify --changed` regenerates the validation registry and fails when a changed file has no domain route or has an unresolved primary-owner tie.
