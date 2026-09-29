---
id: frame-runtime
kind: domain
owner: frame-runtime
---
# Frame Runtime

`RendererCore` is the sole composition root and `FrameCoordinator` is the sole submit owner. The production scene frame is GPU Scene publication → hierarchy/MeshletWork → VisibilityKey/depth → optional HZB/light cluster, lit-consumer XeGTAO and directional VSM → Surface frequency plan/Dense/exception lanes → Physical Sky/Aerial → FSR3 Upscaler → Present. Empty frames use the same Frame Program entry and submit owner.

`FrameProgram.ts` closes the finite product demand and caches a structural key. Scene keys contain internal/output extents, output format, device epoch, virtual geometry bank shape, HZB/late-recheck selection, active resident **sets**, direct-light demand, AO physical profile and physical-environment selection. The 64 material classes, bank masks, scene generations, camera motion, AO noise index, FSR3 ping-pong role and environment LUT generation are not graph keys. `FrameProgramBindings.ts` checks the current publication, descriptor and epoch shape before encoding; `FrameProgramLowering.ts` registers the actual resource edges in the existing FrameGraph. Same-shape publications late-bind physical resources. The High scalar AO profile closes only with a lit Surface consumer; off/unlit/empty programs have no XeGTAO stage.

## Frame transaction and temporal lifetime

Module D temporal facts are produced by `render/temporal/TemporalFactsPass.ts` in
the same Frame Program as Surface and FSR3. Its persistent identity textures are
RGBA32Uint (instance slot, geometry/LOD signature, material signature and
publication transform revision); motion and masks are transient internal-domain
products. `TemporalFabric` owns only logical begin/commit/abort and read/write
roles while FSR3 and Temporal Facts own their physical textures. Output color can
survive an in-envelope internal resize; identity and FSR3 internal scratch are
reset when their domain changes. GPU completion fences delay retirement.

Renderer applies jitter to the live View, updates scene/geometry/material and direct-light publications, prepares FSR3 constants and records environment LUT work on the current frame command context. The Surface frequency plan is written by GPU compute and is zero for ineligible or moving blocks; camera motion does not select another topology. Dense completes both HDR and motion at internal resolution before Sky/Aerial and FSR3 consume them. FSR3 owns output-resolution color and accumulation histories plus internal luma; Present consumes its output-full image.

Temporal Fabric begins, commits or aborts with the submitted frame. Camera cuts, resize, scene/representation/environment revisions and device recovery invalidate their relevant histories. A new View seeds previous-camera data in the same encoder before Surface motion reads it. An aborted first frame repeats the seed; a successful submit advances previous-camera state. Environment generations are published as complete LUT sets and retired only after prior GPU work finishes, so consumers do not mix partial sky generations.

The FrameGraph owns transient resource lifetime and compiled graph reuse. RenderTargets/View and other imported resources are checked per frame. No Surface or provider issues a private `queue.submit`, and no current-frame GPU readback controls visible work. Device loss constructs a fresh Renderer, resource owners and graph/pipeline caches from CPU scene truth; unsupported multi-shard restoration still requires application source replay.

## Current limits and references

Modules B/C and VSM connect Standard/Coated Surface, bounded GPU exception overflow, filtered sky specular, XeGTAO High scalar, directional shadow visibility and FSR3 on the one production path. XeGTAO's scratch and final visibility are frame-local; its LUT and pipelines are device-local. SSSR, GI and other planned providers are subsequent modules. Module completion uses typecheck/build/focused tests; browser lifecycle, visual quality, GPU P50/P95, formal evidence and claims remain final Next Renderer acceptance.

The target architecture is [Next design](../next-design/eengine-next-overall-architecture-final-2026.md); the current sequence is [execution plan](../next-execution/eengine-next-architecture-layer-plan-2026.md). Primary entrypoints are `render/pipeline/RendererCore.ts`, `render/program/FrameProgram.ts`, `FrameProgramBindings.ts`, `FrameProgramLowering.ts`, `framegraph/FrameGraph.ts` and `render/surface/SurfaceMaterialPass.ts`.
VSM E9 checked the current production graph: `RendererCore` publishes a device-epoch generation state, and the graph invalidation pass writes lifecycle facts before demand/allocation. GPU allocation and caster work drive Atlas clear/raster and Surface sampling without a second submit or current-frame CPU residency decision. Device loss rebuilds VSM resources and bindings from CPU scene truth. Focused page-table, profile, odd-extent and epoch tests passed; browser lifecycle combinations remain final acceptance.
