---
name: webgpu
description: Build, debug, and optimize native WebGPU and WGSL applications. Use for adapter and device setup, resources, pipelines, shaders, rendering, compute, compatibility, errors, or performance; use webgpu-review for explicit audits.
---

# WebGPU

Use the smallest relevant topic guide for the current WebGPU or WGSL task. Treat
repository `AGENTS.md`, accepted ADRs, target-platform documents, and project ABI
rules as authoritative over bundled general guidance.

## Workflow

1. Identify the task category and select one primary topic below.
2. Read that topic's `guidance.md` before implementing or diagnosing the task.
3. Load `methods.md` only for exact API signatures, layouts, limits, or decision tables.
4. Load `examples.md` only when a concrete implementation pattern is needed.
5. Load `anti-patterns.md` only for debugging, review, or avoiding a known failure.

Load additional topics only when the task crosses a real API or ownership boundary.
Do not read every reference. For current browser support, proposal status, or spec
details, verify an authoritative current source instead of relying only on bundled
version claims.

Legacy identifiers such as `webgpu-core-architecture` are topic identifiers retained
from the upstream package. They are not separately installed skills.

## Start here

- End-to-end setup, workload selection, or topic routing:
  [pipeline orchestrator](references/agents/pipeline-orchestrator/guidance.md)

## Core runtime

- Adapter, device, queue, initialization, lifecycle:
  [architecture](references/core/architecture/guidance.md)
- Required limits, optional features, compatibility tier:
  [limits and features](references/core/limits-features/guidance.md)
- Render versus compute pipelines, layouts, shader modules:
  [pipeline architecture](references/core/pipeline-architecture/guidance.md)
- Buffer sizes, offsets, row pitch, dynamic-offset alignment:
  [memory model](references/core/memory-model/guidance.md)
- Chrome, Safari, Firefox, and feature detection:
  [cross-browser](references/core/cross-browser/guidance.md)
- Web Workers and OffscreenCanvas:
  [workers](references/core/workers/guidance.md)

## Host API syntax

- Buffer creation, usage flags, mapping, and uploads:
  [buffers](references/syntax/buffers/guidance.md)
- Textures, views, samplers, formats, and external textures:
  [textures](references/syntax/textures/guidance.md)
- Bind group layouts, bind groups, and dynamic offsets:
  [bind groups](references/syntax/bind-groups/guidance.md)
- Command encoders, passes, copies, submission, and queries:
  [command encoder](references/syntax/command-encoder/guidance.md)
- Render pipeline descriptors and fixed-function state:
  [render pipeline](references/syntax/render-pipeline/guidance.md)
- Compute pipeline descriptors and dispatch sizing:
  [compute pipeline](references/syntax/compute-pipeline/guidance.md)
- Canvas configuration, presentation, and resize:
  [canvas context](references/syntax/canvas-context/guidance.md)

## WGSL

- Types, declarations, operators, control flow, and functions:
  [syntax](references/wgsl/syntax/guidance.md)
- Address spaces, host layout, padding, and alignment:
  [memory layout](references/wgsl/memory-layout/guidance.md)
- Builtin functions and builtin stage values:
  [builtins](references/wgsl/builtins/guidance.md)
- Texture and sampler declarations and operations:
  [textures](references/wgsl/textures/guidance.md)
- Vertex inputs, position, varyings, and interpolation:
  [vertex shaders](references/wgsl/vertex-shaders/guidance.md)
- Fragment outputs, MRT, depth, sampling, and discard:
  [fragment shaders](references/wgsl/fragment-shaders/guidance.md)
- Compute invocations, workgroup memory, atomics, and barriers:
  [compute shaders](references/wgsl/compute-shaders/guidance.md)
- Uniform control flow, diagnostics, enable, and requires:
  [uniformity](references/wgsl/uniformity/guidance.md)

## Implementation patterns

- Attachments, MRT, depth-stencil, and MSAA:
  [render targets](references/impl/render-targets/guidance.md)
- Post-processing, deferred shading, shadows, and ping-pong:
  [multipass](references/impl/multipass/guidance.md)
- Instancing, indirect draws or dispatches, and GPU-driven work:
  [instancing and indirect](references/impl/instancing-indirect/guidance.md)
- Upload paths, staging, readback, and padded texture copies:
  [buffer upload](references/impl/buffer-upload/guidance.md)
- Frame loops, mapping, pipeline creation, and avoiding stalls:
  [async patterns](references/impl/async-patterns/guidance.md)
- Caching, bundles, state churn, workgroups, and profiling:
  [performance](references/impl/performance/guidance.md)
- Image processing, particles, physics, reductions, and scans:
  [compute use cases](references/impl/compute-usecases/guidance.md)
- PBR, full-screen passes, post-processing, and screen-space effects:
  [render use cases](references/impl/render-usecases/guidance.md)
- WebGL/WebGL2 concepts, clip space, commands, and mipmaps:
  [WebGL migration](references/impl/webgl-migration/guidance.md)

## Errors and debugging

- Device loss and full resource recovery:
  [device loss](references/errors/device-loss/guidance.md)
- Error scopes, uncaptured errors, and contagious validation failures:
  [validation](references/errors/validation/guidance.md)
- Labels, compilation info, debug markers, and GPU tooling:
  [debugging](references/errors/debugging/guidance.md)

## Review boundary

For an explicit audit, code review, or correctness checklist, use `$webgpu-review`.
During ordinary implementation, diagnose only the issue needed to complete the task;
do not expand every WebGPU change into a full audit.