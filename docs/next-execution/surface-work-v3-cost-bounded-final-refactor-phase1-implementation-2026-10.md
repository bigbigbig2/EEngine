# Surface V3 Phase 1：Publication 与工作产品实施记录

**2026-10-05 复审补注**

本页保留Phase1当时实现与检查记录，不证明全部前置物理要求已落实。当前Phase5实施未收口；lazy witness、dense certificate/ref及预算映射须在必需Phase5.5补齐，之后才进入Phase6。具体发现、阶段责任和继续实施门槛见[阶段复审与准备](surface-work-v3-cost-bounded-refactor-review-and-readiness-2026-10.md)；以下历史结果不转授当前dirty代码。


日期：2026-10-04。入口：[执行计划 §4](surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md)、[设计 §5–6](../next-design/surface-work-v3-cost-bounded-final-refactor-design-2026-10.md)。起点 a491767b，生产基线 14c17078。本阶段没有进入 Phase 2，也没有登记正式性能验收或上游完整采用。

## 实际切换

AppearanceExecutionProfile 从原 scalar DAG 遍历 output 与所有 sample/Product 坐标祖先。发布 FieldExecutionProfile、DependencyGroup、SignalExecutionProfile、DomainRecipe、ProofProfile；保留完整字符串 interning，不以 hash 判断相等。各字段包含实际 input/seam/UV mask、等价 RGBA query、C/X/Y coordinate/value 成本、cache/value cost class、proof DAG/query/visit 边界与质量参数。不同 source、sampler、transform、decode、parameter 和 UV lineage 不合并。普通 UV normal/ORM 保留 StableCache；view/nonlocal/不支持坐标导数的闭包走 DirectTransient，geometry 空间候选保持独立类别。

GPU publication 按实际 material directory 行数 N 分配 profile，不把它当 P 个 PSO。完整 Field identity/version/dependency epoch 仍是独立值身份；profile token 不替代动态 geometry/support/provider 验证。field identity 第 8 word 指向自己的 profile；material profile header 发布真实 input union，signal profiles 预合并 seam 和字段依赖。address、compatibility、signal request 与 FieldStore 路由已有真实读取。Ddirect 此时仍为 colored residual，未提前删除 albedo/coat 等当前公式依赖。

SurfaceCoveragePass 全帧一次扫描 Visibility + MeshletWork + publication，给每个 padded tile 保留 fine descriptor，产出 coverage、enabled profile union、generation、uniform entry 摘要和 ActiveTileList。每个 tile 最多 append 一次，预留 T 个 active index；不依赖可选队列剩余容量。列表顺序不作为屏幕连续顺序使用。

CPU 仍按 extent 编码最大 B 个范围。GPU range producer 从 active count 发布实际 count 和独立 indirect 参数，同时写入 batch 的绝对 tile/origin/coverage。setup request、facts、address、lookup、certificate、分类、demand emit/compact 和 reconstruct 使用实际 indirect；不读回本帧 count 控制编码。需 barrier 的 shader 保留 uniform 容量检查，不能根据 storage 原子读取做分歧 early return。

工作模板实际支持 Publication/Default、ImplicitFine、Uniform rate、Mixed：

- ImplicitFine 直接用 tile/lane 编号；物理最坏 fine slot 仍预留。
- Uniform 从率与真实 coverage 找到 source，不再写/read 固定 grid anchor map。
- Mixed 使用完整 24-word reservation 后发布的 append map；池最坏容纳 K×21 个条目，失败保留完整 fine 描述。
- Constant/Default 从 palette mask/presence/material/generation 公式得到 ref；不再逐 leaf 初始化 15 份常量/default ref。Zero signal 由 enabled/coverage 公式退出，不写 6 份零 ref。
- source leaf 与 transient/Store 物理 value slot 分离。publication/point/domain/Unknown/PendingValidation 状态定义独立；Mixed summary 不被当成所有成员已有 domain proof。

删除被替代的固定 grid anchor 写入和 getter、未消费的旧 plan WGSL helper、firstTile+local/absolute−firstTile 寻址，以及 reconstruct 每批重复生成全屏 B 个 indirect 参数的调度。生产仍只有一个 FrameGraph/submit；未增加旧新桥接路径。

稀疏输出的必要接线前移：背景 writer 只写 coverage 外像素，active reconstruct 只写 coverage 内像素。两者互斥，每个 extent 像素写一次，HDR/TemporalFacts reactive 语义保留。diagnostics 汇总 GPU 实际 batch count，并补全全屏 empty tile 数，不能把 active 数误报为 totalTiles。

## 物理账与后继边界

这些是实际 ABI 与现有 planner 的保留量，不是最终 512MiB/65536-target 架构已经达成。

| 产品 | 实际 layout / owner / consumer |
|---|---|
| execution profiles | 380 words/material=1520B；header8 + 15×20 + 6×12；Appearance publication 生命周期；地址/兼容性/请求读取 |
| coverage + active list | 16 + T×32 + T×4 B；1080p 1,166,416B；Surface frame scratch；range/background/diagnostic消费 |
| active args + indirect | 16B STORAGE/COPY_SRC + 16B INDIRECT/COPY_DST/COPY_SRC；range 后 pass 外 copy；消费者只读 indirect |
| batch header/plane templates | 64B header + 21×24B/K；覆盖、绝对地址、source rate/proof summary；真实 downstream 读取 |
| mixed map pool | 最坏 K×21×96B，actual append，仅非公式关联写入；不再有每 tile/plane 的固定 map 地址合同 |
| refs / value / proof scratch | fine 最坏池继续有界预留；常量/零引用公式化，非公式 Store/alias ref 保留；地址/证书/worker对应 owner 后继切换 |

1080p 当前 R=23,296、K=364、B=90；Workspace 33,741,856B、最大256-program Demand 22,700,544B、GeometryRecord 16,773,120B、field values 5,591,040B、signal values 2,236,416B。新 coverage 和 active arguments 已计入 productionAllocations/ledger；旧 reconstruction indirect 分配删除。当前 planner reserved=343,836,816B，尚不能把这个政策保留量称为 GPU 实测峰值或含所有 retirement 的最终预算验收。

当前 Workspace 名称仍承载 batch 的物理 cold scratch：dense address/leaf certificates、完整 key getter/dedup 和 pool clear 尚在对应后继 owner 使用。没有第二份新旧 workspace 镜像；本阶段替换的是工作模板、常量/zero ref、map 与调度/寻址切换单元。Phase 2 做保证 local setup 与 Geometry hot/cold，Phase 3 做候选/证明受理，Phase 4 删除任意 member/domain 搜索，Phase 5 切换 worker/request 组织，Phase 6 收口 payload reset/retire。不能把这些后继任务或最终删除量记成 Phase 1 已完成。

ProofProfile 的 32 visits 是后继 admission 上限；另记旧完整 variation 的保守 visitBound（32 mip×9 wrapped rectangles×4 nodes×等价 query 数），未谎称当前 query 已执行最终 32-visit budget。只发布 profile 不代表 proof operation count、总受理≤R/2 或廉价完整 key 已实现。

## 本阶段实际验证

- npm --prefix OEngine run typecheck：exit 0。
- npm --prefix OEngine run build：exit 0；生产 tsc、Vite bundle、build declarations。
- npm --prefix OEngine run build:test：exit 0，之后使用新鲜 .test-dist。
- node --test：39 项通过，覆盖新增 surface-execution-profile，以及 field publication/dependency、field identity oracle、bound specialization、cell plan、batch consumption、capacity、frame resources、Geometry publication。
- 新 phase1-production GPU fixture：Chrome 154.0.8037.93、真实硬件 WebGPU；25 个生成模块 compilation error=[]，API/page error=[]。真实 classifier→demand→Geometry→Appearance→Lighting→Store publication→HDR 消费，完整15-field/6-signal mask、constant/empty/mixed、NPOT 25×9、绝对 tile 与 append map。
- 同一编译图与物理产品复用三帧：active `[0,2,5,7]` / `[]` / `[1,5]`，实际 batch count `[2,2,0,0]` / 全零 / `[2,0,0,0]`；可见137/0/72像素，每帧225个正确输出写入，无陈旧背景。
- Showcase 串行短 smoke：GTX1650Ti、Chrome154、1920×1080、Dungeon overview、AO/FSR3/Bloom开、VSM/jitter关；timing3帧（warmup2），独立detailed1帧（warmup1）；errors=[]、sourceDrift=false、GPU验证/device loss/采样失败均0。totalTiles32400、empty23461、visible552598、coverage=pass，overflow=0；观察overview截图未见相对历史同视图新增明显缺失。

本地诊断目录：.local/validation/surface-phase1-serial/ 与 .local/validation/surface-phase1-showcase-serial/。新 runner/fixture 在 validation/labs/surface-optimization-v1/；报告与截图保持 ignored，不作为正式 evidence 提交。

曾出现 WGSL reserved keyword 与 barrier uniformity 错误，已在新主链修复。并行浏览器 GPU 检查曾触发 D3D12 OutOfMemory/device loss，不能认定那次通过；销毁并串行重跑后小链与 Showcase 均通过。后续本机 GPU 检查串行进行。

短 timing 的 GPU pass sum P50=480.126624ms、frame span=544.416608ms、Surface=469.271904ms、CPU=91.04ms。主要剩余成本：两份 classifier约191.8ms、certificate约86.4ms、Field/Signal lookup约67.0ms、address约35.1ms、demand约39.5ms。历史run06的801.7/790.4ms仅供诊断参照；本次3样本、不同预热/热状态，不计算正式提升倍数或宣称目标性能已达成。

未运行：Phase 2–6 实现及其检查、verify --full、跨浏览器/resize/cut/device recovery/连续质量矩阵、同条件独立checkout性能比较、正式 claim/adoption 提升。原因：用户本次仅授权完成 Phase 1；最终范围留在 Phase 7，阶段通过不能代替最终验收。
