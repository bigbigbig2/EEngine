# Example assets

## Venice Mask

- Source: three.js `examples/models/gltf/venice_mask.glb`
- Upstream URL: https://github.com/mrdoob/three.js/blob/dev/examples/models/gltf/venice_mask.glb
- Author: DailyArt (credited by the three.js example)
- License: CC BY-NC 4.0, as credited by the three.js model/example attribution.
- Preparation: Draco geometry decompressed with glTF Transform CLI `copy`; image payloads retained. No three.js runtime dependency is used.

## Venice Sunset HDR

- Source: three.js `examples/textures/equirectangular/venice_sunset_1k.hdr`
- Upstream URL: https://github.com/mrdoob/three.js/blob/dev/examples/textures/equirectangular/venice_sunset_1k.hdr
- Creator/source credited in the example: HDRI Haven (Poly Haven).
- License: CC0, as stated by Poly Haven for its HDRIs.
- Repository copy was already present under `examples/assets/three/rendering-lab/`; this module owns its independent local copy.

## Pre-cooked runtime products

- Geometry and material products are generated from `venice_mask.glb` with `node OEngine/tools/cook-offline-scene.mjs examples/modules/hello-hdr-gltf/assets/venice_mask.glb .local/models/hello-hdr-gltf-cooked 4`.
- The committed `assets/cooked/` artifacts use the repository's Native Offline Cooker and BC texture product pipeline; regeneration and verification require the same pinned toolchain described in the Bistro offline-cook instructions.
- Source GLB SHA-256: `fe5873882034b3071fab964d72b58f8184b8a86f8b20dc539dfb8da75f0227be`.

- Cooked geometry is the repository's Native Offline GeometryProduct; geometry profile and conversion limits remain those of that cooker.

