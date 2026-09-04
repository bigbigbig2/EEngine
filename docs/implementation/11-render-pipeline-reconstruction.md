# R5-Q Quality / Pipeline Architecture Closure

> 状态：**执行设计与收口基线**
> 冻结日期：2026-09-01
> 源码基线：当前 `master` production source 复核
> 当前状态：`R5-Q01..Q06` 已迁移到同一生产路径；正式 clean/full Gate、旧路径删除和 G5-P 产品闭环仍未完成。下一入口是 Product Closure/G5-P，而不是继续叠加 focused 效果参数。
> 适用范围：`G5-T`、`FX-09..12`、`G5-P` 关闭前的 R5 Shading / Screen-space / Temporal / Post Composition 重构

相关权威与下一跳：

- 产品与平台：[DIRECTION](../DIRECTION.md)、[TARGETS](../TARGETS.md)；
- 目标架构与帧序：[ARCHITECTURE](../ARCHITECTURE.md)、[RENDER-PIPELINE](../RENDER-PIPELINE.md)；
- 当前事实与性能：[CURRENT-STATE](../CURRENT-STATE.md)、[PERFORMANCE](../PERFORMANCE.md)、根 `performance-targets.json`；
- 长期决策：[ADR 索引](../wiki/adr/README.md)；
- 算法与许可证：[R5 算法路由](../references/R5-ALGORITHM-GUIDE.md)、[开源复用规则](../references/OPEN-SOURCE-REUSE.md)、[porting ledgers](../references/porting/README.md)。

## 1. 决策

采用 **Contract-first 分阶段重构**，不做 Renderer V2 大爆炸重写，也不继续用局部参数补丁掩盖 composition debt。

继续保留 R2–R4：

- Geometry Cooker；
- GPU Scene、Packed Instances 与显式 patch；
- Cluster hierarchy、SSE、Cone、HZB；
- RasterWork 和 GPU producer → GPU consumer；
- Hardware Visibility、reverse-Z、VisibilityKey；
- Single Material Resolve 和 Surface ABI v1；
- 一条统一主管线、一个 steady main submit、feature-off 零成本。

本包重点重构：

```text
Surface products
→ Lighting composition
→ AO
→ SSR
→ Transparency
→ Temporal
→ Post
→ Frame orchestration
```

在 R5-Q 关闭前暂停新增 SSGI、DOF、Volumetric 和更多 Post。R5-Q 不建立 Core/Quality/Experimental 多套 pipeline；Medium/High/Ultra 只是同一 pipeline 内的可校准 profile。

## 2. 证据纪律

本文区分：

| 类型 | 含义 | 使用规则 |
|---|---|---|
| production 事实 | 当前源码或冻结 artifact 直接证明 | 可以生成修复任务 |
| 集成观察 | Showcase 截图、交互和帧率暴露的问题 | 可以定义 Gate，不能单独证明根因 |
| 待验证假设 | 有明确代码嫌疑但缺 paired A/B | 只能生成单变量测量 |
| 目标合同 | 后续 interface、顺序和不变量 | 实施通过后才写入 `CURRENT-STATE` |
| 初始 profile | 建议的分辨率、step、roughness 等 | 必须由 GPU ms + 质量 Gate 校准，不能提前冻结 |

历史 `FX-07` AO、`FX-08` SSR focused Gate 继续保留，含义仅限当时的数值、history、feature-off、diagnostics 和局部性能合同。它们不证明 Cyberpunk City 综合画质、完整 composition 顺序、1080p/60 或 `G5-T/G5-P` 已关闭。

## 3. 当前 production source 事实

### 3.1 SSR 读取的是不完整 Scene Radiance

当前 IBL 路径顺序为：

```text
Direct Lighting + Emissive
→ Environment Background
→ SSR(sceneColor = 当前 HDR)
→ IBL Diffuse 或 IBL Specular
→ Indirect Composite
```

`Renderer.ts` 在 IBL diffuse 和 Indirect Composite 之前把 `hdrRes` 传给 SSR。因此 SSR 看到的是 `Direct + Emissive + Background`，不是完整的 `Direct + Emissive + Diffuse IBL + Specular IBL + Background`。

直接影响：阴影/间接光区域反射能量不足；反射亮度与正常可见物体不一致；SSR/IBL transition 更明显。这是 composition ordering 错误，不是 trace 参数可以单独修复的问题。

### 3.2 SSR 参数消费仍未形成算法闭环

2026-09-01 初始审计时，`maxDistance` 和 `edgeFade` 已从 Renderer/job 进入
`SsrTraceSettings`，但 production WGSL 仍然：

- traversal 固定 `128u`；
- `settings.max_distance` 未参与 termination；
- edge fade 固定 `0.05`；
- fade 使用 origin UV，而不是 hit UV；
- thickness 为 `0.1 + roughness * 10.0 + rayLength * 0.01`。

Rendering Lab 调试面板落地时已经把最大步数、厚度三项、粗糙度截止、时域强度和
edge fade 接入 production shader；`maxDistance` 也会把超距结果拒绝为零 confidence。
这只是消除 dead control，并不等于 SSR 2.0 已完成：

- `maxDistance` 仍是 raymarch 完成后的拒绝，不会提前终止 traversal；
- edge fade 虽消费运行时参数，仍作用于 origin UV 而不是 hit UV；
- thickness 仍是经验线性组合，尚未进入 physical-scale/ray-cone 合同；
- 当前仍为全分辨率、高默认步数，且读取不完整 Scene Radiance。

以后任何调试参数都必须有 shader/resource consumer，并以 counter 或 image oracle 证明影响。

### 3.3 GTAO Temporal 存在确定性权重错误

GTAO temporal 先计算 `velocityConfidence * confidence * historyValid`，但最终 blend 使用固定 `0.95 * confidence`，没有消费 velocity confidence。快速运动时 history 仍可能保持高权重。

### 3.4 Physical Scale 没有统一合同

Showcase 明确使用 `MODEL_WORLD_SCALE = 10`。当前 GTAO radius、SSR distance/thickness、shadow bias、light radius、camera near/far 等使用绝对 world/view-space 常数，但引擎没有统一定义一 world unit 对应多少米。

### 3.5 GTAO 不应修改 Material AO

Surface Resolve 输出：

```text
albedoAo.rgb = BaseColor
albedoAo.a   = Material AO
```

当前 GTAO composite 以 alpha `min` blend 写回同一 `albedoAo` resource。Material AO 与 screen-space Ambient Visibility 被不可逆合并，后续无法独立调试、调强度或更换 lighting policy。

### 3.6 Lighting composition 过碎

当前 baseline 分成 Direct Lighting、Environment Background、IBL Diffuse、IBL Specular 和 Indirect Composite。多个全屏阶段重复读取 Surface/环境并写 `rgba16float`，属于 bandwidth-heavy deferred composition。

### 3.7 当前综合配置是 pixel/bandwidth/post-process-bound

按 production source 静态展开，Lighting 之后在 AO、SSR、TAA、Sharpen、Bloom、Exposure 全开时约有 37 个 render/compute Pass；确切数量受 topology 和 mip 数影响，必须由 Q00 graph/timestamp evidence 记录，不能只用该静态估计作性能结论。

当前已保存性能还包括：

- 1280×720 Hardware Raster `35–44 ms` P50 回退与 `84.260 ms` P99 长尾；
- FX-08 SSR 720p focused P50 合计约 `2.70 ms`；
- 根目标 1920×1080、60 FPS、整帧 `16.667 ms`，且 `productPerformanceAchieved=false`。

68 个 Instance 只有 20–30 FPS 不能解释为 geometry 数量问题；当前场景很可能主要受 pixel work、full-screen bandwidth 和 post chain 支配，Q00 必须用真实 phase timing 证明。

### 3.8 Temporal 只有 history owner 统一，rejection policy 仍分裂

`TemporalHistoryRegistry` 已集中管理 color/AO/SSR history 和 invalidation，但 AO、SSR、TAA 各自维护 motion/confidence/rejection policy。当前 `OcclusionConfidence` 主要做 current depth 经 velocity reproject 到 previous depth 的 reveal/disocclusion 判断，还不是完整的 Temporal Surface Validation。

### 3.9 Resolution Domain 没有成为强 ABI

TAAU 输出是 output resolution，但 Motion Blur 以 output width/height 创建输出，同时直接读取 internal-resolution velocity/depth。DRS scale 小于 1 时，Pass 没有显式的重采样或 domain conversion 合同。

### 3.10 Post composition 顺序和输入语义错误

当前顺序为：

```text
TAA/TAAU → Motion Blur → Sharpen → Bloom → Exposure → Tonemap
```

Sharpen 在 Bloom 前会放大 TAA/SSR noise、subpixel highlight 和 ringing，再由 Bloom 扩散。

当前 Exposure 输入还取决于 Bloom：Bloom 关闭时测 HDR scene，开启时测 `bloom.downsampled`。Bloom 开关因此改变 exposure meter 的输入语义，而 Auto Exposure 已经拥有独立 histogram/reduce/adapt，不应依赖 Bloom owner。

### 3.11 FrameGraph 是资源 lifetime/culling 图，还不是完整 scheduler

现有 FrameGraph 已有 resource version、read/write、dead-pass culling、transient lifetime/reuse、late binding 和 compiled cache，应继续保留。但当前 `validate()` 恒为 `true`，compiled execution 按 insertion order 遍历 Pass，没有 resource DAG 的 stable topological scheduling。

升级 FrameGraph 的价值是 correctness、scheduling、lifetime、fusion opportunity、prune 和 debug；WebGPU 单队列不会因此自动产生“异步 compute 并行”。

### 3.12 其它已确认债务

- `Renderer` free-floating settings 已发生跨模块泄漏，LightCluster job 甚至收到不属于它的 AO intensity/falloff 字段；
- TAA uniform 中仍有未消费的 jitter 字段；当前 velocity 已包含 current/previous jittered projection 的差值，Temporal resolve 不应再次补偿；
- `bloom.ts` 仍从 `temporal_post_legacy.generated.ts` re-export production WGSL；
- Shadow 在 Main FrameGraph 前独立 encode，LPV 使用另一张 graph；它们需要统一 FramePlan，但不应粗暴塞进一张超级 FrameGraph；
- Profiler 已支持 timestamp、segment、async readback、counter 和 frame history，不应重造，只需给 Showcase 暴露真实数据。

## 4. 目标 frame composition

```text
FRAME PREP
Scene / Camera / Jitter / DRS / Physical Scale
  ↓
SHADOW UPDATE（conditional）
  ↓
GPU-DRIVEN VISIBILITY CORE
Hierarchy → Cull → RasterWork → VisibilityKey
  ↓
IMMUTABLE SURFACE RESOLVE
SurfaceFrame + Velocity + Metadata + Depth
  ↓
OPAQUE TEMPORAL VALIDATION
  ├─→ GTAO 2.0 → AmbientOcclusionFrame
  └─→ Light Cluster
           ↓
OPAQUE LIGHTING
Direct + Shadow + Diffuse IBL + Specular IBL + Emissive + Background
           ↓
CompleteOpaqueHDR + IblSpecular contribution
           ↓
SSR 2.0 specular correction
           ↓
CompleteOpaqueHDR
           ↓
Transparency → HDR + TransparentReactive
           ↓
FINAL TEMPORAL VALIDITY
           ↓
TAA/TAAU → OUTPUT RESOLUTION
           ↓
Motion Blur
  ├─────────────→ Exposure Meter（固定 ExposureSourceHDR）
  └─────────────→ Bloom Pyramid
           ↓
Bloom Composite → HDR-aware Sharpen → Tonemap → Present
```

## 5. 深模块、interface 与 immutable products

目标目录：

```text
OEngine/src/render/pipeline/
  FramePipeline.ts
  FramePlan.ts
  FrameProducts.ts
  ResolutionDomain.ts
  PhysicalScaleContract.ts
  RenderSettings.ts
  RenderQualityProfile.ts
  OpaquePipeline.ts
  ScreenSpaceEffectsPipeline.ts
  TemporalPipeline.ts
  PostProcessPipeline.ts
```

`passes/*` 继续拥有具体 GPU implementation。`Renderer` 只做 composition root：

```text
prepareFrame
→ resolveTopology
→ prepareHistories
→ buildFramePlan
→ executeFrame
→ commitHistory
→ present
```

模块 interface 是调用方和测试的共同 seam；Pass、shader、pipeline 和 bind group 是模块内部实现，不向 Renderer 暴露。

### 5.1 PhysicalScaleContract

```ts
interface PhysicalScaleContract {
  readonly metersPerWorldUnit: number;
}
```

默认 `1 world unit = 1 meter`。所有 GTAO radius、SSR max distance/thickness、shadow bias、light/fog/contact distance 先以 meters 表达，再由一个 owner 转成 world units。Showcase 放大模型 10 倍时必须明确：模型真的物理放大十倍，或同步调整 `metersPerWorldUnit`；不允许效果各自猜尺度。

### 5.2 ResolutionDomain

```ts
type ResolutionDomain =
  | "internal-full"
  | "internal-half"
  | "output-full"
  | "tile"
  | "fixed"
  | "swapchain";

interface TextureDomain {
  readonly domain: ResolutionDomain;
  readonly width: number;
  readonly height: number;
  readonly scale: number;
}
```

FrameGraph texture resource 和 RenderProduct 都携带 domain。每个 Pass 明确 input/output domain；不匹配必须声明 domain conversion，否则 graph build 失败。

### 5.3 SurfaceFrame

```ts
interface SurfaceFrame {
  readonly depth: ResourceId;
  readonly pbr: ResourceId;
  readonly normal: ResourceId;
  readonly albedoAo: ResourceId;
  readonly emissive: ResourceId;
  readonly velocity: ResourceId;
  readonly metadata: ResourceId;
  readonly domain: TextureDomain & { readonly domain: "internal-full" };
}
```

SurfaceFrame 是 immutable frame product。后续效果只能读取，不能偷偷写回。Surface ABI v1 初期不改格式；`albedoAo.a` 继续表示 Material AO，但 GTAO 不得写回。

### 5.4 AmbientOcclusionFrame

```ts
interface AmbientOcclusionFrame {
  readonly visibility: ResourceId;
  readonly bentNormal: ResourceId;
  readonly domain: TextureDomain;
}
```

Material AO、Ambient Visibility、Bent Normal 保持独立；如何组合属于 Opaque Lighting policy，例如经过验证后使用 `indirectDiffuse *= materialAo * ambientVisibility`。

### 5.5 OpaqueTemporalValidity 与 FinalTemporalValidity

```ts
interface TemporalSurfaceFrame {
  readonly velocity: ResourceId;
  readonly historyConfidence: ResourceId;
  readonly reactive: ResourceId;
  readonly domain: TextureDomain & { readonly domain: "internal-full" };
}
```

两层语义：

- `OpaqueTemporalValidity`：motion-valid、bounds、linear-depth consistency、可选 normal/surface identity、opaque reactive；供 GTAO、SSR 和 Final TAA base validity 使用；
- `FinalTemporalValidity`：在 opaque validity 上合入 transparent reactive，仅供最终 TAA/TAAU。

MotionInvalid、Disocclusion、Reactive、Outside、SurfaceMismatch 等 rejection reason 优先作为 counter/debug evidence，不要求全部占用独立 texture。

### 5.6 RenderSettings 与 QualityProfile

```ts
interface RenderSettings {
  readonly lighting: LightingSettings;
  readonly ao: GtaoSettings;
  readonly ssr: SsrSettings;
  readonly temporal: TemporalSettings;
  readonly post: PostSettings;
  readonly resolution: ResolutionSettings;
}
```

严格区分：

- Topology settings：enabled、resolution scale、需要不同资源的 quality choice；
- Runtime uniforms：intensity、radius、max distance、history strength 等，不重建 graph。

`RenderFeatureContract` 是 declarative contract，不发展成浅 OO framework。它至少记录 inputs、outputs、domain、history、invalidation、feature owner 和预估 Pass；关闭后 producer 是否可 prune 必须可回答。

## 6. Composition contracts

### 6.1 OpaqueLighting

常规 IBL 路径融合为一个深模块内部的 Opaque Lighting 实现，读取 Surface、AO、clusters、shadow、environment、diffuse irradiance、split-sum 和 camera，输出：

```ts
interface OpaqueLightingFrame {
  readonly hdr: ResourceId;
  readonly iblSpecular: ResourceId | null;
  readonly domain: TextureDomain & { readonly domain: "internal-full" };
}
```

实现一次计算 Direct Diffuse/Specular、Diffuse/Specular IBL、Emissive；background 由同一 composition contract 输出 environment。是否物理融合为一次 GPU Pass 由 Q02 profile 决定，但 Renderer 不再手工暴露四段 composition。

### 6.2 SSR 是 Specular Correction

Opaque Lighting 已包含 IBL specular。SSR 只返回对 specular fallback 的 correction：

```text
finalSpecular = mix(iblSpecular, ssrSpecular, confidence)
correction = finalSpecular - iblSpecular
finalOpaqueHDR = opaqueHDR + correction
```

miss 时 correction 为零；low confidence 只做小 correction；SSR 不再拥有“完整 indirect specular”。SSR 必须读取 Complete Opaque HDR。

### 6.3 ExposureSourceHDR

Exposure 固定读取有明确颜色空间和 composition 时点的 `ExposureSourceHDR`。Bloom on/off 不得改变 metering source 语义。Bloom 和 Exposure 可以共享明确契约的 downsample/luminance 工作，但不能由 Bloom owner 决定 Exposure 输入。

### 6.4 Jitter

Velocity 已包含 current/previous jittered projection delta。Temporal resolve 不再补偿 jitter；删除未消费的 TAA jitter uniform，并用 motion/reference sequence 冻结该不变量。

## 7. GTAO 2.0

```ts
interface GtaoSettings {
  readonly enabled: boolean;
  readonly radiusMeters: number;
  readonly falloffMeters: number;
  readonly intensity: number;
  readonly resolutionScale: 0.5 | 1;
  readonly temporalEnabled: boolean;
  readonly quality: "medium" | "high" | "ultra";
}
```

要求：

- radius/falloff 使用 PhysicalScaleContract；
- raw sampling 根据屏幕 sample radius 选择 depth/HZB mip，不再固定 mip 0；
- spatial edge stopping 使用 linear/view depth，不直接比较 reverse-Z device depth；
- 默认 half-resolution；
- Temporal blend 真正消费 velocity、history confidence、validity；
- half-res visibility + bent normal 使用 depth/normal-aware joint bilateral upsample；
- 输出独立 `AmbientOcclusionFrame`，不修改 SurfaceFrame；
- 复用 `OpaqueTemporalValidity`。

具体算法必须先沿 R5 reference route 决定采用当前 authored 改写、XeGTAO 可追溯局部移植或拒绝采用。没有 source/commit/license/adaptation ledger 前不得复制表达性代码。

## 8. SSR 2.0

```ts
interface SsrSettings {
  readonly enabled: boolean;
  readonly resolutionScale: 0.5 | 1;
  readonly maxDistanceMeters: number;
  readonly maxRoughness: number;
  readonly maxSteps: number;
  readonly baseThicknessMeters: number;
  readonly distanceThicknessScale: number;
  readonly edgeFade: number;
  readonly temporalEnabled: boolean;
  readonly quality: "medium" | "high" | "ultra";
}
```

要求：

- 默认 half-resolution trace/resolve/temporal；
- roughness 超过阈值时在 trace 前剔除并直接使用 IBL；
- `maxDistanceMeters` 真正终止 ray；
- thickness = physical base + ray distance slope，不使用 `roughness * 10`；
- roughness 控制 ray cone、sample distribution、prefilter mip、confidence、step budget 和 SSR/IBL blend；
- edge confidence 使用 hit UV，并结合 distance/facing/roughness/thickness；
- Complete Opaque HDR 作为 scene-color source；
- `Trace → Resolve → one spatial prefilter → Temporal → joint bilateral upsample/composite`，先删除固定三轮 spatial；
- 复用 `OpaqueTemporalValidity`，miss 由 IBL 连续兜底；
- 记录 trace pixels、roughness/distance reject、hit ratio、average/max steps。

具体实现先沿 R5 reference route 对当前 authored SSR 与 FidelityFX SSSR 等候选做 provenance/许可证/性能评估。WebGPU baseline 不依赖 subgroup；optional subgroup adapter 必须 paired benchmark。

## 9. Temporal 2.0

当前 TAA 已有 MotionValid、Reactive、Disocclusion、Velocity、YCoCg clip、History Lock、Luminance Confidence 和 runtime history strength，不作为第一重写对象。

Q05 先统一 validity，再升级 TAAU：

- Opaque/Final 两层 Temporal Validity；
- bounds、linear depth、可选 normal/surface identity；
- explicit jitter contract；
- Catmull-Rom/Lanczos-like current reconstruction 候选；
- closest-depth motion/classification；
- 3×3 variance clip 和 subpixel history lock；
- DRS 1.0 ↔ bucket transitions 的 history invalidation/resampling；
- AO/SSR 上游正确后才能校准 TAAU，禁止用 TAA 隐藏 screen-space 噪声。

## 10. Post Pipeline

目标顺序：

```text
Final HDR Internal
→ TAA/TAAU
→ Final HDR Output
→ Motion Blur
├─→ Exposure Meter（ExposureSourceHDR）
└─→ Bloom Pyramid
→ Bloom Composite
→ HDR-aware Sharpen
→ Tonemap
→ Present
```

初期选择 Bloom 后、Tonemap 前的 HDR-aware sharpen，减少额外 LDR intermediate。若未来选择 display-space sharpen，必须显式增加 output product、颜色空间和成本 Gate。

Bloom production shader 最终迁出 `temporal_post_legacy.generated.ts`，形成 authored source-of-truth；迁移前必须保持输出和性能证据，不因重命名宣称优化。

## 11. FramePlan 与 FrameGraph

### 11.1 FramePlan

```text
FramePlan
├─ SceneUpdate
├─ ShadowUpdate
├─ LPVUpdate
└─ MainViewGraph
```

每个阶段声明 dependency、frequency、dirty condition、persistent output 和 GPU timing。Shadow/LPV 不必强塞进一张超级 graph，但必须由同一个 FramePlan 解释顺序和 submit。Shadow caching 只有在 scene/light dirty contract 和 paired evidence成立后启用。

### 11.2 FrameGraph Closure

保留现有 resource version、culling、transient reuse、late binding 和 compiled cache。Q06 顺序增加：

1. producer/consumer validation；
2. read-before-write、version 和 imported-resource validation；
3. cycle detection；
4. stable topological sort，相同优先级保持 insertion order；
5. domain validation 和显式 domain conversion；
6. 一个 graph Pass 对应一个真实 encoder render/compute Pass，或明确报告内部 dispatch 数；
7. 统一 graph dump、timestamp 和 resource lifetime evidence。

FrameGraph correctness 完成后才评估 pass fusion、memory lifetime 和 bandwidth tuning。

### 11.3 DRS buckets

DRS 不再生成任意连续 scale，初始候选 bucket 为：

```text
1.00, 0.90, 0.83, 0.75, 0.67, 0.58, 0.50
```

具体 buckets 由 Q05/Q06 quality + cache churn evidence 校准。目标是稳定 graph cache、texture pool、history 和 TAAU quality，不是仅减少 scale 数量。

## 12. Showcase profiler 与中文调试面板

复用现有 FrameProfiler，不建立第二套 profiler。Q00 面板必须显示真实采样而不是 FPS 推断：

- GPU total、phase P50/P95/P99；
- actual render/compute Pass、dispatch、draw 数；
- internal/output resolution 和 domain transition；
- Visibility、Surface、Shadow、Lighting、GTAO、SSR、Temporal、Bloom、Exposure、Tonemap 时间；
- SSR trace pixels、hit ratio、average steps、roughness/distance rejects；
- GTAO pixels、resolution、history accept/reject；
- Temporal rejection ratio；
- resident/transient/history/retiring bytes；
- overflow/invalid/fallback counters。

调试参数从 schema 生成并显示 requested/effective value、单位、uniform/topology/resource change 和 history impact。任何 UI 参数没有 shader/resource consumer 时测试失败。

## 13. 初始 Desktop Quality Profile

下面只是 Q00/Q03/Q04 的初始 sweep，不是冻结值：

| Feature | Medium | High | Ultra |
|---|---:|---:|---:|
| GTAO | 0.5x / 2×4 | 0.5x / 3×5 | 1x / 3×6 |
| SSR | 0.5x / 40 steps | 0.5x / 64 | 1x / 96 |
| SSR max roughness | 0.55 | 0.65 | 0.75 |
| TAAU | standard | high clamp | high reconstruction |
| Bloom | 4 mip | 5 mip | 6 mip |
| Shadow | medium | high | ultra |

建议 production 默认从 half-res GTAO、half-res SSR、roughness cutoff、48–64 HZB steps、output-resolution TAAU、half-res bloom pyramid 开始校准。不得再默认 full-res SSR + 128 steps 后靠降低总 internal scale补救。

项目已经冻结 RTX 2060 SUPER、1080p/60 和 `16.667 ms` 整帧目标，但尚未冻结 AO/SSR/Post 的可信分段预算。Q00 先采集真实数据，再更新 `performance-targets.json`；不得凭空写某个 Pass 必须 `0.7 ms`。

## 14. 七阶段执行计划

### R5-Q00 — Evidence Freeze

以冻结 before evidence 为主体，不在本阶段重写画质算法。允许为证据可观测性消除明确的
dead control，但必须在本文件记录；这类接线修复不能用于宣称 GTAO/SSR/TAA 质量关闭。

交付：

- Showcase GPU timing 面板；
- actual Pass/dispatch/draw counts；
- resolution domains；
- SSR hit/step/reject counters；
- GTAO pixel/history counters；
- 固定相机、GPU、resolution、DPR、quality 的 effect on/off paired A/B；
- Base、CSM、GTAO raw/spatial/temporal、SSR trace/resolve/temporal、TAA、Bloom/Exposure/Post、All-on 的静态图和运动序列。

退出：每个当前异常都能对应到 phase、资源、domain 和图像证据；before artifact 完整且 provenance 可回查。

### R5-Q01 — Render Contract

交付：

- PhysicalScaleContract；
- ResolutionDomain；
- immutable SurfaceFrame；
- AmbientOcclusionFrame；
- Opaque/Final TemporalSurfaceFrame；
- RenderSettings、QualityProfile、FeatureContract；
- 清除 Renderer loose-setting leakage。

退出：画面数学基本不变；Motion Blur 等 domain mismatch 在 graph build 被拒绝或显式转换；动态 slider 不 rebuild graph。

### R5-Q02 — Composition Rebuild

交付：

- Material AO 与 Ambient Visibility 分离；
- Opaque Lighting 深模块和 baseline IBL composition；
- SSR 移到 Complete Opaque HDR 后并改为 specular correction；
- ExposureSourceHDR 与 Bloom 解耦；
- Sharpen 移到 Bloom 后；
- 删除由新 composition 替代的旧 Pass/测试，不保留双 production 路径。

退出：Pipeline Contract Gate 全部通过；Pass/bandwidth 有同条件前后数据；不能只证明图像非空。

### R5-Q03 — GTAO 2.0

交付：meters radius、linear/view depth、depth mip、half-res default、正确 temporal weight、shared opaque validity、joint bilateral AO+bent-normal upsample。

退出：AO reference、0.1x/1x/10x physical-scale、pan/dolly、feature-off、GPU phase 和 memory Gate 通过。

#### 2026-09-01 执行记录（Q01–Q03）

- Q01：新增 `render/pipeline/RenderSettings.ts` 与 `FrameProducts.ts`。Renderer 只接受 `configure()` patch 并暴露 immutable snapshot；Topology/Resource/History 变化分类由同一 owner 决定。`PhysicalScaleContract` 是 AO、SSR、Shadow 的 meters→world 唯一入口；旧示例调用方已迁移，LightCluster job 不再夹带 AO 字段。
- Q02：GTAO 输出独立 Ambient Visibility/Bent Normal，不再写 `albedoAo.a`；Indirect composition 分别消费 Material AO 与 Ambient Visibility。IBL baseline 先进入 Complete Opaque HDR，SSR 读取该 HDR 后由 `SpecularCorrectionPass` 添加 `resolved - baseline`。Exposure 固定读取 Bloom 前 HDR，Sharpen 在 Bloom composite 后执行。
- Q03：生产默认 half resolution；raw radius/falloff 以 meters 配置后换算 world units；新增 AO-resolution linear/view-depth product；Temporal blend 使用完整 `history_weight`；联合 bilateral resolve 同时输出 full-resolution visibility 与 bent normal，并读取深度/法线边界。FX-07 增加 0.1x/1x/10x physical-scale contract stage。
- 删除/替代：production AO alpha-min composite 与 nearest bent-normal upsample 已移除；SSR 不再替代 baseline IBL specular。
- 当前验证：TypeScript/build 与 317 项 Node tests 通过。dirty/full FX-07 和 FX-08 浏览器 Gate 均 `passed=true`、issues 与 WebGPU validation/uncaptured/device-lost 为 0；FX-07 static temporal RMS `0.299 -> 0.069`，pan/disocclusion settle RMS `0.191/0.213`；FX-08 hit/miss `40,550/879,297`，pan/disocclusion response RMS `9.966/96.742` 且 settle 均为 `0`。运动验收截图使用 production Linear HDR，AO raw/denoised/temporal debug view 只承担静态诊断。当前 artifact 绑定 dirty worktree，故 `gateEligible=false`；提交后的 clean/full runner 仍是正式退出证据。

### R5-Q04 — SSR 2.0

交付：half-res、real distance termination、hit edge fade、roughness cutoff、adaptive steps、physical thickness、complete scene color、shared validity、单轮 spatial 和 edge-aware composite。

退出：mirror/rough floor/offscreen/edge/long distance/invalid/backface/pan/disocclusion/Rough Road Gate 通过；rough road 高 roughness 大部分 fallback IBL，不出现满屏 black speckle。

### R5-Q05 — Temporal 2.0

`R5-Q05` 是剩余 `FX-06B Final TAA/TAAU / Upscale Closure` 的实际执行 owner，不再另建一次重复的 Temporal 实施。

交付：Opaque/Final validity、统一 rejection、TAAU reconstruction/clamp、jitter contract、DRS transition。

退出：static jitter、slow/fast pan、disocclusion、moving opaque/transparent、MotionInvalid、Reactive、cut、resize、DRS `1.0 → 0.75 → 1.0` sequence 通过。

### R5-Q06 — FrameGraph / FramePlan Closure

交付：FrameGraph validation、cycle detection、stable topo schedule、FramePlan、Shadow/LPV scheduling、resolution-bucket DRS，之后才做 pass fusion、lifetime 和 bandwidth tuning。

退出：graph 执行顺序可由 dependency dump 证明；warm graph/cache 稳定；一个 main submit；feature-off 和 resource lifetime Gate 通过。

#### 2026-09-02 执行记录（Q04–Q06）

- Q04：SSR 默认改为 half-resolution trace/resolve，保留可配置 full-resolution；链路固定为 trace → resolve → 单轮 spatial → 可选 temporal → full-resolution joint bilateral upscale。`maxDistanceMeters` 在 march 内终止，edge fade 使用 hit UV，thickness 由 base meters + traveled-distance slope 构成，roughness cutoff、temporal owner 和 half/full topology 均进入统一 settings/cache key。SSR 仍是 Complete Opaque HDR 上的 specular correction，不复制第二条 composite。
- Q05：Temporal classification 拆成 `OpaqueTemporalValidity` 与 `FinalTemporalValidity`。GTAO/SSR 消费 opaque validity；最终 TAA 合入 transparent reactive。TAA 从最近 reverse-Z depth 邻域选择 velocity/motion-valid，当前颜色使用 4×4 Catmull-Rom reconstruction；透明 reactive 保留当前输出像素坐标，避免最近深度选择丢失前景拒绝标记。Velocity 已含 jitter delta，resolve 不做二次 jitter 补偿。DRS 只在 `0.5/0.67/0.75/0.8/1.0` 资源桶间迁移。
- Q06：FrameGraph 新增 resource/version/read-before-write、resolution-domain、duplicate producer、dependency cycle 校验，按 stable topological order 执行，并在 dump 中公开依赖、执行序号、domain conversion owner 与真实 encoder work 声明。FramePlan 在单帧上编排 scene update、LPV、shadow 与 main graph；所有阶段仍记录到 Renderer 同一 command encoder，保持一个 main submit。
- 证据边界：dirty/full FX-08 与 FX-06B 已在 RTX 2060 SUPER 上执行；最终 artifact 路径与图像/时序数值登记在 `docs/PERFORMANCE.md`。这些结果可证明 production browser correctness 与 focused temporal/SSR contract，但由于工作树未提交，`gateEligible=false`，不能替代提交后的 clean/full exit，也不代表 G5-P 1080p/60 已达成。

### R5-Q Product Closure

Q00..Q06 全部完成后，才执行 FX-12 legacy deletion 和 G5-P：1080p/High/Cyberpunk City all-on、A/B/C full、目标/最低 correctness adapter、显存/I/O cap 和 clean provenance。只有全部通过才能设置 `productPerformanceAchieved=true`。

## 15. Quality 与 Pipeline Contract Gates

### 15.1 AO Gate

- Plane + Wall Corner；
- Large Open Plane；
- Thin Pole；
- Object Contact；
- Camera Pan / Dolly；
- scale `0.1x / 1x / 10x`。

Physical scale 补偿后，AO 的物理半径应保持一致。

### 15.2 SSR Gate

- Perfect Mirror；
- Rough Floor / Rough Road；
- Off-screen Reflected Object；
- Screen Edge / Long-distance / Invalid / Backface Hit；
- Camera Pan / Disocclusion。

### 15.3 Temporal Gate

- Static jitter、slow/fast pan；
- disocclusion；
- moving opaque/transparent；
- MotionInvalid、Reactive；
- cut、resize、DRS transition。

### 15.4 Pipeline Contract Gate

1. Bloom OFF/ON：Auto Exposure target 在容差内保持不变。
2. GTAO OFF/ON：Surface BaseColor 和 Material AO bit-identical。
3. 只受 IBL 照亮的物体：SSR 能反射其完整 opaque radiance。
4. SSR maxDistance `5 m / 20 m`：hit distribution 发生确定变化。
5. SSR edgeFade sweep：screen-edge confidence/counter 和 image oracle 发生确定变化。
6. internal/output resolution 不同：每个跨域 consumer 有显式转换，Motion Blur 无越界或坐标错配。
7. TAA jitter contract：velocity 已含 jitter delta，resolve 不发生 double compensation。

## 16. 性能与资源 Gate

不再只报告 FPS。每次正式 paired Gate 必须同时报告：

```text
GPU Total P50/P95/P99
GPU Phase P50/P95/P99
Pixel / Ray / Work / Step / Pass / Dispatch / Draw counts
Resident / Transient / History / Retiring / Fragmentation bytes
Output/Internal resolution, DPR, quality profile
```

Hardware Raster 和 Texture Residency 仍是独立产品 P0 债务：

- R4-A/B Hardware Raster 回退继续单变量调查，但 R5-Q 不推翻 VisibilityKey/RasterWork/Single Resolve；
- `4096×4096×16` uncompressed texture array 约 `1.33 GiB`，违反 `512 MiB` resident cap；size-class/budgeted residency 必须在 G5-P 前完成；
- 两项都纳入 Q00 总帧和显存证据，但不改变 Q01..Q06 的 composition-first 顺序。

## 17. Artifact 与文档更新

原始 artifact 沿用不纳入 Git 的目录：

```text
temp/r5-quality/<phase>/<commit>/<profile>/<session>/
  environment.json
  provenance.json
  result.json
  graph.json
  domains.json
  memory.json
  timings.json
  console.json
  images/
  sequences/
```

每个 Gate 在 `PERFORMANCE.md` 登记 commit、路径、环境、settings/profile hash、P50/P95/P99、工作量、显存、截图/序列 hash 和结论。算法采用同步更新 porting ledger；长期决策改变才新增 ADR；代码真正改变后才更新 `CURRENT-STATE`。

新测试从深模块 interface 验证行为。替换完成后删除旧浅模块测试，禁止保留第二条 production 路径或继续叠加只验证内部实现细节的测试。

## 18. 首个实施入口

当前执行入口为 `R5-Q Product Closure / G5-P`。Q01–Q06 的代码迁移已完成，但其正式 clean/full exit artifact 必须在提交后补采；若 full Gate 暴露回归，应回到对应 Q01–Q06 owner 修复，不能以迁移记录替代验收。

在 Q00 完成前，不接受下列内容作为修复完成：

- 调高 AO/SSR/TAA 强度；
- 增加 denoise 次数；
- 统一降低 internal scale；
- 只保存一张“看起来更好”的截图；
- 用历史 focused Gate 代替 integrated evidence。

## 18A. 当前阶段文档路由

为避免把大量历史 P 阶段误认为当前执行顺序，现行重构只使用六个宏观阶段。每个阶段都有独立设计、代码范围、算法边界、验证和删除条件：

| 阶段 | 详细设计 | 真实重构重点 |
|---|---|---|
| Stage 0 | [证据基线与合同冻结](./14-stage-0-evidence-and-contract-freeze.md) | 固定输入、GPU/显存/画面证据 |
| Stage 1 | [Surface / Opaque HDR 组合边界](./15-stage-1-frame-products-and-composition-seam.md) | 产品 ABI 与 producer/consumer seam |
| Stage 2 | [Lighting / Shadow / GTAO](./16-stage-2-lighting-shadow-and-ao.md) | 完整 Opaque HDR、阴影和 GTAO 算法 |
| Stage 3 | [Local Probe / SSSR / TAAU](./17-stage-3-reflection-and-temporal-reconstruction.md) | 反射校正、history、时域重建 |
| Stage 4 | [Transparency / HDR Post / FrameGraph](./18-stage-4-transparency-post-and-framegraph.md) | OIT、颜色域、调度和资源生命周期 |
| Stage 5 | [Legacy Deletion / Product Closure](./19-stage-5-legacy-deletion-and-product-closure.md) | 删除旧 consumer，完成综合 Gate |

历史 Q/P 编号保留用于 artifact 和提交追溯，不再作为新的拆分层级。

## 19. Stage 1：统一 Surface / Opaque HDR 产品（当前执行切片）

Stage 1 采用一个纵向切片完成，不再拆成多个 wrapper 子阶段。目标是先冻结效果
consumer 之间的产品边界，再进入 GTAO、SSR、TAA 的真实算法替换。

本切片已落地：

- `FrameProducts` 提供不可变 `SurfaceFrame` 与 `OpaqueLightingFrame`，统一 internal-full
  resolution domain；Surface 明确允许未启用时域时没有 velocity，以及普通 legacy Scene 没有
  metadata 的事实。
- `PackedMaterialResolvePass` 在创建 Surface attachments 后直接产出 `SurfaceFrame` 产品视图，
  调用方不得再次依赖 attachment 顺序重组 Surface ABI。
- `OpaqueLightingPipeline` 使用共享 `OpaqueLightingFrame` 类型，并在返回处验证资源 id 与
  resolution domain；SSR、Temporal 后续只能消费该产品。
- 公开 index 只导出产品类型和纯校验 helper，不暴露 GPU Pass、Buffer 或 Shader 类型。

本切片明确未完成：

- 没有替换 GTAO、SSR、TAA、GI 或 Post 的核心采样/重建算法；
- 没有删除 MaterialExpand、Velocity、旧 GI/SSR/AO/TAA consumer；
- 没有把 Renderer 的三段 GI/SSR 分支合并为最终 provider 实现。

退出证据：`npm run build`、`npm run build:test`、R5 contract/composition/P3 tests 通过；算法
替换和 legacy deletion 仍由后续同一主管线切片完成，不能把本阶段标为产品闭环。
