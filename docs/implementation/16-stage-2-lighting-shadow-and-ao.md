# Stage 2：不透明光照、阴影与 GTAO 算法重构

> 状态：待执行。
> 
> 目的：先修复所有 screen-space 效果的上游输入，建立完整 opaque HDR，再替换 AO 的真实采样、滤波和时域算法。

## 1. 目标帧流

```text
SurfaceFrame + Depth/HZB
  → Clustered Direct Lighting + CSM/Soft Shadow + Contact Shadow
  → GI Provider (Lightmap / Probe Volume / IBL fallback)
  → GTAO Visibility + Bent Normal
  → OpaqueLightingFrame (complete HDR + specular baseline)
```

## 2. 光照与 GI

- 保留 GPU Light Table、cluster list 和 GPU producer→consumer 闭环；每个 list 固定 ABI、容量、overflow、fallback 和计数器。
- Direct、shadow、emissive、diffuse IBL、specular IBL 在同一 Opaque Lighting 深模块内组合，禁止 `Renderer` 多次覆盖同一 HDR。
- GI Provider 采用可独立启用的 `Lightmap → Probe Volume → IBL fallback`；静态场景允许只有 lightmap 或只有 probe，不强制两者同时存在。
- 默认动态灯光影响静态场景的直接光；间接影响只有在对应 lightmap/probe 更新策略和预算成立后启用，不能伪造实时 GI。

## 3. 阴影

- Directional baseline 使用稳定 CSM：split、texel snapping、reverse-Z、slope/depth bias、alpha-tested caster 全部进入同一 shadow contract。
- 默认产生阴影；软阴影和近距离 Contact Shadow 由 Shadow Service 输出独立 visibility，不修改 Material 或 AO。
- Packed point/spot shadow 只有在 atlas 容量、更新频率和 GPU 时间证据成立后接入，不为缺失能力保留空 Pass。

## 4. GTAO 2.0

- 半径和 falloff 通过 `PhysicalScaleContract` 以米表达，再转换为 world/view space。
- 原始采样使用 linear/view depth，并按屏幕半径选择 depth/HZB mip；禁止直接比较 reverse-Z device depth。
- 默认 half-resolution，depth/normal-aware spatial filter 和 joint bilateral upsample；visibility、bent normal、Material AO 三者独立。
- Temporal blend 必须真正消费 velocity、history confidence、disocclusion 和 surface validity；快速运动不能固定高权重保留旧 history。
- AO 只输出 `AmbientOcclusionFrame`，由 lighting policy 组合 diffuse/specular visibility，不直接乘最终 HDR。

## 5. 开源参考与迁移

- PBR/BRDF/IBL：Filament 文档与源码，公式先建立 CPU numeric oracle。
- CSM：当前 OEngine CSM 与已登记 Microsoft guidance 对照，保留 reverse-Z 和稳定投影不变量。
- AO：先以当前 SSAO 做 paired baseline；若未通过质量/性能 Gate，再按 `XeGTAO` 建立可追溯移植记录。不得删掉关键步骤做“简化版”。

## 6. 实施顺序

1. 先完成完整 Opaque Lighting 输入/输出和颜色、单位合同。
2. 合并 direct/IBL/indirect composition，移除重复全屏 HDR 写入。
3. 完成 CSM、软阴影、Contact Shadow 的统一 owner 和计数器。
4. 替换 GTAO raw、filter、upsample、temporal 四段真实 shader consumer。
5. 以 paired 场景验证，再删除被替代的 SSAO composite 和旧 AO history 路径。

## 7. 退出条件

- 完整 opaque HDR 在 SSR 前可消费；
- AO 不再写回 `albedoAo.a`；
- AO 快速运动、遮挡边缘、薄几何和大尺度场景通过序列回归；
- 阴影默认可见，CSM/Contact/软阴影有 GPU timing 和容量证据；
- 旧 AO/重复 Lighting consumer 已删除或有明确同一提交的删除清单；
- feature-off 接近零成本。

