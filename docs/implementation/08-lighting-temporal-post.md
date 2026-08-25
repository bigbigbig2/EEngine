# 08 · R5 Lighting、Temporal 与 Post

## 阶段目标

在统一 Visibility、Surface、Depth/HZB 和 Velocity 契约上逐项接回高质量光照、阴影、透明、时域和后处理。所有功能属于同一 FrameGraph；按依赖和场景启停，关闭后不保留 Pass、资源、history、readback 或 submit。

## 非目标

- 不设计 Core/Quality/Experimental 三档真实管线。
- 不把“旧代码存在”视为必须默认接线。
- 不为每个效果重复构建 depth、HZB、velocity、light list 或 exposure。
- 不用 TAA/Bloom 掩盖基础 surface、visibility 或 lighting 错误。

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
| light clustering | `LightClusterPass.ts`、`shaders/light_cluster.ts` | 按新 Depth/LightTable ABI 重接并验证 overflow |
| direct lighting | `LightingPass.ts`、`lighting_direct.ts` | 对齐新 Surface/Material flags |
| IBL/background | `IblDiffusePass.ts`、`IblSpecularPass.ts`、`EnvironmentBackgroundPass.ts` | B 场景最先恢复 |
| shadow | `ShadowRasterPass.ts`、`ShadowContext.ts` | 删除旧 MeshletDrawList 依赖，复用新 hierarchy work |
| transparency | `TransparentOitPass.ts` | 迁移到新 geometry/material tables，保持独立透明工作 |
| AO/SSR | `ScreenSpaceAmbientOcclusionPass.ts`、`ScreenSpaceReflectionsPass.ts` | 复用 final Depth/HZB/Surface/Velocity |
| TAA/motion | `TemporalAntiAliasingPass.ts`、`MotionBlurPass.ts` | 统一 history invalidation/reactive |
| exposure/bloom/tonemap | 对应 `*Pass.ts` | 按依赖顺序恢复并核实 color space |
| LPV/Brick4/NSS/path tracer/SDF/volumetrics | 现有 pass/gpu/shader | 不默认接线；作为同图可选节点或 reference/tool 隔离验证 |

“不默认接线”不是删除能力承诺；只有在 source-of-truth、owner 和验证清楚后才进入主管线。Path tracer 若作为离线/对照 renderer，必须与实时主管线资源明确隔离，不影响稳定帧。

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

先证明 Surface/Depth/Velocity 单独正确，背景处理 empty Visibility、HDR 色彩空间和 exposure 前值。没有这一步不进入复杂光照。

### FX-02 · LightTable 与 clustered direct lighting

迁移 LightTable，明确 cluster grid、light index queue ABI、capacity、overflow 和大光源 fallback。用 0/1/多灯数值场景验证 inverse-square、单位和色温/颜色语义。

### FX-03 · IBL 对齐

迁移 diffuse/specular IBL、environment prefilter 和 BRDF LUT。与 Benchmark B 对齐 environment、roughness mip、normal/tangent、color space 和 exposure；禁止额外效果干扰。

### FX-04 · Shadow

Shadow caster selection 复用 Instance/Hierarchy/Cluster tables 和统一 Change Set，不恢复旧 MeshletDrawList。shadow atlas 有明确 allocation、eviction、dirty、overflow 与 debug view；关闭 shadow 不保留 caster work/atlas update。

### FX-05 · Transparency

Alpha-tested 留在 Visibility；真正 blend 材质走透明队列。OIT/排序方案声明容量与 overflow，使用同 MaterialTable/texture pools，正确合成 Opaque HDR、depth 和 velocity/reactive。

### FX-06 · TAA/TAAU

以新 Velocity、Depth、reactive 和 HistoryState 接入。覆盖 camera cut、disocclusion、LOD transition、透明、dynamic resolution 和 resize。TAAU 是否启用是配置节点，不复制一条主管线。

### FX-07 · AO

SSAO/GTAO 选择由画质/性能对比决定，复用 final Depth/HZB/normal。半分辨率、temporal 和 denoise 的每个资源都受同一 feature bit 裁剪。

### FX-08 · SSR

复用 HZB、Surface、roughness、Velocity/history；定义 miss/fallback 到 IBL，避免重复 prefilter 可融合资源。关闭后零 SSR history/trace/denoise。

### FX-09 · Exposure、Bloom、Tonemap、Sharpen/Motion Blur

按 HDR → exposure → bloom/composite → tonemap → output transform 的色彩顺序接入。每项明确输入分辨率、输出 color space 和关闭行为。Motion Blur 不得使用 invalid velocity。

### FX-10 · 高级可选功能隔离接入

LPV、Brick4、NSS、SDF、volumetrics、GI 等逐项以 Feature node contract 接入；未通过验证保持断开。Path tracer 作为 reference/tool 时使用显式入口和资源 owner。任一功能不得增加 feature-off 的主帧固定成本。

### FX-11 · 资源/Pass fusion 实验

只有 timestamps/bandwidth 证明瓶颈后评估 resolve-lighting fusion、AO/SSR 共用 prefilter、半分辨率或 temporal reconstruction。每次实验保持输入输出语义与独立关闭能力。

### FX-12 · 删除旧旁路

每恢复一个功能，删除旧 GBuffer、旧 visibility IDs、旧 MeshletDrawList、独立 HZB/velocity 和私有 submit 依赖。没有通过的新功能不默认回接旧链。

## 队列与 overflow

### Light clusters

记录 cluster count、tested lights、written indices、per-cluster max 和 global index capacity。overflow 时使用保守大光源/global list fallback 或显式限制；禁止随机丢灯。

### Shadow work/atlas

caster queue、tile/page allocation 和 dirty update 各自有 capacity/counter。atlas 满时按明确优先级降级分辨率/拒绝新 shadow，并报告；不覆盖仍被采样的 tile。

### Transparency

OIT node/fragment 容量必须定义。overflow fallback 可以是 weighted blended/受限排序等已验证方案，但不能越界或静默破坏后续资源。

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

## 阶段退出

Benchmark B 的 Standard PBR + direct/IBL 基线正确，C 中 Shadow/Transparency/Temporal/Post 可逐项启停且成本透明；所有 history、queue、资源和 fallback 闭环；旧 ABI 旁路删除。更新 shading/performance Context、`CURRENT-STATE` 和受影响 ADR/lessons。
