# 08 · R5 Lighting、Temporal 与 Post

## 阶段目标

在统一 Visibility、Surface、Depth/HZB 和 Velocity 契约上，优先完成大量动态灯光、现有 CSM、Transparency、Temporal Reconstruction、Dynamic Resolution 和 Upscaling，再逐项接回其他后处理。所有功能属于同一 FrameGraph；关闭后不保留 Pass、资源、history、readback 或 submit。

## 非目标

- 不设计 Core/Quality/Experimental 三档真实管线。
- 不把“旧代码存在”视为必须默认接线。
- 不为每个效果重复构建 depth、HZB、velocity、light list 或 exposure。
- 不用 TAA/Bloom 掩盖基础 surface、visibility 或 lighting 错误。
- 不在本阶段实现 VSM、ReSTIR/Lumen-like GI、地形/角色/粒子、云、水或大气专用路径。
- Decal 没有当前目标 workload、producer/consumer ABI 和 Gate，本阶段明确延期；不得用 Transparency 或 Material Resolve 的存在代替 Decal 完成证据。
- R4-C Software/Hybrid Visibility 是 optional performance track，不作为任何 G5 子 Gate 的前置。

## R5-00 · Contract / Baseline Freeze

R5 第一提交不实现新效果，先冻结下游共同依赖：

```text
Surface ABI v1
├─ Depth: depth32float reverse-Z / empty semantic
├─ PBR: metallic + perceptual roughness
├─ ShadingNormal: encode/decode + normalized semantic
├─ Albedo/AO: working-space base color + AO
├─ Emissive: linear scene-referred
├─ Velocity: coordinate/jitter convention + invalid
└─ SurfaceFlags: reactive / motion-valid / unlit / reserved bits

Color Contract
├─ working linear space
├─ HDR scene color
├─ exposure/pre-exposure ownership
└─ SDR/HDR output transform
```

### R5-00 Surface ABI v1 精确冻结

`OEngine/src/gpu/GpuSurfaceAbi.ts` 是 Surface format、metadata packing 与 velocity semantic 的唯一代码级 truth source。R4-B 遗留的 `surfaceFlags` / `PACKED_SURFACE_FLAGS_FORMAT` 名称暂作兼容别名；attachment 实际语义是 **Surface metadata**，不得再手写位移或 magic mask。

| Attachment | Format | v1 semantic |
|---|---|---|
| Depth | `depth32float` | reverse-Z，empty/clear = `0` |
| PBR | `rg8unorm` | `r = metallic`，`g = perceptual roughness` |
| Normal | `rgba16uint` | `xy = encoded shading normal`，`zw = encoded geometric normal` |
| Albedo/AO | `rgba8unorm` | `rgb = working-linear base color`，`a = ambient occlusion` |
| Emissive | `r32uint` | RGB9E5，linear scene-referred |
| Velocity | `rg16float` | internal pixel，`current - previous` |
| Metadata | `r32uint` | low 16 bit material slot + high 16 bit flags |
| HDR scene/debug color | `rgba16float` | working-linear HDR |

Metadata v1：

```text
bits  0..15  resident MaterialRecord slot
bits 16..31  Surface flags

flag bit 0   valid
flag bit 1   motion-valid
flag bit 2   reactive
flag bit 3   gradient-fallback
flag bit 4   normal-texture
flag bit 5   ORM-texture
flag bit 6   emissive-texture
flag bit 7   unlit
flag bit 8..15 reserved
```

当前材质驻留容量为 `4096`，16-bit material slot 提供到 `65535` 的 ABI 余量；未来若突破该上限必须显式升级 Surface ABI，禁止截断。Velocity 使用调用方提供的 current/previous projection matrix，因此 projection jitter 若存在会包含在 velocity 中。previous homogeneous 与 previous clip 都只有 `w > epsilon` 才允许透视除法；非正 `w` 不能借 `abs(w)` 伪装成有效重投影。motion 无效时 v1 固定为 `velocity = 0`、`motion-valid = false`、`reactive = true`，Temporal consumer 必须拒绝或降权旧 history。

R5-00 与 FX-01 的边界固定如下：R5-00 拥有 attachment format、metadata packing、velocity convention、现有 Resolve/Counter/Debug consumer 迁移和 A/B/C baseline artifact；FX-01 不再重新定义 ABI，只补 GPU 数值 readback、empty/background 行为和 Surface debug 可视验证。改变 format、bit layout 或 velocity convention 必须先升级 ABI/version，不能藏在 FX-01 的 debug 修复里。

### Reactive v1 producer ownership

`Reactive` 是各 owner 写入后按逻辑 OR 合并的保守标记；v1 不编码独立 reason bit，consumer 不得根据单一 bit 猜测来源。

| 原因 | 写入 owner | R5-00/后续行为 |
|---|---|---|
| previous transform/clip 无效 | Packed Material Resolve | zero velocity，清 `MotionValid`，置 `Reactive` |
| analytic gradient fallback | Packed Material Resolve | 置 `GradientFallback + Reactive` |
| BLEND transparent contribution | FX-05 transparent composite | composite 时 OR 到 temporal reactive 输入；不回写 opaque Surface |
| depth/normal/material disocclusion | FX-06 temporal classification | 从 current/history Surface 比较生成 history reject/confidence |
| LOD transition | FX-06 temporal classification | affected pixels 降权或拒绝 history；不得全局永久 reactive |
| texture/geometry re-resident | residency revision owner + FX-06 | v1 在 affected-pixel marker 完成前使用一次性保守 history revision invalidation；未来 streaming 必须补受影响像素标记 |

材质/场景 revision 只能触发一次性 history epoch 变化，禁止每帧全局 invalid。透明、LOD 和 re-residency producer 尚未实现时，文档只定义 contract，不得声明这些 reactive case 已关闭。

Color contract 在 R5-00 只冻结 ownership，不宣称 FX-09 已完成：Surface/base color 与 emissive 进入 working-linear/scene-referred 数据面；exposure/pre-exposure 只能由后续 exposure owner 处理；SDR/HDR output transform 只能发生在最终 output/present 阶段。

同时：
- R5 base A/B/C manifest 只列实际运行的 HW feature；optional `software-visibility` 从 base featureSet 移出；
- `performance-targets.json` 在目标机器采样后冻结绝对门槛；
- Lighting/Temporal 开始修改前先关闭 runtime oracle/generated source-of-truth 债务；
- 建立 `R5-BENCHMARK-MATRIX.md` 与 `R5-TEST-MANUAL.md`。

## 方案 B 子 Gate

```text
R5-00
  ↓
FX-01 Surface
FX-02 Clustered Direct
FX-03 IBL
  ↓ G5-L · Lighting Baseline

FX-04 CSM Shadow
FX-05 Packed MBOIT Transparency
  ↓ G5-S · Secondary Raster

FX-06 Temporal / DRS / Upscale
FX-07 AO
FX-08 SSR
  ↓ G5-T · Temporal Quality

FX-09 Post
FX-10 Optional Effects
FX-11 Evidence-driven Fusion
FX-12 Legacy Deletion
  ↓ G5-P · Product / Performance Closure
```

每个 FX 的人工步骤、预期截图/counter/sequence 和提交复核材料见 [R5-TEST-MANUAL](./R5-TEST-MANUAL.md)；性能扩展轴见 [R5-BENCHMARK-MATRIX](./R5-BENCHMARK-MATRIX.md)。

## 统一资源图

```text
Visibility + Depth
  ├─ final HZB ───────────────→ AO / SSR / later-frame culling
  └─ Material Resolve
       ├─ Surface
       ├─ Velocity / Reactive
       └─ Material flags

LightTable → Light Cluster ───→ Direct Lighting
Environment/BRDF LUT ─────────→ IBL
Shadow work/atlas ─────────────→ Direct Lighting
Surface + lighting ────────────→ Opaque HDR
Transparent work ──────────────→ OIT/composite
Opaque/transparent HDR
  → AO/SSR integration as declared
  → TAA/TAAU
  → Exposure
  → Bloom
  → Tonemap
  → Present
```

实际 AO/SSR 在 lighting 前后组合由算法契约决定，但只能使用已声明的共享资源。FrameGraph 必须能输出某个 feature 的完整 producer/consumer 链。

## 当前代码入口与处置

| 功能 | 当前入口 | 初始处理 |
|---|---|---|
| light clustering | `LightClusterPass.ts`、`shaders/light_cluster.ts` | 先冻结现有 LightDatabase/cluster ABI；修 attempted/written/overflow 与 per-cluster silent drop，profile 后再决定是否重写 LightTable |
| direct lighting | `LightingPass.ts`、`lighting_direct.ts` | 对齐新 Surface/Material flags |
| IBL/background | `IblDiffusePass.ts`、`IblSpecularPass.ts`、`EnvironmentBackgroundPass.ts` | B 场景最先恢复 |
| shadow | `ShadowRasterPass.ts`、`ShadowContext.ts` | 删除旧 MeshletDrawList 依赖，复用新 hierarchy work |
| transparency | `TransparentOitPass.ts` | 迁移到新 geometry/material tables，保持独立透明工作 |
| AO/SSR | `ScreenSpaceAmbientOcclusionPass.ts`、`ScreenSpaceReflectionsPass.ts` | 复用 final Depth/HZB/Surface/Velocity |
| TAA/motion | `TemporalAntiAliasingPass.ts`、`MotionBlurPass.ts` | 统一 history invalidation/reactive |
| exposure/bloom/tonemap | 对应 `*Pass.ts` | 按依赖顺序恢复并核实 color space |
| LPV/Brick4/NSS/path tracer/SDF/volumetrics | 现有 pass/gpu/shader | 不默认接线；作为同图可选节点或 reference/tool 隔离验证 |

“不默认接线”不是删除能力承诺；只有在 source-of-truth、owner 和验证清楚后才进入主管线。Path tracer 若作为离线/对照 renderer，必须与实时主管线资源明确隔离，不影响稳定帧。

R5 的 source-of-truth 前置：
- FX-02 开始修改 Lighting 前，`lighting_ch_oracle.ts` 必须选择 authored source 或可重复 generator，并建立 numeric/visual regression；
- FX-06 开始修改 Temporal 前，`temporal_post_legacy.generated.ts` 必须登记 generator/source；无法追溯时先按已登记 reference 写最小 authored baseline；
- 其他 `dead/unknown` shader 由 FX-12 清理，但不能仅按文件名删除。

## Feature node contract

每项功能必须登记：

```text
feature bit / config owner
scene activation condition
inputs / outputs
resolution and format
history state and invalidation
GPU queue/work capacity and overflow
timer/counters
fallback
off-state graph assertion
```

一个 feature 没有 consumer 时，其 producer 一起被裁掉。例如关闭 SSR 时，不创建 SSR history、prefilter、trace、denoise 或 composite；不能只跳过最后 composite。

## History 失效矩阵

| 事件 | previous HZB | TAA/TAAU | SSR | AO temporal | Exposure | Shadow cache |
|---|---|---|---|---|---|---|
| resize/internal scale | invalid | invalid | invalid | invalid | 可保留或按算法明示 | atlas 可保留，screen cache invalid |
| camera cut/switch | invalid | invalid | invalid | invalid | reset/adapt 明示 | view-dependent cache invalid |
| device lost | invalid/recreate | invalid/recreate | invalid/recreate | invalid/recreate | invalid/recreate | invalid/recreate |
| feature off → on | 按 culling owner | invalid | invalid | invalid | invalid | 按 shadow owner |
| LOD transition | 无全局 invalid | reactive/降权 | reactive/降权 | reactive/降权 | 无 | geometry dirty regions |
| texture/geometry re-resident | fail-open | affected pixels reactive | affected invalid | affected invalid | 无 | affected casters dirty |

每个实现可以比表更保守，但不能使用未初始化或错误 view 的 history。具体 revision 存在 R1 `HistoryState`。

## 分阶段恢复顺序

### FX-01 · Surface debug + Background

消费 R5-00 已冻结的 Surface ABI，证明 Surface/Depth/Velocity 的 GPU 数值 decode 与 debug 正确，背景处理 empty Visibility、HDR 色彩空间和 exposure 前值。FX-01 不拥有 format/packing 重设计；没有这一步不进入复杂光照。

### FX-02 · LightTable 与 clustered direct lighting

先验证当前 `LightDatabase`，不为“统一命名”强制重写 owner。冻结 cluster grid 与 LightList queue：

```text
attempted
written
capacity
overflow
```

producer 可以 `attempted > capacity`，但所有 consumer 只能遍历 `written`。当前 per-cluster point/spot 上限触发时必须设置 overflow 并执行 conservative fallback，禁止 `continue` 后静默少灯。用 0/1 directional、1 point、1 spot 与 C-light `0/1/16/64/256/1024 × spread/overlap` 验证 numeric correctness、worst overlap、capacity 与 scaling。

### FX-03 · IBL 对齐

迁移 diffuse/specular IBL、environment prefilter 和 BRDF LUT。与 Benchmark B 对齐 environment、roughness mip、normal/tangent、color space 和 exposure；禁止额外效果干扰。

### FX-04 · CSM Shadow

保留现有 CSM，不建设 VSM。每个 Cascade 的 caster selection 复用 Instance/Hierarchy/Cluster tables 和 GPU indirect consumer，不恢复 CPU draw list。记录 main/cascade traversal、raster、atlas bytes、更新频率和 alpha-tested caster 成本；关闭 shadow 不保留 caster work/atlas update。

### FX-05 · Transparency

Alpha-tested 留在 Visibility；BLEND 从同一 hierarchy/RasterWork 数据面分类到有界 `TransparentRasterWork`。当前透明算法按 Moment-Based OIT 迁移，不引入不存在的 A-buffer node pool：容量重点是 transparent work queue、raster-state bins、moment numeric range/precision 和 material/texture residency。

透明 shader 必须动态读取同一 Material/Texture owner；draw/pass 数只能依赖有硬上限的 raster-state bin（例如 front/double-sided），不得随 active material 数线性增长。用 overlapping colored quads 做 order-invariance + sorted-alpha quality reference，再跑 C-transparent 的 coverage/depth-layer/material sweep。

### FX-06 · Temporal Reconstruction / Dynamic Resolution / Upscaling

先闭合 Temporal shader source-of-truth，再分离 internal/output resolution。Temporal input contract 至少包含 current HDR、Depth、Velocity+motion-valid、Reactive、disocclusion/history confidence、history revision、jitter 与 internal/output resolution。覆盖 camera cut、disocclusion、LOD transition、透明、dynamic resolution 和 resize。

DRS 使用异步/延迟 GPU timestamp feedback 更新 scale；禁止同步 `mapAsync` 或 readback 控制当前帧，也不产生第二条主管线。C-temporal/C-resolution 必跑 static/pan/fast motion/disocclusion/reactive/cut/resize/scale transition sequence。

### FX-07 · AO

SSAO/GTAO 选择由画质/性能对比决定，复用 final Depth/HZB/normal。半分辨率、temporal 和 denoise 的每个资源都受同一 feature bit 裁剪。

### FX-08 · SSR

复用 HZB、Surface、roughness、Velocity/history；定义 miss/fallback 到 IBL，避免重复 prefilter 可融合资源。关闭后零 SSR history/trace/denoise。

### FX-09 · Exposure、Bloom、Tonemap、Sharpen/Motion Blur

按 HDR → exposure → bloom/composite → tonemap → output transform 的色彩顺序接入。每项明确输入分辨率、输出 color space 和关闭行为。Motion Blur 不得使用 invalid velocity。

### FX-10 · 已有项目效果隔离迁移

LPV、Brick4、NSS、SDF、volumetrics、GI 或其他用户已有项目逐项以 Feature node contract 迁移；未通过验证保持断开。任一功能不得增加 feature-off 的主帧固定成本，也不成为 R5 基础 Gate。

### FX-11 · 资源/Pass fusion 实验

只有 timestamps/bandwidth 证明瓶颈后评估 resolve-lighting fusion、AO/SSR 共用 prefilter、半分辨率或 temporal reconstruction。每次实验保持输入输出语义与独立关闭能力。

同时量化 texture owner 的 allocated/resident bytes、resident/retiring/free layer、实际采样 mip 分布、fallback 和每帧 upload。固定 `64 × 256² × 9 mip` owner 必须与 size-class/按需 residency 候选做同条件内存与 GPU time 对照；只有证据显示固定浪费或 mip 缺失达到目标门槛时才建立 streaming 任务。R5 不因“存在纹理数组”声明 mip streaming 已实现，也不在没有反馈数据时预先引入 streaming 复杂度。

### FX-12 · 删除旧旁路

每恢复一个功能，删除旧 GBuffer、旧 visibility IDs、旧 MeshletDrawList、独立 HZB/velocity 和私有 submit 依赖。没有通过的新功能不默认回接旧链。

## 队列与 overflow

### Light clusters

记录 cluster count、tested lights、written indices、per-cluster max 和 global index capacity。overflow 时使用保守大光源/global list fallback 或显式限制；禁止随机丢灯。

### Shadow work/atlas

caster queue、tile/page allocation 和 dirty update 各自有 capacity/counter。atlas 满时按明确优先级降级分辨率/拒绝新 shadow，并报告；不覆盖仍被采样的 tile。

### Transparency

当前算法为 Moment-Based OIT，不使用 A-buffer node pool。必须定义 `TransparentRasterWork attempted/written/capacity/overflow`、raster-state bin 上限、moment precision/range 与 overlap pressure。overflow 可以使用经过验证的保守降级，但不能越界、NaN/Inf 或静默减少 transparent work。

## 画质验证

- 使用线性 HDR 数值测试验证 direct/IBL/shadow，不先经过 tonemap 比截图。
- Benchmark B 对齐 base color、normal、metallic、roughness、emissive、IBL、camera 和 exposure。
- 保存 feature-by-feature golden：off、单独 on、组合 on。
- TAA/SSR/AO 使用相机轨迹序列，不只比较一张静态截图。
- debug views 能显示 light clusters、shadow atlas、AO、SSR hit/miss、velocity/reactive、history validity、exposure 和 HDR range。

## 性能验收

- 每项输出独立 GPU time、分辨率、读写字节估计、history bytes、工作量和 P50/P95/P99。
- feature off 的 graph dump、resource list、timestamps 和 submit 均无该功能。
- B 在相同 PBR/IBL 条件下与 three.js 基线对照；C 按 lights/materials/shadows/transparent pixels 分轴扩展。
- 不用“功能更多”解释回退；附加功能必须关闭后比较基础链，开启后单列增量。
- 半分辨率/temporal/fusion 方案同时报告画质差异和长尾，不只报平均 GPU time。

## 回退与失败条件

- 某旧效果依赖已删除 ABI：先写 adapter-free 迁移设计；不恢复旧主链。
- feature 关闭仍创建资源/Pass：不能合入，修正 graph recipe/owner。
- history 闪烁/拖影：禁用该 temporal reuse 或 fail-open，修正 invalidation/reactive 后再启用。
- queue/atlas overflow 破坏画面：使用明确降级或报错，禁止静默。
- 高级功能持续拖慢默认帧：保持断开，保留独立研究证据，不影响统一主管线。

## 子 Gate 与阶段退出

- **G5-L**：Surface ABI、direct lighting、LightList/per-cluster overflow、B-shading IBL oracle 和 C-light sweep 通过。
- **G5-S**：Packed CSM 与 Packed MBOIT Transparency 通过；shadow/transparent Packed consumer 不再依赖 legacy `MeshletDrawList`/per-material work producer。
- **G5-T**：Temporal/DRS/Upscaling、AO、SSR 的 camera cut/resize/disocclusion/reactive sequence 通过；history owner/source-of-truth 闭合。
- **G5-P**：Post/color pipeline、feature-off、legacy 删除、shader ownership、clean/full A/B/C + R5 axis sweeps、texture resident/mip evidence 与 streaming 决策、目标机器 `performance-targets.json` 通过。

G5-L/S/T/P 全部关闭后 R5 才能宣称完成。高级 GI、内容专用效果与 optional R4-C 不阻塞阶段退出。
