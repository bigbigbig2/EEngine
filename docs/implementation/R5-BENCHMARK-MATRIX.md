# R5 Benchmark Matrix

本文冻结 R5 的 benchmark 角色、扩展轴和性能统计方法。A/B/C 仍是同一 OEngine unified Renderer 的三个基础角色，不新增 benchmark 专用 Renderer。

## 1. 基础角色

| Case | 角色 | R5 用途 |
|---|---|---|
| A | 160k Teapot geometry/visibility minimum | 防止 R5 feature 对 GPU-driven core 引入无关固定成本 |
| B | Damaged Helmet PBR/IBL minimum | PBR/IBL、Surface、Resolve、基础 Lighting 的最低垂直基线 |
| C | heterogeneous Packed world | R5 integration 与 lights/shadow/transparency/temporal 扩展轴 |

R5 base manifest 只列实际运行的 feature。`software-visibility` 属于 optional R4-C，不得为了未来能力留在 A/B/C base featureSet 中导致 R5 artifact 永久 `capabilityComplete=false`。将来 R4-C 打开时使用独立 `A-hybrid/B-hybrid` variant，不修改 R5 base role。

## 2. B-shading-oracle

用途：把 shading correctness 与 15,625 instance 的 LOD/work-generation 差异拆开。

固定：
- 1 个 Damaged Helmet；
- fixed LOD/pose/camera；
- 同一 linear HDR environment；
- fixed exposure；
- Shadow/AO/SSR/Temporal/Bloom off；
- Packed Visibility + Single Resolve + Direct/IBL only。

输出：
- Surface debug；
- direct HDR；
- diffuse IBL；
- specular IBL；
- final linear HDR；
- tonemapped screenshot。

Reference environment 可离线转换，但 source/result hash 与工具版本必须进入 artifact。

## 3. C-light

Light count：

```text
0 / 1 / 16 / 64 / 256 / 1024
```

布局：
- `spread`：灯分散，平均每 cluster 较低；
- `overlap`：灯集中覆盖中心区域，制造 worst-case overlap。

记录：
- active/tested/written；
- avg/P95/max lights per cluster；
- overflow clusters；
- fallback lights；
- light-cluster GPU；
- direct-lighting GPU；
- resident/transient bytes。

## 4. C-shadow

扩展轴：
- cascade count；
- caster RasterWork；
- alpha-tested caster ratio；
- shadow view update count；
- atlas occupancy/resolution；
- camera motion/stability sequence。

GPU phase 必须拆：
`shadow-work-generation / shadow-raster / shadow-filter-or-sampling`。

## 5. C-transparent

扩展轴：
- transparent coverage：0 / 10 / 50%；
- depth layers：1 / 4 / 8 / 16；
- active materials：1 / 8 / 64。

记录：
- TransparentRasterWork；
- moment pass；
- forward pass；
- composite；
- raster-state bins/draw count；
- transient bytes；
- reactive pixels。

关键 scaling Gate：active materials 增长不得恢复近似 `materials × draw/pass`。

## 6. C-temporal / C-resolution

序列：
- static；
- slow/fast camera；
- object motion；
- disocclusion；
- alpha/transparent motion；
- LOD transition；
- cut；
- resize；
- scale transition。

Internal scale：

```text
1.00 / 0.85 / 0.67 / 0.50
```

记录：
- internal/output pixels；
- history bytes；
- reactive/disoccluded/history-reject pixels；
- temporal GPU；
- total GPU；
- settling frames；
- ghosting notes/sequence captures。

## 7. 性能统计

每个性能任务同时报告：

### Absolute
- CPU/GPU P50/P95/P99；
- pass 原始 `gpuMs`；
- logical phase `gpuPhaseMs`。

### Incremental
同 commit、同 GPU、同 scene：

```text
feature cost = feature-on - feature-off
```

禁止用半年以前另一台 GPU 的绝对值计算新 feature 增量。

### Normalized
- lighting：`ms / 1M shaded pixels`、light indices written；
- shadow：`ms / 1M caster triangles`、atlas pixels updated；
- transparency：`ms / 1M transparent covered pixels`；
- temporal/post：`ms / output MP` 与 `ms / internal MP`。

## 8. Resolution profiles

历史回归 profile：

```text
1280×720
DPR 1
```

产品质量 profile：

```text
1920×1080 output
DPR 1
```

Temporal/DRS 使用产品输出 profile + internal scale sweep。

## 9. 初始回归策略

在同设备/同浏览器/同画质下：
- 不相关场景 P50 > 3% 或 P95 > 5% 回退：阻塞并解释；
- validation/uncaptured/device lost/submit/readback/overflow contract：exact gate；
- 新画质 feature 必须有 off baseline 和 on 增量；
- 只在 `performance-targets.json` 已填写目标机器绝对值后，才允许声称达到最终性能目标。

这些百分比是回归报警线，不是最终产品帧预算；最终绝对数字由目标机器采样后冻结。
