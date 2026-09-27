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
