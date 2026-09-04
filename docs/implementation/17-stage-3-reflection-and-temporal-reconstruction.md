# Stage 3：Local Probe、SSSR 与 TAAU

> 状态：`todo`
>
> 前置条件：Stage 2 的 Opaque HDR、Shadow 和 AO 已通过 focused Gate。Temporal 不得用来掩盖上游黑块、闪烁或错误能量。

## 1. 目标

形成：

```text
OpaqueLightingFrame（已含 IBL specular）
  → SSSR correction
  → CompleteOpaqueHDR
  → FinalTemporalValidity
  → TAAU
```

SSSR 是 specular correction，不是第二套完整间接光；TAAU 是最终重建，不是 AO/SSR 的错误隐藏器。

## 2. 主要源码 owner

| 当前实现 | Stage 3 动作 |
|---|---|
| `ReflectionService.ts` | 成为 Local Probe + SSSR correction 深模块 |
| `ScreenSpaceReflectionsPass.ts` | 重写 trace/resolve/temporal 输入和终止规则 |
| `SpecularCorrectionPass.ts` | 固定 `resolved - baseline` correction |
| `TemporalFeature.ts` | 成为 Opaque/Final validity + TAAU 深模块 |
| `TemporalClassificationPass.ts` | 迁移到统一 validity producer |
| `TemporalAntiAliasingPass.ts` | 重写或替换 resolve implementation |

## 3. Reflection 执行任务

- [ ] S3-01 定义 Local Reflection Probe atlas、box projection、mip、更新和失效；
- [ ] S3-02 Probe 输出稳定 specular baseline，不直接写最终 HDR；
- [ ] S3-03 SSSR 输入改为完整 Opaque HDR、depth、normal、roughness、velocity；
- [ ] S3-04 roughness cutoff 在 trace 前剔除；
- [ ] S3-05 `maxDistanceMeters` 在 march 内真正终止；
- [ ] S3-06 thickness 使用 physical base + distance slope；
- [ ] S3-07 edge confidence 使用 hit UV，并结合 facing/distance/roughness；
- [ ] S3-08 固定 `Trace → Resolve → one spatial → optional temporal → upscale/composite`；
- [ ] S3-09 记录 trace pixels、hit ratio、average/max steps、reject 和 fallback；
- [ ] S3-10 对 FidelityFX SSSR 做许可证、能力和性能评估，决定 port/reimplement/reject；
- [ ] S3-11 删除 SSR final override 和不完整 Scene Radiance consumer。

## 4. Temporal 执行任务

- [ ] S3-12 定义 `OpaqueTemporalValidity` 和 `FinalTemporalValidity`；
- [ ] S3-13 固定 velocity 的像素/UV 域、方向、jitter 和 reverse-Z 语义；
- [ ] S3-14 固定 color、AO、reflection confidence、reactive/disocclusion history；
- [ ] S3-15 实现 bounds、linear-depth、normal/surface identity（按成本选择）的 rejection；
- [ ] S3-16 固定 YCoCg/variance/neighborhood clamp、history lock、reconstruction filter；
- [ ] S3-17 透明 reactive 只进入 FinalTemporalValidity；
- [ ] S3-18 实现 camera cut、scene reload、resize、device resource rebuild 的 history reset；
- [ ] S3-19 DRS 只在固定 resolution buckets 间迁移，并处理 history resample/invalidate；
- [ ] S3-20 删除 jitter double compensation、固定 history blend 和重复 temporal composite。

## 5. 退出 Gate

- Perfect Mirror、Rough Floor、edge、offscreen、backface、long-distance 通过；
- SSR miss、低 confidence、roughness reject 连续回退到 Probe/IBL；
- static jitter、slow/fast pan、disocclusion、moving opaque/transparent、cut、resize、DRS sequence 通过；
- TAAU 输出 output-resolution，且跨域转换显式存在；
- SSR/AO/TAA history 互不污染；
- 关闭 SSR/TAAU 时无无消费者 history、trace 或 resolve 资源。

## 6. 状态记录

```text
状态：todo | doing | focused Gate | 产品闭环
SSR ledger：
Probe artifact：
Temporal artifact：
history reset cases：
SSR/TAA GPU ms：
已删除旧路径：
```
