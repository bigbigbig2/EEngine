# Hello HDR + glTF

Venice Mask is loaded through `load_gltf()` and published through the Product-backed Virtual Geometry path. The local Venice Sunset HDR is loaded through `load_environment_map()` and assigned to `scene.lights.environment`, which drives authored diffuse/specular IBL. The renderer's authored background stage samples the same published radiance mip chain for camera-visible HDR.

The sample follows Hello Cube's baseline: no extra light, HZB off, TAA/FSR3/jitter off, AO/VSM/Bloom off. Runtime controls are routed to renderer owners: exposure to Radiometry, tone mapping to Present's display LUT, and intensity/blur to the authored background pass only.

The upstream Venice Mask requires Draco and uses WebP textures. The checked-in GLB has Draco decompressed losslessly by gltf-transform, retaining WebP images supported by the browser image decoder. It is a preprocessed example asset; the engine loader itself does not claim Draco support.

Asset sources and licenses are recorded in `assets/SOURCE.md`.
