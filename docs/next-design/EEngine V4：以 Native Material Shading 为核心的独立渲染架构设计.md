---
id: next-design/eengine-v4-native-shading-design-2026-10-07
state: history
supersededBy: ./eengine-v4-native-shading-2026-10.md
---

> 2026-10-07 V4 authority 切换：本文保留当时的提案、决定或实施记录，仅供历史追溯。正文的“current / 当前 / 必须 / 已完成”均属原快照，不再定义未来生产架构；其中性能结果、失败和未验证声明不改写。唯一当前依据见 [V4 authority](./eengine-v4-native-shading-2026-10.md)，文档切换不表示代码已切换。

# EEngine V4：以 Native Material Shading 为核心的独立渲染架构设计

日期：2026-10-07。性质：独立设计提案，尚未实施、尚未进行 V4 GPU 测量。本文的 `current` 表示这份提案正在使用，不表示已替换生产实现、执行计划或 workstream。设计不以当前 R3/R4 Surface 合同为前提；源码核对基于 `b69a0a60`。只保留能在新成本模型下成立的资源 owner、数学与资产能力。

**结论：推荐 Visibility + GPU 工作分类 + native 材质程序，以 fused opaque shading 为默认，以有限 compact resolve profile 支持确实需要跨 pass 的算法。删除通用 GPU 材质解释器、全局 Closure Cache、六路全屏 Signal History 与 Surface 中央调度系统。**

这不是“所有东西融合成一个 shader”。材质求值与普通直接光融合，GI、反射、reservoir、透明、天空、重建保持各自所有权。扩展通过具名的数据产品发生，不通过扩展一个全局 Surface Work 协议发生。也不承诺昂贵工作对像素数次线性：先建立最快、完整、可预测的 full-rate native 路径，再按实际盈亏选择局部优化。

本次没有 GPU benchmark。第 11 节给出的高 coverage 普通复杂 PBR 中心估算约 **7.6 ms**，合理开发假设为 **6–10 ms**；复杂材质约 **11–18 ms**，多灯密集重叠约 **17–28 ms**。这些是具备明确输入的规划区间，不是测量、不代表整个 renderer，也不能由历史缓存负收益推导出来。GTX 1650 Ti 上 AAA 效果全开、复杂场景 native 1080p/60 不应成为可承诺目标。

## 0. 阅读方式与事实分级

- §1–2：源码与历史审计；哪些批评被证实，哪些没有足够证据。
- §3–8：三路线比较、推荐数据流、native compiler、binning、单像素过程与 SurfaceAux。
- §9–13：高 coverage、带宽、可重算成本模型、盈亏平衡和 4 GB 预算。
- §14–18：WebGPU 能力、AAA 接线、校准方法、owner 和质量要求。
- §19–22：文件级保留/删除地图、实施顺序、风险与来源。

| 标记 | 本文含义 | 不代表什么 |
|---|---|---|
| 源码事实 | 本次读到的特定 revision 的实现或 ABI | 不证明运行到了这个分支 |
| 历史诊断 | 已有本地 JSON 中记录的结果，本次重新计算摘要 | 不等于重跑、不等于当前 HEAD、不等于可信场景总帧时 |
| 模型 | 显式设定的 workload、有效吞吐和公式 | 不等于硬件保证或实测 P50/P95 |
| V4 决策 | 本提案建议实施的合同 | 不表示已有生产 consumer |
| 待验证 | 能改变路线选择的实验 | 不以“以后优化”掩盖本路线的可行性缺口 |

文档依赖路径用于提示何时应重新检查本提案中的源码判断；它们不是 V4 实施证明。重算脚本：[eengine-v4-cost-model.mjs](../../tools/analysis/eengine-v4-cost-model.mjs)。运行 `node tools/analysis/eengine-v4-cost-model.mjs`，不依赖 GPU，也不会产生性能证据。

## 1. 对历史失败的独立判断

### 1.1 版本名称不能代替实现审计

用户给出的 V1/V2/旧 V3/新 V3 是有用的思想分类，但仓库不是四个干净、互斥的实现快照。`3b4b8794^` 的 `sparse_shading_resolve.ts` 已有 native specialization、直接 HDR 写出和按需求生成 aux；不能将早期代码概括为“从未有过 native”。`7b8d9f95` 的 `AppearanceCachePass.ts` 已使用缓存并生成 13 层 `rgba16float` 全屏字段，不是纯粹轻量 V2。

尤其值得警惕：该 revision 的 `SparseLightingPass.ts::main` 虽对 diffuse 输入取 2×2 锚点，仍为每个 pixel 执行 BRDF 并写 HDR；`field3` 当时还把一个 `.x` 扩成 RGB，灯光方向也是 shader 常量。这个快照不能作为同质量 sparse lighting 的完整性能对照。**名称、pass label、测试通过与算法真实工作量必须分开。**

### 1.2 四类失败分别发生在哪里

| 思想世代 | 真正有价值之处 | 主要失败或局限 | 归因 |
|---|---|---|---|
| Direct pixel | 最终 winner 直接求值；覆盖完整；管理税小 | 大面积高代价材质、重复取几何、较差 locality 会随 P 增长 | 主要是成本与硬件映射问题；O(P) 不是算法错误 |
| Signal rate | 不同辐射分量有不同频谱；昂贵 lighting 可独立降低采样率 | 若材料/几何已经全量写出，前端成本不变；低频输入不等于少执行 BRDF | 粒度选择、端到端成本归因及部分历史实现不完整 |
| Proof/tree/cache | 明确误差、身份、失效与复用边界 | 证明、查找、树遍历、多个 Store 和发布协议先于有用工作，低收益场景不能摊销 | 经济模型先失败，继而造成运行时抽象与带宽问题；不是所有复用算法均错误 |
| Typed Tape + Cache/History | 图依赖、频率抽取、liveness、模板/实例分离可继续使用 | 动态解释阻碍寄存器标量化和优化；全局 cache/history 将节省的少量算术换成大量内存与调度 | 执行表示、owner 膨胀、未以 exclusive saved work 定价 |

`14c17078` 的 `SurfaceWorkRuntime` 实际持有 classifier、demand、geometry、reconstruction、publisher、dependencyEpoch、fieldStore、signalStore。当前版本改了算法但仍持有 coverage/coherence/cache nomination/cache publish/lighting/reconstruct/history/radiometry 等责任。问题是数据与决策集中，并非类名或文件行数。

### 1.3 本次可核对的历史数字

本地历史报告 `.local/c-repair/cache-cost-production.json`：

- build source SHA256：`1ee444f0f49051631c1417a49d70de5b37b7cf4a6c6115885020da31accb3b82`。
- 输出 SHA256：`0700ee89ad6b521377a6cd76506b36b8f99bb06a4462e6518dcd04a1a3b26176`。
- 入口：`OEngine/tests/oracle/surface-work-gpu.mjs::runSurfaceClosureCacheCostGpuOracle`，1920×1080 `closure-cache` fixture。
- 将每个 timing 内全部 `label.startsWith("Surface/")` 的 GPU pass 相加：direct 两个非诊断样本约 **27.54 / 27.38 ms**；cache 最后一个非诊断 warm 样本约 **59.47 ms**。这是约 **2.17×** 的 Surface pass 合计。
- 最后一次详细诊断有 **1,184,706 closureHits**；计数关闭的 timing 样本不能把其零计数解释成真实零命中。不同帧的计数与时间不能拼成精确 hit-time 曲线。
- direct active 分配 **438,085,360 B = 417.79 MiB**；cache **521,415,664 B = 497.26 MiB**。这不是全 renderer 的 VRAM。
- 报告 adapter 为 NVIDIA/Turing/hardware，description 为空；仅凭这个报告不能确认具体是 GTX 1650 Ti。Chrome 154。冷帧与诊断帧显著更慢，不混入 warm 比值。
- 以上合计包含 Surface 维护标签，但不包含 `Temporal Facts/resolve`、Visibility、VSM、未命名 pass；因此仍不是完整 frame cost。

另一份 `.local/c-repair/cost-lookup.json` 中，standard/direct warm 约 51.33 ms、generic/direct warm 约 97.13 ms。这两个 fixture 不能自动视为等价表达式，**不足以单独证明 VM 相对 native 的纯执行税**。源码 `appearance_exact_dag.ts` 的动态指令循环、opcode switch、逐 component/point 遍历确实给出了可信风险机制；纯税仍需等价 graph、相同纹理/梯度/输出的控制实验。

“旧 V3 管理几百 ms”本次没有重新建立同质量、同硬件、同场景的历史测量链，不把该口述数字写成已验证事实。读到的协调器和 Store 链说明风险存在；V4 不需要先证明每一代都完全失败才能停止这些设计。

### 1.4 需要保留的经验

1. 先比较总耗时，再解释 hit、reused pixel、dispatch 数。
2. 成本模型只能计入真正消失的工作；查 key 之前已完成的 geometry/material 不能再算作 cache 节省。
3. 混合频率要按真实依赖划分，不按 shader 函数名字划分。
4. O(P) cheap classification 可以接受；O(P) 大身份、证明、全局 hash 不能无条件常驻。
5. GPU 上的间接寻址、寄存器生命周期、纹理 locality 比 CPU 类结构更直接地决定性能。

## 2. V4 的目标与非目标

### 2.1 必须成立

- GPU Scene → VG/Visibility → 着色 → HDR 的单一生产路径；不保留旧 renderer 的 A/B 兼容桥。
- 一个 frame encoder/queue 提交链。允许多个 pass 和 dispatch；不要求固定几个命令。
- CPU 命令主要随**已发布 program/binding profile**增长，不随可见 pixel 或材质实例逐个增长。
- 页面 residency、对象生命周期、motion、材质语义完整；没有 silent overflow 或永久 fine/miss 的伪成功。
- 去掉复用、VRS、ProgramPage 后仍有完整可用的 native 基线。
- 新高级效果可以增加自己的资源和 pass，但不要求 Surface 获得新的通用 identity/history/proof 类型。

### 2.2 明确不承诺

不承诺任意 custom graph 便宜、不承诺数万 unique programs 仍是几十条 CPU 命令、不承诺 WebGPU 自动等价于 bindless Vulkan、不承诺所有高 coverage 场景次线性，不承诺 4 GB 机器 AAA 全开 native 1080p/60。

性能上限由内容、硬件、API 与工程共同决定。V4 的目标是让普通路径成本接近真实求值，不再让复用管理成为主导。

## 3. 至少三种候选路线

比较范围：opaque 可见面至 HDR；相同材质、照明与画质。透明另算。A/B 共用 Visibility；C 的 raster/overdraw 差额必须计入比较，不能只比较最后一个 shader。

| 维度 | A：Visibility + native compute fused | B：Visibility + compact material resolve + deferred lighting | C：GPU-driven Forward+ raster specialization |
|---|---|---|---|
| 工作 | 分类后 reconstruct/material/light 一次完成 | reconstruct/material 写紧凑 GBuffer，lighting 再读 | vertex/fragment 原生着色，cluster light loop |
| 跨 pass 字段 | 默认无 material fields；仅按需 aux | 常规 24–32 B/pixel 材质结果 | 与 A 接近；透明更自然 |
| GPU 优势 | 只 shade winner；program locality；最少 mandatory roundtrip | lighting 可独立组织、控制寄存器；ReSTIR 接入简单 | 插值/导数由 raster 硬件承担；无 opaque binning |
| GPU 风险 | reconstruction、binning、mask 空 lane、寄存器压力 | GBuffer 带宽、复杂 closure 表示膨胀 | overdraw、quad/helper 浪费、微三角形、draw/pipeline 粒度 |
| 材质自由度 | graph→WGSL；任意支持的图 | 材质必须可编码进选定 closure 或进入专用 extension | graph→fragment；资源/排序/透明语义另管 |
| WebGPU | indirect compute 有；GPU 不能选 pipeline；显式梯度 | 同左，但 lighting 绑定与 source 更短 | 无 mesh shader / 通用 GPU multi-draw 提交保证；draw 组织更难 |
| CPU 命令 | O(已发布 program×binding 配对)，不是 O(instance) | 材质端同 A；加少量 lighting | O(raster bucket)，WebGPU batching 设计决定是否滑向 O(draw) |
| 最坏情况 | 高熵程序导致 masks 稀疏；native 源码过大 | 材质扩展与内存流量失控 | 像素着色过度执行，细碎 draw，alpha 层叠 |
| 扩展性 | 很好，但必须明确算法边界产品 | 很好，代价是每帧写回 | 很好，尤其透明；不自然提供 VG winner 解码入口 |
| 工程难度 | 编译器、资源绑定、binning | 上述 + closure 编码和 lighting 分阶段 | VG raster、bucket 管理、fragment permutations |

### 3.1 同一 high-coverage workload 的数量级比较

第 11 节 workload：1.970 M visible pixels，12 次 filtered query/pixel，1800 ALU-equivalent/pixel，8 个平均有效局部灯，含普通阴影采样但不含阴影生产。以下是**模型差额**，不是成熟引擎 benchmark。

| 项目 | A | B | C |
|---|---:|---:|---:|
| shading 有效总流量估算 | 264 B/visible pixel | A + 48–64 B material roundtrip；扣除与 aux 重合字段后可更低 | 每次 fragment 约 220–250 B；乘实际 shading amplification |
| 全帧对应 MB | 520 | 615–646 | amplification=1.05 时约 455–517；1.6 时 693–788 |
| 材质额外存活分配 | 0 | 47.5–63.3 MiB，全屏分配 | 0 |
| 分类管理 | 0.6–2.1 ms 假设 | 接近 A | 无 opaque pixel binning，但增加 raster/draw 代价 |
| shader 寄存器 | geometry/material/light 连续，风险最高 | 可缩短生命周期，可能提高有效 ALU throughput | fragment 也会因完整 light loop 增压 |
| 预计区间 | 6–10 ms | 7–12 ms；A spill 严重时可优于 A | raster 条件好约 5–9 ms；amplification 1.6–2.5 时约 9–18 ms |

C 的范围包含相对 A/B 的 opaque raster 差额估计，不代表重做完整 VG 的精确计时。硬件 early-Z、prepass 和排序会改变 amplification，不能直接用几何 overdraw 等同实际 fragment 执行倍数。

### 3.2 选择

**选 A 为默认，B 为有明确算法需求或实测寄存器问题的有限 execution profile，C 保留为透明/特殊 raster pass 的自然实现。** 不是运行三个 renderer：三者共用 Scene、Geometry、材质 IR、provider 与 FrameGraph；每一对象/产品只有一个当前 producer。

若首个等价 native 原型在 1650 Ti 上长期证明 B 比 A 快，默认应切换到 B。选择标准是总 GPU 时间与质量，不是本文“推荐 A”的权威性。C 若在大规模 VG 目标场景胜出也应重新评估；当前推荐 A 的原因是已知目标的 winner-only shading 与 VG 数据组织，而非 compute 天生优于 raster。

## 4. 推荐的完整 frame flow

```text
CPU asset publication / native program compilation / residency planning
                           ↓（帧前稳定 publication）
GPU Scene updates + frame/material frequency outputs
                           ↓
Geometry: animation / residency / LOD-SSE / HZB / meshlet work
                           ↓
opaque + alpha-tested Visibility / Depth
                           ├──→ HZB / light clusters / VSM receiver demand
                           └──→ shading route classification → native work bins
                                                   ↓
                            VSM pages ready / environment LUT ready
                                                   ↓
                    native geometry + material + ordinary direct/IBL
                                                   ↓
                         HDR_base + demanded SurfaceAux
                                                   ↓
                   GI / SSR / local histories / composition
                                                   ↓
                       sky + atmosphere + transparency
                                                   ↓
                   exposure / temporal reconstruction / upscale
                                                   ↓
                          bloom / tone map / display
```

ReSTIR 等需要 material→独立 sampling/resampling→final shading 的配置，替换中间一段为：

```text
native material resolve → CompactClosure + Aux
                         ↓
                ReSTIR candidate/resampling/visibility
                         ↓
                direct lighting + IBL → HDR_base
```

这是一份编译好的 frame recipe 的选择，不能同帧先跑 full fused，再跑相同 direct lighting 而重计能量。recipe 由效果需求与质量配置决定；不由本帧 readback 决定。

### 4.1 产品、owner、生命周期

| 产品 | Producer / owner | Consumer | 生命周期 |
|---|---|---|---|
| GPU Scene records | Scene | Geometry、material input、motion | 长期；对象粒度 generation |
| Geometry pages / selected work | GeometryResidency / Geometry | Visibility、winner reconstruction、shadow | pages 长期，work 帧内 |
| Visibility、Depth | Geometry raster | route、shading、temporal、HZB、effects | 本帧；历史只由需要它的效果保留 |
| Program/binding route | Material publication | classifier、native workers | 随 publication，不随 pixel 失效 |
| Work queues / indirect args | ShadingBins | native workers | 本帧，无 persistent identity |
| Material parameters / frequency outputs | Material owner | native workers | instance/frame/view 粒度 |
| HDR_base | Native shading | GI/SSR composition、透明、temporal | 本帧 |
| SurfaceAux | Native shading 或指定 resolve | 具名 effects | 本帧；history 归 effects |
| VSM atlas/page table | Shadow | direct lighting | Shadow 自有 cache |
| Reservoir | ReSTIR | ReSTIR/final direct | ReSTIR 自有双缓冲 |
| Exposure、motion、reactive | Radiometry / Geometry-material / transparency | Upscaler | history 归 Temporal |

“谁拥有字段”与“哪个 shader 计算它”分开：Motion 的变换事实归 Geometry/Scene；可以在 fused worker 内顺便写出，不能因此让 Surface 拥有 Scene motion history。

## 5. Material Execution：从 Graph 到真正的 native WGSL

### 5.1 保留编译分析，替换执行表示

```text
authoring graph / Standard material
 → semantic validation + typed IR
 → outputs demanded by selected frame recipe
 → constant folding / CSE / dead output elimination
 → dependency and frequency partition
 → derivative/texture footprint lowering
 → liveness scheduling / native WGSL expressions and functions
 → explicit resource layout + pipeline specialization
```

IR 可以有 opcode；**shader 不解释 opcode**。每个 graph node 在生成源码中成为静态表达式/局部变量/已知函数调用。无全屏 typed tape scratch、无动态寄存器堆、无按指令 storage load/store。编译器 IR、CPU reference evaluator 和 GPU interpreter 是三种不同东西；前两者保留价值，后者退出生产热路径。

### 5.2 Program 与 Instance

`ProgramKey = canonical topology + output profile + geometry requirements + resource layout + precision/features + compiler ABI`。

实例颜色、roughness 值、纹理逻辑 ID、动画参数通常不进 key；graph literal 中真正改变控制/展开的常量才考虑 specialization。10000 instances × 128 B 参数约 1.22 MiB，完全可以只对应 32 programs。若每个实例都嵌不同程序常量，则确实可能有 10000 unique programs；编译器必须区分 parameter 与 literal，不能用 dedup 口号保证不存在。

Standard PBR、Unlit、Clearcoat 是预编译的常见拓扑，不是限制 custom graph 的三种材质。Custom graph 仍经过同一 native backend；暂不支持的 graph 节点必须在发布期明确报错，不能悄悄进入慢 VM 或改变效果。

### 5.3 频率抽取

| 依赖 | 执行时机 | 例子 | 边界 |
|---|---|---|---|
| literal / immutable asset | cook/compile | 固定矩阵、常量支路 | 不跨越精度或非线性滤波语义 |
| material parameters | instance 更新时 | factor 运算、纯参数混合 | GPU-only 值由小型 native 更新 kernel 求值，不读回 CPU |
| frame/global | 每帧一次或每 program 一次 | 时间波形、共同频谱参数 | time 参与 UV 的最终 sample 仍为 pixel 工作 |
| view | 每 view | view-uniform 色调/矩阵 | `N·V`、world position 不是 view-uniform |
| primitive/vertex | Geometry 或局部重建 | 变换、三角形系数 | 是否 materialize 看消费次数与字节成本 |
| sample | 每可见 pixel | texture sample、normal map、BRDF | 允许 full-rate，不寻找全局复用证明 |

边界不是越多越好。将两次乘法提取成一次每像素随机 uniform heap load 可能变慢；compiler 给出 FLOPs saved、bytes loaded 与预计复用次数，便宜表达式允许 rematerialization。

### 5.4 C/X/Y 与导数

compute 中不依赖 fragment `dpdx/dpdy`。使用可见 primitive 的解析 perspective-correct barycentric 和 UV gradients；显式 `textureSampleGrad`。不能对压缩后的相邻 queue lane 取差分，它们可能不相邻甚至不属同一 primitive。

现有 C/X/Y 是有用语义信息，但不要求整个 graph 永远求三遍。仿射 UV 链解析传播 Jacobian；UV 的非线性程序用静态生成的值/梯度规则；现有合同要求有限差分时生成 C/X/Y 所需子图。texture-driven UV、discontinuity、wrap/step 等需要明确 footprint 语义，不能把 chain rule 近似冒充原采样合同。baseColor 不被 UV/梯度消费时无需复制 X/Y 执行。

法线变换、handedness、双面、near-plane clipping、退化三角形必须与 Visibility 使用同一几何定义。继续保留已有可验证数学与 CPU oracle，不保留旧 Store ABI。

### 5.5 pipeline 与 cache

- 第一目标 16–64 常用程序，初期单场景 profile 容许 128 个已发布 unique programs；这是内容/编译预算，不是通用功能硬上限。
- pipeline 在 scene publication 前异步创建，限制并发 2–4；就绪后原子发布 Scene 可引用的 program set。首轮载入允许 loading；热编辑沿用上一份**有效材质 publication**直到新程序就绪，不维护旧 renderer。
- 编译失败展示错误，不发布未完成 program；device loss 重建 device-scoped pipelines。销毁前保护仍在使用的 publication。
- cache 保存 WGSL、IR、layout 描述和应用内 pipeline 对象；portable WebGPU 不提供应用可依赖的 pipeline binary 导入/导出。驱动内部 shader cache 只能视为额外收益。
- permutation 只按真正影响成本/合法性的轴拆分；不做 `all features × all outputs × all providers × all instances` 的笛卡尔积。
- 统计源码长度、编译 wall time、pipeline 数、驻留内存可观测部分和首帧卡顿；pipeline 内部 native code VRAM 常不可直接精确获得。

### 5.6 ProgramPage 与 megakernel

每 4–8 个小 program 生成一个源码 page，worker 根据该 work item 的 program ID 进入 **workgroup-uniform switch**，分支内仍是 native code。这不是 VM，但每个 page 仍可能被最大寄存器需求、代码体积和 instruction cache 限制。

默认独立 native pipelines。ProgramPage 仅用于很多小冷程序的命令摊销，昂贵 coat/procedural 与 cheap unlit 不混同一个 page。PageKey 不能依赖每实例纹理，否则只是把 draw explosion 改名。

一个包含所有 arbitrary programs、lighting、GI、材质 fallback 的巨型 megakernel 不作为 V4 基础：编译时间、寄存器、布局并集、指令缓存的尾部风险太高。§12 给出 page 何时值得。

## 6. GPU Program / Material Binning 的真实 WebGPU 方案

### 6.1 真正的 route key

`RouteKey = (NativeProgramOrPage, ResourceBindingSet, ExecutionProfile)`。

不是 MaterialInstanceID。否则 10000 instances 仍会变成 10000 queues/dispatches。也不能只有 ProgramID：当前 `TextureResidency` 明确使用九个显式 texture bank bindings；如果两个实例所在 binding set 不同，WebGPU 不能因为 program 相同就动态绑定另一组纹理。

CPU 遍历已发布的 route 表编码 `setPipeline/setBindGroup/dispatchWorkgroupsIndirect`；GPU 只写每条 route 的工作数与工作内容。未见 route 的 indirect x=0，仍可能付 command/validation 成本。允许 CPU 根据长期 publication 删除不可能出现的 route，禁止本帧 GPU readback 后再决定 dispatch。

32 programs、2 个资源集合不必产生 64 routes：只发布实际存在的组合。理想情况 32–48；最坏确实可以 Pgm×Set 膨胀。这个数必须成为内容和 residency 的真实诊断指标。

### 6.2 基础工作项

8×8 tile，每个 `(tile, route)` 一个 16 B record：

```text
u32 tileIndex
u32 routeOrLocalProgram
u32 activeMaskLo
u32 activeMaskHi
```

实例 ID 与 geometry winner 从 Visibility 重读；不把完整 material/geometry 拷进 queue。64 lanes 只执行 mask 中的像素。每 tile 每 pixel 恰属一个 route，opaque HDR 只有一个 writer，无需 per-pixel CAS。

设 T=32400、tile 平均 routes 为 k：Q=kT，1≤k≤64；大面遮盖高时 k 可能 1–2，材料碎片/微三角形时可能远大于 4。**这些必须实测，不能当场景定律。** 同一 tile 内很多 instances 若共用 route 仍为 k=1。

| k | work records | queue 有效 bytes | shader lane 启动上界 | 理想 mask 占用率 |
|---:|---:|---:|---:|---:|
| 1 | 32,400 | 0.49 MiB | 2.074 M | 100% |
| 1.5 | 48,600 | 0.74 MiB | 3.110 M | 67% |
| 4 | 129,600 | 1.98 MiB | 8.294 M | 25% |
| 16 | 518,400 | 7.91 MiB | 33.178 M | 6.25% |
| 64 | 2,073,600 | 31.64 MiB | 132.710 M | 1.56% |

mask 占用率不是实际 GPU occupancy；wave 内分布、register 分配与早退会改变实际浪费。不能用“active lane 只剩一个，所以只算一个”的直觉忽略整个 wave 发射。

### 6.3 一个不依赖 subgroup 的完整构建算法

基线采用具名本地 **Sorted Tile Routes**，不是 runtime proof 系统：

1. 预清有限 route counters/indirect args；不清全容量 records。
2. 每 tile 读 Visibility→route。背景为 sentinel；尾 tile 无效 lane 参与 barrier 但不产生记录。
3. uniform route 快路：workgroup 共享一个参考 key，以共享原子 OR/reduction 检查是否不同，少量 barrier；相同则直接输出一个 mask。
4. mixed tile：64 个 `(route,lane)` 在 workgroup shared memory 中做固定 bitonic sort，21 个 compare-exchange 阶段；按相同 key 的连续段生成两个 32-bit masks。每段首lane作为leader，顺序读取本段最多64个元素形成mask，各段总读取仍为64个；leader用一次workgroup原子分配本tile的runIndex，再生成record。使用原 lane bit，排序位置不改变 pixel identity。全组在最终读取tileRecordCount前同步；不存在非uniform barrier。
5. 暂存位置为 `tileIndex*64+runIndex`，同时写 tileRecordCount。每条 record 对所属 route histogram 做一次 global atomicAdd。
6. 独立 prefix/arguments dispatch 扫描少量 route counts，生成 offsets 和 indirect args；总 records ≤ covered pixels。没有跨 workgroup 自旋或假全局 barrier。
7. scatter：按 tileRecordCount 读取暂存，每 route atomicAdd 取得紧凑地址，写最终 queue。独立 dispatch 完成后才读它做 shading。

正确性基线为一次 sort、两次 append 阶段；不是每个 program 扫一次全屏。mixed tile 排序最坏为每 tile 672 个 compare-exchange 对，1080p 21.77 M 对；常见“双 lane 都比较”的实现会发出约 43.55 M lane 比较。加分段 mask 的 workgroup 操作，不能把它记作零成本。若 uniform tiles 占 70%，sort 部分约为该最坏值的 30%。

shared state 可在 1–2 KiB 内；mixed tile 约 21 个排序 barrier，加装载、mask reduction 和输出同步约 2–5 个。普通 32–64 routes 的 prefix 很小；没有第二次全屏 sort。

暂存按 `64×ceil(W/8)×ceil(H/8)` records分配，最终queue按最多 `P=W×H` records分配；**奇数extent的暂存必须包含tile padding**。1920×1080恰好均为P，各31.64 MiB；加计数/args，总预算 **约 64–66 MiB**。这是明确承认的保守容量，不把通常只有 0.74 MiB 的写入量冒充物理分配。可用两遍重分类替代暂存，省31.64 MiB但重复排序；是否划算需测，不默认采用。

### 6.4 调度、容量与失败

- classify、prefix、scatter 与 shade 之间用独立 dispatch 的 WebGPU 顺序保证可见性；resource 从 storage write 转 indirect read 由 API usage tracking 管理。一个 compute pass 内可以多次 dispatch，不插 CPU wait。
- 若一个 route 的 groups 超过默认 65535，arguments 使用二维 grid，例如 x=min(Q,65535)、y=ceil(Q/x)，worker 线性化 groupID 并检查 `< routeCount`。不能直接截断 x。
- publication 建立 dense route ID，按 negotiated max buffer/binding limits 分段或限制本 profile 分辨率；Q≤P 是数学上界，不能因运行时队列溢出漏 shading。
- 每帧 counters 清零，data records 无须全量 clear；首次分配可能有 WebGPU 安全初始化成本，计入 cold/resize，不当 steady-state 免费资源。
- Sky/background 由背景 pass 覆盖，alpha-tested pixel 在 Visibility 阶段确定 winner；native worker 不再做会推翻 winner 的 alpha discard。
- 无效 publication 是发布错误；资源 streaming 使用 owner 已定义的合法 resident coarse mip/page。热 worker 不重新做完整身份校验。

### 6.5 高熵 tile 与 pixel compaction

tile-route 在 k 很高时不是好模型。备选为把 `(pixelIndex)` 按 route 压入紧凑 pixel queue，64 个相同程序像素组成一组；4 B/pixel 的 queue 写读理论上仅 16.59 MB/1080p，但 histogram/scatter/原子、临时索引和丢失的 texture locality 都要算。

两种可实施策略：

- 内容级 route profile 选择 compact-pixel entrypoint，整帧使用该完整 worker。
- 已实现且确有收益后，在 classify 对 k>阈值 tile 输出 compact work、其他 tile 输出 tile work。CPU 为两种已知 entrypoint 编码 indirect dispatch，GPU 分流，像素写域完全不重叠。

第二种会增加 pipeline/commands 与两套 queue，不放进第一版必需基础设施。先用高熵压力场景找阈值。任意 graph 都能用解析梯度按 pixel compaction 正确求值；不能为了 compaction 丢失导数或给 shader 强塞屏幕邻居。

### 6.6 简单场景不强制 binning

若 publication 只有一个 route，直接 tiled native dispatch；两三个 cheap 标准程序可测试一个小 native switch。无需先建 queue 再证明不需要 queue。选择基于发布内容/校准和已有完整 native 入口，不引入 Surface 复用模式系统。

## 7. 一个像素从 Visibility 到 HDR

例：不透明双纹理 UV 的 Standard PBR，base/ORM/normal/emissive，clustered direct + IBL + VSM，Temporal profile。假定 winner 已确定，当前 depth 与 instance transform 有效。

| 步骤 | 读取 | 计算/寄存器 | 写到显存 |
|---|---|---|---|
| 1 route | Visibility ID、meshlet/material route metadata | integer route、pixel mask；无 BRDF | tile record；这是前述分类 pass |
| 2 worker 定位 | record、pixel Visibility/depth | pixel coordinate、winner ref | 无 |
| 3 geometry | winner triangle indices、压缩 position/normal/tangent/UV、instance transform或frame arena | 解码；透视插值；UV gradients；world P/N/T；view vector | 不写 GeometryRecord |
| 4 material | instance params、frequency outputs、各 texture bank | 生成的 native expressions；CSE；normal map 变换；base/metal/rough/emission/coat；只保留真正 live 字段 | 不写全屏 fields |
| 5 direct | cluster range/light indices/light records、VSM table/depth | attenuation、BRDF、shadow；小 light loop 内边算边累加 RGB | 不写 six signals |
| 6 IBL | environment maps/LUT、可用的 provider 输入 | Fresnel/DFG、diffuse/specular env、AO 的正确分量应用 | 无 |
| 7 HDR | frame pre-exposure | 合成直接/间接/emissive；有限值处理 | rgba16float HDR 8 B |
| 8 aux | previous transform/vertex（仅 motion 有需求时） | current/previous clip、motion、reactive；normal/roughness 的必要编码 | Temporal 8 B/pixel，Reflection 另加需求字段 |

geometry、material closure 与 lighting accumulator 都是 shader 局部值。源码局部变量**不保证硬件寄存器驻留**；若驱动 spill，它会成为内存流量，必须由性能实验/可用的 native capture 发现。compiler 尽早结束 UV/导数/纹理临时变量生命周期，lighting 不携带完整 graph 的 live set。

GLTF metallic-roughness 中 `F0=mix(dielectricF0,baseColor,metallic)`、diffuse energy partition、clearcoat attenuation 维持原有物理语义。`pow(x,5)` 可确定性展开为乘法，不能用无依据 roughness clamp/关闭 coat/删 normal texture 达到速度目标。

退化/near-plane winner 使用同一明确数学 fallback，不恢复旧渲染链。单像素重建可以重读三个顶点；大三角形的共享系数与局部缓存是否物化由 §12 的成本决定，不能因为已有 FrameGeometryArena 就每 primitive 永久写全套 shading 属性。

## 8. Minimal SurfaceAux contract

### 8.1 mandatory frame 产品

规划采用 Visibility 8 B/pixel（完整 winner 引用，不强行塞进 32-bit）、Depth32 4 B、HDR rgba16float 8 B，共 **20 B/pixel = 39.55 MiB**。真实 Visibility ABI 要以当前容量/身份设计验证，不能为了数字漂亮裁剪 meshlet/primitive identity。若后续证明 4 B 足够，可单独降低。

这些是分配，不是每帧 traffic；它们可能被多个消费者读取。SurfaceAux 额外产品如下。

| Profile | 额外字段/编码 | 增量 B/pixel | 1080p 分配 | 明确 consumer |
|---|---|---:|---:|---|
| Base | 无 | 0 | 0 | 只生成 HDR |
| Temporal | motion 两个 half 4 B；reactive/validity/flags 打包 u32 4 B | 8 | 15.82 MiB | Temporal/FSR、motion blur |
| Reflection | Temporal + shading normal oct16×2 4 B + roughness/metal/AO/flags 4 B | 16 | 31.64 MiB | SSR/SSSR classification、denoiser |
| GI | Reflection + linear baseColor/metal 或 diffuse albedo/profile 定义的 RGBA8 4 B | 20 | 39.55 MiB | SSGI hit response / diffuse demodulation |
| RichClosure | 具名新增 coat normal、anisotropy、transmission 等 | +8–32，按算法 | 逐项计算 | 只供实际需要对应 closure 的算法 |

Reflection/GI 不是保证所有材质都能由这些字段重建完整 BSDF。Standard dielectric/metal 的 screen-space近似有明确 profile；colored specular、独立 coat normal、anisotropic custom graph 若需要精确多次 BSDF evaluation，就申请 RichClosure 或走 native resolve profile，不能把它们投影为普通 PBR 而不说明画质差异。

### 8.2 portable 存储设计

不要假设任意 R/RG packed 格式都支持 storage write。默认 HDR 使用规范支持的 `rgba16float` storage texture；Aux 在一个 `var<storage,read_write>` 的 packed u32 buffer 内做 planes，以 `pack2x16float`、`pack2x16snorm`、`pack4x8unorm` 等编码。Motion 的 half 存储不要求 WGSL f16 算术 feature。

纹理消费者若要求 `rg16float` motion 或 `rgba8unorm` mask，可由专用适配 pass 物化这些纹理；只有实际设备协商支持该 storage 格式才让 fused shader 直接写。转换需要 8–16 B/pixel 的读写与 dispatch，计入 temporal 而不能声称免费。也可选 portable `rgba16float` 包含 motion+reactive+validity 的 8 B 平面，用一个纹理换格式便利；选哪种以真实 upscaler 接口决定。

normal/roughness buffer 解码由 effect 读 texel 所在 pixel，重建过滤必须按法线/roughness语义执行，不能随意对 packed bits 做双线性。需要 hardware-filtered guides 时由该效果生成其降采样 texture，算入效果预算。

### 8.3 精度预算不是口号

| 字段 | 初始精度 | 允许的验证预算/回退 |
|---|---|---|
| barycentric/clip/world reconstruction | f32 | 与独立 double CPU oracle 比较；近面、远景、薄三角形不降 half |
| HDR | pre-exposed rgba16float | 正常值相对量化约 0.05% 数量级；检查溢出、underflow、极亮 emissive 和 tone-map 后 banding |
| motion | half，单位为 internal pixel displacement | 中等位移量化目标 ≤0.125 internal pixel；快速转动、大位移不满足时选 f32 profile；不能说 half 在任意位移都满足预算 |
| normal | oct snorm16×2 | 独立全球采样与真实 normal maps：角误差目标 P99 <0.02°、max <0.05°；目标待验证 |
| perceptual roughness | unorm8 | 标量量化 ≤1/510；低 roughness 的 BRDF 误差可能很大，镜面测试不合格升级 unorm16 |
| albedo | linear unorm8 或明确 sRGB 编码 | 每通道量化 ≤1/510 不代表暗部相对误差小；暗部/饱和材质需要 sRGB 存储解码或 fp16 profile |
| flags/identity | u32 bit fields | 精确，不以量化/hash 代替需要的身份 |

“无 consumer 不写”由 frame recipe 的静态需求决定，作用于 shader outputs 和资源创建。不能资源仍分配、shader 仍写，只把 downstream pass 关掉。

### 8.4 Visibility 重建还是一次物化

Position 从 depth/inverse view projection 重建通常便宜，无需 12–16 B world-position GBuffer。Geometric normal 从 triangle 重建可用，但 normal mapped shading normal 不能由 Depth 正确恢复。SSR/GI 多次读取时，4 B 法线通常值得物化；重新执行 normal texture/UV 重建可能比 4 B load 更贵。

一个 cheap mask 消费者不应触发完整材质求值。反过来，十个效果反复重建同一 guide 也不划算。决策单位是具名字段×消费者次数，见 §12，不是“全 renderer 不准 GBuffer”。

## 9. 高 coverage：接受下界，移除无条件昂贵工作

### 9.1 不可避免的 O(P)

可见性/深度、输出 HDR、必要的 motion/guide、边缘和反遮挡处理、最终 reconstruction/output 都至少随覆盖或输出 pixel 数增长。高 coverage 不只是渲染器缺陷，它表示需要生成更多有意义样本。

降低成本的顺序：

1. Geometry owner 减少无意义微三角形、重复解码/变换和无效 streaming；用屏幕误差控制实际几何复杂度。
2. Material compiler 去死输出、共享采样、消除重复节点、把真正 uniform 的昂贵表达式移出 pixel。
3. Native program coherence，提高同一波的有效执行效率；这是硬件利用率优化，不假称减少数学样本数。
4. 只在确定更省时才用局部 shared triangle setup、pixel compaction、粗率照明。
5. 对仍昂贵的全屏工作，用质量配置、Dynamic Resolution、temporal reconstruction 控制 P。

纹理高度不均匀、镜面/法线细节丰富时，sample-rate full shading 是正确且可能最快的选择。

### 9.2 quad/tile coherence 能做什么

同一 primitive 的 quad 可共享三角形索引、变换/解析系数，再用各自 barycentric 求不同属性；不能共享不同像素的 final normal map、BRDF、visibility。workgroup uniform 的 program 分支不意味 material parameters 相同；需要实际 instance ID 匹配才共享 instance constants。

subgroup broadcast 是可协商加速，不假定 32-lane；无 subgroup 时用 workgroup shared 或直接重算。对于十几条算术，barrier 比重算更贵时选重算。compiler 不建立全局共享树。

### 9.3 Software VRS

V4 不将全材质 VRS 作为默认。前置 depth/primitive/program 一致并不足以保证 normal map、roughness、procedural noise、shadow 的低频；需要昂贵材质结果才能做的判定，可能已支付要节省的代价。

可研究的有限范围：昂贵低频 diffuse GI、雾、经过独立画质约束的 lighting 子路径；rate map/history 归具体效果。局部 2×2 允许粗算时，明确 anchor、sample footprint、边界 full-rate、coverage 和重建。高光、alpha、薄物、disocclusion、快速变化内容拒绝粗算。不建立 Certificate，不证明 arbitrary material 可共享。

DOOM VRCS 技术资料包含 compact/remap，也包含上线后撤回 composite/fog 上 VRCS 的经验：管理与修复成本能吃掉收益。不能只引用它成功降采样的一半。

### 9.4 Dynamic Resolution 是一级策略

设固定成本 F、pixel 主导成本 V，internal 线性比例 s：`T(s)≈F+s²V+Upscale(s)`。Geometry、阴影页生产与某些场景管理不会全部按 s² 缩放。

例如 F=6 ms、V=14 ms，native=20 ms；s=0.77 后约 14.30 ms，加 1.5–2.5 ms upscaler 得 15.80–16.80 ms，已接近边缘；s=2/3 后约 12.22 ms，加 upscaler 得 13.72–14.72 ms。所有数字是示例假设。native=35 ms 若固定部分已 14 ms，仅缩分辨率也很难稳定 60。

控制器使用滞后的 GPU timing 平滑调整下一帧 scale，不把本帧 visible/work readback 作为控制。带 hysteresis、最小驻留时间、rate limit；保留输出分辨率 motion/jitter 的一致变换。不要 resize 时复制所有 histories；由 Temporal 明确支持 rescale 或 reset。

## 10. 当前中间产品的真实带宽负担

当前 `GpuSurfaceWorkAbi.ts`：hotWords=12，guides=6，retained field channels 最大16，workStride 最大136 B；signalWords=19，即六路 RGB 的18个 f32 加一个 word，共76 B。最大字段 profile 合计 **212 B/pixel**，不含 control、tape temporary、Closure Cache 和别的 renderer 资源。

> 这是 ABI 最大 profile。实际 varyingFields 会缩小字段区；lit/unlit 不同。分配容量不等于每帧每个 word 都真实读写一次。

1080p 下，若这些产品各完整写一次、读一次：

```text
P = 1920 × 1080 = 2,073,600
Geometry/hot + guides = (48 + 24) × P × 2 = 298.60 MB
fields 最大16个f32 = 64 × P × 2 = 265.42 MB
six signals + state = 76 × P × 2 = 315.19 MB
总计 = 424 × P = 879.21 MB/帧 = 838.48 MiB/帧
```

理论 192 GB/s 下单纯搬运下界 **4.58 ms**；有效100 GB/s 为 **8.79 ms**；60 GB/s 为 **14.65 ms**。这是“上述全量流量确实发生”的条件下界，不是从 capacity 直接推断当前实测耗时。缓存命中、消费者实际字段子集、重复读取、写合并、随机访问和 spill 都会改变结果。

当前四个 bank 按272行填充，实际覆盖分配 2,088,960 samples，比逻辑1080p多约0.74%；最大 data profile 约422.34 MiB，另有 temporary/control。Signal 双缓冲逻辑容量约300.59 MiB，padding 与 recipes 后略高；当前代码复用下一 history slot 作为当帧 signal，不再额外加第三套 signal。**预算不能重复计算同一物理 buffer。**

仅六路 signal 的一次 write+read 已是315.19 MB；相对只写一次8 B HDR的16.59 MB，有约298.60 MB的理论差额，100 GB/s 下约2.99 ms。它不能解释全部27–59 ms差距：解释器、key lookup、访问串行化、occupancy、重复 coverage 等仍需分别验证。

V4 消除跨阶段 Geometry/fields/signals 的强制存在，而不是声称 fused shader 没有读取几何、材质和灯光的成本。

## 11. 1080p analytical cost model

### 11.1 工作负载与范围

目标设备类别：GTX 1650 Ti 4 GB、约192 GB/s理论显存带宽。移动机型TGP、频率和散热会显著影响结果。以32个常用 native programs、实际32–48 routes、8×8 tiles、non-MSAA opaque、Temporal aux为基准。§1历史报告未证明设备具体型号，本节不把它当校准值。

计入：Visibility 已完成后 route、native reconstruction/material/direct/IBL、HDR/Temporal aux 输出。计入普通阴影**查询**，不计阴影 atlas 生成、VG cull/raster、GI/SSR、upscaler、post。frame/material频率更新成本在大量动态实例时另加；例子按少量动态参数处理。

| workload | visible coverage / pixels | 平均有效灯 | 材质/采样条件 | tile情况假设 |
|---|---|---|---|---|
| 普通 PBR | 70% / 1,451,520 | 4 | 标准纹理PBR，普通IBL，小量阴影 | k≈1.2，uniform较多 |
| 高 coverage 普通复杂 PBR | 95% / 1,969,920 | 8 | 4–5个材质采样+IBL/阴影等合计12 queries | k≈1.5，70% tile为uniform route |
| 复杂 PBR | 98% / 2,032,128 | 8 | coat/多UV/层叠纹理，26 queries | k≈2，较长live ranges |
| 多灯 | 98% / 2,032,128 | 32 | cluster实际命中32灯，部分有阴影，40 queries | k≈1.5–2，light loop占主导 |

query 指一次 source-level filtered sample/comparison query，不等于一个DRAM texel读取。trilinear、anisotropic、cache、BC解压、PCF都会改变真实取样工作。PCF循环必须展开计queries，而不能“一次阴影查询”掩盖十几次sample。

### 11.2 每 visible pixel 的输入清单

以下“有效 bytes”是给DRAM成本模型的**待测假设**，不是所有WGSL load的逻辑字节总和。

| 项目 | 普通 | 高coverage | 复杂 | 多灯 |
|---|---:|---:|---:|---:|
| 顺序/局部storage与图像读取 B | 40 | 40 | 40 | 40 |
| 随机/间接metadata、geometry、light有效读取 B | 64 | 96 | 160 | 128 |
| texture有效读取 B | 80 | 112 | 256 | 192 |
| 写 HDR+Temporal aux B | 16 | 16 | 16 | 16 |
| 总有效 B/pixel | **200** | **264** | **472** | **376** |
| filtered sample queries | 10 | 12 | 26 | 40 |
| ALU-equivalent operations | 1200 | 1800 | 4200 | 6500 |
| special operations | 4 | 6 | 12 | 32 |
| shader常规global atomic | 0 | 0 | 0 | 0 |
| shader强制workgroup barrier | 0 | 0 | 0 | 0 |

40 B可理解为8 B Visibility、4 B Depth、约28 B经局部复用后的parameter/cluster/frequency数据摊销。一个未命中cache的三角形解码路径可能发出12 B indices+96 B或更多attributes+48–128 B transform，加32–128 B material以及light records；这远多于64–160 B有效流量。模型假设geometry/instance/light被相邻像素复用。若microtriangle与混乱route破坏复用，随机effective bytes必须上调，而不能仍用同一表。

ALU-equivalent按scalar op计，FMA计2；特殊函数单列，不把`pow`视作一次普通ALU。整数地址、分支、pack/unpack、texture address setup并不严格映射成FLOPs：表是规划代理值，最终用实际native microkernel校准。texture bytes与texture query floor描述同一子系统的不同约束，计算时取最大而不把两者简单相加。

### 11.3 管理成本单列

高coverage k=1.5时：

- 32,400 tile groups；约48,600 records。
- classify全屏8 B Visibility +约4 B route metadata的逻辑量级：24.88 MB；metadata经缓存后DRAM可更少。
- staged write/read + final write/read = 64 B/record：3.11 MB；tile counts等不到1 MB；总管理流量约 **28–32 MB**。
- 每record histogram + scatter各一次global atomicAdd：约 **97,200次**；可能集中于少数route counter而串行，不能使用无争用atomic吞吐估算。mixed tile另有每record一次workgroup原子用于runIndex；uniform检测的shared原子/reduction也归管理。
- mixed30%情况下排序约6.53 M compare-exchange pairs；shared参与和branch另算。
- uniform快路约2–3个group barriers，mixed约23–26个：约0.27–0.32 M group barrier events。这里一次group barrier不等于一次线程指令。
- pipeline/dispatch：reset（可以encoder clear）、classify、prefix/args、scatter、32–48次native dispatch、1次sky，合计约 **36–53次dispatch**，约 **35–52次pipeline transition**，取决于排序/共用pipeline。
- CPU encode遍历同一publication route表；一次frame submit。零count dispatch的验证/编码税仍在。

理想顺序带宽下管理28 MB/100 GB/s≈0.28 ms，只是一个floor。假设非争用append校准0.3 Gops/s，97k次约0.32 ms；与带宽不可盲目相加，也不能忽略单counter争用。dispatch有效GPU税假设每个3–10 μs，40次约0.12–0.40 ms。shared sort/barrier及route latency补足后，expected管理预算 **1.1 ms**，乐观0.605 ms、悲观2.09 ms。**这些吞吐和dispatch税均尚未测量。**

最低容量：queue64–66 MiB，计入ShadingBins临时工作集；params/program metadata约2–8 MiB长期；material/geometry tile局部值在register/shared，任何spill额外计账。工作集不是在shader里创建一个全屏寄存器数组。

### 11.4 三档有效吞吐假设

| 输入 | optimistic | expected | pessimistic |
|---|---:|---:|---:|
| effective混合DRAM GB/s | 140 | 100 | 55 |
| native material effective TFLOP/s代理 | 1.50 | 0.85 | 0.45 |
| filtered query Gquery/s | 22 | 10 | 4 |
| special Gop/s代理 | 12 | 6 | 2 |
| overlap/latency放大系数ρ | 1.10 | 1.25 | 1.40 |
| management倍率 | 0.55 | 1.00 | 1.90 |

它们不是NVIDIA规格表换算值，也不是MeasuredEffectiveThroughput；只是校准前的敏感性区间。随机读取不能真正概括为一个带宽数字：pointer链长与并发不足会表现为额外latency/更差ρ。实际校准后应拆成逐pass或逐stage模型。

```text
N = width × height × coverage
tBW = N × effectiveBytes / effectiveBandwidth
tALU = N × ALUops / effectiveALU
tTEX = N × queries / effectiveTextureThroughput
tSFU = N × specialOps / effectiveSpecialThroughput

floor = max(tBW, tALU, tTEX, tSFU)
estimate = ρ × floor + management
```

`max`是可重叠瓶颈的roofline式下界，不是精确执行模拟；`ρ`是显式不确定性，不得事后任意调到吻合。独立串行pass分别算后相加；不可把全帧所有工作取一次max。硬件lane利用差、spilling和资源竞争严重时，真实值能超过pessimistic。

### 11.5 算出来的结果

| workload | 流量MB | expected BW floor | expected ALU floor | expected TEX/SFU floor | O/E/P中心估算ms |
|---|---:|---:|---:|---:|---|
| 普通 | 290.30 | 2.90 | 2.05 | 1.45 / 0.97 | **2.78 / 4.53 / 9.10** |
| 高coverage | 520.06 | 5.20 | 4.17 | 2.36 / 1.97 | **4.69 / 7.60 / 15.33** |
| 复杂PBR | 959.16 | 9.59 | 10.04 | 5.28 / 4.06 | **8.31 / 13.95 / 29.21** |
| 多灯 | 764.08 | 7.64 | 15.54 | 8.13 / 10.84 | **10.46 / 20.83 / 48.18** |

不要把小数位当精度：表保留它们是为了可重算。规划范围分别用普通 **3.5–6 ms**、高coverage **6–10 ms**、复杂 **11–18 ms**、多灯 **17–28 ms**。悲观列描述低频率/差locality/低occupancy等组合，非统计P95。

对high coverage的灵敏度：

- effective bytes从264降到200，expected BW floor由5.20降至3.94 ms，ALU4.17成为主导；所以带宽优化不会无限收益。
- effective ALU从0.85降到0.45，ALU floor升至7.88 ms；分阶段B可能因occupancy改善获胜。
- k从1.5升至16，Q和mask浪费接近十倍；本表管理1.1 ms假设失效，必须换像素组织或如实接受慢路径。
- pipeline从32增至256，按5 μs/dispatch仅GPU command差额就约1.12 ms，CPU validation也会增长。

## 12. 每一种可选优化都必须算 break-even

统一写作 `Topt = Tbase + M + extraWork − savedExclusiveWork`。命中率/复用率仅是节省项的一个乘数。以下是可重算的**示例合同**，实际M/E必须来自同质量GPU实验。

### 12.1 全局 Closure Cache：淘汰默认路径

设lookup等每样本税L，miss publication成本U，真正可省求值E，hit率h：

`Δ = L + (1−h)U − hE`，break-even `h > (L+U)/(E+U)`。

| 示例E/L/U | 0% hit | 50% hit | 100% hit | 结论 |
|---|---:|---:|---:|---|
| cheap E=20 ns，L=35 ns，U=10 ns | +45 ns | +30 ns | +15 ns | 最理想也亏，直接淘汰 |
| expensive E=150 ns，L=35 ns，U=10 ns | +45 ns | −35 ns | −115 ns | h>28.1%才赚，但0%税很高，不能全局常驻 |

这些ns是GPU大批量耗时摊销值，不是单线程延迟。1650 Ti上全屏45 ns税约93 ms，说明“每pixel几条hash似乎很小”会错得很大，也说明必须实测，而不能机械采用此示例常数。当前96-word上限的key仅payload即384 B，一次write+read就768 B/候选，未计compare/探测/结果。缩key不能破坏identity。

V4不继续优化这条通用路径。若未来某个专用昂贵算法具备强复用性，由它自己的owner建立cache，满足本节盈亏条件，不迁回Surface。

### 12.2 Binning 与直接 native switch

binning通常不减少有效pixel数；它减少divergence和重复通用分支。设额外分类税M=0.9 ms、比原基线多的command税D=0.15 ms、100%获得coherence时可省S=3 ms，q为获得该收益的比例：

`Δ=M+D−qS`。

| coherence收益比例q | 0% | 50% | 100% |
|---|---:|---:|---:|
| 差额ms | +1.05 | −0.45 | −1.95 |

break-even q>35%。若shader总耗时只有0.6 ms，最大可省不到1.05 ms，binning永远不能回本；单route/cheap profile绕过它。若mixed tile本身成为灾难，不能为了“program locality”保留binning。

### 12.3 Pixel compaction 对 tile-route

设compact额外管理M=0.65 ms，最理想能消除mask/wave浪费W=3 ms，q为可消除浪费比例。差额在0/50/100%分别 **+0.65 / −0.85 / −2.35 ms**，break-even q>21.7%。

但若重新排列像素使texture/geometry locality增加0.8 ms，实际break-even=(0.65+0.8)/3=48.3%。须测完整kernel，不能仅测compact自身或dispatch lanes减少。k=1时W≈0，禁用。

### 12.4 Software VRS

设目标昂贵子工作C=8 ms，2×2 coarse可少75%该工作，可接受coarse的比例r；判定+remap+reconstruct税M=0.8 ms：

`Δ=0.8−0.75r×8`。0/50/100% reuse：**+0.8 / −2.2 / −5.2 ms**；break-even r>13.3%。

若C只有1 ms，即使r=100%，差额仍+0.05 ms，淘汰。若判定必须先执行C的60%，可省的exclusive C只剩3.2 ms，break-even升至33.3%。r=100%只是数学理想，画质校验优先，不能强行放宽判定来达标。

### 12.5 ProgramPage

32独立pipeline→8 pages，d=5 μs时最多省24d=0.12 ms。page使6 ms着色部分慢3%=0.18 ms，则最好情况仍亏0.06 ms，淘汰这个page划分。

若源码/寄存器同质，小程序page开销仅0.04 ms：0/50/100%理想command收益差额为 **+0.04 / −0.02 / −0.08 ms**；break-even收益兑现>33.3%，但绝对收益仍小，不应优先投入。如果256冷程序合32 pages能省1.12 ms而page tax0.1 ms，才值得重点验证。

这里“100%”是command节省完全兑现，不是cache hit。CPU encode节省单列；不能拿CPU好处冒充GPU更快。

### 12.6 物化/重算与fused/deferred

字段成本C ns/consumer，n消费者，写成本W、每次读成本R：`materialize=W+nR`，`recompute=nC`，break-even `n>W/(C−R)`，前提C>R。两次乘法往往C<R；normal map重建通常相反。

24 B closure write+read在1080p约99.53 MB，100 GB/s floor约1.0 ms；32 B约1.33 ms，另加pass税。若拆kernel使8 ms fused降到两个合计6.2 ms、付1.1 ms额外memory/pass，总7.3 ms，B获胜；若仅省0.5 ms，B失败。这是B profile的明确选择条件。

Uniform extraction例如跨1 M pixels重复一段50-op纯参数计算，可以省50 M op；若为它增加每pixel16 B读取就是16 MB额外流量。GPU端一次更新不是免费，但相比1 M次执行通常可摊销；对于2-op表达式应直接重算。

### 12.7 采用门槛

最理想条件下不能获得清楚、超过测量噪声的净收益，直接删除方案。0%收益有高税的机制不进常规hot path。测试至少有0/50/100%控制样本、真实内容、相同输出质量和完整维护开销；不以hit率、内存容量减少或局部kernel变快替代总成本。

## 13. 4 GB VRAM 与带宽预算

### 13.1 全屏基本容量

1 B/pixel @1080p = 1.978 MiB。Depth、Visibility、HDR共39.55 MiB；Temporal profile合55.37 MiB；GI profile合79.10 MiB。再加ShadingBins最坏双queue约64–66 MiB，native核心目标约 **120–150 MiB**，不含Geometry资产/工作、lights、效果history、upscale。

ReSTIR若32 B reservoir、双缓冲：126.56 MiB；第三份spatial scratch再63.28 MiB。SSR/GI多个color+moments+normal histories轻易再占几十到上百MiB。它们不是消失了，而是归真实consumer按质量等级预算。

### 13.2 一个可执行的1650 Ti预算样例

单位全部MiB；这是同时驻留上限分配表，不允许各owner独立按“4 GB”扩张。

| Owner/用途 | 规划上限 | 说明 |
|---|---:|---|
| Texture/VT physical pools | 1100 | 含mips/page cache；不沿用TextureResidency自身2 GiB上限作为全局允许量 |
| Geometry resident pages/assets | 600 | meshlet压缩数据/层级；有缺页时合法coarse LOD |
| Frame geometry/work/animation | 180 | 包括arena、indirect、变换与工作队列 |
| Scene/material/light persistent | 100 | 实际规模增长要计账 |
| Visibility/Depth/HDR/Aux/bins及别的基础瞬态 | 220 | 上述约150 MiB外留resize、HZB及cluster余量 |
| VSM atlas/tables/work | 256 | 例如8192² depth32单atlas本身就256 MiB，故不能还无条件加一整套；应按实际尺寸缩atlas |
| Temporal/upscaler history+scratch | 200 | 按完整运行recipe核算，非只一个HDR history |
| SSR/GI/reservoir效果池 | 200 | 不能同时把各算法最高profile都塞进来 |
| uploads/retired overlap | 180 | 在途资源、替换、双scene publication |
| driver/OS/未观测headroom | 700 | 保留空间，不是API可保证的可用预算 |
| 合计 | **3736** | 剩360 MiB，4 GiB物理总量也不保证全部可给进程 |

如果upscaler真实工作集>200 MiB或VSM页面/多视图超额，必须调整其他池或质量tier。WebGPU没有portable的显存剩余量查询；按显式accounting与保守profile分配，不把创建成功视为不会分页。native backend可读取更好预算信息，但不能成为Web版正确性的前提。

Streaming先确保保底coarse mip/page已resident；新页上传有每帧byte预算与队列序。纹理替换、resize、device loss重建的旧新重叠受全局budget控制，不在运行中阻塞等待本帧GPU计数。可以延迟**下一批资产发布**，不能丢当前像素工作。

### 13.3 带宽的整帧约束

100 GB/s有效吞吐、16.67 ms仅约1.67 GB/帧混合可搬运量。high-coverage native shading本身约0.52 GB，尚余约1.15 GB给Visibility/VG/VSM/GI/SSR/temporal/post；真实操作还争用算力和texture。仅说V4 Surface小于200 MiB，不证明能60 FPS。

120Hz目标可用时间减半。质量tier需要同时约束纹理足迹、lights/PCF、effect分辨率、history大小与几何误差，不只是降低某个Surface pool。

## 14. WebGPU Native：能直接用、需要fallback、不应模仿

“WebGPU Native”指以WebGPU模型设计，不指可以无条件调用D3D12/Vulkan扩展。能力以创建device时的features/limits为准。2026-10-07本次核对了W3C WebGPU/WGSL公开规范；后续需固定具体实现版本。

| 技术 | V4处理 |
|---|---|
| compute、storage buffer、indirect dispatch、render indirect | 直接使用；usage/offset/维度合法；indirect数据不能选择pipeline |
| texture arrays、显式bank、atlas、page table | portable资源模型；单texture array layers共格式/尺寸/mips；不能混任意texture对象 |
| native shader specialization | 生成WGSL或override+pipeline；CPU先创建pipeline，GPU只选择数据工作量 |
| subgroups/quad操作 | feature协商；subgroup size不固定32；baseline workgroup算法或解析梯度 |
| shader-f16 | 可选运算优化，独立质量验证；half存储/pack不必依赖它 |
| timestamp-query | 可选；无此feature则报告时间不可用，不用CPU submit耗时替代GPU pass时间 |
| texture compression / format tiers | 协商后使用；storage合法性、filterability与sample type分开检查 |
| hardware VRS、mesh/task shaders、ray queries | 不作为portable WebGPU基础能力；原生扩展必须有明确单一profile边界 |
| descriptor indexing / unrestricted bindless | 不假定存在；显式少量banks+数组layer或VT；资源集合增加route |
| GPU-generated multi-draw count / GPU选pipeline | 不假定存在；CPU编码已发布bucket、GPU写indirect args |
| global GPU barriers / cross-workgroup spin | 禁止；独立dispatch与规范顺序 |
| 64-bit atomics | 不作为visibility/queue依赖；u32结构和硬件raster产品 |
| persistent compute kernel调度一切 | 不作为portable方案；公平调度/occupancy/同步和watchdog风险 |
| FrameGraph显式VRAM alias | WebGPU无通用heap placed-resource alias；只复用兼容GPUBuffer/GPUTexture对象或合法suballocation，不能把native alias barrier假装已具备 |
| async compute overlap | WebGPU单queue接口不保证独立async queue；不把理论并行计入预算 |

### 14.1 一个可落地的baseline binding预算

规范常见baseline：4 bind groups、8 storage buffers/stage、4 storage textures/stage、16 sampled textures/stage、16 KiB workgroup storage、65535 workgroups/axis。设备可更高，但不能先写需要16 buffers的shader再声称portable。

示例native shading资源：

- storage buffers 8个：①queue；②geometry arena（含index/attributes目录）；③Scene/transforms；④material+frequency数据；⑤cluster+light数据；⑥shadow metadata/page table；⑦packed Aux output；⑧可选provider/VT metadata。多个无关owner可以提供只读range到稳定的物理profile，但不能为了凑数创建每帧全量copy；range打包是发布/owner设计。
- sampled textures最多16：Visibility、Depth占2；材质banks预算6；VSM depth 1；IBL cube 1、BRDF LUT 1；其余5给VT/atmosphere/具名provider。当前九bank配置若再加全部providers会逼近上限，应在publication形成合法profile，不在hot shader临时补绑定。
- storage textures：默认HDR一个；packed Aux用buffer避免四个texture出口用尽。RichClosure/reconstruction profiles重新编译明确layout，不能无限添加binding。

表是新layout设计，不表示当前arena已满足全部打包需求。某效果要求额外资源时，优先在其独立pass消费，或选择更高能力profile；基线不足时必须明确admission失败/可选质量tier，不能非法绑定或丢效果。

### 14.2 VT不是免费的bindless替身

VT有page lookup、physical address、边界gutter、mip/anisotropic footprint和feedback成本。小场景直接texture bank往往更快；大场景以bounded physical atlas交换resident capacity与固定绑定数量。V4支持二者的native sampling函数，不为减少pipeline数强制每张小纹理VT化。

## 15. AAA 系统接入推演

### 15.1 Virtual Geometry

Geometry owner负责LOD/SSE、HZB遮挡、meshlet work、parent/child选择、page residency、instance animation、triangle decoding、raster策略；输出完整winner lookup所需的稳定frame view。Surface不做二次LOD，不在material hit时才决定是否需要基本几何。

FrameGeometryArena继续作为唯一物理owner，但哪些数据预计算要重审：变形顶点被Visibility/Shadow多次消费可物化；仅shading需要且每微三角形只有一pixel的巨大setup不应先全写。Geometry自己统计decoded vertices/triangles、screen-size分布、每triangle覆盖和page miss；Surface优化不能掩盖VG过度工作。

primitive身份需兼容LOD、streaming和motion变化。Temporal使用Geometry提供的validity/变化事实；不要创建跨帧每pixel完整Geometry identity库。

### 15.2 Virtual Texture

native compiler把图采样lower为 `sampleMaterialTexture(logicalID, uv, gradients, samplerPolicy)`；资源profile决定bank采样或VT采样。

VT owner负责virtual→physical page table、resident mip、gutter/filter规则、fallback ancestor、feedback去重、upload预算和eviction。gradients先在virtual domain计算LOD，不使用物理atlas UV差分。缺页回退至已驻留祖先mip；反馈异步供未来帧streaming，不能本帧GPU→CPU→GPU等待。

反馈可以tile/page聚合，不能每次纹理sample都无条件global append。全局Surface identity不参与VT cache正确性。pixel reactive可标识明显residency变化，但是否保留历史由Temporal判断。

### 15.3 Virtual Shadow Map

Depth/Visibility提供receiver位置→Shadow owner产生page需求、分配/失效、caster work、atlas raster→native lighting查询page table和depth。必须在lighting读取前完成同帧必要页生产。

缺细页使用已定义的coarse shadow fallback；VSM owner保证表/页一致。shading按实际灯光footprint请求PCF/过滤，不调用Surface cache。Shadow caster程序从同一material graph提取alpha/deformation closure，避免另写一套不一致的alpha语义。

现有 `render/vsm/` 是复用候选，不表示已完整满足V4的大规模page生产性能。VSM的256MiB预算也不自动等于一个8192²atlas加所有临时资源都合法。

### 15.4 ReSTIR

ReSTIR DI的reservoir不是一张“可直接加到HDR的颜色”。candidate proposal、target evaluation、temporal/spatial resampling、visibility与final normalization都需要明确数学合同和目标材质信息。

推荐启用ReSTIR的Standard PBR profile使用B式compact material resolve：

1. native material→depth/normal/albedo/roughness/F0或足够closure + motion。
2. ReSTIR候选生成、历史重投影与spatial reuse，reservoir数据/history归ReSTIR。
3. shadow visibility使用Shadow provider；final direct shading消费被选灯与归一化权重。
4. IBL/emissive与direct合成一次；普通cluster loop不再重复加同一批direct lights。

32B×2 reservoir @1080p约126.6MiB只是一个示例layout预算；真实algorithm字段/precision独立核对。half/quarter rate以denoising和误差评估决定。无ray query的WebGPU不能把RT可见性免费获得：可使用VSM支持的direct shadow查询；未知GI可见性需screen-space/probe/software traversal等具体方案。不能因此称已支持无偏任意RT ReSTIR GI。

custom BSDF若不适合compact closure，可生成专用target evaluation程序或更丰富closure；编译器接口已容纳这种需求，但计算与存储会增加。这里不能靠minimal Aux神奇重建任意图。

### 15.5 SSGI / GI

Depth/HZB、normal、roughness、diffuse albedo、motion、HDR_base给screen-space tracing与denoising。screen-space结果对屏外/遮挡信息有固有限制；独立probe/voxel/离线GI可作为缺失信息provider，不能把SSGI描述为完整GI。

当前帧trace读取稳定HDR_base，不读自己正在写的HDR_final；避免反馈和读写hazard。间接diffuse结果如果是irradiance，由composite乘diffuse response一次；如果是demodulated/radiance，合同明确何处乘/除albedo。history、sample budget、variance、disocclusion归GI owner。GI不要求把六路signal重新写回来。

### 15.6 SSR / SSSR

输入：Depth pyramid、shading normal、perceptual roughness、motion、HDR_base；SSR owner做tile classification、ray queue、trace、denoise与history。低roughness/highlight边缘采用高质量profile；反射miss消费environment。

不能简单将SSR辐射加在已包含完整IBL specular的HDR上，否则双计能量。两种具名recipe：

- 普通fused写`HDR_without_replaceable_specular`，反射composite使用Aux求低成本IBL fallback并用hit confidence混合，再只加一次；该profile需要能由Aux恢复相应specular response。
- RichClosure/复杂coat不适用上述紧凑response时，fused额外输出**一个确有consumer的specular fallback平面**（rgba16float，8B/pixel），composite替换该分量。新增约15.82MiB分配及至少33.18MB write+read。

这张具名specular平面不是恢复六路通用signal；它随反射recipe存在，效果关闭便不生成。若独立coat reflection确实需要更多lobe信息，逐项计费，不许宣称最小16B Aux覆盖一切。

### 15.7 Atmosphere

Atmosphere owner持有transmittance/multiscattering/sky LUT与更新条件；native direct/IBL消费太阳/天空provider；sky和aerial perspective在合适的独立pass消费Depth/HDR。

避免在material shader内每pixel重算完整大气积分，也避免fused fog与post aerial perspective重复衰减。透明物体fog排序单独规定。LUT历史/dirty条件不归Surface。

### 15.8 Temporal / FSR / AI Upscaling

输入合同包括：internal/display extent、jitter、motion方向和单位、depth约定、pre-exposure/exposure、reactive/transparency mask、camera cut/reset、motion validity。定义一个canonical motion（例如current→previous的unjittered internal-pixel displacement）；provider adapter只做明确的单位/符号/jitter变换。当前TemporalFacts的jittered current-minus-previous UV不能直接冒充新合同。

Temporal owner决定color/history ping-pong、rescale与reset；Scene/Geometry保证previous transform/deformation可用，material/transparent提供reactive事实。不用Surface全屏persistent exact identity。

现有FSR3 upscaler模块可审计复用，不能把“FSR3文件存在”解释成frame generation或完整所有profile已验证。AI upscaler是另一个provider：portable WebGPU没有保证任意vendor AI SDK可用，也没有自动tensor-core能力；计算模型、精度、资源与fallback单独协商。GTX1650Ti无可依赖的RTX Tensor加速，AI路径未必比传统temporal更快。保留非AI重建作为正常质量profile，不承诺AI一定是最高性价比。

### 15.9 透明、alpha、MSAA及多视图不能被遗漏

普通Visibility只保留opaque winner。透明/折射必须走同一renderer内明确的forward/raster pass，复用native material backend、light providers和Geometry；这是不同物理需求，不是旧renderer兼容桥。排序、OIT内存、refraction读取HDR的时序单独设计，不在本提案中宣称已经免费解决。

Alpha-tested材质在Visibility/shadow阶段执行最小alpha closure；该sample可能在最终material中重复，但正确visibility不可省。图分析提取alpha子图，不能将整材质搬进early pass。

第一性能模型non-MSAA；MSAA需要per-sample visibility/edge shading和resolve策略，容量按sample数计算。VR/stereo按view复制需要的产品与view频率，不能直接套单视图预算。

## 16. 一个小而有用的 GPU Calibration Profile

**值得纳入V4开发方法，但只作为模型参数生成器，不建设第二套渲染验证平台。** 一个独立页面/原生小程序、十余类kernel、一个JSON结果足够。校准不是每次启动和每个patch都运行；换GPU/driver/browser/backend或关键profile时重跑。

### 16.1 最小测试矩阵

| Kernel | 参数与计量 | 避免的错误 |
|---|---|---|
| sequential read | 16/64/256 MiB或设备可容纳集；u32/vec4，checksum；GB/s | 全部落cache还叫VRAM带宽；shader被DCE |
| sequential write / read-write | 实际bytes分别记录，write至少写变化值 | 把读写总量按只读计；首次zero-init混进steady |
| random read | permutation gather与dependent pointer chase分开；stride/working set梯度 | 用高并发gather推断串行pointer链 |
| atomicAdd/CAS | 独立地址、每tile聚合、32–64个热counter、单counter争用 | 用无争用峰值评估program histogram |
| texture sample | sampleGrad/Level、bilinear/trilinear、格式/BC、coherent/random UV、多footprint | 以一张1×1贴图冒充真实材质吞吐 |
| ALU | FMA、整数寻址、mixed native PBR；依赖链/多accumulator分开 | 无限ILP测试推断normal/BRDF真实依赖性能 |
| special | sqrt/rsqrt、sin、pow、exp/log分别测；记录精度语义 | 将所有special合成统一成本；让常量被折叠 |
| shared + barriers | 64/128/256 lanes，不同shared bytes与bank模式 | 只测空barrier；假定wave固定32 |
| dispatch/pass | 0/1/许多workgroups，1/32/128 dispatch，同/不同pipeline，同/不同pass | 混CPU encode、GPU执行和queue wait |
| subgroup | 有feature才测reduce/broadcast/ballot与portable workgroup对照 | 不支持写成0ms；shader依赖非法uniformity |

每个kernel有结果checksum/readback用于防优化和正确性；readback在计时批次完成后，不在每次dispatch中间强制wait。它属于离线校准，不是生产帧visible/work control。

### 16.2 实验方法

预先编译、分配、预热；同一queue串行运行GPU作业。用支持的timestamp queries包围足够长的批次，避免单次几微秒被量化误差淹没。短kernel重复100–1000次时也要考虑热cache；记录cold/steady两个场景。至少3批、每批20个有效样本，报告median/P10/P90、样本数与异常原因，运行总长控制在几十秒量级。

无timestamp时可用大量重复后的queue completion观察**粗总wall time**，但字段标为wall、包含调度/等待，不填GPU throughput；对应模型参数保持unknown。校准不能靠CPU timer伪造精确GPU ms。

保存adapter可见信息、features/limits、driver/OS可获得部分、browser/Dawn/wgpu版本、power mode、分辨率、source hash、workgroup size、working set、格式、warmup与测量次数。尽量记录频率/温度；没有数据就声明未知，不创建一个虚假的“1650Ti标准结果”。

示例输出：

```json
{
  "status": "measured-or-unavailable",
  "identity": { "adapter": "...", "backend": "...", "sourceHash": "..." },
  "sequentialRead": { "workingSetMiB": 64, "medianGBs": null },
  "hotCounterAtomicAdd": { "counters": 32, "medianGOps": null },
  "nativePbr": { "profile": "normal-orm-eight-lights", "medianMs": null },
  "dispatch": { "count": 32, "gpuMs": null, "cpuEncodeMs": null }
}
```

null表示尚未测或不可用；本提案没有用这个JSON冒充结果。

### 16.3 如何用于决策

校准先替换§11中的throughput假设，再用一个真实native PBR probe检查预测误差。若真实probe比模型慢2×，先调查register spill、dependent fetch、divergence和纹理足迹，不允许只将ρ调大并宣布模型有效。

为方案建立置信范围而非0.1ms精度；最终排序由同场景完整GPU path决定。microbench能淘汰明显不可能回本的cache、program page与scan，但不能证明AAA场景性能。

## 17. 性能上限与1650 Ti现实目标

### 17.1 架构上限

此设计足以作为现代高性能WebGPU renderer基础：winner-only shading、native程序、有限跨pass产品、GPU工作生成、local algorithm histories、Geometry/residency/FrameGraph分工都不阻碍后续扩展。其上限受WebGPU缺乏通用bindless、GPU选pipeline、mesh shader和RT能力影响，不能承诺追平所有D3D12/Vulkan/console引擎。

“极致”应定义为：在指定画质/内容/设备/API下接近已测候选的最佳总成本，且最坏情况可解释。它不是架构名称，也不能由pass更少、cache更少、native更多自动证明。

### 17.2 1080p Surface目标

普通复杂PBR、moderate lights、high coverage、好的geometry/texture locality下，**6–10 ms**是值得验证的第一目标。5ms附近属于表中的乐观情形，需要较高有效吞吐；它不是默认承诺。复杂材质或多灯达到15–20ms乃至更慢完全可能，即使架构正确。

如果第一个native完整profile仍需20–30ms，不应立即添加cache/proof。先与等价native reference比较representation税，再检查program混乱、纹理足迹、geometry fetch、shadow queries与register pressure。若这些是真实必要工作，就降低质量成本/内部像素数或接受更低帧率。

### 17.3 AAA全开

对“GTX1650Ti，复杂场景，VSM+GI+SSR+Atmosphere+Temporal，native1080p稳定60”的一般目标，**没有足够的现实性能预算，不应承诺，默认判断不可达**。特定小场景、低质量设置、少灯可以达到，但不能用它证明长期目标。

一个仅用于压力判断的frame预算：VG/Visibility 2–5ms + fused6–10ms + VSM生产1–4ms + GI/SSR合4–10ms + atmosphere/temporal/post2–5ms ≈15–34ms，且各区间不是相互独立、最小值未必能同时实现。需要场景测量。16.67ms还要留CPU/呈现抖动和GPU峰值余量，不能把median16.6ms称稳定60。

建议quality tiers：

| Tier | internal scale | 光照/效果策略 | 定位 |
|---|---|---|---|
| 1650Ti性能 | 0.67–0.77动态 | moderate有效灯；有限VSM页/PCF；half-res GI/SSR；明确fallback | 60fps方向，仍需实测 |
| 1650Ti质量 | 0.85–1.0 | 更好纹理/阴影/反射，允许30–45fps或关闭部分效果 | 画质优先 |
| 现代中高端 | 1.0或高输出重建 | 更多residency、更高effect rates、协商subgroup/f16 | 扩展能力，保留同一owner架构 |

质量tier改变是显式产品配置，不能在性能测试里偷偷删灯、关feature或减少最终场景。

## 18. 可维护性：复杂性放在真正的问题上

| Owner | 唯一责任 | 不承担 |
|---|---|---|
| MaterialCompiler | 语义IR、依赖/梯度/频率、native生成、source mapping | frame queue、history eviction、GPU submit |
| ProgramRegistry | 编译并发、pipeline/layout cache、publication/device生命周期 | per-pixel field identity interning、全局cache正确性 |
| ShadingBins | route classification、完整queue、indirect args | 材质求值、缓存、光照历史、资源streaming |
| NativeShadingPass | 绑定具名输入、消费queue、写HDR/Aux | provider算法、shadow分配、temporal有效性策略 |
| Geometry | Scene→可见geometry与stable winner、motion输入 | 判断材质颜色能否复用 |
| TextureResidency/VT | logical texture到resident资源、预算与上传 | Surface程序调度 |
| Lighting | cluster/light数据与BRDF函数接口 | 全局Surface history |
| Shadow/ReSTIR/GI/SSR | 各自的算法、cache/history与质量 | 统一别的算法的identity |
| Temporal/Post | motion/exposure消费、reconstruction/history、输出 | 材质VM |
| FrameGraph | macro依赖、资源版本、生命周期、兼容复用、提交 | shader内部node scheduling、通用per-pixel任务系统 |
| Renderer | composition root与recipe选择 | 自己实现以上算法 |

Shader代码可由小的WGSL库和compiler组合生成：geometry reconstruction、material function、BRDF、cluster迭代、shadow query、IBL、aux encode。源码模块化不必对应显存中间产品；fused shader可以从可读、可单独验证的函数组成。

Pipeline绑定必须显式layout，尽量跨兼容program共享bind groups；per-instance数值更新只改参数，不触发pipeline/bind group全量重建。CPU工作维护publication变化列表；FrameGraph缓存compiled recipe，late binding解析当前资源view。只做实际需要的dirty更新，不让诊断系统进入每pixel热路径。

## 19. 当前代码的保留/删除地图

以下分类是**V4实施建议**，本次没有执行源码删除。KEEP不代表内容无需审计；DELETE也不表示删除仍被其他合法consumer使用的资源。实施时用import/生成链核对真实可达性，直接切断旧依赖，不为旧测试恢复架构。

| 分类 | 当前具体路径/符号 | V4处理及原因 |
|---|---|---|
| KEEP | `OEngine/src/gpu/GpuScene.ts`、`GpuRenderWorld.ts`、`GpuAssetStore.ts` | 保留Scene/资产GPU所有权与发布；清除Appearance旧runtime接线 |
| KEEP | `OEngine/src/gpu/VirtualGeometryResidency.ts`、`GeometryPageStreamingRuntime.ts` | 保留VG页身份/residency/streaming；性能归Geometry审核 |
| KEEP | `OEngine/src/render/HierarchicalWorkGenerator.ts`、`MeshletWorkCandidate.ts`、`CurrentHzbLateRecheck.ts` | LOD/SSE/HZB/meshlet职责成立；不转给Surface |
| KEEP | `OEngine/src/render/passes/PackedVisibilityPass.ts`、`VisibilityWorkSet.ts`、`MeshletBucketRaster.ts` | winner与depth生产保留；route/alpha入口随新compiler接线 |
| KEEP | `OEngine/src/gpu/GpuVisibilityKeyAbi.ts`、`SurfacePrimitiveAbi.ts` | 完整winner数学/解码身份，容量不为binning裁剪 |
| KEEP / REWRITE布局 | `OEngine/src/render/FrameGeometryArena.ts`、`FrameGeometryVertices.ts`、`FrameInstanceTransforms.ts` | 保留唯一owner与变换/解码复用；按真实consumer裁减arena，不保留强制full-screenGeometryRecord |
| REUSE MATH ONLY | `OEngine/src/shaders/winner_interpolation.ts`、`surface_geometry_completion.ts`、`surface_work_geometry.ts`、`SurfaceReconstructionOracle.ts` | 保留插值/梯度与独立oracle；改为native可内联函数，不携带store/ref协议 |
| KEEP frontend / REWRITE backend | `OEngine/src/material/AppearanceGraphCompiler.ts`、`AppearanceGraph.ts`、`StandardAppearanceGraph.ts` | dependency/CSE/dead outputs/语义有价值；输出native IR/backend |
| REWRITE | `OEngine/src/material/ExactAppearanceDag.ts` | 提取frequency/liveness分析；删除TapeStage、lane heap、指令tape lowering作为GPU执行格式 |
| DELETE hot backend | `OEngine/src/shaders/appearance_exact_dag.ts`、`OEngine/src/gpu/GpuAppearanceDagAbi.ts` | dynamic GPU interpreter和配套hot ABI退出；CPU oracle可另留typed IR evaluator |
| REWRITE | `OEngine/src/gpu/AppearanceProgramRegistry.ts` | 保留async编译、lease、device loss/cache；去掉Surface field publication identity interning职责 |
| REWRITE | `OEngine/src/gpu/GpuAppearancePublication.ts` | 输出program/instance/binding route/frequency records；不再输出tape/cache-key/field版本运行系统 |
| REWRITE | `OEngine/src/gpu/GpuSurfaceProgramSpecialization.ts` | 保留依赖特化意图；替换固定16族与旧Surface输出语义，支持native graph与Aux profile |
| DELETE / 替代 | `OEngine/src/render/surface/SurfaceWorkRuntime.ts`、`SurfaceWorkTypes.ts` | 替换为ShadingBins和NativeShadingPass；不把原类改名后继续持有全部协议 |
| REWRITE并移owner | `OEngine/src/render/surface/SurfaceFrameResources.ts` | 通用合法生命周期能力归资源/FrameGraph；不继续保留Surface统一768MiB scratch/history体系 |
| DELETE | `OEngine/src/gpu/GpuSurfaceWorkAbi.ts`旧heap/six-signal布局 | 以queue/Aux具名ABI替代，不兼容旧record stride |
| DELETE | `OEngine/src/shaders/appearance_closure_cache.ts`、`appearance_closure_key.ts`、`OEngine/src/gpu/GpuAppearanceClosureCacheAbi.ts` | nominate/exact compare/publish与persistent closure store整链删除 |
| DELETE | `SurfaceWorkRuntime`内signalHistories/revision/retirement链；`OEngine/src/gpu/GpuSurfaceSignalPacketAbi.ts`、`GpuSurfaceSignalStoreAbi.ts`旧六路合同 | 效果拥有自己的history；BRDF数学另行保留 |
| DELETE旧协议 | `OEngine/src/gpu/GpuSurfaceProofAbi.ts`、`GpuSurfaceReferenceAbi.ts`、`GpuSurfaceFieldStoreAbi.ts`、`GpuSurfaceFieldIdentityAbi.ts` | 不保留无consumer的Proof/Store/ref类型；资产自身generation不受此删除影响 |
| REUSE MATH ONLY | `OEngine/src/shaders/surface_work_lighting.ts` | BRDF/IBL/provider查询抽函数；删除signal history/rate/store接线 |
| DELETE旧reconstruct | `OEngine/src/shaders/surface_work_reconstruct.ts` | opaque native直接写HDR；SSR/GI等有自己具名compose，不恢复通用signal reconstruct |
| KEEP / REWRITE调用边界 | `OEngine/src/gpu/TextureResidency.ts`、`GpuTextureRefAbi.ts` | owner、banks、logical refs保留；binding set成本与VT profile重新定价；删除只给proof的metadata |
| KEEP有consumer部分 | `OEngine/src/material/AppearanceNormalFilter.ts`、`AppearanceNormalCooker.ts`、`AppearanceMipCooker.ts` | 保留有质量依据的normal/mip数学；不自动保留复杂variation proof产品 |
| KEEP | `OEngine/src/render/passes/LightClusterPass.ts`、`OEngine/src/shaders/light_cluster.ts`、`OEngine/src/gpu/LightDatabase.ts` | cluster/light owner与完整容量策略；native消费者接线 |
| KEEP并复审成本 | `OEngine/src/render/vsm/`，尤其 `VsmReceiverDemandPass.ts`、`VsmAllocatePagesPass.ts`、`VsmAtlasRasterPass.ts`、`VsmResidency.ts` | VSM有真正理由拥有cache/page history；不等同已完成V4性能 |
| REWRITE | `OEngine/src/render/temporal/TemporalFactsPass.ts`、`OEngine/src/shaders/temporal_facts.ts` | motion/validity事实保留；删除默认全屏rgba32uint exact-like identity双缓冲，按Temporal真实验证需求设置局部history |
| KEEP并适配 | `OEngine/src/render/passes/fsr3/`、`OEngine/src/render/environment/AtmosphereLutResources.ts` | 独立provider/效果；核对完整输入与能量/曝光语义 |
| KEEP | `OEngine/src/framegraph/FrameGraph.ts`、`CompiledFrameGraphCache.ts`、`ReusableResourceManager.ts`、`ShadeGPUCommandContext.ts` | 宏观依赖与资源生命周期成立；不移植Surface微调度进去 |
| REWRITE | `OEngine/src/debug/SurfacePhaseTiming.ts`、`SurfaceDiagnosticsCapture.ts` | 按实际pass归因、unknown单列；去掉旧阶段名称驱动的错误统计与全时热点原子 |

历史`WinnerPrimitiveInterpolation.ts`已不在当前目录，不把它列为待保留的当前文件；当前数学入口见上表。其余路径在实施前仍需再次确认HEAD调用关系。新文件建议放在 `render/shading/`，具体命名不是架构合同。仓库已退休的历史Store owner不重新引入。

### 19.1 新增的最小模块集合

建议新建 `material/NativeMaterialLowering.ts`、`material/NativeMaterialWgsl.ts`、`render/shading/ShadingBins.ts`、`NativeShadingPass.ts`、`gpu/SurfaceAuxAbi.ts`。真实provider沿用自己的目录。只有在明确需求出现时增加CompactClosure/ProgramPage，不先建一个通用V4Runtime框架。

## 20. 切换顺序与可证伪验收

这是V4建议执行顺序，不修改当前workstream阶段。正式实施可以选择V4计划后整体切换，不在本次文档任务里宣称已经采纳。

1. **校准与等价native可行性。** 固定一组PBR/Unlit/coat/custom graphs，对照CPU数学和当前有效语义；离线实验程序比较direct native、当前解释表示和A/B寄存器/带宽。实验是验证artifact，不接入第二条生产renderer。
2. **Compiler+完整资源profile。** 完成参数/频率/梯度、texture banks、publication、async pipeline。至少一个custom graph生成native源码且通过图输出/纹理LOD验证。
3. **生产opaque切换。** 先one-route完整fused→HDR，再连多route binning；Visibility/alpha与直接consumer同时修改。删除旧Surface入口、Closure Cache、Tape GPU执行和signals；中间可短暂不编译，单元结束必须编译/出正确产品。
4. **Aux+Temporal。** 对齐motion、jitter、exposure、reactive、camera cut和透明标记；去除旧identity大历史，核对FSR真实consumer。
5. **完整Geometry/Lighting边界。** VSM、cluster、环境、streaming正常/缺页/容量边界接通，检查是否仍有旧shader潜在依赖。
6. **算法扩展与可选优化。** SSR/GI/ReSTIR分别提交具体producer→consumer闭环；有数据后选择pixel compaction/ProgramPage/VRS。每个不赚钱的机制可彻底删除。
7. **最终场景验证。** GPU作业串行；编译、源码接线、质量、工作量、峰值内存、CPU encode和GPU总时间全部覆盖。当前任务只设计，不伪造这些结果。

### 20.1 正确性必测内容

- 背景、单pixel、奇数extent、屏边tail、近裁剪、退化/薄三角形、不同LOD/instance、negative determinant、skinning与motion。
- 同tile 1/2/4/16/64 routes；10000 instances/32 programs与许多真实unique programs分别测；每visible pixel恰好一个HDR writer，无漏写。
- empty routes、最大队列、2D indirect、resize、publication替换、device loss、资产缺页和合法coarse fallback。
- native与独立CPU/数学oracle比较material输出、normal、导数/纹理LOD、BRDF能量；normal map、coat、高光、暗部/HDR、快速运动质量。
- GI/SSR composition无重复IBL/direct，ReSTIR visibility/normalization正常；格式降精度按§8验收，不以预算未超限代替画质。

### 20.2 成本与淘汰标准

- 统计全frame timestamp和分pass总和，unknown/unclassified非零必须解释；CPU encode/queue latency单列。
- 控制变量包括coverage、k分布、program count、binding sets、纹理working set、lights、alpha overdraw；同图像误差条件比较候选。
- zero-reuse、最大混乱和cold compilation是独立场景；不把warm少数样本叫P95。
- active/retired/upload/history/scratch按物理resource去重计账；报告steady和resize峰值。
- binning若ordinary profile管理占比持续超过约20%且不能换来更大native收益，先简化/绕过；这不是通用硬阈值，最终看绝对ms和worst case。
- A/B若差异小于噪声，选更简单且下游支持更直接的profile；不为了“fused”保留负收益。
- 任何优化的100%理想收益≤管理税，删除；0%高税则不得默认开。

## 21. V4最可能再次失败的地方

| 风险 | 可观测信号 | 对应决策 |
|---|---|---|
| binning成为新Surface mini-OS | queue种类、fallback协议、counter/pass不断增加 | 保留一次分类/scan/scatter；仅有盈亏数据才扩展 |
| native source/pipeline爆炸 | 相同拓扑因参数不同创建pipeline，编译卡顿 | 参数不入ProgramKey；稀有小程序可测page；发布期预算 |
| bindless幻想 | 程序少但binding sets/routes剧增 | 图采样和residency共同设计bank/VT；按route数计成本 |
| fused寄存器spill | 少了产品却更慢；复杂shader陡增 | 缩短live range、拆CompactClosure profile；用A/B成本证据决定 |
| 高熵tile低lane利用 | k高、many mask lanes、texture locality差 | pixel compaction或native小page；不强守tile模型 |
| Geometry重建又变昂贵 | 每pixel重解码大顶点/重复transform | Geometry预处理有真实多consumer的结果，局部重算便宜部分 |
| compiler改变材质语义 | C/X/Y/LOD/normal精度问题 | independent oracle与高频图像；不能以更快掩盖差异 |
| Aux慢慢成为巨型GBuffer | 无consumer仍写、RichClosure常态化 | recipe输出闭包、逐产品byte budget；成本随效果归owner |
| 历史重新中央化 | Surface知道所有provider revision | Temporal/SSR/GI/ReSTIR本地history；Scene仅提供事实 |
| texture随机访存主导 | native ALU减半帧时不变 | residency/locality/材料采样足迹优化；承认带宽瓶颈 |
| 多灯/高PCF吞掉收益 | 灯数量/queries与时间近线性 | cluster剔除、明确quality tier、ReSTIR成本比较 |
| 微基准过度乐观 | 校准预测与真实PBR严重偏离 | 检查ILP、cache、divergence、混合资源竞争；不只调参数 |
| 缺乏真实AAA闭环 | provider接口有了但结果未被消费 | 每算法producer→产品→最终HDR测试，不接受空consumer |
| 为极端硬件牺牲扩展 | 固定1650Ti wave/limit或单一格式 | features/limits协商与有限profile；不建立两套核心renderer |

V4应允许最初的shader数量增加、局部代码重复和几十个dispatch；也应允许在实测需要时分阶段。真正不能接受的是没有消费收益的管理、没有质量依据的少算和没有实测边界的性能承诺。

## 22. 固定来源、物理实现与采用边界

本次先读固定GitHub源文件，再查作者技术资料/论文与规范。完整仓库可取得不等于本次审计整个引擎；以下只对列出的文件/函数负责。网络获取及阅读副本在本地 `.local/v4/sources/`，原URL固定revision。没有构建上游工程，没有运行其benchmark，没有把任何条目提升为“已移植”。

### 22.1 完整开源实现

| ID / 固定revision / license | 本次核读入口 | 物理实现观察 | V4采用边界 |
|---|---|---|---|
| W：WickedEngine `df44c3db4c4927492bc9c791eac715d98d7ed091`，MIT | `visibility_analyzeCS.hlsl::main`、`visibility_resolveCS.hlsl::main`、`visibility_shadeCS.hlsl::main`、`wiRenderer.cpp::Visibility_Shade` | primitive uniform/divergent分类；shader-type tile masks、atomic append、indirect bins；host逐shaderType dispatch；shade load Surface→TiledLighting→HDR，非全局closure store | 采用tile/program思想和masked消费，**不复制**bindless、Wave、push constants与固定shader-type bitmask的能力假设 |
| F：The Forge `cd5046893faba2dc7869243873bf01f02a6f0df9`，Apache-2.0 | `VisibilityBufferShadingUtilities.h.fsl::CalcFullBary/Interpolate2DWithDeriv`；`VisibilityBufferShade.frag.fsl::PS_MAIN` | 读triangle、重建bary/gradients、SampleGrad材质、normal/lighting；这个consumer是**fragment**，有nonuniform texture indexing | 数学与导数参考；不把它称为WebGPU compute binning完整donor |
| M：MaterialX `2d516f56752abbb8bc5d6d438bfb7970d1b6f8f7`，Apache-2.0 | `source/MaterialXGenGlsl/WgslShaderGenerator.cpp`构造及emit输入/参数函数 | graph backend、资源binding context、texture/sampler分离；该文件继承Vk generator并含兼容语法，不能仅凭名字当独立可运行WGSL生成器 | 参考backend边界；EEngine native lowering是具名本地实现，不宣称MaterialX全部节点兼容 |
| L：Filament `bb360e80259167c986e94db7b70153bcdb92c0e1`，Apache-2.0 | `libs/gltfio/src/UbershaderProvider.cpp::getMaterial/createMaterialInstance`相关实现 | material程序选择与实例参数、UV index/transform分开；有限材质变体与实例数据不是同一计数 | 程序/实例分离参考；不以其raster架构证明compute一定快 |

固定源链接：

- Wicked：[analyze](https://github.com/turanszkij/WickedEngine/blob/df44c3db4c4927492bc9c791eac715d98d7ed091/WickedEngine/shaders/visibility_analyzeCS.hlsl)、[resolve](https://github.com/turanszkij/WickedEngine/blob/df44c3db4c4927492bc9c791eac715d98d7ed091/WickedEngine/shaders/visibility_resolveCS.hlsl)、[shade](https://github.com/turanszkij/WickedEngine/blob/df44c3db4c4927492bc9c791eac715d98d7ed091/WickedEngine/shaders/visibility_shadeCS.hlsl)、[host](https://github.com/turanszkij/WickedEngine/blob/df44c3db4c4927492bc9c791eac715d98d7ed091/WickedEngine/wiRenderer.cpp)、[license](https://github.com/turanszkij/WickedEngine/blob/df44c3db4c4927492bc9c791eac715d98d7ed091/LICENSE.txt)。
- Forge：[math](https://github.com/ConfettiFX/The-Forge/blob/cd5046893faba2dc7869243873bf01f02a6f0df9/Common_3/Renderer/VisibilityBuffer2/Shaders/FSL/VisibilityBufferShadingUtilities.h.fsl)、[fragment consumer](https://github.com/ConfettiFX/The-Forge/blob/cd5046893faba2dc7869243873bf01f02a6f0df9/Examples_3/Visibility_Buffer2/src/Shaders/FSL/VisibilityBufferShade.frag.fsl)、[license](https://github.com/ConfettiFX/The-Forge/blob/cd5046893faba2dc7869243873bf01f02a6f0df9/LICENSE)。
- MaterialX：[backend](https://github.com/AcademySoftwareFoundation/MaterialX/blob/2d516f56752abbb8bc5d6d438bfb7970d1b6f8f7/source/MaterialXGenGlsl/WgslShaderGenerator.cpp)、[license](https://github.com/AcademySoftwareFoundation/MaterialX/blob/2d516f56752abbb8bc5d6d438bfb7970d1b6f8f7/LICENSE)。现有graph分析另有`7d0baeeb0b88b24394cbb4cb73aa0794d641af0a`来源记录，本次不混为同一revision。
- Filament：[provider](https://github.com/google/filament/blob/bb360e80259167c986e94db7b70153bcdb92c0e1/libs/gltfio/src/UbershaderProvider.cpp)、[license](https://github.com/google/filament/blob/bb360e80259167c986e94db7b70153bcdb92c0e1/LICENSE)。

### 22.2 论文、作者资料和规范

- [Deferred Attribute Interpolation for Memory-Efficient Deferred Shading](https://cg.ivd.kit.edu/publications/2015/dais/DAIS.pdf)，Schied/Dachsbacher。核读已有论文文本的表示、插值、偏导数和低频着色讨论。证明需要权衡triangle setup与pixel重建，不证明本场景一定更快。
- [Variable-Rate Compute Shaders in DOOM: The Dark Ages](https://static.graphicsprogrammingconference.com/public/2025/talks/variable-rate-compute-shaders-in-doom-the-dark-ages/Fuller-Hammer-variable-rate-compute-shaders-in-doom-the-dark-ages.pdf)，Fuller/Hammer，GPC2025。核读已有完整文本中compact/remap、质量修复以及撤回composite/fog VRCS的部分。第一方技术参考，未核得可直接移植整个VRCS的完整开放源码许可。
- [Spatiotemporal Reservoir Resampling for Real-Time Ray Tracing with Dynamic Direct Lighting](https://research.nvidia.com/publication/2020-07_spatiotemporal-reservoir-resampling-real-time-ray-tracing-dynamic-direct)，Bitterli等，2020。此处仅用于reservoir/resampling算法边界与扩展接口；未审计完整ReSTIR实现，**不构成本轮完整算法移植来源**。实施前必须另行固定完整donor（包括visibility/normalization/temporal条件）。
- [WebGPU规范](https://www.w3.org/TR/webgpu/)和[WGSL规范](https://www.w3.org/TR/WGSL/)，本次读取limits、features、indirect与采样/类型相关定义。规范随时间变化；以运行时协商与实际版本验收，不以“2026”推定硬件能力。

本次没有把受限UE源码、Nanite品牌、Frostbite演讲概述当完整可复制donor。也未找到一个完整开放实现同时覆盖“任意graph native WGSL + portable固定banks + bounded tile-route binning +上述全部AAA效果”。组合方案明确为**EEngine Native Material Pipeline（本地设计）**；Sorted Tile Routes与compiler lowering需独立数值/覆盖/GPU验证。来源账本的对应记录见[迁移来源文档](../porting/next-renderer.md)。

### 22.3 本轮实际完成和未完成

完成：当前源码/若干Git历史入口核读；原始cache诊断报告重新汇总；固定上游文件和license核读；三路线、数据流、WebGPU布局、成本模型、break-even、VRAM、扩展和代码地图设计；模型脚本可执行检查；文档结构检查在交付时报告。

未完成：V4生产实现、native shader编译、校准kernel、GPU实测、image质量对照、P50/P95、最终性能adoption。它们属于实施工作，不能由本文、旧oracle的`passed`或文档校验通过替代。