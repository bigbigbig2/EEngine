# R5-00 · Surface ABI v1 Freeze

## Reference ID

`R5-00-SURFACE-ABI-V1`

## Upstream / license

无外部代码移植。本任务冻结 OEngine R4-B 已投入 production 的 Packed Material Resolve / Velocity / debug/counter 语义；外部 Lighting/Temporal 算法参考继续由 `R5-ALGORITHM-GUIDE.md` 与 FX-02/FX-06 ledger 管理。

## Source / tests

```text
OEngine/src/gpu/GpuSurfaceAbi.ts
OEngine/src/render/passes/PackedMaterialResolvePass.ts
OEngine/src/render/passes/PackedSurfaceCounterPass.ts
OEngine/src/shaders/packed_material_resolve.ts
OEngine/src/shaders/render_debug_view.ts
OEngine/src/shaders/velocity.ts
OEngine/tests/r5-surface-contract.test.mjs
OEngine/tests/packed-material-resolve.test.mjs
OEngine/tests/render-debug-view.test.mjs
```

## Algorithm scope

这里只冻结 resolved Surface 的 storage/metadata/velocity contract，不修改 BRDF、Lighting、IBL、Shadow、Temporal 或 Post 算法。

## Input / output ABI

```text
VisibilityKey + Depth + Geometry/Instance/Material
→ one Packed Material Resolve fullscreen draw
→ PBR rg8unorm
→ Normal rgba16uint
→ Albedo/AO rgba8unorm
→ Emissive RGB9E5 in r32uint
→ Velocity rg16float
→ Metadata r32uint
```

Metadata v1：

```text
bits  0..15  resident MaterialRecord slot
bits 16..31  SurfaceFlags

flag 0 Valid
flag 1 MotionValid
flag 2 Reactive
flag 3 GradientFallback
flag 4 NormalTexture
flag 5 OrmTexture
flag 6 EmissiveTexture
flag 7 Unlit
flag 8..15 reserved = 0 for v1 producers
```

## Retained invariants

- Packed Resolve 仍为一个 fullscreen draw，active material count 只影响数据。
- resolved Surface 仍为 `26 B/pixel`，不增加 attachment bandwidth。
- current material residency capacity `4096` 必须能被 16-bit material slot 无损表示。
- empty metadata 为 `0`；有效 Surface 必须设置 `Valid`。
- Velocity 使用 internal pixel，方向为 `current - previous`。
- previous homogeneous 与 previous clip 都只有 `w > epsilon` 才可透视除法；非正 `w` 必须判为 motion invalid。
- motion invalid 时固定输出 zero velocity，并设置 `Reactive`、清除 `MotionValid`。
- v1 producer 不得写 reserved flag bits。

## WebGPU adaptation

Metadata 保持 `r32uint` color attachment，不切换为 `rg16uint`，避免为纯逻辑 ABI 重排引入额外 render-target capability/performance 变量。16/16 packing 为未来 Temporal/quality flags 预留 8 个未定义位，同时不改变每像素字节数。

## Precision / semantic differences

本任务不改变现有 Surface 数值编码。唯一 binary-incompatible 变化是 metadata 从旧 `material low24 + flags high8` 重排为 `material low16 + flags high16`；所有 production consumer 必须在同一提交切换到 `GpuSurfaceAbi.ts` 生成的 TS/WGSL truth source。

## Performance hypothesis / benchmark

预期 GPU phase 时间与显存带宽无实质变化，因为 attachment 数、格式和 Resolve draw count 不变。R5-00 clean A/B/C baseline 只允许无关回归阈值内波动，并保存同设备 P50/P95/P99；不能跨 GPU 计算百分比。

## Fallback / failure

- CPU pack 超出 `u16 materialSlot`、超出 `u16 flags` 或写 reserved v1 flags：立即抛错，不截断。
- GPU production slot 当前由 4096-capacity residency owner 保证小于 65536。未来若容量超过 65536，必须升级 Surface ABI，而不是 mask。
- motion 无效：fail-open 到 zero velocity + Reactive。
- Reactive v1 采用 producer OR：Resolve 拥有 invalid motion/gradient fallback，FX-05 拥有 transparent contribution，FX-06 拥有 disocclusion/LOD classification；re-residency 在 affected-pixel marker 完成前使用一次性 history revision invalidation。

## Decision

`reimplement/freeze`。

理由：R4-B 已证明 Surface producer 可用，但旧 metadata 8-bit flags 已无扩展空间，且 Resolve/Counter/Debug 分散手写 magic packing。R5-00 在 Temporal/Lighting 继续扩展前先建立单一 ABI owner。
