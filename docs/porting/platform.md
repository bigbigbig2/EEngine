# Platform

## PLAT-TEXTURE-V2 · KTX/Basis research and BC physical package profile

- Local owner/source: `OEngine/src/assets/TextureAssetPackage.ts`、`RuntimeAssetManifestV2.ts` 与 `examples/validation/surface` 的真实 WebGPU oracle。
- Upstream: <https://github.com/KhronosGroup/KTX-Software>、<https://github.com/BinomialLLC/basis_universal>、<https://gpuweb.github.io/gpuweb/#texture-formats>。
- Revision: KTX-Software `90967979cbb7e9401ee2401ff997f30b4b7507d6`；Basis Universal `99f52d63aa6799cbdaecfe977111dc5ec3b31d47`；GPUWeb Editor's Draft 2026-09-01（`e0aff163a37eb3633ffd612e2a943ceb6196d6af`）。
- Upstream source: KTX-Software `tools/toktx`/JS bindings、Basis Universal `webgl/encoder`/`transcoder` 作为 KTX2/UASTC/ETC1S 工具链候选；GPUWeb 的 BC1/BC3/BC4/BC5 block layout、feature negotiation 和 copy validation 是当前物理变体的语义来源。
- License: KTX-Software Apache-2.0；Basis Universal Apache-2.0；W3C document license。当前没有复制其表达性源码或分发其 WASM/native binary。
- Adoption: 当前为 specification/reference reimplementation。离线 cooker 直接生成有界 BC1/3/4/5 physical blocks 与 RGBA8 fallback；KTX/Basis 对象模型和 transcoder 尚未成为 runtime dependency。
- Retained invariants: offline mip、sRGB linear-light filtering、normal renormalization、MASK coverage、block-aligned payload、capability-first variant selection、确定性 metadata/checksum。
- OEngine/WebGPU differences: 第一版 desktop-bc profile 只接受尺寸不小于 4、4 对齐的 2D power-of-two source；在 `texture-compression-unaligned` 尚不可用时，BC mip tail 截止于 4×4，portable variant 保留完整 1×1 tail。Runtime 只暴露 OEngine package contract。
- Fallback/lifecycle: `texture-compression-bc` 未启用时选择完整 `rgba8` variant；variant 缺失/损坏在 GPU resource 创建前失败；上传失败立即销毁 provisional texture，device loss 由 Renderer/asset owner 重新打开 package 并重建。
- Local validation: `runtime-asset-v2.test.mjs` 覆盖确定性、损坏输入、variant、颜色/normal/MASK mip oracle；`surface.texture-package-bc` 在本地 Chrome/NVIDIA adapter 覆盖 cook → load → BC upload → sample 和 WebGPU validation。

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
