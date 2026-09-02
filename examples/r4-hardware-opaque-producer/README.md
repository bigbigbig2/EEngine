# R4-A-02 Hardware Opaque Producer

This browser gate runs the production Hardware opaque shader and the R3
hierarchical work generator in one GPU command stream:

```text
GpuAssetStore + GpuScene
-> HierarchicalWorkGenerator
-> RasterWork + 16-byte drawIndirect
-> PACKED_HIERARCHY_VISIBILITY_RASTER_WGSL
-> direct r32uint VisibilityKey + depth32float reverse-Z
-> validation-only readback
```

The readback verifies valid and empty keys, zero reserved-slot invalid keys,
`VisibilityKey -> RasterWork -> VisibleCluster` resolution, draw-indirect ABI,
reverse-Z depth, WGSL compilation diagnostics, validation errors and uncaptured
errors. It does not feed the current frame or add a production submit.

Run with:

```powershell
cd examples
npm run dev:host
```

Open `http://127.0.0.1:5173/r4-hardware-opaque-producer/`.
