# ADR-0013 · Sparse Shading Bin 与 Specialized Compute Shading

> **Status:** accepted；implementation open
> **Date:** 2026-09-13
> **Scope:** Opaque Visibility shading identity、GPU Shading Bin classifier、queue ABI、specialized compute material/direct lighting、active summary、diagnostics 与 feature-off
> **Depends on:** [ADR-0007](./0007-gpu-native-runtime-assets-and-residency-v2.md) 的 `TextureBindingSet`；[ADR-0008](./0008-gpu-driven-geometry-and-visibility-v2.md) 的 `MeshletWork`/VisibilityKey V2；[ADR-0010](./0010-webgpu-2026-capability-contract.md) 的 WebGPU 2026 Desktop 能力模型
> **Supersedes:** ADR-0009 §3 Material Classification V2、§4 中旧 28-class binding/dispatch 合同、§5 中独立 Material Resolve 后再固定 28 次 direct-lighting dispatch 的物理实现，以及相关 completion criteria；ADR-0008 §6.3 的“classifier 优先逐像素由 MeshletWork→material 恢复 class”实现选择；ADR-0010 对 opaque shading 节点将 `subgroups` 视为可选 accelerator 的口径
> **Preserves:** ADR-0008 的 32-bit VisibilityKey V2、Hardware Visibility 与 MeshletWork identity；ADR-0009 的单次完整材质求值、Surface/HDR/PreExposure、GI/AO/SSR/Temporal/Post 语义；ADR-0004 禁止恢复全屏 Pixel Queue/ShadeWork 的决定
> **Design input:** [OEngine Shading Bin Pipeline 最终设计](../others/2026-09-13-material-tile-shading-optimization-design.md)

## Context

OEngine 当前 production opaque shading 已经形成 GPU producer → GPU consumer 闭环：8×8 `MaterialTileWork` classifier 生成 7 个 `KernelClassId × 4 TextureBindingSetId` 的 28 组 queue/indirect args，compute material evaluator 完整解析材质，第二个 compute consumer 再执行 direct lighting。该实现证明了 Visibility-driven compute shading 的正确方向，但其具体物理结构仍有以下固定成本：

```text
VisibilityKey
    ↓ per valid pixel
MeshletWork
    ↓ per valid pixel
Material record → KernelClassId × TextureBindingSetId
    ↓
8×8 MaterialTileWork
    ↓ 28 indirect material calls
dynamic kernel_class mega-shader
    ↓ compact SurfaceLite
    ↓ 28 indirect direct-lighting calls
HDR
```

当前 classifier 对每个有效像素执行 identity/material pointer chasing，并在 production 热路径维护 `valid_pixel_count`。材质 evaluator 又为每个有效像素维护 `pixelClaims`、shaded/duplicate/unassigned 等 ownership oracle。相机靠近、简单物体覆盖更多屏幕像素时，这些工作会随 coverage 增长；它们并不代表场景或材质复杂度增长。

现有 material shader 也不是真正的编译期 specialization。即使 material 为 unlit，shader 仍会先恢复 triangle、读取 position/normal/tangent/color、计算 barycentric/UV 相关状态，再通过动态 `kernel_class`/material flag 分支决定最终结果。关闭 AO、SSR、GI 等高级效果不会自动删除这些材质热路径工作。

开发阶段截图、任务管理器 GPU 利用率与非正式 FPS 只能说明问题值得调查，不能作为 formal PERF 证据；ADR-0012 生效期间仓库没有真实 browser/PERF host。本 ADR 因而只冻结新的生产结构、ABI 和验证门禁，不宣称当前 revision 已经改善性能。

相关公开实现与规范给出一致方向：

- Nanite GPU-driven materials 使用 material/shading bin 与 indirect shading 的架构；Unreal 表达性 shader 不是可复制的宽松许可证来源。
- Wicked Engine 的 MIT shader 展示 wave 去重、groupshared 聚合和按 tile/bin 追加工作。
- PlayCanvas OneSweep 的 MIT WGSL 提供 subgroup rank/reduction/scatter 参考，但其实现使用 ≤32-lane 假设和平台 fallback，不能整体照搬。
- The Forge/Bevy 可继续作为 visibility reconstruction 与 explicit derivative 的已登记参考。
- Filament 展示 compile-time unlit specialization 如何删除 lit-only 输入与计算。
- Kooch 虽有 WGSL visibility/material compute 示例，但许可证为 All Rights Reserved，且 scheduler 会让每个 material 扫完整 target，因此明确拒绝采用。

需要解决的问题不是把当前每像素 atomic 改为稍少的 atomic，而是让生产成本满足：

```text
classification synchronization ∝ active bins per macro tile
shading work                ∝ microtiles containing that bin
material/lighting work      ∝ statically declared dependencies
disabled feature work       → zero owner / zero resource / zero dispatch
```

## Decision

### 1. 唯一主管线与切换边界

Opaque production pipeline 直接切换为：

```text
GPU Work Generation
        ↓
Hardware Visibility Raster
        ├── reverse-Z Depth
        ├── VisibilityKey r32uint
        └── ShadingBinId r8uint
                    ↓
          64×64 Macro Classifier
          subgroup → workgroup → global
                    ↓
          Sparse 8×8 Microtile Queues
          + GPU-authored Indirect Args
                    ↓
          Specialized Compute Shading
          ├── material evaluation once
          ├── direct lighting for lit programs
          ├── emissive/unlit
          ├── HDR/PreExposure
          └── demanded Surface/Velocity products
```

以下不是合法 production fallback：

- 旧 `MaterialTileWork`/KernelClass mega-shader；
- active-class fullscreen material resolve；
- opaque forward/raster material fast path；
- full-screen PixelQueue、pixel radix sort 或旧 ShadeWork；
- CPU readback 可见 material/bin count 后重建 dispatch list；
- no-subgroup workgroup-only classifier。

开发可拆为多个提交，但最终 consumer cutover 必须一次完成。合并后的主分支不保留旧 ABI alias、转发 wrapper、双写、runtime migration switch 或 compatibility tests。

Transparency 继续使用其独立语义所需的 SecondaryRasterWork/OIT 管线；它不是 opaque fallback，也不得接管 opaque material。

### 2. WebGPU 2026 Desktop 硬能力合同

Opaque shading owner 创建前必须满足：

```text
device feature:
  core-features-and-limits
  subgroups
  texture-formats-tier1
  现有主管线要求的其他 feature closure

device limits:
  maxComputeInvocationsPerWorkgroup >= 256
  maxComputeWorkgroupSizeX >= 16
  maxComputeWorkgroupSizeY >= 16
  maxComputeWorkgroupStorageSize >= classifier declared bytes
  maxStorageBuffersPerShaderStage >= 10
  maxStorageTexturesPerShaderStage >= 5
  maxSampledTexturesPerShaderStage >= 16
  maxSamplersPerShaderStage >= 8
  maxBindGroups >= 4
```

Adapter 缺少 `subgroups` 或 required limit 时，在创建 Renderer-owned buffer/texture/pipeline 前返回 `Unsupported OEngine GPU Performance Baseline`。不创建 portable classifier，也不把失败推迟到 shader compilation。

Classifier module 必须以 `enable subgroups;` 开头。V1 不请求 `subgroup-size-control`，不生成 `@subgroup_size(32)`，不假定 wave32/wave64。算法必须覆盖 adapter 报告的 `subgroupMinSize..subgroupMaxSize`。

`@workgroup_size(16, 16, 1)` 共 256 invocations，能够整除规范范围内 4..128 的 2 次幂 subgroup size。算法不读取 `subgroup_id`，也不假定 subgroup invocation 与 `local_invocation_id` 的空间排列。

本 ADR 不引入以下非基线能力：

- 64-bit atomic；
- multi-draw-indirect；
- mesh/task shader；
- buffer device address；
- 通用 bindless/sized binding arrays。

最终 capability record、pipeline cache key 与 benchmark provenance 必须记录 `subgroups`、subgroup size range、required/actual limits、texture format features 和 shading specialization identity。

### 3. Shading identity

#### 3.1 `ShadingProgramId`

`ShadingProgramId` 是 4-bit 编译期依赖类，不是 material id。V1 固定 16 个 program slots：

| ID | Program | 必需 shading dependencies |
| ---: | --- | --- |
| 0 | `UnlitFactor` | material factor |
| 1 | `UnlitFactorColor` | triangle/barycentric、authored vertex color、factor |
| 2 | `UnlitTexture` | triangle/barycentric、UV/gradient、base texture、factor |
| 3 | `UnlitTextureColor` | ID 2 + authored vertex color |
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
| 15 | `PbrGeneric` | 其他合法 Standard PBR combination |

Material × geometry association 发布时计算 immutable `ShadingDependencyMask`：

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

Versioned CPU/WGSL LUT 将 dependency combination 唯一映射到 program。未被固定 family 捕获但仍属于合法 Standard PBR 的组合进入 `PbrGeneric`；不受支持的 shading model 在 material publication 前失败，不得静默忽略 feature。

PBR programs 保留现有 vertex-color 语义：geometry 有 authored color 时读取并相乘，没有时使用常量白。V1 允许该 geometry-attribute branch 留在 PBR family；unlit 则明确拆分 color/no-color，因为它决定是否可以完全跳过 triangle reconstruction。

#### 3.2 `ShadingBinId`

`TextureBindingSet` 上限继续由 ADR-0007 冻结为 4。Bin 编码：

```text
bits 0..3  ShadingProgramId
bits 4..5  TextureBindingSetId
bits 6..7  must be zero
0xff       invalid/background sentinel
```

```ts
ShadingBinId = (TextureBindingSetId << 4) | ShadingProgramId;
```

合法范围为 0..63。Textureless program 必须 canonicalize 到 `TextureBindingSetId = 0`，避免同一 shader 产生四个重复 bin。

`GpuInstanceAbi` 删除旧 3-bit MaterialKernelClass，使用 `packedRasterFlags[13:8]` 保存 6-bit bin。GPU work generation 将它复制到 `MeshletWork.packedRasterFlags[13:8]`。这些 bits 不改变 VisibilityKey V2 的 24-bit work slot + 8-bit local primitive 物理布局。

Material patch、geometry/material association 改变、TextureBindingSet relocation 或 dependency class 改变，必须在同一事务中更新 instance bin、active summary 与相关 GPU records；任何一步失败则全部回滚。

### 4. Visibility 输出 `ShadingBinId`

`VisibilityFrame` 增加必有的 `shadingBinId`：

```ts
interface VisibilityFrame {
  readonly visibilityKey: ResourceId; // r32uint
  readonly shadingBinId: ResourceId;  // r8uint
  readonly depth: ResourceId;
  readonly meshletWork: MeshletWorkFrame;
  readonly triangleSetup: TriangleSetupFrame;
  readonly domain: TextureDomain<"internal-full">;
}
```

物理合同：

- format：`r8uint`；
- usage：`RENDER_ATTACHMENT | TEXTURE_BINDING`；
- sample count：1；
- render-pass clear：`0xff`；
- valid fragment：只写 0..63；
- background、discarded MASK sample、未通过 depth sample：保留 `0xff`。

Meshlet visibility vertex stage 从 work flags 恢复 bin，并通过 flat integer varying 传到 fragment。赢得同一次 depth test 的 fragment 同时写 `VisibilityKey` 与 `ShadingBinId`，两张 texture 必须具有相同 extent、sample ownership、generation 和 FrameGraph lifetime。

Classifier 只读取 `ShadingBinId`，不再为分类逐像素读取 `VisibilityKey`、MeshletWork 和 Material table。Shading consumer 仍在实际命中的 lane 中读取 VisibilityKey 恢复精确 geometry/material identity。

1080p `r8uint` 的逻辑大小约 1.98 MiB。增加该 MRT 的 raster write 与 classifier read，换取删除 classifier 的 4 B/pixel VisibilityKey read 和后续随机 pointer chasing。该交换是本 ADR 决定的一部分，但性能收益必须在目标 adapter 实测；不能只按格式字节数宣称改善。

### 5. Macro/microtile 拓扑

V1 固定：

```text
macro tile                 64×64 pixels
microtile                   8×8 pixels
microtiles per macro        8×8 = 64
classifier workgroup       16×16 = 256 invocations
pixels per invocation        4×4 = 16
max bins                    64
```

每个 invocation 的 4×4 block 总是完整落在一个 8×8 microtile 内。屏幕边缘通过 guarded `textureLoad` 产生 invalid sentinel；任何 invocation 都不得在 subgroup operation 或 workgroup barrier 前提前 return。

选择 64×64 的理由：

- 64 个 microtiles 可由两个 `u32` 精确表达 coverage；
- uniform 大面积表面从每个 8×8 tile 一次 global append 降为每个 64×64 macro/bin 一次 reserve；
- 核心 groupshared state 小于 1 KiB；
- 256 invocations 落在 required compute limit 内，并能完整容纳规范 subgroup size。

64×64 是唯一 V1 production value，不同时保留 32×32/8×8 backend。若后续 PERF 证明 register pressure、occupancy 或 16-load/lane 不合格，以新 ADR 改写该常量和 ABI；不增加 runtime quality switch。

### 6. Shading Bin ABI

所有 offset、stride、capacity 与 CPU/WGSL oracle 由 `GpuShadingBinAbi.ts` 单一拥有。

#### 6.1 Constants

```text
ABI_VERSION                    1
BIN_COUNT                     64
INVALID_BIN_ID              0xff
MACRO_WIDTH/HEIGHT             64
MICROTILE_WIDTH/HEIGHT          8
COUNTER_STRIDE                 16 B
LAYOUT_STRIDE                  16 B
CONTROL_STRIDE                 32 B
RECORD_STRIDE                   4 B
INDIRECT_STRIDE                12 B
SETTINGS_STRIDE                32 B logical / 256 B dynamic allocation stride
```

#### 6.2 Frame settings

```wgsl
struct ShadingBinSettings {
  width: u32,                  // +0
  height: u32,                 // +4
  microtiles_x: u32,           // +8
  generation: u32,             // +12; non-zero
  allowed_mask_lo: u32,        // +16
  allowed_mask_hi: u32,        // +20
  max_dispatch_dimension: u32, // +24
  layout_revision: u32,        // +28; non-zero
};
```

Settings 由现有 frame upload/ring buffer owner 发布，dynamic offset 遵守 `minUniformBufferOffsetAlignment`。Classifier、finalizer 和所有 resolve dispatch 绑定同一 frame offset。

#### 6.3 Heap control

```wgsl
struct ShadingBinControl {
  frame_flags: atomic<u32>, // +0
  error_count: atomic<u32>, // +4; only error paths increment
  generated_mask_lo: u32,   // +8; finalizer owns
  generated_mask_hi: u32,   // +12
  finalized_generation: u32,// +16
  layout_revision: u32,     // +20
  reserved0: u32,           // +24
  reserved1: u32,           // +28
};
```

`frame_flags` 至少包含：

```text
INVALID_BIN
INACTIVE_BIN
LAYOUT_REVISION_MISMATCH
RESERVATION_OVERFLOW
COUNTER_INVARIANT_FAILURE
IDENTITY_MISMATCH
```

#### 6.4 Per-bin counter

```wgsl
struct ShadingBinCounter {
  attempted_count: atomic<u32>, // +0
  written_count: atomic<u32>,   // +4; never exceeds capacity
  overflow_count: atomic<u32>,  // +8
  flags: atomic<u32>,           // +12
};
```

Production 不保留 `consumed_count`。Indirect args 与 `written_count` 决定唯一 consumer range；额外消费完整性由 diagnostics oracle 验证，不为每个成功 microtile 增加 global atomic。

#### 6.5 Per-bin immutable layout

```wgsl
struct ShadingBinLayout {
  record_base: u32, // +0, element index rather than byte address
  capacity: u32,    // +4
  revision: u32,    // +8
  flags: u32,       // +12; ACTIVE bit
};
```

Program/set 由 bin index 解码，不在 layout 重复存储。Inactive bin 的 `capacity = 0` 且 ACTIVE=0。Active bin 的 capacity 固定为全屏 microtile 数：

```text
ceil(width / 8) × ceil(height / 8)
```

在 producer 正确时，一个 microtile 对同一个 bin 最多产生一条 record，因此上述容量无内容相关 overflow。

#### 6.6 Record 与物理 heap

```wgsl
type ShadingTileRecord = u32; // global microtile linear id
```

物理 `GpuShadingBinHeap`：

```text
CONTROL_OFFSET  = 0
COUNTERS_OFFSET = 32
LAYOUTS_OFFSET  = 32 + 64×16 = 1056
RECORDS_OFFSET  = alignUp(1056 + 64×16, 256) = 2304
HEAP_BYTES      = 2304 + activeBinCount × microtileCount × 4
```

Usage 为 `STORAGE | COPY_DST`。Frame start 只 clear control/counters 的 mutable region；layouts 在 revision 内 immutable，records 不 clear。

Heap byte length 与绑定 range 必须同时满足 `maxBufferSize` 和 `maxStorageBufferBindingSize`。超限时 resize/active-summary publication 失败；不降低 queue capacity，不静默减少 active bins，不拆成隐藏 fallback。

#### 6.7 Indirect args

`GpuShadingBinIndirectArgs` 是独立 buffer：

```text
64 records × 12 B = 768 B
usage = STORAGE | INDIRECT | COPY_DST
offset(bin) = bin × 12
record = workgroupCountX, workgroupCountY, workgroupCountZ
```

它不与 heap 合并，因为 resolve pass 会同时将 heap 作为 read-write storage（错误路径写 frame flag）并将 args 作为 indirect input。分离后不产生同一 pass 的 storage-write/indirect usage 冲突。

每帧在 classifier 前清零全部 768 B；finalizer 无论成功或失败都完整写三个 `u32`，不能依赖旧帧的 Y/Z。

#### 6.8 Queue contract

| Contract | Decision |
| --- | --- |
| Queue class | `CorrectnessCritical` |
| Producer | `ShadingBinClassify` |
| Consumer | 当前 bin 的 specialized `ShadingResolve` indirect workgroups |
| Capacity | 每 active bin 一个 full-screen microtile slice |
| Reservation | 每 macro/bin 至多一次 bounded CAS reservation |
| Overflow | 不写 OOB；计数并 fail closed；全部 shading args 归零 |
| Generation | settings、control、FrameProduct 必须一致 |
| Ordering | record append order 不稳定；consumer 不得依赖顺序 |
| CPU involvement | 只记录由 active scene summary 有界确定的 indirect calls；不读取当前可见 count |

All-or-nothing reservation：

1. `attempted += localCount`；
2. CAS 仅在 `oldWritten + localCount <= capacity` 时推进 `written`；
3. 失败时 `overflow += localCount`，不写任何部分 record；
4. finalizer 验证 `attempted == written + overflow`。

1080p records 内存：

| Active bins | Records bytes |
| ---: | ---: |
| 1 | 126.6 KiB |
| 10 | 1.24 MiB |
| 40 | 4.94 MiB |
| 64 | 7.91 MiB |

4K records 内存：1/10/40/64 bins 分别约 506.3 KiB、4.94 MiB、19.78 MiB、31.64 MiB。当前 1080p、28 class、16-byte `MaterialTileWork` worst-case records 约 13.84 MiB。

### 7. Classifier algorithm

#### 7.1 Initialization

WGSL workgroup variables：

```wgsl
var<workgroup> bin_microtiles: array<atomic<u32>, 128>; // bin × lo/hi
var<workgroup> bin_record_bases: array<u32, 64>;
```

前 128 lanes 清零 `bin_microtiles`，前 64 lanes 将 base 设为 invalid sentinel，然后所有 256 lanes 无条件执行 `workgroupBarrier()`。

#### 7.2 Lane-local discovery

每个 lane 读取自己的 4×4 `ShadingBinId` block，产生：

```text
localBinMask: vec2<u32>   // 这个 block 出现过的 bins
microtileBit: vec2<u32>   // lane 所属 microtile 的 macro-local bit
```

`0xff` 被忽略。任何其他 >63 的值设置 error state；lane 仍继续经过所有 subgroup/barrier 点。

#### 7.3 Subgroup aggregation

所有 lanes 在 subgroup-uniform control flow 中执行：

```wgsl
let subgroup_bins = subgroupOr(local_bin_mask);
```

`subgroup_bins` 对 subgroup 中所有 lanes 相同。subgroup 分别遍历 low/high word 的 set bits；循环条件只依赖这个 subgroup-uniform 值：

```text
for each bin B present in subgroup_bins:
  lane_tile_bit = local_bin_mask contains B ? microtile_bit : 0
  subgroup_tile_mask = subgroupOr(lane_tile_bit)
  if subgroupElect():
    atomicOr(bin_microtiles[B].lo/hi, subgroup_tile_mask)
```

禁止：

- `subgroupBallot(...).x`；
- `1u << subgroup_invocation_id`；
- 固定 32-lane mask；
- 在 lane-varying branch 中调用 subgroup builtin；
- 在 barrier 前按屏幕边缘/invalid bin 提前 return。

#### 7.4 Workgroup reserve and scatter

聚合后所有 lanes barrier。前 64 lanes 一一负责 bin：

1. load 64-bit microtile mask；
2. `countOneBits(lo) + countOneBits(hi)`；
3. 验证 allowed mask、layout ACTIVE/revision/capacity；
4. count>0 时执行一次 bounded global reservation；
5. 把 reservation base 写入 `bin_record_bases[bin]`。

再次 barrier 后，256 lanes 合作遍历固定的 `64 bins × 64 microtiles`。命中 bit 使用 mask 内 prefix popcount 得到唯一 rank：

```text
records[layout.record_base + reservation_base + rank]
  = global_microtile_linear_id
```

不同 macro workgroups 的 record 顺序非确定，但 record 集合确定。没有 global count→scan→scatter，没有 pixel record，也不清 records。

#### 7.5 Global synchronization boundary

不同 compute workgroups 之间没有可用的 workgroup/storage barrier。Classifier 结束后必须结束 compute pass，再由独立 `ShadingBinFinalize` pass 读取最终 counter。禁止在同一次 classifier dispatch 的某个 workgroup 内假设全局 append 已完成。

#### 7.6 Finalizer

一个 64-lane workgroup 完成：

- 检查 counter flags、overflow 和 `attempted == written + overflow`；
- 检查 layout revision；
- 生成 `generated_mask_lo/hi`；
- 验证 generated mask 是 allowed mask 的子集；
- 写 `finalized_generation/layout_revision`；
- 任一错误时将 64 组 indirect args 全部写为 `(0, 1, 1)`；
- 成功时为每个 bin 写完整 2D args。

为覆盖 `written > maxComputeWorkgroupsPerDimension`：

```text
written == 0:
  x = 0, y = 1, z = 1

written > 0:
  x = min(written, max_dispatch_dimension)
  y = ceil(written / x)
  z = 1
```

Consumer 以 `group_id.y * x + group_id.x` 得到 record index，并用 `index < written` 拒绝矩形尾部。X/Y/Z 都必须在 device limit 内；若 Y 超限，frame invalid 而不是写非法 dispatch。

### 8. Specialized compute shading

#### 8.1 Pipeline identity

每个实际创建的 pipeline cache key：

```text
ShadingProgramId
× TextureBindingSetId
× ShadingOutputDependencyMask
× negotiated capability/format profile
```

`BIN_ID` 是 shader creation-time constant/override。Shader source 中不存在每像素 `switch(kernel_class)`。Inactive bin 不创建 pipeline；textureless program 不创建 texture sampling bind group；unlit program 不声明 lighting bindings。

Pipeline 和 bind group 在 scene/revision publication 或 cache miss 时建立并复用，不得在 frame loop 每帧创建。

#### 8.2 Consumer algorithm

一个 indirect workgroup 消费一条 8×8 microtile record，64 lanes 各对应一个像素：

1. 计算 record index；矩形 dispatch tail 超界则 return。
2. 读取 global microtile id，计算 pixel；屏幕边缘超界则 return。
3. `textureLoad(ShadingBinId)`；不等于当前 bin 则 return。
4. 读取/验证 VisibilityKey 与 MeshletWork identity。
5. 按当前 program 的静态 dependency 读取 material/geometry/texture。
6. 完成一次 material evaluation。
7. lit program 完成 clustered direct lighting/shadow；unlit program 直接写 radiance。
8. 写 HDR 与当前 FramePlan 请求的 compact outputs。

Microtile 中不属于当前 bin 的 lane 只支付 coordinate + `r8uint textureLoad` + branch。V1 接受 mixed tile 的 rejected lanes，不增加 LoosePixel queue。

#### 8.3 Unlit specialization

`UnlitFactor` + no authored vertex color + no velocity consumer：

- 读取 ShadingBinId、VisibilityKey、MeshletWork、material factor；
- 不读 triangle index/vertex payload；
- 不计算 barycentric；
- 不读 normal/tangent/UV/color；
- 不绑定/采样纹理；
- 不读 light/cluster/shadow/IBL；
- 直接写 pre-exposed unlit radiance。

有 authored vertex color 时必须路由 `UnlitFactorColor`。有 base texture 时必须路由 `UnlitTexture*` 并保留 perspective-correct UV、显式 gradients 与 `textureSampleGrad`。需要 velocity 时，output specialization 增加 position/barycentric/matrix 依赖；不得为了 fast path 静默改变已有视觉语义。

#### 8.4 PBR and lighting

PBR family 完成一次 surface reconstruction，并在同一 specialized kernel 中完成 direct lighting。该决定删除旧“material indirect 28 次 + shared lighting indirect 28 次”的第二轮提交与 SurfaceLite 立即回读。

ADR-0009 的长程/屏幕空间光照语义保持：

- `mode=off|gtao` 可以把 direct、authoritative long-range GI 与 baseline specular 按既有合同融合；
- `mode=ssgi` 输出 `PreExposedDirectEmissive`/radiance source 与 compact receiver products，之后由 SSGI/ScreenSpaceDiffuseResolve 组合；
- SSR 仍以明确 baseline specular 做 replacement；
- 不允许第二次 `EvaluateShading()`；
- Direct、emissive、unlit 不错误乘 screen AO。

具体相邻 stage 可按 ADR-0009 的语义合法融合，但不能用 fusion 改变 FrameProduct、PreExposure 或 history source stage。

#### 8.5 Output dependencies

HDR 是必有输出。其他输出由 creation-time mask 决定：

```ts
const enum ShadingOutputDependency {
  ShadingSurfaceLite = 1 << 0,
  DiffuseSurfaceLite = 1 << 1,
  Velocity           = 1 << 2
}
```

- 无 bit：`ColorOnly`，只写 HDR；
- `ShadingSurfaceLite`：只发布 normal/roughness/flags/metallic-specular 中真实 consumer 所需的 compact profile；
- `DiffuseSurfaceLite`：只在 SSGI/refraction-like receiver consumer 存在时增加 diffuse/material-AO/validity；
- `Velocity`：只在 temporal/motion consumer 存在时增加 velocity attachment 与 position work。

不存在 consumer 的 texture、binding、store、clear 和 FrameGraph resource 必须全部消失，不能以 dummy texture 维持共享 layout。

HDR background 由 sky/background owner 或一次 render-attachment clear 初始化，不增加 fullscreen compute clear。Surface consumer 必须先检查同域 VisibilityKey/ShadingBinId/depth validity，再读取 surface；background surface texel 内容未定义，不得为其增加全屏 clear。

#### 8.6 Binding budget

最宽 `PbrGeneric + ShadingSurfaceLite + DiffuseSurfaceLite + Velocity` specialization 必须满足：

| Group | Owner | Sampled textures | Samplers | Storage buffers | Storage textures | Uniform buffers |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 0 | frame/bin/output | 3 | 0 | 1 | 5 | 2 |
| 1 | scene/geometry | 0 | 0 | 4 | 0 | 0 |
| 2 | material/TextureBindingSet | 9 | 6 | 2 | 0 | 0 |
| 3 | lighting | 4 | 2 | 3 | 0 | 2 |
| **Total** |  | **16** | **8** | **10** | **5** | **4** |

Group 0 的唯一 storage buffer 是 `GpuShadingBinHeap`；indirect args 只作为 indirect input，不占 shader binding。Scene/material/lighting 沿用并重新验证：

```text
asset-metadata-heap
vertex-payload-heap
cluster-metadata-heap
texture-descriptor-routing-heap
```

`GpuShadingBindingBudget` 升级 schema 并核对每个 concrete specialization 的实际 bindings。若实现需要第 11 个 storage buffer，先合并 metadata/queue state 或通过新 ADR 修改 required limit；不得创建某些 adapter 专用的第二 shading path。

### 9. FrameProducts 与命令拓扑

删除旧 `MaterialTileClassificationFrame` 和 `ComputeMaterialEvaluationFrame`，新增：

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

每帧命令：

1. 在主 command encoder 中 `clearBuffer` heap control/counters 与 indirect args；
2. 一个 `ShadingBinClassify` compute pass；
3. 一个 `ShadingBinFinalize` compute pass；
4. 一个 `ShadingResolve` compute pass，按 active scene bins 切 pipeline/bind group 并调用 `dispatchWorkgroupsIndirect`。

全部命令通过 `ShadeGPUCommandContext` 随主 FrameGraph 一次 submit。没有 classifier/finalizer/readback/private error submit。

Light clustering、shadow、GI/AO/SSR 分支与 classifier 可由 FrameGraph 按依赖排序；lit shading 在读取 light/shadow products 前必须有明确 edge，不能依赖记录顺序偶然同步。

### 10. Active shading summary

`GpuRenderWorld` 删除旧：

```text
opaqueKernelClassCounts
activeKernelMask
activeKernelMasksByBindingSet
```

替换为唯一增量 owner：

```ts
interface ActiveShadingSummary {
  readonly binRefCounts: Uint32Array; // 64
  readonly activeBinMaskLo: number;
  readonly activeBinMaskHi: number;
  readonly opaqueLitReceiverCount: number;
  readonly opaqueUnlitReceiverCount: number;
  readonly transparentLitReceiverCount: number;
  readonly dependencyMask: number;
  readonly revision: number;
}
```

更新时机：bulk upload、instance add/remove、Active/Transparency patch、material patch、geometry/material association、TextureBindingSet relocation。它与实际 GPU instance/material publication 同事务提交/回滚。

Renderer 不得每帧扫描 Scene/object/material registry 重建 summary。CPU summary 只表示“场景可能产生哪些 bins”，不表示当前视角可见 bins；本帧可见 count 仍完全由 GPU classifier 生成。

Active bins 按 ascending bin id 获得 dense queue slices。Summary revision、layout revision、pipeline set 和 bind groups 作为一个不可分割版本发布，并在 submitted-work boundary 后退役旧版本。

### 11. Feature-off and pruning

- 无 opaque active bin：不创建/导入 ShadingBin heap/args，不记录 clear/classify/finalize/resolve。
- unlit-only 且没有透明或其他 lit consumer：不创建 LightCluster、opaque shadow sampling、lit pipeline/bind groups；lit-only GI/AO/SSR receiver work 被裁剪。
- Shadow producer 是否需要仍由所有真实 consumer 决定，包括 transparency；不能只看 opaque unlit。
- 无 velocity consumer：无 velocity pipeline layout、resource、store、clear。
- 无 texture program：无 material texture sampling group。
- inactive bin：无 queue slice、pipeline、bind group 或 indirect call。
- active scene bin 本帧不可见：允许已记录的 indirect call读取 `(0,1,1)`；不做 GPU→CPU 可见性回控。
- Diagnostics off：无 claims、ownership pass、counter copy/readback。

Feature 关闭不能只设置 uniform 分支；owner、resource、pass、history、readback 与额外 submit 均必须缺席。

### 12. Production diagnostics and fail-closed behavior

Production 只保留 correctness/safety 必需的低频状态：

- per-bin attempted/written/overflow；
- invalid/inactive bin；
- layout/generation mismatch；
- identity mismatch；
- generated active mask；
- frame invalid。

成功像素不更新 global valid/shaded/claim atomic。Error-only counter 只在异常分支写入。

Correctness-critical 错误按发现阶段 fail closed：

1. classifier/finalizer 发现 invalid bin、inactive bin、layout/generation mismatch、counter invariant failure 或 overflow 时，不写 OOB/部分 reservation，并在任何 resolve indirect dispatch 执行前把全部 bin args 置零；
2. specialized consumer 才能发现的 meshlet/material/texture generation 或 shading identity mismatch，立即停止对应 lane 的结果写入并设置 frame-invalid；已经编码且开始执行的其他 indirect workgroup 不要求被追溯取消；
3. 任一阶段设置 frame-invalid 后，Final Output 输出明确 diagnostic color，或按宿主冻结的策略保留上一张完整有效帧；不得展示部分成功结果；
4. 异步 readback 只在提交后报告，不回控当前帧 command construction。

### 13. Ownership diagnostics variant

“每个有效 opaque pixel 恰好完整着色一次”仍是验证不变量，但其 oracle 从 production ABI 移出。只有显式 diagnostics build/pipeline variant 才声明：

```text
pixelClaims
valid/shaded/duplicate/unassigned counts
claims clear
full or sampled ownership validation
asynchronous readback
```

Diagnostics off 时 shader layout 中不存在这些 bindings，不是 `counters_enabled=false` 后保留 buffer 和代码。Diagnostics variant 不能成为 Final Output 的 production dependency，也不能用于 formal performance sample。

### 14. Lifecycle

- Resize：根据新 internal extent 原子创建 heap/args/layout；旧版本在 submitted-work completion 后退役。
- Summary change：新 layout、pipeline/bind groups 与 revision 一起发布；正在飞行的 frame 保持旧 immutable snapshot。
- Frame generation：visibility、settings、heap control、indirect args 和 consumer 必须来自同一 frame snapshot。
- Aborted encode/submit failure：不得推进可复用 generation/history/retirement state。
- Device loss：丢弃全部 GPU heap/args/pipeline/bind group；恢复后从 CPU-side material/geometry/summary truth 重建，不能复用旧 revision。
- Stable frame：不创建 pipeline/bind group/buffer，不同步 readback，不扫描 scene。

### 15. Source adoption boundary

实际写代码前在 `docs/porting/visibility.md` 或 `docs/porting/shading.md` 登记最终采用范围。候选状态：

| Source | Revision/path | License | Decision |
| --- | --- | --- | --- |
| Wicked Engine | `70ec32cc62f3dadbf796fd5574ff3e34c3c47301`, `visibility_resolveCS.hlsl` / `visibility_analyzeCS.hlsl` | MIT | `traceable-local-port` candidate；仅移植 wave→groupshared→tile append 不变量并改写为 WGSL/64-bin ABI |
| PlayCanvas | `7b00ca4db4bda4c903f4cc727f39b38b43b76aa3`, OneSweep host/WGSL | MIT | `traceable-local-port` candidate；只采用 width-agnostic local reduction/rank/scatter 表达，拒绝完整 lookback 与 ballot.x 假设 |
| The Forge | current research `cd504689...`; existing ledger shading utilities `9d43e691...` | Apache-2.0 | 延续 reconstruction/gradient reference；新增复制范围必须另记 revision |
| Bevy | `96e3bcfd87f4cb6372dd9da8b5318f3e64899a01`, `visibility_buffer_resolve.wesl` | MIT OR Apache-2.0 | reconstruction cross-check；拒绝 CPU per-material fullscreen scheduler |
| Filament | `d45158c6f175726a33b1236858fa3948c5d8dbb5`, `base.mat.in` | Apache-2.0 | compile-time unlit behavior reference |
| MaterialShaderExample | `ce67da0ea0c22b760fe44fcb9d1ff068407ccbda` | MIT | host material→bin mapping reference；不采用 Unreal private API/fullscreen scheduling |
| Nanite public material | Epic public 2024 presentation/blog | reference only | 架构/算法参考；不复制 Unreal shader expression |
| Kooch | `976eab6038f55edc477c42c57e49ed8918190bfe` | All Rights Reserved | `reject-adoption`；禁止复制、翻译、派生其 WGSL |

规范权威为当前 [WebGPU](https://gpuweb.github.io/gpuweb/) 与 [WGSL](https://gpuweb.github.io/gpuweb/wgsl/) Editor's Draft。外部项目的存在不替代 WebGPU validation、OEngine binding budget 或目标 adapter evidence。

### 16. Cutover ownership and deletion

最终实现 owner：

```text
GpuShadingProgramAbi.ts
GpuShadingBinAbi.ts
GpuRenderWorld.ActiveShadingSummary
VisibilityFrame.shadingBinId producer
shading_bin_classify.ts
ShadingBinPass.ts
shading_programs/*
ShadingResolvePass.ts
SurfaceFeature / MainRenderPipeline composition
```

Replacement 闭环后必须删除：

```text
GpuMaterialTileWorkAbi.ts
MaterialTileClassificationPass.ts
ComputeMaterialResolvePass.ts
PackedMaterialResolvePass.ts
dynamic packed_material_compute.ts
GpuMaterialKernelAbi old class mapping
old KernelClass bits/helpers/counts/masks
static dispatch-class uniform table
production pixelClaims and ownership clear/validation
LightingPass old 28-class MaterialTileWork consumer
old MaterialTileClassificationFrame / ComputeMaterialEvaluationFrame
only-old-path counters, tests and documentation
```

删除要求是最终 cutover 的组成部分，不是可选 cleanup。内部 Shading Bin 类型默认不从 `OEngine/src/index.ts` 导出。

## Consequences

### Positive

- Classifier 从 per-valid-pixel identity/material pointer chasing 改为顺序读取紧凑 `r8uint` bin attachment。
- Global contention 从成功像素粒度降为 macro/bin reservation 粒度。
- Queue record 从 16 B 降为 4 B，并按 active scene bins 分配。
- UnlitFactor 能真实删除 triangle/normal/tangent/UV/texture/light 工作。
- Lit material resolve 与 direct lighting 合并，避免第二轮固定 28 次 dispatch 和 color-only topology 的 Surface write→read。
- GPU producer→indirect consumer 闭环保持，无 CPU 可见材质回读。
- Feature-off、output specialization 和 active summary 使无 consumer 资源/Pass 消失。
- Production correctness 不再支付 per-pixel ownership oracle 成本。

### Costs and risks

- Visibility 增加 1 B/pixel `r8uint` MRT；实际 ROP/cache/store 成本必须测量。
- 64×64 classifier 每 lane 做 16 次 bin load；在某些 adapter 上可能受 register pressure 或 occupancy 限制。
- Mixed microtile 仍执行 rejected lanes；V1 有意用简单 bounded tile queue 避免 full pixel compaction bandwidth。
- Program/output variants 增加 pipeline cache population；必须 lazy-create、cache 并随 summary revision 复用。
- Fused lit shader 达到 16 sampled textures、10 storage buffers、5 storage textures的紧边界，任何新增输入都需重新做 binding consolidation。
- Required `subgroups` 和更高 storage-texture limit 会缩小可初始化设备集合；这是明确产品取舍，不提供旧设备 fallback。
- 新 bin bits、Visibility MRT、queue ABI、FrameProducts 和 lighting physical layout 形成一次跨模块 breaking migration。
- ADR-0012 当前阻止真实 runtime/PERF closure；实现可以达到 Implementation Complete，但不能立即完成 ADR。

### Rejected alternatives

#### 只删除 per-pixel diagnostics

它能减轻一个已知热点，但仍保留 classifier pointer chasing、动态 mega-shader、16-byte records 和第二轮 lighting dispatch，不满足长期架构。

#### Full PixelQueue / radix sort

它会额外写/read全屏 pixel records，并引入 count/scan/scatter 与更复杂生命周期。当前没有证据证明其 bandwidth 能被 mixed-tile shading saving 抵消，且 ADR-0004 已拒绝恢复旧 visible-pixel queue。

#### FullTile + LoosePixel 双队列

它同时增加两套 ABI/consumer/overflow 合同。V1 先接受 mixed microtile rejected lanes；只有 formal occupancy/perf 证据支持时才通过新 ADR 引入。

#### 固定 wave32 / `subgroup-size-control`

PlayCanvas 的 32-lane 实现不是普适证明。固定宽度会无必要地排除合法现代 adapter，并制造 pipeline creation 风险；width-agnostic `subgroupOr` 算法已经能维持单一路径。

#### Opaque raster/forward fast path

第二路径会复制材质执行、output composition、debug、temporal 和 validation matrix，违反统一主管线。性能问题应先在 authoritative visibility path 内解决。

#### No-subgroup fallback

用户和产品方向选择更窄的 2026 Desktop performance baseline。维护 workgroup-only fallback 会保留两套 classifier 实现与 parity burden，因此明确拒绝。

## Verification

公共完成语义、证据强度和相同条件比较遵循 [VALIDATION.md](../VALIDATION.md)。ADR-0012 的 browser-host 限制继续生效。

### DEV gates

- `ShadingProgramId`/`ShadingBinId` CPU↔WGSL encode/decode oracle，覆盖 0、63、0xff 和 reserved bits。
- Material×geometry dependency LUT 覆盖 authored/no-color、unlit factor/texture、全部 Standard PBR texture combinations 和 invalid shading model。
- Instance/MeshletWork bin bits pack/unpack、material patch transaction 与 active-summary rollback。
- Visibility MRT descriptor/source audit：`r8uint`、0xff clear、flat integer varying、MASK/depth ownership。
- Heap control/counter/layout/settings 的 exact offset、stride、alignment、byte-length CPU/WGSL oracle。
- Dense active-bin layout、0/1/64 active bins、1080p/4K/maximum extent、buffer/binding limit rejection。
- Bounded CAS reserve：success、exact capacity、concurrent model、overflow、all-or-nothing、`attempted=written+overflow`。
- Classifier CPU oracle：empty、single bin、64 bins、partial macro、mixed microtile、invalid/inactive bin。
- Subgroup shader compile/source audit：无 ballot.x、无 fixed-lane shift、无 divergent subgroup call、无 barrier 前 early return。
- Indirect args oracle：0、1、65,535、65,536、2D tail、Y overflow；每条 12 B record 三字段完整写入。
- Shader specialization audit：`UnlitFactor/ColorOnly` 不声明 geometry vertex、texture、light、Surface、Velocity bindings；production 不包含 pixelClaims/per-pixel success atomics。
- Binding budget oracle：最宽 variant ≤ 4 groups、16 sampled textures、8 samplers、10 storage buffers、5 storage textures、4 uniforms。
- FrameGraph static tests：no-opaque、unlit-only、velocity-off、textureless、diagnostics-off 的 owner/resource/pass 缺席。

TypeScript/WGSL 改动首先运行：

```powershell
Set-Location OEngine
npm run typecheck
npm run build:test
node --test <targeted ABI/shader/framegraph tests>
```

Dependency/lockfile 未变化时普通 DEV 不运行 `npm ci`。

### MILESTONE gates

新真实 browser host 落地后至少覆盖一个综合 scenario，加以下 deterministic states：

1. `BasicCubeNear`：UnlitFactor/ColorOnly，大屏幕 coverage。
2. `BasicCubeFar`：只改变相机距离。
3. `UnlitVertexColor` 与 `UnlitTexture`：证明未静默删除既有语义。
4. `MixedBins`：同 macro/microtile 多 program/set。
5. `RenderingLabFixed`：lit/unlit、纹理、阴影、GI/AO/SSR/Temporal 的综合 consumer。

每个运行记录：

- adapter/browser/capability fingerprint、subgroup range、requested/actual limits；
- console/page/request error、GPU validation、uncaptured error、device loss；
- queue counts/masks/overflow、frame invalid；
- live FrameGraph resources/passes 与 one-main-submit；
- screenshots/readback/numerical seams；
- resize、material patch、feature toggle、scene replace、aborted submit/device loss lifecycle。

Diagnostics variant 必须捕获故意注入的 duplicate/unassigned/identity error；同一 scene 的 production capture 必须证明 claims buffer、clear、ownership pass 和 readback 不存在。

### PERF gates

正式比较固定：

```text
adapter
browser/build
1920×1080 canvas/internal resolution
DPR 1
fixed render scale
quality/features
scene/seed/camera path
warm-up/sample cadence
independent run groups
```

GTX 1650 Ti 是主要低端门禁，RTX 2060 是第二 adapter；不能用 2060 结果替代 1650。保存 GPU P50/P95、CPU build/submit、present cadence、one-submit、memory 与 counters，CPU FPS 不冒充 GPU timing。

Timestamp phases 至少分离：

```text
Visibility raster including r8 MRT
ShadingBin classify
ShadingBin finalize
major shading programs
light cluster/shadow
AO/GI/SSR/temporal/post
```

接受条件：

- `BasicCubeNear` production capture 中没有 claims/valid/shaded per-pixel atomic、claims clear 或 ownership validation。
- Classifier global reservation 上界由 macro tile 中出现的 bin 数决定，而不是有效像素数。
- `UnlitFactor/ColorOnly` graph 中不存在 LightCluster、opaque shadow sampling、SurfaceLite、DiffuseSurfaceLite 或 Velocity 的无 consumer work。
- 1080p `BasicCubeNear` 产品目标为稳定 60 Hz；目标在满足完整 provenance 前保持“未证明”。
- Near/Far 的 coverage slope 能由 Visibility/bin loads 与真实 shading 解释，不再由 production diagnostics 主导。
- `RenderingLabFixed` 的 P50/P95、内存和视觉质量不得通过牺牲 mixed/PBR workload 换取 cube 成绩。
- 新增 r8 MRT、64×64 classifier、fused lighting 任一项若失败，必须定位到具体 timestamp/bandwidth/occupancy；不得保留旧 backend 作为隐藏 fallback。

### Completion criteria

ADR-0013 只有同时满足以下条件才能标记 complete：

- 新 ShadingProgram/Bin/Heap ABI 与全部 DEV oracle 通过。
- `subgroups`、required limits 与 capability record 已成为真实初始化合同。
- VisibilityKey + ShadingBinId MRT 在 production 写入并由 GPU classifier 消费。
- Classifier→heap/args→specialized indirect shading 形成 GPU-only 闭环。
- 每个 Standard material 组合由固定 program 或 PbrGeneric 正确覆盖。
- 完整 opaque material evaluation 仍恰好一次，MASK coverage 保持独立语义。
- Direct lighting 已进入 lit specialized programs，ADR-0009 的 GI/AO/SSR/PreExposure 语义无回归。
- Feature-off、active summary、resize/patch/device-loss 生命周期通过 MILESTONE。
- Production ownership diagnostics 物理不存在，diagnostics variant 仍能捕获错误。
- 所有旧 MaterialTile/KernelClass/28-dispatch lighting owner、ABI、shader、tests 和文档已经删除或改写。
- `docs/ARCHITECTURE.md`、`docs/PIPELINE.md`、`docs/STATUS.md`、`docs/WEBGPU.md` 和 porting ledger 与实际 cutover 同步。
- 新 browser host 下 1650 Ti + 2060 MILESTONE/PERF 完成，正式证据没有 correctness-critical overflow 或 GPU diagnostics。

在 ADR-0012 的宿主缺口关闭前，本 ADR 最高只能达到 `Implementation Complete`，不得宣称 Runtime Validated、Performance Improved、Pipeline Feature Complete 或 ADR Complete。
