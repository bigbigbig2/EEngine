# Rendering Lab

`rendering-lab` is the Storybook-backed visual and performance fixture for the
GPU-driven static scene path. It loads the unchanged `dungeon_warkarma.glb`
asset, cooks every imported geometry into a versioned runtime package, uploads
the packages through `GpuAssetStore`, and renders one Packed Instance table.

## Modes

- `rendering-lab/` keeps the existing Q00 quality fixture for visual debugging.
- `rendering-lab/?mode=pipeline` is the focused Storybook performance mode. It
  disables shadows, AO, SSR, TAA/TAAU, bloom, exposure, motion blur and
  sharpening so the panel isolates the path through Surface.

The pipeline panel reports source/package counts, resident bytes, packed table
stride, hierarchy/SSE/Cone/HZB counters, work-generation reservations and CAS
retries, RasterWork/indirect consumption, VisibilityKey/reverse-Z coverage,
material features and FrameGraph command counts. GPU timestamps and counters are
asynchronous; an unsampled frame is shown as unavailable rather than inferred
to be zero.

The scene uses the existing `OrbitalCameraController`: left-drag rotates,
right-drag pans, and the wheel changes distance. Debug views are limited to the
surface/visibility data needed by the focused mode.

Run from `examples` with `npm run storybook` and open **Showcase / Rendering
Lab · GPU Pipeline**.
