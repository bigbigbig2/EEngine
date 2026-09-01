# Integrated Pipeline Showcase

This standalone example is mounted in Storybook as **Showcase / Cyberpunk City**.

It exercises the production OEngine path instead of defining a separate demo renderer:

```text
GLB -> load_gltf_packed -> Geometry Cooker -> Packed GPU Scene
    -> hierarchy / SSE / cone / HZB work generation
    -> hardware Visibility -> single Material Resolve
    -> clustered direct lighting + CSM + IBL
    -> optional SSAO / SSR / TAA / Bloom / Exposure / Sharpen
    -> unified render debug view -> Tonemap / Present
```

The right-hand panel changes public `Renderer` feature switches. Selecting a debug view uses the existing single `render_debug_view` contract; it does not add a second render pipeline.

The source GLB uses different UV sets for a small number of textures, including one `TEXCOORD_2` normal map. Before calling `load_gltf_packed()`, this example rewrites those temporary GLB JSON texture-info mappings to the first mapping used by each material (UV0 for the current asset). The original file remains unchanged. This is an explicit visual compatibility adaptation to the current shared-UV `MaterialRecord v2` contract, not a relaxation of the engine ABI.

Every primitive is cooked with the production `renderable` hierarchy recipe. The city asset also acts as a large-coordinate regression for conservative float32 Cluster bounds; the Cooker recomputes the required merged-sphere radius after quantizing its center.

## Assets

- `../public/cyberpunk_city.glb`: **Cyberpunk City** by [mortalityrexotable](https://sketchfab.com/mortalityrexotable), downloaded from [Sketchfab](https://sketchfab.com/3d-models/cyberpunk-city-3f24e5c5bf924f46b30d9a392afa9624), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The attribution is also embedded in the GLB `asset.extras` and displayed in the example UI.
- `assets/venice_sunset_1k.hdr`: **Venice Sunset** by Greg Zaal, sourced from the authored three.js example asset at `three.js/examples/textures/equirectangular/venice_sunset_1k.hdr`; original asset page: [Poly Haven](https://polyhaven.com/a/venice_sunset), licensed CC0.

The environment asset provenance and adoption decision are recorded in `docs/references/porting/SHOWCASE-01-venice-sunset-ibl.md`.
