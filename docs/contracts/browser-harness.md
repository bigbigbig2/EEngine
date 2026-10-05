---
id: browser-harness
kind: contract
status: frozen
owners: 
  - platform
  - frame-runtime
version: 2
consumers: 
  - validation/harness
  - validation/src/runner
invariants: 
  - fresh identity
  - explicit disposal
  - aggregated browser and GPU errors
validation: 
  - protocol-self-test
  - webgpu-component
state: current
verifies:
  - checks
  - project/domains
---
# Browser Harness

The shared harness owns protocol identity, state transitions, freshness, GPU error scopes, capability fingerprints, bounded readback, production observation, disposal, and the binding to a completed full-verification receipt set. Cases own only their scenario setup and assertions.

New cases import `validation/harness/browser.ts`. The harness implementation lives beside the facade and owns freshness, identity, error, page outcome, disposal, and declared artifact gates.

The runner has two explicit modes. A normal `--run` performs a changed-scope preflight and always produces diagnostic evidence. `--run --accept` requires a clean worktree and a complete full-scope preflight; it may reuse an existing receipt set only when revision, tree, registry hash, cleanliness, scope, and passed status all match. Artifact schema v2 records `validationMode` and the actual receipts. Promotion checks that the acceptance mode and every receipt match the browser run.
