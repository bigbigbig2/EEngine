---
id: visibility
kind: domain
owner: visibility
contracts: 
  - claims-and-evidence
claims: 
  - visibility.gpu-closure
  - visibility.feature-off
---
# Visibility

Visibility owns hierarchy traversal, work generation, indirect raster, VisibilityKey/depth publication, and the sparse shading queue. The final visible work must remain GPU producer to GPU consumer; CPU readback is diagnostic or asynchronous scheduling feedback only.

Every queue records its element ABI, capacity, overflow behavior, producer, consumer, and counters. Identity mismatches and overflow fail closed. Feature-off removes the queue work, resources, readback, and submit from the frame plan.

Exact formats and shader invariants live in `docs/specs/` and the ADR-0013 decision. Durable claims are `visibility.gpu-closure` and `visibility.feature-off`; the candidate and production browser cases are linked in `project/claims/visibility.yaml`.

## Current Production Path

GPU hierarchy traversal produces bounded meshlet work, indirect raster publishes VisibilityKey/depth, shading-bin classification creates sparse resolve work, and GPU consumers close the chain without CPU visible-list traversal. Counters and bounded diagnostic readback observe the chain without becoming its producer.

## Owner Boundaries And Failure

Visibility owns hierarchy work generation, raster, visibility output, queue ABI/capacity/overflow, and indirect consumers. Asset residency owns page availability; shading owns final material evaluation. Missing identity, overflow, zero work, and feature-off must produce a closed, consumer-safe state without orphan resources or submits.

## Main Entrypoints And Proof

Primary entrypoints are `OEngine/src/render/passes/`, `MeshletBucketRaster.ts`, `GpuShading*.ts`, `GpuSparseShading*.ts`, and the corresponding shaders. Sparse production plus virtual-product production promote GPU closure; component/candidate cases are diagnostic. The sparse candidate case promotes feature-off pruning.
