# OEngine Shading Bin Pipeline 最终设计

> 状态：研究与设计输入，不是架构权威。已由 [ADR-0013](../adr/0013-sparse-shading-bin-pipeline.md) 冻结最终决策；若本文与 ADR 不一致，以 ADR 为准。
>
> 目标：直接建设唯一的 **Visibility → GPU Shading Bin → 稀疏 Compute Shading** 主管线。本文不是 A→B→C 演进方案，不保留旧 ABI、旧 shader、旧 pass、旧设备 fallback 或第二条 opaque raster fast path。

## 1. 最终决议

OEngine 的 opaque shading 直接采用以下结构：

```text
GPU Work Generation
        │
        ▼
Hardware Visibility Raster
        ├── Depth
        ├── VisibilityKey r32uint
        └── ShadingBinId r8uint
                  │
                  ▼
       64×64 Macro-tile Classifier
       subgroup → workgroup → global
                  │
                  ▼
       Sparse 8×8 Micro-tile Queues
       + per-bin Indirect Args
                  │
                  ▼
       Specialized Compute Shading
       ├── UnlitFactor
       ├── UnlitTexture
       ├── PBR families
       └── PBR Generic
                  │
                  ├── DirectLightingFrame
                  ├── optional SurfaceLite
                  └── optional Velocity
```

冻结以下决定：

1. 只有一条 opaque production path；没有旧 `MaterialTileWork` fallback，也没有 forward/raster material fast path。
2. `subgroups` 是 Renderer 初始化的硬要求；不支持则在创建 Renderer 资源前失败。
3. 不要求 `subgroup-size-control`，不固定 wave32。唯一 classifier 对规范允许的 subgroup size 正确。
4. 分类单位为 64×64 macro tile，消费单位为 8×8 microtile。
5. 不生成全屏 PixelQueue，不做完整 pixel radix sort。
6. Visibility 同一 raster pass 输出 `VisibilityKey` 与 `ShadingBinId`；classifier 不再逐像素追 Material 表。
7. production 不存在 `pixelClaims`、per-pixel valid/shaded global atomic、claims clear 或全屏 ownership validation。
8. lit program 在 specialized compute kernel 中完成材质解析和 direct lighting；unlit program 不绑定 light/cluster/shadow 资源。
9. 队列由 GPU 生产，并由 `dispatchWorkgroupsIndirect` 直接消费；CPU 不回读可见材质或重建可见工作列表。
10. 迁移是一次切换：新 ABI 和新 FrameProducts 接通后删除旧实现，不设置兼容别名或双写期。

## 2. 为什么当前结构必须整体替换

当前实现已经是 GPU producer → GPU consumer 闭环，但它的工作粒度和 shader 结构仍会让简单近景产生不必要的像素成本：

- `material_tile_classification.ts` 每个有效像素读取 `VisibilityKey`，再访问 `MeshletWork` 和 material record 才得到 dispatch class；近景只改变屏幕覆盖率，却放大了随机读取和逐像素诊断原子。
- `valid_pixel_count`、`shaded_pixel_count` 和 `pixelClaims` 把 production correctness oracle 放进了热路径。
- 现有 `packed_material_compute.ts` 即使处理 unlit，也先读取 position、normal、tangent、vertex color，重建 barycentric/UV，并保留一个动态 `kernel_class` 分支树。
- material resolve 与 lighting 都固定记录 28 次 indirect dispatch；unlit-only 场景仍没有形成最小的着色资源和绑定集合。
- 16-byte tile record 重复携带 class、binding set 和 generation；这些信息本来就由当前 bin 和 frame 生命周期唯一确定。

因此本设计不是“优化几个 atomic”，而是同时改变分类输入、队列 ABI、shader specialization 与 FrameGraph consumer。

## 3. 对新增参考资料的结论

`docs/参考.md` 的核心方向——Nanite 风格的 sparse tile bins，而不是全局 pixel list——是合理的；但不能原样作为实现规格。

### 3.1 可以采用的部分

- 借鉴 Nanite 的 `initialize → classify → finalize → indirect shade` 结构与 tile remap 思路。
- 借鉴 Wicked Engine 的 wave/subgroup 去重、groupshared 聚合、每个 active bin/tile 少量全局提交。
- 从 PlayCanvas OneSweep 中局部移植 subgroup rank/reduction/scatter 的表达方式。
- 沿用 The Forge 与 Bevy 已验证的 visibility attribute reconstruction、perspective-correct barycentric 和 explicit gradient 规则。
- 用 Filament 的编译期材质 specialization 证明 unlit 不应携带 lit shader 的输入与工作。

### 3.2 必须修正的部分

1. **PlayCanvas OneSweep 不是通用 Shading Bin 实现。**它的当前 OneSweep 路径使用 `subgroupBallot(...).x` 与 `1u << subgroup_invocation_id`，显式限制 subgroup size ≤ 32；host 还会对不合适的平台选择 portable multi-pass 路径。OEngine 只借局部 subgroup primitive，不复制完整 decoupled-lookback/OneSweep，也不复制 `.x` ballot 假设。
2. **Kooch 不能移植。**当前仓库许可证为 All Rights Reserved，禁止未经许可的复制、修改和派生；其 scheduler 还是“每个 material dispatch 扫完整 target”。它只能列为被拒绝的对照资料，不能成为代码来源。
3. **MaterialShaderExample 不是 scheduler。**它适合参考 host 侧 material→shading-bin 映射，但 shader 仍依赖 Unreal 私有 Nanite API，并以全尺寸 dispatch 展示接线。
4. **Bevy 当前 material shading 不是目标调度模型。**它的 visibility reconstruction 很有价值，但 material shade node 仍是 CPU 逐材质/fullscreen 工作，不可照搬。
5. **“不要旧设备 fallback”不等于“必须 wave32”。**固定 32 会排除合法的新桌面设备，并使正确性依赖一个非必要能力。唯一生产算法应当 subgroup-width agnostic；这比维护 wave32/portable 两套实现更简单。

## 4. 能力基线

### 4.1 Required

- `core-features-and-limits`
- `indirect-first-instance`
- `float32-blendable`
- `texture-formats-tier1`
- `subgroups`
- `maxStorageBuffersPerShaderStage >= 10`
- `maxStorageTexturesPerShaderStage >= 5`
- 当前 Visibility、纹理与 output profile 已要求的 limits/features

`GraphicsContext` 必须在创建 Renderer、FrameGraph persistent resources 或 pipeline cache 前冻结 feature record。`subgroups` 缺失时返回明确的 `Unsupported OEngine GPU Baseline`，不创建 workgroup-only classifier。

### 4.2 不作为 V1 前提

- `subgroup-size-control`
- 固定 `@subgroup_size(32)`
- 64-bit atomic
- multi-draw-indirect
- buffer device address
- mesh/task shader

Classifier 使用 `@workgroup_size(16, 16, 1)`，共 256 invocations。规范允许的 subgroup size 是 4..128 的 2 次幂时，256 都能整除；算法不读取 `subgroup_id`，也不假定 subgroup lane 与 `local_invocation_id` 的排列。

选择 64×64 而不是继续使用 8×8 classifier，是因为它恰好包含 64 个 8×8 microtiles，可以用两个 `u32` 表达每个 bin 的 macro-local coverage；同时把 uniform near cube 对同一 bin 的 global reservation 从“每个 microtile 一次”降为“每个 macro tile 一次”。256-thread workgroup 和不足 1 KiB 的核心 groupshared 状态仍落在当前 required limits 内。这个常量是首个 production 值，不代表未经测量即可宣称最优；若正式 PERF 失败，应通过 ADR 改写常量，而不是保留并行 backend。

## 5. Shading identity

### 5.1 `ShadingProgramId`

`ShadingProgramId` 为 4 bit，0..15。它不是 material id，而是编译期依赖集合的编号。首版冻结以下 LUT：

| ID | Program | 主要依赖 |
| ---: | --- | --- |
| 0 | `UnlitFactor` | material factor；无 authored vertex color 时不重建 triangle |
| 1 | `UnlitFactorColor` | barycentric、vertex color、factor |
| 2 | `UnlitTexture` | barycentric、UV/gradient、base texture、factor |
| 3 | `UnlitTextureColor` | ID 2 + vertex color |
| 4 | `PbrFactor` | position、normal、PBR factors |
| 5 | `PbrBase` | ID 4 + base texture |
| 6 | `PbrOrm` | ID 4 + ORM texture |
| 7 | `PbrBaseOrm` | ID 4 + base + ORM |
| 8 | `PbrNormal` | ID 4 + tangent + normal texture |
| 9 | `PbrBaseNormal` | ID 8 + base |
| 10 | `PbrOrmNormal` | ID 8 + ORM |
| 11 | `PbrBaseOrmNormal` | ID 8 + base + ORM |
| 12 | `PbrBaseOrmNormalEmissive` | ID 11 + emissive texture |
| 13 | `PbrBaseEmissive` | ID 5 + emissive texture |
| 14 | `PbrOrmNormalEmissive` | ID 10 + emissive texture |
| 15 | `PbrGeneric` | 未命中固定 LUT 的合法 Standard PBR 组合 |

PBR program 保留现有 vertex-color 语义：geometry 有 authored color 时读取并相乘，没有时使用常量白。首版允许这个 geometry-attribute 分支留在 PBR family；unlit 单独分 class，因为简单 unlit 是当前最需要消除重建成本的路径。

`ShadingDependencyMask` 在 material×geometry association 发布时计算一次，至少包含：

```ts
const enum ShadingDependency {
  AuthoredVertexColor = 1 << 0,
  Uv0                 = 1 << 1,
  Normal              = 1 << 2,
  Tangent             = 1 << 3,
  BaseTexture         = 1 << 4,
  OrmTexture          = 1 << 5,
  NormalTexture       = 1 << 6,
  EmissiveTexture     = 1 << 7,
  Lit                 = 1 << 8
}
```

不允许 shader 每像素重新推导 material feature combination。

### 5.2 `ShadingBinId`

```text
bits 0..3  ShadingProgramId
bits 4..5  TextureBindingSetId
0xff       invalid/background sentinel
```

因此：

```ts
ShadingBinId = (TextureBindingSetId << 4) | ShadingProgramId;
```

最多 64 个 bin。无纹理 program 强制 canonicalize 到 `TextureBindingSetId = 0`，避免为同一个 textureless shader 建立重复 bin。

`GpuInstanceAbi` 删除旧 3-bit KernelClass 编码，使用 `packedRasterFlags` 的 bits 8..13 保存 6-bit `ShadingBinId`。GPU work generation 原样复制到 `MeshletWork`。这是 ABI 替换，不保留 `encodeInstanceMaterialKernelClass` 等兼容 API。

### 5.3 Visibility 输出 `ShadingBinId`

Hardware Visibility 同一 raster pass 新增一个 `r8uint` MRT：

```ts
interface VisibilityFrame {
  visibilityKey: ResourceId; // r32uint
  shadingBinId: ResourceId;  // r8uint, clear 0xff
  depth: ResourceId;
  // ...
}
```

Vertex/meshlet work 已知 `ShadingBinId`，以 flat integer varying 传给 fragment；通过 alpha test 且赢得 depth 的同一 fragment 同时写 `VisibilityKey` 和 `ShadingBinId`。这样两者具有完全相同的 sample ownership。

这张 1 B/pixel 图增加一次 raster write 和一次 classifier read，但移除了 classifier 对每个有效像素的 `VisibilityKey → MeshletWork → material` 指针追踪。1080p 的逻辑流量约为 1.98 MiB/write + 1.98 MiB/read；是否存在厂商相关的 attachment 膨胀必须由 GPU timestamp 和资源计数验证。

## 6. Sparse microtile queue ABI

### 6.1 固定常量

```text
Macro tile:        64×64 pixels
Microtile:          8×8 pixels
Microtiles/macro:   8×8 = 64
Classifier WG:     16×16 = 256 invocations
Pixels/invocation:  4×4 = 16
Max bins:          64
```

每个 classifier invocation 处理固定 4×4 block；该 block 永远位于一个 8×8 microtile 内。屏幕边缘使用 guarded load，但所有 invocation 都必须执行 subgroup operations 和 workgroup barriers，禁止提前 return。

### 6.2 Immutable layout

```wgsl
struct ShadingBinLayout {
  record_base: u32,
  capacity: u32,
  revision: u32,
  flags: u32, // ACTIVE
}; // 16 bytes × 64
```

program/set 由当前 bin index 解码，不在 layout 重复存储。owner 是 `GpuRenderWorld` 的 active shading summary。只有 active scene bin 获得 record slice；inactive bin 的 `capacity = 0`。layout 改变时创建新 buffer，并按 submitted-work boundary 退役旧 buffer。

每个 active bin 的容量固定为：

```text
ceil(internalWidth / 8) × ceil(internalHeight / 8)
```

因此在算法无损坏时不会溢出：一个 microtile 对同一个 bin 最多生成一条 record。

### 6.3 Mutable queue state

```wgsl
struct ShadingBinCounter {
  attempted_count: atomic<u32>,
  written_count: atomic<u32>,
  overflow_count: atomic<u32>,
  flags: atomic<u32>,
}; // 16 bytes × 64

struct ShadingBinControl {
  frame_flags: atomic<u32>,
  error_count: atomic<u32>,
  generated_mask_lo: u32,
  generated_mask_hi: u32,
  finalized_generation: u32,
  layout_revision: u32,
  reserved0: u32,
  reserved1: u32,
}; // 32 bytes

struct ShadingBinSettings {
  width: u32,
  height: u32,
  microtiles_x: u32,
  generation: u32,
  allowed_mask_lo: u32,
  allowed_mask_hi: u32,
  max_dispatch_dimension: u32,
  layout_revision: u32,
}; // 32-byte uniform

type ShadingTileRecord = u32; // global 8×8 microtile linear id
```

`ShadingTileRecord` 不重复保存 bin、binding set 或 generation：bin 由 slice/dispatch 唯一确定，generation 属于整个 frame-local queue 生命周期。`ShadingBinSettings` 走现有 frame upload/ring-buffer owner，不放进每帧 clear 的 heap control；classifier、finalizer 和 resolve 绑定同一 dynamic offset。

这些逻辑区域物理合并为一个 `GpuShadingBinHeap`：

```text
[256-aligned control]
[64 × counters]
[64 × immutable layouts]
[dense active-bin records]
```

另有一个独立的 `GpuShadingBinIndirectArgs` buffer，包含 64 组标准 12-byte args，usage 为 `STORAGE | INDIRECT | COPY_DST`。它不能与 heap 合并：resolve compute pass 会同时把 heap 作为可写 storage（仅错误路径写 frame flag）并把 args 用作 indirect input；拆开可避免同一 pass 内 storage-write/indirect usage 冲突。

所有区域 offset 由 `GpuShadingBinAbi` 唯一计算，indirect offset 保持规范对齐。每帧只清 heap 的 control/counters 区间和 args buffer；layout 在当前 revision 内不变，records 不清零。整个 heap 的长度和 storage binding range 必须同时小于 `maxBufferSize` 与 `maxStorageBufferBindingSize`，否则在 resize/summary publish 时明确失败，不偷偷减少容量或切换另一套 queue。

### 6.4 队列合同

| 项 | 定义 |
| --- | --- |
| Producer | `ShadingBinClassify` |
| Consumer | 对应 bin 的 specialized `ShadingResolve` compute pipeline |
| 容量 | active bin 数 × 全屏 microtile 数；每 bin 独立 slice |
| Reserve | 每个 active bin、每个 macro tile 最多一次 bounded CAS reservation |
| Overflow | 不写 OOB；增加 `overflow_count`，置 `frame_flags.INVALID`；finalize 将所有 indirect args 置零 |
| Invalid bin | 若 raster 输出不在 allowed active mask，置 frame invalid，不写 record |
| Generation | settings/control/FrameProduct 必须一致，layout revision 必须匹配；不写入每条 record |
| Production stats | per-bin attempted/written/overflow、generated mask、frame flags；无 consumed/per-pixel claims |

bounded reserve 必须是 all-or-nothing：

1. `attempted += localRecordCount`；
2. CAS 循环只在 `oldWritten + count <= capacity` 时推进 `written`；
3. 失败时 `overflow += count`，不产生任何部分 record；
4. finalizer 验证 `attempted == written + overflow`。

### 6.5 内存上界

只为 active bins 分配 slice：

| Internal resolution | microtiles/bin | 1 bin | 10 bins | 40 bins | 64 bins |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1920×1080 | 32,400 | 126.6 KiB | 1.24 MiB | 4.94 MiB | 7.91 MiB |
| 3840×2160 | 129,600 | 506.3 KiB | 4.94 MiB | 19.78 MiB | 31.64 MiB |

作为对比，现有 1080p、28 class、16-byte record 的 worst-case records 约 13.84 MiB。新 ABI 即使 64 bins 全 active 也更小；简单立方体通常只分配一个 bin slice。

## 7. Classifier 算法

### 7.1 每 lane 的局部工作

每个 lane 读取自己的 4×4 `ShadingBinId` block，得到：

- `localBinMask: vec2<u32>`：16 个像素中出现过哪些 bin；
- `microtileBit: vec2<u32>`：该 lane 所属 microtile 在当前 macro tile 的 64-bit 位置。

无效值 `0xff` 被忽略；0..63 以外的值置 frame invalid。

### 7.2 subgroup 去重

所有 lane 无条件执行：

```wgsl
let subgroupBins = subgroupOr(localBinMask);
```

`subgroupBins` 对 subgroup 内所有 lane 相同。随后 subgroup 在一致的 set-bit 循环中遍历实际出现的 bin，而不是固定循环 64 次：

```text
for each set bit B in subgroupBins:
    laneTileBit = localBinMask contains B ? microtileBit : 0
    subgroupTileMask = subgroupOr(laneTileBit)
    elected lane atomicOr(workgroupBinMicrotileMask[B], subgroupTileMask)
```

关键性质：

- subgroup builtins 位于 subgroup-uniform control flow；
- 不使用 ballot `.x`，64-bit mask 始终表示为两个 `u32`；
- 不依赖 subgroup size、subgroup index 或 lane/local-id 映射；
- uniform near cube 中，一个 subgroup 对一个 bin 只产生最多两个 groupshared OR，而不是每像素 global atomic。

### 7.3 workgroup 聚合与 global reserve

groupshared 状态：

```wgsl
var<workgroup> bin_microtiles: array<atomic<u32>, 128>; // 64 × lo/hi
var<workgroup> bin_record_bases: array<u32, 64>;
```

前 128 个 lane 先清零 `bin_microtiles`，前 64 个 lane 将 `bin_record_bases` 设为 invalid sentinel，然后全组 barrier。聚合完成并再次 barrier 后，由前 64 个 lane 一一负责一个 bin：

1. 读取该 bin 的 64-bit microtile mask；
2. `countOneBits(lo) + countOneBits(hi)`；
3. 若 count > 0，验证 bin active/layout/generation；
4. 对该 bin 做一次 bounded global reserve；
5. 把 reserve base 写入 `bin_record_bases[bin]`。

再次 barrier 后，256 lanes 合作遍历 `64 bins × 64 microtiles`。命中的 `(bin, microtile)` 用 mask 内 prefix popcount 得到唯一 rank，再写：

```text
records[layout.record_base + reserved_base + rank]
    = global_microtile_linear_id
```

不需要 global count→scan→scatter，不需要清 records，不存在 pixel record。

不同 macro tile 的 record append 顺序不稳定，但 consumer 不依赖顺序；可复现截图、identity 和 shading 结果只依赖 record 集合，不依赖 queue 排列。

### 7.4 Finalize

单个 64-lane workgroup 读取全部 counter：

- 验证 overflow、flags、`attempted == written + overflow`；
- 生成 `generatedActiveMask` 并验证其为 `allowedActiveMask` 子集；
- 任一 bin 失败则整个 frame invalid，并将所有 indirect x/y/z 置零；
- 正常时为每个 bin 写 2D indirect grid。

WebGPU 的 `maxComputeWorkgroupsPerDimension` 不能假定大于 65,535。对 `written > maxDim`：

```text
x = min(written, maxDim)
y = ceil(written / x)
z = 1
```

consumer 用 `group_id.y * x + group_id.x` 得到 record index，并对矩形尾部 over-dispatch 做 `index < written` guard。`written == 0` 时写 `(0, 1, 1)`。

## 8. Specialized compute shading

### 8.1 一个 bin 一套静态 shader 语义

每个 active bin 对应一个 pipeline cache entry：

```text
ShadingProgramId
× TextureBindingSetId
× ShadingOutputProfile
× negotiated capability profile
```

`BIN_ID` 是 pipeline override/source constant；不存在每像素 `switch(kernel_class)`。不需要纹理的 program layout 中没有 texture arrays/samplers；unlit layout 中没有 light cluster、shadow atlas 或 PBR BRDF 绑定。

每个 indirect workgroup 消费一条 8×8 microtile record。64 lanes 各处理一个像素：

1. guarded 计算 pixel coordinate；
2. 读取 `ShadingBinId`，不等于当前 bin 立即返回；
3. 读取并验证 `VisibilityKey`；
4. 只按当前 program 的 dependency mask 读取 work/material/geometry；
5. 执行 specialized material + direct shading；
6. 写 HDR，以及当前 FramePlan 真正需要的 SurfaceLite/Velocity。

queue 以 microtile 为粒度，因此 mixed tile 会有 rejected lanes；这是用少量 `r8uint` load 换取不生成全屏 PixelQueue 的有意选择。首版不增加 LoosePixel 队列。

### 8.2 真正的 unlit fast kernel

`UnlitFactor` 且 geometry 无 authored vertex color、FramePlan 不需要 velocity 时：

- 读取 bin、VisibilityKey、MeshletWork 和 material factor；
- 不读取 triangle index/vertex buffer；
- 不计算 barycentric；
- 不读取 normal/tangent/UV/color；
- 不绑定或采样纹理；
- 不读取 light/cluster/shadow/IBL；
- 直接写 pre-exposed unlit radiance/HDR。

若需要 velocity，source specialization 只增加 position/barycentric/matrix 依赖；若有 authored vertex color，路由到 `UnlitFactorColor`，不得静默忽略颜色。

`UnlitTexture*` 保留 perspective-correct UV 和 `textureSampleGrad`；退化梯度使用显式 LOD fallback，并通过 surface flag/低频诊断计数暴露。

### 8.3 lit kernel 与 direct lighting

PBR program 完成一次 surface reconstruction，并在同一 kernel 消费 cluster/light/shadow/IBL 数据，输出 `DirectLightingFrame`。这删除当前第二轮固定 28 次 indirect direct-lighting dispatch，也避免在 color-only profile 中把 SurfaceLite 写回再立刻读回。

当 AO/GI/SSR/debug view 等后续 consumer 需要 surface 时，同一 program 额外发布命名产品；不存在 consumer 时，对应 storage texture、binding、store 和 clear 都不出现。

首版 output profiles：

| Profile | 输出 |
| --- | --- |
| `ColorOnly` | HDR |
| `ColorSurface` | HDR + ShadingSurfaceLite/DiffuseSurfaceLite 中实际有 consumer 的字段 |
| `ColorSurfaceVelocity` | Profile 2 + velocity |

具体字段集合是 shader creation-time specialization，并进入 cache key，不通过热路径 uniform 分支切换。

精确 cache key 使用输出依赖位而不是一个含糊的运行时 quality 枚举：

```ts
const enum ShadingOutputDependency {
  ShadingSurfaceLite = 1 << 0,
  DiffuseSurfaceLite = 1 << 1,
  Velocity           = 1 << 2
}
```

HDR 是所有 opaque shading program 的必有输出，不占 dependency bit。`ColorSurface` 是 `ShadingSurfaceLite` bit；需要 diffuse receiver 数据时再增加 `DiffuseSurfaceLite` bit。这样关闭 SSGI/GI 不会因为共享一个笼统 profile 而保留 diffuse attachment。

### 8.4 背景与未写 Surface

- HDR 由现有 sky/background owner 或一次 render-attachment `loadOp: clear` 初始化；不新增 fullscreen compute clear。
- SurfaceLite consumer 必须先检查同分辨率 `VisibilityKey/ShadingBinId` validity，再读取 surface；无效/background 像素的 SurfaceLite 内容未定义。
- 禁止为了让无 consumer 的 surface 可读而做全屏 texture clear。

### 8.5 FrameProducts 与命令拓扑

旧 `MaterialTileClassificationFrame` 与 `ComputeMaterialEvaluationFrame` 直接删除，替换为：

```ts
interface ShadingBinFrame {
  readonly abiVersion: number;
  readonly heap: ResourceId;
  readonly indirectArgs: ResourceId;
  readonly generation: number;
  readonly activeBinMaskLo: number;
  readonly activeBinMaskHi: number;
  readonly microtileWidth: 8;
  readonly microtileHeight: 8;
  readonly domain: TextureDomain<"internal-full">;
}

interface OpaqueShadingFrame {
  readonly direct: DirectLightingFrame;
  readonly shading: ShadingSurfaceLiteFrame | null;
  readonly diffuse: DiffuseSurfaceLiteFrame | null;
  readonly velocity: ResourceId | null;
}
```

每帧命令顺序固定为：

1. `clearBuffer` 清 heap 的 mutable counters/control 与独立 indirect args；不清 records。
2. 一个 `ShadingBinClassify` compute pass。
3. 一个 `ShadingBinFinalize` compute pass。
4. 一个 `ShadingResolve` compute pass，内部按 active scene bins 切换 pipeline/bind group 并记录 indirect dispatch。

全部工作通过主 `ShadeGPUCommandContext` 编码并随 FrameGraph 单次提交；禁止 classifier、finalizer、readback 或错误处理拥有 private submit。

### 8.6 Binding budget

把 direct lighting 融入 lit program 的前提是仍然满足当前四组、最多 10 个 compute-stage storage buffers 的硬预算。最宽的 `PbrGeneric/ColorSurfaceVelocity` 必须落在以下 envelope 内，简单 program 只删除绑定，不使用 dummy resource 补齐：

| Group | Owner | Sampled textures | Samplers | Storage buffers | Storage textures | Uniform buffers |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 0 | frame/bin/output | 3 | 0 | 1 | 5 | 2 |
| 1 | scene/geometry | 0 | 0 | 4 | 0 | 0 |
| 2 | material/texture set | 9 | 6 | 2 | 0 | 0 |
| 3 | lighting | 4 | 2 | 3 | 0 | 2 |
| **Total** |  | **16** | **8** | **10** | **5** | **4** |

Group 0 的唯一 storage buffer 就是合并后的 `GpuShadingBinHeap`；scene/material/lighting 继续采用现有 `asset-metadata-heap`、`vertex-payload-heap`、`texture-descriptor-routing-heap` 和 `cluster-metadata-heap` consolidation。新 ADR 同步升级 `GpuShadingBindingBudget`，初始化验证 adapter limits，shader tests 验证每个具体 specialization 的实际绑定数。任何实现如果需要第 11 个 storage buffer，必须先重新合并数据或修改能力合同，不能在某些 GPU 上临时拆路径。

## 9. Active shading summary 与 FrameGraph 裁剪

`GpuRenderWorld` 删除 `opaqueKernelClassCounts`、`activeKernelMask` 和 `activeKernelMasksByBindingSet`，替换为唯一 owner：

```ts
interface ActiveShadingSummary {
  readonly binRefCounts: Uint32Array;       // 64
  readonly activeBinMaskLo: number;
  readonly activeBinMaskHi: number;
  readonly opaqueLitReceiverCount: number;
  readonly opaqueUnlitReceiverCount: number;
  readonly transparentLitReceiverCount: number;
  readonly dependencyMask: number;
  readonly revision: number;
}
```

它在 bulk upload、instance add/remove、material patch、geometry/material association 改变时增量维护；renderer 不得每帧扫描对象。更新失败必须与 instance/material patch 同事务回滚。

FrameGraph 规则：

- 没有 opaque bin：不创建 bin layout/counter/records/args，不记录 classifier/finalizer/shading。
- unlit-only 且没有其他 lit consumer：不创建 LightCluster、opaque direct-light resources、shadow sampling bind group；GI/AO/SSR 中只为 lit receiver 存在的工作全部裁剪。
- shadow producer 是否存在由所有真实 shadow consumer 决定，包括 transparency；不能只看 opaque unlit。
- 无 velocity consumer：pipeline layout 和 output resources 均没有 velocity。
- 无 texture program：不创建/绑定 texture sampling group。
- inactive bin 不创建 pipeline，不获得 queue slice，也不记录 indirect dispatch。
- active 但本帧不可见的 bin 保留一次 `dispatchWorkgroupsIndirect(x=0)`；不做 GPU→CPU readback。

透明仍使用其语义所需的 SecondaryRasterWork/透明管线；它不是 opaque shading 的兼容 fallback，也不能接管 opaque material。

## 10. Diagnostics、错误和生命周期

### 10.1 Production

production 只保留会影响安全或最终结果的低频状态：

- per-bin attempted/written/overflow；
- invalid bin/layout/generation/identity；
- generated active mask；
- frame invalid。

这些原子按 bin/macro tile 或只在错误发生时更新，不按成功像素更新。发生 frame invalid 时，finalizer 将 shading args 全部清零，Final Output 显示明确 diagnostic color；不允许部分队列产生貌似正常的错误画面。

### 10.2 Ownership diagnostics variant

exactly-once 仍然是验证 oracle，但不是 production ABI。显式 diagnostics build/pipeline variant 才拥有：

- `pixelClaims`；
- duplicate/unassigned/invalid pixel 计数；
- claims clear；
- full/sampled ownership validation；
- readback。

production shader layout 中完全没有这些 bindings，而不是 `counters_enabled = false` 后保留资源和代码。

### 10.3 Resize、patch 与 device loss

- resize 根据新的 internal dimensions 重建 record slices/indirect state；旧资源在 submitted-work completion 后退役。
- active mask revision 改变时，layout 与 pipeline set 作为一个不可分割版本发布。
- 同一 frame 的 visibility、layout、counter、args、consumer 使用同一 generation/revision。
- device loss 后不得复用任何旧 layout generation 或 pipeline cache entry。

## 11. 代码切换范围

实现完成时应呈现以下最终状态；可以拆提交，但不能在主分支保留双路径：

### 11.1 新增/替换

- `GpuShadingProgramAbi.ts`：ProgramId、DependencyMask、BinId 与 CPU/WGSL oracle。
- `GpuShadingBinAbi.ts`：layout/counter/control/record/indirect ABI。
- `shading_bin_classify.ts`：唯一 subgroup classifier + finalizer。
- `ShadingBinPass.ts`：资源 owner、clear/classify/finalize。
- `shading_programs/*`：按 dependency/output profile 生成的 WGSL modules。
- `ShadingResolvePass.ts`：记录 active bin 的 indirect compute shading。
- `VisibilityFrame.shadingBinId` 与 Visibility MRT producer。
- `ActiveShadingSummary` 及增量 patch/oracle tests。

### 11.2 删除

- `GpuMaterialTileWorkAbi.ts`
- `MaterialTileClassificationPass.ts`
- `ComputeMaterialResolvePass.ts`
- `PackedMaterialResolvePass.ts`
- 现有动态 `packed_material_compute.ts`
- old KernelClass encoding/helpers/counts/masks
- material resolve 的 static dispatch-class uniform buffer
- production `pixelClaims`、claims clear、ownership validate/finalize
- `LightingPass` 中复用旧 MaterialTileWork 的 28 次 direct-lighting dispatch
- 仅服务上述旧路径的 FrameProducts、counters、tests 和文档措辞

内部文件可在实现时合并，但不得保留旧名字的转发 wrapper。`OEngine/src/index.ts` 的公共 API 只有在真实 consumer 需要时才扩展；Shading Bin 内部类型默认不导出。

## 12. 来源采用与移植边界

进入实现后，每个实际采用项必须写入 `docs/porting/`，记录 commit、文件、许可证、保留不变量与 OEngine/WebGPU 差异。

| 来源 | 固定 revision / 文件 | 许可证 | 状态与边界 |
| --- | --- | --- | --- |
| Wicked Engine | [`70ec32c` `visibility_resolveCS.hlsl`](https://github.com/turanszkij/WickedEngine/blob/70ec32cc62f3dadbf796fd5574ff3e34c3c47301/WickedEngine/shaders/visibility_resolveCS.hlsl)、[`visibility_analyzeCS.hlsl`](https://github.com/turanszkij/WickedEngine/blob/70ec32cc62f3dadbf796fd5574ff3e34c3c47301/WickedEngine/shaders/visibility_analyzeCS.hlsl) | MIT | 首选可追溯局部移植参考：wave 去重、groupshared 聚合、tile/bin append；改写为 WGSL 与 64-bin/two-u32 ABI |
| PlayCanvas Engine | [`7b00ca4` OneSweep host](https://github.com/playcanvas/engine/blob/7b00ca4db4bda4c903f4cc727f39b38b43b76aa3/src/scene/graphics/radix-sort/compute-radix-sort-onesweep.js)、[`onesweep-binning.js`](https://github.com/playcanvas/engine/blob/7b00ca4db4bda4c903f4cc727f39b38b43b76aa3/src/scene/shader-lib/wgsl/chunks/radix-sort/onesweep-binning.js) | MIT | 只移植 subgroup local rank/reduction/scatter 表达；拒绝完整 OneSweep/lookback 和 ≤32 ballot 假设 |
| The Forge | [`cd50468` Visibility Buffer](https://github.com/ConfettiFX/The-Forge/blob/cd5046893faba2dc7869243873bf01f02a6f0df9/Examples_3/Visibility_Buffer/src/Visibility_Buffer.cpp)；现有 ledger 已固定 `9d43e691...` shading utilities | Apache-2.0 | 沿用 visibility reconstruction/gradient 算法参考；新增范围另记来源 |
| Bevy | [`96e3bcf` `visibility_buffer_resolve.wesl`](https://github.com/bevyengine/bevy/blob/96e3bcfd87f4cb6372dd9da8b5318f3e64899a01/crates/bevy_pbr/src/meshlet/visibility_buffer_resolve.wesl) | MIT OR Apache-2.0 | WebGPU/WESL 重建交叉验证；不采用 CPU 逐材质 fullscreen scheduler |
| Filament | [`d45158c` `base.mat.in`](https://github.com/google/filament/blob/d45158c6f175726a33b1236858fa3948c5d8dbb5/libs/gltfio/materials/base.mat.in) | Apache-2.0 | unlit 编译期 specialization 的行为参考 |
| MaterialShaderExample | [`ce67da0`](https://github.com/Phyronnaz/MaterialShaderExample/tree/ce67da0ea0c22b760fe44fcb9d1ff068407ccbda) | MIT | host 侧 material→Nanite shading bin 接线参考；不采用 Unreal 私有 API 或 fullscreen dispatch |
| Nanite GPU-driven materials | [Epic 官方公开介绍](https://www.unrealengine.com/blog/take-a-deep-dive-into-nanite-gpu-driven-materials?lang=en) | 非宽松开源代码来源 | 算法/架构参考；不得复制 Unreal shader 表达性源码 |
| Kooch | [`976eab6` LICENSE](https://github.com/lobinuxsoft/kooch/blob/976eab6038f55edc477c42c57e49ed8918190bfe/LICENSE.md) | All Rights Reserved | **拒绝采用**；不复制、不翻译、不派生 WGSL，只记录为何排除 |
| aaaa-rp | [`3479ae0` Visibility Buffer shaders](https://github.com/Delt06/aaaa-rp/tree/3479ae0597814c5074d9da2baa3d5435501599de/ShaderLibrary/VisibilityBuffer) | MIT | reconstruction 数学交叉检查，不作为 scheduler |
| Carrot | [`66cdd89` `material-pass.slang`](https://github.com/jglrxavpok/Carrot/blob/66cdd8932d1bc17da655cc60fcd4762b159cdbd1/engine/resources/shaders/material-pass.slang) | MIT | Slang/Vulkan reconstruction 交叉检查，不移植平台绑定模型 |
| WGSL | [living specification](https://gpuweb.github.io/gpuweb/wgsl/) | 规范 | subgroup uniformity、ballot 128 lanes、`@subgroup_size` 能力与 pipeline creation 规则的权威来源 |

## 13. 验证合同

ADR-0012 生效期间，examples 只是 Storybook 空壳，因此当前只能完成设计和静态/targeted tests，不能宣称 Runtime Validated 或 Performance Improved。正式 PERF 必须等新的真实浏览器宿主落地。

### 13.1 静态与单元测试

- CPU/WGSL `ShadingBinId` encode/decode oracle。
- layout/counter/control offset、stride、byte-length oracle。
- active-bin dense slice layout 与 resize/revision retirement。
- bounded CAS reserve：成功、边界、并发模型、overflow、all-or-nothing。
- 2D indirect grid：0、65,535、65,536、最大合法 tile count。
- material×geometry dependency LUT，包括 vertex color 与全部 texture combinations。
- shader source audit：`UnlitFactor/ColorOnly` 不出现 geometry/texture/light bindings；production 不出现 pixel claims 或 per-pixel global success atomic。
- WGSL compilation/validation 覆盖至少两个不同 subgroup size 的 adapter/实现；算法输出必须一致。

### 13.2 GPU correctness

- 每个 program family 的 factor、vertex color、base/ORM/normal/emissive texture 语义。
- perspective-correct interpolation 与 `textureSampleGrad` 数值/截图 parity。
- macro/microtile 屏幕边缘、mixed bins、empty background、alpha test、double-sided、near-plane。
- active-mask revision、material patch、resize、device loss。
- 故意注入 invalid bin、generation mismatch 和 overflow；必须 fail closed，且没有 OOB write。
- diagnostics variant 捕获 duplicate/unassigned；production capture 中相关资源和 pass 必须不存在。

### 13.3 性能 workloads 与计数器

固定同一 adapter、1920×1080、DPR 1、画质、warm-up、相机和浏览器环境：

1. `BasicCubeNear`：`UnlitFactor/ColorOnly`，大屏幕覆盖。
2. `BasicCubeFar`：仅改变相机距离。
3. `UnlitVertexColor`、`UnlitTextured`：证明语义保留。
4. `MixedBins`：同 macro/microtile 多 program/set。
5. `RenderingLabFixed`：中高几何、纹理、lit/unlit 混合。

GPU timestamps 至少分离：

- Visibility raster（含新增 r8 target）；
- ShadingBin classify；
- finalize；
- 各主要 shading program family；
- light clustering/shadow；
- downstream AO/GI/SSR/temporal/post。

生产计数至少包括：active/generated bins、records/bin、overflow、各 pass 是否被裁剪及原因。microtile occupancy、rejected lanes 与 reservation 次数属于显式 PERF/diagnostics variant，避免为无运行时 consumer 的统计再增加热路径原子。UI/readback 显式启用并低频采样。

正式接受标准：

- `BasicCubeNear` 不再出现随有效像素数增加的 claims/valid/shaded global atomic；classifier 的全局 reserve 上界是“macro tile 中出现的 bin 数”，不是像素数。
- `UnlitFactor/ColorOnly` 图中没有 LightCluster、Shadow、SurfaceLite 或 Velocity 的无 consumer 工作。
- GTX 1650 Ti 作为主要低端门禁，RTX 2060 作为第二 adapter；两者在相同条件下验证，不能用 2060 掩盖 1650 的 bandwidth/atomic 问题。
- 1080p `BasicCubeNear` 的目标是稳定 60 Hz；以 GPU P50/P95 和 present cadence 分开记录，不用自制 FPS 单值替代 GPU 证据。
- `RenderingLabFixed` 不允许通过牺牲 mixed/PBR workload 换取简单立方体成绩；任何回退必须定位到具体 pass、带宽或 occupancy。

## 14. 一次性切换顺序

以下是依赖顺序，不是可长期存在的 A/B/C 阶段；最终合并必须一次切到新主管线：

1. 先落新 ADR、required subgroup baseline、ShadingProgram/Bin ABI 与 CPU oracle。
2. 让 material×geometry association 和 GPU work generation 产生 6-bit bin；Visibility 同时写 `r8uint ShadingBinId`。
3. 接通新 queue layout、classifier、bounded reserve、finalizer 和 indirect tests。
4. 建立真实 specialized programs，先保证所有现有 Standard material 语义由固定 LUT 或 `PbrGeneric` 覆盖。
5. 将 direct lighting 融入 lit programs，并由 output profile 发布现有 downstream 所需 FrameProducts。
6. 接通 active summary、资源/Pass pruning、diagnostics variant 与生命周期。
7. 删除所有旧 MaterialTile/KernelClass/claims/28-dispatch lighting 代码和测试，更新权威文档与 porting ledger。
8. 新浏览器宿主可用后，按 `docs/VALIDATION.md` 完成 1650 Ti + 2060 的正式 PERF gate。

如果任一步尚未闭环，分支可以继续开发，但不能以旧路径 fallback 的方式合并到主分支。

## 15. 不再保留的讨论项

本设计已经替用户做出以下选择，不再作为实现时的可选开关：

- 不做方案 A 的局部修补后再观察；直接替换为 sparse Shading Bin。
- 不做完整 PixelQueue、Pixel Sorting 或 LoosePixel 双队列。
- 不做 opaque raster/forward fast path。
- 不保留 no-subgroup fallback。
- 不固定 wave32，不要求 subgroup-size-control。
- 不保留动态 mega-shader 的 `kernel_class` 分支。
- 不保留 production ownership oracle。
- 不保留旧 ABI、旧名字 wrapper、双写、迁移开关或 compatibility tests。

后续如果真实性能证据要求改变 macro tile 尺寸、增加 loose-pixel consumer 或引入 fixed subgroup size，必须通过新的 ADR 和同条件 benchmark 改写这一设计；不能悄悄增加第二套隐藏路径。
