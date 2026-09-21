---
id: materials-textures
kind: domain
owner: materials-textures
contracts: 
  - claims-and-evidence
claims: 
  - materials.texture-path
  - materials.mip-convergence
---
# Materials And Textures

This domain owns authored PBR slots, sampler/UV metadata, texture residency, mip availability, and bounded material/texture identity. Image bytes stay outside the geometry Product ABI and enter the production `TextureResidency` path through an atomic mapper.

Mode A sampling clamps to the available mip and converges after promotion. A residency record is not evidence of physical memory release; that requires a separate allocation and budget measurement.

The durable claims are `materials.texture-path` and `materials.mip-convergence`. Their component and authored-texture cases are declared in `project/claims/materials-textures.yaml`.

## Current Production Path

Authored image, sampler, UV, alpha-mode, and material-slot metadata enter the scene mapper, then publish through `TextureResidency` and the GPU material identity consumed by the single shading path. Sampling clamps to the highest available mip until promotion publishes a newer residency view.

## Owner Boundaries And Failure

This domain owns decoded texture packages, physical residency, mip availability, sampler identity, and material bindings. Geometry Product does not own image bytes, and loaders do not retain long-lived GPU textures. Decode, budget, cancellation, or replacement failure leaves the previous active mapping intact.

## Main Entrypoints And Proof

Primary entrypoints are `OEngine/src/material/`, `OEngine/src/assets/Texture*.ts`, and `OEngine/src/gpu/Texture*.ts`. Authored-texture production plus the texture-residency oracle promote the texture-path claim; isolated transport variants are diagnostic. The residency oracle promotes mip convergence.
