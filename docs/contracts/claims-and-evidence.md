---
id: claims-and-evidence
kind: contract
status: frozen
owners: 
  - platform
version: 1
consumers: 
  - tools/vibe.mjs
  - validation/evidence
invariants: 
  - status is derived from current evidence
  - accepted evidence is clean and complete
validation: 
  - node tools/vibe.mjs evidence
  - node tools/vibe.mjs status
---
# Claims And Evidence

A claim is a durable statement that can affect a completion decision. Its `level` is the minimum evidence level (`L0` through `L4`), `requiredChecks` names the checks that must run, and `allowedDeclarations` bounds what the project may claim after evidence is accepted. Case manifests provide the reverse coverage link:

```text
unproven -> diagnostic -> accepted
                 \-> stale
                 \-> blocked
```

`stale` means the evidence revision or generated registry hash no longer matches the current revision. `blocked` means the latest relevant run failed. A retired claim is explicitly marked `lifecycle: retired`; no status page can promote it back to active.

Raw runner output stays under ignored `.local/validation/`. `node tools/vibe.mjs evidence` writes the compact latest-per-case index at `validation/evidence/index.json`, retaining history counts without copying raw screenshots or traces. Each index record carries claim/check identity, workload and registry hashes, contract hashes, browser/adapter capability, resolution/DPR, artifact hashes, and freshness gates.
