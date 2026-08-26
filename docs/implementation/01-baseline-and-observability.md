# 01 · R0 基线与可观测性

## 阶段目标

先建立能解释一帧的证据链，再决定优先重写 LOD、软件光栅、HZB、材质还是提交路径。R0 不以提高 FPS 为主要目标；它的退出条件是所有后续性能结论都可以被复现和反驳。

A/B 是 three.js 两个示例给出的最低垂直功能与性能基线，不是产品完成标准；C 与通用 vertical/lifecycle cases 才继续覆盖 OEngine 的多资产、动态世界、完整效果和工程生命周期。三类 benchmark 必须通过同一 OEngine 主管线运行，只改变 manifest、数据和 feature set。

## 非目标

- 不在本阶段重写 Visibility 主算法。
- 不以加入 timer 后的一次 FPS 数字宣告瓶颈。
- 不用不同模型、材质、DPR 或后处理配置直接对比 OEngine 和 three.js。
- 不把 debug readback 留在每个稳定帧。

## 当前代码入口

| 关注点 | 当前入口 | 已知事实 |
|---|---|---|
| 全局更新与统计 | `OEngine/src/gpu/GraphicsContext.ts` | `update()` 创建并结束独立命令，触发 collection limits 更新 |
| Scene/动画更新 | `OEngine/src/gpu/GPUSceneContext.ts` | `update()` 无条件创建 animation flush command |
| 主帧编排 | `OEngine/src/render/Renderer.ts` | 每帧创建主 FrameGraph，并串接 Visibility/HZB/Material/效果 |
| 图执行 | `OEngine/src/framegraph/FrameGraph.ts` | 支持 compile、pass culling、execute，但主帧拓扑未缓存 |
| GPU 时间 | `OEngine/src/framegraph/GPUTimer.ts`、`GPUPerformanceTimer.ts` | 作为现有能力核实真实接入、query 容量和 readback 频率 |
| 工作量统计 | `OEngine/src/gpu/GPUCollectionLimits.ts` | 现有 readback 路径需要改为显式采样 |
| Visibility | `OEngine/src/render/passes/VisibilityPass.ts`、`OEngine/src/gpu/MeshletDrawList.ts` | bucket/scan/expand/second chance 与 `drawIndirect()` 主路径 |
| HZB | `OEngine/src/render/HierarchicalZBuffer.ts` | 每个 mip 开独立 Render Pass |
| Material | `OEngine/src/render/passes/MaterialExpandPass.ts` | material depth 后按材质画全屏三角形 |

以上是调查起点，不是保留承诺。

## 计划新增与修改

建议新增：

```text
OEngine/benchmarks/
├─ README.md
├─ harness/
│  ├─ BenchmarkHarness.ts
│  ├─ EnvironmentManifest.ts
│  └─ ResultWriter.ts
├─ scenes/
│  ├─ ComputeRasterA.ts
│  ├─ ComputeRasterIblB.ts
│  └─ GeneralSceneC.ts
└─ results/                  ignored or artifact-managed measured output

OEngine/src/debug/
├─ FrameCounters.ts
├─ FrameProfiler.ts
└─ RenderDebugView.ts

examples/
├─ r0-observability/       # profiler/environment/result 导出垂直页
├─ benchmark-a/            # three.js Compute Rasterizer 对齐
├─ benchmark-b/            # Compute Rasterizer IBL 对齐
└─ benchmark-c/            # OEngine 通用压力
```

预计修改 `GraphicsContext.ts`、`GPUSceneContext.ts`、`Renderer.ts`、`FrameGraph.ts`、现有 timer/statistics 类及关键 Pass。目录和类名可在实现前按局部 `AGENTS.md` 调整，但职责不得重新散回每个 Pass。

## 观测数据契约

### GPU counter buffer

使用固定 `u32` 数组作为 baseline ABI，按 256 字节对齐分配，首版至少包含：

| 字段 | Producer | 说明 |
|---|---|---|
| candidateInstances / visibleInstances | Instance cull | 输入与通过数量 |
| visitedBvhNodes | hierarchy traversal | 访问节点数；R0 期间可为 0 |
| candidateClusters / selectedClusters | work generation | 光栅前工作量 |
| rejectedFrustum / rejectedCone / rejectedHzb | culling | 各原因互斥或明确可重叠语义 |
| swClusters / hwClusters / alphaClusters | classifier | R4 前可为 0/现有 HW 数 |
| swTriangles / hwTriangles | raster queue | 实际进入两条路径的三角形 |
| shadedPixels / emptyVisibilityPixels | resolve | 单次扫描工作量 |
| activeMaterials / activeLights | GPU world/shading | 场景复杂度 |
| queueOverflowMask | 任一 producer | 每个 bit 对应一个已登记队列 |

Owner 是 `FrameProfiler`。每帧在主 encoder 内清零，由 GPU pass 原子累加。counter 不参与当前帧 CPU 决策。

当前落地 ABI 为 `schemaVersion=1`、总长 256 bytes，字段索引固定在 `OEngine/src/debug/GpuFrameCounters.ts`。producer 通过 `FrameProfiler.copyGpuCounter()` 复制已有 GPU 数量，或在直接原子写入共享 counter buffer 后调用 `registerGpuCounterFields()` 登记字段；结果只导出本帧实际登记过的字段，尚未接线的 producer 保持字段缺失，不以 0 冒充真实统计。ABI buffer、清零、采样 copy 和归档已接入主帧。

首个真实 producer 是最终 Visibility Buffer 像素统计：`VisibilityCounterPass` 在所有 opaque、second-chance 与 alpha-tested Visibility 完成后，以 8×8 工作组归约 `r32uint mesh-id` attachment，每个工作组最多执行两次全局原子加，写入 `shadedPixels` 与 `emptyVisibilityPixels`。这里的 `shadedPixels` 精确定义为“最终 Visibility Buffer 中 mesh-id 非 sentinel 的像素数”，不是 Material/Lighting shader invocation 数。每个有效样本必须满足：

```text
shadedPixels + emptyVisibilityPixels
== internalWidth × internalHeight
```

该 Pass 只存在于 GPU counter 采样帧；非采样帧不清零、不复制、不分配 counter 资源，也不添加统计 Pass。

第二个真实 producer 是 `activeLights`：LightCluster 的 GPU frustum 与 HZB filter 依次产生两级运行时本地灯光列表，图内 `GpuListCounterAccumulator` 在 transient buffer 释放或复用前分别读取两级 raw count。两者都使用 4-byte count header 与 `u32` elements，64 KiB Buffer 的真实 capacity 是 16,383；任一级 raw count 超容量都设置 `queueOverflowMask` bit 3。filtered list 另外把实际可消费的 safe count 记为 `activeLights`，只统计送入 cluster assign 的 Point/Spot light，不包含 DirectionalLight。

第三组真实 producer 是现有 Visibility GPU list。`GpuListCounterAccumulator` 只在采样帧读取 count-prefixed list 的 GPU raw count，以 Buffer size、16-byte header 和元素 stride 推导真实 capacity，向 Counter ABI 原子累加 safe count；若 raw count 超过 capacity，则设置稳定的 `queueOverflowMask` bit。当前接线语义为：

| 字段 | 当前精确定义 |
|---|---|
| `candidateInstances` | 所有实际执行的 Visibility job 中，GPU scene frustum filter 接收的有效 mesh row 累计数；不是唯一 Application World instance 数 |
| `visibleInstances` | 所有实际执行的 Visibility job 中，GPU scene frustum filter 输出 mesh row 的累计数；initial、second-chance、alpha job 可重复出现同一逻辑 instance，因此不是唯一 Application World instance 数 |
| `rejectedFrustum` | `candidateInstances` 中未通过 scene sphere/AABB frustum test 的累计 row 数；不包含后续 instance/cluster HZB 或 cone reject |
| `candidateClusters` | 所有实际 Visibility wave/bucket 中 expand 后、进入 cluster/HZB cull 的队列项总和；可能包含 second-chance/alpha wave 的重复逻辑 cluster |
| `selectedClusters` | 实际送入 opaque、second-chance 与 alpha hardware raster draw list 的队列项总和 |
| `hwClusters` | opaque/second-chance hardware raster list 的队列项总和 |
| `alphaClusters` | alpha-tested hardware raster list 的队列项总和 |
| `hwTriangles` | 固定功能路径实际提交的 primitive 数；当前每个 Meshlet 固定 `drawIndirect` 384 vertices，即 128 triangles，不是 Meshlet header 中的逻辑 primitive count |
| `queueOverflowMask` | bit 0=`sceneMeshList`，bit 1=`meshletList`，bit 3=`lightList`；bit 2 为 material list 保留但尚无 producer |

每个无 overflow 的样本应满足：

```text
selectedClusters == hwClusters + alphaClusters
hwTriangles == selectedClusters × 128
candidateInstances == visibleInstances + rejectedFrustum
```

第四个真实 producer 是 `activeMaterials`。Material Expand 对 `SceneInstances.materials` 的去重材质集合过滤透明和未构建 context，并为剩余每项实际编码一个全屏 GBuffer draw；采样帧在 draw loop 结束后用 `GpuCounterAtomicAdder` 把真实 `lastDrawCount` 写入 Counter ABI。该字段衡量当前按材质重复全屏扫描的 GPU 工作，不声称这些材质最终都有可见像素。

cone/HZB reject reason、SW raster 与 material overflow producer 仍未接线，因此 `OBS-05` 保持 `Partial`。

### Timestamp contract

至少标记：

```text
frame
upload
animation
instance-cull
hierarchy-and-cluster-cull
software-raster
hardware-raster
hzb
material-resolve
light-cluster
lighting-and-ibl
shadow
transparency
temporal
post
```

不支持 `timestamp-query` 时仍记录 CPU encode/submit 和 counters，并在 `environment.json` 标注 `gpuTimestamps: unavailable`；不得用 CPU 包围时间冒充 GPU 时间。

### Readback ring

- 默认每 60 个 warm frame 采样一次，可由 benchmark harness 改写。
- 使用至少 3 个 staging slot，只有 GPU 完成的旧 slot 才 map。
- 稳定非采样帧不编码 counter/timestamp copy，不创建 readback buffer，不等待 Promise。
- 采样延迟允许跨帧，结果按原始 frame index 归档。
- ring 满时丢弃本次采样并增加 `droppedSamples`，不得阻塞渲染帧。

当前 `GpuReadbackRing` 已实现固定至少三槽、主 encoder 内 copy、submit 后 `mapAsync`、按 frame index 回填、满环丢样本，以及 map 失败后释放槽位。结果 Schema v2 通过 `diagnostics.droppedGpuCounterSamples` 与 `failedGpuCounterSamples` 显式保存异常；控制器会同时等待 timestamp 和 counter 的延迟结果。

### Result Schema v2

- `environment.engine` 保存 commit、dirty 和逐项 `dirtyReasons`。
- `environment.adapter.driver` 在浏览器无法提供时必须为 `null`，不能伪造。
- `environment.run` 固定 `baselineRole`、timestamp/counter cadence 与 readback ring slots。
- 每帧分别保存 CPU counters、GPU counters、timestamp、submit/readback/upload 和 graph 证据。
- 顶层 `diagnostics` 保存 validation、uncaptured error、device lost、counter dropped/failed；smoke 页面任一 dropped/failed 样本都显示错误状态。

## Benchmark 场景

### A · three.js Compute Rasterizer 对齐

- 160k instances、相同 Teapot 与 LOD 数据。
- 相同相机轨迹、实例变换 seed、分辨率、DPR 和颜色输出。
- three.js Hardware/Software/Hybrid 与 OEngine 当前 Hardware 分开记录。
- 关闭 PBR、shadow、post，只做简单 Visibility resolve。
- 最终最低功能覆盖必须包含 GPU LOD/work generation 和可切换 HW/SW/Hybrid Visibility；R0 可先记录当前缺项，但不得把 HW-only 页面标成 A 已通过。

### B · three.js Compute Rasterizer IBL 对齐

- 相同 glTF、Meshopt LOD/Meshlet、环境贴图、实例布局和相机轨迹。
- 相同 HZB 开关、PBR/IBL 属性和输出格式。
- OEngine 额外效果全部关闭并证明没有 Pass/资源残留。
- 最终最低功能覆盖必须包含材质属性重建与 PBR/IBL；只有场景看起来相似而输入属性或色彩空间不一致，不能通过。

### C · OEngine 通用压力

至少包含三个可独立缩放轴：

1. 多 geometry、多 material 的静态异构场景；
2. Packed instances 与独立动态 transform 混合；
3. alpha-tested、shadow、lights 和 temporal feature 的逐项压力。

每个轴使用固定 seed；不要把所有变量同时放大后再猜瓶颈。

C 不是“比 A/B 多开几个效果”的展示页。它必须验证相同 GPU-driven 主链能推广到异构资产、动态增量更新、Packed Instances、完整效果依赖和生命周期事件，而不退化为 CPU 遍历或样例专用旁路。

## 执行任务

### 当前落地进度（2026-08-26）

- 已有 Result Schema v2、CPU timeline、submit/readback/upload、可选 GPU timestamp、GPU counter ABI 与 P50/P95/P99 汇总。
- `BenchmarkRunController` 已统一 warm-up、采样帧调度，并同时等待 timestamp/counter 延迟结果收尾。
- 256-byte counter buffer 与至少三槽的非阻塞异步 readback ring 已进入真实 `Renderer.render()`；profiler 关闭时不分配 counter/ring 资源。
- 最终 Visibility Buffer、LightCluster 与现有 Visibility GPU list 已接入真实 GPU counter producer；采样帧输出像素、本地灯光、instance/cluster/HW 工作量和 scene-mesh/meshlet/light overflow 证据，frame smoke 会校验字段存在性、工作量关系与像素总数不变量。非采样帧不编码 counter clear/copy/readback 或统计 Pass。
- Shader source-of-truth 静态审计已覆盖 66 个文件，逐项记录 direct/runtime consumer、最近 pipeline owner、generator candidate 与删除候选；当前结论为 55 个 authored-live、5 个 dead candidate、6 个运行中的 oracle/generated ownership blocker。清单见 `OEngine/benchmarks/shader-source-audit.json` 与 `docs/SHADER-SOURCES.md`。
- HZB legacy 统计已改为记录每帧真实 build 次数与累计 mip pass 数，不再把同帧两次 build 报成一次。
- `OBS-06` 已建立单一 `render_debug_view` 控制面：VisibilityKey、reverse-Z depth 与 velocity 在时域/后处理之后覆盖最终 HDR 输入；HZB mip、三类 reject reason、LOD/Cluster level、SW/HW 分类、material ID 与 history validity 均登记为带原因的 `unsupported`，不会添加占位 Pass。旧 `feature_velocity_debug_view` 与独立 `VelocityDebugPass` 已删除；关闭和 unsupported 状态不创建 Debug Pass、瞬态输出或 readback。
- 原始 GPU timestamp label 已增加稳定逻辑阶段归类；Result 同时保留逐 Pass `gpuMs`，并将同一采样帧内的 Pass 先按 phase 求和后输出 `gpuPhaseMs`，避免用 Pass 样本冒充帧样本。未知 label 显式进入 `unclassified`，采样用 counter/debug Pass 单独进入 `observability`，不混入主渲染阶段。
- `validateBenchmarkEvidence()` 已建立 Result artifact 机器门禁：检查 Schema、clean commit/dirtyReasons、A/B/C role、adapter/尺寸/feature set、真实资产与相机 hash、采样帧数、diagnostics、异步 timestamp/counter 完成状态、counter ABI、逻辑 phase，并从逐帧 segment 反算核对 `gpuMs`/`gpuPhaseMs`。用户 `temp/` 的两份旧 Schema 1 smoke 已登记为 exploratory，不会误入 G0。
- `examples/r0-observability` 与 `examples/r0-frame-smoke` 已通过类型检查和生产构建；后者进入真实 `Renderer.render()`。
- 尚未完成 A/B/C 对齐场景、其余 GPU pass counter producer、unsupported 视图所需的逐像素 producer、浏览器控制台/截图复测和可用于 gate 的真实性能 artifact，因此 G0 仍未通过。

### OBS-01 · 冻结运行环境清单

输出 `environment.json` schema：commit、浏览器版本、OS、adapter 名称、driver、WebGPU features/limits、窗口像素尺寸、DPR、power preference、feature set、warm-up 和采样帧数。缺失字段使结果不可用于 gate。

### OBS-02 · 建立 A/B/C harness

让场景、相机轨迹、seed 和开关由同一个 manifest 驱动。可运行页面放在根目录 `examples/` 并通过相对路径引用 `OEngine`；three.js 结果可由其独立页面导出，但字段必须映射到同一 result schema。首版先证明截图与场景数量对齐，并检查 WebGPU validation error，而不是只运行 TypeScript 测试。

Harness 必须在结果中声明 `baselineRole`（`minimum-a`、`minimum-b` 或 `engine-generality-c`）和真实 feature bits。A/B 页面不得形成样例专用渲染器；C 不得复用 A/B 通过状态冒充通用性通过。

### OBS-03 · 接通 CPU frame timeline

记录 world/change set、resource upload、graph build/compile、encode、submit 前总耗时、submit 次数、readback 次数和每帧上传字节。使用 monotonic clock；不得把异步 GPU 完成时间混进 CPU encode。

### OBS-04 · 接通 GPU timestamps

在主 encoder 内分配 query 范围，Pass 只请求逻辑 marker，不拥有 query set/readback。处理设备不支持、query 容量不足和 feature off 的情况。

状态：`Partial`。主 encoder 的真实 Pass timestamp、异步结果归档与 unavailable 路径已接通；原始 label 现在映射到稳定的 `instance-cull`、`hierarchy-and-cluster-cull`、`software-raster`、`hardware-raster`、`hzb`、`material-resolve`、`light-cluster`、`lighting-and-ibl`、`shadow`、`transparency`、`temporal`、`post`、`observability` 和 `unclassified`。Result 按帧汇总 `gpuPhaseMs`，同时保留原始 `gpuMs`。主 encoder 之外的 upload/animation 独立提交尚无统一 timestamp，whole-frame marker 也尚未闭环，因此不能标为 Completed。

### OBS-05 · 接通工作量 counters

先覆盖现有 instance、meshlet、draw、material 和 light 路径。所有 counter 定义是“输入”“通过”还是“唯一项”必须写入 schema，避免重复累计后无法比较。

状态：`Partial`。固定 ABI、资源 owner、采样 ring、结果聚合和主帧生命周期已完成；最终 Visibility Buffer 已产生像素统计，LightCluster 已产生带 overflow 证据的 `activeLights`，Visibility GPU list 已产生 instance/frustum/cluster/HW 工作量，Material Expand 已产生实际全屏 draw 数 `activeMaterials`。cone/HZB reject、SW raster 与 material overflow 等 producer 尚未接入；字段缺失是“未接入”，不是“工作量为零”。

### OBS-06 · 建立 debug views

至少提供 VisibilityKey、depth、HZB mip、frustum/cone/HZB reject reason、LOD/cluster level、SW/HW 分类、material ID、velocity 和 history validity。尚不存在的数据视图显示 `unsupported`，不伪造。

状态：`Completed（R0 control surface）`。公共 `RenderDebugView` 目录统一登记 12 种状态，Renderer 只接受一个选择。当前三个真实视图共享 `rgba16float` 最终覆盖契约，并按输出/内部尺寸做显式坐标映射：VisibilityKey 对 `meshId + triangleId` 稳定哈希，depth 显示 reverse-Z mip 0，velocity 以色相表示方向、亮度表示屏幕空间幅度。其余视图因缺少可靠逐像素 producer 显示 `unsupported` 及具体原因；后续 producer 接入时扩展同一控制面，不新增独立 feature flag 或旁路管线。

### OBS-07 · 核实 Shader source-of-truth

为实际创建 pipeline 的 WGSL 建立 `shaderName → authored/generated source → generator → runtime pipeline` 清单。未被引用的 oracle/generated Shader 标为删除候选，不在 R0 顺手大规模改写。

状态：`Completed（inventory）`。`npm run audit:shaders` 生成确定性的 schema v2 JSON，覆盖全部 66 个 `src/shaders/*.ts`，并沿 import 图记录最近 runtime pipeline owner。审计发现 5 个没有静态 pipeline owner 的删除候选，以及 6 个仍在运行但没有仓库内 generator/source 的 oracle/generated 文件。后者已经追到具体 pipeline owner，作为对应模块迁移 blocker 记录；R0 不把它们误标为 authored，也不在缺少视觉/数值回归时直接删除。人工摘要与限制见 `docs/SHADER-SOURCES.md`。

### OBS-08 · 采集不可修改基线

在同机完成 A/B/C 的 cold/warm、P50/P95/P99。保存原始 JSON、截图、控制台错误和分析说明。任何后续阶段都以该 artifact 与前一阶段 artifact 双重对照。

状态：`Partial`。Result JSON 的机器 gate validator 与旧 artifact 登记已完成；旧 RTX 2060 SUPER Schema 1 数据只能证明当时 81 Box 主链的 3 submit、持续 readback 等探索事实，不能作为 A/B/C gate。A/B/C 的 clean Schema v2 JSON、截图、控制台和 cold/warm run bundle 尚未采集。

## 验收

### 正确性

- 同一 manifest 重跑得到相同场景数量、相机路径和 feature set。
- counter 清零、采样延迟和 frame index 经人工小场景验证。
- debug view 不改变正常 render graph 的输出；关闭 debug 后无对应 Pass/readback。
- timestamp unavailable 路径仍可运行。

### 性能

- profiler 关闭时没有 query resolve、counter copy、map 或额外 submit。
- profiler 采样开销单独记录，不混入默认结果。
- 能回答当前 OEngine 与 A/B 的差距分别来自 CPU、submit、cull/work generation、raster、resolve、lighting 或带宽中的哪些段。

## 回退与失败条件

- timer 导致 validation error：关闭 GPU timestamp，保留 CPU/counter 结果并修正 query 生命周期后再启用。
- A/B 资产或画质不能对齐：结果只能标为探索数据，不能用于性能 gate。
- counters 溢出：升级对应字段或缩小场景；禁止饱和值静默当真值。
- 若 profiler 本身改变图拓扑，必须提供完全关闭路径并分别量化开销。

## 阶段退出

`OBS-01` 至 `OBS-08` 全部完成，且 [PERFORMANCE.md](../PERFORMANCE.md) 每项字段都有自动化输出。收尾更新 `CURRENT-STATE`、performance Context 和 performance lesson；此后才允许用数据调整 R1–R5 优先级。

G0 退出只表示证据系统完整，不表示 A/B 功能追平或 OEngine 产品完成；后者仍由 G3–G5 与 C/vertical/lifecycle 门禁判定。
