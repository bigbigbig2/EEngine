# OEngine Web Geometry Cooker

Current artifacts (2026-10-10 / VSM V4-R1): native, portable-single and pthread
producers use input ABI 4, `static-pbr-page-local-f32-lean-v7` and hierarchy
recipe `nyx-hierarchy-v4.1-conservative-spheres`. Sphere merge recomputes the
required radius about the stored f32 center and rounds outward; the independent
translated-hierarchy oracle tests strict double containment. This changes
content/recipe identity, not page layout. Existing Products need recooking.
The canonical recipe now includes `instanceSemantics: cast-receive-explicit-v1`.
Native glTF node extras and public Scene/WASM producers preserve explicit
cast/receive off, with both enabled by default. Legacy scene manifests without
this policy are rejected and require recooking; zero flags are never inferred.
Runtime
Groups contain page-local local indices and authored vertices, without the
retired 64-byte/triangle continuity payload (bits 6/7). Obsolete artifacts and
Products require recooking; no compatibility decoder is provided. Cook-only
seam/domain/lineage/error mathematics remains, as do float32 positions and
normal/tangent/UV/color precision. Payload acceptance uses actual lean bytes.

`node tools/test-web-cooker-threads.mjs` (after fresh build:test) compares real
Chrome Worker portable-single and pthread 1/4-concurrency output, section/page
by section/page. The G2.2 four-domain 73,728-source-triangle fixture passed.
This does not establish the application Dedicated Worker startup/profile or
large-scene performance acceptance. Git preserves the old artifact records.

The pinned meshoptimizer revision remains unchanged. The 22 hash entries in
source.json and verify.cmake were corrected after byte-for-byte comparison
against that revision; no vendored algorithm source was changed.

Browser-first `portable-single` Nyx geometry producer. It accepts the canonical binary input from `WebGeometryCookerAbiV1`, runs the full meshlet/Group/simplification/refine/hierarchy/page pipeline in WASM, and exposes decoded Geometry Product sections. It has no filesystem, cgltf, LZ4, WebGPU, OEGPACK writer, or Native CLI dependency.

Build with an activated Emscripten SDK:

```powershell
emcmake cmake -S tools/oengine-web-geometry-cooker -B tools/oengine-web-geometry-cooker/build-wasm -G Ninja -DCMAKE_BUILD_TYPE=Release
cmake --build tools/oengine-web-geometry-cooker/build-wasm
```

`OENGINE_WEB_COOK_INITIAL_MEMORY_MB` and `OENGINE_WEB_COOK_MAXIMUM_MEMORY_MB` are build-time ceilings. A CookSession must impose a smaller per-session WASM/output budget through the ABI; the module ceiling is not admission credit.

The native oracle uses the same sources and ABI without emulating a file workflow:

```powershell
npm run test:web-geometry-cooker-core
```

That oracle proves producer ABI, Nyx algorithm execution, negative validation and determinism. It does not replace an actual Emscripten build or Dedicated Worker/browser evidence.

The checked-in browser artifact under `src/assets/web-cook/wasm/vendor/` was
built with Emscripten SDK 6.0.9 (release `f04ea239d533260dd1db760dd2d668d5f9a88d6b`)
using the command above and the pinned Nyx hashes enforced by CMake. The current
artifact carries the ADR-0017 two-phase ABI, the ADR-0018 Phase B incremental
canonical-window builder, and the Phase D optional spill-release hook
(`abi_version == 4`):

```text
oengine-web-geometry-cooker.mjs   SHA-256 1479ec4f16200e4cdbe94e65295b6198f41b6c0d061d90fbe922df87ea1e4156
oengine-web-geometry-cooker.wasm  SHA-256 a3d7d8082f420d627a173d20f3df4f4974ed64f9f322317e392bae9eb4a73a0f
```

The cooker emits one Product asset per canonical material domain, so a
multi-mesh GLB keeps independently addressable primitives. Rebuild the artifact
and refresh both hashes whenever the C++ sources change.

The Phase D source and checked-in browser pair expose the optional
`oengine_web_geometry_cook_release_page` spill hook. It releases a successfully
spilled page's decoded buffer and serialized Groups while preserving descriptor
identity. An ABI-4 artifact without the optional symbol retains plan memory until
handle release; this optional lifetime hook is not an old-ABI compatibility
decoder. Earlier input ABI versions are rejected and require recooking.

### `isolated-pthreads` specialization (experimental)

The same sources build a pthread specialization used by the
`isolated-pthreads` runtime profile behind cross-origin isolation:

```powershell
emcmake cmake -S tools/oengine-web-geometry-cooker -B tools/oengine-web-geometry-cooker/build-wasm-threads -G Ninja -DCMAKE_BUILD_TYPE=Release -DOENGINE_WEB_COOK_THREADS=ON
cmake --build tools/oengine-web-geometry-cooker/build-wasm-threads
# copy to src/assets/web-cook/wasm/vendor/threads/
```

The per-domain cook loop is parallelized with the same bounded batching as the
native writer. The runtime profile is opt-in (`?profile=isolated-pthreads`) and
has G2.2 isolated browser artifact determinism evidence; application
Dedicated Worker initialization remains a separate acceptance responsibility.

This specialization ships its own pair of artifacts and must be rebuilt
whenever the C++ sources change, exactly like the single-threaded pair above.
The current artifact carries the same ADR-0017/ADR-0018 Phase B ABI
(`abi_version == 4`):

```text
threads/oengine-web-geometry-cooker.mjs   SHA-256 02daaae63b8af3c19141e1152a1fb2e364c2fc26ee6b8f6c9f0028bb4a2408fb
threads/oengine-web-geometry-cooker.wasm  SHA-256 c507bbccf7fab7a6b2419057d9882462fc6be5b9b7c7fc04f402fbbae9590ac6
```

2026-09-29: both artifacts rebuilt for nyx-hierarchy-v3.1 and
static-pbr-page-local-f32-v4. VertexFormat byte 10 is now 1 (Float32x3);
meshlet-local U16 products must be recooked. Native ABI oracle includes exact
shared-position bits and terminal LOD error after a rejected simplification.

2026-09-29 historical experiment: v3.2 rejected sloppy for entire seam-bearing groups. It retained excessive fine geometry and is no longer current behavior.

Historical 2026-09-30 record before the Surface phase-one rebuild: experimental nyx-hierarchy-v3.3 artifact pairs. The Nyx 0.25 sloppy extension carries source triangle-corner attributes separately from clustered positions, compacts coarse wedges and preserves fine vertices. Prior builds and targeted geometry tests passed, but same-close-camera barrel artifacts remain. This is not visual/performance acceptance or a meshoptimizer v1.3 port. The candidate is described in docs/next-design/virtual-geometry-attribute-simplification-2026.md and docs/porting/next-renderer.md. Always copy WASM with matching .mjs; recipe changes require recooking old products.
