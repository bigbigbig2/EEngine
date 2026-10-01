# Shared Surface geometry diagnostic

These hosts check the actual geometry/winner owners and their downstream shader libraries, including a headed Chrome component host. They are component diagnostic evidence, not Showcase, a complete S2 implementation, an adopted upstream port, AAA quality acceptance or a performance result.

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

## Single-binding frame geometry arena

```powershell
node validation/labs/surface-geometry/winner-interpolation-gpu-oracle.mjs .local/surface-gpu-oracle --arena
node validation/labs/surface-geometry/frame-geometry-arena-chrome.mjs
```

`FrameGeometryArena` owns one buffer with an immutable metadata prefix and aligned typed regions. Its cumulative physical budget includes alignment and directory storage. Vertex/triangle budgets are explicit; a second directory is allocated only when a filtered work namespace is requested. The winner owner borrows storage and owns only settings/indirect (64 B); this is not the total geometry/winner cost. Publication copy commits only after submission, so abandoned transactions remain retryable and committed stable frames encode zero metadata copies.

Binding aliasing and usage scopes are separate restrictions. The initial disjoint-range read-only/writable prototype failed with `Storage(read-write)|Storage(read-only)` in one synchronization scope. Producers now declare all arena views as storage/read_write, keep every range disjoint and leave input data logically read-only; the subsequent packed consumer binds the entire arena read-only in a separate scope. No blanket atomic-u32 vertex storage is needed. The corrected native owner executes the same 26 case/frames and 19,874 hardware pixels; typed and single-binding outputs agree within this diagnostic's 2e-6 per-value tolerance. Metadata is checked bit-for-bit after all GPU writes, including capacity misses. Existing separate-buffer diagnostics also pass after the internal range API migration.

Installed **headed Chrome 154.0.8037.92**, hardware NVIDIA Turing adapter, no GPU feature flags: the actual arena/winner owners and single-binding shader execute six frames and 2,717 covered pixels. Gaussian weight error ≤2.4345836e-7, finite footprint error ≤1.9577069e-7 and hardware basis error ≤0.0001493693, under independent fixture budgets. The host uses two newly allocated extents (64×32 / 80×48), an abandoned metadata publication, original W=0/negative W and near clipping. This does not test production Renderer resize, HZB directory remapping, shared resident geometry or full loss/recovery. API errors/device loss zero; physical owner accounting is zero after release. Native adapter/cache-blob diagnostics persist. Reports are `frame-geometry-arena-gpu-oracle.json` and `frame-geometry-arena-chrome.json` under the ignored artifact directory.

Focused layout/range/capacity/accounting/abort/loss tests are in `frame-geometry-arena.test.mjs` and `winner-interpolation-owner.test.mjs`. Real resident vertex production, original→filtered queue directory remapping, raster/Surface production consumption and full S1–S7 acceptance remain required; arena compilation is not an architectural performance result.

## Selected shared vertices and final HZB namespace

```powershell
node validation/labs/surface-geometry/frame-vertices-gpu-oracle.mjs .local/surface-gpu-oracle
node validation/labs/surface-geometry/frame-vertices-chrome.mjs
```

Both hosts run `frame-vertices-fixture.mjs`: actual instance/arena/selected-vertex/HZB/winner owners, actual ordinary/Product hardware raster shaders and the single-binding winner consumer. Ordinary source decoding is the existing Geometry ABI; Product uses its complete existing Float32 position profile. Each selected meshlet-local vertex and triangle is prepared once. This is not persistent decoded attributes, deformation, cross-meshlet deduplication or stable source/LOD addressing.

Each host passed 18 cases and 9,670 covered pixels on NVIDIA Turing hardware. Three negative controls overwrite source positions **after** shared clips are generated: ordinary, Product and filtered Product output remains identical to its unmodified reference. HZB rejects one of three meshlets and remaps each directory with its actual output reservation. Empty/zero-generation, stale source directory, independent vertex/triangle capacity misses, camera/motion/mirror/shear and 65,537-work 2D padded grids are covered. Shared clip error ≤5.96046448e-8; independent double Gaussian weight error ≤1.58964244e-7 and finite footprint error ≤2.17837548e-7. API errors/device loss zero and owner accounting zero after every release. Native Dawn adapter/cache diagnostics remain. Chrome is installed **headed 154.0.8037.92**, with no GPU feature flags or software adapter. Artifacts: `frame-vertices-native.json` and `frame-vertices-chrome.json`.

Capacity misses preserve Raster coverage through the accurate source decoder in the same production shader. The diagnostic winner returns invalid for a missing clip directory; complete new-Surface geometry supply on those misses is **still required**. Production PackedVisibility and FrameGraph now carry the shared vertices/directory; production Surface winner consumption remains pending. Focused tests cover exact asynchronous PSO readiness, cache dedup/failure/revocation, physical accounting, preparation rollback, stable workset reuse, aborted metadata commit and GPU-order retirement. These are not Showcase performance/video/quality acceptance.

The old `frame-instance-gpu-oracle.mjs` was updated with required shared-geometry bindings and a fresh pending report. Two initial attempts exit abruptly while Chrome also compiles; fresh state localizes the second to `frame/shear-raster`, without a JS exception. An isolated `--case shear-raster` run and a serial full ten-frame/3,533-pixel run both pass, retaining the exact snapshot/normal/clip budgets above and zero API errors/device loss. This correlation does not establish the abrupt-exit cause. Failed logs remain under the ignored artifact directory; final GPU acquisition must be serial. Installed Chrome separately compiles all 13 affected families (new ordinary/Product vertex and HZB stages, ordinary opaque/MASK, Product and old Surface families); API errors/device loss zero. PSO compilation is not execution of the old Surface diagnostic or whole Showcase.
