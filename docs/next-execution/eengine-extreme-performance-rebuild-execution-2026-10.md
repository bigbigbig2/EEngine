---
id: eengine-extreme-performance-rebuild-execution-2026-10
state: current
verifies:
  files:
    - OEngine/src/render/surface/SurfaceWorkRuntime.ts
    - OEngine/src/render/surface/SurfaceGeometryPass.ts
    - OEngine/src/render/surface/SurfaceReconstructionPass.ts
    - OEngine/src/gpu/GpuAppearancePublication.ts
    - OEngine/src/gpu/SurfaceOptimizationCapacity.ts
    - OEngine/src/framegraph/FrameGraph.ts
    - OEngine/tests/contract/frame-program.test.mjs
    - OEngine/tests/contract/surface-demand-phase5.test.mjs
    - OEngine/package.json
---

# EEngine Surface V3 极致性能重建执行计划

日期：2026-10-05。设计依据：[重建设计母稿](../next-design/eengine-extreme-performance-rebuild-2026-10.md)；来源与采用记录：[next-renderer ledger](../porting/next-renderer.md)；开发节奏：[根 AGENTS.md](../../AGENTS.md)。本文替代此前的有界前端、优化 V1 与五步修复执行路线。

**本文是待实施的目标计划，不是完成记录。** 本轮只完善设计和任务拆分，未实现新域、队列、缓存、GPU 路径，也未产生新性能结果。实际进行到哪个切换单元，以 [workstream 的 currentSlice](../../project/workstreams/active/eengine-next-clean-rebuild.yaml) 为准；单元收口后更新该处，入口文件不得复制阶段状态。

本次首要交付是 **B1 → B2 → C 的 Surface 生产链收口**。A0/A1 只建设对此必要的测量、执行生命周期和物理资源身份。D/E/F 中直接受 Surface 布局、需求和输出改变影响的接线随 producer 前移；完整 Geometry/Lighting/Temporal 后续工作仍有独立单元。SSR、SSGI、VT、ReSTIR、AI Upscaling 暂只约束输入输出和扩展边界，不提前建设通用 provider framework。

## 1. 范围、证据与切换责任

### 1.1 唯一生产路径与模块边界

唯一 Renderer、FrameProgram、FrameGraph 和一次 frame submit 保持连续。一个 closure 的新 producer、产品、全部直接 consumer、binding、reset 和容量作为原子切换对象，同一 closure 不保留旧/新 A/B 路径。B1 允许其他尚未迁移 closure 暂由当前机制生产；这是同一个 renderer 内的分项切换，不能复制 renderer、重复求值或增加 adapter。B2 结束后，退休的全批 Surface 协调链从生产依赖中删除。

独立 CPU oracle、GPU 测试宿主和固定历史 checkout 可用于比较，均不接入 production。只保留目标架构仍需要的数学、资产发布、资源 owner 和 GPU 产品。不为历史测试恢复退休 owner；仍有效的语义必须迁移到新入口。

### 1.2 审计数据的正确使用

两份审计是历史材料：[源码真值审计](../reviews/eengine-source-truth-audit-2026-10-05.md)、[独立源码与 GPU 性能审计](../reviews/eengine-independent-source-gpu-performance-audit-2026-10-05.md)。用于定位切入点，不把静态推导自动升级为当前实测。

| 历史观察 | 本计划采用的含义 | 禁止的推论 |
|---|---|---|
| `09449d6d` 审计配置：1080p 固定 47 batch，2,689 executable nodes、2,394 dispatch | B2 必须改变固定展开、物理表示和调度 | 每个 node 等于一个 GPU pass；现在所有场景仍恰好这些计数 |
| 近景 Surface timestamp pass 合计 P50 785.19 ms | 该配置 Surface 很昂贵，非完整 frame span | 删除某层必然节省固定毫秒或保证 FPS |
| 所列管理分项 P50 合计 708.71 ms，所列求值合计 23.26 ms | 指出严重失衡；A0 重建完整成本口径 | 分项 P50 之和就是逐帧管理 P50；分母包含所有 Geometry/效果 |
| graph-execute CPU P50 39.50–42.08 ms，含编码和诊断 wrapper | A1 有 CPU 复杂度问题 | 从 GPU 785.19 ms 减 CPU 40 ms；把全部 CPU 时间归给资源扫描 |
| 原生命令 489 次 clearBuffer，283.47 MiB/frame | 实际 clear/copy 范围要计账 | 旧静态逻辑 workspace 累计 4.73 GiB 等于实际 reset 或显存总线流量 |
| 同质量 cache OFF/recompute 未完成 | C 必须验证缓存净收益 | 全部 cache 一律无效或应删除 |

正式同条件历史收益留到架构和计划 providers 完成后。A0 基线刷新只记录本次环境/配置，不能修改历史结论。

### 1.3 三条架构不变量及单元验收范围

| 不变量 | 在实施中如何判断 |
|---|---|
| A 命令数与场景复杂度解耦 | 有限执行类别/scope；增加像素、域、exception、material 实例和 work 只改变参数与 shader 工作量，不复制 producer→consumer 全图。实际 kernel family、texture sets/banks 必须有限且协商，不能用“program”或“分片”改名恢复乘法展开 |
| B 管理成本不超过被管理计算 | 同帧配对的管理/求值/辅助成本。对近零成本常量不算不稳定比率，验证直接发布/广播和绝对开销；贵 closure 的 cache 算入 identity/lookup/admission/publish/reset/历史维护后看净收益 |
| C 关闭复用仍正确且同量级 | 关可选 cache/历史/跨样本复用后，同一生产框架执行完整 exact work，质量合同不降级；报告真实求值、存储、命令与时间，不能只证明图像未崩 |

每单元核对 A/B/C，但明确**本单元可证明的范围和遗留**。A0 验测量；A1 验执行器和生命周期，不能声称当前整帧 Surface 已满足 A/B/C。B1 只验已切换 closure 与 finite-family 可行性；B2/C 验新 Surface 全链；D/E/F 扩大到对应 producer/consumer。现有缺口不得因措辞自动消失，也不能把本单元必需 consumer 留给未来接线。

### 1.4 测试可信度失败修复与阶段完成规则（2026-10-05 补齐）

1. 实施前列任务 ID、设计要求、复审缺口与不变量范围；收口逐项核对真实 producer → 产品 → 全部 consumer、独立预期、正常/边界/失败、结构和成本。必需项遗漏、未测或无 consumer，就是未完成，不悄悄改成可选优化。
2. 测当前生产入口、生成 WGSL 或真实 GPU component，先证明目标分支执行。CPU oracle、mock、源码 guard 分开标注；源码正则、归档 shader、预填结果、小 fixture 不证明生产算法。Lighting 有非零有效 provider；coarse/cache 有普通合法成功与局部拒绝，不能永久 fine/miss。
3. 正确性与成本独立：完整身份/失效、独立 closure、发布前后、pin/generation、同 key 唯一 Store writer、互斥写域；真实 descriptions/samples/queues/refs/hot-cold、allocation/编码/clear/copy/计时覆盖。删除或按需的工作须真实消失或随该需求增长，容量减少不代替帧时证据。
4. 失败流程为“保存原始失败 → 最小复现/核对预期 → 分类定位 → 局部修复 → 原用例和关联回归”。区分生产错误、旧 ABI 测试、fixture/harness、环境、未完成 runner；未知根因如实未通过，改到绿不等于定位。
5. 禁止删/跳断言、吞异常、放宽容差、关 feature、缩小最终场景、永久 fine/residual、测试专用 production fallback。旧测试按 §12 退休映射迁移；不为 mock 缺 API 接错 owner，不在热 consumer 补重复 decode/guard，不恢复旧链或第二 submit。
6. 预期修改给出设计、固定来源或独立数学依据；功能、质量、误差预算或阶段范围变化先取得用户认可。缺少旧版复现时记录原因，以独立参考/fixture 受控故障检验敏感性，不在 production 加故障开关。
7. 集中收口复审最终 diff/覆盖，使用新鲜 `build:test`；最终源码变化后重跑受影响验证，不拼接快照。GPU 作业串行；超时、未完整报告、skip、不可用 timestamp 单列；零 API error 不代替结果断言。

这是单元收口责任，不是每 patch 门禁。开发中按调试需要运行 typecheck/build/单测，大模块链路连通后集中检查。完整 browser matrix、连续画质、正式 P50/P95、evidence/claims 留到 §13。

## 2. 执行顺序与首要交付

| 单元 | 本单元交付 | 后续关系 |
|---|---|---|
| A0 | 成本分类/counter producer/有限 timer/readback 生命周期 | 只做后续可测所需最小部分 |
| A1 | 编译期 lifetime events、稳定物理身份、execute 无逐 node 全表扫描 | 不先建万能效果 scheduler |
| B1 | 一个便宜 closure 原子切换 + 完整 generic family/布局可行性原型 | 关键可行性门，不能外推全部质量 |
| B2 | 全部当前 Surface 轻量 domains/queues/信号率/exact 覆盖，删除 plane proof/全批链 | 本次主要结构改造 |
| C | 发布成本分类、精确身份、可选有收益 cache、唯一 GeometryRecord | 本次首要收口终点，尚非完整 renderer 验收 |
| D | 完整 Geometry 工作域、真实树深/保守遮挡/独立 caster | 必需接线提前，完整算法单独收口 |
| E | 当前 Lighting/Shadow 极端路径/overflow/容量 | 当前有效 lighting 连续正确，不预建 ReSTIR/GI |
| F | Temporal/Post 历史语义、radiometry 和当前结构集成 | 计划 providers 齐备后正式最终验收 |

保持 A0 → A1 → B1 → B2 → C → D → E → F。独立阅读/测试准备可并行，生产布局按切换边界实施。A0/A1 必要范围完成后立即进入 Surface，不先全仓重排、建设未来效果或完整虚拟资源系统。

## 3. 生产链切断与保留矩阵

以下是当前源码入口；新产品/阶段名称是**拟实施责任**，不是既有代码事实。稳定后再定最终文件/ABI。

| 当前入口/机制 | 新 producer → 产品 → direct consumer | 切换与删除时点 |
|---|---|---|
| `render/surface/SurfaceWorkRuntime.ts`、`render/program/FrameProgramLowering.ts` | S0–S9有限语义阶段：coverage/address → lookup/miss → demand → Geometry/Appearance/guide → signal rate/Lighting → publish/reconstruct | B1 按 closure 接入；B2 删除 `consumeBatch`/全批接线，不复制 runtime |
| `SurfaceCellClassifierPass.ts`、`SurfaceCellPipelineLayout.ts`、`GpuSurfaceCellPlanAbi.ts` | 轻量域描述、tile 引用、信号 sample recipes；全率 facts 与可选 rate 分开 | B2 删除固定 21-plane tree/plans，coverage/direct consumers 同迁 |
| `SurfaceCellGeometrySetup.ts`、`SurfaceGeometryPass.ts`、`WinnerPrimitiveInterpolation.ts` | 唯一 Geometry owner、薄记录/guides、需求并集与 completion；保留插值数学 | B1 最小输入，B2/C 删除重复 setup/proof 输入/无 consumer 工作，不删目标数学 |
| `SurfaceDependencyEpochPass.ts`、`GpuAppearancePublication.ts`、`AppearanceExecutionProfile.ts` | 发布结构/成本/身份/版本，有限 family/bank routing；动态 footprint 完整依赖比较 | B2/C；删每帧通用扫依赖前接通发布/驻留失效，不用全局 token 掩盖局部依赖 |
| `SurfaceFieldLookupPass.ts`、`SurfaceSignalLookupPass.ts`、`GpuSurfaceFieldStore.ts`、`GpuSurfaceSignalStore.ts` | 便宜值直接发布/计算；贵 closure 可选精确 lookup；Lighting 历史按信号语义 | C 消费者迁移后删除宽通用缓存默认入口，不截断 key 留旧协议 |
| `SurfaceDemandPass.ts`、`GpuSurfaceDemandAbi.ts`、`SurfaceStorePublishPass.ts` | lookup 在 material miss compact 前；独立 dirty union、唯一 Geometry/closure work、唯一 cache writer | B2 迁 mandatory work，C 收口 cache/immutable results，删旧 arena/dictionary/maps |
| `SurfaceLightingPass.ts`、`SurfaceLightingWorkPass.ts`、`GpuSurfaceSignalPacketAbi.ts` | 唯一 GeometryRecord/Appearance → 各信号 radiance/transport | B2/C 前移需求/binding/语义，E 再处理完整 worst case |
| `SurfaceReconstructionPass.ts`、`SurfaceProducts.ts`、`SurfaceRadiometryPass.ts` | 完整覆盖映射、已有结果重建/廉价组合/radiometry | 随结果 producer 同切，不重跑完整几何、材质或 PBR 补漏 |
| `SurfaceFrameResources.ts`、`SurfaceOptimizationCapacity.ts`、`SurfaceDiagnosticsAbi.ts` | actual layout、exact profile、scratch owner、异步退休、正确单位/counters | A0/A1 必要修正；B2 迁新布局，不用旧 envelope 推全链 batch |
| `shaders/surface_cell_classify.ts`、`surface_cell_certificates.ts`、`surface_cell_group_validation.ts` 及 proof/witness 家族 | 删除通用逐 leaf 证明；信号质量条件由 rate owner 承担 | B2 删除整套生产依赖，不能改名接回 |
| `gpu/GpuSurfaceReferenceAbi.ts`、旧 field/signal ref WGSL | closed handle/version 与结果生命周期/互斥写域 | B2/C；无消费者 key/proof/ref 一起删除，有效身份语义迁移 |
| `TemporalFactsPass.ts`、`TemporalFabric.ts`、`Fsr3UpscalerRuntime.ts` | 当前 motion/depth/identity/radiometry → 各 history owner | B2/C 同迁输入/output/reset，F 独立复核历史/图像算法 |

### 3.1 母稿 S0–S9 与切换任务的对应

S 编号描述 semantic phases，不预定一个 phase 一个 pass。下表防止为了率判定/lookup 先完成全部 heavy Geometry，或为省缓存工作漏掉其他 dirty consumer。

| 阶段 | 实施责任与完成时点 | 生产/消费顺序 |
|---|---|---|
| S0 publish/reset | A0/A1最小底座，B1/B2/C随新layout迁移 | 已提交publication/frame/history roles → 当前bindings和少量controls，未提交结果不成为下帧hit |
| S1 coverage/work | B1最小域，B2完整work | Visibility/full-rate facts → active tiles/uniform-mixed引用；描述不等于采样 |
| S2 address geometry | B1/B2实际地址输入，C精确lookup | 仅cache class实际要求的projection/UV mapping/handle/version；不能先decode所有position/normal/tangent/UV/color |
| S3 field lookup | B1无cache直接，C可选贵closurecache | 完整地址/version → immutable hit refs/miss masks；在material miss compact之前 |
| S4 demand/bin/args | B2完整队列、C hit/dirty并集 | Appearance misses ∪ dirtyLighting ∪ requiredGuides ∪ numericResidual → 唯一Geometry union/family work/args |
| S5 Geometry→Appearance | B1原型，B2完整布局，C按真实miss减heavy | 唯一Geometry代码生成薄/局部C/X/Y，Appearance读其record；产field值/full-rate guide，实际后续consumer才保留cold |
| S6 rate/signal work | B2信号率，C各signal历史边界 | 已有真实guide/domain/provider facts → 每signal计划/exact recipes，必要新增需求由同Geometry owner补未发布字段 |
| S7 Lighting | B2/C迁当前consumer，E完整极端路径 | 唯一GeometryRecord/fields/providers → immutable信号或正式full-rate radiance贡献；不补写record |
| S8 optional publish | C缓存/当前signal历史 | eligible value/唯一writer → 经合法dispatch提交的下帧缓存/历史；atomic state不替代多word发布同步 |
| S9 reconstruct/compose | B1/B2/C所有直接读者，F输出/历史复核 | 已产immutable结果/pixel factors/AO/TemporalFacts → HDR/reactive/完整covered-background；无完整Geometry/材质/PBR |

命令数也统计native dispatch/draw/copy/clear/bind requests与upload字节，不允许把大量dispatch藏在一个graph node。scan采用母稿固定来源的portable多dispatch基线/协商subgroup特化，局部counts、padding初始化、exclusive转换、scatter/overflow/args均要真实生产与消费；不能跨workgroup自旋等待或假定最后一个group发布全局结果。

## 4. A0 — 最小测量与事实基线

| ID | 任务/源码切入 | 必须产物 |
|---|---|---|
| A0-01 | `framegraph/GPUTimer.ts`、`GPUPerformanceTimer.ts` 分离 production/coarse/stage/full | query 数/范围、ring/异步读回、profiler tax；不是改 mode 名称 |
| A0-02 | `SurfaceDiagnosticsPass.ts`、`SurfaceDiagnosticsAbi.ts` 逐 counter 查 producer/单位 | descriptions、samples、completion、hit/miss、mandatory/exceptions、clear/copy 分开；未接通为 unavailable |
| A0-03 | 当前同帧 stage/span 与 CPU encode 分开 | baseline 配置、pass sum 遗漏的 copy/clear/gap；不拼 P50 |
| A0-04 | 资源 owner 的 active/retired/query/readback/scratch | 物理身份/容量/live peak/retired peak，不累计逻辑 imports 当显存 |

timer 用持久 query/readback ring；GPU→CPU 仅异步诊断，不控制本帧 work。修 `geometryRecordStrideWords` 等单位时 encoder/decoder 同迁，并用独立单位预期。当前 Surface 热点可测即可，不先补未来 effects counter 平台。

集中检查：现有 `unit/gpu-timer.test.mjs`、`unit/surface-v3-timing.test.mjs`、`unit/sparse-shading-profiler.test.mjs` 验 ring/单位/归属，标明 mock 边界；拟新增真实 GPU timer 模式微测，验证 query/命令差和 span。边界含 query 不足、pending readback、abort、resize、连续 prepare/commit、无 timestamp；不能错帧/阻塞/填0。

出口：当前 Surface 成本和真实 clear/copy 可追踪，测量 owner 自身 A/B/C 范围通过。旧 Surface 缺口仍是遗留，不能宣布整帧性能改造完成。

## 5. A1 — 必要 FrameGraph 执行/生命周期

| ID | 任务/源码切入 | producer → consumer |
|---|---|---|
| A1-01 | `FrameGraph.ts` compile/execute | 编译 acquire/release events/resolved slots；execute 只处理当前 scope 引用和事件，删逐 node 全 registry 扫描 |
| A1-02 | graph import、`SurfaceFrameResources.ts`、history roles | 同 owner 物理 buffer 不因多 import 增 allocation；逻辑读写版本/依赖不能因物理去重丢失 |
| A1-03 | compiled graph cache/`FrameProgramLowering.ts` | 可缓存拓扑、晚绑定当前历史角色；缓存图不 pin 已退休资源 |
| A1-04 | queue scratch、abort/submit 清理 | 未提交与已提交资源按正确条件释放，active/retired 账闭合 |

保留 dependency sorting、unconsumed culling、version、alias/usage 合法性；不重建完整 FrameProgram 语言或 effect registry。pass 合并按实际 dispatch usage/依赖判断，不能假定一个 node 一个 pass。

集中检查：现有 `contract/frame-program.test.mjs`、`view-frame-transaction.test.mjs`、`surface-frame-resources.test.mjs`、`surface-history-binding.test.mjs`、`unit/gpu-bind-group-resource-cache.test.mjs`。拟新增 production compiled execute 缩放 case，分别固定命令增加 resources、固定 resources 增 commands，验证复杂度接近 commands/references/lifetime events；fake encoder 只验排程，另核真实资源不早退。

失败/边界：同物理不同版本、alias overlap、throw/abort、pending completion、cached resize recipe、destroy/device replacement。出口：无逐 node 全扫，依赖和 late binding/清理成立；仅证明 CPU 算法改进，不能从 GPU 毫秒扣 CPU 时间，也不假称 Surface 全帧 A/B/C 通过。

## 6. B1 — 单 closure 竖切与执行家族可行性门

### 6.1 任务与原子切换

| ID | 任务 | 必须同切产品/consumer |
|---|---|---|
| B1-01 | 选一个常量或简单已有源纹理 closure，列输出/identity/rate/all consumers | `GpuAppearancePublication` 发布、Surface 字段生产、Lighting/reconstruct 的全部直接读者 |
| B1-02 | 域身份、coverage tile refs、sample work 分开，最小域映射 | 唯一薄 Geometry/插值输入 → 域 refs → 实际 evaluator；该项不进旧 proof/lookup |
| B1-03 | 迁需求、结果 handle/binding/reset/容量 | 同 closure 旧链不能重复请求/求值/写入；其余未迁项只在同 renderer 暂留当前路径 |
| B1-04 | 原型验证有限 family 的完整 generic graph 路径及寄存器/布局 | 完整现有 instruction scalar DAG，包括 nonlinear coordinate、3 UV、normal/coat/product、不同graph/set；不能靠 per-program dispatch 兜底 |
| B1-05 | 独立 exact oracle、uniform 身份与采样分开测试 | GPU producer → 真实 direct consumer → 独立数值预期；tiny capacity 仍完整输出 |

常量直接发布/广播，不需像素 hash/cache。简单纹理仍保留正式 sampler/LOD/footprint 语义，不当常量。consumer 不止一个就全部迁，不能为缩小实验只接空 consumer。

**1 domain 不等于 1 sample。** Uniform fixture 可验一个合法连续域身份、零身份例外，但 tile refs 可多条；checkerboard/normal 高频即使域身份相同仍有必要采样。域数量、覆盖引用、样本数量分别断言，不预定 32–64 B 最终 descriptor ABI。

### 6.2 有限命令数的硬门

当前 `GpuAppearancePublication.ts` 的 `kernelKey` 包含生成 WGSL、texture set、product textures，`surfaceProgramCount` 不具有目标有限 family 保障，不能把旧 64 上限当作有效保证。

目标候选是 Standard PBR/Unlit 等有限参数化 family，加一个覆盖**全部当前支持 AppearanceInstruction 标量 DAG** 的 exact generic family，乘既有受控 texture sets；static product texture 走受控 atlas/bank routes。这个组合是具名本地集成方案，不能截节点、裁材质、换 cheap material 或限制现有语义以声称命令数解耦。generic family 内的工作长度/计算成本可以随 graph 增长，graph 实例数量不能增加整套 dispatch。

常用family与generic/独立CPU参考逐输出一致，保留原操作顺序、coordinate子图、嵌套采样、sRGB RGB/linear alpha、sampler/wrap/LOD、normal与coat validity/finite guard。产品atlas/bank路由改变也必须保持原过滤/footprint语义，不以atlas边界渗漏或隐式mip变化换绑定数量。

B1 至少验证普通 material 和上述完整 generic graph 可执行性、正确坐标导数/LOD/三 UV/coat、binding/寄存器/liveness、tiny sparse capacity 的完整 dense destination。若只能 per-program 新 dispatch 才正确，或者 invocation-private Geometry C/X/Y register 代价不可接受，就不能过 finite-family/布局可行性门；返回修改母稿候选执行表示，不用测试特例或另一 renderer 接过缺口。

按母稿 Exact Appearance DAG Execution 原型，generic temporary以并发lanes Q与完整DAG推导的live slots L计容量；每lane独占scratch，以固定数量workgroups对actual work做strided loop。资源紧张可减少Q但不截instruction/output、不丢work；private/register/storage/spill均计账，降低并发后的最坏帧也要可接受。循环只处理独立item，不等待其他workgroup。无法容纳完整既有资产时publication显式失败并保留上一合法事务，同时记录未解决回归，不能以拒绝资产判B2完成。

### 6.3 验证与出口

正常：常量、连续简单纹理、普通 PBR/Unlit、完整 generic graph。边界：UV seam、跨 primitive 连续/不连续、非整 tile extent、空 coverage、version 变化。失败：域/稀疏容量不足、invalid publication、abort/resize/reset。

独立预期来自 material 数学、sampler reference、独立插值，不调用 production evaluator 当 oracle。拟新增真实 GPU B1 case使用当前发布/evaluator/consumer，证明目标 closure 不执行旧 proof/lookup，并比较输出。源码 guard 只证明结构，不证明算法。

结构成本：该 closure 有限 scopes 不随像素/域/material 实例增加；descriptions/refs/samples 及 generic graph 实际算术分别计数。常量绝对管理预算与纹理/程序成本分别报告。出口：单 closure 完整切换，普通与完整 generic 家族原型通过，关闭可选复用 exact 输出成立；A/B/C 只覆盖本单元。整帧其他 closure 仍为明确遗留。

## 7. B2 — 全部当前 Surface 替换与完整 exact work

### 7.1 任务

| ID | 任务 | producer → consumer/删除 |
|---|---|---|
| B2-01 | full-rate facts、唯一薄 Geometry 和必要 guides | Visibility/geometry publication → facts/thin → rate；coverage/depth/motion/Winner identity 不先做求值证明 |
| B2-02 | 轻量 domains/coverage refs/每信号 sample recipe | 发布结构与当前 guides → domain/rate → Appearance/Lighting；删21-plane tree/proof/leaf witness，保留信号质量条件 |
| B2-03 | 有界 sparse queues + exact dense implicit work recipes | builder → compact/indirect evaluator；overflow 直接枚举完整受影响写域，不依赖每像素 exception append |
| B2-04 | finite families、窄字段布局、Geometry completion | 所有 dirty consumers needs union → 唯一 Geometry completion → closed 产品；producer-private heavy record → 同 kernel Appearance |
| B2-05 | 全直接 consumer/reconstruct/capacity/reset 同迁 | Lighting/Appearance/TemporalFacts/输出资源；新 layout 创建前 preflight，晚绑定/退休一起更新 |
| B2-06 | 删除旧全batch协同链和所有无consumer依赖 | `consumeBatch`、固定tree/certificates/group validation、proof/witness/reference家族、旧workspace reset/setup/capacity专用接线退役 |

域解决身份/地址范围，不保证 lighting 平滑。rate owner执行母稿规定的信号质量条件和 guides；silhouette、纹理/法线高频、视向/shadow变化仍需合法判定。普通合法 coarse 成功与局部 exact 拒绝都要出现；复杂组合缺完整 donor 的部分按 ledger具名本地方案与独立推导实施，不称完整上游移植。

### 7.2 exact recipe、容量与互斥写域

mandatory 完整覆盖不依赖 optional sparse 池。创建前计算 supported profile 的 full-rate facts/guides/exact结果/completion，满足 `maxBufferSize`/`maxStorageBufferBindingSize`/workgroup 等 limits。Sparse overlay 可以不足，dense indexed destination 必须事先容量合法，不能靠 overflow 后再分配/CPU读回控制本帧。

当前 15 material fields 的实际宽度共 **25 f32 channels = 100 B/sample**，不能按15×vec4误算成240 B。目标窄SoA按语义省常量/未用字段，分段每binding≤limit；真实峰值还包含 guides/Geometry/histories/cache/retired等，100B不是整帧内存承诺。

Geometry hot按活跃宽度与共享 primitive mapping组织；heavy C/X/Y completion候选由唯一Geometry producer的invocation-private record直接交给同kernel Appearance consumer，避免全屏保留528B cold。fused producer只有布局/private record/register/liveness与性能原型验证通过才选，不在reconstruct执行PBR，也不引入另一geometry/renderer路径。完整peak预算仍待原型；账算数字不证明1650Ti已适配。

Sparse域/样本队列不足时，在**最终生产边界**把完整受影响tile/partition升级exact recipe。recipe枚举全部covered samples，由像素/固定范围推导地址，不需要先append完整exception list。promotion在相应结果写入前定稿，撤销该写域coarse工作；exclusive owner保证同一信号同一目的地无coarse/exact双writer。不同信号不同率合法。

Optional容量为0、全屏需exact也是正常支持路径；cache admission不足只拒绝optional cache写，不丢求值。mandatory容量不满足则在创建/prepare前显式拒unsupported profile或按已批准profile协商，不提交半帧、不静默截断、不自动降质量。full-rate exception是**同算法的GPU工作recipe**，不进cache/proof，不用容量不足恢复全批前端。分bank/2D dispatch按真实limits推导，有限profile类别计命令，不复制整套链。

数量/u32算术checked preflight，不能wrap；history池不足产当前direct结果并保留必要guides，不能用stale值；Geometry cold/scratch不足降Q或同owner局部record直消，不能另恢复几何。GPU不能临时createBuffer，因此每种pool耗尽独立验证，metadata fallback不证明retained field/signal目的地存在。完整支持profile内mandatory worst case是硬出口；超能力失败保持前一合法publication，不把既有资产回归改称成功。

### 7.3 验证与出口

- 源码核对：全部现有closure/signal/lit/unlit/material family和非零provider有真实producer/全部consumer；reset/resize/abort/commit/binding原子迁移。
- 独立oracle：域身份、coverage/exact配对、exclusive write sets与信号质量；普通coarse成功、局部高频拒绝、全fine exact都出实际结果。
- 拟新增真实GPU domain/rate/overflow component调用production WGSL/directConsumer，zero/tiny optional capacity、部分/全部tile promoted、重复需求、边界tile、背景、shape/version变化与完整generic graph输出对独立reference。
- 结构成本：descriptors/tile refs/samples分开；optional append与mandatory dense destination分开；无21-plane tree/leaf proof、无按容量复制全链；真实reset只touch必要control/metadata，payload按实际写域覆盖。
- 内存账：thin hot/guides/private completion/outputSoA/refs/indirect/cache/history与active/retired峰值，binding limits与exact worst case。关复用完整求值，无隐藏宽全屏key/cold数组。
- 出口：新Surface覆盖/质量、唯一Geometry语义、finite execution families与A/B/C通过本单元范围，旧全批/证明从production imports删除；D/E/F必需consumer已接。完整后续算法遗留具名，不留基础缺陷到最终验收才发现。

## 8. C — 成本分类、精确身份与有收益复用

| ID | 任务/当前入口 | 生产链责任 |
|---|---|---|
| C-01 | `AppearanceGraphCompiler.ts`、`AppearanceExecutionProfile.ts`、`GpuAppearancePublication.ts` | 发布时常量/便宜源采样/贵稳定closure/动态视向closure分流，依赖结构与策略固定，不建每tile成本预测器 |
| C-02 | `AppearanceFieldIdentity.ts`、`GpuSurfaceFieldIdentityAbi.ts`、texture/product版本发布 | Winner/Sharing/Cache identity分开，同published handle+version稳定；不因无关编译顺序失效 |
| C-03 | 替换Field/Signal lookup默认主链 | **lookup在material miss compact前**；薄记录/必要guides/发布依赖完成精确查询，hit不触该字段geometry/material heavy |
| C-04 | Demand/Geometry completion/evaluator/publisher | 独立dirty masks并集；某field hit不能抹lighting/其他field需求，仍请求唯一GeometryRecord；cache同key唯一writer |
| C-05 | closed immutable结果和cache生命周期 | identity失效/overflow互斥/pin/generation在权威发布/生产边界保证；hot consumer不重复guard已保证不变量 |
| C-06 | Lighting信号与reconstruct收口 | transport/radiance/direct/specular/coat各自合法率/历史，view/provider依赖完整；reconstruct只消费已有结果 |

只有贵closure验证净收益后启cache，常量/便宜源采样走直接路径。改变地址域可降低key展开成本，不能截key、以hash无比较代替完整身份，或用global generation代替精确依赖。动态footprint完整比较UV、LOD/mip、sampler/query范围、源/驻留版本及真实依赖；不能比较时拒optional复用并正常exact求值，不让所有动态材质永久miss。

Closed GeometryRecord不要求每sample存全部字段。薄record已写字段与completion字段有明确互斥writer；需要heavy输入的invocation-private completion由唯一Geometry生产函数执行，再喂同kernel材质。独立Lighting/其他dirty消费仍参加需求并集；cache hit不会触重几何建立key。无consumer重新decode顶点，无reconstruct重跑材质/PBR。

验证：保留/迁移现有 `oracle/appearance-field-identity.test.mjs`、`contract/appearance-publication.test.mjs`、`appearance-product-binding.test.mjs`、`surface-field-publication.test.mjs`、`oracle/surface-store-writer-protocol.test.mjs`有效语义，旧宽key字数不是目标。拟新增真实GPU cache成功/碰撞/容量不足/dirty并集case，核hit确省对应heavy，不只缩counter。

边界/失败：同handle/version复用、无关closure重排、参数/UV/mip/sampler/驻留/page/deform/LOD/provider/view变化、namespace耗尽、pending pin、resize/abort/device重建、CAS竞争、未closed结果。独立reference和fixture错误key负控能识别stale hit，不在production加故障开关。普通贵closure有hit，便宜closure绕cache，局部拒绝不漏work。

成本：cache OFF/ON同输入分别统计identity/lookup/admission/publish/reset/history/retired与saved heavy，cold/static/moving分开；廉价近零分母用绝对开销。出口：B2新拓扑保持、复用可关、命中省heavy、dirty完整、immutable发布/热consumer边界成立，无宽通用SignalStore默认Lighting缓存/重复Geometry owner/reconstruct重算。C是首要Surface收口，不宣布未来providers完成。

## 9. D — Geometry 完整工作域

| ID | 当前入口/任务 | 核对与出口 |
|---|---|---|
| D-01 | `assets/geometry-product/VirtualGeometrySceneSourceV1.ts`、`passes/PackedVisibilityPass.ts`、`render/HierarchicalWorkGenerator.ts` | 真实package树深/容量/调度，删固定64层语义，SSE/LOD/page miss覆盖完整 |
| D-02 | `RendererCore.ts`与HZB owner | 保守previous/current HZB与普通相机运动；camera cut分开，不关遮挡当正常结果 |
| D-03 | Winner interpolation、geometry residency、frame attributes与Surface薄/补全产品 | decode/setup按真实consumer需求；布局/directConsumer同步，不恢复第二Surface geometry owner |
| D-04 | `vsm/VsmCasterRecordPass.ts`与geometry产品 | camera-visible与light caster域分开，屏外caster/deform/LOD/page变化成立 |

现有 `contract/virtual-geometry-product.test.mjs`、`geometry-surface-publication.test.mjs`、`winner-interpolation-owner.test.mjs`、`oracle/virtual-geometry-work-source.test.mjs`、`oracle/current-hzb-late-recheck.test.mjs`为语义入口；已注册真实GPU `hzb-conservative`、`virtual-geometry-handoff`、`virtual-geometry-instance-culling`只证明对应范围，额外case拟新增。独立coverage/保守预期含空/单Product、多runtime、深树、边界SSE/page miss/快速运动/屏外caster，不能只看selected counter。

D出口：producer→Surface/caster consumer、完整coverage、保守拒绝、实际decode/round/存储成本和A/B/C范围成立；固定donor来源需完整阶段映射/GPU证据，当前合同不自动升adoption。

## 10. E — 当前 Lighting/Shadow 极端路径

| ID | 当前入口/任务 | 核对与出口 |
|---|---|---|
| E-01 | `passes/LightClusterPass.ts`、`ClusteredLightingReference.ts` | 按light bounds建影响范围count/prefix/fill或母稿具名方案，完整列表/overflow，不每cluster无差别扫全灯 |
| E-02 | `SurfaceLightingWorkPass.ts`/`SurfaceLightingPass.ts` | 有效provider/signal queue；overflow不每sample无界遍历全灯、不静默丢灯；worst case有账 |
| E-03 | `VsmResources.ts`、`VsmReceiverDemandPass.ts`、`VsmCasterRecordPass.ts`、`VsmAtlasRasterPass.ts` | pageConstants真实producer、generation/receiver-caster关联/tight bounds/dirty commit恢复 |
| E-04 | Shadow采样与Surface rate/cache边界 | 屏外遮光体、移动光源、page/caster不足；局部灯shadow按真实支持profile，缺实现不能返回1.0宣称支持 |

完整cluster/page/caster复杂算法实施前固定开源来源与映射，prefix胶水不豁免整个算法调研。现有 `oracle/vsm-e9.test.mjs`、`contract/frame-program.test.mjs`、`surface-execution-profile.test.mjs`只验各自合同；拟新增真实GPU非零lighting/shadow/overflow，对独立逐灯数学、caster/page覆盖reference。

E出口：非零direct light/有效shadow真实消费，cluster/page/caster不足正确且可恢复，命令/关联数/dirty页/raster成本及A/B/C范围有证据。ReSTIR/GI不属于本单元，不预建reservoir/world-query实现。

## 11. F — Temporal/Post 与当前结构收口

| ID | 当前入口/任务 | 核对与出口 |
|---|---|---|
| F-01 | `TemporalFactsPass.ts`、`TemporalFabric.ts`、`TemporalHistoryRegistry.ts` | facts生产一次；motion/jitter/depth/identity/exposure/reset合同，各history独立有效性 |
| F-02 | Surface信号历史与`Fsr3UpscalerRuntime.ts` | signal更新/最终图像各有owner，避免双层无限平滑，不用clamp隐藏漏work |
| F-03 | `SurfaceRadiometryPass.ts`、`SurfacePresentPass.ts`/post | irradiance/radiance/preExposure/colorSpace；当前FSR3完整算法保留，native1:1/upscale分profile |
| F-04 | active/retired/readback/history与主frame | abort/resize/cut/device replacement发布/退休，一次submit/唯一路径 |

现有 `contract/temporal-fabric.test.mjs`、`surface-history-binding.test.mjs`、`fsr3-frame-lifetime.test.mjs`、`oracle/d4-d5-radiometry-presentation.test.mjs`保留有效语义；拟新增production连续帧/新显露/rate变化GPU数值case。cut不能无条件清静态Appearance，resize绑定当前物理对象，device重建无stale handle。历史大buffer仅排查线索，不丢identity/关history达标。

F完成表示当前结构与已有providers收口。未来SSSR/SSGI/VT等仍独立实施，消费Surface/Geometry/radiometry，各owner拥有history/query/queues。计划providers齐备后才进入§13，不提前完整browser/claim验收。

## 12. 实际命令、新增case与旧测试退休

### 12.1 集中检查命令

以下来自当前 `OEngine/package.json` 和既有runner，**本次文档工作没有运行这些源码检查**。按单元选择必要targeted，最终源码变动后新鲜build:test，GPU逐条串行。

```powershell
# 仓库根：导航，非许可门禁
node tools/vibe.mjs context OEngine/src/render/surface

# OEngine目录：大模块链连通后的集中检查
npm run typecheck
npm run build
npm run build:test

# OEngine目录：A1当前语义入口示例
node --test tests/contract/frame-program.test.mjs tests/contract/view-frame-transaction.test.mjs tests/contract/surface-frame-resources.test.mjs

# OEngine目录：C当前身份/发布入口，不代替GPU结果
node --test tests/oracle/appearance-field-identity.test.mjs tests/contract/appearance-publication.test.mjs tests/contract/appearance-product-binding.test.mjs tests/oracle/surface-store-writer-protocol.test.mjs

# 仓库根：已经注册的GPU入口，逐条执行
node tools/gpu-oracle.mjs --list
node tools/gpu-oracle.mjs environment-probe
node tools/gpu-oracle.mjs hzb-conservative
node tools/gpu-oracle.mjs virtual-geometry-handoff
node tools/gpu-oracle.mjs virtual-geometry-instance-culling

# 仓库根：文档改动合同；不证明源码算法
node tools/docs-verify.mjs
```

可显式用既有 `node tools/vibe.mjs verify --module --test <OEngine/tests/...test.mjs>`。`tools/gpu-oracle/registry.mjs`尚未注册新domain/cache/lighting case，实施时新增真实模块/registry或迁移生产宿主；本文拟新增文件/selector不可提前放进已通过清单。`validation/labs/surface-optimization-v1/`历史fixtures先核是否退休ABI，不能直接当新主链验收。

### 12.2 拟新增的必要验证责任

| 单元 | 拟新增case（责任名，非已有脚本） | 独立预期/目标分支 |
|---|---|---|
| A0/A1 | timer模式GPU、compiled lifetime缩放 | 同帧span/命令数，独立release排程reference |
| B1 | closure域身份/采样/direct consumer、finite generic family prototype | uniform、checkerboard、seam/version、完整DAG/nonlinear/三UV/coat、tinycapacity |
| B2 | domain/rate、dense recipe/overflow/write互斥/SoA limits | 全covered samples、quality、zero/tiny optional完整结果、binding limit/峰值 |
| C | cache hit省heavy/dirty union/publish lifetime | same-version hit、stale拒绝、CAS唯一writer、独立exact evaluator |
| D/E/F | 几何/caster coverage、非零lighting/shadow、history/radiometry | 保守遮挡/逐灯数学、屏外caster、连续帧状态/色彩单位 |

先证明分支执行，oracle不能生产函数自比。必要负控放fixture；文档更新阶段不写镜像实现测试。

### 12.3 历史测试迁移矩阵

| 当前内容 | 退休/迁移 | 保留语义 |
|---|---|---|
| `surface-fixed-tree-phase4.test.mjs`、`surface-cell-plan.test.mjs`、`surface-batch-consumption.test.mjs`树/plane/batch形状 | B2删除退休形状与无consumer入口，增新domain/rate/exact入口 | coverage、共享成功/局部拒绝、exclusive写域、各信号率 |
| `surface-field-store.test.mjs`、`surface-signal-store.test.mjs`、`surface-demand-phase5.test.mjs`宽key/arena/admission | C按新store/direct迁移，不保留宽表示 | mandatory独立optional、同key唯一writer、generation/pin/失效 |
| `surface-phase6-reset.test.mjs`、`surface-optimization-capacity.test.mjs`旧offset/envelope | B2新layout/reset范围 | 控制初始化、完整容量、payload只真实写、active/retired |
| `surface-geometry-phase2.test.mjs`、`frame-vertices-owner.test.mjs`、`winner-interpolation-owner.test.mjs` | 迁新producer字段/调用 | 唯一geometry/插值owner、aliases共享但独立semantic需求、按需求值 |
| `surface-field-publication.test.mjs`、`surface-field-dependency-profile.test.mjs`、`appearance-field-identity.test.mjs` | 保留身份数学，替换入口 | 参数/源/sampler/UV/动态依赖完整、无关编辑不失效、stale拒绝 |
| `surface-history-binding.test.mjs`、`temporal-fabric.test.mjs`、`fsr3-frame-lifetime.test.mjs`、`view-frame-transaction.test.mjs` | 同步布局，不只补mock API | late binding、prepare/abort/commit、cut/resize/device、提交后退休 |

区分退休机制断言与有效语义；不能因换架构删完整身份/质量/覆盖/失败预期，不能让旧fixture驱动恢复第二路径。失败和预期修改遵守§1.4。

### 12.4 母稿原型风险的任务落点

| 母稿风险 | 执行任务与集中出口 |
|---|---|
| R01 family/product增长 | B1-04、B2-04、C-01：完整generic/受控routes与material实例增长命令不增 |
| R02 liveness/spill/低并发长尾 | B1-04：完整DAG live slots、Q、register/private/storage实际账和最坏work耗时 |
| R03 全率destinations峰值/limits | B1-05、B2-03/04/05：100B真实通道基线、窄SoA、thin/guides/temporary/retired完整preflight |
| R04 hit前hidden decode | C-03/04：只实际地址输入，hit重几何/材质采样归零，独立dirty仍完成 |
| R05 coarse漏高频/窄高光/shadow | B2-02、C-06：各signal独立质量与合法成功/局部拒绝，不能permanent fine |
| R06 cold/map/queue不足 | B2-03/04：每pool单独tiny/zero受控故障，完整indexed输出、互斥writer |
| R07 transport/factor finite guard变义 | B2-05、E-02/04：独立combined BRDF/packet/radiometry对照 |
| R08 history事件漂移 | C-05/06、F-01/02/04：roles、cut/resize/abort/commit真实生产链 |
| R09 reuse OFF仍有proof/Store | C-03/05：原生commands、allocation/reset/writes确实消失，exact输出完整 |
| R10 VSM/多灯被普通场景掩盖 | E-01/02/03/04：非零provider、屏外caster、独立overflow/dirty恢复 |

各风险按本单元范围关闭；无法关闭如实未完成，不改名“后续优化”跳过。完整matrix/正式收益仍遵守§13时点。

## 13. 最终完整验收与本轮未实施边界

### 13.1 进入条件

A0/A1/B1/B2/C/D/E/F与direct消费者收口，workstream计划providers完成，已知基础缺陷修复后，再做browser matrix、场景/材质组合、连续画质、正式GPU P50/P95/evidence/claims；`verify --full`属于此阶段。Surface单元真实GPU component/必要reset不等于提前跑完整正式矩阵。

### 13.2 质量和全成本

Production无profiling/coarse frame/有限stage/full诊断分开；frame span/pass sum/copy/clear/gap/CPU encode与profiler tax明确；CPU/GPU可能重叠，不直接相加推FPS。每帧配对求P50/P95，不能加多个P50当统计结果。

完整矩阵至少含低/高coverage、near/far、静止/移动/新显露，常量/源采样/贵静态/动态/完整generic graph，高频normal/ORM/窄specular/coat，seam/primitive/LOD/deform/residency，非零local light/cluster压力/VSM稳定dirty屏外caster，native/upscale/post，resize/cut/abort/device loss。检查真实commands/descriptions/samples/queues/hit-miss/completion/exceptions/write sets/clear-copy/live-retired，不能零API error或不超容量代替结果。

固定历史checkout与最终revision用同相机/分辨率/功能/质量/browser/warmup/device状态。记录1650Ti实际adapter/limits；频率/温度/供电未控制则降低结论强度。超时/Target closed/device lost保留原失败，不用别的host通过追认。

不精确承诺FPS或百分比。若超预算，列真实效果/query/bandwidth/memory/调度成本，选择具名算法/profile；质量或功能变化先获用户认可，不改测量定义。

### 13.3 本轮状态

所有任务是实施要求。历史测试/审计/来源pin只证明各自范围，**不证明本计划已实现、全帧A/B/C已过、donor采用或性能目标达成**。本轮只更新设计/执行文档，不运行生产build、targeted tests、GPU component/benchmark；文档合同检查统一执行并单独报告。
