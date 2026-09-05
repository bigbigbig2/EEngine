# Rendering Lab

`rendering-lab` is the Storybook-backed visual and performance fixture for the
GPU-driven static scene path. It loads the unchanged `dungeon_warkarma.glb`
asset, cooks imported geometry into versioned runtime packages, uploads those
packages through `GpuAssetStore`, and renders one Packed Instance table.

Performance telemetry is provided by the shared `OEngine` Performance Inspector
(`OEngine/src/addons/inspector`). The former Rendering Lab statistics and
pipeline panels have been removed so there is a single source of truth for
timings, counters, FrameGraph, resources and diagnostics. The **性能 Inspector**
button toggles the shared panel; scene controls and debug views remain in the
Rendering Lab panel.

## Modes

- `rendering-lab/` keeps the quality fixture for visual debugging.
- `rendering-lab/?mode=pipeline` is the focused pipeline mode. It disables
  shadows, AO, SSR, TAA, bloom, exposure and sharpening so the panel isolates
  the path through Surface.

The Inspector reports package/residency and packed-scene evidence, visibility
and work-generation counters, RasterWork/indirect consumption,
VisibilityKey/reverse-Z coverage, material features, FrameGraph command counts,
resource/memory state and diagnostics. GPU timestamps and counters are
asynchronous; an unsampled frame is shown as unavailable rather than inferred
to be zero.

Run from `examples` with `yarn storybook` and open **Showcase / Rendering Lab**.
