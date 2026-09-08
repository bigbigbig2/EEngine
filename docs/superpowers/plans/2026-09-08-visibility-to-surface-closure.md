# Visibility-to-Surface Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every remaining M2–M7 correctness, evidence, lifecycle, and final-validation item without weakening the RFC gates or treating dirty/exploratory output as release evidence.

**Architecture:** Keep the current MaterialClassDepth/Surface production path unchanged while adding an offline evidence pipeline that captures attachment data, pairs independently launched profiles, validates identity/provenance, and computes M2–M7 decisions. Runtime feature promotion remains a startup-time decision derived from accepted evidence; benchmark-only controls stay outside the public renderer interface.

**Tech Stack:** TypeScript, WGSL, WebGPU, Playwright, Node.js ESM, OEngine FrameGraph and benchmark evidence APIs.

**Spec:** `docs/OEngine_Visibility_to_Surface_WebGPU_RFC.md`

## Global Constraints

- Desktop WebGPU/wgpu-compatible baseline only; no 64-bit atomics, multi-draw-indirect, mesh/task shaders, or buffer device address assumptions.
- GPU-driven work must retain a GPU producer to GPU consumer closure.
- Feature-off creates no dedicated pass, allocation, history, readback, counter copy, or submit.
- Formal evidence uses 1920×1080, DPR 1, 120 warm-up frames, 480 measured frames, timestamp cadence 8, counter cadence 11, and three independent browser sessions.
- Performance gates require a clean commit and complete build provenance; dirty artifacts remain exploratory.
- Per the execution RFC, full tests and shader audit run once after the M7 decision, not between M2–M7 evidence tasks.

---

### Task 1: Formal artifact pairing and validation

**Files:**
- Create: `examples/rendering-lab/visibility-surface-evidence.mjs`
- Modify: `examples/package.json`
- Modify: `docs/OEngine_Visibility_to_Surface_WebGPU_EXECUTION.md`

**Interfaces:**
- Consumes: `profile-formal.mjs` `report.json` artifacts and `VisibilitySurfaceMigrationGates` evaluators.
- Produces: one immutable aggregate report with paired run identities, provenance errors, Surface ABI evidence, TriangleSetup comparisons, backend timing comparisons, and the current M5/M6/M7 decisions.

- [ ] **Step 1: Define strict artifact input and pairing rules**

  Require report schema/profile/workload/backend/setup identity, three unique runs, matching commit/content hash/adapter/run settings, and explicit pair keys. Reject missing GPU timestamps, browser errors, provenance errors, gate errors, or duplicate run/session ids.

- [ ] **Step 2: Implement the offline aggregator**

  Read explicit report paths, pair baseline/candidate runs by workload and ordinal, derive memory and attachment-byte evidence from captured reports, and invoke the existing gate evaluators without launching a browser or modifying runtime state.

- [ ] **Step 3: Add stable CLI entry points**

  Add package scripts for aggregate validation and document exact M3/M5/M6/M7 invocation shapes. The CLI must exit non-zero for malformed or ineligible evidence, while an RFC-valid `rejected-by-evidence` or `not-needed-by-evidence` decision is a successful completed gate.

### Task 2: M2/M3 attachment parity capture

**Files:**
- Create: `OEngine/src/debug/VisibilitySurfaceCapture.ts`
- Modify: `OEngine/src/render/Renderer.ts`
- Modify: `examples/rendering-lab/fixture.ts`
- Modify: `examples/rendering-lab/main.ts`
- Modify: `examples/rendering-lab/profile-formal.mjs`

**Interfaces:**
- Consumes: VisibilityKey, reverse-Z depth, and all active Surface attachments from the existing main FrameGraph.
- Produces: one-shot, same-submit padded texture readbacks plus hashes/statistics and bounded numerical parity metrics.

- [ ] **Step 1: Define the capture schema**

  Record format, width, height, bytes-per-row, byte length, SHA-256 digest, finite-value status, and attachment-specific comparison policy. Preserve raw capture files outside the JSON artifact and reference them by relative path plus digest.

- [ ] **Step 2: Add a one-shot FrameGraph capture seam**

  Import readback buffers only when a capture is requested, encode copies into the existing main command encoder, map only after submission, and destroy all staging buffers after resolution or failure.

- [ ] **Step 3: Capture formal parity inputs**

  Extend the runner to request VisibilityKey, depth, PBR, normal, albedo/AO, emissive, metadata, and optional velocity after warm-up, saving one deterministic capture per independent session.

- [ ] **Step 4: Compare v2/v3 and legacy/class backends offline**

  Enforce exact parity for integer attachments, RFC tolerances for normalized/float attachments, explicit EMPTY/INVALID handling, and zero invalid/overflow counters for formal workloads.

### Task 3: M5 TriangleSetup decision

**Files:**
- Modify: `examples/rendering-lab/visibility-surface-evidence.mjs`
- Modify: `docs/OEngine_Visibility_to_Surface_WebGPU_EXECUTION.md`

**Interfaces:**
- Consumes: paired setup-off/setup-on artifacts for the four RFC workloads.
- Produces: correctness deltas, hit/fallback/overflow statistics, memory deltas, P50/P95/P99 deltas, feature-off audit, and `required` or `disabled-by-evidence` decision.

- [ ] **Step 1: Aggregate correctness and setup counters**

  Apply bit-exact metadata/emissive checks, albedo/PBR P99 ≤ 1/255, normal P99 ≤ 0.5 degrees, velocity P99 ≤ 0.05 internal pixels, finite values, and three-run heavy-overdraw hit ratio ≥ 90%.

- [ ] **Step 2: Evaluate feature-off and performance**

  Reject setup-off artifacts containing the setup resource/pass/copy/readback or non-zero work-cache bytes; report paired Surface/total GPU P50/P95/P99 and memory peaks.

- [ ] **Step 3: Freeze the runtime default**

  Change the production default only when every M5 gate passes. Otherwise retain off and persist `disabled-by-evidence` with the failing metrics.

### Task 4: M6 Surface ABI v2 decision

**Files:**
- Modify: `examples/rendering-lab/visibility-surface-evidence.mjs`
- Modify: `OEngine/src/gpu/GpuSurfaceAbi.ts` only if evidence accepts v2.
- Modify: `OEngine/src/render/RendererConfig.ts` only if evidence accepts v2.
- Modify: `docs/OEngine_Visibility_to_Surface_WebGPU_EXECUTION.md`

**Interfaces:**
- Consumes: unified Surface ABI captures for comprehensive-full, material-mosaic-7, and near-plane-motion.
- Produces: three paired identity-bearing `SurfaceAbiRunEvidence` entries per workload and an accepted/rejected M6 decision.

- [ ] **Step 1: Build paired Surface ABI evidence**

  Combine capture parity, velocity-on/off bytes per pixel, conversion pass count, resident peak, transient peak, and active startup ABI/profile.

- [ ] **Step 2: Audit full composition coverage**

  Require Direct Lighting, AO, SSR, IBL, LPV, Brick4, Opaque Resolve, Temporal, and Render Debug evidence; require explicit legacy MaterialExpand rejection for v2.

- [ ] **Step 3: Promote or reject**

  Promote v2 only if all runs preserve correctness, save attachment bytes, add zero conversions, and do not increase memory peaks. Otherwise retain v1 and record `rejected-by-evidence` or `insufficient-evidence`.

### Task 5: M7 two-vendor backend decision

**Files:**
- Modify: `examples/rendering-lab/visibility-surface-evidence.mjs`
- Create only if the gate returns `required`: `OEngine/src/render/passes/PackedMaterialTilePass.ts`
- Create only if the gate returns `required`: tile queue ABI and WGSL files under their existing owners.
- Modify: `docs/OEngine_Visibility_to_Surface_WebGPU_EXECUTION.md`

**Interfaces:**
- Consumes: three independent sessions for three workloads on at least two GPU vendors, with ClassDepth and a validated tile prototype/model sharing comparison identities.
- Produces: `not-needed-by-evidence` or `required`; only `required` authorizes a runtime tile backend.

- [ ] **Step 1: Collect the first-vendor artifacts**

  Run the fixed M7 matrix on the locally available adapter and validate timing sample coverage, identities, and clean provenance.

- [ ] **Step 2: Import and validate second-vendor artifacts**

  Require a different normalized vendor identity and the same commit, browser/settings, workloads, and run rules. Do not synthesize or substitute a CPU timing/model for GPU timestamps.

- [ ] **Step 3: Resolve the branch**

  If neither vendor is ≥10% slower on ClassDepth P50 or P95, record `not-needed-by-evidence` and verify no tile runtime resources exist. If `required`, implement the bounded tile ABI with capacity, overflow, counters, GPU producer/consumer, class-discard fallback, and true feature-off, then repeat the M7 matrix.

### Task 6: Lifecycle matrix and final verification

**Files:**
- Modify: `examples/rendering-lab/fixture.ts`
- Modify: `examples/rendering-lab/main.ts`
- Modify: `examples/rendering-lab/visibility-surface-evidence.mjs`
- Modify: `docs/OEngine_Visibility_to_Surface_WebGPU_EXECUTION.md`
- Modify: `docs/STATUS.md`
- Modify: `docs/porting/visibility.md`

**Interfaces:**
- Consumes: final M2–M7 implementation and accepted/rejected artifacts.
- Produces: lifecycle artifact, final test/audit results, and authoritative completion state.

- [ ] **Step 1: Capture lifecycle transitions**

  Exercise Packed Scene release, resource epoch replacement, Renderer destroy, device loss, resize, counter cadence changes, TriangleSetup startup/off/on, Surface ABI startup profiles, and all relevant feature-off states. Record owner/pass/resource/readback/submit snapshots before and after each transition.

- [ ] **Step 2: Run the deferred final verification suite**

  After M7 resolves, run `OEngine/npm ci`, `npm test`, `npm run audit:shaders`, then `examples/yarn install --frozen-lockfile`, `yarn build`, `yarn test:visibility-key-oracle`, and `yarn test:rendering-lab:workload`.

- [ ] **Step 3: Publish the final state**

  Record clean commit, browser/adapter identities, run ids, P50/P95/P99, parity errors, overflow, resource peaks, lifecycle results, and every gate conclusion. Mark the RFC complete only when all applicable gates are closed.
