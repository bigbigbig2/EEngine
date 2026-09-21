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
