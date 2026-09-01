# SHOWCASE-01 Venice Sunset IBL asset

## Registration

- **Reference ID:** SHOWCASE-01
- **Decision:** adopt as a copied example-only asset
- **Reason:** OEngine already owns the RGBE decode, equirectangular-to-octahedral reprojection, GGX prefilter, diffuse irradiance, and runtime IBL pipeline. Reusing a known HDR environment provides realistic input without importing three.js runtime code or creating a second IBL implementation.

## Upstream

- **Asset:** Venice Sunset 1K HDR by Greg Zaal
- **Original page:** https://polyhaven.com/a/venice_sunset
- **License:** CC0; Poly Haven confirms its downloadable assets are distributed under CC0 at https://polyhaven.com/license
- **Local upstream repository:** `three.js/`
- **Repository URL:** https://github.com/mrdoob/three.js
- **Upstream checkout:** `7cda7e710d884827fc73ff1a3aa63270846513d7`
- **Source path:** `examples/textures/equirectangular/venice_sunset_1k.hdr`
- **Example path:** `examples/webgpu_loader_gltf_iridescence.html`
- **Asset-introducing commit:** `47afab803818d4579ebcf0897fb6ff840cc99679`
- **OEngine copy:** `examples/integrated-showcase/assets/venice_sunset_1k.hdr`

## Scope and ABI

- **Input ABI:** RGBE equirectangular `.hdr` fetched as an `ArrayBuffer`.
- **OEngine path:** `load_environment_map()` decodes RGBE, reprojects the image to OEngine's octahedral environment representation, converts it to half-float HDR, and returns a `ShadeTexture`.
- **Runtime consumer:** the existing environment owner creates separate GGX-prefiltered specular radiance and cosine-convolved diffuse irradiance resources for the unified lighting pipeline.
- **Retained invariants:** scene-linear HDR values, equirectangular projection, and the environment's original radiance distribution.

## Adaptation and differences

- No three.js loader, PMREM implementation, material, renderer, shader, or generated artifact is copied.
- three.js samples this asset through `HDRLoader` and its PMREM/environment path; OEngine samples the same source asset through its own tested RGBE and IBL path.
- The copied asset is limited to the example and is not exposed as an OEngine runtime dependency or public API.

## Cost and failure behavior

- The 1K source adds approximately 1.4 MB to the example distribution and incurs one-time CPU RGBE decode/reprojection plus GPU environment prefiltering.
- No new steady-frame pass is introduced; the example consumes the existing IBL passes.
- Fetch or decode failure is reported by the showcase loading UI and prevents the render loop from starting. There is no silent fallback that would make the IBL demonstration misleading.

## Local validation

- Build: `cd examples; npm run build:storybook`
- Runtime: Storybook `Showcase / Cyberpunk City`
- Required checks: scene reaches `data-state="ready"`, final output and IBL debug views render, feature/debug switches do not produce WebGPU or console errors, and teardown releases the Renderer.
