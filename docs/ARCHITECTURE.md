# OEngine 当前架构

本页描述当前代码事实，不描述目标阶段。长期取舍见 [ADR](./adr/README.md)，精确合同见 [specs](./specs/README.md)，未完成迁移见 [STATUS](./STATUS.md)。公开入口由 `OEngine/src/index.ts` 控制，内部 Pass、GPU 表和 Shader ABI 默认不公开。

## 依赖与组合

```text
source asset
  -> validated runtime package
  -> GpuAssetStore / GpuScene / GpuRenderWorld
  -> FramePlan + MainRenderPipeline + FrameGraph
  -> Visibility -> sparse shading -> lighting/effects -> temporal/post
  -> present + asynchronous evidence
```

`OEngine/src/render/Renderer.ts` 是公开生命周期 shell；`OEngine/src/render/pipeline/MainRenderPipeline.ts` 是唯一主管线 recipe owner。CPU 负责导入、显式 patch、配置和命令编排；GPU 生成的最终可见工作必须由 GPU consumer 直接消费。

## Owner 表

| 边界 | 当前 owner | 合同 |
| --- | --- | --- |
| Runtime Asset | `src/assets`、`src/loaders` | 设备无关 package、内容身份、校验、range read 和 codec preparation |
| OEGPACK V3 / Geometry Product | `GeometryAbiV3.ts`、`OegPackV3.ts`、`assets/geometry-product/` | V3 metadata/page 解析、producer-neutral descriptor/page validation、OEGPACK Product adapter；Offline 已经共享 admission/residency 和 production Visibility consumer |
| Web Runtime Cooker | `loaders/gltf/streaming/`、`assets/web-cook/`、`tools/oengine-web-geometry-cooker/` | GLB Range/catalog、CookSession whole-page credit、GLB primitive canonicalizer、Nyx C++/Emscripten WASM artifact、Dedicated Worker 与 live Product provider；公开 `load_gltf()` 和普通 Scene 已进入共同 Product consumer |
| GPU 资产 | `GpuAssetStore.ts`、`TextureResidency.ts`、`VirtualGeometryResidency.ts` | GPU allocation、稳定 handle/generation、Product activation/page heap、demand/readback/upload/eviction；失败换版原子性与全局 bank 容量尚待重构 |
| Scene 与实例 | `GpuScene.ts`、`GpuRenderWorld.ts` | Packed instance、显式 patch、资产/材质关联与原子 publication |
| GPU 工作/可见性 | `GpuWorkGenerationAbi.ts`、`GpuVisibilityKeyAbi.ts` 及 work/visibility owners | hierarchy/culling、容量和 overflow、indirect work、VisibilityKey |
| Sparse shading | `SurfaceFeature.ts`、`ShadingBinPass.ts`、`SparseShadingResolvePass.ts` 及 publication owners | 可见像素分类、active-bin indirect specialization、一次材质解析、按需 Surface/velocity |
| Lighting 与效果 | `src/render/features`、`src/render/passes` | shadow、direct/indirect lighting、AO/GI/SSR、transparency、temporal 与 post |
| Frame resources | `FrameGraph.ts`、`FramePlan.ts`、`FrameContext.ts`、`FrameProducts.ts` | 依赖、pruning、冻结帧输入、typed products 和资源生命周期 |
| Capability | `GraphicsContext.ts`、`MainRenderPipeline.ts` | feature/limit/WGSL/API probe、specialization 和 capability record |
| Evidence | `src/debug`、`src/addons/inspector`、`OEngine/benchmarks`、`validation/` | counter、timestamp、资源统计、真实浏览器 artifact |

## 资产边界

Runtime Asset 是设备无关事实；GPU owner 由 Renderer/device 生命周期控制。Loader、Scene 临时对象和 FrameGraph 外部引用不得隐式延长 GPU 资源寿命。

生产几何的公开来源是 Web/Offline Geometry Product，二者进入同一 GPU hierarchy/work/visibility 主管线，不另建 renderer backend。旧 V2 geometry package 仅保留在内部 oracle、shader ABI 和底层测试边界；普通 Scene 与默认 `load_gltf()` 已完成 Product cutover。具体开放问题见 [0016 后续计划](./implementation/0016-remaining-work-plan.md)。

纹理生产路径目前是 TextureAssetPackage V2 + GPU-native variants/KTX2 preparation + `TextureResidency` + 有界 `TextureBindingSet`。Mode A 已在该所有权模型内实现，并由独立 Chrome component case 以 GPU readback 验证 tail/promoted sampling：完整逻辑纹理一次分配、先上传 mip tail、按可用 mip clamp 采样并通过稳定逻辑句柄 promotion；这不等同于真实物理显存释放，也不等同于 production-path 完成。Mode B/Virtual Texturing 仍需独立的 allocation 证据和 spec，不以“V3”名义重写已经有效的材质和绑定体系。

## 生命周期不变量

- 资源发布必须是原子的；旧 generation 只能在 submitted-work 边界后 retire。
- persistent asset/history/shadow 资源与 transient attachment 分开统计。
- feature 关闭时不创建对应 Pass、资源、history、readback 或独立 submit。
- 新 GPU 队列必须定义元素 ABI、容量、overflow、producer、consumer 和 counter。
- device loss、scene replace、resize、camera cut、提交失败和异步任务取消必须有明确失效语义。

## 不属于本页

二进制字段偏移和状态机写入 spec；活跃切片和退出条件写入 implementation；完成度和风险写入 STATUS；算法来源写入 porting ledger。
## Web visible-first 调度检查点（2026-09-19）

Web Runtime Cooker 现在把 catalog ready 与 source cooking 分开。Worker 在启动
Cook 前 flush catalog，让 camera/source priority 能选择有界 bootstrap unit。
catalog entry 暴露稳定 asset key 和保守 bounds。按 unit 的 range 合并会在
canonicalize 后释放 source reader，未选 asset 不再是首个 cut 的隐含依赖。
Subset Product 携带经过校验的 `sceneAssetIndices`，统一 Scene mapper 只为
当前 revision 构建实例。完整 refinement 是带 `replaces` 的新不可变 Product，
不是原地追加 DAG。这里是 S2 实现检查点，不是浏览器 milestone 证据。

## Product Runtime Status (2026-09-18)

Geometry Product V1 now has a live internal consumer in the unified GPU path:
`GpuScene -> GpuRenderWorld -> hierarchy/work -> MeshletBucketRaster -> VisibilityKey -> Sparse Shading`. Packed CSM uses the same Product generation and resident banks. Real GLB/Offline browser cases, the Emscripten Worker artifact and the accepted authored-texture case exist; these do not prove visible-first large-scene PERF or final V2 cutover.

## S6 Consumer Cutover (2026-09-19)

The current public loading path is Product-first: `load_gltf()` opens the Web Product Runtime, and the Web and Offline/OEGPACK producers publish through the same Product admission, residency, scene mapping, main/shadow visibility and device-loss recovery path. The migrated examples and validation cases no longer construct or upload the legacy GeometryPackage route. Public exports are audited to exclude `load_gltf_packed`, `cookGeometryAssetPackage` and `openGeometryAssetPackage`.

Legacy `GeometryAssetPackage`, `GeometryCooker` and related GPU store code remain only where an internal shader/oracle/ABI test still consumes them. They are not public production entry points and are not a second renderer. Removing those remaining modules is a separate source/compiled/browser audit gate, not a condition silently satisfied by their continued existence.
## glTF 作者材质生产连接（第三步，2026-09-19）

Web GLB/glTF source 已支持有界 Range/200 fallback、外部 buffer/image、data URI、File/Blob object URL、sparse accessor 和取消释放。`GlbSceneCatalog`/Web Cook catalog snapshot 只传播 image/texture/sampler/UV/PBR 元数据；image bytes 不进入 Geometry Product ABI。

`Renderer.uploadWebCookedScene` 现在在 Product mapper 阶段异步读取并解码当前 revision 的 authored images，构造 `StandardShadeMaterial`/`ShadeTexture` 后进入既有 `GpuRenderWorld -> TextureResidency -> TextureBindingSet` 事务。mapper、decode、upload 或 submit 失败时不发布半状态。`validation` 的 authored-texture Chrome case 已在 clean commit 上 accepted：五个 PBR 槽位、UV transform、`MASK` 原子发布、TextureResidency resident page 和真实像素读回均有 artifact；41 个 targeted tests 另覆盖 Mode A promotion、失败回滚、代际复用、容量与 feature-off。Mode A 仍不代表物理显存节省。

## S7 用户观察器与证据边界（2026-09-19）

独立 `validation/src/cases/virtual-product-observer` 现在提供统一的模型观察界面。用户可以在同一页面选择 Web GLB/glTF 或 Offline OEGPACK，切换 `portable-single`、`portable-pool`、`isolated-pthreads` profile，输入 URL 或选择 Web File/Blob，并执行 Load、Cancel、Replace、断源、camera close、camera cut 和 device-loss recovery。Offline 本地文件若没有显式 `scene.oescene` manifest 会失败，不猜测 pack identity。

观察器展示并写入 artifact 的是 catalog、bootstrap/first meaningful frame、Product revision/generation、source/WASM/output budget、GPU capability、resident/pinned/retiring、demand/fallback/overflow、材质数量、streaming/residency、GPU 错误和有限 HDR numeric readback。Web 与 Offline 仍只通过 `Renderer.uploadWebCookedScene`/`Renderer.uploadOegPackScene` 进入同一个 Product admission/residency/Visibility consumer；界面不创建第二条 renderer 管线。

该 case 证明用户可复跑的功能和规模观察入口，不证明 60 FPS、物理显存节省或正式 PERF。正式 PERF 仍需在干净 revision、固定 adapter、1920x1080/DPR1、固定 workload/warm-up 和线程预算下，按 `VALIDATION.md` 单独执行。
