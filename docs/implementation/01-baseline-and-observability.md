# 01 · R0 基线与可观测性

## 阶段目标

先建立能解释一帧的证据链，再决定优先重写 LOD、软件光栅、HZB、材质还是提交路径。R0 不以提高 FPS 为主要目标；它的退出条件是所有后续性能结论都可以被复现和反驳。

G0/R0 冻结的是“证据真实性”，不是要求提前完成 R2–R5。对当前已有并启用的算法，采样结果必须包含真实 GPU producer 写出的 counter，真实工作量为 0 时明确保存数值 `0`；对当前不存在的算法或尚未接线的观测 producer，Result 必须保存 `unsupported + blockerTaskId + reason`。G0 可以产出结构完整但仍带能力 blocker 的 artifact，不能把它宣称为 A/B 功能追平。Packed Instances、Hierarchy/SSE LOD 与 Compute SW Raster 的产品完成分别仍由 `WORLD-07`、`WORK-04`、`VIS-05` 及 G2–G4 判定。

A/B 是 three.js 两个示例给出的最低垂直功能与性能基线，不是产品完成标准；C 继续覆盖 OEngine 当前范围的多资产、Packed Instances、alpha-tested、CSM、动态灯光、Temporal/Upscaling、内存和扩展曲线。三类 benchmark 必须通过同一 OEngine 主管线运行，只改变 manifest、数据和 feature set。

## R0 收口总账

本表是 `01-baseline-and-observability` 的最终收口总账。`Completed` 表示已经满足 R0 的证据真实性目标，不因未来可以增加更多 counter、debug view、计时范围或正式性能采样而重新打开；只有发现当前声明为 supported 的证据是伪造、错误归帧或无法运行，才允许重新打开对应任务。

| 任务 | 状态 | R0 结论 / 唯一剩余交付 |
|---|---|---|
| `OBS-01` 环境清单 | `Completed` | Environment Schema、commit/dirty、浏览器/OS、adapter/features/limits、尺寸/DPR、feature set 与采样参数已经冻结并受 gate 校验 |
| `OBS-02` A/B/C Harness | `Completed` | Manifest、资产 hash/seed/相机、共享 runner、三个入口、Schema v3 导出、自动测试及 RTX 2060 SUPER 五页浏览器 smoke 均已完成 |
| `OBS-03` CPU Timeline | `Completed` | CPU frame 分段、submit/readback/upload、FrameGraph build/compile/execute 已归帧 |
| `OBS-04` GPU Timestamp | `Completed（R0 范围）` | 已覆盖真实 Compute/Render Pass、跨 CommandContext 异步归档、phase 汇总、失败及 unavailable；纯 copy/write 与跨 submit wall-clock 不属于 WebGPU Pass timestamp 能力，不再阻塞 R0 |
| `OBS-05` 工作量 Counters | `Completed（当前能力）` | 当前启用算法的 required counter 已有真实 producer；未实现算法由能力矩阵明确 `unsupported + blockerTaskId` |
| `OBS-06` Debug Views | `Completed（R0 control surface）` | 统一控制面与三个真实视图已接通，其余模式明确 unsupported，未来随 producer 所属阶段扩展 |
| `OBS-07` Shader Source | `Completed（inventory）` | 66 个 Shader 的 source/consumer/pipeline owner 审计已冻结 |
| `OBS-08` 不可修改基线 | `Closed as R0 blocker` | R0 以已登记的 Schema v3 smoke 冻结当前事实；clean/full cold-warm bundle 改为每个后续性能阶段开始修改前的基线刷新，不再阻塞进入 R1 |

因此 R0/G0 已完成，下一步直接进入 R1 的分析与计划。`OBS-02` 的 manifest、入口、自动核对和浏览器 smoke 已经整体收口；clean/full 性能采集只在后续阶段真正要做性能修改前执行，不再让 R0 无限等待。

### 固定剩余实施顺序

已完成的 `OBS-02` 建立了以下可重复输入与运行入口：

1. 冻结共享 manifest schema，包含 role、资产 hash、seed、相机路径 hash、实例/材质/灯光数量、尺寸/DPR、feature set 和 cold/warm 参数。
2. A 固定 160k Teapot 对照输入；B 固定 glTF、LOD/Meshlet、环境贴图与 PBR/IBL 输入；C 固定当前可以运行的 geometry/material/alpha/shadow/dynamic-transform 分轴输入。当前缺少的 Packed/Hierarchy/SW 能力写入 feature evidence，不为 R0 制造样例专用替代实现。
3. 新增 `examples/benchmark-a`、`benchmark-b`、`benchmark-c`，通过相对路径复用同一 OEngine public interface、`Renderer.render()`、`BenchmarkRunController` 和 Result writer。
4. 自动核对 manifest hash、场景数量、相机帧序列和 Result role；浏览器核对两个既有 smoke 与 A/B/C 页面无 validation/uncaptured/device-lost error，能导出 Schema v3 JSON 和截图。

第 1–4 项均已完成。开发链接使用 `?profile=smoke`，该 profile 会被 Result 强制标成 dirty/non-gate，不能冒充完整 A/B/C artifact。RTX 2060 SUPER 实机结果中，A/B/C 分别完成 12/12 帧、3 个 timestamp/counter 样本、全部 counter 不变量和零 diagnostics；当前能力 blocker 分别为 2/2/4 个，符合冻结能力矩阵。五页截图与 JSON 位于用户工作区 `temp/`，登记见 `docs/BASELINE-ARTIFACTS.md`。

`OBS-02` 完成只表示“输入和采集入口被冻结并可运行”，不表示 A/B 的 GPU LOD、SW/HW Hybrid 或最终性能已经追平。

后续阶段开始性能修改前，按原 `OBS-08` 契约刷新可比较基线：

1. 在一个干净、可定位的 commit 和主要开发/目标 adapter 上记录完整 environment；timestamp-query 不可用时走已冻结的 unavailable 路径。
2. 对 A/B/C 分开采集 cold compile/upload 与 warm steady-state，输出原始逐帧数据以及 CPU/GPU/counter 的 P50/P95/P99；profiled sampled run 与 profiler-off 总体性能分开保存。
3. 为每组保存 Result JSON、画面截图、控制台记录和简短分析，并登记到 `docs/BASELINE-ARTIFACTS.md`；任何 dropped/failed/pending evidence 或 validation error 都使该 run 作废。
4. `validateBenchmarkEvidence()` 必须返回 `gateEligible=true`。`capabilityComplete` 可以因后续能力 blocker 为 false；R0 报告必须写“当前基线已冻结”，不能写“A/B 已通过”或“性能已达标”。

这项刷新不是新的 R0 阶段，也不影响现在进入 R1。R0 不再增加新的 counter、debug view、场景轴或跨设备运行；这些需求进入其所属后续 Gate。

### 不再作为 R0 blocker

- Packed Instances、Hierarchy/SSE LOD、cone culling 与 Compute SW Raster 分别属于 `WORLD-07`、`WORK-04`、`VIS-05` 和 G2–G4；R0 artifact 必须诚实报告缺失，但不实现它们。
- HZB mip、逐像素 reject reason、LOD/Cluster、SW/HW classification、material ID 与 history validity 的新 producer 随对应后续算法实现；R0 统一 debug control surface 报告 unsupported 即为完成。
- `queueOverflowMask` 当前只声明并验证 bit 0=`sceneMeshList`、bit 1=`meshletList`、bit 3=`lightList`。bit 2 只是未启用的 material-list 保留位，不得宣称受保护，但也不要求 R0 为一个没有登记 ABI/producer 的队列伪造统计。
- WebGPU Pass timestamp 不能覆盖 command encoder 中的纯 copy/write，也不能用一个 query 横跨多个 submit；Result 保留 CPU upload/submit 时间、字节与次数，并明确 GPU 覆盖边界，不再为追求不存在的“整帧 query”延迟 G0。

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

## 已落地与固定剩余目录

当前已落地：

```text
OEngine/src/debug/BenchmarkHarness.ts
OEngine/src/debug/BenchmarkRunController.ts
OEngine/src/debug/EnvironmentManifest.ts
OEngine/src/debug/FrameProfiler.ts
OEngine/src/debug/GpuFrameCounters.ts
OEngine/src/debug/GpuReadbackRing.ts
OEngine/src/debug/RenderDebugView.ts
OEngine/benchmarks/README.md
OEngine/benchmarks/shader-source-audit.json

examples/
├─ r0-observability/
└─ r0-frame-smoke/
```

`OBS-02` 固定只新增 A/B/C manifest/scene 夹具与三个根目录浏览器入口；结果 writer 可以复用浏览器下载或 artifact-managed 输出，不再预设一套与现有 `OEngine/src/debug` 重复的 harness 目录。A/B/C 必须调用公开 OEngine seam 和同一个 `Renderer.render()` 主链，不新增 benchmark 专用 Renderer。

## 观测数据契约

### GPU counter buffer

使用固定 `u32` 数组作为 baseline ABI，按 256 字节对齐分配，首版至少包含：

| 字段 | Producer | 说明 |
|---|---|---|
| candidateInstances / visibleInstances | Instance cull | 输入与通过数量 |
| visitedBvhNodes | hierarchy traversal | 访问节点数；producer 不存在时必须声明 unsupported，不能填 0 |
| candidateClusters / selectedClusters | work generation | 光栅前工作量 |
| rejectedFrustum / rejectedCone / rejectedHzb | culling | 各原因互斥或明确可重叠语义 |
| swClusters / hwClusters / alphaClusters | classifier | SW producer 不存在时必须声明 unsupported；已有 HW/alpha 必须是真实值 |
| swTriangles / hwTriangles | raster queue | 实际进入两条路径的三角形 |
| shadedPixels / emptyVisibilityPixels | resolve | 单次扫描工作量 |
| activeMaterials / activeLights | GPU world/shading | 场景复杂度 |
| queueOverflowMask | 任一 producer | 每个 bit 对应一个已登记队列 |

Owner 是 `FrameProfiler`。每帧在主 encoder 内清零，由 GPU pass 原子累加。counter 不参与当前帧 CPU 决策。

当前落地 ABI 为 `schemaVersion=1`、总长 256 bytes，字段索引固定在 `OEngine/src/debug/GpuFrameCounters.ts`。producer 通过 `FrameProfiler.copyGpuCounter()` 复制已有 GPU 数量，或在直接原子写入共享 counter buffer 后调用 `registerGpuCounterFields()` 登记字段；结果只导出本帧实际登记过的字段。ABI buffer、清零、采样 copy 和归档已接入主帧。

### R0 能力证据矩阵

Result Schema v3 在顶层增加 `capabilityEvidence`，其冻结实现位于 `OEngine/src/debug/BenchmarkCapabilityEvidence.ts`：

- `featureSets` 必须与 `environment.run.featureSet` 一一对应，并声明每个 feature set 的状态及必需 counter。
- `gpuCounters` 必须完整覆盖固定 ABI 的全部字段；`supported` 保存稳定 GPU producer 名称，`unsupported` 保存稳定实施任务 ID 和非空原因。
- 已完成、未 dropped/pending 的采样帧，必须包含所有“已启用 supported feature 所需且 counter 也 supported”的字段；值允许为 `0`，但必须来自真实清零、GPU producer 和异步 readback。
- `unsupported` 字段必须从 `gpuCounters.values` 和汇总中缺失；即使写成 `0` 也会被 gate 当作伪造证据拒绝。
- 字段缺失只对矩阵明确声明为 `unsupported` 的 counter 合法。对 required/supported counter，字段缺失是证据错误，不等价于零工作量。
- 矩阵是代码内冻结事实，Result 不能自行把 blocker 改成 supported、伪造 producer，或用自由文本代替任务 ID。
- `FrameProfiler` 会在采样帧拒绝注册矩阵中仍为 unsupported 的 counter，避免把清零后的 ABI 槽位导出成“真实 0”；必须先完成 blocker 下的 GPU producer 并更新冻结矩阵。

当前标准 feature set 契约如下：

| Feature set | 当前状态 | 必需 counter / blocker |
|---|---|---|
| `hardware-visibility` | supported | instance、cluster、frustum、HW/alpha triangle、visibility pixel、overflow |
| `hzb-culling` | supported | `rejectedHzb`；由真实 HZB depth-query reject 分支产生 |
| `cone-culling` | unsupported | `WORK-04`；当前主链没有独立 Meshlet normal-cone/backface culling stage |
| `material-expand` | supported | `activeMaterials` |
| `clustered-lighting` | supported | `activeLights`、`queueOverflowMask` |
| `ibl` | supported | 当前无独立工作量 counter |
| `packed-instances` | unsupported | `WORLD-07` |
| `hierarchy-sse-lod` | unsupported | `WORK-04`；未来包含 `visitedBvhNodes` 等层次工作量 |
| `software-visibility` | unsupported | `VIS-05`；未来包含 `swClusters/swTriangles` |

`validateBenchmarkEvidence()` 分开返回两个结论：`gateEligible` 只表示 Result JSON 的结构、采样和声明可信；`capabilityComplete` 表示启用的 feature 及其必需 counter 均已支持，`blockedCapabilities` 给出阻塞项。带明确 blocker 的 G0 artifact 可以 `gateEligible=true` 且 `capabilityComplete=false`；任何 A/B 最终功能通过声明都必须同时检查 `capabilityComplete`、固定场景契约、性能阈值、截图和控制台 artifact。

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
| `hwClusters` | legacy 路径为 opaque/second-chance list；Packed R3/R4 路径为统一 Hardware `drawIndirect` 实际消费的 RasterWork 总数，包含 alpha-tested 子集 |
| `alphaClusters` | legacy 路径为独立 alpha list；Packed R4 路径为 sampled GPU reducer 从统一 RasterWork 中识别出的 alpha-tested 子集 |
| `hwTriangles` | 固定功能路径实际提交的 primitive 数；当前每个 Meshlet 固定 `drawIndirect` 384 vertices，即 128 triangles，不是 Meshlet header 中的逻辑 primitive count |
| `queueOverflowMask` | bit 0=`sceneMeshList`，bit 1=`meshletList`，bit 3=`lightList`；bit 2 为 material list 保留但尚无 producer |

每个无 overflow 的样本应满足：

```text
legacy split-list: selectedClusters == hwClusters + alphaClusters
Packed unified draw: hwClusters >= selectedClusters && alphaClusters <= hwClusters
hwTriangles == hwClusters × 128
candidateInstances == visibleInstances + rejectedFrustum
```

第四个真实 producer 是 `activeMaterials`。Material Expand 对 `SceneInstances.materials` 的去重材质集合过滤透明和未构建 context，并为剩余每项实际编码一个全屏 GBuffer draw；采样帧在 draw loop 结束后用 `GpuCounterAtomicAdder` 把真实 `lastDrawCount` 写入 Counter ABI。该字段衡量当前按材质重复全屏扫描的 GPU 工作，不声称这些材质最终都有可见像素。

第五个真实 producer 是 `rejectedHzb`。现有 initial、dual 与 second-chance Meshlet HZB Compute Shader 只在 `visibility_query_depth_from_screen_space_bb()` 判定为遮挡的真实分支中原子累加；视锥拒绝、投影失败和屏幕 texel-center 裁剪不计入该字段。它统计实际执行的 HZB wave reject event，同一逻辑 Cluster 可能在 initial、dual、second-chance 或 alpha wave 中重复出现，因此不是唯一 Cluster 数。

只有 GPU counter 采样帧使用带额外 storage bind group 与全局 atomic 的 Shader/Pipeline variant；非采样帧继续使用原 Shader，不增加 binding、atomic 或 readback。`hardware-visibility` 与 `hzb-culling` 是独立 feature set，关闭 HZB 时硬件光栅证据不应被迫要求 `rejectedHzb`。

当前主链没有独立 Meshlet normal-cone/backface culling 算法，因此 `cone-culling/rejectedCone` 由 `WORK-04` 阻塞，不属于“已有算法只差 OBS-05 接线”。SW raster 仍由 `VIS-05` 阻塞。material overflow bit 2 只是未启用保留位，当前 feature evidence 没有宣称其存在 producer；这一边界已经显式记录，不再阻止 OBS-05 收口。

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

当前 `GpuReadbackRing` 已实现固定至少三槽、主 encoder 内 copy、submit 后 `mapAsync`、按 frame index 回填、满环丢样本，以及 map 失败后释放槽位。结果 Schema v3 通过 `diagnostics.failedGpuTimestampBatches`、`droppedGpuCounterSamples` 与 `failedGpuCounterSamples` 显式保存异常；timestamp 某个 context readback 失败时会以空 batch 收尾并使 diagnostics gate 失败，不会永久 pending。控制器会同时等待 timestamp 和 counter 的延迟结果。

### Result Schema v3

- `environment.engine` 保存 commit、dirty 和逐项 `dirtyReasons`。
- `environment.adapter.driver` 在浏览器无法提供时必须为 `null`，不能伪造。
- `environment.run` 固定 `baselineRole`、timestamp/counter cadence 与 readback ring slots。
- 每帧分别保存 CPU counters、GPU counters、timestamp、submit/readback/upload 和 graph 证据。
- 顶层 `capabilityEvidence` 保存 feature-to-counter 矩阵、真实 producer 或明确 blocker；旧 Schema 1/2 不具备该语义，只能作为 exploratory artifact。
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

C 不是“比 A/B 多开几个效果”的展示页。它必须验证相同 GPU-driven 主链能推广到异构资产、Packed Instances、少量字段 patch、alpha-tested、CSM、动态灯光、Temporal/Upscaling 和内存扩展曲线，而不退化为 CPU 遍历或样例专用旁路。

## 执行任务

### 当前落地进度（2026-08-26）

- 已有 Result Schema v3、CPU timeline、submit/readback/upload、可选 GPU timestamp、GPU counter ABI、能力证据矩阵与 P50/P95/P99 汇总。
- `BenchmarkRunController` 已统一 warm-up、采样帧调度，并同时等待 timestamp/counter 延迟结果收尾。
- 256-byte counter buffer 与至少三槽的非阻塞异步 readback ring 已进入真实 `Renderer.render()`；profiler 关闭时不分配 counter/ring 资源。
- 最终 Visibility Buffer、LightCluster 与现有 Visibility GPU list 已接入真实 GPU counter producer；采样帧输出像素、本地灯光、instance/cluster/HW 工作量和 scene-mesh/meshlet/light overflow 证据，frame smoke 会校验字段存在性、工作量关系与像素总数不变量。非采样帧不编码 counter clear/copy/readback 或统计 Pass。
- 三种真实 Visibility HZB cull Shader 已接入 sampled-only `rejectedHzb` producer；只统计 depth-query reject event，不混入 frustum/offscreen reject，非采样 variant 没有额外 counter binding 或 atomic。能力证据矩阵 schema 已升级为 v2，并把 `hardware-visibility`、`hzb-culling`、尚未实现的 `cone-culling` 分开表达。
- Shader source-of-truth 静态审计已覆盖 66 个文件，逐项记录 direct/runtime consumer、最近 pipeline owner、generator candidate 与删除候选；当前结论为 55 个 authored-live、5 个 dead candidate、6 个运行中的 oracle/generated ownership blocker。清单见 `OEngine/benchmarks/shader-source-audit.json` 与 `docs/SHADER-SOURCES.md`。
- HZB legacy 统计已改为记录每帧真实 build 次数与累计 mip pass 数，不再把同帧两次 build 报成一次。
- `OBS-06` 已建立单一 `render_debug_view` 控制面：VisibilityKey、reverse-Z depth 与 velocity 在时域/后处理之后覆盖最终 HDR 输入；HZB mip、三类 reject reason、LOD/Cluster level、SW/HW 分类、material ID 与 history validity 均登记为带原因的 `unsupported`，不会添加占位 Pass。旧 `feature_velocity_debug_view` 与独立 `VelocityDebugPass` 已删除；关闭和 unsupported 状态不创建 Debug Pass、瞬态输出或 readback。
- 原始 GPU timestamp label 已增加稳定逻辑阶段归类；Result 同时保留逐 Pass `gpuMs`，并将同一采样帧内的 Pass 先按 phase 求和后输出 `gpuPhaseMs`，避免用 Pass 样本冒充帧样本。采样挂在统一 `ShadeGPUCommandContext.create()` 缝上，登记主图之外的 upload、database update 和 animation context，并覆盖其中实际存在的 compute/render Pass；多个 context 的异步结果按注册顺序稳定合并，不按 readback 完成顺序漂移，也不新增 submit。纯 copy/write 命令没有 Pass timestamp，不能把“context 已登记”写成复制区间已完整计时。未知 label 显式进入 `unclassified`，采样用 counter/debug Pass 单独进入 `observability`，不混入主渲染阶段。
- `validateBenchmarkEvidence()` 已建立 Result artifact 机器门禁：检查 Schema、clean commit/dirtyReasons、A/B/C role、adapter/尺寸/feature set、真实资产与相机 hash、能力证据矩阵、采样帧数、diagnostics、异步 timestamp/counter 完成状态、counter ABI、逻辑 phase，并从逐帧样本反算核对 `gpuMs`、`gpuPhaseMs` 与 `gpuCounters`。它分别输出 artifact 的 `gateEligible` 和产品证据的 `capabilityComplete/blockedCapabilities`。用户 `temp/` 的两份旧 Schema 1 smoke 已登记为 exploratory，不会误入 G0。
- `examples/r0-observability` 与 `examples/r0-frame-smoke` 已通过类型检查和生产构建；后者进入真实 `Renderer.render()`。
- R0 观测基础设施、`OBS-02` Harness/浏览器验收和 G0 均已收口；下一步是 R1 分析与计划。后续算法 counter、逐像素 debug producer和 clean/full 性能刷新不再混入 R0。

### OBS-01 · 冻结运行环境清单

输出 `environment.json` schema：commit、浏览器版本、OS、adapter 名称、driver、WebGPU features/limits、窗口像素尺寸、DPR、power preference、feature set、warm-up 和采样帧数。缺失字段使结果不可用于 gate。

状态：`Completed`。`EnvironmentManifest`、Result Schema v3 与 `validateBenchmarkEvidence()` 已覆盖并校验上述字段；浏览器无法提供 driver 时保存 `null`，不会伪造。后续只允许版本化 schema 迁移，不因新增可选环境字段重新打开 R0。

### OBS-02 · 建立 A/B/C harness

让场景、相机轨迹、seed 和开关由同一个 manifest 驱动。可运行页面放在根目录 `examples/` 并通过相对路径引用 `OEngine`；three.js 结果可由其独立页面导出，但字段必须映射到同一 result schema。首版先证明截图与场景数量对齐，并检查 WebGPU validation error，而不是只运行 TypeScript 测试。

Harness 必须在结果中声明 `baselineRole`（`minimum-a`、`minimum-b` 或 `engine-generality-c`）和真实 feature bits。A/B 页面不得形成样例专用渲染器；C 不得复用 A/B 通过状态冒充通用性通过。

状态：`Completed`。A/B/C 三份冻结 manifest、真实 workspace 资产 SHA-256、seed、240 帧相机路径 hash、共享场景 runner、三个根目录入口和 Schema v3 Result 导出已经存在；自动测试会重新计算所有资产/相机 hash，并验证 role、统一 Renderer 路径与 unsupported asset blocker。A 固定 7 级 Teapot 与 160k 布局，B 固定 Damaged Helmet/PBR 纹理/15,625 布局并将暂不能解码的 UltraHDR 环境标为 `MAT-05`，C 固定多 geometry/material/alpha/light/dynamic-transform 配方。

RTX 2060 SUPER 的手动浏览器验收已覆盖 `r0-observability`、`r0-frame-smoke` 与 A/B/C smoke：五页均显示采集完成，A/B/C 分别为 `12/12`、`2/2/4 blocked`、`counterIssues=0`；JSON diagnostics 全零，GPU timestamp/counter 均完成且没有 dropped/failed sample，渲染截图与对应场景输入一致。smoke 因 dirty/non-gate 标记返回 `gateEligible=false` 是预期行为，不是验收失败。R0 页面继续把 Hierarchy/SW/Packed 等当前缺项输出为 unsupported，不得为补齐后续产品功能而重新打开 `OBS-02`。

### OBS-03 · 接通 CPU frame timeline

记录 world/change set、resource upload、graph build/compile、encode、submit 前总耗时、submit 次数、readback 次数和每帧上传字节。使用 monotonic clock；不得把异步 GPU 完成时间混进 CPU encode。

状态：`Completed`。`FrameProfiler` 已按帧记录 CPU timeline、submit/readback/upload label 与字节、FrameGraph build/compile/execute；异步 GPU 完成时间保存在独立 GPU evidence 中。R1 可以减少这些成本，但不重新定义 R0 归帧契约。

### OBS-04 · 接通 GPU timestamps

每个被采样的 OEngine CommandContext 分配 query 范围，Pass 只请求逻辑 marker，不拥有 query set/readback。处理设备不支持、query 容量不足、异步 map 失败和 feature off 的情况。

状态：`Completed（R0 范围）`。所有 OEngine `ShadeGPUCommandContext` 的真实 compute/render Pass timestamp、异步多批次归档、map 失败收尾与 unavailable 路径已接通；原始 label 以 command context 限定，并映射到稳定的 `upload`、`animation`、`instance-cull`、`hierarchy-and-cluster-cull`、`software-raster`、`hardware-raster`、`hzb`、`material-resolve`、`light-cluster`、`lighting-and-ibl`、`shadow`、`transparency`、`temporal`、`post`、`observability` 和 `unclassified`。Result 按帧汇总 `gpuPhaseMs`，同时保留原始 `gpuMs`。

WebGPU timestamp-query 的可靠范围是 Compute/Render Pass；纯 copy/write 继续由 CPU encode 时间、upload/readback 字节和 submit 归属说明，不能用 CPU 等待或虚构 GPU marker 冒充。跨多个 submit 的 wall-clock latency 属于 R1 提交路径重构与外部 profiler 调查，不是 OBS-04 未完成项。

### OBS-05 · 接通工作量 counters

先覆盖现有 instance、meshlet、draw、material 和 light 路径。所有 counter 定义是“输入”“通过”还是“唯一项”必须写入 schema，避免重复累计后无法比较。

状态：`Completed（当前能力）`。固定 ABI、资源 owner、采样 ring、结果聚合、主帧生命周期和 Schema v3 能力证据矩阵已经完成；最终 Visibility Buffer、LightCluster、现有 Visibility GPU list、Material Expand 与三种 HZB cull Shader 已分别产生像素、灯光、instance/frustum/cluster/HW、active material 与 `rejectedHzb` 的真实证据。

当前不存在的 cone culling、SW raster 与 hierarchy producer 分别以 `unsupported + WORK-04/VIS-05` 表达。`queueOverflowMask` 当前只承诺已登记的 scene-mesh、meshlet 与 light 队列；material bit 2 是未启用的 ABI 保留位，不出现在 feature-set required evidence 中。未来若建立对应 GPU 队列，必须在其所属任务中同时补 capacity、overflow producer、能力矩阵和回归测试，但不因此重新打开 OBS-05。

### OBS-06 · 建立 debug views

至少提供 VisibilityKey、depth、HZB mip、frustum/cone/HZB reject reason、LOD/cluster level、SW/HW 分类、material ID、velocity 和 history validity。尚不存在的数据视图显示 `unsupported`，不伪造。

状态：`Completed（R0 control surface）`。公共 `RenderDebugView` 目录统一登记 12 种状态，Renderer 只接受一个选择。当前三个真实视图共享 `rgba16float` 最终覆盖契约，并按输出/内部尺寸做显式坐标映射：VisibilityKey 对 `meshId + triangleId` 稳定哈希，depth 显示 reverse-Z mip 0，velocity 以色相表示方向、亮度表示屏幕空间幅度。其余视图因缺少可靠逐像素 producer 显示 `unsupported` 及具体原因；后续 producer 接入时扩展同一控制面，不新增独立 feature flag 或旁路管线。

### OBS-07 · 核实 Shader source-of-truth

为实际创建 pipeline 的 WGSL 建立 `shaderName → authored/generated source → generator → runtime pipeline` 清单。未被引用的 oracle/generated Shader 标为删除候选，不在 R0 顺手大规模改写。

状态：`Completed（inventory）`。`npm run audit:shaders` 生成确定性的 schema v2 JSON，覆盖全部 66 个 `src/shaders/*.ts`，并沿 import 图记录最近 runtime pipeline owner。审计发现 5 个没有静态 pipeline owner 的删除候选，以及 6 个仍在运行但没有仓库内 generator/source 的 oracle/generated 文件。后者已经追到具体 pipeline owner，作为对应模块迁移 blocker 记录；R0 不把它们误标为 authored，也不在缺少视觉/数值回归时直接删除。人工摘要与限制见 `docs/SHADER-SOURCES.md`。

### OBS-08 · 采集不可修改基线

在同机完成 A/B/C 的 cold/warm、P50/P95/P99。保存原始 JSON、截图、控制台错误和分析说明。任何后续阶段都以该 artifact 与前一阶段 artifact 双重对照。

状态：`Closed as R0 blocker / moved to phase-entry refresh`。Result JSON 的机器 gate validator、固定 A/B/C 输入、Schema v3 smoke JSON/截图与 artifact 登记已经完成，足以结束“先建立真实证据链”的 R0。旧 RTX 2060 SUPER Schema 1 数据仍只能证明当时 81 Box 主链的 3 submit、持续 readback等探索事实；本轮 Schema v3 smoke 证明当前入口、counter、unsupported 声明与浏览器渲染可运行，但不冒充 clean/full 性能 gate。

以后 R1–R5 中任何实际性能修改，仍必须在修改前按本节步骤采集命中场景的 clean/full cold-warm bundle，并与修改后结果成对保存。它是性能改动的阶段入口条件，不再是继续滞留 R0 的独立工作包。

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

按“R0 收口总账”，`OBS-01～07` 已完成，原 `OBS-08` 已改为后续性能阶段的入口刷新，R0/G0 现在正式退出。后续 A/B/C artifact 仍必须使用冻结输入、Result Schema v3、当前 supported counter 的真实值、后续能力的 `unsupported + blockerTaskId`，并配套截图与控制台记录；但这不阻止现在根据已有证据分析和规划 R1。

G0 退出只表示证据系统能够诚实、可机读地表达“当前真实值”和“后续能力 blocker”，不要求在 R0 提前实现 Packed Instances、Hierarchy/SSE LOD 或 Compute SW Raster。A/B 的 manifest、资产/相机对照契约在 R0 建立，但 A/B 真正的垂直功能与性能追平仍由 G2–G5 的对应实现和最终 run bundle 判定；C/vertical/lifecycle 门禁继续判定通用引擎能力。
