# R5 Algorithm Guide

R5 原则：优先验证并迁移当前 OEngine 已有实现，只在 correctness/quality/performance 证据表明现实现不满足目标时替换算法。所有外部实现必须按 `OPEN-SOURCE-REUSE.md` 在对应 `references/porting/` ledger 中锁定 source/commit/license/适配差异。

## Reference Matrix

| 领域 | 首选 reference | R5 使用方式 |
|---|---|---|
| glTF material semantics | Khronos glTF 2.0 spec / Sample Viewer | Surface、metallic-roughness、normal、emissive、color-space numeric oracle |
| PBR / IBL | Google Filament PBR documentation/source | BRDF、roughness、light/IBL 语义；提取公式和测试，不复制 Renderer |
| Clustered lighting | Clustered Deferred and Forward Shading + 当前 OEngine LightDatabase | 冻结 cluster/list/overflow；先验证现有 paged database，不为改名重写 |
| CSM | 当前 OEngine CSM + Microsoft CSM/shadow-map guidance | split、stable projection、texel snapping、bias/filter/stability sequence |
| Transparency | 当前 Moment-Based OIT + Moment-Based OIT paper/reference implementation | 保留 MBOIT，迁 Packed work/material owner；容量定义为 transparent work + moments numeric range |
| Temporal AA | Brian Karis TAA + Playdead INSIDE temporal reprojection | neighborhood/reprojection/history rejection 的 authored source baseline |
| Reactive/upscaling seam | FidelityFX FSR2 documentation | 参考 reactive/motion/depth/jitter/internal-output contract；不要求直接移植 FSR2 |
| AO | 当前 SSAO；XeGTAO 作为候选 | 先 revalidate，失败后做 paired replacement benchmark |
| SSR | 当前 SSR；FidelityFX SSSR 作为候选 | 参考 HZB/classification/traversal/denoise；不提前重写 |
| Tonemap/color | 当前 SDR/HDR tonemap + 明确 working/output color contract | 先冻结 linear HDR/exposure/output transform，再评估替换 |

## Source-of-truth Blocking Rules

以下 runtime shader 在对应阶段开始前必须闭环：

- `lighting_ch_oracle.ts`：FX-02 前选择 authored source 或可重复 generator，增加 numeric/visual regression 后迁 pipeline owner。
- `temporal_post_legacy.generated.ts`：FX-06 前登记可重复 generator/source；若无法追溯，按 reference 重写最小 authored Temporal baseline，再替换 runtime owner。
- 其他 `dead/unknown` shader 不允许因为名字可疑直接删除；FX-12 用 build、graph、feature hit 与 source audit 证明。

## R5-01 Surface / Lighting Porting Ledger 必填

- working color space；
- light intensity/attenuation unit；
- normal/tangent convention；
- roughness perceptual/linear semantic；
- Surface ABI decode；
- LightList attempted/written/capacity/overflow；
- per-cluster overflow fallback；
- CPU numeric oracle；
- C-light performance hypothesis。

## R5-02 Shadow Ledger 必填

- cascade count/split；
- reverse-Z/light depth convention；
- stable cascade/texel snapping；
- depth/slope bias；
- alpha-tested caster；
- atlas allocation/lifetime；
- per-cascade work/counter；
- camera sub-texel sequence。

## R5-03 Transparency Ledger 必填

- MBOIT moment formulation/precision；
- transparent work classification；
- raster-state bin upper bound；
- material/texture owner；
- depth/velocity/reactive；
- order-invariance test；
- sorted-alpha quality reference；
- overlap/layer/material sweep。

## R5-04 Temporal Ledger 必填

- motion-vector coordinates；
- jitter convention；
- history color space；
- reactive/disocclusion；
- camera cut/resize/scale revision；
- exposure/pre-exposure；
- internal/output resolution；
- DRS timestamp feedback latency；
- sequence metrics。

## R5-05 AO / R5-06 SSR Ledger

只有当现有实现未通过 R5 tests 或 profile 时才建立 replacement ledger。每次替换必须保留 old/new 同输入 paired artifact，不能仅凭“新算法更现代”合入。
