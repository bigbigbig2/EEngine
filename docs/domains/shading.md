---
id: shading
kind: domain
owner: shading
---
# Shading

## Current production path

`FrameProgramLowering` connects `VisibilityKey/depth/MeshletWork` to one `SurfaceMaterialPass`. Its GPU frequency planner writes an `r32uint` 4×4-tile plan before material evaluation. The planner only selects opaque unlit factor or publication-certified 1×1 base-texture blocks with the same valid VisibilityKey, close depth, matching material/texture/publication generations, a static instance and identical current/previous view-projection matrices. A zero plan means full rate. Camera motion and jitter never change the Frame Program topology.

Dense shades hot set-0 Standard/Unlit pixels and produces seven bounded exception lanes. Each lane has GPU indirect Binned evaluation and a mutually exclusive whole-lane overflow fallback. Coated is an exception family. Dense alone reads the frequency plan: one eligible anchor evaluates material, then writes the same HDR and motion to every pixel of its 2×2 or 4×4 block before FSR3. Lit pixels stay full rate: the planner rejects `material.family != 0` and requires every pixel in a coarse block to share the same VisibilityKey. Binned/Coated remain full rate. `SurfacePresentPass` only presents FSR3 output; it does not reconstruct material pixels. The retired 64-class `ShadingWorkPass`, per-class shader generator and queue are removed.

Canonical Material and glTF specular/IOR/clearcoat inputs publish physical texture set and authored family separately. `surface_material_kernel.ts` reconstructs geometry, perspective gradients and Standard/Coated lighting. Direct light consumes the cluster and PhysicalSun; indirect diffuse and specular consume the published sky irradiance, filtered radiance and DFG. XeGTAO High scalar now produces same-frame indirect visibility from reverse-Z depth through private view normal, five weighted depth levels, horizon integration, edge-aware denoise and packed `u32` output. Dense, Binned and overflow consume the same buffer. `min(materialAO, Xe scalar)` affects sky/IBL diffuse and the specular AO cone for base and coat; direct, Sun, emissive and Unlit do not multiply Xe visibility. Directional VSM visibility multiplies the Standard/Coated direct lobe once. SSSR and GI remain later providers.

The physical Surface layout is checked against device limits before pipelines are created. The widest AO layout uses 16 sampled textures, 16 storage buffers and two storage textures; scalar AO uses one read-only storage buffer rather than a seventeenth sampled texture. Material/texture generations are late-bound publication facts, not topology keys. AO scratch/final visibility, frequency work, Dense, indirect exceptions, FSR3 and Present share the frame's command context and single submit. AO intermediate normal, weighted depths, raw AO and edges are transient Graph resources. Final packed visibility is frame-local. Hilbert LUT and pipelines belong to the device epoch; XeGTAO owns no temporal history. Resize changes Graph resource extents, scene replacement changes late-bound resources, and a replacement device creates new AO owners.

## Surface field demand boundary

These are semantic candidates, not allocated attachments. The current physical plan only allocates XeGTAO's frame-local packed indirect visibility and existing HDR/motion. Future SSSR/GI integration must choose a finite physical layout using total producer, read, binding and reconstruction cost.

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

Shading owns `render/surface/SurfaceMaterialPass.ts`, `SurfaceExecutionAbi.ts`, `SurfaceProducts.ts`, `SurfaceKernelBindingPlan.ts`, `shaders/surface_execution.ts`, `shaders/shading_frequency.ts` and `shaders/surface_material_kernel.ts`. Visibility owns hit production; texture residency owns physical texture availability; Renderer composes them. Invalid identity writes an explicit Surface error, and exception capacity overflow is resolved on the GPU without a same-frame CPU decision.

Module C integrates the selected High scalar engineering path. The fixed XeGTAO source, mapped stages and license are recorded in [Next source ledger](../porting/next-renderer.md). Real GPU numerical producer→consumer evidence is still missing, so R05 remains `not adopted`. Browser matrix, visual comparisons, GPU timing, formal evidence and claim promotion remain deferred to the completed Next Renderer.
VSM E9 module checks are complete. Receiver demand, page allocation, bounded caster expansion, dirty-slot depth clear, Atlas raster and post-raster dirty commit feed `ShadowVisibilityFrame` and Surface on the same FrameGraph path. Each clip level has disjoint mip planes with 32-byte page entries; missing, stale and dirty pages sample neutral visibility. `VsmGeneration`/`VsmInvalidationPass` own generation and temporal invalidation; diagnostics stay GPU-resident and observational. Caster discovery is still bounded by the current frame's MeshletWork and does not establish complete off-camera shadow coverage. The full scene, quality and performance matrix remains final renderer acceptance.
