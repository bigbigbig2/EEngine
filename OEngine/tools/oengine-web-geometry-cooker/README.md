# OEngine Web Geometry Cooker

Current artifacts (2026-09-30): both specializations rebuilt from the shared
GeometryCooker for Surface phase one. Canonical/recipe input ABI is version 3;
the recipe profile is static-pbr-page-local-f32-surface-v5 with the existing
nyx-hierarchy-v4.0-attribute-update algorithm. Groups carry flag bit 6 and
32-byte primitive continuity/variation records between triangle and vertex
regions. Group partitioning respects the complete 256 KiB payload and 128
meshlet limits. Old recipe products require recooking; there is no second
production geometry decoder. Updated LOD corners with no unambiguous source
mapping reject sharing. This rebuild does not establish VG visual acceptance.

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
(`abi_version == 3`):

```text
oengine-web-geometry-cooker.mjs   SHA-256 1e6c227c9d10439f0e4b9c75de7a0c84ef74ff47820b8dc4c857de73fb1d1efb
oengine-web-geometry-cooker.wasm  SHA-256 7040e0b04d149a3cb1428958643f6e1e451b1293cfae54791d20bb6dbdda8297
```

The cooker emits one Product asset per canonical material domain, so a
multi-mesh GLB keeps independently addressable primitives. Rebuild the artifact
and refresh both hashes whenever the C++ sources change.

The Phase D source and checked-in browser pair expose the optional
`oengine_web_geometry_cook_release_page` spill hook. It releases a successfully
spilled page's decoded buffer and serialized Groups while preserving descriptor
identity. ABI-v3 artifacts without the optional symbol retain plan memory through the
TypeScript fallback. ABI-v2 artifacts are not the current canonical producer.

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
still requires browser validation: the Emscripten pthread module does not
yet finish pool initialization inside the app's Dedicated Worker.

This specialization ships its own pair of artifacts and must be rebuilt
whenever the C++ sources change, exactly like the single-threaded pair above.
The current artifact carries the same ADR-0017/ADR-0018 Phase B ABI
(`abi_version == 3`):

```text
threads/oengine-web-geometry-cooker.mjs   SHA-256 39089cb83a1ffd89db8f0f6748465566b5f0a78700b4bc296d28ddfd73771514
threads/oengine-web-geometry-cooker.wasm  SHA-256 198faaa1f426909524c019015418a292977bd32bb2fd415d0429fbaafbf043bd
```

2026-09-29: both artifacts rebuilt for nyx-hierarchy-v3.1 and
static-pbr-page-local-f32-v4. VertexFormat byte 10 is now 1 (Float32x3);
meshlet-local U16 products must be recooked. Native ABI oracle includes exact
shared-position bits and terminal LOD error after a rejected simplification.

2026-09-29 historical experiment: v3.2 rejected sloppy for entire seam-bearing groups. It retained excessive fine geometry and is no longer current behavior.

Historical 2026-09-30 record before the Surface phase-one rebuild: experimental nyx-hierarchy-v3.3 artifact pairs. The Nyx 0.25 sloppy extension carries source triangle-corner attributes separately from clustered positions, compacts coarse wedges and preserves fine vertices. Prior builds and targeted geometry tests passed, but same-close-camera barrel artifacts remain. This is not visual/performance acceptance or a meshoptimizer v1.3 port. The candidate is described in docs/next-design/virtual-geometry-attribute-simplification-2026.md and docs/porting/next-renderer.md. Always copy WASM with matching .mjs; recipe changes require recooking old products.
