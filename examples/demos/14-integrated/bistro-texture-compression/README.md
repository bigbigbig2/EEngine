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

The desktop sidebar exposes current production knobs: VSM shadows, GTAO, FSR3,
Bloom, camera jitter, HZB/cone culling, Orbit damping and LOD SSE. Sun/sky intensity
use `PhysicalEnvironmentInput`. Defaults preserve the original run. Exposure is
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

The current frame includes native material/physical sun, sky diffuse/specular
IBL, physical sky, aerial perspective, VSM, GTAO, FSR3, GPU auto exposure, Bloom
and SDR display grading. There are no authored lamps/HDR in this model. SSR and
screen-space GI are not wired into this Frame Program. A listed Frame stage may
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
