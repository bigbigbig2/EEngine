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

Storybook serves the examples at `Showcase / Basic Scene · Cube + Plane` and
`Showcase / Rendering Lab`. The basic scene demonstrates a packed cube and
ground plane with `PerspectiveCamera` + `OrbitControls`; the production build
is available with `yarn build:storybook`; the standalone Vite build is
`yarn build`.
