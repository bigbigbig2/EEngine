# OEngine Rendering Lab

`rendering-lab/` is the only browser fixture kept in this workspace. It is a
single Storybook story backed by the real OEngine renderer and the packed static
scene path. The page includes quality controls, GPU counters, debug views and a
focused `?mode=pipeline` mode for isolating the Surface path.

```powershell
Set-Location examples
yarn install
yarn storybook
```

Storybook serves independent cases at `Showcase / Basic Scene · Cube + Plane`,
`Showcase / Feature 02 · Model Loading` and `Showcase / Feature 03 · Geometry
Preprocess`, alongside the integrated Rendering Lab. Each case owns its own
HTML page, renderer, scene, camera, controls, Inspector and failure state; the
cases intentionally do not share a runtime harness. Every case has **导出
JSON**, **截图** and **重置相机** controls. JSON includes case status, build
provenance, lifecycle, camera and feature evidence; startup failures remain
exportable for manual capture.

The production build is available with `yarn build:storybook`; the standalone
Vite build is `yarn build`.
