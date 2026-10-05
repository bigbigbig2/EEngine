---
id: domains/readme
state: current
verifies:
  - project/domains
---
# Domains

Domain pages summarize implemented owner boundaries, production data flow and known gaps. The matching file under `project/domains/` owns routing plus contract, check and source relationships. Case manifests live under `validation/cases/`; the claim layer is retired. Use `node tools/vibe.mjs context <path>` for navigation. A target design, a completed task label or a passing fixture does not by itself prove a production implementation.

| Domain | Machine source | Current owners |
| --- | --- | --- |
| [Virtual assets](./virtual-assets.md) | `project/domains/virtual-assets.yaml` | Assets, loaders, geometry, Product admission, residency |
| [Visibility](./visibility.md) | `project/domains/visibility.yaml` | Work generation, raster, visibility, sparse queues |
| [Shading](./shading.md) | `project/domains/shading.yaml` | Material evaluation, lighting, temporal and post |
| [Frame runtime](./frame-runtime.md) | `project/domains/frame-runtime.yaml` | Device, frame graph, renderer lifecycle, recovery |
| [Materials and textures](./materials-textures.md) | `project/domains/materials-textures.yaml` | Authored slots, texture residency, binding identity |
| [Platform](./platform.md) | `project/domains/platform.yaml` | WebGPU capability, validation host, project OS |
