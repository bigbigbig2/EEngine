# Platform

## PLAT-WEBGPU · WebGPU/WGSL capability baseline

- Local owner/source: `GraphicsContext`、Renderer device creation、pipeline/bind-group owners。
- Upstream: <https://www.w3.org/TR/webgpu/> and <https://www.w3.org/TR/WGSL/>。
- Revision: living specifications; behavior rechecked when browser/toolchain changes。
- Upstream source: WebGPU API and WGSL specifications。
- License: W3C document license；规范是语义权威，不复制实现源码。
- Adoption: implementation to specification。
- Retained invariants: explicit feature/limit negotiation、usage validation、resource lifetime、error scopes、device loss and asynchronous mapping。
- OEngine/WebGPU differences: desktop discrete GPU is performance profile, but correctness cannot assume 64-bit atomic、MDI、mesh shader、buffer address 或 subgroup。
- Fallback/lifecycle: optional feature unavailable时共享 ABI 走正确 fallback 或明确拒绝；device loss/resize 销毁或失效相关资源/history。
- Local validation: device initialization、WebGPU validation、uncaptured error、device-lost diagnostics 和 target-browser fixture。

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
