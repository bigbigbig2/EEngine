# Surface V3 最终性能重构设计：有界前端、真实复用与单一生产链

> 执行入口：[独立执行计划](../next-execution/surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md)；状态与冻结基线：[执行记录](../next-execution/surface-work-v3-cost-bounded-final-refactor-progress-2026-10.md)。2026-10-04 Phase 0静态清单、Phase 1 publication/工作表示与 Phase 2 Geometry owner/bounded setup 实现及阶段检查已完成，当前待 Phase 3；重构前代码14c17078。实际消费/容量及缺口见[Phase 0清单](../next-execution/surface-work-v3-cost-bounded-final-refactor-phase0-inventory-2026-10.md)、[Phase 1实施记录](../next-execution/surface-work-v3-cost-bounded-final-refactor-phase1-implementation-2026-10.md)与[Phase 2实施记录](../next-execution/surface-work-v3-cost-bounded-final-refactor-phase2-implementation-2026-10.md)。

日期：2026-10-04

状态：实施设计；尚未实施、尚未验收，不构成性能或来源采用声明。

依据：当前实际源码、Showcase run06 采样及本轮代码审计。333.md 仅作补充，不覆盖源码事实、正确性条件和实测。

范围：SurfaceWork 前端、Geometry setup/record、FieldStore/SignalStore、Appearance/Lighting 调度、重建与资源生命周期。本文包含实施顺序。

阅读顺序：§2–3 核对问题和成本；§4–16 为最终生产合同；§17–19 为容量与 WebGPU；§20–21 可直接用于重构拆解；§22 判断是否真正完成。补充材料原路径为 G:/我的云端硬盘/web3d/webgpu/temp/333.md；其中实施建议经过本文重新取舍，不作为独立执行指令，也不是重构必须依赖的外部文件。

## 1. 文档关系与本轮决策

本文是[第三版最终重构设计](eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)的性能实施细化，保留其产品、画质、单一主链和 owner 约束，沿用[整体架构](eengine-next-overall-architecture-final-2026.md)边界。它修订[优化 V1](surface-work-v3-optimization-v1-design-2026-10.md)和[五步修复](../next-execution/surface-work-v3-classifier-store-repair-plan-2026-10.md)中的前端执行选择，不把旧文档“已完成”记录视为当前性能已合格。

保留以下目标：

- 唯一生产 Renderer、FrameGraph 和 frame submit；不恢复退休 owner，不建立旧/新运行桥梁。
- Winner、Sharing、Cache identity 分离；hash 只索引，不证明身份。
- cache lookup 在相应 material miss compact 前；命中字段不重新进入其重求值 closure。
- SurfaceGeometryPass 是唯一完整 GeometryRecord producer；Appearance/Lighting 不解码三角形。
- field 与六类 lighting signal 独立需求、独立引用；TemporalFacts 是唯一基础时域事实 owner。
- reconstruct 只选取引用、解码有限结果并合成；不重新执行几何、完整材质或 PBR。
- 复杂材质、正常/退化几何、Product/普通资产、阴影、IBL、颜色与时域语义完整保留。

本轮一起实施的变化：

1. publication 提供依赖、成本与可证明性 profile，避免每个像素重复发现程序性质。
2. 固定空间层级替代逐 plane 的任意 member/pair 搜索；unknown 仅细化相关字段或 signal。
3. 候选定位、值有效性、空间共享证明分开；昂贵证明受数量和单项工作上限约束。
4. 不缓存的廉价/动态 closure 在同一新链直接求值；不强制先做宽 key 全局去重。
5. setup 跨消费者复用，cold 数据按需生成；取消 shader 内隐式重复完整解码。
6. 稀疏边界前移到 active tiles、候选和证明需求；删除最大容量 payload 的整块清零。
7. 压缩工作集与引用表示，缓存稳定 bindings，按真实依赖合并 compute 编码。
8. 当前 Lambert direct diffuse 合法分离颜色因子，并同步收窄前端依赖。

“有界”不表示画质降级或丢工作：优化预算耗尽时停止寻找共享机会，实际材质与光照仍完整执行。不能把整场景永久 fine 当作成功完成 V3。

## 2. 已核对基线及证据边界

### 2.1 运行身份

分析基点为 HEAD daaed9c7303a90e1658265e77e5cda02d63921b4 加采样时 dirty 工作树，不能只用该 commit 复现实测。此前审计比较 run06 保存的 613 份源码指纹与当时工作树，一致；实施 Phase 0 重新保存实际状态，不能假设此后未变化。

本机证据位于 ../../.local/validation/showcase-5173-surface-repair-20261004-run06/：

- performance-summary.json：时间口径及分布。
- profiles.json、detailed-counters.json：实际阶段与独立计数。
- capture.json、report.json、source-fingerprints.json、shaders/：配置、身份和生成代码。

环境：GTX 1650 Ti、Chrome 154.0.8037.93、1920×1080、Dungeon 静态 overview；AO/FSR3/Bloom 开，VSM/jitter 关，exposure 4。30 个有效 GPU timing 样本，detailed 为独立采样。本文仅引用已有报告，没有重跑。

### 2.2 阶段时间

| 指标 | P50 ms | 含义 |
|---|---:|---|
| 全帧 GPU pass sum | 801.730 | 被标记 compute/render pass 的区间总和 |
| GPU frame span | 867.389 | 首尾 GPU 时间跨度 |
| Surface pass sum | 790.373 | Surface 标记阶段 |
| CPU | 102.405 | 报告 cpuMs，不能未经 CPU trace 全归为 createBindGroup |
| Field classify | 88.538 | 内含比较、边界求值、访问及可能的 fallback |
| Signal classify | 211.219 | 不等于纯 pair-search 时间 |
| Geometry/Field certificates | 155.469 | geometry 约 45.717，其余为字段 family |
| Field lookup | 123.176 | 常量处理、identity/support/value/certificate 查询 |
| Signal lookup | 60.535 | enable、引用初始化、实际 cacheable probe |
| Address | 39.749 | 包含 analytic footprint 等前置计算 |
| Demand | 49.581 | 请求组织、去重、mask、分组 |
| Geometry setup | 5.333 | 不含嵌在其他 shader 内的直接解码 |
| GeometryRecord | 14.651 | 完整记录生产 |
| Appearance | 3.394 | 实际材质求值 |
| Lighting | 5.929 | 实际 lighting worker |
| Reconstruct | 4.435 | 结果选择与合成 |
| Cache maintenance | 21.318 | 不可从成本模型漏掉 |

不同阶段 P50 不能相加冒充某个样本或整帧 P50。classify 汇总项 306.524ms 还含 facts；上表单列两份 classify shader。

直接判断：主要成本发生在决定怎么计算、查询复用和准备证明，而非实际 BRDF/材质。仅缩短 lighting kernel 不能解决本次问题。阶段计时也不证明某个内部循环独占该阶段，后续归因计数仍必要。

### 2.3 实际工作量与容量

| 量 | 已有数据/静态计算 |
|---|---:|
| 可见像素 / 空像素 | 552,598 / 1,521,002 |
| tiles / 空 tiles | 32,400 / 23,461 |
| GeometryRecord 数 | 528,645 |
| materialEvaluatorEntered | 513,687 |
| lightingRecordsProcessed | 480,692 |
| materialMissRequested → queued unique | 993,339 → 969,940 |
| Field value hits | 309,579 |
| batch target capacity | 23,296，即 364 tiles |
| batch 数 | 90 |
| 每个 GeometryRecord | 720B |
| 每 target Workspace | 约 1,448B，另含固定区/对齐 |
| setup / dictionary capacity | 2,655 / 16,384 |
| 两项整块 clear 累计逻辑范围 | 5,079,101,760B，约 4.73GiB/frame |
| 全帧 GPU 标记区间 / dispatch | 3,548 / 3,555 |
| 实际 Appearance programs | 2，每个执行 90 次 |

preclassification hit、postclassification miss 和 evaluator group 不是同一种实体，不能混成统一 hit rate。当前 material miss 去重约节省 2.36%，不是前置去重收益的精确预测，但不能默认当前完整 key 有几十倍压缩率。

### 2.4 必须撤回的过强推断

- 4.73GiB 是 clear 命令范围，不是硬件 DRAM 实际流量。clear 位于 pass 外，不能直接解释 801.7ms pass sum。平均 span−pass sum 约 65.54ms，包含多种未标记成本，也不是 clear 优化严格上限。
- 576B 是地址槽位，非每个像素必写量；无效 leaf 提前返回，属性按依赖分支写入。
- Field 实际外层循环为 552,598×15≈829 万次，非全覆盖假设下的 3,110 万次；常量/缺失字段不进行完整 probe。
- Signal 会初始化空 leaf 的六份引用，但 disabled signal 不做 expensive probe。
- 2655 槽位不证明大量 overflow；fallback counter105 尚缺完整导出。
- 静态小链 warm 的零 heavy producer 不证明完整 Showcase 前端为零。
- 8.5 秒与 800ms 不是可直接引用的严格同条件十倍提升。

## 3. 成本模型与设计通过条件

定义 P 为输出像素，V 为可见像素，T 为 tile，Ta 为非空 tile，R 为 batch target 上界，B 为编码的最大 batch 数，G 为启用依赖等价组，C 为受理证明数，M 为 miss 求值数，U 为完整等价请求数。

~~~
Tsurface =
  Tcoverage + Tsetup + TcandidateAddress
+ TcandidateFetch + TvalueValidation
+ Tproof + TfieldPlan + TsignalPlan
+ Tdemand + Tgeometry + Tappearance + Tlighting
+ Tpublish + Tmaintenance + Treconstruct
+ TclearCopyAndTransitions
~~~

CPU 编码、GPU span、pass sum 分别报告；不把可重叠的 CPU/GPU 简单相加推 FPS。内存账列 resident、累计逻辑读写、reset range、实际 bytes/counter；峰值带宽除字节数只用于理想下界，不当耗时预测。

缓存准入的必要经济条件：

~~~
L + (1 − h) × (E + A) < E
~~~

L 包含地址、查询、验证；A 包含 miss 附加准入、组织、写回和维护；E 为直接求值；h 是对应请求类别的有效命中率。未知 h 不能填成 100%。常量直接 publication ref。

空间共享的必要条件：

~~~
(n − m) × E >
  proof + classification + mapping + added queues + added reconstruction
~~~

closure CSE 可能同时省多个 field，成本按实际求值组统计，不能重复计算收益。减少 bytes 不保证同倍加速；寄存器、分歧、缓存和同步留作实测项。

性能防线：

1. 无复用、全 miss、高频、微三角形时，优化前端仍有显式上限。
2. common stable UV field 具备实际可用缓存/共享能力，不以全部 transient 绕过实现。
3. 每项优化说明删除的成本、新增成本及核验计数。
4. 时间验收独立于结构验收，records 减少/hit 增多不是完成证明。
5. GTX 1650 Ti/1080p 为首要目标，优于 V1/V2 为同条件比较目标；没有可比数据前不许诺固定 FPS 或百分比。

## 4. 最终数据流与 owner

~~~mermaid
flowchart TD
  P[Material / Geometry / Texture publication] --> C[依赖与成本 profile]
  V[Visibility + Depth] --> A[Coverage + ActiveTileList]
  A --> S[Geometry owner: bounded shared setup]
  C --> R[轻量请求与 DomainKey]
  S --> R
  R --> L[Field 候选查询 + 必要值验证]
  L --> Q[受理的 unresolved proof]
  Q --> F[固定层级 Field plan + source binding]
  L --> F
  F --> SL[Signal 候选查询 + 必要验证]
  SL --> SP[有界 Signal proof/plan]
  SP --> D[实际 miss/dirty + 唯一 Geometry 需求]
  D --> G[唯一 GeometryRecord hot/cold]
  G --> M[缺失 Appearance closure]
  M --> LP[独立 Lighting workers]
  LP --> ST[Field/Signal 发布与提交]
  ST --> O[廉价 reconstruct + TemporalFacts]
~~~

field plan 必须在 signal key 前。已知 FieldStore/Publication ref 可参与 signal lookup；待求值 transient field 没有稳定持久值身份，该 signal 在本批按 dirty 处理。字段命中不代表另一个 dirty signal 不需要 geometry；需求按真实消费者取并集。

| Owner / 当前入口 | 最终责任 |
|---|---|
| compiler / Appearance publication | DAG identity、依赖等价组、proof/value profile、PSO family |
| GeometrySurfacePublication / Cooker / residency | 连续域、chart/seam、source/LOD、属性与形变版本 |
| SurfaceWorkRuntime / SurfaceCellClassifierPass | composition、范围、候选与计划；不拥有第二套几何/材质数学 |
| SurfaceGeometryPass / SurfaceCellGeometrySetup | setup/address/witness 几何部分及唯一完整 record |
| SurfaceFieldLookupPass / GpuSurfaceFieldStore | 候选读取、独立 value/certificate 验证、准入与生命周期 |
| SurfaceDemandPass | mask/模板需求、完整覆盖、worker/program 分流 |
| Appearance worker/compiler | missing closure；完整材质与 explicit gradients |
| SurfaceLightingWorkPass | 六种 signal、实际 provider、完整 lighting 数学 |
| SurfaceReconstructionPass | 有界选择、颜色合同、唯一输出写域 |
| FrameGraph / frame resources | 依赖、pass scope、indirect、预算与退休 |

不引入全局通用 Coordinator、第二 geometry cache owner 或所有语义共用的巨型 universal queue。

## 5. Publication：把不随像素变化的决策移出热路径

从真实编译 DAG/source metadata 发布以下逻辑信息；这是设计协议，不立即固化为稳定 docs/specs ABI：

| 产品 | 关键内容 | 来源 |
|---|---|---|
| FieldExecutionProfile | constant/default、input/sample/seam mask、value cost class、cache class、proof template | compiler live DAG，不能解析 WGSL 字符串猜依赖 |
| DependencyGroup | 共享 input/seam/proof 的字段集合 | 完整等价比较；ORM 共用 RGBA query，后接通道变换仍保留 |
| SignalExecutionProfile | field/provider dependencies、数值语义、允许率、proof class | 对应 production PBR 公式 |
| DomainRecipe | 必须比较的 continuity/side/LOD/source | closure 实际属性 |
| ProofProfile | 支持输入、完整操作/查询上界、质量参数、失败原因 | 原 interval/variation 数学 |
| Immutable publication token | 程序、参数、纹理/采样/驻留内容完整 witness 的版本身份 | 完整 interning、不可复用 generation |

几何实例、side、footprint 等动态输入不会因 publication token 自动消失。仅被证明不依赖实例/视角的 closure 才省去相应身份。

路由固定为：

1. Constant/Default：零 FieldStore lookup，零材质 worker，按需 publication ref。
2. StableCache：具备廉价完整 identity/witness 与合理复用空间；普通 UV-local 材质必须正式支持。
3. ShareCandidate：具有空间共享机会，允许有界 proof，不强求持久缓存。
4. DirectTransient：view/nonlocal、identity 构造比求值昂贵，或 proof 不支持，直接进入同一新链实际需求。

cache/share 是独立属性。廉价 texture read 与复杂程序不能无条件承担相同元数据成本。成本分类来自静态操作计数和最终校准表；未校准分类保守选择较低前端支出，不以主观“昂贵”开启无限 proof。

## 6. Coverage、active tile 和工作表示

全帧一次 coverage 扫描输出 tile coverage、enabled profile 摘要和 ActiveTileList。空 tile 不进入 setup/address/lookup/proof/worker，背景由独立明确写域处理。

CPU 按 extent/已协商容量编码最大 batch 数；GPU 用 active count 发布真实 range/indirect。不得读取本帧 active count 后由 CPU 决定追加编码。

- ImplicitFine：tile/program mask + 算术 lane 地址，不生成 64 条像素 task。
- Uniform：一个来源/率描述，coverage/value ref 由公式推导。
- Mixed：固定树选择位、少量 source/exception mask；仅非公式关联分配显式 map。
- 不按 15 fields + 6 signals 无条件初始化 21 份完整 ref/map；常量、zero、implicit source 使用模板。

多材质 tile 按实际 program 的 coverage mask 分流，mask 总覆盖不重复。PSO 基于 compiler program/family 共享材质实例，不为每 instance 创建 PSO。fine 下物理 value/geometry 可预留 tile-local dense slots，但不物化 pixel task。

leaf source 用 tile/lane 直接编号，geometry need mask compact 后发布 slot remap，删除 lane0 线性查 representative。Geometry 唯一性以实际求值位置、generation 和输入合同为准，不是每 primitive 只能一份 record。

## 7. Setup：跨消费者复用，最坏情况不退回隐藏解码

### 7.1 必选机制

1. 用 visibility/source metadata 取轻量 material/domain 信息，不为 material slot 解码三顶点。
2. Geometry owner 为实际需 address/proof/record 的 primitive 提供 setup。
3. tile 内 primitive key 固定 64 元素排序/分组产生 run leader；portable workgroup bitonic 网络最多 21 个 compare-exchange 步骤，非前序 pair 搜索。只排序 key/lane，不移动完整 setup。
4. 一个 tile/primitive 一个 request，workgroup prefix 分配 local slots。最大 local setup 数为 R，不依赖 hash 成功。
5. 所有消费者用显式 SetupRef，不再各自调用 cell_build_geometry_setup fallback。
6. setup 单 producer 完整写入，后续 dispatch 消费。按 input union 拆属性，复用原 Winner 数学。

完整 tile winner 相同可直接 uniform 分组；mixed 排序是确定上限，其成本不能记为零。

### 7.2 跨 batch 复用

使用有界 frame setup memo，不保证所有可见 primitive 都进入全帧池。key 覆盖 instance、实际 selected primitive/source、geometry/deformation generation、setup 的 view/projection 依赖。

- 本批查已发布 memo，固定 probe 上限；命中读取不可变 ref。
- miss 由预留 local slots 保证正确，本批完成后可尝试准入 memo。
- 不同 tile 同一 miss 可以各算一次，但不能扩大到每 field/pass/invocation。跨 tile dedup 仅在受益时启用，满表仍 local。
- memo 满不扫描全池、不跨 workgroup 等待；不准入即可。
- frame generation 切换使 view-dependent setup 失效；跨帧延长寿命非默认合同。
- memo 与 local 容量独立，不再用 R×128 隐式挤出 2655 槽位。

保证“每个受理的 tile/primitive setup 被各 consumer 复用”，不承诺“一帧每 primitive 仅 decode 一次”。分别计 local builds、memo hits、重复 winner、admission rejected；timing 移除当前 fallback 逐次全局诊断 atomic。

## 8. 身份、查询与证明：三个独立合同

| 合同 | 证明内容 | 不证明什么 |
|---|---|---|
| CandidateKey | 定位可能可用 bucket/entry | 同值、完整 identity、支持域 |
| ValueWitness | 当前请求可读取该值 | 邻居也可共享 |
| SharingCertificate | 指定区域/过滤支持域/质量预算内可共享 | 任意输入的精确 point value |

FieldRef 携带 kind/index/generation；certificate 携带 profile、依赖版本、支持域和误差，不是 safe=true。不能用一个 hit bit 混用。

### 8.1 最终查询步骤

~~~
Constant/Default -> publication ref
DirectTransient  -> 本批未求值需求
StableCache      -> CheapCandidateAddress
                 -> bounded bucket fetch
                 -> complete identity comparison
                 -> necessary ValueWitness / support validation
                 -> 独立 ValueHit / CertificateHit / Miss
~~~

首版保留 4-way bounded Store probe，删除失败后全请求线性扫描。只有候选可能匹配才生成昂贵支持域。若当前 index 仍依赖 analytic gradient class，先重做 index 所需的廉价保守类别；不能先宣称命中，再仅为 miss 计算确认命中必需的 footprint。

初始 CheapCandidateAddress 的索引部分最多 8 个 u32；普通 StableCache profile 的完整 identity+必要 exact witness 比较上限为 32 个 u32，静态依赖可由完整 interning token 代表。不能塞下的复杂 closure 不截短身份，而走 DirectTransient 或另一个经过成本评估的显式 profile，不静默回到全字段 88-word 通用 getter。

需要 detailed support 的候选先标记 PendingValidation，验证工作计入 §10 的 C 和操作预算；没有获准验证就按未命中处理，不能绕过证明上限在每个 leaf 的 lookup 内运行原完整 analytic/interval 链。廉价验证仍须有 profile 的固定比较字数和数据访问上界。

字段循环由 active profile mask 驱动，zero/constant 使用模板。同 tile 同 bucket 可共享候选 metadata，但不同请求仍完成必要验证。

### 8.2 ValueWitness 类别

- ExactPublication：完整不可变 field witness/版本。
- ExactPoint：精确 point/finite-difference 输入与真正依赖；仅可廉价构造的 profile 启用。
- ConstantDomain：证明支持域内常量，且请求过滤域被包含。
- BoundedDomain：正式允许质量预算内近似的 canonical cell，记录 anchor、值域/误差、filter/support、版本；与 exact 分别统计。
- Unsupported/Unknown：不接受缓存值，进入 transient/细化。

publication token 缩短 key 的前提是 producer 已完整 interning；短 hash 不能替代完整身份。ExactPoint 不是所有 closure 默认路线：若要先恢复完整几何才能拼 key，一般应走 transient。

### 8.3 持久 cell 的初始范围

支持稳定单 UV chart、已覆盖 sampler/wrap/filter、有效 source lineage 的 compiled closure；沿用真实 winner anchor 和 fine gradients，不在任意 cell 中心虚构 surface。

BoundedDomain 必须证明新请求的采样/输入支持域与最终字段变化，不只中心 UV 同格。多 chart、未覆盖 anisotropy、world/view、seam/LOD unknown 局部细化；不能把普通 UV-local 都排除后宣布缓存完成。

每次查询一个声明层级及有限候选，不跨多层反复试探。支持域不适用则 miss，后续可准入更细 cell；缓存满仍完整 transient 求值。

BoundedDomain 的最小可实施误差证书为：完整 closure 在声明支持域的保守值域 [lo, hi]、实际发布 anchor 值 v，以及数值舍入余量。逐通道误差上界为 max(abs(lo−v), abs(hi−v)) 加余量；向量方向使用独立锥度量，不能当 RGB 标量。若只有输入纹理界，没有最终 closure 输出界，不能把它当字段值误差。entry 发布时先求真实 v 再确认误差，查询时同时确认依赖版本、请求支持域包含关系及剩余质量预算。

### 8.4 去重范围

默认只做模板天然共享、tile-local 完整等价合并；受理的昂贵 stable requests 可做 bounded batch admission dedup。

不为所有 fine transient field/signal 建全局完整 key 表。不能证明等价时独立求值，允许重复数学，不允许重复写同一 output/Store slot。hash 满不做 O(N²) 全请求扫描，改用独立 transient destination。

bucket fetch 共享与 value producer 共享分别计数；后者必须证明完整数值身份和相关支持域。

## 9. 固定空间层级 classifier

### 9.1 DomainKey

publication 合并 seam/dependency mask，Geometry publication 提供精确连续域 token。每个启用依赖等价组生成完整 DomainKey：

- instance/source/product 与对应 generation；
- 合法几何连续域、side；
- closure 所需 UV/color/normal/tangent continuity；
- UV2/LOD lineage 不可靠时，仅该 closure 使用 representation-local 限制；
- signal 所需 cluster/provider 身份。

Hash 可加速 rejection，不可作为 accept。组合 tuple 若 intern 成 ID，必须保证无碰撞与 lifetime；GPU 动态分组不能靠未经验证的 32-bit signature 合并。

### 9.2 固定树

8×8 tile 只有 16 个 2×2、4 个 4×4、1 个 8×8 内部节点；每组最多 21 个候选，每个节点只合并 4 个 child：

1. leaves 发布 coverage、DomainKey、必要 cheap facts。
2. 2×2 child 身份一致、coverage/side 合法且有潜在收益，才提出 proof。
3. parent 合并 child 的支持域、bounds、来源和误差，再按 parent 预算判断，不能只 AND child safe。
4. parent 不可接受就保留 child，不枚举任意 member 子集寻找共享。
5. mixed domains 可在不同 child 区域各自共享；不为不规则区域恢复 pair-search。
6. accepted source 必须是覆盖内的真实合法 winner。source 与写域发布后不再变化。

metadata/merge 工作由 O(Ta×G×(64+21)) 描述，G 是实际启用等价组，不能直接写成 1。constant/zero 不参与。proof 另计为受理 C 项的 bounded 工作。

保守矩形树可能比任意 domain masks 少发现共享，这是明确的性能取舍，不降低画质。mixed material/seam 场景检验净收益，不保留旧 pair-search“增强模式”。

### 9.3 Workgroup 存储

portable 路线保持 64 lanes。共享内存只存 key、compact facts、当前依赖组的树状态与 prefix scratch；不得放 64 份 512B setup 或全部 21 plane 的大型证书。组按等价 profile 有限遍历，payload 留在有界 storage pool。资源创建前根据真实 WGSL workgroup storage 计算 limit，不以 TS 结构大小猜测。

## 10. Proof：只为值得尝试的候选，保留完整数学

证书不能成为默认每像素执行的第二份材质程序。分三个层次：

1. Publication proof：常量、固定 affine 关系、摘要已知性和版本。
2. Cheap runtime eligibility：coverage/domain/side、必要平面/方向界、provider 边界、潜在收益上限。
3. Bounded detailed proof：只有仍可能共享且收益足够的 unresolved 候选进 GPU 队列。

保留当前 interval engine、真实 TextureVariation、sample closure CSE、透视支持域数学；改变调用粒度、缓存对象和准入，不缩成同名 heuristic。

### 10.1 必须覆盖的 profile

- 常量/affine 属性、简单 UV-local texture 表达式。
- normal/ORM/albedo 等真实 compiler closure，共用相同 RGBA query。
- 原 interval DAG 完整支持操作；预算不足返回 Unknown，不能截断后接受。
- Geometry position/normal/tangent/view 与 parent-plane residual 的保守合并。
- specular/coat 各自的方向、roughness 与 provider 约束。
- cluster 身份、真实 light attenuation、shadow receiver 域、environment revision。

shader family 分区可减少编译体积，不允许重新变成“六个 certificate family 对所有 leaf 扫描”。

### 10.2 明确的执行上限

每个 publication proof template 记录最大 DAG bound operations、sample queries、每 query hierarchy visits、light risk visits 和 scratch。

初始调度上限：每候选 64 个 bound DAG 节点、4 个独立 texture-summary queries、每 query 32 个 hierarchy node visits、8 个 punctual risk light visits。它们是前端工作预算，不是质量阈值或 GPU 周期估计。完整 DAG 节点数不能忽略一个节点内部循环；其所有内层循环也必须有上述独立上限。

超过上限的模板不逐像素进 detailed proof；运行时超限则完整标记 Unknown。shared-prefix 只复用相同数学上下文，不混合 filter/chart/support/version。

每 batch 总受理 proof 数默认 ≤R/2；geometry、field、support proof 以有类型 slot 计入同一总账，不能每类各偷用 R/2。各 family 从共同 compact count 切片，未获容量的候选保留 child/fine；常量直接证明不占该队列。

初始上限在最终验收校准，不可为了 coarse rate 无限增加。普通低频材质大面积 Unknown 时，应在 publication/variation/域 producer 补足廉价完整证明，不能永久 fine。

### 10.3 正确性与误差

- parent 支持域覆盖所有被代表目标；anchor 采样梯度不随共享面积偷偷放大。
- child 相对自身平面 residual 转换到 parent plane，不能只取最大 child residual。
- denominator 穿零、near clip、退化、镜像、double-side、UV wrap/seam、filter 范围、f32 outward margin 保留。
- 当前 0.02 field variation、3° normal cone、原设计 specular roughness 0.35 等是已有初始 profile，不自动成为最终质量保证。
- stable cache 近似与空间共享近似不能分别各花完整预算。记录 accumulated field error，后续 signal proof 计算传播/剩余预算；无法保守组合则 exact/transient/fine。
- 字段 variation 小不自动批准高能镜面共享。保留完整 signal 风险判据，复合误差进入最终质量对照。
- 两帧降频 hysteresis 仅在 region identity/history 有效时使用；升频/失效立即生效。

## 11. Lighting 分类不重做昂贵 light list 搜索

当前 surface_cell_lighting_risk 对 group 成员与光源重复检查。目标：

- 默认相同完整 cluster ID+版本作为便宜充分条件；不同 cluster 局部拒绝 direct 共享，不逐候选比较完整 light lists。
- 同一几何候选的 world box/provider risk 只计算一次，服务相关 direct lobes；各自质量预算仍独立。
- punctual risk 循环受 §10.2 限制；多灯超前端预算则 direct fine，实际 lighting worker 仍遍历完整合法光源集合。
- VSM revision 相同不证明不同 receiver 同阴影。没有 receiver-region certificate 时相关 direct 细率，environment/无关 field 不受影响。
- environment/direct/coat 独立失效；不因 compose 中 AO scalar 改变清空材质缓存。

未知 provider 支持域不执行逐像素完整 PBR 来“探测能否共享”。不能把省下的 shading 放回 classifier。

## 12. Field source、Signal lookup 与 geometry demand 顺序

1. Field value/certificate 查询及受理证明完成，固定 Field plan/source bindings。
2. 可构造精确 signal identity 者查询 SignalStore，value hit 单独发布 SignalRef。
3. signal 空间共享仍验证自己的支持域。value hit 不跳必要 rate proof；若已有全部逐点有效值，可直接使用 fine/template refs，不再强求 coarse 合并。
4. 依赖待求值 transient field 的 signal 默认本轮 dirty，不能把 transient index 当跨帧稳定身份。
5. dirty signal rate plan 消费已知 field/geometry/provider bounds；未知只细化该 signal。
6. 缺失 fields 与 dirty signals 的代表形成 geometry input union；每实际 target 最多一个 record，cold mask 合并。
7. GeometryRecord → Appearance missing closures → Lighting dirty signals → Publish/Consume。

完全命中且无其他 dirty consumer 的目标不进 heavy Geometry/Appearance。albedo hit 但 lighting dirty 仍可需要 record，统计按 consumer 区分。

SignalStore 初始保留当前完整 identity 类别，仅缩减真实无关依赖；本次不同时引入未经证明的跨视角 Signal 近似缓存。value cache 与 TemporalFacts-based reuse 分开，不恢复 dense 全分辨率 history 大包。

## 13. 唯一 GeometryRecord：语义完整，物理 hot/cold

当前 45×vec4=720B 固定物化 14 类 center/X/Y 等输入。改为消费者矩阵驱动：

- Hot：重复消费的 position/depth、合法 frame/flags、generation、cold/profile refs。
- Cold：实际需要的 UV sets/梯度、color、tangent、高精度 normal、view/previous/deformation 语义。
- Primitive setup：共享三顶点/coefficient/source，不逐 record 重复。
- 每 record 可有多个冷段，但只有 Geometry owner 填写。Appearance/Lighting 不自行补 barycentric/vertex decode。

热段目标 96B、预算上界 128B；属于待真实消费矩阵核定的物理目标，不是删字段许可。全部旧语义需要时，容量先预留 cold 最坏 720B/record，避免压缩目标掩盖功能损失；最终不得无条件写完整 cold。

保留 center/X/Y finite-difference，不能未经证明把 nonlinear derived input 三值改成 center+解析导数。量化需独立误差验证，初始 cold 用 f32，不为凑热段尺寸牺牲 UV/normal/HDR 精度。

统一 accessor 只做简单地址和已定义解码，不读三顶点。同一 shader 聚合所需冷段，避免每 field 重复随机 gather。

## 14. Direct Diffuse 的最终物理合同

当前 lighting_direct.ts 的 Lambert diffuse 对有限合法输入可写为：

~~~
DiffuseFactor = max(albedo, 0) * (1 - saturate(metallic))
DdirectTransport =
  sum_l(max(N dot L_l, 0) * incidentRadiance_l
        * visibility_l * coatBaseAttenuation_l / pi)
DdirectRadiance = DiffuseFactor * DdirectTransport
~~~

实际 incident/provider 已应用的 visibility/attenuation 不得重复乘。shadow、physical sun、coat Fresnel/view 依赖保留。DdirectTransport 与 Denv irradiance 的 π/颜色语义不同，以 packet semantic 区分。

同步修改 Ddirect 的：

- SignalExecutionProfile dependency mask；
- request key、proof、rate、history/version；
- worker 输出与 publish semantic；
- reconstruct factor×transport；
- direct/AO/environment 应用边界与数值对照。

正常 no-coat diffuse 不再依赖 specularWeight/specularColor/roughness/coatNormal；coatFactor 及 Fresnel/view attenuation 的实际依赖保留。

当前 re_direct_physical 对 diffuse/specular/coat 总 contribution 共用 finite guard。最终可证明有限 profile 使用 factorized transport；不能保证原 guard 等价的异常数值 profile，使用同一个新 lighting worker 的显式 ColoredResidual packet semantic 保留原 guard。该合法异常语义不恢复旧 owner，也不允许普通材质永久落入 residual。

这是实数公式下因子分离，不承诺浮点逐位相同；积累顺序误差进入容差。specular/coat/IBL 原算法不简化。

## 15. Demand、worker 和发布

- target missing-field mask、dirty-signal mask、template source 为主需求；implicit fine 由 lane 推导，不创建全部 field 的宽 request。
- 只有 StableCache admission 创建独立窄请求，完整 key 验证仅发生于对应 identity 类别。
- 同位置多个 miss field 合并为实际 missing closure worker，保留 CSE，不重跑 hit closure。
- Lighting 可共享 geometry/light 数据读取，只生产 dirty kinds，不强制六种 signal 同率。
- 发布单独 reserve/produce/commit，引用在 commit 后消费。
- admission 同 key 冲突不要求所有 transient 求值全局去重；仅一个 Store writer，其余使用自己的合法 transient 值。
- 删除满表扫描全请求流的恢复策略；失败是 cache 不准入，不是画面不完整。
- geometry input mask 不无条件扩大到全材质所有输入。

request、probe、accepted unique、evaluated closure、Store admission 分别统计，不用 workCount 掩盖组织成本。

### 15.1 Store 状态、pin 与退休

状态为 Empty → Reserved → Produced → Published → Retiring；Produced 仅表示 payload 已写，必须由后续 dispatch 提交 Published。弱 CAS 失败不能当作他人完成；同 dispatch 内没有等待 producer 的循环。

key/value/support 在 Published generation 内不可变。新内容必须新 generation，拒绝旧引用；touched/age 等维护字段不改变数值身份。命中和新发布项至少 pin 到本批最后一个消费者完成；消费 batch-local结果/refs后才复用scratch。后续批的维护不得提前驱逐仍被引用的entry。

跨帧 host 资源销毁沿用 trackSubmission/gpuDone；abort 不推进有效历史、不提交未完成内容。u32 identity/generation耗尽时切换完整 namespace并在安全边界重建，不能绕回相同可见身份。原texture/content/LOD/deformation依赖版本与cache slot generation保持分域。

## 16. Reset / overwrite / validity

| 区域 | 初始化规则 | 消费条件 |
|---|---|---|
| frame/batch control、indirect | reset 小块 | count 在完整 payload 后发布 |
| tile mode/coverage | producer 每轮完整覆盖 | 当前 generation |
| cheap address/hot/cold payload | 实际生成项覆盖写 | valid mask + 合法 slot/count |
| proof payload | 受理项覆盖，Unknown 显式状态 | 当前 profile/support/generation |
| persistent certificate known/field mask | 清零或整体覆盖新 mask | 不 OR 到旧 batch |
| geometry/material/lighting mask | 保留 atomicOr 时先 reset 所有可读 leaf | compact 不读过期 mask |
| refs/aliases/queues/results | actualCount 内写，implicit 不写逐项 ref | count/valid 后才能读 |
| request hash/setup dictionary | 首版 reset compact state | payload 非零不等于 valid |
| FieldStore/SignalStore | 独立 state/generation/epoch | 不逐 batch 清整个池 |
| HDR/reactive | 背景/Surface 明确写域 | 每输出像素恰好覆盖 |

首版优先小型 mask/table clear 和覆盖写，generation-tagged hash 非必须首发优化。采用 tag 时处理 wrap、发布顺序、槽位复用、in-flight 生命周期；不能增加热判断后宣称 reset 免费消失。

零工作 batch 的 indirect args 必须写零。最终验证用 poison payload 检查消费者是否依赖被删除的 clear。

## 17. 物理容量与内存账

### 17.1 默认 R 与 batch

初始 desktop profile 目标 R=65,536，即 1,024 tiles；1080p 最大范围 B=ceil(32,400/1,024)=32。GPU active tiles 减少实际 shader 工作，但 CPU 仍编码最大范围合法命令。相对当前 23,296，这是待物理 layout/limits 算出的设计目标，不能硬写 32 保证收益。

若 full-support cold、绑定、workgroup memory 或 program 分区要求更小 R，planner 取真实约束最小值并报告限制项，不为 R 删除材质能力。active compaction 后的 local tile index 必须通过 ActiveTileList 映射回绝对 tile/pixel，不能沿用 firstTile+local 的屏幕连续假设。

### 17.2 512MiB 初始预算

以下是上限分配，非已分配量/稳定 ABI。每个实际 GPUBuffer/Texture 记一次，不能只用 profile 乘法替代真实 layout。

| 类别 | MiB 上限 | 内容 |
|---|---:|---|
| frame/tile plans、active list、control | 8 | 全帧 metadata、indirect、program counters、模板 |
| setup | 48 | local R×512B=32MiB；memo payload 8MiB；目录/refs/对齐等 8MiB |
| candidate address + proof | 32 | 热地址、lazy witness、C≤R/2 proof；不叠三份 dense cert |
| Geometry hot | 8 | R×128B 上界，目标96B |
| Geometry cold | 48 | 最坏 R×720B=45MiB，含profile/对齐；按需写 |
| transient field values | 16 | 最坏 R×15×16B=15MiB |
| transient signal values | 8 | 最坏 R×6×16B=6MiB，f32及语义metadata |
| demand / refs / mixed maps | 32 | 最坏引用/mask/remap/program 分流；不叠21份全量hash/request副本 |
| persistent FieldStore | 128 | key/value/cert/state/generation/管理 |
| persistent SignalStore | 64 | 精确key、signal、管理/history语义 |
| local variation residency | 32 | texture summary/metadata |
| Surface outputs | 24 | 1080p rgba16float HDR+r32float reactive≈23.73MiB |
| retirement / resize / alignment headroom | 64 | 不是额外自由payload池 |
| 合计 | 512 | 本owner全部新增resident成本 |

address/proof 初始分割必须满足字节公式。例如热地址≤96R=6MiB，proof record≤256×(R/2)=8MiB，其余 witness/canonical support/queue 共≤18MiB。单证明不能装入则减少受理项或 fine，不隐含借其他池。该例约束容量，不允许用256B代替完整proof语义设计。

pure fine 可稠密预留 transient values，但不恢复逐field的稠密初始化/lookup/task。数据存在和调度对象数量分开核算。所有 coarse source 来自真实 leaf，geometry union 最大 R；不会为每个 field/signal 独立再分 R 份 record。

### 17.3 物理与生命周期

planner 计算真实 alignment、hash pow2 rounding、绑定切片、program count、precision、last batch、输出与 retired allocations。协商 maxStorageBufferBindingSize/maxBufferSize、storage binding 数、workgroup storage/invocations、dispatch dimensions、uniform offset alignment。

不假设分段 buffer 可用未协商 bindless 数组访问；baseline 128MiB storage binding 可覆盖最大单池，更低 profile 显式分区并计 dispatch。

共享 GPU Scene、TemporalFacts、AO、VSM、IBL 归原 owner，但新版本额外副本计入引擎总内存，不通过改名移账。

64MiB headroom 不足以同时保留整套旧/新 scratch。resize/profile 重建优先复用预留尺寸；确需替换且超预算时，异步等旧 submitted epoch 完成后分配，合并 resize 请求/暂缓新帧。不能在 steady-state 每帧 await GPU，也不能超预算后宣称512MiB。

## 18. Overflow 的完整覆盖与写域

“overflow→fine”必须有可执行位置：

1. 为所有 tile 预留 ImplicitFine 描述及 mandatory output/geometry/field/signal 最坏 slots，不依赖 mixed queue 剩余空间。
2. 先计算 tile/plane 所需 entries，完整 reservation 成功后才发布 Mixed/Uniform mode。
3. reservation 失败发布 Fine；临时写但未提交的 coarse entries 不可消费。
4. 最终 owner map 对每个 field/signal 目标唯一选择 coarse 或 fine，不同时写二者。
5. proof/admission/setup memo 满只拒绝优化，不导致 mandatory pool 溢出。
6. mandatory pool 装下整批最坏状态才允许 R，否则 CPU capacity planning 缩小 R。
7. 不把 GPU count 超范围静默 clamp 丢像素；真实异常标记失败，不冒充成功fallback。
8. 非法数值/几何继续原合法拒绝语义，不伪造 cache hit。

相同最终 worker 处理 fine/coarse 描述，是同一算法不同工作表示，不是旧/新桥梁。

## 19. WebGPU 编码、Bindings 与同步

已核对 WebGPU Resource Usages：compute pass 每个 dispatch 是独立 usage scope。相邻 producer/consumer dispatch 可在同 compute pass，不把 workgroupBarrier/storageBarrier 当跨 workgroup 全局屏障。

- FrameGraph 保留逻辑资源依赖，物理编码可合并相邻兼容 dispatch，不删除图声明掩盖依赖。
- clearBuffer、copyBufferToBuffer、query resolve、staging copy 在 pass 外，不能机械删 end/begin。
- GPU-produced indirect args 使用独立小 buffer；producer 写完后，在后续 usage scope 作为 INDIRECT 消费，不能同时以 writable storage 绑定该 buffer。
- arena→indirect copy 若保留必须结束 pass；直接生产独立 args 也要后续 dispatch 消费。
- 同 buffer 不相交 range 不自动规避 usage-scope 限制，access/layout/alias 单独核对。
- 显式兼容 PipelineLayout；auto layout BindGroup 不跨不兼容 pipeline 复用。
- BindGroup cache key 包含 device generation、layout、资源 identity/generation、offset/size、view/sampler/profile；重建正确失效。
- batch settings 使用对齐 uniform ring/dynamic offset 或现有有序 staging copy；不能同 submit 前反复 queue.writeBuffer 同地址，却假设每个 dispatch 捕获了不同值。
- optional subgroups/f16/bindless/特殊原子不是正确性前提。
- 不新增私有 submit、本帧 CPU work readback 或全局自旋。

dispatch 数建模为：

~~~
D = Dframe + B × (Dfrontend + Dstore + PpublishedPrograms
                  + FproofFamilies + LworkerFamilies + Dcompose)
~~~

GPU 零 count 省 shader 工作，不省 CPU 编码。很多 programs 仍有 B×P 成本，不能宣称 active queue 自动解决。publication 复用等价 compiler programs，避免实例级 PSO；高 program 场景单独计量，不能用 Dungeon 两程序代表通用情况。

生产计时使用少量大 scope；诊断可拆分相同 dispatch 序列采子阶段，两种模式标明，不能将一版诊断开销与另一版生产数据直接比较。

## 20. 具体修改与删除边界

以下为仓库相对路径，按现有 owner 就地演进，不先建通用框架。

| 当前入口 | 重构动作 | 必须保留 |
|---|---|---|
| OEngine/src/render/surface/SurfaceCellClassifierPass.ts | 替换dense编排、整块clear、全family扫描 | FrameGraph真实依赖 |
| OEngine/src/shaders/surface_cell_classify.ts | 删除前序pair、重复成员搜集、lane0来源线性查找 | 独立plane、coverage、parent重判 |
| OEngine/src/shaders/surface_cell_production_facts.ts | publication mask/DomainKey；删除热依赖发现/隐藏decode | 透视/side/source数学 |
| OEngine/src/shaders/surface_cell_lighting_risk.ts | cluster快拒绝、共用有界provider proof | 实际light/VSM条件 |
| OEngine/src/shaders/surface_cell_addresses.ts | candidate/lazy witness，取消144-word必须物化 | 必需过滤/差分语义 |
| OEngine/src/shaders/surface_cell_certificates.ts | 实际候选/profile queue，取消dense证书常态生产 | interval/known/support/residual |
| OEngine/src/render/surface/SurfaceCellGeometrySetup.ts | guaranteed local+bounded memo | 唯一geometry owner |
| OEngine/src/gpu/GpuSurfaceCellGeometryAbi.ts | setup/ref/capacity独立计算 | limits/generation |
| OEngine/src/gpu/GpuSurfaceCellPlanAbi.ts | 模板/树/proof slots，删除dense Workspace合同 | 最终写域 |
| OEngine/src/shaders/surface_field_request.ts、surface_field_lookup.ts | 候选/完整验证分开，active profile | 完整identity、独立value/certificate |
| OEngine/src/shaders/surface_signal_request.ts、surface_signal_lookup.ts | source binding后key，缩减真实无关依赖 | transient不是持久身份 |
| OEngine/src/gpu/GpuSurfaceDemandAbi.ts、shaders/surface_demand.ts | mask/template，限定dedup，删除满表全流扫描 | actual indirect、完整coverage |
| OEngine/src/gpu/GpuSurfaceGeometryRecordAbi.ts、render/surface/SurfaceGeometryPass.ts | 消费矩阵驱动hot/cold | 完整输入/形变 |
| OEngine/src/material/AppearanceFieldIdentity.ts及publication/compiler | dependency/cost/proof profile | 原DAG、witness、CSE、求值 |
| OEngine/src/render/surface/SurfaceLightingWorkPass.ts | Ddirect分离、异常residual、dirty work | 原PBR/IBL |
| OEngine/src/render/surface/SurfaceReconstructionPass.ts | 模板ref、新semantic compose | AO/颜色/π/pre-exposure/reactive |
| OEngine/src/gpu/SurfaceOptimizationCapacity.ts、render/surface/SurfaceFrameResources.ts | 真实layout、R、memo/proof/retire账 | 创建前协商、生命周期 |
| OEngine/src/framegraph/ShadeGPUCommandContext.ts、GPUTimer.ts | 必要的兼容dispatch编码/计时 | 单frame submit、usage scope |

删除无消费者旧 imports/bindings/arena/counters 与 fixture 假设，不为旧 ABI 测试维持第二实现。保留仍使用的数学/helper，不复制“优化版”与原版长期共存。

## 21. 连续实施顺序

本次只形成文档。实施遵循用户2026-10-04最新要求：每阶段实现、每阶段集中检查、通过后再进入下一阶段。Phase0静态核对；Phase1–6各自完成typecheck/build、必要targeted tests及WGSL/真实GPU组件接线检查，失败在本阶段修复；不要求每patch重跑全部测试。临时编译失败/无图仅限阶段内部，必须前移必要consumer使本阶段真实闭合，不通过旧链/adapter/占位值消除错误。Phase7保留整链回归、跨场景/浏览器、连续质量与同条件性能正式验收。每阶段检查清单见当前执行计划§1。

### Phase 0：固定事实与静态账

保存 HEAD/dirty diff、源码/生成shader指纹、资产、GPU/浏览器、feature/camera配置与已有报告。逐项列 buffer producer/consumer/stride/reset/access/lifetime，建立真实 Geometry 消费矩阵与 compiler profiles。

历史比较 refs 89f0a94、15f12f7b、e7296be9 是原计划版本身份，不先验称作可比性能基线；run06 还必须保留 dirty patch。正式比较使用独立 checkout，不在生产建 A/B 桥。

### Phase 1：Publication 与工作表示

实现 dependency groups、DomainRecipe、成本/proof profile、active tile、implicit/uniform/mixed；固定value/certificate/source状态和写域。按producer与直接consumer组成的真实切换单元迁移dense请求/Workspace，删除已被替代的入口；需要后续接线才能检查时，将必要部分前移本阶段，不跨阶段遗留断链。

### Phase 2：Geometry owner 与物理资源

实现bounded primitive grouping、guaranteed local setup、memo、lazy candidate/witness、hot/cold和实际容量planner。删除消费者内完整decode，数学集中唯一owner。

### Phase 3：Field 查询与受理证明

落实candidate→完整验证→独立hit；常量零lookup、transient直接需求、stable UV正式canonical/support路线。证明工作预算、Unknown→child/fine、hash满→transient在发布处保证。

### Phase 4：固定 Field/Signal 层级

删除pair-search，接固定树与直接source map；Field source后再Signal lookup。接provider proof共享和独立信号依赖，normal/ORM/mirror/coat高频不连带其他合法粗率结果。

### Phase 5：实际 worker 与输出

接Geometry union、missing Appearance、dirty Lighting、Ddirect分离、完整Store reserve/commit与cheap reconstruct。fine容量保障和互斥写域真实接线，不使用占位输出。

### Phase 6：调度、reset、生命周期收口

删除payload clear，落实reset表；稳定BG/PSO cache、合法pass合并、uniform ring/indirect；retired memory、resize/camera cut/device loss、publication失效。全链不再引用旧执行模型；本阶段typecheck/build、GPU/lifecycle与短整链smoke检查通过后再进入Phase7。

### Phase 7：集中验证、校准与返工

在各阶段检查通过基础上重跑完整整合回归、数值/覆盖/生命周期、真实GPU消费、跨浏览器/场景、连续画质与同条件性能。错误在新主链修复。成本分类/proof admission校准不能放松错误身份、丢覆盖或恢复旧重协调器。

## 22. 最终验证与失败判据

### 22.1 结构与正确性

- empty/partial/last batch、all fine/hit/miss、overflow、多program、微三角形完整且唯一写回。
- Constant/Default/Zero无probe；ValueHit不重跑其closure；CertificateHit不冒充值命中。
- 同材质不同UV、overlapping sheets、梯度方向、sampler、驻留版本、无关纹理更新、LOD、instance/side分离。
- parent重新判误差；plane转换、near clip、W crossing、normal/tangent/coat cone保守。
- cache和空间近似复合误差有上界，不只验证每层单独合格。
- memo/hash/proof/mixed满不丢工作；mandatory pool合法输入不越界。
- reserve/commit/generation/pin/abort真实consumer链；不读未发布payload。
- poison payload、zero indirect、generation wrap/device reset。
- f32/HDR/70000精度、正常/非有限Ddirect guard、π/AO/coat各一次。
- center/X/Y、UV transforms、skin/morph/previous deformation、Product页缺失完整语义。
- PSO/bindings/workgroup storage不越limit，不依赖optional feature。

### 22.2 三种报告分开

1. Timing：关闭细诊断写入，记录CPU/GPU span/pass sum/Surface scope、clear/copy范围。
2. Detailed：独立帧记录work/bytes/拒绝原因，不混入timing分布。
3. Quality：连续camera path，静止/运动/返回、近远/高低覆盖、normal/ORM/低roughness/coat、AO/VSM/IBL、LOD/纹理更新。

| 类别 | 必须区分的诊断 |
|---|---|
| 前端 | active/empty tiles、leaf touches、dependency groups、node tests |
| 查询 | bucket fetch、实际probe、compare words、support checks、各hit class |
| 证明 | proposed/admitted/completed/Unknown；ops/queries/visits；预算/质量拒绝 |
| setup | tile primitive requests、local builds、memo hits、准入拒绝、跨batch重复 |
| 工作 | raw/unique、exact dedup率、cacheable/direct transient、实际missing closure |
| geometry | need union、hot/cold bytes、input mask分布、无consumer records |
| signal | 各kind fine/coarse/hit/dirty、实际light/DFG/environment/BRDF次数 |
| 资源 | allocation、reset范围、logical writes、spill、retire overlap、BG/PSO创建 |
| 发布 | Store hit/admission/full/reject、单writer、epoch/gen退休 |
| 覆盖 | duplicate/missing、fallback reason、implicit/mixed比例 |

### 22.3 同条件比较

固定 adapter、GPU/浏览器配置、资源/shader build、分辨率、camera path、features、预热/采样长度和热状态，使用独立历史checkout。历史版不支持相同效果时仅比较共同能力子集，另列最终完整质量成本。

覆盖 warm/cold、持续运动、all-miss/失效、满屏高频、微三角形、多材质/多program、强IBL/direct+VSM。各workload报P50/P95、重复独立运行与抖动区间，差异小于波动不能判收益。

结构性失败即使更快也不能完成：整场景默认fine、普通UV cache全关闭、降画质/漏结果、overflow、重复decode、reconstruct重PBR、未记超预算。

时间性失败即使结构漂亮也不能完成：同质量Surface/整帧仍明显落后可比V1/V2，或收益只在静止warm而cold/motion有无法解释的大幅回退。无严格可比基线时只能报告“新方案已测，超越目标未证明”。

不以静态代码预测精确毫秒。报告分已删除操作、实际新增操作、测得收益、尚不能归因四栏。预测失效则按counter在本设计身份/成本上限内返工，不继续叠加通用缓存。

## 23. 替代方案与明确拒绝

| 方案 | 处理 |
|---|---|
| 只删clear/扩batch/加setup | 有价值但不足，未覆盖主要classifier/lookup/proof |
| 所有closure exact wide-key cache | 拒绝，identity/查询可能比求值贵 |
| 所有lookup前全局dedup | 拒绝作为默认，重复率未证明且增加组织成本 |
| value hit跳过全部证书 | 拒绝，数值与空间许可不同 |
| hash/同材质/同UV cell当相等 | 拒绝，错误复用 |
| 无限interval proof寻找最优率 | 拒绝，总成本比最少sample更重要 |
| 深度/normal heuristic替完整支持域 | 拒绝，无证明不放行 |
| 全部未知材质永久fine | 仅局部正确路线，不代表V3完成 |
| 全帧每primitive无界512B | 拒绝，采用local保证+bounded memo |
| 强行64B record/f16全部数据 | 拒绝，完整消费者/误差优先 |
| 所有dispatch合一个kernel | 拒绝，发布/indirect/寄存器边界保留 |
| 恢复旧链/第二submit接中间阶段 | 拒绝 |
| 减阴影/灯数/材质能力拿收益 | 拒绝作为优化证明 |

## 24. 来源、采用与剩余风险

本地方案名：Bounded Surface Frontend（有界 Surface 前端），是既有 Continuity-Domain Signal Sampling 的成本修订，不是某个游戏引擎算法完整移植。

固定来源、阶段映射和核读边界见[来源账本](../porting/next-renderer.md)：

- Forge cd5046893faba2dc7869243873bf01f02a6f0df9，Apache-2.0：VisibilityBufferShadingUtilities.h.fsl，透视/finite-difference。
- Intel CPS 63ad5c1adafbfcc2869a200f50a5ea11f28b4887，Apache-2.0：ComputeShaderTile.hlsl，固定coarse/full、边界拒绝、完整覆盖；其已有GBuffer输入不是本地免费事实。
- OSS 473a59bbcdd30e3366cc567d66a5a97353620d48，Apache-2.0：RenderTaskProcessing.compute，occupancy→task→indirect；不移植Unity/RT/Htex/GI全系统。
- Microsoft DirectX SDK Samples 1ad8f0f6a3e4d9be7e54ca52640ac12b6565ab0c，MIT：ComputeShaderSort11.hlsl::BitonicSort 及 host GPUSort level循环，参考固定64-key局部分组；不引入全帧transpose排序或CPU回读。
- DAIS §3–4、§6、Appendix A与OSS preprint：沿用账本已有核读，本次未重新提取PDF全文。
- WebGPU resource usages/WGSL同步原子模型：dispatch、publication、indirect、绑定/lifetime。

本次重新访问固定CPS源码并核对关键函数，阅读本机固定Forge/OSS/CPS副本相关阶段与README，核查WebGPU living spec的compute usage scope。未构建donor/跑benchmark。复杂实现前按实际修改阶段补核完整源依赖与本地映射，本文不替代该责任。

另核读固定 Microsoft ComputeShaderSort11.hlsl 完整文件、host GPUSort 的level/transpose阶段和根MIT许可。64元素本地适配保留compare-exchange前后的uniform barriers，将host level=2..64合并为同workgroup固定循环；key相等以原lane作确定性tie-break，空lane使用独立valid标记，不能假设合法key永不等于sentinel。MatrixTranspose不适用于单workgroup，不移植它及host下载步骤。此处仅完成来源参考，尚无WGSL或生产GPU证据。

剩余风险的处理：

- proof接受率低：改进publication/variation/域输入，不放宽错误身份。
- lookup仍贵：缩小受理类别、降低必要witness构造成本，检查盈亏，不省必要比较。
- cold gather抵消压缩：按consumer重排流，不恢复独立decode。
- fixed tree漏掉共享机会：按净耗时优化有限模板，不恢复无界域搜索。
- setup memo收益小：保留local保证、缩小/关闭memo admission。
- program多：报告B×P、复用program/binding，不假称零indirect省CPU编码。
- 时间目标失败：按§22返工，“最终设计”不等于“性能最终通过”。

## 25. 本次交付状态

已完成：基于源码/采样形成实现选择、数据流、正确性合同、上限、容量、删除清单、连续执行顺序和最终验收标准。

未完成且未声称：生产源码重构、稳定ABI、新编译/测试/GPU运行、性能收益、四版本同条件比较、完整upstream adoption。

333.md中保留：减少无用clear、压缩工作集、setup复用、稳定bindings/pass编码、Ddirect分离。修正：全覆盖上限不代替实际量；所有footprint不能一概miss-only；value hit非certificate hit；dedup/setup overflow须有数据；classifier不能默认推迟最后。
