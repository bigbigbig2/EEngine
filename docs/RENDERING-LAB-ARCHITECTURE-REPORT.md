# Rendering Lab 渲染链路架构分析

日期：2026-09-06  
证据：本地 Chrome WebGPU，1920×1080、DPR 1，`full` 正式套件（120 warm-up + 480 measured）

## 1. 结论

当前 Rendering Lab 已经跑通一条单主管线：GPU Scene/Packed Instances → Hardware Visibility → Surface/Material Resolve → HZB 与层次工作生成 → clustered lighting/IBL → GTAO/SSR → Packed MBOIT → Temporal/TAA → Motion Blur → Exposure/Bloom → Color Grade/Sharpen/Tonemap。

本次 FrameGraph 证据为 48 个 executable passes、67 个 logical resources（24 个 imported、43 个 transient），所有 48 个 pass 均未被错误保留为 culled。正式 full 每帧 1 个 main submit；GPU queue 没有 overflow、timestamp failure 或 validation error。

## 2. Producer → consumer 闭环

| 阶段 | GPU producer | GPU consumer | 运行证据 |
| --- | --- | --- | --- |
| Packed visibility | exact OPAQUE+MASK producer、hierarchy rounds | VisibilityKey / depth、Material Resolve | `packed.visibility.*`、`visitedBvhNodes`、`selectedClusters`、`hwTriangles` |
| Raster work | visible cluster → RasterWork | exact raster / indirect draw | `rasterCandidateTriangles`、`opaqueRasterWork`、`maskRasterWork` |
| Material | visible pixel classification | single material resolve | `packed.material.kernelDraws`、Surface counters |
| Lighting | cluster assign / HZB filter | direct lighting、IBL | `lighting.clusterCount`、IBL pass labels |
| Transparency | bounded TransparentRasterWork | MBOIT moment/forward/composite | `transparentRasterWork`、`transparentTriangles`、FX-05 labels |
| Temporal | validity/classification | TAA/TAAU、motion blur history | `temporal.*`、FX-06/FX-06B labels |

这些计数器来自 Renderer/GPU owner，而不是 DOM 文本或 CPU 重建的可见列表；因此可以用来验证 producer 与 consumer 是否真的接通。

## 3. FrameGraph 顺序与资源生命周期

```text
Visibility producer
  → Material Resolve / Surface
  → HZB + hierarchy + clustered light
  → Direct + IBL + GTAO
  → SSR prefilter/trace/resolve
  → Packed MBOIT transparency
  → Temporal classification + TAA
  → Motion blur
  → Exposure + Bloom
  → Color Grade + Sharpen + Tonemap
  → Present
```

资源 evidence 保留每个 logical slot 的 `firstUsePass`、`lastUsePass`、imported/transient 标志。这样可以定位三类问题：

1. pass 被执行但没有消费者；
2. transient attachment 生命周期过长导致池容量膨胀；
3. history 或 imported resource 被错误地当作 transient 重建。

本次 full 的资源分解：

- imported：24 个，包含 swapchain、depth、previous depth、环境和持久化目标；
- transient：43 个，包含 35 个纹理和 8 个 buffer；
- graph executable order：0–47，拓扑顺序稳定；
- culled executable pass：0。

## 4. 内存与预算诊断

| owner | 实测 | 预算/解释 | 结论 |
| --- | ---: | --- | --- |
| materials resident logical | 533.1 MiB | resident 总预算 512 MiB | 主要超预算来源 |
| resident logical 总计 | 542.4 MiB | 512 MiB | 超出约 30.4 MiB |
| transient pool | 251.3 MiB | 256 MiB | 只剩约 4.7 MiB |
| history | 43.5 MiB | 128 MiB | 通过 |
| shadow atlas | 64 MiB | 128 MiB | 通过 |

resident 不是物理 VRAM 查询；它是 OEngine resource accounting 的 logical resident bytes。当前最值得做的优化是纹理 mip/residency、材质纹理分层和 transient 峰值复用，不是先删掉 visibility pass。报告中的 `allocatedBytes` 还包含 capacity slack 和 allocator fragmentation，不能直接等价于显卡占用。

## 5. Feature-off 结构验证

`full-minus-*` 对照覆盖 shadow、GTAO、SSR、transparency、temporal、Bloom、automatic exposure、motion blur、sharpening。9 个 gate 均通过：full 出现对应 owner label，minus case 没有对应 active pass。该 gate 同时保留 counter/history/readback/submit 对照；工作区 dirty 时，提交门禁仍会拒绝把结果当成发布基线。

## 6. 性能瓶颈定位建议

在当前本地 adapter 上，`full` 的 CPU P50 为 17.0 ms、timestamped GPU phase P50 为 1.445 ms。相机运动路径中，`occlusion-run` 和 `transparent-close` 的稳定 CPU P50 分别约 22.9 ms 和 21.0 ms，但 GPU frame phase 分别约 1.281 ms 和 1.235 ms；运动段的额外成本主要出现在 CPU/提交与阶段组合，而不是简单的 GPU frame span 单调增长。这说明需要把运动段的 visibility、透明和后处理拆开看，而不能只看静止平均值。

下一轮优化顺序建议：

1. 先将 resident logical 压回 512 MiB 内，并观察 material texture fallback 是否改变；
2. 对 transient pool 做峰值生命周期分析，保留至少 5% 余量；
3. 在目标桌面 adapter 上重复 1080p full 与运动路径；
4. 只有在上述证据稳定后，再比较 hierarchy/LOD、SSR trace 和 MBOIT 的算法成本。

## 7. 证据边界

当前证据不能推出 SM occupancy、驱动排队、物理 VRAM 或 Presented FPS。目标产品的 1920×1080、DPR 1、60 FPS 仍未被目标硬件证明；本报告用于建立可复跑的架构和优化基线。
