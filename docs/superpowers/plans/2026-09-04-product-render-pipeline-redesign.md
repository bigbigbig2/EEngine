# Product Render Pipeline Redesign Completion Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the accepted `13-product-render-pipeline-redesign.md` architecture as a real runtime migration: Feature-owned graph composition, one packed opaque path, unified lighting/secondary/transparency/temporal/post composition, deletion of legacy consumers, and production browser evidence.

**Architecture:** `Renderer` owns device/frame boundaries only. A `FrameCoordinator` owns the one encoder/submit and a main-view composer resolves enabled `RenderFeature` contributions by typed logical products into one `FrameGraph`. Features own their pass algorithms, resources, histories, counters, and feature-off behavior. There is no second product pipeline and no permanent compatibility bridge.

**Tech Stack:** TypeScript, WGSL, WebGPU, OEngine FrameGraph, Node test runner, Vite/Storybook examples, GPU timestamp/counter evidence.

**Spec:** `docs/implementation/13-product-render-pipeline-redesign.md`

## Global completion rules

- A wrapper class, constructor move, regex/source-shape test, or comment is not a completion artifact.
- Every stage needs an executable producer/consumer path, feature-off evidence, and deletion of the displaced production consumer.
- All features record into the coordinator-owned encoder; no feature may submit or perform synchronous readback.
- Visibility/HZB/work generation remain GPU producer → GPU consumer and are changed only where ownership wiring requires it.
- External algorithms retain the source/commit/license/adaptation records required by `docs/references/OPEN-SOURCE-REUSE.md`.
- Browser/GPU gates are not replaced by TypeScript tests. The final status remains incomplete until the six P9 scenarios have artifacts.

---

### Task 1: Replace the selection-only registry with executable FeatureGraph composition

**Files:**
- Create: `OEngine/src/render/RenderFeatureGraph.ts`
- Modify: `OEngine/src/render/RenderFeatureRegistry.ts`
- Modify: `OEngine/src/render/MainFrameFeatureTopology.ts`
- Create: `OEngine/tests/render-feature-graph.test.mjs`
- Modify: `OEngine/tests/p1-frame-infrastructure.test.mjs`

- [x] Add failing behavior tests for stable topological order, disabled-feature zero contribution, duplicate producers, missing products, dependency cycles, and contribution evidence.
- [x] Implement typed product declarations and a stable compiled contribution order without creating an encoder or submit.
- [x] Make the registry return a compiled executable selection instead of only owner/history string lists.
- [x] Run `npm run build:test` and the two focused P1 tests.

### Task 2: Move main-view graph construction behind a composer

**Files:**
- Create: `OEngine/src/render/MainViewComposer.ts`
- Modify: `OEngine/src/render/FrameCoordinator.ts`
- Modify: `OEngine/src/render/Renderer.ts`
- Modify: `OEngine/src/render/pipeline/FrameProducts.ts`
- Create: `OEngine/tests/main-view-composer.test.mjs`

- [x] Add failing behavior tests proving one graph, one encoder owner, one submit owner, and feature contribution order.
- [ ] Extract binding layout, graph creation/compile/cache, logical products, and graph evidence from `Renderer`.
- [ ] Route main-view construction through FeatureGraph contributions while retaining identical pass algorithms.
- [ ] Delete the corresponding manual topology/resource creation block from `Renderer`.
- [ ] Run focused coordinator/composer tests and `npm run typecheck`.

### Task 3: Hard-cut the opaque Visibility → Resolve → Surface path

**Files:**
- Modify: `OEngine/src/render/features/VisibilityFeature.ts`
- Modify: `OEngine/src/render/features/SurfaceFeature.ts`
- Modify: `OEngine/src/render/Renderer.ts`
- Delete: `OEngine/src/render/passes/MaterialExpandPass.ts`
- Delete: displaced legacy material-expand/velocity shaders and tests
- Modify/Create: packed surface runtime tests and Rendering Lab evidence wiring

- [ ] Add runtime tests for packed-only opaque and alpha-test product wiring and feature counters.
- [ ] Make Visibility and Surface contribute their own FrameGraph passes/products.
- [ ] Remove legacy Scene fallback, MaterialExpand, legacy velocity, and duplicate Surface consumers.
- [ ] Verify one resolve draw, valid/overflow/fallback counters, and feature-off resources.
- [ ] Run packed surface tests, typecheck, and the Rendering Lab browser gate.

### Task 4: Complete clustered lighting, shadow service, and one HDR composition

**Files:**
- Modify: `OEngine/src/render/features/LightingFeature.ts`
- Modify: `OEngine/src/render/services/ShadowService.ts`
- Modify: clustered lighting/shadow passes and WGSL under `OEngine/src/render/passes/` and `OEngine/src/shaders/`
- Modify: `OEngine/src/render/Renderer.ts`
- Modify/Create: lighting/shadow runtime tests and Dynamic Lighting gate

- [ ] Add behavior tests for Directional/Point/Spot GPU light ownership, cluster boundedness, and shadow products.
- [ ] Move light clustering, packed directional/point/spot shadows, direct BRDF, and HDR output into LightingFeature contributions.
- [ ] Remove duplicate legacy light lists, shadow composition, and manual Renderer branches.
- [ ] Verify cluster overflow semantics, shadow tile/cascade counters, one HDR equation, and shadow-off zero cost.

### Task 5: Complete GI, reflection, and AO provider composition

**Files:**
- Modify: `OEngine/src/render/services/GIService.ts`
- Modify: `OEngine/src/render/services/ReflectionService.ts`
- Modify: `OEngine/src/render/services/AOService.ts`
- Modify: corresponding passes/WGSL and `OEngine/src/render/Renderer.ts`
- Modify/Create: GI/reflection/AO runtime tests and browser gates

- [ ] Add provider-chain behavior tests for `Lightmap → Probe Volume → IBL → none` and `Local Probe → SSSR correction → IBL`.
- [ ] Implement/finish Local Reflection Probe ownership and complete-scene-radiance SSSR correction.
- [ ] Keep material AO, diffuse visibility, specular visibility, and bent normal as distinct products.
- [ ] Delete duplicate indirect/SSR final composites and Renderer effect-order branches.
- [ ] Verify independent feature-off resources/histories and Indoor GI/Reflection artifacts.

### Task 6: Complete transparent Forward/OIT contribution

**Files:**
- Modify: `OEngine/src/render/features/TransparencyFeature.ts`
- Modify: packed transparent passes/WGSL and `OEngine/src/render/Renderer.ts`
- Delete: legacy transparent Scene/OIT consumers
- Modify/Create: transparency runtime tests and gate

- [ ] Add behavior tests for shared lighting/shadow products, opaque depth preservation, velocity/reactive outputs, and off-state allocation.
- [ ] Make packed OIT contribute accumulation/composition into the same main graph.
- [ ] Delete legacy OIT and duplicate light/material interpretation.
- [ ] Verify capacity/overflow/fallback counters and feature-off zero cost.

### Task 7: Complete Temporal Reconstruction, TAAU, and DRS

**Files:**
- Modify: `OEngine/src/render/features/TemporalFeature.ts`
- Modify: temporal passes/WGSL, history registry, and `OEngine/src/render/Renderer.ts`
- Delete: duplicate legacy TAA/final temporal composites
- Modify/Create: temporal behavior/numeric tests and Temporal Stress gate

- [ ] Add behavior tests for independent histories, invalidation matrix, reactive/disocclusion classification, and fixed-config DRS.
- [ ] Make TemporalFeature own classification, TAA/TAAU reconstruction, histories, and output-domain conversion.
- [ ] Remove Renderer temporal branches and unowned histories.
- [ ] Verify resize/cut/rebuild/light-change resets and TAAU quality/performance artifacts.

### Task 8: Complete HDR post, presentation, and debug composition

**Files:**
- Modify: `OEngine/src/render/features/PostFeature.ts`
- Modify: post passes/WGSL and `OEngine/src/render/Renderer.ts`
- Modify/Create: post ordering/domain tests and browser artifacts

- [ ] Add behavior tests for linear HDR ordering and disabled-stage zero contribution.
- [ ] Contribute Exposure → Bloom → Color Grading → Tone Mapping → optional Sharpen → Present through PostFeature.
- [ ] Make color grading explicitly configurable and remove hidden always-on work.
- [ ] Delete duplicate gamma/LDR/post composition and final manual Renderer branches.
- [ ] Verify output-domain numeric/screenshot consistency.

### Task 9: Delete the manual product pipeline and legacy production owners

**Files:**
- Modify: `OEngine/src/render/Renderer.ts`
- Delete: all unreferenced legacy passes/shaders/resource owners/config branches
- Modify: source ownership/audit tests

- [ ] Add/strengthen executable ownership tests and repository reference audits.
- [ ] Reduce Renderer to lifecycle, frame contract construction, composer invocation, and submit/error boundary.
- [ ] Delete all displaced fallback consumers rather than retaining compatibility aliases.
- [ ] Run shader audit, typecheck, unit tests, and examples build.

### Task 10: Run P9 production gates and correct authoritative status documents

**Files:**
- Modify/Create: six fixed examples/artifacts for Static Geometry, Dynamic Lighting, Indoor GI, Reflection, Temporal Stress, Heavy Workload
- Modify: `docs/CURRENT-STATE.md`
- Modify: `docs/implementation/13-product-render-pipeline-redesign.md`
- Modify: P1–P8 execution records and relevant ADR implementation status

- [ ] Capture screenshot, fixed-frame sequence, GPU timestamps, debug views, counters, memory, and feature-off evidence for every gate.
- [ ] Compare same machine/browser/GPU/resolution/DPR/profile after warm-up.
- [ ] Record failures honestly and keep the redesign status incomplete until all gates pass.
- [ ] Only after all gates pass, mark the redesign implemented and publish the final deletion/evidence inventory.
