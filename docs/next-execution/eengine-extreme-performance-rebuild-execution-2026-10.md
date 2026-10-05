---
id: eengine-extreme-performance-rebuild-execution-2026-10
state: current
verifies:
  - OEngine/src/render/surface
  - OEngine/src/framegraph/FrameGraph.ts
  - OEngine/src/gpu/SurfaceOptimizationCapacity.ts
---

# EEngine 极致性能重建执行计划

日期：2026-10-05。设计母稿：[极致性能重建设计](../next-design/eengine-extreme-performance-rebuild-2026-10.md)。

**本计划是重建的唯一执行入口。** V3 有界前端执行计划、优化 V1 执行计划、五步修复计划均已归档。

前提：本次重建**取代**此前所有 Surface 执行路线。不维护新旧兼容生产链，不使用占位效果、空 consumer 或永久 fine/miss 通过检查。

---

## 1. 三条架构不变量（每个切换单元都要过）

设计母稿 §3.1 的三条硬约束，在本计划中作为**每个切换单元的验收前置**，不只是最终目标：

| 不变量 | 检查方式 | 当前值 |
|---|---|---|
| **A 命令数解耦** | 数 dispatch：`Surface dispatch ≤ 小常数 × 执行类别数`，且与像素数解耦 | 47 批 × 48 = **2,263** ← 违反 |
| **B 管理成本上限** | `T(管理) / T(实际计算) ≤ 1` | 708.71 / 23.26 ≈ **30.5** ← 违反 |
| **C 复用层可关闭** | 关掉复用层后帧仍正确且仍在同一数量级 | 未验证 |

**不变量 A 是硬约束而不是性能目标**：它可数、任何提交前都能查、且直接绑定那个乘法基数。想加一个 pass，必须解释它属于哪个执行类别。

---

## 2. 切换单元总览

设计母稿 §20 的顺序把"执行与资源底座"（A）放在最前。**本计划做两处调整**：

1. **A 与 B 并行，但 B 先以 B1 竖切验证可行性。**
   理由：A 主要治 CPU graph 执行（近景 39.50–42.08 ms），占 Surface 785 ms 的约 5%。A 修完 Surface 从 785 变成约 743 ms——真实价值是让后续工作可测，但**它不碰那 708 ms**。先做安全的 A 会建立"底座已重构"的印象，而真正的手术还没开始。

2. **B1 竖切先行**：不做"一次性替换分类器 + 全 consumer + reset"（那是最大的不可逆改动），而是先用**一个域 + 一个最廉价 closure**证明三件事：域实体能建成、协议能绕过、输出能等价。

| 单元 | 与提案的对应 | 规模 | 可逆性 |
|---|---|---|---|
| **A0** 测量口径与基线 | 提案 §19.4 | 小 | 高 |
| **A1** FrameGraph 执行器 | 提案 §20 A | 中 | 高 |
| **B1** 域实体竖切 | 提案 §20 B（缩小） | **中** | 中 |
| **B2** 域/率全面替换 | 提案 §20 B | 大 | 低 |
| **C** 材质分类与信号复用 | 提案 §20 C | 大 | 低 |
| **D** Geometry 完整工作域 | 提案 §20 D | 中 | 中 |
| **E** Lighting/Shadow 极端路径 | 提案 §20 E | 中 | 中 |
| **F** Temporal/Post 与整体收口 | 提案 §20 F | 中 | 中 |

---

## 3. A0 — 测量口径与基线

**为什么先做**：没有可信的测量，"改进了"无法判定。当前 full per-pass timestamp 本身有约 7 ms 税（空 shader 实测 full span 7.504 ms vs coarse 0.393 ms），且 `pass sum` 遗漏 pass 间 copy/clear/gap。

**做**：
- production（无 profiling）/ coarse / stage / full 四种模式**独立**，不是同一配置的不同名字。
- Timer 使用持久 query/readback ring，异步回收，不每帧创建后销毁。
- 修诊断字段单位失真：`geometryRecordStrideWords` 写 8 而 hot 记录是 32 words——decoder 也比 8，所以 coverage pass 发现不了这个命名/单位错误。
- 明确**不可用**字段：多个 light/shadow/readBytes/allocation 字段无完整 producer，零不能证明无工作。

**退出条件**：四种模式各自可复现；每个 counter 有可指认的 producer；`pass sum` 与 `frame span` 的差被解释。

---

## 4. A1 — FrameGraph 执行器

**源码事实**：`FrameGraph.executeCompiled` 每节点后遍历全部 resource registry，检查 `entry.last === pass`。约 2,689 × 1,603 = 431 万次 entry 判断/帧。

图编译与 dump **已有缓存**——问题在执行，不是重编译。

**做**：编译结果直接包含
```
executionScopes[]
acquireAtScope[] / releaseAtScope[]
resolvedResourceSlots[]
historyBindingRoles[]
```
执行时只处理当前 scope 的引用与命令。

同时处理同物理 scratch 被多次 import 的身份膨胀。

**保留**：resource producer/consumer、依赖排序、未消费裁剪、transient 生命周期、历史角色、合法 alias 计划。这些对未来多效果组合有价值。

**退出条件**：空图缩放接近 `O(commands + references + lifetime events)`；真实 renderer 的 graph execute 明显低于现状；依赖与异常清理回归通过。

**注意**：A1 与 B1 无硬依赖，可并行。但 A1 的收益在 B1/B2 之后才会完全显现（node 数先掉下来）。

---

## 5. B1 — 域实体竖切（关键可行性验证）

**目标**：用最小范围证明域实体成立。**这是整个 B 的可行性门**——如果 B1 建不成（例如域描述装不下现有语义），在花掉数周之前就会知道。

### 5.1 范围（严格限定）

- **一个域实体**：`tileDomain`，8×8 tile 起步，32–64 B descriptor。
- **一个 closure**：选**最廉价**的类别——常量折叠后的值，或已有源纹理的简单采样（即当前命中率最差的那类）。
- **直接算**：不命中任何 cache，不进任何 proof，不产生 certificate。
- **一个 consumer**：只接该 closure 的实际消费者。

### 5.2 必须同时切换的单元

**替换 producer 与它的直接 consumer 是同一切换单元，只保留一条生产路径。**

| 角色 | 当前入口 | B1 中的处理 |
|---|---|---|
| producer | `SurfaceCellClassifierPass` 的 batch 循环 | 该 closure 走域路径，不进 batch 循环 |
| 表示 | `GpuSurfaceCellPlanAbi` 的密集 workspace | 新增 `tileDomain` ABI；密集表示仅保留给未迁移的 closure |
| consumer | `SurfaceFieldLookupPass` 对该 closure 的路径 | 改为从域描述推导地址，不 probe Store |
| reset | batch workspace reset | 该 closure 不再需要 |

**其余 closure 暂留在旧路径**——B1 是竖切，不是全面替换。但**必须保证双路径不互相污染**：域路径的 closure 不得被旧路径重复求值。

### 5.3 退出条件（全部可数或可断言）

1. **不变量 A**：该 closure 的 dispatch 数是**可声明的小常数**，与像素数、与 tile 数无关。
2. **结构性判据**：全屏同材质、UV 连续时，产生 **1 个**域描述、**0 个** exception。（当前架构下不可能成立）
3. **输出等价**：与 B1 前的逐像素结果**逐值等价**，有独立 reference。
4. **不变量 B**：该 closure 的管理成本 < 其实际计算成本。
5. **成本随需求增长**：域描述与 exception 的数量随真实需求变化，不随全屏容量。

### 5.4 明确不做

- 不建完整的域分类器（只建实体与一个 closure）。
- 不替换整个 `SurfaceWorkRuntime`。
- 不动 proof/certificate 家族（它们仍在旧路径上服务其他 closure）。
- 不改 `SurfaceOptimizationCapacity`（等 B2）。

**为什么不做**：B1 的目的是**证明可行性**，不是交付性能。它的价值在于把 B2 的风险从"数周不可逆"降到"数天可判断"。

---

## 6. B2 — 域/率全面替换

B1 通过后，B2 是把 B1 的形状**重复到全部 closure**，并删除被取代的机制。

| 删除 | 替代 |
|---|---|
| `SurfaceCellClassifierPass` 全批展开（809 行） | 单次 GPU 驱动域构建 |
| 21-plane 固定树与重复 reduction | 每域一次率决策 |
| `surface_cell_certificates.ts` 逐 leaf 证书（449 行） | 发布时分类 + 域级准入 |
| `surface_cell_group_validation.ts` 树验证（307 行） | 同上 |
| `surface_field_lookup.ts` 15 字段循环（276 行） | 廉价 closure 直接算 |
| `surface_signal_lookup.ts`（82 行） | 同上 |
| `SurfaceDependencyEpochPass` 每帧 4 dispatch（154 行） | 发布时验证 |
| `SurfaceOptimizationCapacity` 固定 envelope | 真实 layout 与 limits 推导 |
| 逐 batch workspace reset（4.73 GiB/frame 逻辑范围） | 域生命周期 |

**必须与 B2 一起切换**：需求、Record、**全部直接 consumer**、reset、capacity。不能分批留断链。

**退出条件**：不变量 A/B/C 全部满足；普通合法材质有真实共享成功（不是换一种永久拒绝）；完整覆盖；连续画质对照通过。

---

## 7. C — 材质分类与信号复用

**做**：
- 材质按设计母稿 §4.4 的四类处理。**发布时决定策略**，不在每 tile 动态预测。
- 删除简单源数据的等价缓存路径。
- 替换 72-word 通用 `SignalStore` 作为 lighting 复用默认机制：视向相关的 direct/specular/coat 用各自历史图 + reprojection + 局部依赖变化 + 置信度。
- 从宽 key 变小的方法：**改变依赖表达与地址域**（发布时给无歧义 domain ID），不是截断 key。

**退出条件**：命中真正跳过对应 heavy work；有独立画质与净收益；**不变量 C** 在此单元首次可验证（关掉复用层仍正确且同量级）。

---

## 8. D — Geometry 完整工作域

**做**：
- hierarchy max depth 来自 cook/package 实际数据，删除硬编码 64。
- 只编码真实表示最大深度的必要轮次。
- Product 路径接入真正的保守遮挡；相机普通运动不等于 camera cut。
- 帧属性按真实 consumer 共享；不各自解码一遍相同静态顶点。
- Shadow 的 caster 域独立于 camera-visible list。

**退出条件**：完整 coverage/无漏几何；selected work、SSE/HZB 数据可信；遮挡拒绝数有据。

---

## 9. E — Lighting / Shadow 极端路径

**做**：
- cluster 按 light bounds 影响范围分配（count → prefix → fill），替换每 cluster 扫全部 active lights。
- overflow 不再让百万 samples 各自遍历世界全部灯。
- VSM 用 light-space page binning 与更紧 bounds，替换 `meshlet × dirtyPages` 无差别关联。

**退出条件**：非零 provider；overflow 正确（池不足不静默截断）；off-camera caster 成立；大灯数下的成本可解释。

---

## 10. F — Temporal / Post 与整体收口

**做**：
- TemporalFacts 只生产一次；camera cut 清屏幕域 history 但不清静态 Appearance。
- 稀疏 lighting history 负责信号更新；FSR3/output temporal 负责最终图像。**不能两个系统各自无限平滑、靠输出 clamp 隐藏缺失工作。**
- 原生 1080p 与 upscale 分 profile 报告。
- Temporal identity 双 rgba32uint 约 63.28 MiB、FSR history 约 75.15 MiB，在 F 梳理，**不靠丢身份/关 history 满足性能目标**。

**退出条件**：连续画质；全帧 P50/P95；live/retired 峰值完整账目。

---

## 11. 每个单元的检查规则

沿用仓库既有节奏（见根 `AGENTS.md`），并补充本重建特有的部分：

1. **实现核对**：逐项核对真实 producer → 产品 → 全部 consumer。必需项遗漏、未测或无 consumer，单元未完成。
2. **结构性判据优先于计数**：优选用**可断言的结构事实**（如"全屏同材质 → 1 个域、0 个 exception"），而不是计数器下降。计数器可以被缩，结构不能。
3. **正确性与成本分开**：完整身份/失效、写域互斥、覆盖完整；以及实际 dispatch 数、字节、内存。**声称删除的工作必须真实消失或随需求增长。**
4. **测真实入口**：mock、源码正则、归档 shader、预填结果不证明生产算法。GPU 作业串行。
5. **失败先分类再修**：区分生产错误、旧 ABI 测试、fixture/harness、环境、未完成 runner。无法定位则如实未通过。
6. **禁止为过关放宽**：不删断言、不吞异常、不放宽容差、不关 feature、不用永久 fine/residual、不加测试专用 production fallback。
7. **三条不变量每单元必过**。

---

## 12. 测量与验收

### 12.1 四种报告模式（互不混用）

| 模式 | 用途 |
|---|---|
| Production，无 profiling | CPU 编码、帧间隔/吞吐、真实体验 |
| Coarse frame timing | 小预算 GPU 跨度 |
| Stage timing | 定位工作归属，稳定有限 query 量 |
| Full per-pass | 短时诊断，**profiler tax 单列** |

### 12.2 预算示例（设计容量检查，不是验收线）

| 部分 | 示例 GPU 预算，ms |
|---|---:|
| Geometry / Visibility / HZB | 3.0 |
| Surface 前端 / GeometryRecord / Appearance | 2.0 |
| Lighting / Shadow | 5.0 |
| AO / Environment | 1.5 |
| Temporal / Post / Present | 3.0 |
| 余量 | 2.17 |

CPU encode 可先按 2–3 ms 设计。**CPU 与 GPU 可能重叠，不简单相加成 FPS。** 这张表**不是预测，也不是已批准的验收线**。

### 12.3 最终验收至少同时满足

- 相同场景/分辨率/效果/约定画质下，完整帧 P50/P95 与 CPU 编码明显改善。
- 正常合法区域有实际节省，**不能全 fine 或全 miss**。
- 前端管理成本不再压倒重计算；cold 与 moving 时无数百 ms 管理爆炸。
- 工作覆盖与有效性完整；无静默截断、同 key 多 writer、错误 history。
- 真实命令、clear/copy、hot/cold 写入、live/retired 内存有可解释账目。
- 如最终达不到预算，**明确是哪些真实效果/输入成本超标**，再选择算法或产品 profile，**不篡改测量口径**。

### 12.4 最小场景矩阵

- 低/高可见覆盖；near/far；静止/持续移动/新显露。
- 简单常量与源纹理；昂贵静态与动态材质；normal-map、锐利 specular、coat。
- UV 接缝、跨 primitive 连续面、LOD 变化、形变、texture/page residency 变化。
- 有效非零 local lights；超 cluster 阈值；global 列表压力。
- VSM 稳定页/大量 dirty 页；移动光源；off-camera caster。
- Resize、camera cut、device 重建。

---

## 13. 不做什么

- 不恢复 V1/V2 执行模式。当前 V3 的问题不构成回退依据。
- 不为未来 ReSTIR/AI upscale 新建万能 scheduler / proof graph / provider registry。
- 不因为"现代"就强制全局 subgroup / 硬件 VRS / bindless / persistent shader。
- 不单独美化目录或改名——没有消费者收益的重构不是性能工作。
- 不重写未被证明错误或昂贵的 BRDF、插值、过滤、Atmosphere 数学。
- 不建立新旧 A/B 运行桥。独立 reference 在独立宿主或固定 checkout 中运行。
