# OEngine Rendering Lab

The `examples/` directory contains independent browser fixtures backed by the
real OEngine renderer. `rendering-lab/` remains the integrated quality fixture;
the feature cases under `basic-scene/`, `model-loading/` and
`geometry-preprocess/` each own their own renderer, scene and evidence bridge.
The integrated page includes quality controls, GPU counters, debug views and a
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
Vite build is `yarn build`. Browser smoke testing uses the installed Google
Chrome when available (otherwise Playwright Chromium), launches each case in a
fresh browser context, and writes screenshots plus JSON results under
`../temp/fixture-results/`:

```powershell
yarn test:fixtures
```
