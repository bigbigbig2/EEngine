---
id: shading
kind: domain
owner: shading
---
# Shading

## Current production path

`FrameProgramLowering` connects `VisibilityKey/depth/MeshletWork` to one `SurfaceMaterialPass`. Its GPU frequency planner writes an `r32uint` 4×4-tile plan before material evaluation. The planner only selects opaque unlit factor or publication-certified 1×1 base-texture blocks with the same valid VisibilityKey, close depth, matching material/texture/publication generations, a static instance and identical current/previous view-projection matrices. A zero plan means full rate. Camera motion and jitter never change the Frame Program topology.

Dense shades hot set-0 Standard/Unlit pixels and produces seven bounded exception lanes. Each lane has GPU indirect Binned evaluation and a mutually exclusive whole-lane overflow fallback. Coated is an exception family. Dense alone reads the frequency plan: one eligible anchor evaluates material, then writes the same HDR and motion to every pixel of its 2×2 or 4×4 block before FSR3. Binned/Coated remain full rate. `SurfacePresentPass` only presents FSR3 output; it does not reconstruct material pixels. The retired 64-class `ShadingWorkPass`, per-class shader generator and queue are removed.

Canonical Material and glTF specular/IOR/clearcoat inputs publish physical texture set and authored family separately. `surface_material_kernel.ts` reconstructs geometry, perspective gradients and Standard/Coated lighting. Direct light consumes the cluster and PhysicalSun; indirect diffuse and specular consume the published sky irradiance, filtered radiance and DFG. Future AO, shadows, reflection and GI providers are separate consumers/producers; their absence is not silently described as implemented quality.

The physical Surface layout is checked against device limits before pipelines are created. The widest layout uses 16 sampled textures, including the frequency plan, two storage textures and fixed resource groups. Material/texture generations are late-bound publication facts, not topology keys. Frequency work, Dense, indirect exceptions, FSR3 and Present share the frame's command context and single submit.

## Ownership and status

Shading owns `render/surface/SurfaceMaterialPass.ts`, `SurfaceExecutionAbi.ts`, `SurfaceProducts.ts`, `SurfaceKernelBindingPlan.ts`, `shaders/surface_execution.ts`, `shaders/shading_frequency.ts` and `shaders/surface_material_kernel.ts`. Visibility owns hit production; texture residency owns physical texture availability; Renderer composes them. Invalid identity writes an explicit Surface error, and exception capacity overflow is resolved on the GPU without a same-frame CPU decision.

Module B was closed with typecheck, build and focused contract/oracle tests. Browser matrix, visual comparisons, GPU timing, formal evidence and claim promotion are deferred to the completed Next Renderer. The donor/adoption boundary remains in [Next source ledger](../porting/next-renderer.md); successful compilation does not promote an upstream port.
