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
  - freshness is anchored to a per-case signature
validation: 
  - node tools/vibe.mjs evidence
  - node tools/vibe.mjs status
---
# Claims And Evidence

A claim is a durable statement that can affect a completion decision. Its `level` is the minimum evidence level (`L0` through `L4`), `requiredChecks` names the checks that must run, `evidencePolicy` defines the promotion expression, and `allowedDeclarations` bounds what the project may claim after evidence is accepted. Case manifests provide only the reverse coverage link; `covers` never silently adds a required case.

`evidencePolicy.allOf` requires every named case, `anyOf` requires at least one named alternative, and `diagnosticCases` never affects promotion. `checkOnly` is reserved for L0/L1 claims proved solely by full, clean check receipts. Labs and manual cases cannot enter promotion sets. Every covering case must be classified explicitly so the required set cannot depend on local execution history.

```text
unproven -> diagnostic -> accepted
                 \-> stale
                 \-> blocked
```

`stale` means the evidence revision no longer matches the current revision, or the case signature under which the run was produced no longer matches the current case manifest. A case signature covers only that case's normalized manifest together with its workload and profile, so editing an unrelated case does not invalidate evidence that is still valid; the whole-generated-registry hash is recorded for provenance but is no longer the freshness gate. `blocked` means the latest relevant run failed. A retired claim is explicitly marked `lifecycle: retired`; no status page can promote it back to active.

Raw runner output stays under ignored `.local/validation/`. `node tools/vibe.mjs evidence` writes the compact latest-per-case index at `validation/evidence/index.json`, retaining history counts without copying raw screenshots or traces. Empty or partial raw input cannot remove compact case records unless `--force-empty` or `--force-prune` is explicit. Each index record carries claim identity, actual check receipts, workload and registry hashes, contract hashes, browser/adapter capability, resolution/DPR, artifact hashes, and freshness gates.

Check coverage is execution provenance, not declared metadata. A browser artifact is schema v2 and embeds receipts produced by its mandatory full preflight. Promotion requires passed receipts whose revision, tree, dirty flag, registry hash and scope match the artifact. The index must never synthesize receipt ids from `requiredChecks`.
