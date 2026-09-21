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
