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
- 补充大量动态灯光、Transparency/Decal、Temporal/Upscaling、resize、feature toggle 和 capability fallback 的 vertical cases；不能只测一个静态峰值场景。完整 asset lifecycle/device recovery 不属于当前产品性能 Gate。

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
- 当前 Material Expand 先写 material depth，再对每个材质画全屏三角形。
- Packed Material 已删除每 vertex 重复 descriptor 扫描、错误 fullscreen derivative 和重复 viewport mapping；但每材质 fullscreen 循环仍存在，R4-B 前不得把局部降本当作 single resolve 完成。
- Packed Velocity 已将 `previous * inverse(current)` 从每可见像素移到 Instance bulk/patch，并对奇异 motion 输出零；尚缺同条件浏览器 timestamp，当前只登记结构工作量消除，不声明 GPU 百分比。
- Visibility、material depth、四张 GBuffer、HDR 和 history 产生较大全分辨率带宽。
- 主链缺少 hierarchy/SSE LOD；Compute micro-raster 是待 profile 的可选优化，不是唯一根因。
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
