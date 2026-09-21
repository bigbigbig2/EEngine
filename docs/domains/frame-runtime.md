---
id: frame-runtime
kind: domain
owner: frame-runtime
contracts: 
  - browser-harness
  - claims-and-evidence
claims: 
  - frame.recovery
  - frame.host-protocol
---
# Frame Runtime

Frame runtime owns capability negotiation, frame graph/resource publication, renderer lifecycle, resize, feature-off, submit retirement, and device-loss recovery. `Renderer` is the lifecycle shell and `MainRenderPipeline` is the single composition root.

A frame consumes an immutable publication revision. Persistent, transient, history, shadow, upload, and readback budgets are accounted by owner. Replaced resources retire only after the referencing submission completes. Recovery creates a new device and rebuilds CPU scene state without reusing old GPU resources.

Capability rules are in `docs/WEBGPU.md` and ADR-0010. Browser lifecycle evidence is governed by ADR-0014. Durable claims are `frame.recovery` and `frame.host-protocol`.
