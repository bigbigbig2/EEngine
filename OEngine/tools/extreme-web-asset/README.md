# Extreme Web Asset Tooling

The authority is
`docs/next-design/eengine-extreme-web-asset-compression-2026-10.md` and its paired
execution document. This directory owns offline image encoding, finite quality
search/evaluation, fixtures and immutable scene publication. It is not a runtime
codec, a production shader vendor or a second progress tracker.

```powershell
node OEngine/tools/extreme-web-asset/prepare.mjs fetch
node OEngine/tools/extreme-web-asset/prepare.mjs build
node OEngine/tools/extreme-web-asset/native-smoke.mjs
```

Use `native-smoke.mjs --snapshot` only when intentionally replacing the finite
`e0-baseline.json` tool-identity snapshot. It is not a mutable progress record;
the complete build, source and smoke records remain in the local output.

`sources.json` pins upstream Git revisions and the Windows NASM archive hash.
All fetched source, legal-page snapshots, logs, native binaries and generated
test inputs stay under `.local/extreme-web-asset/`. Existing mismatched or
modified tracked checkouts are rejected rather than reset. No upstream package
install scripts run, and no shader is copied to production or redistributed.

The native recipe currently requires Windows x64, CMake with the Visual Studio
18 2026 generator, and an installed MSVC x64 toolchain. It builds zlib, libpng,
libjpeg-turbo and libaom from pinned source, then links libavif against these
local static dependencies. libavif's default LOCAL libaom is not used because
it selects a different revision. Perl is discovered in Git for Windows, or set
with `EENGINE_PERL`, for upstream libaom's source generators. Upstream zlib CMake
renames `zconf.h`, so it runs against a separate build-source copy; the pinned
checkout is kept intact. libyuv is disabled explicitly; libavif's own
complete RGB/YUV conversion remains active. NASM retains optimized x64 kernels.
Do not interpret the disabled optional conversion accelerator as an encoder
algorithm simplification or a production throughput result.

`sources.json` in the local output records tracked-file tree identities and
license/source file hashes. `native-build.json` records exact configure/build
commands, CMake caches and binary hashes. Build failure does not write a new
success manifest; per-invocation logs remain available. Do not use an earlier
success manifest to claim a later failed build passed. The smoke command checks
binary identity before executing donor IQ/SSIM/10-bit/Identity options at the
High/Extreme anchors, including a rejected invalid option. Generated ramp
roundtrips prove tool configuration, not browser upload semantics or quality.

Spark's JavaScript MIT does not cover its shader codecs. Evaluation/public
engine distribution and downstream use have distinct conditions in its EULA;
no production redistribution authorization is recorded here. gltf-tex declares
MIT but this revision has no standalone copyright/license notice. Until the
applicable notice is obtained, its implementation is studied as a reference,
not copied as a vendored module. Further unit status and actual results belong
only in the execution authority, section 12.

## Preparation and GPU checks

```powershell
npm --prefix OEngine run build:test
node OEngine/tools/extreme-web-asset/fixtures.mjs
node --test --test-reporter ./tools/test-reporter.mjs OEngine/tests/contract/image-texture-product.test.mjs
node tools/gpu-oracle.mjs image-texture-transcode --json
node tools/gpu-oracle.mjs image-texture-transcode-f16 --json
```

Run GPU jobs serially. The oracle visibly attributes Spark in its evaluation
page and binds downstream evaluation to the fetched EULA. It reads complete,
hash-checked upstream shaders only from the local checkout; no shader is copied
into engine source, package or deployment. E1 completion does not grant engine
production redistribution rights.

`cook.mjs::nativeCook` accepts already oriented/canonical RGBA8 data, invokes
the pinned native encoder, validates actual AVIF metadata, writes immutable
content-addressed payloads, and atomically replaces the directory last. It does
not load legacy BC products. Raw exact coverage is the permitted uncompressed
exact representation; no lossy image is used as exact coverage. Special/virtual
mips come from complete caller-provided canonical chains, not cell-local mip
generation. `fixtures.mjs` creates local synthetic inputs only, not recooked
hello/Dungeon/Bistro assets.

Production image consumers use the schema4 product, shared preparation entry and
encode-only recorder. Ordinary textures and VT share the same image contract;
the Worker pool does not reinterpret retired products or provide a legacy codec
fallback. The current geometry contract is OEGPACK4/source-exact SoA4 with the
complete Zstd decoder owned by the existing preparation chain.

## Complete scene cook and publication

```powershell
node OEngine/tools/cook-offline-scene.mjs <source.glb> <cook-directory> 1
node OEngine/tools/cook-offline-scene.mjs <source.glb> <vt-cook-directory> 1 --vt
node OEngine/tools/verify-offline-scene.mjs <cook-directory>
node OEngine/tools/extreme-web-asset/scene-package.mjs <cook-directory> <deployment-directory>
```

Set `EENGINE_IMAGE_QUALITY` to `high` (default) or `extreme` before cooking.
Each product evaluates all 20 resident or 60 VT candidates; local canonical,
candidate and evaluation artifacts are not deployment assets. GPU search jobs
must run serially. A completed search is not a formal scene performance result.

`--publish-only` on the scene cooker revalidates existing complete source/profile
checkpoints and reconstructs the immutable scene closure without running another
search. It does not manufacture missing search results. Always run the verifier
before deployment. The publisher checks closure hashes/extents and immutable
object conflicts, copies dependencies first, then atomically replaces only
`scene.materials.json`. Static build plugins enumerate this closure rather than
copying scratch, candidates or obsolete files. Per-product reports explicitly
leave module/network totals unknown until a real deployment inventory is supplied.
