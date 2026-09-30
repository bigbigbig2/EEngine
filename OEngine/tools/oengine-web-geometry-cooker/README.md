# OEngine Web Geometry Cooker

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
(`abi_version == 2`):

```text
oengine-web-geometry-cooker.mjs   SHA-256 4530ca139fc7cba81a5310e729a2879add9f88142877bea64776630cc05f270f
oengine-web-geometry-cooker.wasm  SHA-256 ee9c99f637d4d51cef647e95777eed24b4e0fd7bd82de8ad848bd3801b11216e
```

The cooker emits one Product asset per canonical material domain, so a
multi-mesh GLB keeps independently addressable primitives. Rebuild the artifact
and refresh both hashes whenever the C++ sources change.

The Phase D source and checked-in browser pair expose the optional
`oengine_web_geometry_cook_release_page` spill hook. It releases a successfully
spilled page's decoded buffer and serialized Groups while preserving descriptor
identity. Older ABI-v2 artifacts without the symbol remain supported by the
TypeScript fallback, which retains the older plan memory.

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
(`abi_version == 2`):

```text
threads/oengine-web-geometry-cooker.mjs   SHA-256 06c5d7a9c461085d386dae48434c6151634b49b7522825d14d0a55ab48cda0e7
threads/oengine-web-geometry-cooker.wasm  SHA-256 3616fbaf73c97c156113a0b91d189b3da7c3f38b381f90d838ba8beb907cab49
```

2026-09-29: both artifacts rebuilt for nyx-hierarchy-v3.1 and
static-pbr-page-local-f32-v4. VertexFormat byte 10 is now 1 (Float32x3);
meshlet-local U16 products must be recooked. Native ABI oracle includes exact
shared-position bits and terminal LOD error after a rejected simplification.

2026-09-29 historical experiment: v3.2 rejected sloppy for entire seam-bearing groups. It retained excessive fine geometry and is no longer current behavior.

2026-09-30: hashes above describe current experimental nyx-hierarchy-v3.3 artifact pairs (canonical ABI remains version 2). The Nyx 0.25 sloppy extension carries source triangle-corner attributes separately from clustered positions, compacts coarse wedges and preserves fine vertices. Prior builds and targeted geometry tests passed, but same-close-camera barrel artifacts remain. This is not visual/performance acceptance or a meshoptimizer v1.3 port. The candidate is described in docs/next-design/virtual-geometry-attribute-simplification-2026.md and docs/porting/next-renderer.md. Always copy WASM with matching .mjs; recipe changes require recooking old products.
