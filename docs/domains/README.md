# Domains

Domain pages explain the current owner boundary in human terms. The matching file under `project/domains/` owns routing plus direct contract, claim, check, and source relationships. Claim policies live under `project/claims/`, and case manifests live under `validation/cases/`. Run `node tools/vibe.mjs context <path>` to generate the current relationship summary.

| Domain | Machine source | Current owners |
| --- | --- | --- |
| [Virtual assets](./virtual-assets.md) | `project/domains/virtual-assets.yaml` | Assets, loaders, geometry, Product admission, residency |
| [Visibility](./visibility.md) | `project/domains/visibility.yaml` | Work generation, raster, visibility, sparse queues |
| [Shading](./shading.md) | `project/domains/shading.yaml` | Material evaluation, lighting, temporal and post |
| [Frame runtime](./frame-runtime.md) | `project/domains/frame-runtime.yaml` | Device, frame graph, renderer lifecycle, recovery |
| [Materials and textures](./materials-textures.md) | `project/domains/materials-textures.yaml` | Authored slots, texture residency, binding identity |
| [Platform](./platform.md) | `project/domains/platform.yaml` | WebGPU capability, validation host, project OS |
