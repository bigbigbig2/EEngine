# 性能契约与 Benchmark

## 原则

性能结论必须基于同机、同浏览器、同 GPU、同分辨率、同 DPR、同画质、相同 warm-up 的数据。FPS 只用于体验总览；定位必须使用 CPU 分段、GPU timestamp、计数器和带宽/资源信息。

## 强制基线

A/B 是最低垂直功能与性能基线，不是 OEngine 的产品范围或完成标准。它们用于保证 GPU LOD、GPU 工作生成、SW/HW Visibility、材质重建和 PBR/IBL 基础闭环至少不落后于对照实现。C 用于证明 OEngine 在中大型高密度、多资产/Packed Instance、hierarchy、single resolve、动态灯光、CSM、Temporal/Upscaling、内存和扩展曲线上的更高目标。

A/B/C 必须驱动同一套 OEngine 主管线；只允许通过 manifest、场景数据和 feature set 改变依赖图，不允许为通过 benchmark 维护样例专用 Renderer 或独立真实管线。

### A · three.js Compute Rasterizer 对齐

- 相同 Teapot LOD 数据和 160k instances。
- 相同实例布局、相机、分辨率和 DPR。
- 分别比较 Hardware、Software、Hybrid。
- 输出简单 Visibility Resolve。

### B · three.js Compute Rasterizer IBL 对齐

- 相同 glTF、Meshopt LOD/Meshlet、实例布局和环境贴图。
- 相同 HZB、PBR/IBL、分辨率和输出格式。
- 额外效果必须关闭或单独列出。

### C · OEngine 中大型场景压力

- 多 geometry、多 material、alpha-tested、CSM、少量动态 transform、Packed instances。
- 分别增加实例、Cluster、可见比例、活跃材质和灯光数量。
- 补充大量动态灯光、Transparency、Temporal/Upscaling、resize、feature toggle 和 capability fallback 的 vertical cases；不能只测一个静态峰值场景。Decal 当前延期，不计入 R5 Gate；完整 asset lifecycle/device recovery 不属于当前产品性能 Gate。

## 每组必须记录

- CPU：World/Change Set、graph/encode、提交前总时间、submit 次数。
- GPU：upload、cull/traversal、SW raster、HW raster、HZB、resolve、lighting、每个效果。
- 数量：候选/可见 instance、BVH node、Cluster、SW/HW triangle、材质、灯光。
- 内存：Geometry/Texture/Table/history resident bytes、transient 峰值、每帧上传与 readback 字节。
- 消费效率：indirect instance count、submitted/useful vertex/triangle、固定 384-vertex Meshlet waste、bucket/pass 数。
- 统计：平均、P50、P95、P99、首次编译和 warm frame。

Result 必须同时保留原始 Pass `gpuMs` 与稳定逻辑阶段 `gpuPhaseMs`。阶段统计先在每个采样帧内求和，再跨帧计算分位数；不得把同一帧的多个 mip/bucket/pass 当作多个独立帧样本。无法可靠归类的 label 写入 `unclassified`，profiler/counter/debug 的采样开销写入 `observability`，两者都不能静默并入主渲染时间。

GPU timestamp 的契约范围是 WebGPU Compute/Render Pass。纯 copy/write 由 CPU encode、上传/回读字节与 submit 归属记录；跨多个 submit 的 wall-clock 不得用 Pass duration 之和冒充。明确保存这一覆盖边界即满足 G0，提交路径合并与更完整的 frame latency 调查属于 R1。

`rejectedHzb` 的当前比较单位是 HZB Shader 实际 depth-query reject event，不是唯一 Cluster。initial、dual、second-chance 与 alpha wave 可能重复处理同一逻辑 Cluster；比较前必须保持 wave 调度和 feature set 一致。frustum/offscreen reject 不得混入该值。

## 当前已确认的性能风险

- R1-A 入口的 `GraphicsContext.update()` 独立 submit、持续 collection readback、scene animation/database self-submit 已删除；真实 WebGPU smoke 已确认 Frame/A/B/C 从 3/13 收口为一次 `Renderer/main-0` submit。
- steady render tick 现在由 `FrameCoordinator` 持有唯一主 command；显式 one-shot/tool/debug-readback/recovery 路径仍可独立提交，但 runtime label 必须在 allowlist。
- R1-B 已把主管线改为 canonical-key compiled cache：key miss 才 build/compile，稳定 key 只 execute；最终 clean Frame Smoke/A/B/C 的所有记录帧均为 `0/0/1/1` warm hit。
- R1-C 已把 HZB 从逐 mip Render Pass 改为每 build 一个 Compute Pass；A/B/Frame 每帧总计 2 builds，C 当前为主视图 3 builds + 实际更新阴影视图 9 builds。重复 main build 和 shadow update 策略仍需后续 profile，但 counter 现在记录所有 view 总量。
- R1-D 冻结了 transient 生命周期：command 内 last-use alias、同 queue ordered reuse、mapping/readback/显式 fence/跨 owner destroy 等待 completion。把所有 transient 一刀切延迟到 completion 会把 Frame Smoke resident 从约 265 MB 放大到约 946 MB，已拒绝。
- Visibility 的 bucket/scan/expand/second-chance 中间队列和 clear 成本高。
- R4-B 前的 Packed Material Expand 先写 auxiliary MRT，再按材质重复全屏；该 Packed 链现已由一次 Resolve 删除。普通 Scene legacy 仍按需保留，不进入 Packed B/C。
- Packed Material 已删除每 vertex 重复 descriptor 扫描、错误 fullscreen derivative、重复 viewport mapping 与每材质 fullscreen；B/C material sweep 已证明 draw 恒为 1，但 B 的完整纹理+velocity Resolve 绝对时间回退，仍需后续 profile。
- Packed Velocity 已将 `previous * inverse(current)` 从每可见像素移到 Instance bulk/patch，并在 R4-B 合并进 Resolve；同条件浏览器 timestamp 已包含在 R4-B 数据中。
- VisibilityKey/depth、26 B/pixel Surface、HDR 和 history 仍产生较大全分辨率带宽；R4-B 仅相对旧 Packed chain 减少 8 B/pixel，不代表总帧带宽目标完成。
- 生产 Packed 主链已接 hierarchy/SSE/Cone/previous-HZB 与 Hardware indirect consumer。R3-C A 数据显示 InstanceCull、round 0 和 VisibleCluster expansion 是主要热点，但此前将三者都写成 `workgroup_size(1)` 属于错误归因：InstanceCull/Traversal 已是每 workgroup 64 lane，旧 expansion 是每 lane 串行展开一个 Cluster。R3-D 已把 expansion 改成每 Cluster 一个 64-lane workgroup；after 证明 expansion 成本显著下降，同时把剩余问题定位为 A InstanceCull/round-0 P95 长尾和 C 低密度固定成本。
- Shader runtime owner 已有静态审计，但 6 个运行中的 oracle/generated 事实源仍没有 generator/所有权闭环，也尚未建立系统的性能和视觉回归。

这些是待测风险，不得在没有分段数据时把总慢归因于单一 LOD 或单一 Pass。

## R1 证据与结论

2026-08-26 Schema v3 acceptance-smoke 是 R1 的调查输入。它证明旧路径 Frame Smoke/A/B 为 3 submits、C 为 13 submits，且每帧重建 graph、持续 collection readback、逐 mip HZB Render Pass；但 artifact 是 dirty/smoke，不能充当 clean/full paired before。

R1-A/B/C 的中间 smoke 用于定位并修复 mipmap 临时资源提前销毁、graph cache、Compute HZB 和 Debug WGSL 问题。最终 Gate 只认 commit `7934db1` 的 clean/full after bundle：

| Case | 分辨率 | CPU frame P50 / P95 / P99 | Submit | Warm graph | HZB 总 builds / passes / dispatches | Resident P50 |
|---|---:|---:|---:|---:|---:|---:|
| Frame Smoke | 1038×583 | 5.000 / 7.295 / 7.785 ms | 1 | 0 / 0 / 1 / 1 | 2 / 2 / 20 | 266,063,384 B |
| A full | 1280×720 | 260.500 / 287.015 / 311.496 ms | 1 | 0 / 0 / 1 / 1 | 2 / 2 / 20 | 685,619,504 B |
| B full | 1280×720 | 24.400 / 32.005 / 53.219 ms | 1 | 0 / 0 / 1 / 1 | 2 / 2 / 20 | 457,393,268 B |
| C full | 1280×720 | 21.000 / 25.710 / 27.063 ms | 1 | 0 / 0 / 1 / 1 | 12 / 12 / 120 | 384,516,100 B |

四组均满足：commit/dirty provenance 准确、`scenePrepareCount=1`、非采样 readback 帧为 0、`queueOverflowMask=0`、WebGPU validation/uncaptured/device-lost/counter/timestamp diagnostics 为 0。A/B/C 页面为 `gateEligible=true`、`counterIssues=0`；`capabilityComplete=false` 仍由 R2/R3/R4 的 WORLD-07、WORK-04、VIS-05 等任务阻塞，不反向阻塞 G1。

C 的 HZB counter 在最终提交前发现只统计 primary view 3 builds，但 GPU timestamp 每个采样帧有 12 个 `HZB/compute-pyramid` 标签。commit `7934db1` 将语义修正为本帧所有实际更新 view 的总量：主视图 3 + 阴影视图 9 = 12 builds/Compute Passes、120 dispatches，并逐帧与 12 个 timestamp 标签一致。每个单独 build 仍满足一个 Compute Pass、`mipCount` dispatch、零 Render Pass 的结构上界。

G1 的结构硬门槛已全部关闭：一次 main submit、非采样零 readback、scene prepare 一次、warm graph 不 rebuild/compile、逐 mip HZB Render Pass 为零、feature off 无对应 owner/Pass/history/readback/timestamp/submit、持久资源安全退休。

R1 修改前没有同条件 clean/full bundle，因此无法诚实计算 CPU/GPU paired 百分比。R1 只声明减少了 submit、graph rebuild、持续 readback 和逐 mip Render Pass 这些结构工作，不声明总帧性能提升。尤其 A full 的 CPU P50 仍为 260.5 ms，说明 flat 160k instance/meshlet 路径远未达到最低性能线；下一步必须通过 R2 compact data/Packed Instances 和 R3 hierarchy/SSE 在展开前真正减量，而不是继续把 R1 当性能完成证明。详细实现证据见 [R1 文档](./implementation/02-runtime-submit-and-framegraph.md)。

## R3-C paired 证据与结论

2026-08-28 在 clean commit `0b77ce8cf67e110aef5d6cf82ee9e0e2f9c837d0` 上完成 A/B/C flat-vs-hierarchy full 对照。环境为 NVIDIA Turing、Chrome 150、1280×720、DPR 1，每组 60 warm-up + 180 sample frames，GPU timestamp/counter 每 6 帧采样。六组均为 `dirty=false`、`gateEligible=true`、`counterIssues=0`、`queueOverflowMask=0`，validation/uncaptured/device-lost/failed timestamp/failed counter diagnostics 均为 0。A/B 各有 1 个 SW Visibility blocker，C 有 Cone + SW Visibility 两个 blocker；这些诚实 unsupported 不使 artifact 失效，也不反向宣称 A/B 已完成最终能力对齐。

时间为 P50/P95/P99，单位 ms。`Producer` 包含 InstanceCull、hierarchy rounds、RasterWork preparation/expansion 及对应 evidence；`Visibility total` 是 Producer + Hardware Raster。

| Case | 模式 | Producer | Hardware Raster | Visibility total | RasterWork |
|---|---|---:|---:|---:|---:|
| A | hierarchy | 112.427 / 116.651 / 117.288 | 10.289 / 10.355 / 10.355 | 122.749 / 126.940 / 127.624 | 273,750 |
| A | flat | 1.114 / 1.311 / 1.311 | 106.562 / 107.243 / 107.479 | 107.577 / 108.357 / 108.593 | 2,776,888 |
| B | hierarchy | 5.767 / 6.685 / 6.731 | 10.355 / 10.551 / 10.551 | 16.253 / 17.105 / 17.151 | 281,286 |
| B | flat | 0.262 / 0.262 / 0.262 | 53.150 / 53.710 / 53.740 | 53.412 / 53.972 / 54.002 | 1,437,568 |
| C | hierarchy | 0.328 / 0.328 / 0.328 | 0 / 0.066 / 0.066 | 0.328 / 0.393 / 0.393 | 127 |
| C | flat | 0 / 0.066 / 0.066 | 0 / 0.066 / 0.066 | 0.066 / 0.066 / 0.066 | 127 |

分场景结论：

- A：RasterWork 减少约 90.1%，Hardware Raster P50 从 106.562 ms 降至 10.289 ms，但 Producer P50 升至 112.427 ms，Visibility total 仍回退约 14.1%。热点为 InstanceCull 约 35.6 ms、round 0 约 37.8 ms、VisibleCluster expansion 约 38.5 ms；这些数字不证明 workgroup size 根因。
- B：RasterWork 减少约 80.4%，Visibility total P50 从 53.412 ms 降至 16.253 ms，改善约 69.6%；这是当前 hierarchy 能够降低总 GPU Visibility 成本的明确胜例。
- C：两路均生成 127 RasterWork，`shadedPixels=187,368`，但 hierarchy 比 flat 多约 0.262 ms 固定成本；这是 R3-D 必须保留的低密度回退例，不能从报告中删掉。
- 视觉：A hierarchy/flat 的 `shadedPixels` 约差 2.4%，`*-visual.png` 显示为预期 LOD 轮廓差异，无明显破洞；B 基本一致，C 画面与像素计数一致。只登记带 `-visual` 后缀的截图，窄 viewport 的早期截图不作证据。

这些数据关闭 R3-C Hardware vertical 与 paired 退出条件，但不关闭 G3，也不支持“hierarchy 普遍更快”。R3-D 必须先解决 workgroup 粒度、queue bandwidth 和低密度固定成本，再加入 Cone/previous HZB，删除 flat producer/owner 后重跑同条件 A/B/C。本地 JSON 与截图位于 `temp/r3c-0b77ce8-artifacts/`，`temp/` 不纳入 Git。

## R3-D 浏览器 after 证据与性能结论

2026-08-28 的 R3-D 代码完成以下结构变化：RasterWork expansion 改为每 selected Cluster 一个 64-lane workgroup且只预约一次；Cluster cone 和 previous-frame reverse-Z HZB 进入 hierarchy traversal；`rejectedCone/rejectedHzb/visitedBvhNodes` 由真实 GPU producer 写入；Packed flat producer、Shader、runtime switch、queue 和 indirect owner 已删除，`flatWorkBytes=0`。

live `examples/r3-hierarchical-work-generation` 已通过：Perspective/Orthographic/empty/pressure 的 GPU/CPU VisibleCluster、RasterWork 和完整 16 B indirect record 一致，Shader diagnostics、validation、uncaptured error 均为空。随后在 clean commit `1f3a2d7583ec60dfab71ad3dfa111e947833fcfb` 上完成 A/B/C hierarchy full after；环境与 R3-C 相同：NVIDIA Turing、Chrome 150、1280×720、DPR 1、60 warm-up + 180 sample frames，timestamp/counter 每 6 帧采样。三组均 `dirty=false`、`gateEligible=true`、`counterIssues=0`、`queueOverflowMask=0`，validation/uncaptured/device-lost/failed timestamp/failed counter diagnostics 全为 0；`capabilityComplete=false` 只来自合法的 `VIS-05` Software Visibility blocker。

时间为 P50/P95/P99，单位 ms；`Producer` 为 InstanceCull、全部 hierarchy rounds、RasterWork preparation/expansion 和 queue evidence，`Visibility total = Producer + Hardware Raster`：

| Case | Producer | Hardware Raster | Visibility total | RasterWork P50 |
|---|---:|---:|---:|---:|
| A | 86.049 / 111.244 / 113.154 | 10.355 / 13.704 / 13.763 | 96.403 / 124.948 / 126.916 | 273,750 |
| B | 4.981 / 5.381 / 5.998 | 13.500 / 13.536 / 13.566 | 18.481 / 18.917 / 19.564 | ≈281,191 |
| C | 0.262 / 0.429 / 0.505 | 0 / 0.066 / 0.066 | 0.262 / 0.495 / 0.571 | 127 |

分场景结论：

- 64-lane expansion 局部优化成立：A/B/C 的 P50 分别由 38.54/2.49/0.131 ms 降至 6.82/1.31/0.066 ms，约改善 82.3%/47.4%/50.0%。
- A：Visibility P50 相对历史 flat 107.577 ms 改善约 10.4%，但 P95 相对 flat 约 108.357 ms 回退约 15.3%；主要长尾仍在 InstanceCull 与 round 0，因此由 `R3-D-08` 阻塞。
- B：Visibility P50/P95 相对历史 flat 53.412/53.972 ms 分别改善约 65.4%/65.0%；`rejectedCone=16`、`rejectedHzb=40`，证明 Cone/HZB reject 在生产 Renderer 中真实执行，而不是只通过 Shader 编译。
- C：两路仍只有 127 RasterWork，after 多约 0.262 ms 固定成本；flat 两个 Pass 的 P50 都量化为 0，P95 合计约 0.131 ms，而 after P95 为 0.495 ms，回退约 277.5%，由 `R3-D-09` 阻塞。

因此当前状态是“R3-D live correctness complete；G3 functional complete；G3 performance blocked”。artifact 位于 `temp/r3d-1f3a2d7-clean-artifacts/`，其中 A/B/C 各有 clean full JSON 与 PNG；`temp/` 不纳入 Git。下一轮必须针对 A InstanceCull/round-0 P95 和 C 低密度固定成本做单变量优化并重跑同条件 paired，不得恢复 CPU draw list、运行时 flat owner 或 benchmark 专用管线。

## R3-D-08/09 fused-root、compaction 与低密度收口

2026-08-28 在 clean commit `aff3ab8fb33e29a31243bedde55f68fdb9b26964` 上完成最终 A/B/C full。环境继续固定为 NVIDIA Turing、Chrome 150、1280×720、DPR 1、60 warm-up + 180 sample，timestamp/counter 每 6 帧采样。三组均为 `dirty=false`、`gateEligible=true`、`counterIssues=0`、`queueOverflowMask=0`，validation/uncaptured/device-lost/failed timestamp/failed counter diagnostics 全为 0；`capabilityComplete=false` 只来自合法的 `VIS-05` Software Visibility blocker，不影响 G3 Hardware 工作生成 Gate。

本轮把 InstanceCull 与 root Cluster 判定融合；root/traversal children 与 SelectedCluster 先做 workgroup-local compaction，再由 lane 0 做全局有界预约；queue evidence 只在 sampled/opt-in 帧产生。depth-zero 且静态上界不超过 `144 instances / 144 RasterWork capacity` 时，单个 fused-leaf Pass 直接写 VisibleCluster、RasterWork 和完整 16 B indirect。第一轮 clean C 曾因把 127 emitted work 错当静态 capacity、阈值写成 128 而未命中；commit `aff3ab8` 已修正，并由最终 Pass label 证明真实运行 fused-leaf。

时间为 P50/P95/P99，单位 ms；仍按每个采样帧先求 `Producer + Hardware Raster`，再跨帧计算分位数：

| Case | Implementation | Producer | Hardware Raster | Visibility total | RasterWork P50 |
|---|---|---:|---:|---:|---:|
| A | wavefront + fused-root | 6.291 / 7.120 / 7.674 | 10.486 / 10.617 / 10.617 | 16.777 / 17.511 / 18.234 | 273,750 |
| B | wavefront + fused-root | 1.180 / 1.180 / 1.226 | 10.355 / 10.486 / 10.579 | 11.534 / 11.665 / 11.758 | ≈281,191 |
| C | fused-leaf | 0 / 0.066 / 0.066 | 0 / 0.066 / 0.066 | 0 / 0.066 / 0.066 | 127 |

相对 clean commit `1f3a2d7` 的 R3-D after：A Visibility P50/P95 分别下降约 82.6%/86.0%，B 下降约 37.6%/38.3%，C 的 P50 量化为 0、P95 下降约 86.8%。相对 commit `0b77ce8` 保存的历史 flat：A P50/P95 下降约 84.4%/83.8%，B 下降约 78.4%/78.4%，C 的 P95 与 flat 同为一个 timestamp quantum，且输出仍是相同 127 RasterWork 与约 187,368 shaded pixels。没有通过减少输出工作或恢复 flat producer 获得结果。

新增 sampled contention counter 的 P50/P95/P99：

| Case | root reservations | traversal reservations | dispatch updates | CAS retries |
|---|---:|---:|---:|---:|
| A | 489 / 489 / 489 | 0 / 0 / 0 | 0 / 0 / 0 | 18,428 / 20,672 / 21,471 |
| B | 100 / 100 / 100 | 52 / 53.55 / 54 | 33 / 34.55 / 35 | 465 / 608.6 / 651.17 |
| C | 6 / 6 / 6 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 1.42 |

A 的 CAS retry 仍高，说明 compact 后 SelectedCluster 全局有界预约仍存在竞争；但 reservation 数、Producer 总时间与 P95 Gate 已通过，因此它登记为后续更大规模 sweep 的可观测风险，不继续阻塞 G3，也不为追求 counter 为零引入 Prefix Scan/额外 Pass。若新 workload 出现长尾，再以同 ABI 单变量比较 atomic、scan 或分层 queue。

正确性同时由 `examples/r3-hierarchical-work-generation` 六组 GPU/CPU oracle、完整 16 B indirect、capacity parent fallback、最终 C 正常画面与三组稳定 RasterWork/shadedPixels 证明。最终 JSON 位于 `temp/r3d-aff3ab8-clean-artifacts/`，`temp/` 不纳入 Git。由此 `R3-D-08`、`R3-D-09` 与 G3 performance 关闭；下一阶段进入 R4-A Visibility contract，不把 A/B 的 `COOK-11`、`VIS-05` 或 B 画质输入 blocker 伪装成已经完成。

## R4-A-06 Hardware Visibility 浏览器 Gate

2026-08-28 的 clean/full A/B/C Gate 继续使用 NVIDIA Turing、Chrome、`1280×720`、DPR 1、60 warm-up + 180 sample，GPU timestamp/counter 每 6 帧采样。三组都运行 production Packed hierarchy → RasterWork → single Hardware `drawIndirect`，final-color oracle 仍由当前主管线 Material Resolve 产生；Gate 另外保存 VisibilityKey heatmap 与 reverse-Z depth，不建立替代 Renderer。三组均为一个 main submit、一个 Packed drawIndirect、`invalidVisibilityKeys=0`、`queueOverflowMask=0`、`shadedPixels + emptyVisibilityPixels = 921,600`，WebGPU validation/uncaptured/device-lost/timestamp/counter 与浏览器 console/page errors 全为零。

Hardware Raster 时间为两次实现等价 clean full 重跑观测到的 P50/P95/P99 范围，单位 ms；RasterWork/alpha 为稳定 sampled counter P50，单次精确值以当前 `summary.json` 为准：

| Case | Hardware Raster | RasterWork | alpha RasterWork |
|---|---:|---:|---:|
| A | `35.372–39.831 / 37.769–40.481 / 39.247–41.621` | `273,750` | `0` |
| B | `39.307–43.523 / 39.587–60.679 / 39.725–84.260` | `≈281,191` | `0` |
| C | `0.0512–0.0614 / 0.0539–0.0713 / 0.0545–0.0716` | `127` | `40` |

这是正确性 Gate，不是性能优化完成证明。相对 clean R3 `aff3ab8` 的 A/B Hardware Raster P50 `10.486/10.355 ms`，R4-A 在 RasterWork 数量基本不变时回退到约 `35–44 ms`，且 B 的一次 clean run 出现 `P95=60.679 ms / P99=84.260 ms` 长尾。R4-A-03 新增的 per-fragment Material Visibility lookup/alpha 分支是待验证嫌疑，不是已证明根因；运行间波动也必须纳入调查。下一轮应分别 profile record lookup、alpha branch/atlas、额外 `r32uint` attachment 带宽与 adapter/浏览器稳定性，保持场景、分辨率、DPR、画质、warm-up 与采样 cadence 不变。R4-B 报告必须继续独立列出 `hardware-raster`，不得用总 Resolve 改善掩盖该回退。

submitted fragments 没有可协商的 WebGPU pipeline-statistics producer，继续登记 `unsupported / WEBGPU-01-PIPELINE-STATISTICS`；useful fragments 使用 final `shadedPixels`，不伪造 submitted/useful 比率。截图中的 final-color、Key 与 depth silhouette 一致，只证明没有明显 blank、孔洞或 key/depth 分离；该 artifact 不证明后续 Single Resolve 或 SW/Hybrid。artifact 位于 `temp/r4-a-06/full/`，`temp/` 不纳入 Git。

## R4-B Single Material Resolve 浏览器 Gate

2026-08-28 在 clean commit `4e1206bd8d32670fddf3c5659710b92e46888210` 完成 B/C full。环境为 NVIDIA Turing、Chrome 151、`1280×720`、DPR 1、60 warm-up + 180 sample，GPU timestamp/counter 每 6 帧采样。两组均 `passed=true`、`gateEligible=true`，issues/counter issues、validation、uncaptured error、device loss、failed timestamp/counter 和 queue overflow 为 0；`capabilityComplete=false` 只来自尚未开始的 `software-visibility / VIS-05`，不反向阻塞 G4-B Hardware vertical。

| Case | Active materials | Fullscreen Resolve draws | Resolve P50 / P95 / P99 | Resident textures | Texture/sampler fallback |
|---|---:|---:|---:|---:|---:|
| B | 1 | 1 | `1.559088 / 1.7152 / 2.05827136 ms` | 4 | `0 / 0` |
| C | 3 | 1 | `0.66336 / 0.6934896 / 0.69565568 ms` | 0 | `0 / 0` |

材质 `1 → 3` sweep 证明 fullscreen draw 恒为 1。Surface 物理布局为 26 B/pixel：PBR `rg8unorm` 2、normal `rgba16uint` 8、albedo/AO `rgba8unorm` 4、emissive `r32uint` 4、velocity `rg16float` 4、flags `r32uint` 4；旧 Packed Material Expand + Velocity 链为 34 B/pixel，因此少 8 B/pixel，在 1280×720 少 `7,372,800` transient bytes。Material/texture owner 分配 `22,893,824` B，其中 array texture resident bytes 为 `22,369,536`；固定 64 layers、`256×256`、9 mips 的方案换取 WebGPU baseline 下的确定容量、单 binding 与一致 mip 行为，代价是 C 即使没有 resident texture 也保留该固定 owner 内存，后续 texture streaming/size-class 需要另做同条件 benchmark。

与 R4-A clean artifact `1c160d7` 的旧 Packed Material Expand 对照：

| Case | Old draws | Old P50 / P95 / P99 | New draws | New P50 / P95 / P99 | 结论 |
|---|---:|---:|---:|---:|---|
| B | 1 | `1.02664 / 1.2854272 / 1.37027936 ms` | 1 | `1.559088 / 1.7152 / 2.05827136 ms` | 新 Resolve 同时承担完整纹理采样与 velocity，绝对时间回退；不得宣称普遍提速 |
| C | 3 | `0.75264 / 0.7877024 / 0.79532608 ms` | 1 | `0.66336 / 0.6934896 / 0.69565568 ms` | 移除 materials×fullscreen，P50 改善约 11.9% |

R4-B artifact 继续单独报告 `hardware-raster`：B `39.369904/39.6922608/39.93239712 ms`，C `0.053248/0.0567792/0.0572512 ms`。因此 R4-A 暴露的 B Hardware Raster 高成本仍存在，没有被 Resolve 数据掩盖。B/C 保存 final-color、VisibilityKey、depth 及 10 个 Surface/velocity debug views；B 13/13 hash 唯一，C 的 emissive/reactive 合法零值 view 重合。artifact 位于 `temp/r4-b/full/`，`temp/` 不纳入 Git。

2026-08-30 lifecycle/material-contract follow-up 在 clean commit `74e61c02f3fd66d30bafbf02d8b2472305c9347e` 重跑 B/C full。环境改为 Chrome 151 / Intel Gen9，其它条件保持 `1280×720`、DPR 1、60 warm-up + 180 sample、timestamp/counter 每 6 帧。两组均 `passed=true`、`gateEligible=true`，issues/counter issues、console/page、validation/uncaptured/device-lost/failed timestamp/counter 均为 0；active materials `1 → 3` 时 fullscreen draw 仍恒为 1。B/C Single Resolve P50/P95/P99 为 `9.9478445/10.14003285/10.1460405 ms` 与 `4.875299/5.04401315/5.08029693 ms`。由于 adapter 不同，本组禁止与 2026-08-28 NVIDIA Turing 数据计算涨跌；它用于关闭 texture lifecycle、separate occlusion reject、normal scale/unlit WGSL 接线后的 clean correctness Gate。

新 material evidence schema v4 在 B 报告 material slots `1 resident / 0 retiring / 4095 free`、texture layers `4 / 0 / 59`；C 为 `3 / 0 / 4093` 与 `0 / 0 / 63`。两边 texture/sampler fallback、private submit 均为 0，证明 layer 0 fallback 保留、63 个可用层的会计恒等式与采集结束零 retiring。13 个 canvas view 加 page screenshot 已刷新到 `temp/r4-b/full/`；B 的 14 个 PNG hash 全部不同，C 只有合法零值 view 重合，final-color、normal、occlusion、emissive 已人工检查为非空且轮廓一致。

## R5 FX-02 Clustered Direct dirty smoke

2026-08-31 的 exploratory smoke 使用 production `Renderer.render()`、Chrome WebGPU、
`C-light` 的 local light `0/1/16/64/256/1024 x spread/overlap`，并补充 1 spot、
0/1 directional 与 GPU bounded-list micro。15/15 case 通过，console、validation、
uncaptured error 与 device loss 为 0；artifact 位于
`temp/r5/fx-02/7b036316b818eef63f1f3a8a03de65f7498ef986-dirty-4ebbcf6ba142/smoke/`。

该 profile 每档只有 3 个 timestamp sample，只用于实现探索，不能作为 P50/P95/P99
性能结论。256/1024 overlap 分别产生 `4,600` 个 overflow cluster，并通过 active-list
fallback 评估 `1,177,600 / 4,710,400` 个 light references；center-luma 自动判定没有
出现静默少灯。1024 overlap 的 Direct Lighting P50 为 `49.708544 ms`，明确说明保守
fallback 的最坏成本很高；它是 correctness 降级，不是目标 steady-state fast path。
clean/full 仍需 60 warm-up + 180 sample 并保存完整分位数，结果写回前不关闭 FX-02。

## 性能变更完成标准

1. 提供基线和变更后的同条件数据。
2. 说明优化减少了哪一种工作，而非只移动到另一个 Pass。
3. 不引入漏绘、遮挡错误、LOD 闪烁、深度不一致或时域历史错误。
4. 给出其他场景是否退化以及 fallback。
5. 更新相关 lesson 或 ADR（若结论改变调查顺序或长期架构）。

## Gate 解释

- G0 证据 artifact：`gateEligible=true` 只表示 Schema、环境、采样、真实 counter/unsupported 声明和汇总可比较；它不等于功能或性能达标。
- G0 已完成：A/B/C Harness、Schema v3、真实 counter/unsupported 契约和 RTX 2060 SUPER 浏览器 smoke 已验证。clean/full cold-warm bundle 在每个实际性能修改阶段开始前按命中场景刷新，不再反向阻塞 R1 分析和计划。
- 能力证据：`capabilityComplete=false` 时，`blockedCapabilities` 必须列出未实现 feature 或尚未接线 counter 的稳定任务 ID。真实 GPU 采样值 `0` 与 `unsupported` 是不同状态；required/supported 字段缺失或 unsupported 字段伪填 `0` 都使 artifact 无效。
- A/B 未通过：基础 GPU-driven/渲染闭环尚未达到最低线。
- A/B 通过：除证据 artifact 合格外，必须 `capabilityComplete=true`、固定功能/画质契约完整且性能阈值达标；这仍只说明对照功能与性能下界达标，不代表通用引擎完成。
- OEngine 当前阶段完成：除 A/B 外，还必须通过 C 的多资产/Packed Instance/hierarchy、single resolve、动态灯光、CSM、Temporal/Upscaling、内存、feature-off 与目标 capability 门禁；不要求超大世界或完整 Gameplay 生命周期。
