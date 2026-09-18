# 0016 虚拟资产系统：当前差距与后续交付计划

Status: active

Owners: Web Runtime Cooker、Geometry Product admission/residency、GpuRenderWorld/MainRenderPipeline、glTF/材质与纹理、Nyx 移植验证、validation host

审查快照：2026-09-18，OEngine `64f346d`，本地 Nyx `D:\Nyx-main`。本页是针对当前 revision 的活跃执行清单，不是新的 ADR 或 ABI。设计目标以 [ADR-0016 研究母稿](../others/虚拟化资产系统/EEngine_ADR-0016_Nyx_WebGPU2026_虚拟化资源加载与GPU驱动终极架构提案.md)为本次对照基线；已生效的产品、WebGPU、精确格式和验收约束仍分别由 `PRODUCT.md`、`WEBGPU.md`、`docs/specs/` 和 `VALIDATION.md` 管理。本次未阅读 ADR-0016 子文档。

## Outcome

Web GLB/glTF 与 Native OEGPACK 是两个 Producer，而不是两个 Renderer。它们从 Geometry Product admission 开始共享 GPU residency、GPU hierarchy/work、主视图和阴影 Visibility、Sparse Shading、replacement/eviction/device-loss 生命周期。Web 主入口以有界、visible-first 的 CookSession 尽早发布独立可绘制的 immutable bootstrap Product；丰富版通过完整新 revision 替换，不改写已发布的 Group/Page。普通 Scene、公开加载入口和最终生产 consumer 完成 Product cutover 后删除 V2 geometry 生产路径。

“完成”的必要条件是 Nyx 算法的源函数/Shader entry point、决策分支和不变量得到可追溯移植与下游消费证明，而不是语言、图形 API、内存布局或输出字节逐行相同；平台限制若无法保持核心语义，暂停相应切片请求方向确认，不用简化实现顶替。

## 当前事实与缺口

下列“浏览器已通过”取自 [STATUS](../STATUS.md) 记录和 `validation/` case 源码；本次审查没有重跑浏览器，也没有把历史 accepted 数值当作当前机器的新测量。

审评结论：Producer-neutral Product、GPU owner 分离、统一 Main/Shadow/Visibility 消费方向正确，现有 Nyx 几何算法也不是仅有概念名称的占位。但“整场景一次 Cook”、失败换版先拆旧发布、跨会话预算未真实记账和按 Product 预建 bank 是结构性问题；它们不能靠增加 case 或提高超时阈值补救。以下计划优先改 owner/事务与调度结构，再扩大输入覆盖和执行 profile，最后才允许生产 cutover。

| 领域 | 已有的生产基础 | 尚未关门的差距 |
| --- | --- | --- |
| Product/Renderer | Web WASM artifact、Offline OEGPACK provider、共享 admission/residency、GPU hierarchy/work、主视图/CSM/Visibility/Sparse Shading 已有真实浏览器 case | 公开默认 GLB 与普通 Scene 未完成 cutover；V2 package/upload/consumer 仍活跃 |
| Web Cook | GLB Range、Worker protocol、canonicalizer、Nyx C++ port、bootstrap + richer revision、逐页 credit | 实际 `cookProgressive` 一次 canonicalize **全部** primitive 与 Range，再对整场景 Cook 两次；source priority 没有带来按 asset 的首帧发布；巨大 primitive 无 shard |
| GPU residency | demand→延迟 readback→scheduler→upload、ancestor fallback、原子换版/失败保旧/驱逐/device-loss 有 targeted 与真实浏览器证据；同设备共享固定 4-bank slot pool | 仍需后续多 Product 压力、demand overflow 与设备丢失下的浏览器证据；淘汰评分已有 request/visible/predictive/refetch/thrash 记账，但尚未完成大场景 PERF |
| 预算/并行 | 单会话限制、output credit、全局 `WebCookBudgetLedger` 类型与 session admission | 生产路径只登记 output 的全局 reserve，source/WASM 跨会话字节未登记；`portable-pool` 未实现，pthread pool/部署未闭环，Worker crash/OOM 证据不足 |
| glTF/材质/纹理 | GLB/glTF Range source、Blob/File、data URI、外部 buffer、sparse/interleaved/normalized/non-indexed、作者 PBR texture metadata 与 Texture Mode A 接线已落地；独立 authored-texture Chrome case 已取得 diagnostic-only 证据 | clean revision 的 accepted 证据、promotion/replacement/device-loss/feature-off 仍缺；Draco/meshopt/skin/morph 仍按 capability/error 拒绝；巨大 primitive shard 属于第二步遗留 |
| Nyx 验收 | 本地 7 个关键 Nyx 文件 hash 匹配移植台账；本地 Cooker 真实调用 meshoptimizer build/partition/attribute-aware simplify；Native↔Web corpus 通过 | 两个 OEngine Producer 共用本地 C++ port，现有 differential 不是独立 Nyx 原版输出；GPU `DAGCull`/`VBufferMesh` 的逐入口行为、负例与真实 consumer 对照未齐 |
| 验证/文档 | Dungeon、Offline、demand、replacement、eviction、device-loss case 已登记 | 现有像素 smoke 不是作者材质保真或大场景 TTFMF/PERF；`ARCHITECTURE.md`、`PIPELINE.md` 有已过时叙述，`STATUS.md` 下一步重复 S6 |

需要优先处理的代码证据：

- [WebCookCoordinator](../../OEngine/src/assets/web-cook/WebCookCoordinator.ts) 把整个 catalog 的 `units` 交给 `cookProgressive`；[NyxWebRuntimeCooker](../../OEngine/src/assets/web-cook/NyxWebRuntimeCooker.ts) 为全部 unit 预取并常驻 Range/canonical input。这违反母稿 §7.4/§15.1 的调度与首帧边界，不等于 Nyx 几何构建算法本身被简化。
- [GeometryProductAdmission](../../OEngine/src/gpu/GeometryProductAdmission.ts) 现在保持 candidate `ready-to-activate`，由 Renderer 在 Scene/GPU/Sparse publication 提交成功后 commit；失败/取消保留旧 generation，错误传到 `settled()`。
- [VirtualGeometryResidency](../../OEngine/src/gpu/VirtualGeometryResidency.ts) 使用同一 GPUDevice 的固定 4 x 128 MiB shared slot pool；`evidence()` 同时报告 bank capacity、metadata overhead、双 revision peak、pinned/retiring 与 eviction/thrash 统计。物理显存节省仍不得仅凭逻辑 residentBytes 宣称。
- [WebCookClient](../../OEngine/src/assets/web-cook/WebCookClient.ts) 对 page-global ledger 只有 output reservation；[WebCookBudget](../../OEngine/src/assets/web-cook/WebCookBudget.ts) 的 source/WASM 限制在真实多会话路径中没有生产记账。
- [GlbSceneCatalog](../../OEngine/src/loaders/gltf/streaming/GlbSceneCatalog.ts) 与 [WebCookSceneSource](../../OEngine/src/assets/web-cook/WebCookSceneSource.ts) 不传递作者纹理绑定；`MASK` 几何与最低可采样纹理表示的原子准入条件仍缺。
- [load_gltf](../../OEngine/src/loaders/load_gltf.ts) 默认仍走 `GltfLoader.loadFromUrl()` 的完整 `arrayBuffer()`/旧 SceneBundle；新入口是显式的 `load_gltf_web_product()`。[SceneGeometryCanonicalizerV1](../../OEngine/src/assets/geometry-product/SceneGeometryCanonicalizerV1.ts) 是普通 Scene→Product 的 CPU/WASM seam，目前只有 targeted tests，尚非默认生产消费路径。

## Slices：按较大的交付阶段推进

以下七步是完整可运行结果，不把每个文件或单个测试当成一步。每步都先核对母稿相关章节与 Nyx 函数映射，再修改代码；完成后回头做设计对照、命中 DEV 验证和必要的集中浏览器 MILESTONE，满足退出条件才提交该阶段。未达门禁时保留“in progress”，不为赶进度绕过正确性。

执行依赖为第一步→第二步→第三/四步→第五步→第六步→第七步；第三步的 glTF/纹理与第四步的并行可以在 Product/Worker 合同稳定后分别推进，但二者和第五步的算法验收都是第六步删 V2 的前置条件。

### 第一步：修复 Product 发布事务与 GPU 内存所有权

目标：新 revision 的 descriptor、activation pages、材质/Scene 映射和 GPU staging 均成功后，才在冻结帧边界提交 active scene/product generation；任何 preflight、mapping、upload、submit 或取消失败都继续保留旧画面。让 GPU bank/slot 预算覆盖**全局**并发 Product 与新旧双 revision 峰值，而不只是单 Product 的 resident Page 计数。

执行：重构 `GeometryProductAdmissionController` 与 Renderer 的两段 active 状态，使 admission candidate 不先于 Scene publication 成为对外 active；允许新旧 GPU publication 同时 staging，commit 后才 revoke/retire 旧 generation，错误必须传回调用方/`settled()`。梳理固定 bank 绑定与后续 demand 页的矛盾，在 WebGPU limit 内选择可证明的共享 slot pool、预绑定容量或提交安全的 binding revision 方案；任何方案都要统计 GPUBuffer `size`、已上传页、pinned/retiring、双 revision peak，防止按每 Product 重复突破 512 MiB 总预算。驱逐策略补最小驻留时间、近期 demand/visible 频率、祖先重要性、重取成本和 thrash/cooldown 计数；保持 revoke→提交安全→slot reuse。

退出：故障注入覆盖“新 cut 已 resident、Scene mapping 失败”“GPU staging/submit 失败”“richer 事件与首次上传并发”“取消/ABA/slot reuse”；旧 scene 与 generation 全程可绘制或显式 fail closed，无吞错、无泄漏。针对 Product buffer/bind group usage、size/alignment、limits、device-loss 和 submission 边界做局部 WebGPU 审核；通过 typecheck、admission/residency/Renderer targeted tests 与 `validation/` 的失败换版 case。完成后更新 Runtime spec 中的事务/预算字段与 counter。

### 第二步：把 Web 主路线改成真正有界、visible-first 的渐进 Cook

目标：场景 catalog 先就绪，当前 camera 相关的独立 asset/shard 先获取 Range、Cook Nyx 完整算法并发布可绘制 bootstrap；未被优先选中的资产不能成为首帧的隐含等待条件。单个超大 primitive 需要确定性 spatial shard 或独立 coarse bootstrap 产品，不能靠增加线程掩盖全量输入依赖。

执行：从 `GlbSceneCatalog` 建立 source asset/shard、保守 bounds、依赖与优先级；重构 `WebCookCoordinator`/`NyxWebRuntimeCooker` 的全场景 canonical input 为有界 unit ownership、按 unit 的 Range 合并与及时释放。多 asset 的 Product/Scene 引用必须有明确 ABI 和原子 publication 规则：每个已发布 Product revision 自身完整、Group/Page identity 不变；不可把未完成 DAG 拼进一个已 active Product。保留 Nyx 的 meshlet→Group→seam/attribute lock→simplify/refine/error→hierarchy→Page 全阶段，只改变 source 和任务编排。为巨大 primitive 冻结 shard 坐标/边界、seam 规则、identity 与合并/可见性语义，不允许任意三角形分块替代 Nyx 算法。让 source/Worker/WASM/output/page/upload 的占用随着 credit 释放，超预算明确失败或选择显式 Offline source。

退出：慢速/高 RTT 的多 asset GLB 中，首个 Product/像素先于非可见资产 Range/Cook 完成；同 source/recipe 的优先级变化不改变产品语义，改变并行度不破坏已声明确定性；巨大 primitive 峰值与 TTFMF 有记录；取消后无滞留 Range/WASM/output。通过 source/coalescing/protocol/identity targeted tests 和至少一个真实浏览器 visible-first case，报告 catalog、bootstrap、first meaningful frame 与各 owner peak。

### S2 实现检查点（2026-09-19）

Web 主路线现在会在启动 Cook 前发布 catalog metadata，按优先级选择有界的
bootstrap unit 集合，按 unit 合并/获取 range，并把明确的
`sceneAssetIndices` 元数据贯穿 Worker -> Product provider -> Scene mapper。
Subset revision 仍是完整不可变 Product，后续 richer revision 通过原子
replacement 替换。Nyx cooker 阶段没有删减。2026-09-19 的真实 Chrome 多 asset
visible-first case 已通过；artifact 记录了 798 个 catalog primitive、首个
bootstrap activation、revision 1 replacement 和 replacement 后 demand 像素。
正式 milestone 仍需在干净提交上重跑，并补齐 source/WASM/output owner 峰值的
统一报告。

### 第三步：补齐 glTF 来源、作者材质与 Texture Mode A 生产连接

目标：默认产品支持声明范围内的 GLB、`.gltf` 外部资源和本地 File/Blob；材质/纹理不是“看得见三角形即可”，特别是 `MASK` 的最低可采样纹理表示与 geometry activation 同步。Mode A 只声明网络/上传渐进，不声明物理显存节省。

执行：扩展 URL/Blob/data URI/外部 buffer-image SourceProvider，验证 URI、Range/200 fallback、CORS/credential、source identity 和取消；补 sparse accessor 及 interleaved/normalized/non-indexed 的正反例。Catalog 和 Scene mapper 传递 glTF PBR texture slot、UV/sampler、image/codec variant 与 AlphaTest 依赖，接入现有 `TextureAssetPackage`/`TextureResidency`/`TextureBindingSet`，不另建纹理 renderer。对 Draco、`EXT_meshopt_compression`、skin/morph 等未支持 profile 给准确 capability/error，不静默回退 V2 或忽略 `extensionsRequired`。

退出：带 base-color/normal/metallic-roughness/emissive/occlusion 与 MASK 的代表模型有像素/数值对照；最低 mip 未就绪时不发布半状态；纹理 promotion、失败、replacement、device loss、feature-off 有 targeted/browser 证据。源格式矩阵对支持与拒绝均明确，不把 Dungeon 的材质常量 smoke 当保真验收。

#### 第三步当前实现检查（2026-09-19）

已完成：`GlbRangeSource` 支持 GLB、JSON `.gltf`、data URI、外部 buffer 的有界 Range/200 fallback、取消与 Blob/File object URL 生命周期；`GlbSceneCatalog` 输出 texture/image/sampler/UV/PBR 元数据，严格处理 sparse accessor，并对 `extensionsRequired`、Draco、`EXT_meshopt_compression`、skin/morph 给出拒绝错误；Web Product catalog snapshot 已携带纹理元数据；`WebCookRuntimeAsset.readImageSource()` 对嵌入 image bufferView 和外部/data URI 提供有界读取；Web Scene mapper 在 Product admission 前异步解码作者纹理，生成 `StandardShadeMaterial`/`ShadeTexture` 并交给既有 `TextureResidency`、`TextureBindingSet` 原子 staging。独立 `glb-web-product-authored-texture` Chrome case 已在当前 dirty revision 下 diagnostic-only 通过，取得五个 PBR 槽位、UV transform、`MASK`、resident page、GPU 纹理统计和真实像素读回证据。

仍未完成：第三步专用浏览器 case 尚未在 clean revision 上取得 accepted 证据；纹理 promotion、失败换版、device-loss、feature-off 仍没有完整的第三步专用 artifact；当前 authored case 使用单三角形/单 page，只验证材质生产连接，不替代多材质、大场景和 S4 demand；Mode A 仍只表示网络/上传渐进，不宣称物理显存节省。

### 第四步：完成可移植并行与跨会话背压/故障恢复

目标：`portable-single` 继续是正确性基线；非隔离 `portable-pool` 和隔离 `isolated-pthreads` 都能在同一 Product ABI 下工作，且全页 session/Worker/thread/source/WASM/output/upload 公平与总预算真实生效。

执行：实现多 Dedicated Worker 的独立 asset/shard 分派、稳定合并和输出信用；完成 pthread pool 在应用 Worker 内的握手、SAB/COOP/COEP 与资源跨域部署验证，禁止 Worker×pthread 嵌套失控。把 `WebCookBudgetLedger` 的 source/WASM reservation 接到实际 Range cache、canonical input、WASM committed/peak 生命周期，而不只在测试里调用；拒绝/等待/取消的公平性、队列容量、超额策略和恢复必须可观测。Worker crash/OOM 使 generation 失效，不复用其页或 descriptor；重启后按 source identity 重建，不阻塞渲染帧。

退出：多 session 压力下每项峰值不超过配置、credit 饱和时上游暂停、取消能释放所有 reservation；两种并行 profile 通过同一 conformance/negative corpus，故障不会发布 stale Product。先做 targeted tests 和部署 smoke，只有比较默认 profile 时才运行固定总线程预算的 PERF，不凭线程数推断性能。

### 第五步：完成 Nyx 函数级 differential 与 GPU 行为验收

目标：从“有来源的实质移植”升级为可证明的“Nyx 算法完整移植”。本地原版 Nyx、OEngine Native、OEngine Web 三腿相互独立地比较语义，不以两个 OEngine Producer 共用的 C++ port 互相比对替代 Nyx oracle。

执行：固定并重新验证 `MeshletBuilder.cpp`、`ModelConvert.cpp`、`MeshletStructs.h`、`GeometryStreaming.cpp/.h`、`DAGCull.slang`、`VBufferMesh.slang` 的七项 hash；建立可运行的原版 Nyx Model/reference harness，或等价地抽取**原版函数**并保留其接受/拒绝分支，不能用本地 port 冒充参考。扩展 corpus 至 seam/attribute lock、simplification fallback、refine link/error 单调、bounds 包含、BVH/DAG 可达性、Page 独立、bootstrap cut、材质边界和 determinism。针对 `ProcessNodeBatch`、`ProcessMeshletBatch`、`computeMain`、`BuildVertexOutput`、`meshMain`、`pixelMain` 建源入口→WGSL/现有 raster 的输入、关键分支、输出和平台适配映射，用可控 GPU counter/readback 对照 HZB/SSE、缺页 demand/ancestor fallback、overflow、primitive identity。不能直接比较 DX12 与 WebGPU 的布局/字节来判成败。

退出：三腿结构化 differential 与真实 malformed Product/overflow/stale/cancel 负例齐全；每个 Nyx 阶段有源码行、生产 consumer、语义差异和 oracle。若原版 Nyx harness 无法构建或核心语义不能保留，明确记录阻塞并请求方向确认，不标记 External Algorithm Complete，不私自删阶段。

### 第六步：公开入口与全部 Scene consumer cutover，删除 V2 生产路径

目标：`load("scene.glb")`/File/Blob、普通 Scene 和 Offline selection 均落到 Product Runtime；main、shadow、material、recovery 共用唯一 Renderer。删除已经替代的 V2 geometry package/cook/upload/runtime switch，而非保留双轨作为永久 fallback。

执行：在第二、三、五步门禁通过后，迁移 `load_gltf()` facade 和 Scene adapter；把现有普通 Scene→Product canonicalizer 接到明确的 Worker/asset owner、共享 admission 与 Renderer，不让同步主线程整 Scene Cook 成为新默认。逐一迁移 `GpuAssetStore`、`GpuRenderWorld`、main/shadow、device-loss recovery 与 public exports；对已无消费者的 `load_gltf_packed`、旧 `GeometryCooker.ts`、GeometryAssetPackage/upload、V2 shader/graph 分支执行 source→compiled graph/shader→浏览器 counter 三层审计后删除。Offline source 可显式选择，失败策略配置化，不暗中换质量或按 PageID 混拼。

退出：公开入口实际走 Web Product，普通 Scene 与 Offline 走相同 downstream；仓库生产调用、生成图/Shader 与浏览器 topology/counter 都无旧 V2 owner；replacement、shadow、feature-off、device-loss 通过集中 MILESTONE。删除前保存必要 oracle，不能用“类还存在但不调用”当作完成。

### 第七步：用户模型验收界面、规模化证据与文档收尾

目标：交付一个由用户自己运行的模型加载/观察界面及明确的验收说明，同时把功能正确性、规模行为和性能结论分开报告。

执行：在独立 `validation/` 宿主建可输入 URL/选择 File/Blob、切换 Web/Offline source 和运行 profile 的模型界面，显示 catalog/bootstrap/first meaningful frame、revision、source/WASM/output/GPUBuffer 容量、resident/pinned/retiring、demand/fallback/overflow、材质/纹理状态、GPU/console 错误；提供相机靠近、camera cut、取消/替换、断源与 device-loss 操作。用小 GLB、多 asset/多材质、巨大 primitive、Bistro-class、外部 glTF 和高 RTT/限速矩阵集中运行浏览器 MILESTONE。正式 PERF 仅在准备宣称目标或改进时执行，固定 adapter、1920×1080/DPR 1、画质、workload、warm-up 与线程总预算，记录 GPU P50/P95、TTFMF、最终收敛、CPU/内存峰值。同步修正 `ARCHITECTURE.md`、`PIPELINE.md`、`STATUS.md` 的旧事实和重复下一步，稳定 ABI/golden 写回 spec，来源写回 porting ledger。

退出：用户界面与手工脚本可独立复跑，case artifact 包含 revision、source hash、capability、截图/数值 readback、GPU diagnostics；未运行的用户/正式 PERF 项明确标记“未验证”，不宣称 60 FPS 或显存物理节省。所有完成事实写回权威文档后，删除实施文档中过时过程记录。

## Shared gates 与提交规则

1. 每阶段交付前，对照母稿 §4/§7–§10/§12–§18 和本页相应条目，列出保留的 Nyx 阶段、OEngine 平台差异与未覆盖项目。发现严重差异或当前简化实现时直接重构/删除，不以注释或未来 TODO 代替。
2. 修改共享 Product、GPU location、demand、Worker 或二进制字段时先更新 spec、TS/WGSL/WASM mirror 与 golden/negative tests；不得并行发明第二 ABI 或第二 Renderer。
3. 默认只跑 `npm run typecheck`、命中的 targeted tests 和构建；跨 GPU publication、材质保真或 consumer cutover 时集中运行对应 `validation/` 浏览器 MILESTONE。`npm ci`、全套重测试及正式 PERF 仅按 `VALIDATION.md` 的触发条件执行。
4. 每阶段提交前检查 `git diff`、实际 producer→consumer、feature-off、budget/overflow/counter、失败/取消/device-loss；设计对照无偏且命中验证通过才提交。提交应对应一个上述完整交付阶段，可在阶段内使用少量可回退的中间提交，但不把类名/空接口当阶段完成。
5. S9 持久 cache 和 Texture Mode B/Virtual Texturing 暂不进入上述必做链；只有重复 Cook/source 或真实物理 texture allocation 的固定 workload 证据证明瓶颈后，另行立项和验收。
