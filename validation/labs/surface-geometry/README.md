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
