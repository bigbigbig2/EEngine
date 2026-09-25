---
id: surface-kernel-binding-v1
kind: spec
owner: shading
---
# Surface Kernel Binding V1

Status: draft; physical planning implemented, GPU material consumer not yet connected.

Owners: Visibility & Surface / shading

## Version/Compatibility

V1 describes only the new ShadingWork compute consumer's resource closure. It does not alter Geometry Product, MeshletWork, material record or texture-route bytes.

## Contract

`SurfaceProducts.ts` declares logical Product and per-program resource demand. `SurfaceKernelBindingPlan.ts` lowers that demand to a WebGPU compute bind-group layout and checks the negotiated device limits before pipeline creation. A program key contains the generated layout signature, kernel specialization, WGSL source and capability fingerprint. Material/texture/publication generations belong only to revision-local bind groups. No old Sparse descriptor, ShadingBin microtile layout or old Pass owns this layout.

| Group | Purpose | Bindings |
| --- | --- | --- |
| 0 | ShadingWork and output | `0` work queue, `1` MeshletWork, `2` material records, `3` frame view, `4` radiance storage texture, conditional `5` depth |
| 1 | Geometry | conditional `0` instances, `1` ordinary asset metadata, `2` vertex payload, `3` Product metadata, `4..7` Product page banks |
| 2 | Texture routing | conditional `0` texture routes, `1..9` only requested banks, `10..15` six sampler classes |
| 3 | Basic direct light | conditional `0` light records, `1` cluster lookup, `2` cluster data, `3` cluster parameters |

The widest virtual-geometry, textured, directly lit program consumes 15 read-only storage buffers, 10 sampled textures, 6 samplers, 2 uniforms and one `rgba16float` storage texture. Group 2 uses 16 binding slots. A plain unlit factor program consumes only 3 read-only storage buffers, one uniform and one storage texture. The planner rejects insufficient limits; it never silently drops texture banks, direct lighting, geometry data or visible work. Current Renderer admission already negotiates at least 16 storage buffers per shader stage for Virtual Geometry, but the other limits and concrete binding set still require validation on each adapter. This contract does not claim that the full Surface shader is compiled or executed yet.

The next material consumer must bind these roles from the same Scene/Product publication and compare material, texture, geometry, queue and route generations before evaluating a hit. `ShadingWork` remains GPU-produced and indirect-consumed. The physical layout cannot turn the old material-publication diagnostic into `Radiance` by renaming its output. The actual shader must run the extracted perspective reconstruction, gradients, material/texture evaluation and basic direct-light math before that Product is claimed.

Source provenance: perspective interpolation and projected one-pixel gradients are mapped to The Forge `CalcFullBary` / `Interpolate2DWithDeriv` in [R02](../porting/next-renderer.md); texture bank residency and GPU Scene records are EEngine ABI; PBR/direct-light mathematics follows the existing Filament-derived implementation. This WebGPU binding layout is local integration code, not a claim of upstream algorithm migration.

## Validation

The Surface Product contract checks narrow and widest closures, exact binding kinds, slot uniqueness, omission of unused groups and failure at insufficient limits. The full WGSL pipeline and new-chain GPU material/lighting image still need compilation and runtime comparison before this spec can be frozen.
