---
id: browser-harness
kind: contract
status: frozen
owners: 
  - platform
  - frame-runtime
version: 3
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
  - validation/harness/browser.ts
  - validation/src/runner/run-case.mjs
  - validation/src/shared/artifact.mjs
---
# Browser Harness

The shared harness owns protocol identity, fresh run/nonce, state transitions, GPU/browser error aggregation, declared artifacts and disposal. Cases own scenario setup and independent assertions. New cases import `validation/harness/browser.ts`.

`node validation/src/runner/run-case.mjs <case-id>` launches an isolated browser and runs one diagnostic case. It checks page/runner identity, timestamps, errors, outcome, dispose and artifact ownership, writes schema-v3 raw results under .local/validation, and reports unsupported separately.

The runner does not perform claim promotion or repository preflight. `--accept` and retired artifact versions are rejected; v3 removes claim receipts and requires diagnostic mode. Identity/error/dispose/ownership assertions remain unchanged.

Host identity includes engineSourceSha256 over conservative engine source/config/lock/compiler inputs, and the runner rejects input changes during execution. dirty remains descriptive. GPU oracle separately verifies fresh .test-dist source/output hashes before and after execution. These identities do not replace numeric assertions, workload quality or performance measurement.
