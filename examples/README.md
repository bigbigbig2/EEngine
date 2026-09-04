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

Storybook serves the lab at `Showcase / Rendering Lab`. The production build is
available with `yarn build:storybook`; the standalone Vite build is
`yarn build`.
