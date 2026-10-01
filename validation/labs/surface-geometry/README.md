# Shared Surface geometry diagnostic

This host checks the actual `WinnerPrimitiveInterpolation` owner and its downstream shader library. It is component diagnostic evidence, not Chrome/Showcase, a complete S2 implementation, an adopted upstream port, AAA quality acceptance or a performance result.

Run from the repository root after `npm run build:test` in `OEngine`:

```powershell
node validation/labs/surface-geometry/winner-interpolation-gpu-oracle.mjs .local/surface-gpu-oracle
```

The second argument locates an already-installed external `webgpu` runtime. Nothing is installed into engine dependencies. Ignored artifacts are written under `.local/validation/surface-geometry/`.

The host publishes fixture geometry inputs, then GPU-produces clip transforms once. Hardware raster and the winner coefficient producer/consumer read the same clips. The shader consumer reads the real dictionary and coefficients, including direct misses. Basis varyings are perspective-interpolated by the hardware. A separate double Gaussian solve supplies current weights and independent +1 pixel footprint references; it does not duplicate the shader cofactor implementation.

Coverage includes perspective, near/side clipping, original zero/negative W, mirrored nonuniform transforms, local primitive 127, final winners only, three repeated frames, empty second frames, fully clipped work, zero generation, hash collisions/full tables, coefficient/probe overflow, valid current pixels with a singular neighbor, degeneracy/NaN, and common clip scales from 1e-30 through 1e30. Allocation/accounting/loss/abort tests live in `OEngine/tests/contract/winner-interpolation-owner.test.mjs`.

Observed 2026-10-01: GTX 1650 Ti, D3D12 driver `32.0.15.8142`, Dawn Node `webgpu@0.6.1`; 26 case/frames and 19,874 covered pixels passed. Analytic weight error ≤4.8837144e-7; gradient error ≤1.9343742e-7. Hardware basis error ≤0.000162065 within this fixture's independent 0.00025 raster budget. The initial 0.00003 hardware budget failed and its report is retained locally. For the unclipped perspective case, independently rounding projected vertices to 1/256 pixel yields ≤1.5136974e-7 against hardware, identifying subpixel snapping; the analytic oracle was not relaxed. These tolerances are fixture-specific and do not establish general quality limits.

API validation/uncaptured errors and device loss were zero. Native Dawn still emits other-adapter initialization `0x887A0020` and pipeline cached blob `0x8000FFFF` diagnostics; this is not evidence of a clean Chrome environment.

The fixture transform producer is deliberately independent of renderer scheduling. Ordinary/Product resident attribute preparation, actual frame geometry ownership/capacity and Surface cutover, normal/tangent semantics, stable source domains/LOD mapping and final browser/performance/video validation remain required. The source profile and local algorithm boundary are recorded in `docs/porting/next-renderer.md`.

## Shared instance transforms

`FrameInstanceTransforms` is now in the production `PackedVisibilityPass` / `VisibilityWorkSet` chain. Actual MeshletWork selects unique instances entirely on GPU, prepares current clip matrices and normal cofactors once, and supplies ordinary/Product Raster and Surface through the replaced instance binding. Late HZB consumes the same prepared superset. Temporal facts, culling and HZB retain Scene's authoritative motion records. Selection and build both use GPU indirect dispatch; the declared queue capacity does not determine launched selection work. Buffer accounting includes records, markers, compact queue, settings, control and indirect, with a 256 MiB cumulative owner budget in addition to negotiated limits.

```powershell
node validation/labs/surface-geometry/frame-instance-gpu-oracle.mjs .local/surface-gpu-oracle
node validation/labs/surface-geometry/frame-instance-chrome-compile.mjs
```

The native host executes the actual owner, actual ordinary hardware raster shader and actual Surface geometry/setup and cached-normal helper. Ten frames cover duplicate instances, mirrored/nonuniform/sheared transforms, camera and instance movement, empty-after-visible, zero generation, invalid references, published-count clamping and generation `0x7fffffff`. Generation uses an explicit u32 lane, not float NaN payload storage. It checks exact 176 B source snapshots, generation, clip matrices and interpolation, and compares normals with an independent double pivoted solve of `M^T n = local`. Observed GTX 1650 Ti / D3D12 `32.0.15.8142`: 3,533 covered pixels; clip error ≤5.96046448e-8, normal error ≤7.17062618e-8, barycentric error ≤2.09740457e-7. API errors/device loss zero. Singular transforms are selected/snapshotted; this fixture does not rasterize or independently check their normal fallback. The native adapter/cache-blob diagnostics above persist.

The second host uses installed **headed Chrome 154.0.8037.92**, no GPU feature flags or software adapter, and creates actual asynchronous PSOs for ten affected shader families: frame preparation, ordinary opaque/MASK, Product raster, ordinary/Product Probe, worker and closure. It includes the 16-storage Product + scalar-AO profile; combined VSM + scalar-AO would require 17 and remains rejected by the preexisting limit contract, not claimed supported. API errors/device loss zero. This is PSO compilation evidence, not Showcase frames or performance. Product's generic worker compilation took 38–42 seconds across these batches; these cold preparation times are not GPU frame cost and remain a final finite-program replacement concern.

An optional native `--compile-consumers` run exited with code 1 abruptly while creating the full ordinary Probe PSO; it produced no JavaScript/WebGPU validation error and did not complete. Its pending/failed attempt is retained locally (`frame-instance-native-compile-report.json`, run log); the cause is **unresolved**, not asserted to be browser incompatibility. Complete consumer compilation was verified separately in real Chrome. Neither diagnostic establishes full S2, shared resident attributes/vertices, stable LOD addresses, a new cache/lighting pipeline, or final performance/quality acceptance.
