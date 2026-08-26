# 性能契约与 Benchmark

## 原则

性能结论必须基于同机、同浏览器、同 GPU、同分辨率、同 DPR、同画质、相同 warm-up 的数据。FPS 只用于体验总览；定位必须使用 CPU 分段、GPU timestamp、计数器和带宽/资源信息。

## 强制基线

A/B 是最低垂直功能与性能基线，不是 OEngine 的产品范围或完成标准。它们用于保证 GPU LOD、GPU 工作生成、SW/HW Visibility、材质重建和 PBR/IBL 基础闭环至少不落后于对照实现。C 以及通用 vertical/lifecycle cases 用于证明 OEngine 在多资产、动态世界、完整效果和扩展性上的更高目标。

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

### C · OEngine 通用性压力

- 多 geometry、多 material、alpha-tested、shadow、动态 transform、Packed instances。
- 分别增加实例、Cluster、可见比例、活跃材质和灯光数量。
- 补充 Lighting、Transparency、Temporal/Post、asset unload/reload、resize、feature toggle 和 device lost/capability fallback 的 vertical cases；不能只测一个静态峰值场景。

## 每组必须记录

- CPU：World/Change Set、graph/encode、提交前总时间、submit 次数。
- GPU：upload、cull/traversal、SW raster、HW raster、HZB、resolve、lighting、每个效果。
- 数量：候选/可见 instance、BVH node、Cluster、SW/HW triangle、材质、灯光。
- 内存：常驻 Buffer/Texture、transient 峰值、每帧上传与 readback 字节。
- 统计：平均、P50、P95、P99、首次编译和 warm frame。

Result 必须同时保留原始 Pass `gpuMs` 与稳定逻辑阶段 `gpuPhaseMs`。阶段统计先在每个采样帧内求和，再跨帧计算分位数；不得把同一帧的多个 mip/bucket/pass 当作多个独立帧样本。无法可靠归类的 label 写入 `unclassified`，profiler/counter/debug 的采样开销写入 `observability`，两者都不能静默并入主渲染时间。

GPU timestamp 的契约范围是 WebGPU Compute/Render Pass。纯 copy/write 由 CPU encode、上传/回读字节与 submit 归属记录；跨多个 submit 的 wall-clock 不得用 Pass duration 之和冒充。明确保存这一覆盖边界即满足 G0，提交路径合并与更完整的 frame latency 调查属于 R1。

`rejectedHzb` 的当前比较单位是 HZB Shader 实际 depth-query reject event，不是唯一 Cluster。initial、dual、second-chance 与 alpha wave 可能重复处理同一逻辑 Cluster；比较前必须保持 wave 调度和 feature set 一致。frustum/offscreen reject 不得混入该值。

## 当前已确认的性能风险

- R1-A 入口的 `GraphicsContext.update()` 独立 submit、持续 collection readback、scene animation/database self-submit 已删除；真实 WebGPU smoke 已确认 Frame/A/B/C 从 3/13 收口为一次 `Renderer/main-0` submit。
- steady render tick 现在由 `FrameCoordinator` 持有唯一主 command；显式 one-shot/tool/debug-readback/recovery 路径仍可独立提交，但 runtime label 必须在 allowlist。
- R1-B 已把主管线改为 canonical-key compiled cache：key miss 才 build/compile，稳定 key 只 execute；真实浏览器 Frame Smoke/A/B/C after smoke 已确认所有记录帧均为 warm hit，但旧 provenance/dirty smoke 不能用于宣称正式 CPU 性能收益。
- R1-C 已在代码中把 HZB 从逐 mip Render Pass 改为每 build 一个 Compute Pass；普通帧仍 build 两次、alpha-tested 可能三次，是否裁剪重复 build 必须由 after phase 数据决定。
- Visibility 的 bucket/scan/expand/second-chance 中间队列和 clear 成本高。
- 当前 Material Expand 先写 material depth，再对每个材质画全屏三角形。
- Visibility、material depth、四张 GBuffer、HDR 和 history 产生较大全分辨率带宽。
- 主链缺少 hierarchy/SSE LOD 和 Compute micro-raster。
- Shader runtime owner 已有静态审计，但 6 个运行中的 oracle/generated 事实源仍没有 generator/所有权闭环，也尚未建立系统的性能和视觉回归。

这些是待测风险，不得在没有分段数据时把总慢归因于单一 LOD 或单一 Pass。

## R1 入口数据与目标

2026-08-26 Schema v3 acceptance-smoke 已作为 R1 调查输入登记，但因 smoke/dirty 标记不能充当正式 paired gate。第一次修改 R1 代码前按相同入口采集 clean/full cold + warm 基线；这是 R1 前测，不是重新打开 R0。

R1-A 修复 B mipmap 生命周期后的自动门禁为 `npm test` 55/55 与 examples production build 通过。浏览器插件桥在本轮初始化失败，因此浏览器 artifact 由用户采集；下表仍是入口基线，after smoke 只用于验证结构变化，不与 clean/full 性能 gate 混用。

commit `4de81f7a` 的第一轮 after smoke 已证明 Frame Smoke/A/B/C 的 submit P50/max 全为 1/1，非采样 readback P50 为 0，scene preparation P50 为 1；C 的 view preparation P50 为 10，但不增加 scene preparation 或 submit。Frame Smoke/A/C diagnostics 为 0。B 的 3 个 GPU counter 采样帧因 mipmap 临时 Buffer/Texture 提前销毁产生 validation error，第一轮 B 不能进入 after 性能比较，并促成后续资源生命周期修复。

修复后第二轮 B 保持 submit P50/max 1/1、readback P50 0、scene preparation 1，并恢复 `shadedPixels P50=259190`，diagnostics 全为 0，画面人工确认正常；`R1-A` 功能 Gate 关闭。由于 dev server 未重启，第二轮 JSON 仍带旧 build-time commit 字段，只能作为 non-gate smoke；正式性能百分比和 clean/full paired 结论留到 R1-D，届时必须刷新 server、commit 与 dirty reasons。

R1-B after smoke 中，Frame Smoke 的 24 个记录帧和 A/B/C 各 12 个记录帧全部为 `build=0、compile=0、execute=1、cacheHits=1`；submit P50/max 均为 1/1 且 label 只有 `Renderer/main-0`，非采样 readback P50 为 0，diagnostics、counter sample failure 和 `queueOverflowMask` 均为 0。B 继续保持 `shadedPixels P50=259190`，C 保持 `activeMaterials=3`、`activeLights=6`。用户人工确认四页画面正常但未保存截图。JSON 从 warm-up 后开始记录，因此首个 miss 由自动测试证明；文件仍携带旧 `4de81f7a` build-time provenance 和 dirty/smoke 标记，只能作为 R1-B 结构/功能证据，不能与入口表直接计算性能百分比。

R1-C 接受的结构上界已冻结为每次 build `computePasses=1、dispatches=mipCount、renderPasses=0`。计数器已迁移为 `hzb.computeBuilds`、`hzb.computePasses`、`hzb.dispatches`、`hzb.outputPixels`、`hzb.historyValid`、`hzb.historyInvalidations`；不得用旧 `legacy.hzb.mipPasses` 或合成零值证明迁移。独立奇数尺寸 GPU readback 页面已加入，但本轮浏览器控制连接不可用，after JSON、validation 和 P50/P95 尚未登记。

| Case | CPU frame P50 / P95 | Submit | Graph build/compile | HZB build / mip Render Pass | HZB phase P50 / P95 |
|---|---:|---:|---:|---:|---:|
| Frame Smoke | 2.150 / 2.985 ms | 3 | 1 / 1 每帧 | 2 / 20 | 0.114 / 0.116 ms |
| A smoke | 2.800 / 3.800 ms | 3 | 1 / 1 每帧 | 2 / 20 | 0.125 / 0.127 ms |
| B smoke | 3.050 / 3.860 ms | 3 | 1 / 1 每帧 | 2 / 20 | 0.126 / 0.128 ms |
| C smoke | 9.300 / 18.555 ms | 13 | 1 / 1 每帧 | 3 / 30 | 1.040 / 1.051 ms |

G1 的结构性硬门槛是：Frame Smoke/A/B/C warm non-sampled 均为一次 main submit；非采样帧零 collection readback；每 scene/frame 只 prepare 一次；相同 graph key warm frame build/compile 为 0；逐 mip HZB Render Pass 为 0；feature off 无对应 Pass/resource/history/readback/timestamp/submit。详细执行与 paired 性能规则见 [R1 计划](./implementation/02-runtime-submit-and-framegraph.md#量化-gate)。

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
- OEngine 阶段完成：除 A/B 外，还必须通过 C 的扩展曲线、完整效果、动态世界、生命周期、feature-off 与跨设备门禁。
