---
id: next-execution/eengine-next-dungeon-performance-2026-09
state: current
verifies:
  - OEngine/src
---
# EEngine Next Dungeon 性能基线（2026-09-29）

## 测量条件

- 设备：NVIDIA RTX 2060 SUPER（Turing，8 GB）
- 浏览器：隔离 Chrome Headless 154，WebGPU enabled
- 宿主：`next-renderer-validation?perf`
- 场景：`dungeon_warkarma.glb`
- 分辨率：1280×720，DPR 1，render scale 1
- 相机：固定 overview 视角，动画保持生产状态
- VSM：关闭（`enableVsm: false`，`shadowVisibilityEnabled: false`）
- 采样：warmup 120 帧，记录 300 帧；GPU counter 每 8 帧采样

Perf Mode 已移除原来的 8/20 FPS 人工门控，持续执行 `requestAnimationFrame` 和 `renderer.render`。报告使用现有 `FrameProfiler`、GPU timestamp、GPU counter、FrameGraph 和 memory evidence。

## Full baseline

| 指标 | P50 | P95 |
| --- | ---: | ---: |
| GPU frame | 4.889 ms | 4.987 ms |
| CPU frame | 1.675 ms | 2.145 ms |
| graph-execute | 约 1.20 ms | 约 1.60 ms |

GPU timestamp 模块聚合（每帧先按模块求和，再计算百分位）：

| 模块 | P50 | P95 |
| --- | ---: | ---: |
| Geometry / Visibility | 2.427 ms | 2.520 ms |
| FSR3 | 1.021 ms | 1.039 ms |
| Surface | 0.671 ms | 0.687 ms |
| XeGTAO | 0.237 ms | 0.246 ms |
| Bloom | 0.180 ms | 0.192 ms |
| Physical Sky + Aerial | 0.115 ms | 0.118 ms |
| Temporal Facts | 0.100 ms | 0.107 ms |
| HZB | 0.074 ms | 0.076 ms |
| Present | 0.060 ms | 0.061 ms |
| Radiometry | 0.056 ms | 0.059 ms |

现有 `FrameGpuPhase` 的宽阶段仍把部分 Surface、FSR3 和 Visibility label 归入 `unclassified`；本报告的模块聚合直接按现有 timer label 汇总，避免用错误的宽阶段归属替代原始数据。

资源与图稳定性：

- 每帧 25 次 upload write，3544 bytes；1 次 submit。
- FrameGraph 每帧 1 次 execute，cache hit 1，compile/cache miss 为 0。
- GPU diagnostics：validation、uncaptured error、device loss、failed timestamp/counter 均为 0。
- allocated bytes 约 601 MB，resident logical bytes 约 140 MB；transient pool 约 164 MB。

## 最小 A/B

所有变体保持同一场景、相机、分辨率和采样长度。

| 变体 | GPU P50 | GPU P95 | CPU P50 | 相对 Full GPU P50 |
| --- | ---: | ---: | ---: | ---: |
| Full | 4.889 ms | 4.987 ms | 1.675 ms | 基线 |
| GTAO OFF | 4.650 ms | 4.726 ms | 1.730 ms | -0.239 ms |
| FSR3 bypass | 3.868 ms | 4.290 ms | 1.695 ms | -1.021 ms |
| Bloom OFF | 4.692 ms | 4.905 ms | 1.760 ms | -0.197 ms |
| Physical Environment OFF | 4.695 ms | 4.792 ms | 1.780 ms | -0.194 ms |
| bounded geometry | 4.898 ms | 5.305 ms | 2.070 ms | +0.009 ms |

FSR3 bypass 时 FSR3 compute pass 和对应 graph 资源声明不进入 FrameGraph（runtime history 仍按生命周期准备）；Bloom OFF 时 Bloom pass、transient texture 和 bind group 不创建。两项都只作为 Perf Host 诊断 profile，默认生产配置仍保持开启。
Full 的 transient pool 约 164.3 MB；FSR3 bypass 约 121.3 MB，Bloom OFF 约 81.8 MB，说明 pruning 同时减少了对应的 transient allocation。

## Geometry counter 结论

37 个 GPU counter 样本中：

- `geometryNodesTested`：P50 2735
- `geometryClustersAccepted`：P50 766
- `geometryMeshletsSelected`、`geometryMeshletWorksProduced`、`geometryRasterTriangles`、`meshletQueue*`：均为 0
- `queueOverflowMask`：0

没有观察到 overflow。当前 S1 Product MeshletWork pass 确实出现在 timestamp 中，但 meshlet 计数字段仍为 0；源码中的 Product counter 写入已经绑定到 Perf counter buffer，`geometryMeshletWorksProduced` 的 ABI 也明确允许 legacy triangle-work baseline 为 0。因此这组 0 不能直接解释为“没有几何工作”，仍需在下一轮用 Product publication/meshlet queue header 做一次针对性核对。bounded geometry 对 nodes/clusters 和 GPU frame 没有实质影响，暂不改 Geometry 架构。

## 结论与下一步

当前是 **GPU bound**：GPU frame 约 4.9 ms，CPU frame 约 1.7 ms；FrameGraph cache、submit 和上传不是主要瓶颈。

当前最值得继续处理的三个真实成本：

1. FSR3（约 1.02 ms）：在 native 1:1 分辨率下仍执行完整 FSR3 stage，需要单独决定 Native Temporal AA 与 Upscale profile 的产品策略。
2. Geometry / Visibility（约 2.43 ms）：bounded budget 没有降低工作量，先核对 Product meshlet publication 和 queue header，再判断是否存在 work amplification。
3. Surface（约 0.67 ms）与 XeGTAO（约 0.24 ms）：先保留质量配置，后续根据材质和 AO profile 做有证据的优化。

本轮已完成 Perf Host、GPU timestamp/counter 输出、`gpuDone` completion promise 复用，以及 FSR3/Bloom 的最小诊断 pruning；没有通过降低 render scale、减少场景几何或关闭生产效果来宣称优化收益。SSSR、GI、VT、VSM 性能和正式跨浏览器/性能矩阵继续按仓库规则延期。
