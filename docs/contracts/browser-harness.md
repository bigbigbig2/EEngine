---
id: browser-harness
kind: contract
status: frozen
owners: 
  - platform
  - frame-runtime
version: 1
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
---
# Browser Harness

The shared harness owns protocol identity, state transitions, freshness, GPU error scopes, capability fingerprints, bounded readback, production observation, disposal, and the binding to a completed full-verification receipt set. Cases own only their scenario setup and assertions.

New cases import `validation/harness/browser.ts`. The harness implementation lives beside the facade and owns freshness, identity, error, page outcome, disposal, and declared artifact gates.

The runner refuses to launch a case when full preflight is incomplete. Artifact schema v2 records the passed receipts, and promotion checks that their revision, tree, cleanliness, registry hash, and scope match the browser run.
