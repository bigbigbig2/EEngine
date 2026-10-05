---
id: next-design/temporal-radiometry-presentation
state: current
verifies:
  - OEngine/src
---
# Module D 设计：Temporal Facts、Radiometry 与 Presentation

> 实施状态：D0-D6 已完成生产路径接入。模块级静态检查已完成；browser、真实 GPU 画质/性能与正式 evidence 仍按总体验收后置。

> 状态：2026-09-27，D0-D6 已实施并完成模块级集中检查。对应[执行文档](../next-execution/temporal-radiometry-presentation.md)、[整体架构](./eengine-next-overall-architecture-final-2026.md) §6、[来源账本 R12/R24/R25](../porting/next-renderer.md)。下文的“当前事实”来自本轮源码核对；未取得真实 GPU 运行、画质或性能结果前，不视为整个 Next Renderer 最终验收。

## 1. 目标、范围与完成的含义

Module C 已在唯一生产 Graph 中接通 Surface、XeGTAO 和 FSR3，但时序事实、曝光及显示仍没有统一闭环。D 要让 Geometry/Surface/Environment 各自生产的 HDR 与运动事实进入一条可追溯的 GPU 链：`scene radiance → working-space pre-exposed HDR → FSR3 → bloom/metering → tone/grade/display transform → canvas`。这条链必须能在相机切断、局部几何/材质变化、动态分辨率、空场景、替换和 device loss 后保持诚实的历史有效性。

完成 D 指**生产路径和原理**连通：FSR3 继续完整运行已固定版本的 Upscaler 阶段；opaque 的真实 motion/validity/reactivity 可用；共享事务与 FSR3 物理 history 一致；GPU 自动曝光无需读回；SDR 呈现不再直接输出 HDR；HDR 只在能力成立时成为同链 profile。透明/折射/毛发尚未实现时，不宣称其 composition mask 已生产。SSSR、GI、VSM 的 history confidence 由未来各自 owner 定义。本模块不实施 Frame Generation、Bloom 中可选 lens flare/lens dirt、通用后期特效编辑器或最终 browser/画质/性能矩阵。

开发阶段保持一个 Renderer、一个 Frame Program 主链、一次 frame submit；本帧亮度不能 GPU→CPU→GPU 回读决定曝光或可见工作。模块连通后集中 typecheck、build 与必要 targeted tests；正式 evidence、claims、P50/P95 留到 Next Renderer 整体完成。

## 2. 当前源码事实与必须切断的耦合

| 已核对入口 | 当前事实 | D 的动作 |
| --- | --- | --- |
| `pipeline/RendererCore.ts::render` 的 `beginFrame`、`_temporal.begin`、`_fsr3.prepareFrame`、`encodeCompiledGraph` | `RadiometryRuntime` 的 multiplier 仍为 1；`sceneRevision` 使用整个 shading publication revision；Graph 编码后将 color/depth/motion 统一 `markProduced` | Renderer 保留事务编排，不拥有曝光/时序算法；把物理写入成功与逻辑 commit 对齐，局部变化不一概变整屏重置 |
| `TemporalFabric.ts`、`TemporalHistoryRegistry.ts` | 有 begin/commit/abort、逻辑 ping-pong；scene/representation/light/render-scale/preExposureGeneration 变化可全项失效；逻辑 color/depth/motion history 与 FSR3 自持的真实纹理不是同一组资源 | 分清公共生命周期和 backend 物理 history；不要标记从未写入的历史为已生产 |
| `RadiometryContract.ts` | CPU 浮点 multiplier、generation；`setMultiplier` 增 generation；Renderer 未用它做 GPU 自动适应 | 替换为 GPU `P/E` 状态和仅用于不连续事件的 epoch；日常亮度变化不触发整屏清历史 |
| `GpuInstanceAbi.ts`、SurfaceWork V3 GeometryRecord/signal owners | instance 有 geometry generation、dynamic revision、previous-from-current 和 motion-valid 标志；TemporalFacts 计算 current-minus-previous UV；最终 motion target 只存 xy | 保留速度，另发布有效性与局部变化；frame-local primitive/work index 不作跨帧身份 |
| `passes/fsr3/Fsr3UpscalerRuntime.ts` | 已有 pinned FSR3 准备、luma/shading pyramid、reactivity、instability、accumulate、RCAS；motion 负号和 jitter correction 已在 backend；reactive/transparency 都是 zero mask；render size 变更重建全部 history，previous size 常用当前值 | 只在 FSR3 adapter 做约定转换；接真实 mask；保持合法尺寸变化的输出 history，传真实上帧 render size |
| `program/FrameProgramLowering.ts::lowerPresentation`、`surface/SurfacePresentPass.ts` | `Sky → Aerial → FSR3 → Present`；Present 直接取 HDR radiance 写 canvas | 将曝光、Bloom、静态 grade、tone/display 纳入语义产品与实际 Graph 边，旧直出路径切断 |
| `passes/PhysicalSkyPass.ts`、`AerialPerspectivePass.ts` | 天空/大气新加入的辐射未按 Surface 的 multiplier 统一 | 全部 HDR writer 进入相同 pre-exposure 空间，避免 `P≠1` 混域 |
| `passes/AutomaticExposurePass.ts`、`ColorGradingPass.ts`、旧 tonemap shader | 旧实现不是 Next 主链；旧曝光从末级 mip 取样构造 histogram，不可当完整 donor | 仅用于对照或删除，不恢复旧 effect owner |

职责建议：Geometry/Visibility 生产身份、depth 和 motion 原料；shading 生产 material/local-change、opaque reactive、HDR；temporal/presentation owner 管公共事实、FSR3 adapter、曝光和显示；environment 提供 scene-linear sky/aerial；frame-runtime 只组装产品和唯一提交。`vibe context` 当前将 `TemporalFabric.ts` 路由到 platform、FSR3 到 visibility、Present 到 shading；D 中应修正 domain 路由，使导航与实际职责一致，不让 `RendererCore` 长出算法实现。

## 3. 来源选择与移植边界

完整算法先核对固定 GitHub 实现；论文和文章用于理解决策，不代替源代码。固定 SHA、许可证、入口、逐项映射及 adoption 条件记录在[来源账本](../porting/next-renderer.md)。

| 任务 | 固定来源 | 采用范围与不采用范围 |
| --- | --- | --- |
| Temporal reconstruction | FidelityFX SDK v1.1.4 `c6efa6bf7f2027b3ec94f28578bb5965eabb9e55`，所选 SDK 子集 MIT；`ffx_fsr3upscaler.cpp` 与 `sdk/include/FidelityFX/gpu/fsr3upscaler/*`；账本 R12 | 保留 Upscaler 的完整已移植阶段及 host 输入语义；不是 Frame Generation；FSR3 内部 luma 适应服务算法，不能替代摄影曝光 |
| 自动曝光 | Wicked Engine `0c97cfcdc2a146e12e31ef9464a7aece71706264`，MIT；`luminancePass1CS.hlsl`、`luminancePass2CS.hlsl`、`wiRenderer.cpp::CreateLuminanceResources/ComputeLuminance`；账本 R24 | 半分辨率采样→局部/全局 histogram→加权 log luminance→指数适应和 histogram 清零作为完整基线。中心权重、percentile/高亮保护若加入，是具名 EEngine 扩展，不能称原样移植 |
| Bloom、调色、tone | Filament `41f996de8fcc2d6b60b73159aa1bc44a05a40700`，Apache-2.0；`PostProcessManager.cpp::bloom`、`materials/bloom/*`、`details/ColorGrading.cpp`、`ToneMapper.cpp::GT7ToneMapper`、`materials/colorGrading/colorGrading.fs`；账本 R25 | 逐阶段移植选定 High Bloom core（flare/dirt 关闭）、静态 SDR 调色+GT7+输出 LUT 生成/采样；WebGPU 调度与 HDR 输出适配是本地集成。Filament 当前 `hdrColorAt` 在 OETF 前 saturate 0..1，**不能**把该 LUT 原样用于 HDR extended 输出 |

Wicked 的 [Histogram Luminance 文章](https://www.alextardif.com/HistogramLuminance.html)用于对照 histogram 曝光的极端亮点和适应行为；Godot/Falcor 的固定源仅作对照，前者按平均亮度、后者以最高 mip 的 log 平均为主，均不作为本模块 donor。Filament 源指向 SIGGRAPH 2025 GT7 论文；本轮未独立取得论文全文，不把“论文已读”写入来源状态。Rec.2020 工作色域、P/E 事务和多 consumer facts 是 **EEngine Temporal Radiometry v1**，不是上述任一项目的整套 renderer port。

## 4. 共享 Temporal Facts：语义先于物理布局

Frame Program 为实际 consumer 闭包声明字段，不强制每项有一张全屏纹理。初始物理方案保持 Surface `rg16float` motion，并为 validity/local flags 提供紧凑 sidecar 或与现有可复用目标打包；具体格式要先核对 binding/带宽与 FSR3 对输入的要求。未来 SSSR/GI/VSM 可复用语义，但不得借 FSR3 内部贴图反向定义合同。

| Fact | 生产者→消费者 | 空间/范围、无效行为 |
| --- | --- | --- |
| `motion` | Geometry previous mapping + Surface resolve → FSR3/未来时序 | internal pixel 的 current UV minus previous UV，**未减 jitter**；上一帧采样位置为 `currentUV - motion`。带当前/上一帧 view-projection 约定；FSR3 符号和 jitter 消除只在 adapter 做。非法投影、无 previous mapping、背景都伴随 invalid，不能伪装为可信零速度 |
| `motion-valid`、`disocclusion-evidence` | Geometry/Visibility + depth comparison → FSR3；未来各自 consumer | coverage、越界、depth/order 不一致、近裁剪与新露出显式失效；不能以 motion.xy 是否为零判断有效性。reverse-Z 深度单独传递，深度重投影阈值由 consumer 选择 |
| `stable-instance-id`、`surface-signature` | GPU Scene/material publication → 历史消费者 | 稳定 instance ID + generation、geometry/material/texture 与必要局部坐标/normal/roughness 签名；frame-local work index/primitive token 仅用于当帧重建。LOD 无稳定 primitive 对应时，以 instance、重投影 depth/normal/material 一致性降低各 consumer 权重 |
| `local-change` | GPU patch/材质、geometry/residency、Surface 频率/环境事实 → consumer | 位含 `GeometryChanged`、`LODChanged`、`DeformationChanged`、`MaterialChanged`、`TextureResidencyChanged`、`ShadingRateChanged`、`CompositionChanged`；生产者可给 per-instance 或 screen-local 区域。缺失具体记录时标 unknown/change 并局部保守，而非默认整屏有效 |
| `reactive`、`transparency/composition` | opaque shading 与未来透明合成 → FSR3 | `[0,1]`，internal resolution；本 D 接 emissive/材质突变/高频局部变化等可真实计算的 opaque reactive。透明未生产时明确 absent/zero profile；不能声称已覆盖透明或将 mask 伪造为全部有效 |
| `jitter`、`P_t`、extent/epoch | Temporal/Radiometry 控制面 → 全 HDR writer、FSR3/Present | 当前/上一帧 jitter 的像素与投影约定、internal/output 尺寸、曝光 buffer binding、camera-cut/device epoch；仅 CPU 已知的事务状态可影响拓扑，GPU 测光结果留在 GPU |

**共享输入不等于共享 `HistoryConfidence`。** FSR3 对 reactive/shading-change 有自己的权重；SSSR 的 roughness/material 容忍度、GI 的低频 cache 和 VSM 的页内容失效彼此不同。公共层只保证事实可取、有效性清楚、生命周期一致。

刚体使用当前局部位置与 `previous-from-current`；skinned/deformed backend 必须发布 previous position/映射或明确 invalid。天空无表面身份，使用相机旋转/无限远规则，新增天空区域不能套用 opaque 零 motion。masked 边缘、coarse/fine 频率切换、VG 页替换和 material patch 只降低受影响区域；若当前 patch 数据不足以定位变化，先扩展 GPU Scene publication，而非把整条 history 永久绑定到全局 shading revision。

## 5. History 事务与动态分辨率

`TemporalFabric.begin` 给所有 backend 同一个 frame epoch、read/write index 与 reset reason；每个 backend 持有并报告其真实物理 history、格式、resolution domain、被 Graph 写入的事实。`markProduced` 必须来自对应 writer 编码成功的产品，不能仅因 Graph 总体编码过而给三个逻辑槽记账。提交成功后才交换 index；编码失败/未提交则 abort 并保持或明确作废旧 read，不能让 CPU index 超前 GPU。GPU 执行完成前资源延迟退休；device loss 清所有 GPU history 并重建 pipeline/binding。

输出尺寸/格式、view switch、camera cut、设备替换是强重置。**仅 internal render size 在预先分配的合法包络内变化**时，保留 output-domain color history，更新上帧 render size/jitter 和本帧 motion 映射；internal-domain luma/depth/accumulation 若物理尺寸或内容语义不兼容，可以分别重建/降权。不能简单把所有 slot 共享一个 valid bit。FSR3 当前按任意尺寸变化全量 allocate，D 应把 output/internal 域分离，并核对 pinned host 常量 `previousFrameRenderSize`、`maxRenderSize` 及每阶段采样范围。超出包络或未知历史尺寸时明确 reset。

局部变化 mask 不引起逻辑全屏 generation 变化。camera cut 的检测不能仅依赖任意矩阵差阈值；应区分连续相机运动与明确切断/投影突变，保留保守 fallback。空场景仍必须产生定义良好的 background motion/测光输入、可提交的 display 输出。

## 6. Radiometry：GPU 曝光与工作色域

选定工作空间为**线性 Rec.2020 RGB**，HDR 仍是 scene-referred（绝对 nits 只在显示映射层出现）。这是目标迁移，不是现状。glTF sRGB 贴图先线性化再转换；物理天空 LUT、IBL、直接灯、emissive、bloom 与历史采样必须在同一工作基底。法线、depth、motion、AO、mask 不作颜色转换。Rec.2020 的宽色域能减少高饱和光源和 HDR 级联剪裁，但需要逐入口核对已有 sRGB/线性假设和 LUT 生成成本；中间 `rgba16float` 是否足够以及高亮范围用最终设备量测。

定义 `L_t` 为 scene-linear radiance，`P_t>0` 为 GPU 上一**已提交**帧的适应曝光，所有 HDR producer 写 `C_t=L_t·P_t`。本帧从 `C_t/P_t` 求 scene luminance，Wicked histogram 得目标并以 delta-time 指数适应出 `E_t`；显示的曝光后输入为 `C_t·E_t/P_t`。成功提交后 `P_(t+1)=E_t`；abort 不推进。FSR3 对上帧 pre-exposed color 的重标定为 `P_t/P_(t-1)`；普通曝光数值变化只更新比值，不能每帧增 generation 清全屏历史。P/E 是 GPU ping-pong buffer，同帧 meter→display 明确 Graph 读写边；CPU 只绑定、提交，不读数值。

Wicked 基线的第一 pass 从场景采样并累积 histogram，第二 pass 归约 weighted log luminance、时间适应、清 histogram。源 pass1 使用 Rec.709 亮度系数；本目标输入是 linear Rec.2020，必须改用对应亮度系数或先转换回源基底，并在 oracle 里明示这一适配。WebGPU 的 workgroup/storage 限额决定物理分批及 buffer 格式，但不得删掉全局归约或清理，不能把 FSR3 luma exposure 当显示曝光。GPU 零/NaN/极端亮度、空场景使用有界正值与明确 bootstrap；无 GPU 历史时 `P_0=1`、`E_0` 合法。可在后续质量调优加入中心权重或 percentile，但须另列公式、参数与来源状态。

`PhysicalSkyPass`、`AerialPerspectivePass` 必须对新增辐射乘同一 `P_t`，在已经 pre-exposed 的输入上不重复乘。反射/GI/透明后续也遵守同一 HDR producer 合同；与 SDR/HDR output profile 无关。

## 7. Presentation：Bloom、调色、SDR/HDR

生产 Graph 顺序建议：`pre-exposed scene + sky/aerial → FSR3 → exposure-aware bloom extraction/downsample/upsample/composite → GPU E_t/P_t → SDR 静态 grade+GT7+display LUT（HDR 为宽范围数学路径）→ display-referred UI/composition → canvas`。Histogram 可从 FSR3 前的 internal HDR 采样以省带宽，Bloom 和显示仍用 output resolution；测光与 Bloom 均须说明除/乘 `P_t` 的阈值单位，避免曝光飘动改变场景阈值。UI 默认 display-referred，不能被 scene tone map 再压一次；未来透明/媒体若为 scene-referred 必须在 FSR3/后期的明确位置合成并提供 reactive/composition facts。

Filament Bloom 选择 High core、threshold on、flare/dirt off；阈值、低频链及奇偶尺寸的 9/13 tap 分支、上采样组合逐函数迁移。可按 WebGPU texture usage 和存储限制改 physical pass，但保留所选分支的核权重、边界和合成能量；关闭的可选效果不宣称已移植。ColorGrading 的白平衡、CDL、contrast、vibrance、saturation、GT7 tone、gamut/OETF 在源 `hdrColorAt` 中按顺序**一起生成静态 SDR LUT**，不是任意可交换的独立后期 pass。LUT 是静态参数变化时重建，不能每帧为曝光重生；动态 `E_t/P_t` 在采样 LUT 前应用。GT7 保留源的 Rec.2020→ICtCp、toe/shoulder、chroma 及亮度目标分支；该组合与 HDR 分离路径须通过数值 oracle 核对。

SDR baseline：GT7/grade 后映射到目标 SDR gamut 和 OETF，单一 Present pass 写 preferred 8-bit canvas format。HDR specialization：仅在实际 `GPUCanvasContext.configure` 支持的 `rgba16float`、`toneMapping: {mode:"extended"}` 和可核对 colorSpace/profile 下启用；用 `getConfiguration()` 检查实际配置，格式存在不等于浏览器/显示器的 HDR 输出已成立。HDR profile 保留超过 1 的亮度与独立目标峰值/白点，不能经过 Filament 当前 saturate 的 SDR LUT；需要具名的宽动态范围 grade/tone 输出适配。若 HDR 能力不足，返回 SDR profile，仍使用同一 Frame Program 产品合同与 Renderer。Canvas 与 display gamut/OETF 的职责必须避免双重编码。

## 8. WebGPU 成本、选择与风险

| 选择 | 性能收益与代价 | 画质/正确性边界 |
| --- | --- | --- |
| motion/flags 紧凑 sidecar，而非全套 GBuffer | 增少量全屏写读与绑定，避免每个 temporal consumer 重做身份判断；先核查 Surface 最宽 binding 限额 | flags 必须逐像素覆盖 Dense/Binned/overflow；不能只写代表样本 |
| half-res histogram + 小型全局归约 | 避免全分辨率亮度图和 CPU readback；每帧固定少量 compute work | 亮点、黑场和薄面积强光的偏差留具名质量扩展调整 |
| 曝光标量 GPU buffer ping-pong | 不等下一帧 CPU 数值；Graph 内读写有序 | `P_t` 和 `E_t` 不能别名；abort/device loss 不能推进或采未写值 |
| FSR3 history 输出域与内部域分离 | 动态 render-scale 时少丢 output history、少重建大纹理 | pinned FSR3 各 history 尺寸/常量仍须逐项匹配，不能假设全部可保留 |
| output Bloom + 静态 grade LUT | Bloom 吃带宽；mip 链和 LUT 仅按真实 consumer 裁剪 | threshold 的 scene/exposure 单位、Rec.2020 与 HDR 饱和必须对照源 |

`rgba16float` 中间纹理、canvas `toneMapping`、可选 `shader-f16`/subgroups 均须按 adapter/device、WGSL language feature 和实际 canvas 配置分别协商；不把草案能力写成必有能力。HDR profile 的色彩管理、显示峰值以及跨浏览器一致性是最终系统验收风险，不能由 typecheck 推断。

## 9. D 的交付与延期验证

D0 固定来源/事实 ABI，D1 发布 temporal facts，D2 统一真实 history 事务，D3 使 FSR3 消费事实，D4 建 GPU radiometry，D5 接 Bloom/grade/tone/SDR-HDR，D6 对照本设计一次集中检查、修明显问题并更新 currentSlice。各阶段可按调试需要跑单项检查；不构成逐批门禁。D6 后直接进入 VSM 的详细设计与实施。

最终 Next Renderer 完成时再集中做浏览器/显示矩阵、camera cut/resize/device loss、透明与材质交互、不同场景、画质对照、GPU 带宽和 pass 时间、P50/P95、formal evidence 与 claims。未取得真实 GPU 数值及最终画质证据前，来源账本仍按实际覆盖标记，不以文档或编译成功提升 adoption。
