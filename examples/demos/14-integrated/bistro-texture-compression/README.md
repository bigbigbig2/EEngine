# Bistro Exterior: Texture Compression

Independent EEngine demo using the current production Renderer and authored
materials. Default mode is Cooked; `?mode=raw` explicitly selects browser Raw cook. The BC encoder recipe remains
`bc7e-scalar-6-bc4-hq`; source resolution, alpha cutoff and scene geometry are
unchanged. This is a scene demo, not a formal benchmark or a renderer feature claim.

## Run

From `D:\shu\engine\examples`:

```powershell
npm run typecheck:bistro
npm run build:bistro
npm run demo:bistro -- --port 5174
```

Open `http://localhost:5174/demos/14-integrated/bistro-texture-compression/index.html`.
The examples Vite development server mounts exactly:

```text
.local/models/BistroExterior_static_fixed_occlusion.glb
  -> /assets/local-bistro/BistroExterior_static_fixed_occlusion.glb
```

The model is never copied into `examples/assets`, the build or Git. The mount is
dev-only and supports HEAD and byte ranges. A static build needs a separately
served equivalent model URL; `vite preview` does not mount the local model.

Development smoke check: append `?fixture=1` to use the existing small
fixture cooked by `offline-scene-cook.test.mjs` (two materials, including MASK).
`?fixture=1&mode=raw` uses `validation/public/assets/oengine/glb-web-product-v1.glb`. The heading and report
identify this as a fixture. It does not count as Bistro acceptance.

## Scene Controls

The canvas fills the browser viewport. A translucent white panel overlays its
right side; collapsing the panel leaves the render extent unchanged. Each effect
has a separate switch and reveals its parameters or diagnostics when enabled.
VSM, GTAO and Bloom start disabled; FSR3, camera jitter, HZB, cone culling and
orbit damping start enabled. Profiling remains opt-in.

Live controls use existing Renderer/OrbitControls APIs: render scale, jitter,
LOD SSE, sun/sky intensity, camera FOV, rotation speed and damping factor.
Disabling FSR3 restores scale 1 and disables jitter, preserving the production
equal-extent bypass. Exposure changes still require release and reload.
VSM device-negotiated atlas/page/filter settings, GTAO radius/power and Bloom
threshold/intensity are read-only, labeled fixed where appropriate; no new
shader tuning contract is introduced. GPU P50 is available only in a profiled
run, while CPU/FPS use the existing submitted-frame statistics.

Full viewport rendering increases pixel count compared with the old reserved
header/sidebar layout. The historical performance captures below used all
effects enabled and the explicitly recorded smaller render extents; they are
not measurements of these new defaults.

## Current Production Route

The latest public GLB route is `load_gltf()` -> `GlbRangeSource`/WebCook catalog
and Geometry Products -> `createWebCookSceneSourceAsync()` -> encoded
`ShadeImage`/`ShadeTexture` -> Renderer `prepareMaterialTextureProducts()` ->
`PcTexturePreparation` -> `AssetWorkerPool` -> `pc-texture-worker` -> Basis direct
BC -> schema3 `TextureProduct` -> `TextureResidency` array segments ->
`TextureBindingSet` -> TextureRef ABI3 -> `NativeMaterialBindings`/
`GpuNativeMaterialScene` -> native Visibility / SurfaceV4 / VSM.

This uses the public Product geometry route. It does not use the legacy full
ArrayBuffer `load_gltf_packed`/GeometryAssetPackage route. `GltfLoader.ts`,
`gltfTextures.ts` and `gltfMaterials.ts` remain useful importer source references,
but that parser is not the public WebCook mapper used by this demo.

Base color/emissive and specular color, when mapped, use BC7 sRGB. Normal and
multi-channel linear maps use BC7 linear; scalar maps use BC4. MASK base color
has a separate exact R8 coverage plane shared by native consumers. No RGBA
material residency, BC5 normal, Spark encoder, ASTC, ETC2 or WebGL fallback is
introduced. Whole GPUTexture allocation, initial tail upload and promotion in
ordinary Renderer frames retain their existing owners.

## Known Importer And Asset Limitations

The source has 405 images and 132 materials. The current public WebCook mapper
does not map `KHR_materials_specular` factors or textures. Its standard slots
reference 274 images; 131 specular-color images are omitted by the existing
importer. Actual Product/resident counts may be lower through content dedup and
constant-dead material samples. The demo reports source images and live Products
separately. **The requested complete 405-image validation cannot be claimed on
this importer.** No Bistro-specific material repair is performed.

Separately, `parseGltfMaterial()` supports specular factor, specular color factor,
scalar alpha/sRGB color texture slots and UV transforms, saturating factors to
`[0,1]`. The source contains values of `[2,2,2]`, metalness zero and uniform
roughness about 0.552786; original Bistro packed Specular channels were AO,
roughness and metalness. The imported GLB cannot be treated as original Bistro
material fidelity. DirectX normal Y conversion is not patched. UI states:
`Known source-material conversion limitation`.

Cooked materials use the current `parseGltfMaterial()` importer, including
`KHR_materials_specular`. Its behavior differs from the WebCook mapper described
above; the source conversion limitations remain. Every source material texture
slot is saved, including constant-dead slots. The runtime may allocate fewer
Products because its native graph removes dead samples and residency deduplicates
identities. Cooked artifact count and live GPU Product count are different metrics.

## Offline Cook

From the repository root, prerequisites are a current native geometry cooker,
a current emitted TypeScript tree and the pinned native BC encoder. The native
BC tool uses the unchanged scalar Basis C ABI, with byte parity checks against
production WASM. No texture quality or resolution setting is overridden.

```powershell
node OEngine/tools/build-native-cooker.mjs
node tools/test-build.mjs
node OEngine/tools/build-pc-texture-native.mjs
node --test OEngine/tests/contract/offline-scene-cook.test.mjs
node OEngine/tools/cook-offline-scene.mjs
node OEngine/tools/verify-offline-scene.mjs
```

The BC build expects Basis revision `99f52d63aa6799cbdaecfe977111dc5ec3b31d47`
at `.local/texture-design-basis` or `BASIS_SOURCE`. The offline PNG decoder is
`pngjs@7.0.0`, installed with
`npm install --prefix .local/offline-cook-deps pngjs@7.0.0 --no-audit --no-fund`.
PNG pixels remain straight RGBA with no gamma adjustment. The existing
`cookPcTextureRgba()` owns storage extents, full mip chains, normal resampling,
BC7/BC4 encoding and exact R8 coverage; the native executable only supplies its
existing C ABI operations. Products carry the native executable hash, not a
fabricated WASM identity.

The CLI accepts `[input.glb] [output-directory] [workers=4]`, bounded to 1..8
workers. Geometry shards target 64 MiB of decoded asset payload using the
existing native `--shard-bytes` option; the geometry recipe remains unchanged.
Defaults read the original local Bistro GLB and write only to
`.local/models/bistro-cooked/`. It writes `scene.oescene`, `.oegpack`,
`scene.materials.json`, individual `.textureproduct` archives and cook receipts.
`geometry-input.gltf` is a small derived description referencing the original
GLB buffer in place. It splits material domains into primitive assets, keeping
all vertices, triangles, instance transforms and authored material ids. Neither
the source GLB nor its PNG bytes are copied into tracked assets.

Completed archives are hash/schema/recipe checked and reused on restart.
`scene.materials.json` is published only after all textures complete. Missing or
invalid cooked data fails explicitly; Cooked never starts a Raw cook on a miss.
Runtime opens validated final blocks with `openTextureProduct()` and uses
`GeometryProductMultiRuntimeV1` / `buildVirtualGeometrySceneSourceV1()` /
`Renderer.uploadVirtualGeometryScene()`. Texture preparation finds final
Products, then ordinary TextureResidency/native publication consumes them.
Decode, encode, transcode, runtime mip generation, codec Workers and geometry
cook are all absent from this loading branch. Ordinary geometry page streaming
and texture tail/promotion retain their current production owners.

Material factors, UV transforms, samplers and final texture bindings are carried
by the material catalog. The runtime still creates native material objects with
the current importer, compiles device-specific WebGPU pipelines and uploads GPU
resources. This is not an offline GPU shader binary or pipeline cache.
Cook receipt `wallMs` is the duration of that CLI invocation, including reused
artifacts when resumed; it must not be reported as a fresh cold-cook duration.

The dev-only mount `/assets/local-bistro/cooked/` serves this ignored directory.
The runtime never fetches the original GLB in Cooked mode.

## Current Bistro Result

Complete offline cook and validation: 405 source images, 405 archives / 202
unique Product identities, 273 BC7 sRGB planes, 132 BC7 linear planes and 10 R8
coverage planes. No BC4 scalar usage exists in this imported source. Four
OEGPACK shards retain 2,829,226 triangles and 1591 instances, deduplicated into
1513 geometry assets. Geometry pack files total 186,208,720 bytes; TextureProduct
archives total 1,311,548,642 bytes (before any archive-level content dedup).

The successful cooked Chrome/WebGPU run reached first useful/full mip completion
at 26.4 seconds, using zero codec Workers and making zero source GLB requests.
Live GPU Products: 202 BC7 + 10 coverage planes, 6 segments, 1,034,645,106 live
bytes and 1,051,428,279 allocated/peak bytes. Release reached zero texture and
geometry allocations. This is software accounting, not driver VRAM.

Original single-pack admission failed on the production physical geometry heap.
The producer's existing sharding plus an explicit `HighEnd` residency request
resolved admission. The configured budget alone does not promote `auto` out of
Portable. No residency algorithm or physical bank limit was changed.

The desktop screenshot remains visibly overexposed. Source material conversion
and lighting/visual correctness are not established by resource evidence; base
color, normal detail, MASK vegetation and VSM visual acceptance remain open.
**BISTRO TEXTURE COMPRESSION DEMO = NOT PASS** until those checks are complete.

## Measurements And Lifecycle

The user-supplied baseline is **RTX 2060 8GB / Windows / Chrome WebGPU**. The
actual browser adapter identity is reported separately. Driver actual VRAM is
`UNKNOWN`; TextureResidency, GraphicsMemoryEvidence, geometry Product accounting
and ResourceAccounting are software ledgers and must not be summed blindly.

Export downloads a JSON snapshot with real source counts, per-format plane
counts, live/allocated/peak/retiring bytes, pending upload/promotion counts,
segment capacities, neutral/free layer overhead, upload counters, cold cook
wall/decode/encode timings, per-Product publication timings and failure phase.
Batch wall timings can overlap; imageReadMs is a sum of read durations, not a
single end-to-end load interval. Catalog read/parse is reported as a combined
producer timing; separate GLB-read/glTF-parse values stay unknown. Main-thread
whole-GLB ArrayBuffer/copies are avoided by the existing range route, not by a
new loader optimization. Browser/native decode peak remains unknown.

First useful time is first successful ordinary-frame GPU completion. The legacy
JSON field `fullQualityMs` records settled Geometry Product publication and all
live texture mip clamps at zero after an ordinary frame completion. The UI calls
this **Full texture mips**, not Stable: geometry page streaming continues and
visual stability is not established. CPU samples
start after 60 full-quality frames and exclude hidden-tab frames. Profiling is
off by default. The Profiled run checkbox enables the existing full GPU timing
capture; normal and profiled CPU populations stay separate. GPU numbers are
command span and Surface pass sum from complete timestamps, never RAF or queue
wait substituted for GPU time. Full captures are bounded by the existing profiler.

Release stops RAF, aborts cold work and awaits scene retirement when fully
published; its JSON result checks TextureResidency fenced zero and includes
geometry accounting. Reload uses this lifecycle before navigation. Inspect
`window.bistroDemo.report()` or `await window.bistroDemo.release()` without
introducing another telemetry owner. Failed phases remain in the report.

## Desktop Diagnostics And Current Visual Failure

The desktop overlay exposes current production knobs: VSM shadows, GTAO, FSR3,
Bloom, camera jitter, HZB/cone culling, Orbit damping and LOD SSE. Sun/sky intensity
use `PhysicalEnvironmentInput`. VSM, GTAO and Bloom now start disabled. Exposure is
immutable Renderer configuration: Apply exposure and reload releases owners and
reopens Cooked assets with `?exposure=fixed&fixedExposure=1` (or Auto). This does
not run an encoder. Pause stops frame submission; Step submits one ordinary frame.
Changing diagnostic settings resets frame measurement populations.

Available views are VisibilityKey/triangle, Meshlet ID, Material ID, reverse-Z
depth and pre-exposed HDR. HDR is after atmosphere/reconstruction, before final
exposure and display grading; direct debug presentation clips values to [0,1].
BaseColor/normal/ORM, velocity/history, SSR and separate IBL views currently lack
the required SurfaceV4 outputs in `FrameProgramLowering`. They are not enabled
merely because the historical debug descriptor labels them supported.

The default frame includes native material/physical sun, sky diffuse/specular
IBL, physical sky, aerial perspective, FSR3, GPU auto exposure and SDR display
grading. VSM, GTAO and Bloom are enabled with their switches. There are no authored
lamps/HDR in this model. SSR and screen-space GI are not wired into this Frame
Program. A listed Frame stage may
remain as a copy/disabled stage; Active effects reports the actual control state.

2026-10-09 targeted Cooked Bistro diagnosis on the same NVIDIA Turing/WebGPU
machine reproduced two separate issues. These are diagnostic comparisons, not
formal performance or visual acceptance evidence:

- At a fixed overview camera, resident geometry stayed at 1822 pages (1306
  pinned), 972,816,384 physical bytes with no evictions, while Auto exposure
  screenshots changed broadly in brightness. Fixed exposure 1 greatly reduced
  the global variation but remained dark. This implicates the radiometry path;
  its exact adaptation/temporal root cause is still unresolved.
- At a fixed closer camera, physical geometry residency approached the 1 GiB
  shared heap. Evictions/reloads continued after disabling FSR3, jitter,
  HZB/cone culling, VSM, GTAO and Bloom. In one Auto sample, 1.5 seconds changed
  evictions 1205 -> 1275 and reloads 512 -> 581. Fixed exposure still reproduced
  the geometry churn. Offlining the cook does not remove runtime page residency.
- The existing geometry cook records 6085 decoded 256 KiB pages, mean fill
  15.89%, 1,341,656,608 padding bytes, 1306 bootstrap pages and 2101
  simplification fallback groups. Runtime attribute expansion also occupies
  physical slots. These contribute to working-set pressure; the model is not
  missing source triangles and this is not proof that driver VRAM is exhausted.
- Both Cooked diagnostic runs used zero Workers, retained 202 live BC7 Products
  plus 10 exact R8 planes, and reported no WebGPU/page errors. Texture and
  geometry accounting returned to zero on release. These facts do not excuse
  the visible lighting/geometry instability.

The sidebar/export includes all registered Products' geometry residency, pending
IO, per-refresh upload/eviction/reload deltas, thrash bytes, errors, camera clip
planes, actual effect flags and Frame Program stages. A quiet half-second is
only a page-activity observation, never a visual-stability claim. Geometry heap /
page packing / LOD demand belong to geometry residency; metering/adaptation and
history belong to radiometry/temporal. This diagnostic addition does not change
those architectures or patch Bistro materials. BC compression quality, exact
coverage and the full scene remain unchanged. Visual acceptance remains NOT PASS.

## Geometry Residency Fix (2026-10-09)

Main and VSM traversal now report resident page usage through the same delayed
queue as missing-page requests. Usage records update last-used frames without
source IO. Eviction uses complete feedback frame indices instead of a newer
GPU-completion clock; overflow/malformed feedback cannot authorize eviction.
The upload-frame eviction allowance is shared across all Product shards.

Runtime Geometry GPU ABI 4 keeps the 16-byte page location, packing a 16-byte
aligned attribute-directory offset into location word 3. CPU publication and both
WGSL lookup readers use this offset. Raw payload, directory and expanded attributes
can share the existing 256 KiB slot when they fit; overflow still reserves complete
additional slots from the same pool. Payload is uploaded before tail contents,
then the page location is published. All slots retire under the original fence.
OEGPACK files, geometry quality, textures and the 1 GiB configured heap are unchanged.

Cost card: traversal remains 64 lanes. Each accepted resident group adds the
existing bit-mask atomic path, deduplicating to at most one 16-byte record per page
per view/frame; repeated instances contend on the existing page mask. Scratch,
ring sizes, dispatches, bindings, submits and texture samples do not increase.
Worst-case feedback overflow postpones eviction, retaining complete coarse coverage.
Small pages save one 256 KiB slot; pages whose attributes fill the raw tail may
still need additional slots. If 0/50/100% of pages fit their complete directory
and attributes in the raw slot, savings average 0/128/256 KiB per page. WGSL lookup adds a mask and address addition, with no new
memory fetch. Raw uploads now transfer validated payload rather than page padding;
source integrity still verifies the complete original page. This addresses capacity
waste, not driver VRAM measurement or a claim of improved frame performance.

Reference: the existing Nyx revision and MIT source map in
`docs/porting/next-renderer.md` applies. `DAGCull.slang::ProcessNodeBatch` records
accepted groups before residency testing; `GeometryStreaming.cpp::Update` refreshes
last-use for resident requests and loads only misses. EEngine reuses its delayed
WebGPU queue and retains exact Product identity and fenced retirement. Tail packing
and the ABI offset are local engineering changes, not a new donor algorithm.

Verification: engine/demo typecheck, demo build, 60 focused contract/unit/source
checks, five existing appearance lifecycle tests, and the real GPU
`geometry-budgeted-residency` oracle passed. The GPU oracle now checks nonzero
directory offsets at physical bank boundaries, fixed-view convergence, switched
view pressure eviction, resident VSM usage, coarse coverage, abort/retry and loss.
Its first run exposed missing shadow tagging on usage records; this was corrected
before the successful run. Final targeted tests additionally cover a dropped
shadow readback while its ring is full. `docs-verify` still fails on the untouched
`docs/status.generated.md` missing frontmatter; the modified source-map document
has no reported finding.

One complete Cooked Bistro run used the original 405 archives, full scene and
fixed exposure 1, with zero Workers/errors. At the same overview, 1822 pages now
occupy 509,083,648 bytes (485.5 MiB), compared with the earlier 972,816,384 bytes
(927.75 MiB). After the same 30 zoom steps, 2741 pages occupy 837,025,792 bytes
(798.25 MiB). Both 15-second near samples retained exactly the same residency,
upload bytes, zero evictions, zero reloads and zero thrash bytes. The 1 GiB heap
allocation and 128 MiB metadata allocation remain preallocated; occupied slots
are not driver VRAM. Texture live remains 1,034,645,106 bytes with the same BC7/R8
planes and no RGBA residency. Release returned both geometry and texture owners
to zero.

Default temporal near screenshots still change about 1.46% of scene pixels
over 15 seconds (channel threshold 12). With jitter/FSR3/HZB/cone disabled for
isolation, only 8 scene pixels change; Material ID changes zero scene pixels
over 10 seconds. These comparisons exclude the bottom elapsed-time banner and
do not disable VSM/GTAO/Bloom. Defaults in the demo are unchanged. The fixed
exposure image remains dark; Auto adaptation and temporal differences are
separate unresolved findings. This closes the reproduced page-unload flicker,
not overall visual acceptance or every possible camera working set.

Normal near CPU encode samples: P50 3.775 ms, P95 6.175 ms (600 samples, profiling
off). GPU/Surface timings were not measured. First useful/all texture mips ready
were 29.567/29.568 s; this is Cooked loading, not Raw preparation or complete
geometry residency. Local artifacts: `.local/bistro-texture-compression/` contains
`residency-fix-bistro-result.json`, screenshots and `gpu-residency-final.json`.
The final dropped-shadow safeguard was checked with focused CPU/GPU tests after
this Bistro run; the complete asset was not loaded again for that guard.

## Camera Motion And Submission Measurement (2026-10-09)

The demo measures **submitted FPS**, not RAF callbacks or presented frames.
`Renderer.render()` still returns device health when a tick is deferred. The
demo therefore checks `frame_count` advancement, counts unsubmitted callbacks
separately, and includes their gaps in submission intervals. CPU P50/P95 covers
controls, camera update and `render()` on submitted callbacks only; it does not
measure total browser CPU use. Normal and profiled samples are separate, with
60 submitted warmup frames after full texture mips or a sample reset. Pause/Step
consumes a step only when submission occurs.

`FrameCoordinator.evidence()` records submission-to-observed-completion latency
using the existing command fence. It includes queue waiting, GPU work, browser
delivery and CPU scheduling, so it is **not GPU timestamp duration or display
latency**. In-flight capacity stays at two; neither profiling nor the evidence
API adds a frame submission. Presented FPS and driver actual VRAM stay UNKNOWN.

Two camera-motion bugs invalidated temporal history: incrementing camera
identity on every VP change, and treating an absolute VP element delta > 0.25
as a cut. The latter is world-scale dependent. These triggered repeated FSR3
history allocation, with generation reaching 372 in an earlier diagnostic.
Ordinary motion now retains history for reprojection. Changing the camera object
still resets the temporal domain. Same-camera teleports/cuts must call
`invalidateTemporalHistory()`; Frame scene already does. Explicit reset also
reaches VSM invalidation on the next successful submission, and abort retains
that pending reset. HZB still fails open during camera motion.

The two expensive passes were Luma Instability and Accumulate. Local diagnostic
shader rewrites produced bit-identical small-oracle results but no useful Bistro
speedup, so production shaders and FSR3 quality settings were preserved. The
implemented fix addresses their history lifetime, not their algorithm.

The 8 GB Bistro host now explicitly requests **4 x 384 MiB = 1536 MiB** geometry
capacity. `?geometryMiB=1024` selects the previous budget; accepted values are
128..2048 MiB. Device limits and the runtime address namespace still cap actual
allocation. Other hosts keep their existing default profile ceilings. Runtime
GPU ABI 5 expands the address namespace to 2048 slots per bank, with matching
CPU encoding and generated WGSL decoding; older GPU headers are rejected. The
four bindings, record strides and offline Product/page bytes are unchanged.
This requires no asset recook. The fixture defaults to 128 MiB.

### Cost Card

- Statistics: at most 600 callback/completion samples per owner, bounded CPU
  collection and snapshot copies; no shader work, readback, new fence or submit.
- Temporal fix: removes repeated allocation/retirement during ordinary motion.
  Passes, sample counts and reprojection math stay unchanged. At zero camera
  motion there is no expected GPU improvement from this fix.
- Bistro capacity: reserves an additional 512 MiB, with unchanged shader ALU,
  binding and dispatch counts. Below the old working-set ceiling this extra
  capacity gives no benefit. Above it, pages can remain resident and avoid
  eviction/refetch. A working set exceeding the new ceiling may still churn;
  this is a capacity choice for this host, not a geometry compression claim.

### Actual Cooked Desktop Check

Hardware: Windows, NVIDIA **RTX 2060 SUPER 8192 MiB** (local hardware query),
Chrome/WebGPU, adapter identity `nvidia/turing`; browser device/description and
driver version were not exposed. The requested RTX 2060 8 GB baseline is retained
as the host target. These numbers are not GTX 1650 Ti results.

One page, all effects enabled (the defaults at capture time), SSE 4 and resolution
scale 1, with a repeatable near-camera orbit at 0.35 rad/s. Each capture lasted 10 seconds with
warmup excluded. Window dimensions include the sidebar/header; actual render
outputs were 1540x1010 and 2180x1370. The intermediate run had already removed
the camera-revision bug and allocated 1.5 GiB, but still had the VP cut heuristic.
It is retained to isolate the final correction; it is not the original HEAD.

| Moving capture | Intermediate submitted FPS | Final submitted FPS | Final CPU P50/P95 ms | Final completion P50/P95 ms |
| --- | ---: | ---: | ---: | ---: |
| 1920x1080 window, normal | 50.83 | 55.23 | 4.93 / 6.88 | 18.36 / 30.96 |
| 2560x1440 window, normal | 32.91 | 51.60 | 5.37 / 7.54 | 22.28 / 45.11 |
| 1920x1080 window, profiled | 49.63 | 56.00 | 5.48 / 7.75 | 17.87 / 30.34 |
| 2560x1440 window, profiled | 36.59 | 56.31 | 4.70 / 7.02 | 20.29 / 32.38 |

| Final profiled capture | GPU command span P50/P95 ms | Surface sum P50/P95 ms | FSR3 pass sum P50/P95 ms | Luma Instability P50/P95 ms | Accumulate P50/P95 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1540x1010 output | 8.47 / 9.61 | 2.37 / 3.15 | 1.29 / 1.77 | 0.067 / 0.068 | 0.477 / 0.740 |
| 2180x1370 output | 13.00 / 14.31 | 4.26 / 5.16 | 2.37 / 2.68 | 0.120 / 0.124 | 0.926 / 0.940 |

For the larger intermediate profiled capture, FSR3 P95 was 14.97 ms, Luma
Instability 6.05 ms and Accumulate 6.30 ms. Final ordinary-motion generation
deltas were zero in every capture. Resize advanced generation 1 -> 2, and the
explicit reset check advanced it 2 -> 3. Static final normal submission rates
were 57.00 and 54.66 FPS. Normal/profiling differences include residency warmup
and browser scheduling; they do not demonstrate that profiling makes rendering
faster. No sustained-60-FPS claim is made.

Queue backpressure remains measurable: the two final normal moving windows had
36 and 65 completion deferrals over the full captures, zero history-retirement
deferrals. In the warmed callback windows, 32/530 and 58/519 callbacks were not
submitted. GPU timestamps exclude queue waiting/browser delivery, and a 13 ms
GPU span does not imply a sub-16.67 ms observed completion. The larger normal
completion P95 exceeded two 60 Hz callback intervals. Increasing the in-flight
limit would add latency and retained resources; this check leaves that limit
unchanged. The geometry demand readback ring also skipped 435 reservations over
the run while busy; demand overflow remained zero. That counter is not VRAM
exhaustion and needs separate scheduling investigation if it delays refinement.

Final geometric residency was 1087.25 MiB inside the actual 1536 MiB heap;
evictions/reloads were zero throughout motion and after stopping. Texture live
remained 986.71 MiB, allocated/peak 1002.72 MiB: 202 BC7 Products, 10 exact R8
coverage planes, zero BC4, six segments, zero RGBA fallback/codec Workers.
First useful/full texture mips were 41.998/41.998 s in this load; original GLB
read and Raw cook were not performed. Release returned both texture and geometry
accounting to zero. Existing importer/material appearance limitations remain.

Validation: engine/demo typecheck, demo build, fresh `build:test`, 87 targeted
contracts, small desktop controls/step/reload/release smoke, expanded-slot WGSL
GPU oracle (1024, 1535, 2047 plus physical-boundary rejection), and the complete
Cooked captures. The global docs verifier still reports the pre-existing missing
frontmatter in `docs/status.generated.md`; the touched specs have no findings.
Local diagnostic artifacts are in `.local/bistro-texture-compression/`:
`motion-partial-fix-result.json`, `motion-fix-result.json`,
`expanded-bank-gpu-result.json`, and `motion-fix-desktop.png`.

## Production temporal input correction (2026-10-09)

This change was developed against HEAD `b5007067`, using the current production
Renderer and the existing Cooked Bistro assets. It does not change exposure,
lighting, RCAS sharpness, texture quality, alpha cutoff or the FSR3 Accumulate
formula. The following are source-confirmed defects:

- Primitive, meshlet and LOD winners entered the geometry identity hash. Their
  changes became reactive=1, then dilated shading change, suppressing accumulation.
- A fixed reverse-Z depth cutoff of 0.0001 invalidated genuine distant geometry.
  Infinite reverse-Z geometry now accepts positive depth; empty sky is depth=0.
- Raster jitter had half the requested displacement, used viewport dimensions
  before they were updated, and cycled 16 phases while FSR3 used 8 at 1x.
- Output/backing resolution used CSS dimensions without DPR.
- MASK interiors had a permanent reactive penalty; native RGB samplers had no
  anisotropy. Existing temporal debug views also consumed retired metadata and
  divided UV motion by dimensions a second time.

### Files and ownership

Paths below are relative to `OEngine/src/`, unless otherwise specified.

| File | Change and reason |
| --- | --- |
| `shaders/native_surface_aux.ts` | Stable resource identity; local hard replacement separated from soft reactive; positive reverse-Z validity; bounded actual MASK coverage edge hint. |
| `shaders/native_surface.ts` | Publishes MASK status to the existing temporal aux product. |
| `render/surface/NativeSurfaceAux.ts` | CPU mask semantics match the production hard/soft distinction. |
| `render/temporal/NativeTemporalFactsPass.ts` | Documents the actual motion and mask contract; keeps transactional identity ownership. |
| `render/passes/fsr3/Fsr3PrepareReactivityPass.ts` | Consumes local validity/replacement as disocclusion; guards zero-motion division. |
| `render/passes/fsr3/Fsr3UpscalerRuntime.ts` | Uses direct raster pixel jitter and shared SDK phase count; supplies the validity input and read-only jitter evidence. |
| `render/TemporalJitterController.ts`, `render/TemporalFabric.ts` | One production Halton phase rule derived from actual internal/output widths. |
| `render/ViewContext.ts` | Converts raster pixel offsets to the actual camera projection convention. |
| `render/pipeline/RendererCore.ts` | Sets viewport before jitter; separates CSS/DPR/output/internal extents; supports DPR override/recovery and read-only evidence. |
| `gpu/NativeMaterialBindings.ts` | Linear mipmapped RGB gets 8x anisotropy; exact coverage and nearest remain 1x; resource keys include anisotropy. |
| `shaders/hierarchy_lod.ts` | Shared conservative SSE camera anchor and its 32-byte ABI. |
| `shaders/hierarchical_work_generation.ts`, `shaders/virtual_geometry_work.ts` | Root publishes anchors; traversal and coarse meshlet gate use the same stable SSE. |
| `render/HierarchicalWorkGenerator.ts` | Owns current/committed anchors, resource limits, same-encoder copy, accounting and retirement. |
| `render/MeshletWorkCandidate.ts`, `render/passes/PackedVisibilityPass.ts`, `render/ShadowGeometryWork.ts` | Close the new binding through every direct consumer. Shadow stability is disabled and its existing SSE semantics are retained. |
| `render/passes/RenderDebugViewPass.ts`, `render/program/FrameProgramLowering.ts`, `shaders/render_debug_view.ts`, `debug/RenderDebugView.ts` | Existing temporal diagnostic views now read native motion/mask products. |
| This demo's `main.ts`, `index.html` | Show jitter/resolution evidence and expose motion, validity/replacement and soft-reactive views. |
| `OEngine/tests/contract/{temporal-input-contract,fsr3-frame-lifetime,native-surface-aux}.test.mjs` | Numeric projection/DPR/phase checks and hard/soft/abort lifecycle semantics. |
| `OEngine/tests/oracle/temporal-input-contract-gpu.mjs`, `tools/gpu-oracle/registry.mjs` | Real production GPU input and conservative LOD semantic checks. |
| `OEngine/tests/oracle/{geometry-budgeted-residency,geometry-product-scale,virtual-geometry-handoff}-gpu.mjs` | Supply the new production anchor binding in existing independent geometry checks. |

### Final data contract

| Product | Space / units / domain | History and validity |
| --- | --- | --- |
| Jitter | Halton(2,3)-0.5; actual top-left raster pixels at internal resolution. Phase count is `trunc(8*(outputWidth/internalWidth)^2)`. | Fabric selects the submitted frame's sample. Runtime retains only committed previous jitter; abort restores it. |
| Camera / Visibility / Surface | Current VP has current jitter; previous VP has the last submitted jitter. `P[8] -= 2*Jx/W`, `P[9] += 2*Jy/H` produce raster displacement `(Jx,Jy)`. | View copies camera state in the ordinary frame encoder. Hierarchy frustum/SSE uses the unjittered camera. |
| Native motion | RG32 float, internal pixels storing **current-minus-previous top-left UV**, including both jitters. Sky uses rotation without translation. | Invalid projection, motion state, bounds, publication or global reset clears mask.G. |
| Identity | RGBA32 uint: instance slot, resource/topology generation signature, material signature, material slot. | Same-instance geometry replacement and same-slot material publication replacement set B. Triangle/meshlet/LOD/winner variation does not. Scene/camera replacement remains owned by global history invalidation. |
| Native mask | RGBA8: R soft reactive; G valid motion; B local hard replacement; A diagnostic bits. | MASK interiors have R=0. Actual coverage/winner edges have a bounded 0.1 hint (0.098 after quantization). |
| FSR Prepare Inputs | Negates Native motion, then subtracts `(previousJ-currentJ)/internalSize`; result is **previous-minus-current UV without jitter**. | Selects/dilates nearest reverse-Z depth and motion, reconstructs previous depth in the existing frame. |
| FSR Reactivity | Depth disocclusion plus local invalid/replacement; soft R still follows SDK dilation/shading-change rules. | Hard invalidation no longer becomes dilated shading change. Zero velocity cannot form 0/0. |
| Luma Instability / Accumulate / RCAS | Existing SDK translation; internal evidence reconstructs output-domain radiance. | Accumulate equations and RCAS settings retained. Ordinary camera movement does not reset history. |
| Present | Physical output = rounded CSS size * DPR; internal = floored output * renderScale. | Output/format/scene/device/explicit resets retain existing ownership; internal-size changes invalidate internal identity while output color can survive supported resize. |

### LOD stability and cost card

Previously traversal and coarse handoff used the current camera position with a
single hard SSE boundary. The main perspective view now freezes one camera
anchor per instance until translation exceeds 5% of its nearest enclosing-sphere
distance (clamped by near). Projection/SSE/height/near and instance/resource/
transform revisions reset the anchor. Orthographic and shadow views retain their
existing decision. This is a stable SSE band, not per-cluster hysteresis.

Both consumers use `max(distance(anchor,cluster)-radius-anchorBudget,near)`.
Subtracting the complete allowed translation bounds the true SSE by triangle
inequality, including loose cluster spheres. Thus the choice is conservatively
finer, with the same complementary refine `>` / keep `<=` threshold and complete
coarse fallback while refinement pages are absent. Small rotation already leaves
radial SSE unchanged. This mechanism does not provide geomorph or remove page
arrival popping after larger movements.

| Mechanism | Additional or removed cost | Expected / worst behavior |
| --- | --- | --- |
| LOD anchor | 64 bytes/instance persistent for current+committed; 32 bytes/instance same-encoder copy/frame. Root reads/writes one record and computes a small revision hash and distances. Traversal/coarse gate reads one 32-byte record and subtracts the budget. No new dispatch, atomics or CPU readback. | Fixed tax at 0/50/100% stabilization benefit. Instance-scoped memory, including ordinary retirement of replaced worksets. Conservative refinement can increase geometry work; no FPS improvement or measured break-even is claimed. |
| Temporal identity | Removes primitive mapping/hash inputs; existing identity/mask allocations remain unchanged. | No new full-screen pass. Resource replacement still rejects locally. |
| MASK edge hint | Four neighbor Visibility uint reads (16 bytes) only on MASK pixels; 0–4 bounded meshlet records when a neighbor resolves to a different work slot. No extra R8 sample. | Interior can accumulate; complicated coverage gets a bounded hint rather than permanent rejection. No measured GPU cost claim. |
| Local hard invalid | One extra existing-mask load in Reactivity and one texture binding. | No extra allocation/pass. SDK accumulation equations remain unchanged. |
| Anisotropy | Hardware anisotropic RGB filtering up to 8x, no additional GPUTexture storage. Nearest/coverage remain 1x. | Oblique sampling may cost more; hardware fetch count is not assumed to equal eight shader samples. |
| DPR | Native physical output; pixel work grows approximately with DPR squared. | Prevents compositor enlargement; higher physical resolution can reduce FPS. Quality is not silently capped. |

### Actual validation

Engine typecheck, fresh `build:test`, Bistro typecheck/build and 25 targeted
contract tests passed. Real GPU checks passed: temporal input contract, native
Surface integration, geometry Product scale (18 cases) and meshlet handoff
(50 cases). Handoff's first run retained a fixture anchor at the near camera
while testing far mode; supplying the actual case's root-produced anchor fixed
the fixture without changing its independent expected counts. Both failures
and successful results are retained locally.

The full Cooked Bistro ran on NVIDIA/Turing, Chrome 154 WebGPU, using the
RTX 2060 8GB baseline. The first capture exposed the distant reverse-Z validity
bug; it was retained and followed by a targeted repair and one corrected full
load. Static windows warmed 60 submitted frames; controlled slow rotation ran
60 steps. Sparse probes sampled a 64x36 grid, **not every pixel**:

| View / SSE | Static visible probes / mean accumulation | Slow visible probes / mean accumulation |
| --- | --- | --- |
| Far / 4 | 117 / 0.9947 | 124 / 0.9959 |
| Far / 2 | 126 / 0.9963 | 128 / 0.9948 |
| Far / 1 | 128 / 0.9953 | 124 / 0.9956 |
| Near / 1 | 905 / 0.9970 | 918 / 0.9975 |

All these visible probes had zero invalid motion, hard rejection and zero
accumulation. Slow movement retained each capture's FSR history generation.
The actual damped OrbitControls fixture also retained history. GPU semantic
checks independently verified primitive/meshlet/LOD changes, MASK interior/edge,
true replacement, invalid motion, far depth and jitter cancellation. The LOD
probe crossed ordinary SSE=4 while stable SSE stayed identical within the anchor
band. Roof/window edge screenshots show spatial smoothing; bypass/on brightness
differs in the existing radiometry path, so this is not a clean photometric A/B
or complete visual acceptance.

Real browser contexts at DPR 1/1.25/1.5/2, CSS 800x600, produced backing/output
800x600 / 1000x750 / 1200x900 / 1600x1200. Resize and renderScale=0.75 also matched
output/internal dimensions. Actual projection displacement matched FSR pixel
jitter within approximately 2e-8 pixels. Normal runtime does no diagnostic GPU
readback; the sparse capture was injected only by a local test script.

No Bistro GPU/page errors were recorded; Release returned texture and geometry
owner allocation to zero. Geometry at SSE=1 still had 1077 pending reads with
maxConcurrentReads=1, despite zero evictions/reloads. Finer pages arriving can
therefore still change a fixed-camera silhouette. Full texture mips are not
proof that all geometric refinements are resident. Streaming scheduling and
page-arrival transitions remain unresolved temporal stability limits.

Local evidence is under `.local/bistro-texture-compression/`: `aa-browser-result.json`,
`aa-before-far-depth.json` (also contains the DPR checks), `aa-temporal-oracle.json`,
`aa-native-integration.json`, `aa-geometry-scale.json`, `aa-geometry-handoff.json`,
`aa-geometry-handoff-initial-failure.json`, `aa-debug-result.json` and screenshots.

Source map: existing FidelityFX SDK 1.1.4, MIT, pinned
`c6efa6bf7f2027b3ec94f28578bb5965eabb9e55`. Jitter phases/cancellation were checked
against `tools/fsr3-port/upstream/sdk/src/components/fsr3upscaler/ffx_fsr3upscaler.cpp`
and the pixel/projection contract in `sdk/include/FidelityFX/host/ffx_fsr3upscaler.h`.
The existing accumulation/shading-change formula was checked against
`sdk/include/FidelityFX/gpu/fsr3upscaler/ffx_fsr3upscaler_prepare_reactivity.h`.
Projection signs and input masks are EEngine adaptations; the conservative
instance anchor is an original local mechanism. `tools/fsr3-port/validate.mjs`
still fails on 15 existing vendored license/build/Vulkan-wrapper digests; the
algorithm/host files used here were not among those mismatches. This change does
not update the manifest or claim complete source-package provenance validation.

## Explicit Scope

| Capability                   | Status            |
| ---------------------------- | ----------------- |
| Virtual Texture              | NOT IMPLEMENTED   |
| Texture Page Table           | NOT IMPLEMENTED   |
| GPU Texture Feedback         | NOT IMPLEMENTED   |
| Physical Texture Page Cache  | NOT IMPLEMENTED   |
| Mip/Page Eviction            | NOT IMPLEMENTED   |
| BC5 Normal                   | NOT IMPLEMENTED   |
| BC6H Environment             | NOT IMPLEMENTED   |
| Spark GPU Production Encoder | DEFERRED          |
| ASTC production fallback     | NOT TARGET        |
| ETC2 production fallback     | NOT TARGET        |
| RGBA material fallback       | REMOVED BY DESIGN |
| Full BLEND transparency path | NOT COMPLETE      |

Runtime status and full acceptance are distinct. Until complete source-image
consumption, visual texture/MASK/VSM checks and lifecycle results are recorded,
`BISTRO TEXTURE COMPRESSION DEMO = PASS` is not claimed.
