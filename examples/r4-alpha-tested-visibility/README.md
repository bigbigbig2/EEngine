# R4-A-03 Alpha-Tested Visibility

This browser gate binds the production Packed Visibility WGSL to eight
hand-authored GPU `RasterWork` records and one `drawIndirect` command. It covers
opaque, texture mask, factor discard, blend exclusion, double-sided, mirrored,
invalid-texture fallback and sampler fallback behavior without a CPU
per-material draw loop.

Run with:

```powershell
cd examples
npm run dev:host
```

Open `http://127.0.0.1:5173/r4-alpha-tested-visibility/`.
