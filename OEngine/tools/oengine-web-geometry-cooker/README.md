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
using the command above and the pinned Nyx hashes enforced by CMake:

```text
oengine-web-geometry-cooker.mjs   SHA-256 c425c75290a6db5b6553542f5e11e60d9ce37706b48413848f3c044e740e78c5
oengine-web-geometry-cooker.wasm  SHA-256 e61765e749eca8181eb7c48cf6109c8b0438888e1aa61ccd0d4ba563600cedaa
```
