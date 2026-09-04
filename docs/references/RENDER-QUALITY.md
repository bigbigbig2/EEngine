# 渲染画质参考

当前画质目标是为中大型高密度场景建立高质量 PBR/IBL/CSM、动态灯光、Transparency 和 Temporal/Upscaling 闭环，不建设所有 AAA 内容系统。R5 的详细 reference/adaptation 规则由 [R5-ALGORITHM-GUIDE](./R5-ALGORITHM-GUIDE.md) 拥有。

## 当前参考

| 领域 | 首选参考 | 当前用途 |
|---|---|---|
| Standard PBR / IBL | Filament、Khronos glTF spec/Sample Viewer | metallic-roughness、颜色空间、tangent、BRDF、IBL numeric oracle |
| Clustered lighting | Clustered Deferred and Forward Shading + 当前 OEngine LightDatabase | cluster/list/overflow；先验证现有 owner，不为改名重写 |
| Shadow | 当前 OEngine CSM + Microsoft CSM/shadow-map guidance | cascade split、stable projection、texel snapping、bias/filter、GPU caster work |
| Transparency | 当前 Moment-Based OIT + MBOIT paper/reference | 保留 moments 算法，迁 Packed work/material owner，验证 order invariance/overlap |
| Temporal | Brian Karis TAA + Playdead INSIDE temporal reprojection | reprojection、neighborhood/history rejection、authored source baseline |
| Reactive/Upscaling seam | FidelityFX FSR2 documentation | reactive、motion/depth/jitter、internal/output contract；不要求直接移植 FSR2 |
| AO | 当前 SSAO；XeGTAO 作为候选 | 先 revalidate；只有 quality/perf Gate 失败才 paired replacement |
| SSR | 当前 SSR；FidelityFX SSSR 作为候选 | 先 revalidate；参考 HZB/classification/traversal/denoise |
| Tonemap/color | 当前 OEngine SDR/HDR tonemap + 明确 color contract | linear HDR、exposure、output transform、SDR/HDR capability |

## R5 顺序（方案 B）

```text
R5-00 Contract/Baseline
  ↓
FX-01 Surface
FX-02 Clustered Direct
FX-03 IBL
  ↓ G5-L

FX-04 CSM Shadow
FX-05 Packed MBOIT Transparency
  ↓ G5-S

FX-06A Temporal foundation/DRS contract
FX-07 AO
FX-08 SSR
FX-06B Final TAA/TAAU/Upscale closure
  ↓ G5-T

FX-09 Post
FX-10 Optional effects
FX-11 Evidence-driven fusion
FX-12 Legacy deletion
  ↓ G5-P / R5 CLOSED
```

每个 Gate 的 production browser、自动截图/数值/sequence 预期见 `docs/implementation/R5-BROWSER-GATES.md`；当前阶段状态见 `docs/implementation/STATUS.md`。

## Deferred

R4-C Software/Hybrid Visibility、Virtual Shadow Maps、ReSTIR/Lumen-like GI、terrain/foliage/hair、volumetric cloud/ocean/atmosphere 不属于 R5 core Gate。未来迁移必须复用统一 Depth/HZB/Surface/Velocity/Lighting 和 FrameGraph seam。
