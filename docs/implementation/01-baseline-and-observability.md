# 01 · R0 基线与可观测性

## 阶段目标

先建立能解释一帧的证据链，再决定优先重写 LOD、软件光栅、HZB、材质还是提交路径。R0 不以提高 FPS 为主要目标；它的退出条件是所有后续性能结论都可以被复现和反驳。

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

## Benchmark 场景

### A · three.js Compute Rasterizer 对齐

- 160k instances、相同 Teapot 与 LOD 数据。
- 相同相机轨迹、实例变换 seed、分辨率、DPR 和颜色输出。
- three.js Hardware/Software/Hybrid 与 OEngine 当前 Hardware 分开记录。
- 关闭 PBR、shadow、post，只做简单 Visibility resolve。

### B · three.js Compute Rasterizer IBL 对齐

- 相同 glTF、Meshopt LOD/Meshlet、环境贴图、实例布局和相机轨迹。
- 相同 HZB 开关、PBR/IBL 属性和输出格式。
- OEngine 额外效果全部关闭并证明没有 Pass/资源残留。

### C · OEngine 通用压力

至少包含三个可独立缩放轴：

1. 多 geometry、多 material 的静态异构场景；
2. Packed instances 与独立动态 transform 混合；
3. alpha-tested、shadow、lights 和 temporal feature 的逐项压力。

每个轴使用固定 seed；不要把所有变量同时放大后再猜瓶颈。

## 执行任务

### 当前落地进度（2026-08-26）

- 已有 environment/result schema、CPU timeline、submit/readback/upload 入口、可选 GPU timestamp 与 P50/P95/P99 汇总。
- `BenchmarkRunController` 已统一 warm-up、采样帧调度和延迟 GPU 结果收尾。
- `examples/r0-observability` 与 `examples/r0-frame-smoke` 已通过类型检查和生产构建；后者进入真实 `Renderer.render()`。
- 尚未完成 A/B/C 对齐场景、正式 GPU counter buffer/三槽 ring、debug views、浏览器控制台/截图验收和真实性能 artifact，因此 G0 仍未通过。

### OBS-01 · 冻结运行环境清单

输出 `environment.json` schema：commit、浏览器版本、OS、adapter 名称、driver、WebGPU features/limits、窗口像素尺寸、DPR、power preference、feature set、warm-up 和采样帧数。缺失字段使结果不可用于 gate。

### OBS-02 · 建立 A/B/C harness

让场景、相机轨迹、seed 和开关由同一个 manifest 驱动。可运行页面放在根目录 `examples/` 并通过相对路径引用 `OEngine`；three.js 结果可由其独立页面导出，但字段必须映射到同一 result schema。首版先证明截图与场景数量对齐，并检查 WebGPU validation error，而不是只运行 TypeScript 测试。

### OBS-03 · 接通 CPU frame timeline

记录 world/change set、resource upload、graph build/compile、encode、submit 前总耗时、submit 次数、readback 次数和每帧上传字节。使用 monotonic clock；不得把异步 GPU 完成时间混进 CPU encode。

### OBS-04 · 接通 GPU timestamps

在主 encoder 内分配 query 范围，Pass 只请求逻辑 marker，不拥有 query set/readback。处理设备不支持、query 容量不足和 feature off 的情况。

### OBS-05 · 接通工作量 counters

先覆盖现有 instance、meshlet、draw、material 和 light 路径。所有 counter 定义是“输入”“通过”还是“唯一项”必须写入 schema，避免重复累计后无法比较。

### OBS-06 · 建立 debug views

至少提供 VisibilityKey、depth、HZB mip、frustum/cone/HZB reject reason、LOD/cluster level、SW/HW 分类、material ID、velocity 和 history validity。尚不存在的数据视图显示 `unsupported`，不伪造。

### OBS-07 · 核实 Shader source-of-truth

为实际创建 pipeline 的 WGSL 建立 `shaderName → authored/generated source → generator → runtime pipeline` 清单。未被引用的 oracle/generated Shader 标为删除候选，不在 R0 顺手大规模改写。

### OBS-08 · 采集不可修改基线

在同机完成 A/B/C 的 cold/warm、P50/P95/P99。保存原始 JSON、截图、控制台错误和分析说明。任何后续阶段都以该 artifact 与前一阶段 artifact 双重对照。

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
