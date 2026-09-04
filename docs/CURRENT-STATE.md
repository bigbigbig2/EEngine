# OEngine 当前实现事实

更新时间：2026-09-04

本文只回答“当前源码实际上做了什么”。阶段状态、算法成熟度和未关闭 Gate 的唯一入口是 [implementation/STATUS](./implementation/STATUS.md)；目标架构见 [13-product-render-pipeline-redesign](./implementation/13-product-render-pipeline-redesign.md)，当前执行设计见 [11-render-pipeline-reconstruction](./implementation/11-render-pipeline-reconstruction.md)。历史性能数字和完整 artifact 索引见 [PERFORMANCE](./PERFORMANCE.md) 与 [BASELINE-ARTIFACTS](./BASELINE-ARTIFACTS.md)。

## 当前生产帧

```text
Scene/GPU Scene updates
  → Instance cull + hierarchy/SSE/cone/previous-HZB work generation
  → Packed RasterWork → drawIndirect → VisibilityKey + reverse-Z depth
  → Packed Material Resolve → Surface + Velocity
  → Clustered Direct + CSM/Shadow
  → GI/IBL + AO + SSR correction
  → Transparency/OIT
  → Temporal/TAAU + DRS
  → Exposure/Bloom/Color Grading/Sharpen/Tonemap
  → Present
```

WebGPU 主帧目前使用单一 `Renderer` command encoder 和 steady main submit。Compiled FrameGraph、feature pruning、HZB previous/current history、GPU producer → GPU indirect consumer、Surface ABI 和统一 debug view 已接入。功能关闭时，已迁移的 owner 会跳过对应 Pass/resource/history；仍有 legacy consumer 的普通 `Scene` 分支暂不能宣称零成本删除。

## 已验证的基础能力

- R0–R1：观测 schema、CPU/GPU phase、counter、单主提交、compiled graph、Compute HZB 和 completion-safe resource lifecycle。
- R2：versioned Runtime Asset/Geometry package、Geometry/Cluster/Instance GPU records、GpuAssetStore、Packed Instance bulk/patch/residency。
- R3：hierarchy/SSE/cone/previous-HZB、VisibleCluster/RasterWork、GPU work queue、完整 indirect args 和 Hardware `drawIndirect()`；Packed flat producer 已删除。
- R4-A：`VisibilityKey v1`、reverse-Z depth、alpha-tested、capacity/overflow/fallback 和 key lookup。
- R4-B：Packed 路径单次 `PackedMaterialResolvePass` 输出 Surface + Velocity；普通 `Scene` 的 Material Expand/Velocity 仍有真实 consumer。
- Stage 1：`FrameProducts` 现在为 Packed Material Resolve 输出不可变 `SurfaceFrame`，并由
  `OpaqueLightingPipeline` 复用统一 `OpaqueLightingFrame`；这只是产品边界收敛，不代表底层
  GTAO/SSR/TAA/GI 算法或 legacy consumer 已替换。

这些条目表示对应 focused/核心 Gate 的证据，不表示最终产品画质或 1080p/60 整帧性能已达成。具体阶段分层只看 [STATUS](./implementation/STATUS.md)。

## R5 当前真实 owner

| Owner | 当前底层实现 | 真实边界 |
|---|---|---|
| `VisibilityFeature` | `PackedVisibilityPass`、`HierarchicalWorkGenerator` | Packed visibility/work generation |
| `SurfaceFeature` | `PackedMaterialResolvePass`、Surface ABI v1 | Packed Surface/Velocity |
| `LightingFeature` | `LightClusterPass`、`LightingPass`、`EnvironmentBackgroundPass` | clustered direct + HDR background |
| `ShadowService` | Packed CSM work + 现有 shadow raster | directional CSM；point/spot Packed 未完成 |
| `GIService` | `OpaqueLightingPipeline`、Brick4、LPV | Lightmap/Probe/IBL provider composition |
| `ReflectionService` | `ScreenSpaceReflectionsPass`、`SpecularCorrectionPass` | SSR delta correction + IBL fallback |
| `AOService` | `ScreenSpaceAmbientOcclusionPass` | GTAO visibility/bent normal output |
| `TransparencyFeature` | `PackedTransparentOitPass`、`TransparentOitPass` | Packed MBOIT 与普通 Scene OIT |
| `TemporalFeature` | `TemporalAntiAliasingPass`、`TemporalClassificationPass`、DRS | TAA/TAAU、history、jitter、DRS |
| `PostFeature` | Exposure、Bloom、Color Grading、Sharpen、Tonemap passes | HDR post composition |

因此当前架构事实是“新 owner 统一生命周期和组合入口，底层仍部分复用旧/现有算法 Pass”。不能因为 Feature 类已创建，就把对应算法写成已整体重构。

## R5 已有证据与未闭环范围

- FX-01–03：Surface、Clustered Direct、IBL focused Gate 已有 clean artifact。
- FX-04–05：Packed directional CSM、Packed MBOIT focused Gate 已有 artifact；普通 Scene shadow/OIT 仍保留。
- FX-06A/07/08：Temporal foundation、AO、SSR revalidation 已有 focused artifact；它们不等于整帧 TAAU、综合画质或 G5-T。
- R5-Q01–Q06：Render Contract、composition、GTAO/SSR correction、两层 temporal validity、Catmull-Rom TAA、bucketed DRS、FramePlan/FrameGraph 校验已迁入生产路径；当前提交后的 clean/full 数值/timestamp/memory artifact 尚未补齐，截图不属于必需证据。

仍未闭环的产品问题：

- 普通 `Scene` 的 Material Expand、Velocity、Shadow/OIT 和部分旧 indirect consumer 尚未迁移删除；`Renderer.ts` 仍是大型 composition root。
- GI、SSR、GTAO 的底层实现仍未全部替换为目标参考实现；已有证据只覆盖局部合同和 focused 场景。
- 最终 TAAU/Temporal 综合序列、Post、综合画质和 1920×1080/DPR1/60 FPS 产品 Gate 未通过。
- Hardware Raster 的历史 `35–44 ms` P50 风险、纹理/全帧 transient/history 显存预算和上传预算仍需 G5-P 关闭。
- Shader oracle/generated source-of-truth 仍有 `unknown` 项；以 [SHADER-SOURCES](./SHADER-SOURCES.md) 的审计结果为准。

## 下一跳

1. 在代码提交后重新运行 R5-Q04–Q06 的 clean/full 数值、timestamp、memory 和 diagnostics 证据，并更新 `PERFORMANCE.md` 和 `STATUS.md`；不要求截图回归。
2. 按 FX-09 → FX-12 顺序收口 Post、融合和旧 consumer/shader 删除；每次删除必须先有真实引用和替代 consumer 证据。
3. 执行 G5-P：目标场景 all-on、A/B/C、正确性 adapter、GPU phase、显存/I/O、feature-off 和 clean provenance 全部通过后，才可把 R5 标为 `产品闭环`。

## 本地参考边界

- `three.js/` 是本地参考，不是 OEngine runtime dependency；其 gitlink 修改属于用户现有工作树。
- `webgpufundamentals/` 是学习资料，不是架构权威。
- 外部算法采用、移植或拒绝记录在 [references/porting](./references/porting/README.md)；不能以博客、类名或单张截图替代实现和 Gate 证据。
