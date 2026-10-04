# Surface V3 分类与 Store 修复计划：五步完成生产链，再做同场景复测

> 2026-10-04 后续状态：本页是已执行五步修复的历史计划，原“尚未实施”仅指创建时状态。步骤1–4及后续run06诊断见[历史执行记录](surface-work-v3-classifier-store-repair-progress-2026-10.md)；当前重构改按[有界前端计划](surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md)。新阶段的检查依据当前执行计划和用户最新要求；旧用例不自动转授通过，诊断完成不等于性能达标。

日期：2026-10-04（Asia/Hong_Kong）。状态：**修复设计与执行计划，尚未实施或验收**。

本计划依据用户本次要求：结合最新代码、`G:\我的云端硬盘\web3d\webgpu\temp\333.md` 和 Showcase 的 8 秒诊断，安排 3–5 个连续步骤，每步有相应测试，但不以单步性能提升作为继续开发的条件；最后使用同一个场景示例采集截图和性能数据。本文采用五步。

目标边界沿用[第三版总设计](../next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)与[第一版优化设计](../next-design/surface-work-v3-optimization-v1-design-2026-10.md)，细化[既有执行计划](surface-work-v3-optimization-v1-execution-2026-10.md)的当前返工范围。本文不重启 Phase 0–6，不恢复旧 Surface 链，不把本轮同场景复测等同于原 Phase 7 全范围通过。

## 1. 执行规则：检查帮助定位，不要求逐步变快

1. **五步是一条连续修复链。** 一个步骤可能先增加正确工作量，另一个步骤才让它被共享、缓存或 compact；局部耗时不降甚至暂时上升，不证明整体设计失败。
2. **每步完成相关实现后执行一次必要的定向检查。** 不要求每个 patch、文件或小模块运行 build、browser 或 benchmark。不要求所有历史 tests、evidence、claims、clean revision 或 `verify --full` 才进入下一步。
3. **步骤 1–4 不设性能准入线。** 不规定 classifier 必须低于多少毫秒、某 pass 必须降低百分之几、cache hit 必须高于多少、每步必须提升 FPS。可以记录短诊断，但不能据此卡住后面的步骤。
4. **失败按性质处理。** 已定位的错误引用、越界、数据竞争、能量重复/遗漏和真实编译错误应在新链修复；依赖后续步骤才能消除的问题写清归属，继续必要接线。工具缺失、fixture 超时、消费者尚未齐全、旧测试依赖退休 ABI，也不构成无限重复测试的理由。
5. **中间允许无法完整出图。** 不为了让某步独立可运行而恢复旧桥、临时全率旧链或占位效果。若跨 owner 的 ABI 修改暂时使编译失败，记录错误并在依赖步骤处理；步骤 4 收口和步骤 5 实际采样前必须修复。
6. **最终测试如实报告。** 正常毫秒级是本轮优化目标，不预先保证 16.7 ms、固定 FPS 或固定倍数。第五步仍慢就根据整链数据返工；不能通过降低分辨率、覆盖率、材质功能或调整曝光制造达标结果。
7. **测试授权边界。** 用户本次明确要求“每一步相应测试”，覆盖根 AGENTS 中本范围开发期间不测试的时点规则，仅授权本文列出的必要检查；不会扩大成逐步完整验收。

| 检查结果 | 后续动作 |
|---|---|
| 当前已接通路径的确定性正确性错误 | 修复根因；只重跑受影响用例 |
| 修复跨步骤，当前消费者或最终 ABI 尚未完成 | 记录失败与负责步骤，继续完成相关生产接线 |
| 微型 GPU fixture 超时或编译耗时过长 | 保存阶段、shader 和日志；区分编译/执行/宿主问题，继续独立工作，不无限重跑 |
| 旧 source-regex 测试要求已删除的 coordinator/record 布局 | 更新或删除失效断言，保留独立语义用例；不恢复旧架构 |
| 单步耗时无改善、整体暂时仍为秒级 | 保留诊断，继续下一步，不作为阶段否决 |
| 第五步没有实际截图或完整有效 timing 样本 | 报告未完成与原因；修复后补采，不能写性能通过 |

每步记录只需：修改范围、实际运行的检查及结果、未运行原因、移交后续步骤的问题。不要给未实施内容勾选“完成”。若产生代码提交，沿用根规则的中文提交说明，准确区分已验证与未验证；不在本文额外要求逐步提交才可继续。

## 2. 设计基点与最新代码现状

### 2.1 三种身份不能混用

- **旧诊断运行身份**：`.local/validation/showcase-5173-20261004/report.json` 记录 `c28d0292c7d4416a02b8d501cbecdaa9599be607` 加当时 dirty 修改；不是 clean c28d0292，也不是现在的未提交版本。
- **本文核对身份**：`HEAD 0bc4e68752ab187a1b508f7a1952e6ebe18bec02` 加 2026-10-04 写本文时的工作树。创建本文前有 13 个 tracked 文件修改，以及新 packet ABI 和 GPU fixture 两个 untracked 文件。
- **最终采样身份**：第五步另存实际 HEAD、dirty 列表、diff 和相关源码/资产 fingerprint，不能仅写“master”或引用本文的 HEAD。

旧报告见 [summary.md](../../.local/validation/showcase-5173-20261004/summary.md)、[profiles.json](../../.local/validation/showcase-5173-20261004/profiles.json) 和 [performance-summary.json](../../.local/validation/showcase-5173-20261004/performance-summary.json)。它只有 23 帧预热/准备期间完成的 GPU timestamps，30 帧正式测量没有开始，`accepted=false`。

| 旧诊断项目 | P50 |
|---|---:|
| GPU pass 总和 | 8557.95 ms |
| Surface 分类相关 | 8494.75 ms |
| stage 6：direct/environment specular | 3984.53 ms |
| stage 1：roughness/occlusion/emissive | 3649.19 ms |
| compact representative | 32.96 ms |
| FieldStore publish | 29.62 ms |
| CPU frame 编码 | 9.25 ms |

各项 P50 独立计算，不能相加推出整帧 P50。按旧 profiles 每帧扣除 `Surface/cell classify`、`compact` 和 `publish` 后，其余 GPU 工作的 P50 约 63.57 ms；这只是旧样本拆账，不是新链的性能下限或预测。

### 2.2 当前修改应继续利用，不能假装尚未开始

| 生产入口 | 核对事实 | 本轮继续处理 |
|---|---|---|
| `surface_cell_classify.ts` | 已换成 2×2→4×4→diffuse 8×8；区域并行，内部仍按兼容域分组 | parent certificate 合并、跨 plane 复用、最小状态和有界分组 |
| `surface_cell_group_validation.ts` | 每次候选仍扫描 64 lanes、嵌套 primitive 去重、构造 context、执行字段 bounds | 一次 facts/unique primitive，共享 geometry/field/direction certificate |
| `surface_cell_production_facts.ts` | stage attribute mask、同 context 的 sample 缓存、节点计数局部累计已经存在 | 依赖从 stage 并集细化为候选闭包；跨字段/信号/层级复用 |
| `SurfaceCellClassifierPass.ts` | 已删除 `min(all plane reps)`，改代表并集和字段/信号 demand mask | 完整引用语义、常量/默认/零值、batch 地址、真正 GeometryDemand |
| `GpuSurfaceCellPlanAbi.ts` | plan/map 驱动各 plane 的 source 解析，sample_map 只映射代表像素 | 发布合法引用，避免 hot consumer 重复大窗口扫描 |
| `SurfaceMaterialCachePass.ts` | 冗余显式 FieldStore lookup 路径已删除；publish 已按 record miss indirect | 字段请求、真实 payload/certificate 读取、full-key dedup 与唯一 producer |
| `GpuSurfaceFieldStoreAbi.ts` | publish 改为独立 state CAS | 明确完整准入/发布边界，重复请求、generation 和满表分支 |
| `SurfaceLightingWorkPass.ts` | 开始按 field plan 读取，emissive 从 Denv 移除；Denv 仍是已着色 radiance | irradiance/compose factors、kind-specific key、dirty signal 调度 |
| `GpuSurfaceSignalStoreAbi.ts` | 仍有首 key word 兼任 owner 的写入分支 | 独立 ownership/state、唯一 producer、发布后消费 |
| `SurfaceReconstructionPass.ts` | 实际入口按六 signal plan 合成；添加 E 的旧 compose helper 未被入口使用 | 实际入口读取 E 和 diffuse factors，消除未消费 helper |

已知静态接线缺口包括：lighting planner 未注入所用 packet 常量；`SurfaceCellClassifierProducts.batchTileCapacity` 是必需项但 callback 传入对象遗漏；packet 与 Store 的 spill/owner/semantic bit 含义开始分叉。实施时先重新核对源码，若其他修改已经修复则记录现状，不能重复套 patch。

### 2.3 修正原因分析中的因果关系

`min(rep)` 破坏不同 plane 的合法 source，必须删除，但它位于分类之后，不是 stage 1/6 数秒执行时间的直接原因。修复映射后代表并集可能增加，不能拿旧错误映射下很低的 material/lighting worker 时间预测最终结果。

固定层级也不自动变快：满覆盖且 4×4 全部通过时，旧算法可能四次验证结束，新层级可能执行 16 次 quad 加四次 parent。必须让 parent 消费证书，而不是重复完整验证。混合域仍可能使一个空间节点有多个候选，不能声称每 tile 总共永远只有 21 次验证。

## 3. 最终生产数据流与 owner

```text
Visibility / 已有 Geometry address facts / publication dependencies
  → Cheap Coverage + Identity + Canonical Address
  → Certificate/Value Lookup（仅消费已发布且覆盖请求的 entry）
  → Fixed Hierarchy + Shared Certificate（只处理 unresolved/dirty）
  → Independent FieldRef / SignalRef / ConstantRef / DefaultRef / ZeroRef
  → GeometryDemand Union + FieldMissQueue + SignalDirtyQueue
  → Dedup / Admit / GPU indirect
  → 唯一 SurfaceGeometryRecord 的实际 miss 生产
  → Appearance 的 unique field misses
  → FieldStore payload/certificate publish
  → Lighting 的 unique dirty signals
  → SignalStore payload/certificate publish
  → Cheap Reconstruction + TemporalFacts
  → 既有 HDR / FSR3 / Bloom / Present
```

Lookup 之前必须有便宜地址与足够身份，不允许把 lookup 无条件搬到 Visibility 前面。持久命中需要同时满足完整 key、依赖版本和请求 footprint 被有效域覆盖；hash 只决定集合位置。

| Owner | 责任与边界 |
|---|---|
| Geometry | 当前已有 source/primitive setup 和地址数学；去重 geometry demand；唯一 GeometryRecord producer。classifier 的 address/certificate helper 不新建完整几何恢复链 |
| Appearance publication | 从实际 graph 输出生成 per-field dependency profile、常量/默认值、采样等价类与区间规则 |
| Surface classifier/work | coverage、候选、共享证书、独立映射、队列及 GPU count；不求完整 material/PBR |
| FieldStore / SignalStore | 各自长期资源、完整 key、payload/有效域、generation、容量、准入/退休；不依赖本帧 CPU 回读 |
| Lighting | 原 BRDF、cluster、shadow、IBL、AO provider；独立 signal 物理量和实际依赖 |
| Reconstruction | 引用解析、解包、定义好的乘法与加法、AO/energy、色域和 pre-exposure；不遍历灯、不采材质、不重跑 PBR |
| TemporalFacts / FrameGraph | 保留事实权威和统一提交；consumer 完成后才能复用 batch scratch |

`FieldRef`、`SignalRef` 和 `GeometryRef` 是不同逻辑域，即使物理记录共享一条索引，也不能以该索引强迫所有 plane 同源。`ZeroRef` 只表示数学上的零，如不存在的 coat/signal/E；缺失 roughness、normal、occlusion 等使用各字段原有默认值，不能统统置零。constant/default 可以引用 publication，不因没有 union record 就丢失输出。

## 4. 五步执行总表

| 步骤 | 实现重点 | 对应检查 | 继续条件 |
|---|---|---|---|
| 1 | 独立引用、packet 物理量、发布互斥与明显接线缺口 | 映射/合成、Store 碰撞、实际 shader 编译小用例 | 语义已明确；跨步骤问题有归属，不要求出完整场景或提速 |
| 2 | 最小验证、固定层级共享 certificate、primitive/texture 去重 | 独立数值与边界用例、复用计数、微型 GPU producer/consumer | 证书保守和工作有界，不要求 classifier 时间达标 |
| 3 | expensive validation 前 lookup、有效域与选择性失效 | 冷/热/partial/dirty 命中链和拒绝链 | hit 真正旁路昂贵工作，未完成调度由步骤 4 处理 |
| 4 | 实际需求 compact、唯一 producer、Store 与 consumer 完整接通 | 一次集中编译/build、定向检查、短生产链 smoke | 实际新链可运行并能采样，不要求单步性能下降 |
| 5 | 同一个 5173 Showcase 的截图与整帧性能 | 固定配置静态 timing、独立 counters、静态/运动截图 | 按实际结果报告；失败返工，不预写成功 |

## 5. 步骤一：完成独立引用、物理合同和发布正确性

### 5.1 实施内容

1. 保留现有 representative union；完善 tile/plane plan 的覆盖、mode、group、source 与 batch 地址。删除仍将一个 record 视为所有字段/信号 source 的消费语义，显式传递 `firstTile/batchTileCapacity`，不由 record capacity 或数组位置反推地址。
2. constant/default/zero 与采样 source 分开解析；纯 E/unlit、全部常量、没有 direct light、coat absent 仍完整输出。为常量引用找到便宜的 material/publication 身份，不能为它重新分配完整 GeometryRecord。
3. GeometryDemand 只合并真正需要求值的目标与未命中的 geometry；后续 Lighting 只读唯一 GeometryRecord。Field/Signal 的 source 不随 geometry union 被合并。
4. 在现有 packet ABI owner 内统一 semantic/spill bits、precision、色域和单位；packet flags 与 Store ownership/generation 分开。所有独立 WGSL module 都注入实际使用的定义，不靠另一 module 的字符串声明。
5. **Denv 改成环境 diffuse irradiance**，不带 albedo、metallic 派生的 diffuse reflectance 或 emissive。AO/occlusion 放在定义好的 compose factor 路径；独立读取其细率字段。生产 HDR 合成如下，`1/π`、AO 和能量项各使用一次：

   ```text
   HDR = diffuseReflectance × occlusion × scalarAO × DenvIrradiance / π
       + 可安全分离的 direct diffuse 项
       + 必要的 direct diffuse residual
       + E + Sdirect + Senv + Cdirect + Cenv
   ```

   不能把原 direct BRDF 改成 Lambert 以方便拆分。先保留必要已着色 direct residual 也是最终设计允许的方案；新增可分离项必须从原公式逐项推导并标明依赖。coat/energy 在原生产公式中应作用哪些项就保留哪些项，不能为了合成简洁遗漏。
6. E 由实际 reconstruct 入口解析 field 5 的独立 ref；不要简单恢复“所有 packet 与 E 同 record”的旧 compose。E-only 输出不能因为没有 lighting packet 而被标成无效。
7. 更新 `cell_signal_dependencies()` 与 stage fields：Denv 不再证明已剥离的高频颜色/E；direct residual 和 spec/coat 按真实数学闭包验证。检查 AO footprint 是否由独立 compose 消费，而非粗率 packet 隐含复制。
8. Store state 与 full key 分开；修掉 SignalStore 的 `old.old_value == request[0]` 并发写入分支和 touched-generation 自比较。限定重试，禁止跨 workgroup 自旋等待。age/confidence 每 submitted frame 最多一次推进，epoch 与 publication generation 不能混用。
9. 明确准入、写 payload/certificate、发布、消费的 dispatch 边界。不能仅在同一 dispatch 最后 atomicStore(valid) 就假定其他 word 对其他 workgroup 同步可见。步骤 4 完成全 key dedup 前重复准入也必须保持单 slot 唯一 writer，不能保留已知 race 等待后续优化。
10. 修复已知 callback 属性、binding、packet constants 和跨 shader bit 解释缺口；清除无消费者 helper 与旧 probe 资源。

主要入口：`GpuSurfaceCellPlanAbi.ts`、`GpuSurfaceSignalPacketAbi.ts`、`GpuSurfaceFieldStoreAbi.ts`、`GpuSurfaceSignalStoreAbi.ts`、`SurfaceCellClassifierPass.ts`、`SurfaceMaterialCachePass.ts`、`SurfaceLightingWorkPass.ts`、`SurfaceReconstructionPass.ts`、`SurfaceWorkRuntime.ts`、`GpuAppearancePublication.ts`。

### 5.2 相应测试

- **映射用例**：同一 tile 中 BaseColor=4×4、roughness=1×1、Denv=8×8、Sdirect=1×1；各消费者取得各自 source，而非某个编号的最小值。补部分覆盖、空 tile、跨 batch 和最后不足 8×8 边界。
- **合成数值用例**：常量 E-only；棋盘 albedo × 常量 irradiance；AO=0/1；已着色 direct residual；coat absent/present。用独立解析值核对遗漏和重复的 `1/π`、E、AO、色域/pre-exposure。不要断言旧错误图像必须逐位一致。
- **并发用例**：相同首 word 不同 full key、重复完整 key、同 set 四路碰撞、满表；不同 request 不覆盖，重复请求不共享错误 payload。多 probe 同 frame 不重复 age 衰减。
- **编译用例**：实际生成 lighting planner、heavy worker、reconstruct 与修改的 Store modules，用 `getCompilationInfo()` 和真实 bind group/pipeline 创建检查。字符串正则只辅助检查定义，不代替 WGSL 编译。

复用入口：`OEngine/tests/contract/surface-cell-plan.test.mjs`、`surface-field-store.test.mjs`、`surface-signal-store.test.mjs`、`surface-batch-consumption.test.mjs`；新 `validation/labs/surface-optimization-v1/cell-demand-gpu-fixture.mjs` 是已有但尚未证明运行成功的 fixture，应接到能执行它的宿主，不能只因为文件存在就写通过。合成数值用例需要补充，名称/入口以实际实现为准。

此步不运行 1080p 性能验收。若整链受后续 ABI 修改影响，只检查当前已接通的最小路径并记录待接 consumer。

## 6. 步骤二：把重复完整验证改成共享、可组合证书

### 6.1 实施内容

1. 从实际 Appearance graph 的 per-output closure 发布 dependency profile：attribute mask、field closure、texture sample/footprint 等价类、position/normal/tangent/view 需求、static/dynamic/nonlocal 风险。不要仅通过拼接后的 WGSL 正则决定长期依赖合同。
2. 保留现有 stage specialization，但同 stage 的所有材质/字段并集只用于 pipeline 最大能力，不代表每次验证都构造全部属性。roughness UV-local 候选不生成无关 color、tangent 或 view footprint。
3. cheap facts 阶段每 tile 建有界 unique primitive 与 lane→primitive index；candidate 引用成员集合，不每 plane 重新进行 `member × previous` 去重。未知/溢出按当前关联域细化，不全局清空共享。
4. 用固定空间 hierarchy 组织 16 个 2×2、四个 4×4 和一个 eligible 8×8 节点；1×1 是关联需求的细率 fallback。空间节点内可以有多个兼容域，但用有界域列表/成员 mask 表达，不恢复全 tile arbitrary remaining/shrink 搜索。
5. 建立 frame-local 的 `GeometryCertificate`、`TextureFootprintCertificate`、`FieldCertificate` 与共享 direction/material certificate。字段和信号引用证书；Sdirect/Senv 在最终 provider 判定处分叉，前面的 geometry/normal/view/roughness/F0 不各自从头证明。
6. texture query 按真实 texture identity、sampler/filter/wrap、UV transform/表达式、requested footprint 与 revision 的等价类复用。相同 ORM 的不同 channel 可以共用 RGBA interval；同 texture 但不同 UV/gradient/sampler 不能只按 texture ID 合并。
7. parent 合并 child 的值域、方向界、几何误差和 domain/footprint 支持范围，再执行 parent budget/provider 判定。`all children.safe` 不等于 parent.safe；child relative plane residual 不能直接当 parent relative plane residual。对新 anchor/view/filter footprint 覆盖不到的部分只补必要验证，不能误称简单 min/max 已证明所有新支持域。
8. unknown、奇点、非法长度下界、seam、纹理缺摘要和 shader 浮点余量均保留。失败只细化关联字段/信号；不能放大预算、忽略 normal 风险或以 cheap heuristic 代替原有误差证明。
9. 根据 live dependency 决定 bounded scratch，再安排并行。不要让每 lane 同时携带 `fields[15] + attributes[24] + 大 geometry setup + 所有 texture 状态`。候选/证书跨 lane 读写必须有 uniform barrier；跨 workgroup 依靠 dispatch 边界。
10. 不一次分配 `batchTiles × 21 hierarchy nodes × 64 domains × 21 planes` 的宽证书表。分层复用 live certificate scratch，按实际依赖分块；把新增 metadata/key/state/scratch 全计入原 Surface envelope。必要时协商更小 batch，并同步地址/所有消费者，不在资源创建后静默截断。
11. 诊断计数先 invocation/workgroup 累计再少量全局写，timing 模式关闭 detailed atomics/readback。结构 counters 与 GPU timing 分开运行。

主要入口：`GpuAppearancePublication.ts`、`appearance_field_bounds.ts`、`surface_cell_production_facts.ts`、`surface_cell_group_validation.ts`、`surface_cell_classify.ts`、`texture_local_variation_query.ts`、`SurfaceCellGeometrySetup.ts`、`SurfaceCellClassifierPass.ts` 及相应 ABI owner。

### 6.2 相应测试

- 用独立数学/高精度枚举检查 scalar interval、normal/direction merge、parent plane residual、UV/filter 支持范围；构造“每个 child 合格但 parent 超预算”用例，必须拒绝 parent。
- 覆盖同域跨 primitive、混合域、UV seam、低 roughness、未知 normal、部分覆盖和分母穿零；检查每个覆盖 lane 的最终合法 source 与误差，而不是复制实现的合并循环作为 expected。
- 使用同 ORM sample 的 AO/roughness/metallic 和 Sdirect/Senv 共享依赖用例，核对同证书上下文只构造一次；变换/过滤不同的样本不误复用。复用次数是确定性语义检查，不要求硬件耗时降低多少。
- 检查 scratch 最坏容量、最后 batch、零需求，以及 cooperative write/read；微型 GPU fixture 同时跑 producer 和 consumer，不只导出源字符串。

复用 `surface-bound-specialization.test.mjs`、`texture-local-variation.test.mjs`、`surface-optimization-capacity.test.mjs` 及 `cell-plan-gpu-oracle.mjs`、`appearance-bound-gpu-oracle.mjs`、`cell-address-gpu-oracle.mjs`。现有 reference 是否仍代表目标数学要先核查；更新独立 oracle 的合同，不能使其照抄新 GPU 排程。

可以记录候选/unique primitive/context/texture query 数量与一次短 timing，但不要求 step 2 比 step 1 更快。fixture 宿主缺失或超时保留事实，继续步骤 3 的 lookup/lifetime 接线。

## 7. 步骤三：前置 certificate/value lookup，并按真实依赖失效

### 7.1 实施内容

1. 步骤 2 的 frame-local certificate 先复用，再扩展持久有效域。cheap address 发布 chart/domain、side、canonical level/cell、版本与 requested footprint；在 expensive bound validation 前查询已发布 certificate/value。
2. 将原 classifier 注册顺序拆成实际 FrameGraph producer/consumer 边：cheap facts/address → lookup → unresolved compact → certificate validation/plan publish。缓存 hit 的候选不再先跑完整 validator 才决定 hit。
3. 命中不仅检查一个 admission 标记：读取真实 cached field/signal payload 与有效域，给新请求发布合法 ref。不能只调用 `field_store_hit()` 返回 bool，最后仍从某个 reused record 的旧 fields 取值。
4. 值有效域与证书有效域分别证明。命中值的 anchor/footprint 必须满足当前重采样误差，命中证书也必须覆盖当前 candidate；只有 value hit 不代表可沿用上一帧完整 rate plan。
5. 分开 GeometryRevision、ViewRevision、TextureRevision、Material/ProgramRevision 与 provider revision。纯 view-independent 材质不会因为 camera epoch 一起失效；需要 view 的 signal、几何记录或方向证书仍严格失效。
6. camera exact witness 可以继续服务当帧几何输入一致性，但从持久 UV-local field key 的权威中撤出。primitive/LOD/instance/overlapping-UV sheet/side 的兼容性仍保留；不能为了 hit 放松完整 identity。
7. 按 signal kind 构造真实 dependency key：Denv 依赖环境和 normal/geometry 有效域；Senv 再依赖 view/roughness/F0；Ddirect residual/Sdirect 依赖 direct light/shadow 及各自材料闭包；coat 依赖对应 provider 和 coat 闭包。AO 若放 compose，Denv key 不再绑定 AO；不能全 signal 都 hash env/light/shadow/all-fields。
8. key 的材质版本必须来自实际 FieldRef 所引用的 producer/version，不能继续只 hash union record 本地可能未求值的 19-word cache metadata。对 key 中 hashed dependency digest 明确 exact witness 或发布版本证明，hash 相等不能冒充完整身份相等。
9. miss/dirty/未知/footprint 外请求进入新链相应 unresolved 队列；满表或不能准入仍由本批 transient 正确求值。不能跨 workgroup 等待另一 entry 完成，也不能由 CPU 回读来补本帧调度。
10. persistent payload/certificate 的 publication 替换、eviction/slot reuse、resize、abort、submitted epoch 与在途帧通过既有资源 owner/FrameGraph 管理。复用上一提交已发布内容，禁止读取本 dispatch 尚未完成的内容。

主要入口：`SurfaceCacheIdentityPass.ts`、`SurfaceDependencyEpochPass.ts`、`SurfaceMaterialCachePass.ts`、`SurfaceLightingWorkPass.ts`、`GpuSurfaceFieldStore*`、`GpuSurfaceSignalStore*`、`SurfaceWorkRuntime.ts` 和步骤 2 的 certificate producer。

### 7.2 相应测试

- 同一请求 cold miss→publish→warm hit：hit counter 有记录且对应 expensive validator/material/lighting invocation 没有执行，不以总帧耗时代替旁路证据。
- 局部 field 更新：A/B hit、C miss；纹理/材质版本变化只失效真实依赖。相机缓慢变化时 view-independent field 保留，view-dependent signal 正确拒绝。
- env-only 更新、direct-light-only 更新、shadow 更新、AO 更新分别核对受影响 kind；不能出现“漏失效”或“全 signal 无差别失效”。
- 请求 footprint 在域内/跨域边界、filter/gradient 类别改变、UV seam/side/LOD 改变；用独立合法性判定拒绝误命中。
- entry collision/满表、generation/slot reuse、提交 abort 后重试：不得读到半发布数据；不能把正常满表 transient 当作丢失覆盖。

复用 `appearance-field-identity.test.mjs`、`surface-field-store.test.mjs`、`surface-signal-store.test.mjs`、`surface-history-binding.test.mjs` 和 FieldStore GPU oracle，补 certificate hit bypass 与 kind-selective invalidation 的实际 GPU 用例。命中率和移动相机时间用于诊断，**不设命中率或性能门槛**；完整 dispatch 压缩可继续在步骤 4 完成。

## 8. 步骤四：实际需求调度、唯一 producer 与完整生产接线

### 8.1 实施内容

1. capacity、activeCount、missCount、dirtyCount、uniqueProducerCount 用不同语义参数；`recordCount=layout.sampleCapacity` 只表示容量，不再一路当请求数量。CPU 编码固定有界 batch，实际数量由 GPU 决定。
2. 形成实际 `GeometryQueue`、逐字段 `FieldMissQueue` 与按 kind 的 `SignalDirtyQueue`，每条需求携带最终独立引用。Geometry 只 union/dedup 未被命中满足的需要，不能因为某字段 miss 使所有 signal 全部重算。
3. FieldStore request 按 requested field 与 full identity 去重，只有唯一 producer 求值/准入/publish；其他 request 引用其已发布结果。Appearance 可以按有限 program family 合并重叠字段闭包，但不为省 dispatch 恢复整 record 全字段求值。
4. SignalStore pack/publish 消费真实 dirty/producer 队列，删除 `sampleCapacity × 6` 全扫再跳过的生产路径。相同全 key 只发布一次，不让相同首 word 的多个线程并发写。
5. Lookup/admit → evaluate → publish → consume 的顺序进入 FrameGraph 真实资源依赖。state=RESERVED 的 request 在后续 publication 之前不可被 hot consumer 读取；无全局 spin，未准入的值走同一新链 transient ref。
6. 对 bounded set/full、queue overflow、certificate scratch exhaustion、precision spill overflow 给出明确处理：选择更细的关联需求或本批正确 transient/fine 求值；不能悄悄截断覆盖、错误借用 entry 或以 NaN/Inf 标 valid。容量本身无法容纳完整 negotiated profile 时在创建资源前拒绝/减小 batch。
7. Reconstruction 按独立 plan/ref 解析材料 compose factors、E 和 signals；固定 grid 用公式/已发布 anchor，不每像素为每 plane 反复扫描整个 8×8 支持域。masked remap 保持有界；相邻像素共享同 source 时可组内复用读值，但不为此增加额外完整帧中间 plane。
8. 保留完整 TemporalFacts 和 pre-exposure/working-color 合同；direct/env/spec/coat 默认不合并为通用 radiance 源。背景、纯 E、zero signals、部分覆盖输出有确定语义。
9. 删除无 consumer 的旧 pack、冗余 lookup、record-only metadata、scratch/helper/binding 和对应 stale tests；长期 Store、batch scratch、frame outputs 分开 accounting/retire。只删真实被替代的代码，不恢复历史 retired renderer。
10. 审计最终资源 usage、binding count/size、uniform layout、indirect offset/count、uniform barriers 与 batch scratch alias 顺序；仍是一条 renderer、同帧统一 encoder/submit，无本帧 GPU→CPU→GPU work 控制。
11. 更新实际 diagnostics/metrics，让 classifier、address/lookup、dedup、queue、Store maintenance、publish、reconstruct 和 batch 开销进入 Surface 总成本。不要只保留 heavy worker 时间；计数器仍与 timing 分离。

### 8.2 相应测试与集中收口

此步安排一次集中检查：

```powershell
npm --prefix OEngine run typecheck
npm --prefix OEngine run build
npm --prefix OEngine run build:test
```

随后只跑本轮改动的定向测试。现有 `.mjs` 多数导入 `.test-dist`，源码改动后不能拿过期编译产物运行；`build:test` 是这里的测试准备，不额外要求每个小 patch 重建。步骤 1–3 需要这类测试时也可仅生成其必要产物，并按 §1 记录跨步骤编译缺口。

- **实际工作检查**：active=0、所有值 hit、一个 field miss、一个 signal dirty、重复 full key、全 miss/混合域和末 batch。检查 GPU count/indirect 与实际 producer 相符、disabled/zero 不执行，无 capacity-driven Store 扫描。
- **完整小链**：真实 production publication→classifier/address→lookup→geometry/material/lighting→reconstruct，320×240 或更小即可，运行冷/热及一次材质/provider 改变；pipeline 编译和真实 bind group 都覆盖。它是接线 smoke，不是提前执行第五步的 1080p验收。
- **生命周期/精度小集**：scratch 跨 batch 复用、resize 往返、提交 abort/slot reuse、HDR spill 边界和满表 transient。测试碰到实际新问题才扩展，不要求全浏览器矩阵。
- **计量检查**：`surface-v3-timing.test.mjs` 与 Showcase `BenchmarkMetrics` 的相关现有测试，确保相同帧的重复 batch 标签先累计，Surface 总成本无遗漏；percentile 按帧再算。

优先复用 `surface-batch-consumption.test.mjs`、`surface-frame-resources.test.mjs`、`surface-optimization-capacity.test.mjs`、`surface-history-binding.test.mjs` 和 `validation/labs/surface-optimization-v1/production-cell-fixture.mjs` / `run-production-cell-browser.mjs`。宿主当前默认设置要按新 ABI 更新；现有 standalone fixture 不自动等于 Showcase 成功。

真实编译错误在新链修复后再进入实际最终采样。**进入第五步只要求新链可以采样，绝不要求步骤 4 的帧时间已低于固定 ms 或比步骤 3 快。**

## 9. 步骤五：同一个 Showcase 的截图与整帧性能复测

### 9.1 原场景与运行身份

地址保持：`http://localhost:5173/demos/14-integrated/next-renderer-showcase/`。若用户服务仍在 5173，先核对它实际加载新源码/构建和资产；不能访问同 URL 就假定版本正确。需要启动测试宿主时使用同一示例和相同配置并记录实际地址，不能改成轻量替代场景。不要未经必要性判断重启用户已有服务。

| 条件 | 复测设置 |
|---|---|
| 场景 | `examples/assets/three/rendering-lab/dungeon_warkarma.glb` 对应的现有 Dungeon 示例，核对实际路径/资产 |
| 原资产 SHA256 | `cac0fc8c16d107e7ac4e69efde89c2cb6ef4bc66c34456a4dd0923218e5aafb1`；不相同就明确差异 |
| GPU | 优先同 GTX 1650 Ti，确认非软件 fallback；记录驱动、浏览器、adapter 信息 |
| 输出 / 内部倍率 | 1920×1080、DPR 1、internalScale 1 |
| 功能 | AO/FSR3/Bloom 开；VSM/jitter 关；曝光 4；其余 HZB/cone/SSE/太阳与纹理上限使用旧示例配置并保存 conditions |
| 主性能相机 | overview、coverage=preset、distanceScale=1、锁相机、trajectory=static |
| 主性能口径 | `surfaceMode=timing`、counters=false；至少 8 帧预热和 30 帧实际测量 |
| 浏览器方式 | 优先复用旧报告的独立 headless Chrome 方式；版本变化如实记录 |

在 `conditions` 保存 camera transform/view-projection、visible coverage、太阳/provider 参数、材质/资产 publication、实际内部尺寸。`preset` 不能悄悄改成 low coverage；如果校准代码改变相机距离，要记录其实际结果并解释可比性。GPU 温度/功耗/频率能取则记录，不能取得则标未知，不把热状态未知当作禁止完成截图与诊断的门槛。

最终运行前固定实际修复版本身份。dirty 状态允许采诊断，只要保存 diff/fingerprint；clean revision 不是本轮完成采样的前置条件。

### 9.2 实际运行顺序

1. **启动与冷态记录**：真实启动场景，记录 scene load、shader/pipeline compile 与首帧阶段；采默认初始相机截图。冷启动耗时与稳态 frame time 分开，不把编译时间记作每帧 GPU 时间。
2. **静态 timing 主采样**：先切 overview 固定相机，按原请求预热 8 帧、等待现有驻留准备、采至少 30 帧；仅保留实际完成 GPU timestamps 的测量帧，不把预热/准备帧补进正式样本。成功后可增加到 60–120 帧观察 P95，但不强制多轮 120 帧阻止结果交付。
3. **短 detailed 诊断**：同相机另采一组少量帧，核对 candidate/certificate/query/hit/miss/producer/bytes 等实际计数。detailed 模式有额外 atomics/readback，不能与 timing 主采样混算，也不要求它和 timing 的耗时相等。
4. **截图**：保存同 overview 的稳态静态截图与至少三帧连续截图；再做短 `orbit-return` 运动序列，截图包含移动、转向、显露区域和回到相同相机后的帧，注明帧号/相机。默认相机和 overview 不构成前后画质对照。
5. **补充小用例**：在同示例中检查一次 resize 往返或 camera cut；纯 E、high-frequency albedo、normal/roughness、coat 等步骤 1–4 fixture 的结果一并引用。若另做 VSM-on，单独配置/单独报告，不替换 VSM-off 的原条件主采样。
6. **结果汇总**：生成新报告和原始数据，明确成功、慢、失败、未完成与异常，不覆盖旧报告。

既有 `.local/run-user-showcase-test.mjs` 可作为请求/浏览器启动参考，不能原样重跑覆盖旧目录。实施时把输出路径参数化或复制到本轮专用 runner；CLI/参数以实际新增入口为准，不在文档虚构一个尚不存在的命令。主采样请求复用其 `frames=30,warmup=8,view=overview,coverage=preset,distanceScale=1,lockCamera=true,counters=false,surfaceMode=timing,trajectory=static,vsm=false`。

当前示例 `main.ts::renderFrames()` 有 120 秒 batch timeout。若仍慢，先记录停在哪个阶段和已完成帧；必要时在诊断 runner/宿主明确调整有限等待预算，不能只延长外层脚本却忽略内层 timeout。测试等待分段打印进度，不能无限挂起。增大 timeout 只帮助取得诊断，不能被写成性能修复。

### 9.3 必须交付的截图和数据

新目录建议：`.local/validation/showcase-5173-surface-repair-YYYYMMDD-HHmm/`，使用本地 Asia/Hong_Kong 时间命名，避免覆盖 `showcase-5173-20261004`。

- `summary.md`：条件、代码身份、结果、瓶颈、截图索引、未完成项。
- `report.json`：浏览器/adapter、实际 URL、HEAD/dirty/diff fingerprint、资产 fingerprint、错误和 device-loss、准备阶段、完成状态。
- `capture.json`：完成的固定 capture 请求、conditions、实际 measurement frame range；未完成则明确缺失。
- `profiles.json`：原始逐帧 CPU/GPU 时间和 timestamps，保留 batch 标签。
- `performance-summary.json`：整帧 GPU span、GPU pass sum、Surface total、分类/lookup/Store/geometry/material/lighting/reconstruct 的逐帧聚合后 P50/P95、样本数、异常数。
- `detailed-counters.json`：独立 detailed 采样的实际需求/证书/命中/工作/容量及可用状态；新增指标未接入就注明 unavailable，不能凭 allocation size 推算流量。
- 截图：默认初始相机、固定 overview、overview 连续静态帧、运动/显露/返回帧；每张注明条件和帧号。失败时保留失败截图，但不把 loading/黑屏当成功出图。

截图由真正的生产 Showcase 输出，不由 synthetic fixture 图片替代。检查主要材质/几何、UV seam、E、diffuse 能量、normal/spec/coat 和时域闪烁；无需在本轮立刻完成所有 AAA 场景矩阵，发现明显错误应返工。

### 9.4 怎样比较，怎样报告“8 秒是否解决”

旧 23 帧是预热/准备诊断，新固定测量是另一采样范围。因此可以报告“旧诊断 8560.61 ms GPU span，新固定采样 X/Y ms”，但不能据此直接宣布严格同条件的提升倍数或四版本验收通过。

如果需要严格 before/after，使用保存了实际 dirty patch 的独立旧 checkout，以相同相机、功能、准备/计数器状态与测量口径补采；不能仅 checkout clean c28d0292 或 clean 0bc4e687 就声称还原了旧运行。旧快照不能还原、旧采样再次超时或工具不可用时，保留旧诊断并说明限制，不阻止交付新截图和实测数据。不得在生产链加旧/新运行 switch。

最终结论分别写清：

1. 新链是否真实出图、有没有已知正确性/编译/GPU API 错误。
2. 主 timing 的真实整帧与 Surface P50/P95、完整样本数，classifier 是否仍占数秒。
3. 当前主要瓶颈在哪里，是否需要继续整链返工；“降到数十/数百 ms”和“达到目标可交互帧时间”不能混写。
4. 旧报告的可比范围、温度/驻留/版本差异，以及尚未验证的功能。

不预设每步提升比例，不以某一个 pass 变快代替整帧结论，不从本轮结果自动提升所有 claims/adoption。

## 10. 来源与本地方案边界

来源账本见 [next-renderer.md](../porting/next-renderer.md)。本计划延续具名本地 **Continuity-Domain Signal Sampling**，证书复用与有效域组合是本地扩展，不宣称现有 donor 已实现整个 21-plane/WebGPU 主链。

| 来源 | 固定身份/入口 | 用途及未覆盖部分 |
|---|---|---|
| [Intel CPS](https://github.com/GameTechDev/DeferredCoarsePixelShading/blob/63ad5c1adafbfcc2869a200f50a5ea11f28b4887/ComputeShaderTile.hlsl) | `63ad5c1adafbfcc2869a200f50a5ea11f28b4887`，shader Apache-2.0；`RequiresPerPixelShading/ComputeShaderTileCS` | coarse/full 与覆盖、组同步参考；它先读 GBuffer，不提供本地前置材质证书或跨帧证书缓存 |
| [OSS task 源码](https://github.com/WeakKnight/real-time-seamless-object-space-shading/blob/473a59bbcdd30e3366cc567d66a5a97353620d48/ObjectSpaceShading/Assets/Shaders/Resources/RenderTaskProcessing.compute) | `473a59bbcdd30e3366cc567d66a5a97353620d48`，Apache-2.0；`RenderTaskPrepare/RenderTaskIndirectDispatch` | occupancy 到实际 task/indirect 边界；不照搬 Unity/RT、Htex/GI 或宣称完整 Store/certificate donor |
| [Intel GPU Pro 7 配套说明](https://github.com/GameTechDev/DeferredCoarsePixelShading/blob/63ad5c1adafbfcc2869a200f50a5ea11f28b4887/README.md)、[OSS 作者资料](https://github.com/WeakKnight/real-time-seamless-object-space-shading/blob/473a59bbcdd30e3366cc567d66a5a97353620d48/README.md) | 同上固定 revision；既有论文/详细资料检索范围沿用账本 | 低频分离、对象空间缓存研究依据；本文未运行 donor benchmark，未借用其收益比例 |
| [WGSL 2026-09-21](https://www.w3.org/TR/2026/CRD-WGSL-20260921/#atomic-builtin-functions) | 固定公开规范快照 | atomic relaxed ordering、barrier scope 与 publication 的 API 约束，不是渲染算法 donor |
| Forge、现有 Geometry/Appearance/BRDF/IBL | 沿用账本原 pin、许可与具体映射 | 复用已需数学和 owner；不新增第二几何恢复者或缩减原 PBR |

本文重新访问了上述 CPS shader、OSS task shader、README/OSS license 与 WGSL 规范。OSS 固定 revision preprint 的本次 web 提取失败，未声称重新核读论文全文；保留账本既有研究范围。进入复杂证书合并/跨帧有效域实施前，应补核读实际相关源码、论文与详细技术资料，向账本追加源函数→本地阶段、输入输出、不变量和降级映射；不存在完整 donor 的部分继续明确为本地算法。

未选择的方案：只把 lane 0 大 validator 复制到更多 lane；固定 hierarchy 但 parent 完整重算；放宽误差冒充优化；21 refs/pixel dense buffer；全容量 Store publish；恢复旧 full-rate renderer；只延长 benchmark timeout。这些都不能单独兑现本轮完整目标。

## 11. 本文创建时的实际验证状态

已完成：读取最新源码与 dirty diff、现有设计/执行/来源记录、测试入口、Showcase capture/runner 配置，创建本计划。

未运行：生产代码修改、typecheck、build、targeted tests、GPU fixture、browser、截图和新性能采样。本次请求是创建详细修复步骤文档；上述检查是后续按五步实施时执行的工作，不能提前记为通过。

文档核对只检查路径/链接、五步依赖、测试范围、旧/新测量身份和非性能门槛表述；不把文档存在视为实现完成。
