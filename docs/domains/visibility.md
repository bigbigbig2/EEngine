---
id: visibility
kind: domain
owner: visibility
---
# Visibility

Visibility owns hierarchy traversal, bounded GPU MeshletWork generation, indirect raster, VisibilityKey/depth publication and HZB. The visible-work producer and consumer remain on the GPU; CPU readback is diagnostic or asynchronous scheduling feedback only. The optional current-HZB late recheck is a bounded hint queue. Invalid metadata or overflow fails open to the source work.

The current `FrameProgramLowering` sends VisibilityKey/depth/MeshletWork directly to the Surface frequency planner and Dense/exception material pass. The former 64-class ShadingWork classifier/scatter and per-class indirect consumer are removed. The Visibility `ShadingBinId` attachment and ABI still have actual raster/diagnostic users; their existence does not create a second material path. Surface owns its own bounded exception queue and full-lane overflow fallback.

Each visibility queue states its ABI, capacity, producer, consumer and overflow behavior. Invalid identity must fail visibly, and zero work must leave a consumer-safe state. Visibility does not submit a private frame or use same-frame readback to control material work. Device recovery rebuilds queues and caches in the new device epoch.

Primary entrypoints are `render/features/VisibilityFeature.ts`, `render/program/FrameProgramLowering.ts`, `render/HierarchicalWorkGenerator.ts`, `render/MeshletBucketRaster.ts`, `render/passes/PackedVisibilityPass.ts` and `render/HierarchicalZBuffer.ts`. [ADR-0013](../adr/0013-sparse-shading-bin-pipeline.md) describes historical ownership; [ADR-0020](../adr/0020-clean-cut-renderer.md) and the current source determine the Next path. Browser evidence and claims remain deferred to final Next Renderer acceptance.

Selected frame geometry now follows MeshletWork → shared instance transforms → `FrameGeometryVertices` → Raster. The vertex owner decodes/transforms each selected meshlet-local vertex once, preserves original triangle corner order, and writes independent bounded clip/triangle regions in `FrameGeometryArena`. Ordinary mirrored corner selection stays in Raster. A zero directory entry uses the original accurate source decoder in that same shader, retaining visibility on reservation/capacity misses. This is not persistent resident attributes, deformation or cross-meshlet deduplication.

Product late HZB copies each source geometry directory entry into its reserved filtered work slot; clips/triangles are shared, and profile/LOD flags are not repurposed as indices. The filter dispatch follows actual GPU written count through a separate indirect producer/read scope, including a 2D grid. FrameGraph carries the shared arena write/read versions through both raster stages. Immutable metadata copies commit after the existing frame submission and stable frames omit them. Scene publication awaits asynchronous vertex/HZB PSOs and finite ordinary/Product Raster descriptors; the draw path requires those exact warmed descriptors.

Native and headed installed Chrome component diagnostics each execute 18 cases/9,670 covered pixels, including source-position mutation after preparation, conservative HZB remapping and 65,537-entry grids. Shared-owner bytes, preparation rollback, aborted publication, stable reuse and queue-order retirement have focused tests. The winner consumer is still diagnostic; current production Surface reconstructs from source geometry. A missing shared directory keeps Raster coverage but returns invalid winner interpolation, so complete new-Surface geometry supply remains required. The modified old native Surface diagnostic initially exits abruptly during the shear frame while Chrome also compiles; the isolated shear and serial ten-frame/3,533-pixel runs then pass with zero API errors/device loss. The abrupt-exit cause is not established; failed logs remain and final GPU runs must be serial. These facts do not establish final S2 or net performance.
