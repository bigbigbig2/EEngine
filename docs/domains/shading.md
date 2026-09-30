---
id: shading
kind: domain
owner: shading
---
# Shading

## Current production path

FrameProgramLowering connects VisibilityKey/depth/MeshletWork to one SurfaceMaterialPass coordinator. SurfaceProbe consumes cooked continuity/variation metadata, sampling routes and live residency revisions. The 8×8 tile Work Builder selects 1×1/2×1/1×2/2×2 cells; same-profile/rate tiles use implicit descriptors, mixed tiles use compact records and exact coverage masks. Four resident-set profiles consume the same Standard/Unlit/Coated math, extracted into surface_geometry, surface_material_evaluation and surface_lighting. The old frequency planner, Dense/seven exception lanes and their ABI are deleted.

Record and result pools reserve all tile demand before committing. Any failure marks a fixed tile state as fallback; no partial sample work is published. GPU finalize emits bounded two-dimensional indirect grids. Normal full samples write HDR directly; coarse samples write a separate immutable rgba16float result pool. Resolve reads only those results and fixed tile cell indices, never HDR. Fixed-state fallback covers the whole failed tile, with mutually exclusive profile writes and no repair queue. Background is cleared once; invalid published hits receive explicit error color. No current-frame readback or separate submit controls execution.

The first same-rate lighting profile is directional-no-shadow: current world position/view direction/normal and roughness budgets must permit sharing, and the active punctual list must be empty. VSM or physical sky/IBL forces full rate because their variation bounds are not established. Unknown texture metadata, ORM/normal-map lighting risk, Coated and nonuniform AO cells also stay full. RendererConfig.surfaceShadingBudget supplies immutable named budgets; defaults remain exact/strict. This is not a legacy/new switch. A real resident nonconstant-albedo PBR plane with nonzero directional lighting executes 16 material and full lighting samples instead of 64 in the production FrameGraph GPU oracle. Different-rate signals, richer light bounds, reconstruction quality and tail packing remain phase three; no net performance claim is made.

Canonical Material preserves base/normal/ORM/emissive/specular/IOR/coat and sampler semantics. Full and coarse workers call the same perspective interpolation, texture and lighting functions and convert Rec.709 to pre-exposed Rec.2020 once. Motion is not a Surface product or kernel demand: TemporalFacts independently consumes depth, instance and current/previous camera facts. XeGTAO scalar affects only the existing indirect diffuse/specular AO math; directional VSM affects the existing direct lobe. SSSR and GI remain later providers.

The widest AO worker layout requires 16 storage buffers, 15 sampled textures and 2 storage textures; lit probe uses 11264 bytes of workgroup storage. Fixed tile/descriptors, compact/index and result extents are checked against buffer, texture, u32 and dispatch limits before allocation. Material/publication revisions are late-bound facts. Probe, builder, finalize, workers, Resolve, AO, FSR3 and presentation share the frame command context and single submit. FrameGraph owns transient work/results/HDR; device owners retain only view buffer, samplers and pipelines. Motion/camera changes do not add another topology.

## Surface field demand boundary

These are semantic candidates, not allocated attachments. The current physical plan only allocates XeGTAO's frame-local packed indirect visibility and Surface HDR; Temporal owns motion. Future SSSR/GI integration must choose a finite physical layout using total producer, read, binding and reconstruction cost.

| Field | Producer and actual/potential consumer | Space, filtering and invalidity | Recompute/materialize choice |
| --- | --- | --- | --- |
| Xe geometric normal | Raw depth → XeGTAO Main | View space, geometry scale; point loads, invalid at background or depth discontinuity | Currently AO-private `r32uint`; sharing requires matching geometry and space semantics. |
| Surface geometric normal | Visibility reconstruction → Surface lighting; possible SSSR | World space; identity-aware reconstruction only, invalid on missing or mismatched hit | Currently in Surface registers. A sidecar adds write/read and bindings; repeated reconstruction costs geometry decode. |
| Surface shading/coat normal | Material and normal texture → Surface BSDF; possible SSSR/GI | World space, normal map dependent; filter only within stable material/geometry identity, invalid on stale texture generation | Currently in registers. A future shared field can be written by the same Surface kernel if repeated texture sampling justifies it. |
| Perceptual roughness | glTF material/ORM texture → Surface GGX and coat; possible SSSR | Material closure `[0,1]`, not squared microfacet alpha; identity-aware filter, invalid on stale material/texture generation | Currently in registers; sidecar competes against repeated material lookup and texture sampling. |
| Material identity | VisibilityKey, meshlet work and publication records → Surface; future temporal/provider rejection | Exact scene/object/material/geometry and texture publication generations; never interpolate, invalid on stale key or replaced scene | Existing GPU records and key are authoritative; a separate pixel identity surface requires a real consumer and measured repeated lookup cost. |
| Motion | Current/previous transforms → Surface → FSR3 | Current UV minus previous UV in normalized view coordinates; no filtering across disocclusion or identity change; zero on invalid/background | Existing full-frame `rg16float` output is demanded by FSR3. Future consumers reuse its sign and validity convention. |
| Indirect visibility | XeGTAO pack → Surface indirect branches | Screen space scalar `[0,1]`, four pixels per `u32`; neutral one on background/off, no cross-frame reuse | Current same-frame buffer is the only new cross-owner AO product; off profile allocates no AO buffer. |

Finite future candidates are register-only reconstruction, a same-kernel `CompactNormalRoughness` sidecar after a real SSSR demand, and an alternate layout that reuses a measured free texture slot. None is activated for Module C.

## Ownership and status

Shading owns `render/surface/SurfaceMaterialPass.ts`, `SurfaceSampleAbi.ts`, `SurfaceProbePass.ts`, `SurfaceProducts.ts`, `SurfaceKernelBindingPlan.ts`, `shaders/surface_sample_work.ts`, `surface_sample_worker.ts` and the extracted geometry/material/lighting math. Visibility owns hit production; texture residency owns physical texture availability; Renderer composes them. Invalid identity writes an explicit Surface error, and multi-pool overflow is resolved per tile on the GPU without a same-frame CPU decision.

Module C integrates the selected High scalar engineering path. The fixed XeGTAO source, mapped stages and license are recorded in [Next source ledger](../porting/next-renderer.md). Real GPU numerical producer→consumer evidence is still missing, so R05 remains `not adopted`. Browser matrix, visual comparisons, GPU timing, formal evidence and claim promotion remain deferred to the completed Next Renderer.
VSM E9 module checks are complete. Receiver demand, page allocation, bounded caster expansion, dirty-slot depth clear, Atlas raster and post-raster dirty commit feed `ShadowVisibilityFrame` and Surface on the same FrameGraph path. Each clip level has disjoint mip planes with 32-byte page entries; missing, stale and dirty pages sample neutral visibility. `VsmGeneration`/`VsmInvalidationPass` own generation and temporal invalidation; diagnostics stay GPU-resident and observational. Caster discovery is still bounded by the current frame's MeshletWork and does not establish complete off-camera shadow coverage. The full scene, quality and performance matrix remains final renderer acceptance.
