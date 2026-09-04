# Rendering Lab

`rendering-lab` is the Storybook-backed visual and performance fixture for the
GPU-driven static scene path. It loads the unchanged `dungeon_warkarma.glb`
asset, cooks imported geometry into versioned runtime packages, uploads those
packages through `GpuAssetStore`, and renders one Packed Instance table.

## Modes

- `rendering-lab/` keeps the quality fixture for visual debugging.
- `rendering-lab/?mode=pipeline` is the focused pipeline mode. It disables
  shadows, AO, SSR, TAA, bloom, exposure and sharpening so the panel isolates
  the path through Surface.

The pipeline panel reports package statistics, residency, packed instance
tables, hierarchy/SSE/Cone/HZB counters, work-generation reservations,
RasterWork/indirect consumption, VisibilityKey/reverse-Z coverage, material
features and FrameGraph command counts. GPU timestamps and counters are
asynchronous; an unsampled frame is shown as unavailable rather than inferred
to be zero.

Run from `examples` with `yarn storybook` and open **Showcase / Rendering Lab**.
