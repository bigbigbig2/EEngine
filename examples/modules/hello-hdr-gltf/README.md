# Hello HDR + glTF

Venice Mask is published from the checked-in offline GeometryProduct and BC texture products through the Product-backed Virtual Geometry path. The browser does not cook GLB geometry or transcode its textures on startup. The local Venice Sunset HDR is loaded through `load_environment_map()` and assigned to `scene.lights.environment`, which drives authored diffuse/specular IBL. The renderer's authored background stage samples the same published radiance mip chain for camera-visible HDR.

The sample follows Hello Cube's baseline: no extra light, HZB off, TAA/FSR3/jitter off, AO/VSM/Bloom off. Runtime controls are routed to renderer owners: exposure to Radiometry, tone mapping to Present's display LUT, and intensity/blur to the authored background pass only.

The upstream Venice Mask requires Draco and uses WebP textures. The checked-in GLB has Draco decompressed losslessly by gltf-transform, retaining WebP images supported by the browser image decoder. It is a preprocessed example asset; the engine loader itself does not claim Draco support.

Asset sources and licenses are recorded in `assets/SOURCE.md`.

## Rebuild cooked products

The source GLB remains checked in as the provenance and recook input. To regenerate the runtime products, follow the pinned offline-cook prerequisites in the Bistro example and run:

```powershell
node OEngine/tools/cook-offline-scene.mjs examples/modules/hello-hdr-gltf/assets/venice_mask.glb .local/models/hello-hdr-gltf-cooked 4
node OEngine/tools/verify-offline-scene.mjs .local/models/hello-hdr-gltf-cooked
```

Copy `scene.oescene`, `scene.materials.json`, the `.oegpack`, and `textures/*.textureproduct` from the cook output into `examples/modules/hello-hdr-gltf/assets/cooked/`. This sample uses the offline cooker's current geometry and BC7 material products; it is not a renderer benchmark or a claim of improved frame-time performance.
