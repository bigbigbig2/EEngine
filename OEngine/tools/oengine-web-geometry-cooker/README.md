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
artifact carries the ADR-0017 two-phase ABI plus the ADR-0018 Phase B
incremental canonical-window builder (`abi_version == 2`):

```text
oengine-web-geometry-cooker.mjs   SHA-256 bc336c14322d66e83ea5fa82ddb5d587758611ce32f49090cf26bfa4e8c45a46
oengine-web-geometry-cooker.wasm  SHA-256 b6aebdf1fbeb1aa182c62aae757f7adeed5a04b9e61e2081887bf60d08e8f86f
```

The cooker emits one Product asset per canonical material domain, so a
multi-mesh GLB keeps independently addressable primitives. Rebuild the artifact
and refresh both hashes whenever the C++ sources change.

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
threads/oengine-web-geometry-cooker.mjs   SHA-256 5378e52a0b275d0fae09622a9eae692c19f61abc8080f16b7580d3939f5dce35
threads/oengine-web-geometry-cooker.wasm  SHA-256 c34870c73a8545fa97c4bb612073eef29e2aa56c0a6865083fd94afecf62cf28
```
