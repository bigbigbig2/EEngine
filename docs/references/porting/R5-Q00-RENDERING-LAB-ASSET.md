# R5-Q00 Rendering Lab Asset Record

- Reference ID: `R5-Q00-DUNGEON-WARKARMA-ASSET`
- upstream project: three.js
- repository URL: `https://github.com/mrdoob/three.js.git`
- repository revision used by this checkout: `7cda7e710d884827fc73ff1a3aa63270846513d7`
- asset introduction commit: `03419b8b34fa981ee3daa2c0ca3b699f2ff9c5cb`
- source path: `examples/models/gltf/dungeon_warkarma.glb`
- source example: `examples/webgpu_postprocessing_ssr_denoise.html`
- local path: `examples/rendering-lab/assets/dungeon_warkarma.glb`
- local retained repository license: `examples/rendering-lab/assets/THREE-LICENSE.txt`
- SHA-256: `cac0fc8c16d107e7ac4e69efde89c2cb6ef4bc66c34456a4dd0923218e5aafb1`
- upstream attribution: “Dungeon - Low Poly Game Level Challenge” by Warkarma
- upstream author link: `https://sketchfab.com/warkarma`
- license evidence: the three.js checkout distributes the asset under its top-level MIT license and carries the author attribution in the examples that consume it; no separate asset-local notice exists in the checkout
- maturity class: upstream example asset used by three.js WebGPU SSR and performance examples
- decision: adopt as a copied validation asset with the repository license and upstream attribution retained

## Compatibility inspection

Before adoption, the GLB JSON chunk was inspected independently of OEngine:

- 1 scene, 1,489 nodes, 798 meshes and 25 materials;
- zero skins, zero skinned nodes and zero animations;
- no Draco-compressed primitive extension;
- 25 embedded WebP images through required `EXT_texture_webp`;
- no external URI dependency.

This satisfies the static-node contract of `load_gltf_packed()`. Browser decoding and actual Packed residency remain runtime gates; a successful TypeScript or Vite build is not evidence that import succeeded.

## Scope

The dungeon is the main bounded, traceable PBR subject in the `rendering-lab` example. It is the same GLB loaded by three.js `webgpu_postprocessing_ssr_denoise.html`, but OEngine does not copy or execute the three.js SSR, temporal reproject, denoise, loader, renderer or scene implementation.

The surrounding roughness lanes, floor, contact boxes, thin poles, emissive markers and lights are authored with OEngine geometry/material APIs. They provide deterministic GTAO, SSR, shadow, lighting and temporal evidence in addition to the authored dungeon surfaces.

## OEngine adaptation

- The local OEngine Packed glTF loader reads the unchanged GLB.
- Imported source geometries are cooked into OEngine `GeometryAssetPackage` records.
- Imported transforms are uniformly fitted to a 7.2 m lab subject while preserving local geometry bounds.
- Imported materials remain loader-owned CPU data until the packed-scene residency owner uploads them.
- Runtime import, cook, residency and first-frame readiness are tested in a WebGPU browser before screenshots are accepted.

## Performance and fallback

This asset is selected for controllable image-quality evidence and for workload complexity beyond a single hero object. Q00 reports its geometry/material counts, GPU timings and residency separately from Cyberpunk City. Import, cook or residency failure is fatal for the example; it does not silently substitute another model.
