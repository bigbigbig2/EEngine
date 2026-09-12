# Platform

## PLAT-TEXTURE-V3 · KTX/Basis production codec 与 Web integration reference

- Local owner/source: `OEngine/src/assets/codec/`、`OEngine/src/assets/TextureAssetPackage.ts` 与 `RuntimeAssetManifestV2.ts`。
- Upstream: <https://github.com/KhronosGroup/KTX-Software>、<https://github.com/BinomialLLC/basis_universal>、<https://github.com/mrdoob/three.js>、<https://github.com/BabylonJS/Babylon.js>、<https://gpuweb.github.io/gpuweb/#texture-formats>。
- Revision: runtime binary 是 KTX-Software `v4.4.2`、source commit `4d6fc70eaf62ad0558e63e8d97eb9766118327a6`；2026 source review 同时固定 KTX-Software `90967979cbb7e9401ee2401ff997f30b4b7507d6` 与 Basis Universal `v2_50`；Three.js `r186`（`819fadd6b663b74d828c6af72a543024f74d3877`）；Babylon.js `9.26.0`（`e40c30aa8d5280b3781b69ecea5f58c9610b05e8`）；GPUWeb Editor's Draft 2026-09-01（`e0aff163a37eb3633ffd612e2a943ceb6196d6af`）。
- Upstream source: runtime 使用官方 release `KTX-Software-4.4.2-Web-libktx_read.zip` 中 `libktx_read.js`/`libktx_read.wasm`，对应 `interface/js_binding/ktx_wrapper.cpp` 和 libktx/Basis transcoder；Three.js `examples/jsm/loaders/KTX2Loader.js`、`examples/jsm/utils/WorkerPool.js` 与 Babylon.js `packages/dev/core/src/Misc/khronosTextureContainer2.ts`、`packages/tools/ktx2Decoder/` 只用于 Worker pool、Transferable、lifecycle 与 target decision 对照。
- Build flags/artifact hashes: Khronos release 的 read-only Web build启用 libktx Basis transcoder，不包含 write/encoder API；release zip SHA-256 `dbade8edfbbae4a8aa432d98a61b374c906fe062545c43f95ccace78e9af0465`，原始 JS `235d8265b5c30908272ecd3a33502a6b9175f5518c671b753b0f0fcaaf48fca8`，未修改 WASM `8336a23659f306c93f45816022dcdfae122f66eaf566488a2b7cf40e0bf65f0e`。本地只给 generated JS 追加 ESM default export，修改声明保存在同目录 `LICENSE.md`。
- License: KTX-Software 与 Basis Universal Apache-2.0；Three.js MIT；Babylon.js Apache-2.0；W3C document license。Vendored binary/source notice 位于 `OEngine/src/assets/codec/vendor/ktx-software-4.4.2/LICENSE.md`。
- Adoption: KTX-Software 是 direct pinned codec binary；GPU texture format/copy rules 是按规格独立实现；Three.js/Babylon.js 是 specification/reference reimplementation。OEngine 自研 BC/mip helper 仅允许 test/reference，production texture compression/transcoding 不得依赖 OEngine-authored block codec。
- Retained invariants: bounded lazy Workers、Transferable input/output、每 Worker 一次 WASM init、capability 与 exact transcoder target 双重选择、完整 mip、sRGB/normal/MASK semantic contract、block extent、atomic residency publication、确定性 metadata/checksum。
- OEngine/WebGPU differences: Worker 不拥有 WebGPU/Renderer/Texture；KTX2 UASTC/ETC1S output 归一化为 OEngine encoded variant，并进入 ADR-0007 同一 residency transaction。Pinned v4.4.2 target matrix 是 BC1/3/4/5/7、ETC1/ETC2/EAC、ASTC 4×4 与 RGBA32；未宣称 BC6H 或可变 ASTC block target。`texture-compression-unaligned` 尚不作为 hard requirement。
- Fallback/lifecycle: 已兼容的 GPU-native package 永远绕过 Worker/WASM；codec 不可用或无 exact target 时只选择 package 明示且 policy 允许的 uncompressed variant，否则在 GPU resource 创建前失败。取消/Worker crash 释放 CPU reservation，device loss 从 authoritative package/KTX2 input 重建。
- Local validation: `asset-codec-service.test.mjs` 覆盖 protocol、priority/FIFO、Worker/memory bound、Transferable、cancel/failure/replacement、lazy lifecycle、policy，并以 SHA-256 `c59c2174a0db4e12d2bbbab8f830cd9f2f1716194bbda89fac5ccbd57aae5268` 的 upstream 32×32 UASTC fixture 真实调用 pinned WASM 转 BC7；`runtime-asset-v2.test.mjs` 继续覆盖 package/residency。GPU consumer 的旧浏览器证据只属于冻结 commit，当前 Gate 等待 ADR-0012 的后续宿主。

## PLAT-WEBGPU · WebGPU 2026/WGSL capability contract

- Local owner/source: `GraphicsContext`、Renderer device creation、pipeline/bind-group owners。
- Upstream: <https://gpuweb.github.io/gpuweb/>、<https://gpuweb.github.io/gpuweb/wgsl/>、<https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedFeatures>、<https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/createTexture>、<https://developer.mozilla.org/en-US/docs/Web/API/GPUTexture/usage>。
- Revision: GPUWeb Editor's Draft 2026-09-01（spec commit `e0aff163a37eb3633ffd612e2a943ceb6196d6af`）；WGSL/MDN 于 2026-09-10 复核。living specifications 在 browser/toolchain 更新时重查。
- Upstream source: WebGPU/WGSL 规范正文是语义权威；MDN 用于 API exposure 与浏览器兼容性核对；merged proposal 只作历史 explainer。
- License: W3C document license；规范是语义权威，不复制实现源码。
- Adoption: implementation to specification。
- Retained invariants: core feature-level verification、explicit feature/limit/WGSL/API negotiation、usage validation、resource lifetime、error scopes、device loss and asynchronous mapping。
- OEngine/WebGPU differences: `docs/WEBGPU.md` 的 WebGPU 2026 Desktop 是目标 profile；subgroups、primitive-index、f16、format/compression 和 2026 core API 通过 specialization 使用。仍不依赖 64-bit atomic、MDI、mesh/task shader、buffer address、bindless 或 Draft extension。
- Fallback/lifecycle: optional feature unavailable时共享 ABI 走正确 specialization 或在 owner 创建前明确拒绝；Immediate Data/Transient Attachment 缺失不改变资源和结果语义；device loss/resize 销毁或失效相关资源/history。
- Local validation: frozen capability record、device initialization、WGSL enable/language feature、Immediate Data/Transient Attachment probe、WebGPU validation、uncaptured error、device-lost diagnostics 和 target-browser fixture。

## PLAT-FRAMEGRAPH · FrameGraph and resource ownership

- Local owner/source: `OEngine/src/framegraph/FrameGraph.ts`、`ShadeGPUCommandContext.ts`、`render/pipeline/FramePlan.ts`。
- Upstream: WebGPU specification plus Babylon.js/PlayCanvas/Renderling engineering references。
- Revision: external engines are design references only; no source revision is claimed as a local port。
- Upstream source: public frame-graph、pipeline-cache、bind-group-cache and WebGPU backend implementations reviewed conceptually。
- License: no expressive external source copied；each future port must pin its own compatible license/revision。
- Adoption: OEngine-authored implementation informed by public engineering patterns。
- Retained invariants: explicit reads/writes、stable resource identity、topological order、pruning、persistent/transient separation and one main submit。
- OEngine/WebGPU differences: FramePlan validates cross-graph order without creating another encoder；FrameGraph owns OEngine resource domains and late-bound jobs。
- Fallback/lifecycle: disabled/unconsumed nodes allocate nothing；in-flight destruction occurs after GPU completion；abort invalidates uncommitted histories。
- Local validation: framegraph dependency/resource tests、FramePlan dump、submit/readback counters。

## PLAT-CACHE-READBACK · Cache and asynchronous evidence

- Local owner/source: render/compute pipeline caches、bind-group caches、`FrameProfiler` and GPU counter readback ring。
- Upstream: WebGPU API semantics and browser-engine cache/readback practices。
- Revision: specification-driven; no direct external dependency。
- Upstream source: `GPUDevice` pipeline creation、`GPUBuffer.mapAsync`、queue completion and error model。
- License: specification/reference only。
- Adoption: independent OEngine implementation。
- Retained invariants: stable cache key includes layout/source/format/state；readback is delayed、bounded and never controls current-frame work。
- OEngine/WebGPU differences: sampling cadence and ring slots are explicit；unsupported timestamp/counter stays unavailable instead of being fabricated。
- Fallback/lifecycle: ring full drops a sample with diagnostics；map/device failures do not block rendering；destroyed owner retires buffers after submit boundary。
- Local validation: cache tests、profiler schema、readback ordering、dropped/failed sample counters。

## PLAT-INSPECTOR-UI · three.js Inspector shell reference

- Local owner/source: `OEngine/src/addons/inspector/InspectorShell.ts`、`inspector.css`。
- Upstream: <https://github.com/mrdoob/three.js>。
- Revision: `c4ffe022f2a4f982b42b7da5af79a87066a138ae`。
- Upstream source: `examples/jsm/inspector/Inspector.js`、`examples/jsm/inspector/ui/Profiler.js`、`examples/jsm/inspector/tabs/Performance.js`、`examples/jsm/inspector/tabs/Timeline.js`、`examples/jsm/inspector/tabs/Memory.js`。
- License: MIT (three.js)。
- Adoption: traceable local port of profiler shell interaction model and SVG icon language。
- Retained invariants: floating toggle with FPS readout、bottom/right dock、maximize/hide controls、scrollable tab strip、dark profiler palette、persisted layout。
- OEngine/WebGPU differences: framework-free Shadow DOM、typed Monitor/Record/High detail、内存 Timeline ring、GPU-driven/FrameGraph/Resources/Diagnostics panels；不依赖 three.js runtime objects，不提供离线 Capture/Replay。
- Fallback/lifecycle: `styles: inline | external | none`；每个 `Inspector` 独立拥有并销毁 shell；unsupported metrics 保持 `—`，不合成数值。
- Local validation: `OEngine npm test`、`examples npm run build`、`examples npm run build:storybook`。
