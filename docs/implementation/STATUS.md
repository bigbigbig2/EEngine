# OEngine 渲染重构状态

> **唯一状态入口**：本文只记录当前源码、提交和验证证据。目标设计见 [13-product-render-pipeline-redesign](./13-product-render-pipeline-redesign.md)，当前执行入口见 [README](./README.md)。
>
> 更新时间：2026-09-04。`three.js/` 的用户现有 gitlink 修改不属于本状态判断。

## 1. 状态语义

文档和提交必须使用下面的分层状态，不能把它们混写：

| 状态 | 含义 | 是否代表产品完成 |
|---|---|---|
| `目标设计` | 只描述目标合同、推荐顺序或未来接口 | 否 |
| `边界已接入` | owner、lifecycle、FrameGraph seam 已连接，底层实现可能仍是旧 Pass | 否 |
| `算法局部修正` | 已修改算法或 composition 的一部分，并有局部验证 | 否 |
| `focused Gate` | 固定小场景/单能力 Gate 通过 | 否 |
| `产品闭环` | 算法、旧路径删除、综合画质、GPU 时间、显存和 feature-off Gate 全部通过 | 是 |

仓库的“完成”只允许用于 `产品闭环`，或者明确限定为某一个 focused Gate。`Implemented` 不再作为跨文档的默认完成词。

## 2. 当前主线

当前不是在建设第二套渲染管线，而是在同一主管线上收敛现有生产路径：

```text
GPU Scene / View
  → Hierarchy + Work Generation
  → Packed Visibility / VisibilityKey / Depth
  → Packed Material Resolve / Surface
  → Clustered Direct Lighting + Shadow
  → GI / IBL + AO + SSR correction
  → Transparency / OIT
  → Temporal TAA/TAAU + DRS
  → HDR Post
  → Tonemap / Present
```

当前运行时仍存在 Packed 与普通 `Scene` legacy 分支；这不是目标架构，而是尚未完成 consumer 迁移的事实。

## 3. 阶段矩阵

| 阶段 | 当前源码事实 | 算法状态 | 旧路径状态 | 证据状态 | 当前结论 |
|---|---|---|---|---|---|
| R0–R3 | 观测、运行时固定成本、Packed 数据、层次工作生成和 GPU→indirect 闭环已落地 | 主要能力已通过对应 Gate | R3 Packed flat 已删除 | clean/full A/B/C artifact | `focused Gate` |
| R4-A | `VisibilityKey`、reverse-Z、Hardware Visibility、alpha 和容量合同已接入 | Packed 路径正确性已验证 | 普通 Scene 分支仍保留 | G4-A 关闭 | `focused Gate` |
| R4-B | `SurfaceFeature` → `PackedMaterialResolvePass` 一次 Resolve 输出 Surface/Velocity | Packed Material Resolve 已验证；不是全仓统一 | `MaterialExpandPass`、`VelocityPass` 仍被普通 Scene consumer 使用 | G4-B 关闭 Packed 范围 | `focused Gate` |
| P1 | `RenderFeatureRegistry`、FrameGraph 资源摘要和主帧证据已接入 | 明确不修改 TAA/SSR/GTAO | 旧 Pass 继续存在 | P1 合同测试 | `边界已接入` |
| P2 | `RendererConfig`、`RenderFrameContract`、能力 fail-fast 已接入 | 不包含效果算法迁移 | 旧参数/consumer 尚未全清 | P2 合同测试 | `边界已接入` |
| P3 | `VisibilityFeature`、`SurfaceFeature` 作为 Renderer owner | Packed 主链复用已验证实现 | Renderer 仍有 `packedResolveOut ?? obtainLegacyMaterialExpand()` | Packed Gate；普通 Scene 未闭环 | `边界已接入` |
| P4 | `LightingFeature`、`ShadowService` 收拢 cluster/direct/CSM owner | direct shader 和 Packed directional CSM 有局部 Gate | `ShadowRasterPass`、legacy light/scene 分支仍存在；Packed point/spot 未完成 | G5-L/FX-04 局部证据 | `算法局部修正` |
| P5 | `GIService`、`ReflectionService`、`AOService` 负责 provider/历史/合成边界 | GI fallback、SSR delta correction、AO 四通道分离已改；底层仍是 Brick4/LPV/SSR/GTAO 旧 Pass | `OpaqueLightingPipeline`、`IndirectCompositePass`、SSAO/SSR Pass 仍为实现 owner | FX-07/08 与 P5 focused artifact | `算法局部修正` |
| P6 | `TransparencyFeature` 同时选择 Packed MBOIT 与 legacy OIT | Packed MBOIT 有 focused Gate；不是全透明路径替换 | `TransparentOitPass` 仍保留 | G5-S 仅覆盖 Packed 范围 | `focused Gate` |
| P7 | `TemporalFeature` 收拢 TAA、Classification、颜色 history、jitter、DRS | YCoCg clip、closest-depth velocity、Catmull-Rom、history lock 等已存在；完整 TAAU/TSR 产品质量未验收 | `TemporalAntiAliasingPass` 和 `TemporalClassificationPass` 仍是内部算法实现 | FX-06A/局部 Q05 evidence | `算法局部修正` |
| P8 | `PostFeature` 收拢 Exposure、Bloom、Color Grading、Sharpen、Tonemap、Motion Blur | 新增基础线性 HDR Color Grading；没有完整 LUT/ACES/HDR 产品 Gate | 具体 `*Pass` 仍持有算法 | 没有独立 P8 执行记录和 G5-P artifact | `边界已接入` |
| P9 | 删除 5 个无 consumer shader | 不代表效果算法完成 | `MaterialExpandPass`、legacy Shadow/OIT、旧 IBL/Indirect 等仍有引用 | 仅 shader audit/引用复检 | `局部清理` |

## 4. 当前真实 owner 与算法实现

Feature 目前主要是深模块边界和生命周期包装，不能仅凭 Feature 类存在判断算法已经重构：

| Feature/Service | 当前实际算法实现 |
|---|---|
| `VisibilityFeature` | `PackedVisibilityPass`、`HierarchicalWorkGenerator` |
| `SurfaceFeature` | `PackedMaterialResolvePass`、Surface ABI v1 |
| `LightingFeature` | `LightClusterPass`、`LightingPass`、`EnvironmentBackgroundPass` |
| `GIService` | `OpaqueLightingPipeline`、`Brick4*`、`LpvIndirectDiffusePass` |
| `ReflectionService` | `ScreenSpaceReflectionsPass`、`SpecularCorrectionPass` |
| `AOService` | `ScreenSpaceAmbientOcclusionPass`、`ssao.ts` |
| `TransparencyFeature` | `PackedTransparentOitPass`、`TransparentOitPass` |
| `TemporalFeature` | `TemporalAntiAliasingPass`、`TemporalClassificationPass`、`DynamicResolutionScaling` |
| `PostFeature` | `AutomaticExposurePass`、`BloomPass`、`ColorGradingPass`、`SharpenPass`、`TonemapPass` |

## 4A. 宏观阶段设计状态

下表是当前执行层级；上面的 P/Q/FX 矩阵是历史证据索引，不是新的实施拆分。

| 阶段 | 设计文档 | 当前状态 |
|---|---|---|
| Stage 0 | [证据基线与合同冻结](./14-stage-0-evidence-and-contract-freeze.md) | 基线候选已采集，clean/full 正式 Gate 未关闭 |
| Stage 1 | [Surface / Opaque HDR 组合边界](./15-stage-1-frame-products-and-composition-seam.md) | 边界已接入；提交 `fcd53d1` |
| Stage 2 | [Lighting / Shadow / GTAO](./16-stage-2-lighting-shadow-and-ao.md) | 待执行 |
| Stage 3 | [Local Probe / SSSR / TAAU](./17-stage-3-reflection-and-temporal-reconstruction.md) | 待执行 |
| Stage 4 | [Transparency / HDR Post / FrameGraph](./18-stage-4-transparency-post-and-framegraph.md) | 待执行 |
| Stage 5 | [Legacy Deletion / Product Closure](./19-stage-5-legacy-deletion-and-product-closure.md) | 待执行 |

因此当前架构事实是“新 owner + 旧/现有算法实现”，而不是“所有算法已被新实现替换”。

## 5. 尚未关闭的产品问题

- `Renderer.ts` 仍是大型 composition root，仍直接持有 legacy Visibility、Material Expand、Velocity、Occlusion 和多个具体效果入口。
- 普通 `Scene` 的 `MaterialExpandPass` / `VelocityPass` 仍有真实 consumer，不能删除；类级删除属于后续 consumer 迁移。
- Packed point/spot shadow、完整软阴影和 Contact Shadow 产品闭环未完成。
- GI、SSR、GTAO 的底层算法仍未按目标参考实现完成整体替换；现有局部 Gate 不代表综合场景画质已解决。
- 最终 TAAU/upscale、透明与不透明 history 的综合稳定性仍需 G5-T。
- Post 只有基础 HDR 组合和 Color Grading，FX-09、融合和最终颜色域 Gate 尚未关闭。
- `ShadowRasterPass`、`TransparentOitPass`、`OpaqueLightingPipeline`、旧 IBL/Indirect consumer 和部分 generated/oracle shader 仍未完成删除判定。
- 目标为 1920×1080、DPR1、60 FPS、整帧 16.667 ms；已有 Hardware Raster `35–44 ms` P50 风险，不能宣称产品性能达成。
- 纹理、全帧 transient、History、Shadow/Probe 和统一显存预算尚未形成最终闭环。

## 6. 当前执行顺序

当前执行入口是 [11-render-pipeline-reconstruction](./11-render-pipeline-reconstruction.md) 路由的六个宏观阶段，而不是继续创建新的 Feature wrapper：

```text
Stage 0 证据基线与合同冻结
  → Stage 1 Surface / Opaque HDR 组合边界
  → Stage 2 Lighting / Shadow / GTAO
  → Stage 3 Local Probe / SSSR / TAAU
  → Stage 4 Transparency / HDR Post / FrameGraph
  → Stage 5 Legacy Deletion / Product Closure
```

每个阶段的详细执行合同见 `implementation/14` 至 `implementation/19`。历史 P/Q/FX 编号只用于追溯旧 artifact，不再代表新的拆分层级。下一阶段任务必须先回答“要替换哪一个真实算法 consumer、删除哪些旧路径、通过什么 GPU/浏览器 Gate”，不能只新增 owner 类或重命名 Pass。

### Stage 0 当前进度（2026-09-04）

Q00 采集器已在当前提交上完成 smoke/full 运行，能够输出图像、运动序列、Feature on/off、
GPU phase/timestamp、counter、FrameGraph、memory 和 provenance。该结果只属于“基线候选”：
工作树受用户已有 `three.js` gitlink 修改影响而为 dirty，且阶段窗口的完成 timestamp 样本不足以
冻结稳定分位数。正式 Stage 0 退出条件仍是提交后的 clean/full 三 session 采集、问题→phase/resource/
domain 映射和可回查 artifact；在此之前不把 Q00 写成产品完成，也不开始用参数掩盖算法问题。

本轮已实际运行 `R5-Q00 full`：`passed=true`、`gateEligible=false`、`issues=[]`。artifact：
`temp/r5-quality/R5-Q00/db9d7a83fcdb93ad9ffae34ffdb8655916531fa4-dirty-6410bce26fa5/desktop-high-full/2026-09-04T07-37-54-924Z/`。
本轮包含 7 组 feature paired run、12 张阶段截图、graph/timings/memory/counter/provenance 和 temporal
sequence；详细数值与真实 owner/问题映射见 [Stage 0 文档](./14-stage-0-evidence-and-contract-freeze.md)。
由于当前提交包含本次文档修改和用户已有的 `three.js` gitlink 修改，artifact 只能作为候选 before evidence。
Stage 0 仍为 `doing`，下一步必须在 clean scope 补采至少两次 full session，并补齐 resize、camera-cut
和六个正式 workload 的完整序列。

### Stage 1 当前进度（2026-09-04）

阶段一按单个纵向切片推进，已将 `SurfaceFrame` 与 `OpaqueLightingFrame` 作为真实 producer
输出产品接入 `FrameProducts`，并加入资源 id、internal-full domain、velocity/depth/metadata
缺失语义校验。`PackedMaterialResolvePass` 现在直接生成 Surface 产品视图，`OpaqueLightingPipeline`
复用统一产品类型；相关构建与 12 项契约/组合测试通过。

该状态仍是“边界已接入”，不是算法完成：GTAO、SSR、TAA、GI 和 Post 的底层 consumer 尚未
整体替换，Renderer 的 legacy 分支仍在，旧路径删除和综合产品 Gate 均未关闭。

## 7. 文档维护规则

- [CURRENT-STATE](../CURRENT-STATE.md) 只写当前源码事实和已保存 artifact；不要把目标合同写成事实。
- [ROADMAP](../ROADMAP.md) 只写依赖和方向；阶段状态链接回本文。
- `implementation/11` 只拥有当前 R5-Q 执行设计；`13` 只拥有产品目标设计。
- `15–21` 是阶段交付记录，必须标明边界、算法和产品 Gate 的差异。
- `00–10` 是早期实施/历史证据。除非任务明确复盘历史，否则不作为当前执行入口。
- 只有在算法、producer/consumer、旧路径删除、正确性、性能、显存和 feature-off 全部满足后，才能把状态提升为 `产品闭环`。
