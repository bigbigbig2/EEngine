# Stage 3：Local Probe、SSSR 与 TAAU

> 状态：`doing`
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

- [~] S3-01 定义 Local Reflection Probe atlas、box projection、mip、更新和失效；当前 LightProbeAtlas/LPV 仅覆盖 Probe Volume，尚无独立 Local Reflection Probe 的 box-projected specular producer；
- [~] S3-02 Probe 输出稳定 specular baseline，不直接写最终 HDR；现有 IBL/LPV baseline 满足不写最终 HDR，但 Local Reflection Probe baseline 尚未接入；
- [x] S3-03 SSSR 输入改为完整 Opaque HDR、depth、normal、roughness、velocity；
- [x] S3-04 roughness cutoff 在 trace 前剔除；
- [x] S3-05 `maxDistanceMeters` 在 march 内真正终止；
- [x] S3-06 thickness 使用 physical base + distance slope；
- [x] S3-07 edge confidence 使用 hit UV，并结合 facing/distance/roughness；
- [x] S3-08 固定 `Trace → Resolve → one spatial → optional temporal → upscale/composite`；
- [x] S3-09 记录 trace pixels、hit ratio、average/max steps、reject 和 fallback；GPU counter ABI 已提供 trace/hit/steps/max/reject/roughness/distance 字段；
- [x] S3-10 对 FidelityFX SSSR 做许可证、能力和性能评估，决定 port/reimplement/reject；R5-06 决策为保留 OEngine authored，未复制 FidelityFX SSSR；
- [x] S3-11 删除 SSR final override 和不完整 Scene Radiance consumer；SSR 只从完整 opaque HDR 做 correction，不再拥有 final override。

## 4. Temporal 执行任务

- [x] S3-12 定义 `OpaqueTemporalValidity` 和 `FinalTemporalValidity`；
- [x] S3-13 固定 velocity 的像素/UV 域、方向、jitter 和 reverse-Z 语义；
- [x] S3-14 固定 color、AO、reflection confidence、reactive/disocclusion history；
- [x] S3-15 实现 bounds、linear-depth、normal/surface identity（按成本选择）的 rejection；
- [x] S3-16 固定 YCoCg/variance/neighborhood clamp、history lock、reconstruction filter；
- [x] S3-17 透明 reactive 只进入 FinalTemporalValidity；
- [x] S3-18 实现 camera cut、scene reload、resize、device resource rebuild 的 history reset；
- [x] S3-19 DRS 只在固定 resolution buckets 间迁移，并处理 history resample/invalidate；
- [x] S3-20 删除 jitter double compensation、固定 history blend 和重复 temporal composite。

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

## 7. 2026-09-04 执行记录

本轮完成 Stage 3 已存在实现的真实调用和算法收敛检查，并修正 SSR 命中置信度：

- `ScreenSpaceReflectionsPass` 继续从完整 `Opaque HDR`、Surface normal/roughness、depth/HZB、velocity 接收输入；roughness 在 march 前拒绝，max distance 在层级 march 内终止；
- hit confidence 现在由 `edge × facing/thickness × distance × roughness` 连续组合，远距离、掠射角和高粗糙度命中回退到稳定 baseline，而不是覆盖 Probe/IBL；
- SSR evidence 明确记录 trace/hit/steps/max/reject/roughness/distance 计数；
- `TemporalFeature`、`TemporalHistoryRegistry`、`TemporalClassificationPass` 和 `TemporalAntiAliasingPass` 已覆盖 opaque/final validity、closest-depth velocity、reactive/disocclusion、YCoCg variance clip、history lock、camera cut/resize/DRS reset；
- 旧 SSR final override 和不完整 Scene Radiance consumer 未出现在生产路径；
- S3-01/S3-02 暂不勾选：当前仓库只有 LPV/LightProbeAtlas（Probe Volume）实现，没有独立 Local Reflection Probe 的 box-projection specular producer，因此不能把 LPV 冒充 Local Probe。

验证：`npm run typecheck`、`npm run audit:shaders`、`npm test`（373/373）和 Stage 3 定向静态/合同测试均通过。本轮按要求未运行浏览器或截图 runner；因此退出 Gate 的画质、DRS sweep、GPU timestamp/memory artifact 仍保持 focused Gate。
