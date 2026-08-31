# FX-08 Screen-Space Reflections Gate

Production `Renderer.render()` fixture for SSR hit/miss, roughness `0 / 0.5 / 1`,
environment miss fallback, offscreen target, camera pan/disocclusion, shared temporal
history, and feature-off ownership. The runner stores debug/final screenshots,
scene-linear HDR readback metrics, per-phase GPU timestamps, graph/lifecycle evidence,
and browser/WebGPU diagnostics.
