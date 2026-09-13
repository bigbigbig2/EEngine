# ADR-0013 · Sparse Shading Bin 与 Specialized Compute Shading

> **Status:** accepted；implementation open
> **Date:** 2026-09-13
> **Scope:** Opaque Visibility shading identity、GPU Shading Bin classifier、queue ABI、specialized compute material/direct lighting、active summary、diagnostics、feature-off、分阶段 cutover 与分层验收
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

实际写代码前在 `docs/porting/visibility.md` 或 `docs/porting/shading.md` 登记最终采用范围。Step 0 冻结后的采用状态如下：

| Source | Revision/path | License | Decision |
| --- | --- | --- | --- |
| Wicked Engine | `70ec32cc62f3dadbf796fd5574ff3e34c3c47301`, `WickedEngine/shaders/visibility_resolveCS.hlsl` / `visibility_analyzeCS.hlsl` | MIT | `traceable-local-port`；仅移植 wave→groupshared→tile append 不变量并改写为 WGSL/64-bin ABI |
| PlayCanvas | `7b00ca4db4bda4c903f4cc727f39b38b43b76aa3`, `upstream:src/scene/graphics/radix-sort/compute-radix-sort-onesweep.js` / `upstream:src/scene/shader-lib/wgsl/chunks/radix-sort/onesweep-binning.js` | MIT | `traceable-local-port`；只采用 width-agnostic local reduction/rank/scatter 表达，拒绝完整 lookback 与 ballot.x 假设 |
| The Forge | `cd5046893faba2dc7869243873bf01f02a6f0df9`, `Examples_3/Visibility_Buffer/src/Visibility_Buffer.cpp`; `9d43e69141a9cd0ce2ce2d2db5122234d3a2d5b5`, `Common_3/Renderer/VisibilityBuffer2/Shaders/FSL/vb_shading_utilities.h.fsl#L90-L150` | Apache-2.0 | `algorithm-invariant-reference`；延续 reconstruction/gradient 参考，新增复制范围必须另记 revision |
| Bevy | `96e3bcfd87f4cb6372dd9da8b5318f3e64899a01`, `crates/bevy_pbr/src/meshlet/visibility_buffer_resolve.wesl` | MIT OR Apache-2.0 | `algorithm-invariant-reference`；reconstruction cross-check，拒绝 CPU per-material fullscreen scheduler |
| Filament | `d45158c6f175726a33b1236858fa3948c5d8dbb5`, `libs/gltfio/materials/base.mat.in` | Apache-2.0 | `algorithm-invariant-reference`；compile-time unlit behavior reference |
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

Step 0 的机器可读 requirement、来源和迁移 owner 由 [`adr-0013-migration-manifest.json`](../../OEngine/tests/fixtures/adr-0013-migration-manifest.json) 唯一维护，并由 targeted test 检查当前 owner 存在、replacement/verification owner 完整、来源状态无 candidate、需求 id 稳定以及公开入口不泄漏内部 ABI。其迁移边界汇总如下：

| 迁移域 | 当前 production owner | replacement owner | 实现 Step | 旧 owner 删除 Step |
| --- | --- | --- | --- | --- |
| Identity/ABI | `GpuMaterialKernelAbi`、`GpuInstanceAbi`、`GpuMaterialVisibilityAbi` | `GpuShadingProgramAbi`、`GpuShadingBinAbi` 与更新后的 instance/material ABI | 1 | 7 |
| Scene publication | `GpuRenderWorld` kernel counts/masks | `GpuRenderWorld.ActiveShadingSummary` 与原子 material/geometry publication | 3 | 7 |
| Visibility output | `PackedVisibilityPass`、`meshlet_bucket_visibility` | 同一 depth winner 写入的 `r8uint ShadingBinId` MRT | 4 | 7 |
| Classifier/queue | `GpuMaterialTileWorkAbi`、`MaterialTileClassificationPass` | `GpuShadingBinAbi`、`ShadingBinPass`、`shading_bin_classify` | 4 | 7 |
| Material/direct lighting | `ComputeMaterialResolvePass`、`PackedMaterialResolvePass`、`LightingPass` 与动态 class shaders | `shading_programs/*`、`ShadingResolvePass` 与 fused lit programs | 5 | 7 |
| FrameProducts/composition | `MaterialTileClassificationFrame`、`ComputeMaterialEvaluationFrame`、Surface/Lighting Feature | `ShadingBinFrame`、`SpecializedShadingFrame` 与唯一主管线 composition | 4–5 | 7 |
| Diagnostics/profiler | production `pixelClaims`、旧 counters/evidence schema | error-only production counters、独立 diagnostics variant、ADR-0013 evidence schema | 5 | 7 |
| Tests/docs | 只验证旧 MaterialTile owner 的 ABI/ownership/docs | 新 ABI/reference/shader/GPU/lifecycle/perf/deletion tests 与权威文档 | 1–8 | 7–8 |

### 17. 分阶段重构、分层测试与验收闭环

#### 17.1 执行原则

本重构按下述 Step 顺序执行。Step 是实施和验证边界，不是可长期选择的运行模式：

- 当前 `MaterialTileWork` 在最终 production cutover 前仍是唯一生产 owner；新链路在内部模块、CPU oracle、shader audit 和新验证宿主的 candidate composition 中逐层闭合。
- 不增加公开 `legacy/new` 开关、Renderer 兼容选项、旧 ABI alias、长期双写或同一发布版本中的双 backend。
- 测试宿主可以显式构建 candidate composition，但该入口只属于验证系统，不从 `OEngine/src/index.ts` 导出，也不能进入产品配置。
- 新模块在接入主管线前必须有 targeted test consumer；不得以“以后会接线”为由合入无验证的死代码。
- 每个 Step 先通过自己的 DEV Exit Gate 才能进入下一 Step。需要真实 GPU 的 Runtime Exit Gate 在新浏览器宿主可用前保持 open；open 不等于通过。
- Step 6 的真实 MILESTONE/PERF 未通过前，不允许执行 Step 7 的 production cutover 和旧路径删除。
- 每个 Step 只修改其声明的 owner。若发现必须改变本 ADR 已冻结的 bin 数、tile 大小、队列模型、required capability、FrameProduct 语义或 fallback 选择，先修改/新增 ADR，不把架构变化伪装成局部修复。

实施 checkpoint 不写回本 ADR。每个 Step 的实际状态只在 `STATUS.md` 记录为 `not-started | implementation-open | implementation-complete | runtime-validated | accepted`；逐次命令输出进入 CI/验证 artifact，不在权威文档积累日志。

#### 17.2 测试层级

| Layer | 目的 | 典型证据 | 对应验证等级 |
| --- | --- | --- | --- |
| L0 · Static/ownership | 保证依赖方向、源码 owner、文档和删除边界正确 | typecheck、build:test、source audit、`rg` ownership/deletion scan、Markdown/provenance check | DEV |
| L1 · CPU oracle | 在不依赖 GPU 的情况下证明 ABI、编码、容量、数学和事务不变量 | table-driven/property tests、CPU reference classifier、layout/offset oracle、rollback tests | DEV |
| L2 · Shader contract | 证明 WGSL、BGL、pipeline layout、format 和 specialization 结构一致 | generated-source audit、binding reflection/oracle、`getCompilationInfo()`、pipeline creation error scopes | DEV；真实编译部分属于 MILESTONE |
| L3 · GPU component | 隔离证明 producer、counter、queue、indirect args 和 consumer 闭环 | deterministic texture/buffer input、GPU dispatch、readback、counter closure、fault injection | MILESTONE |
| L4 · Pipeline/lifecycle | 证明真实 FrameGraph、视觉语义、feature-off 和生命周期 | browser scenario、topology/resource evidence、screenshot/numeric seam、resize/patch/device loss | MILESTONE |
| L5 · Performance | 在固定条件下判断 keep/revise/reject | timestamp phases、P50/P95、CPU build/submit、memory、coverage slope、independent runs | PERF |
| L6 · Final audit | 逐条对照 ADR，证明没有遗漏、隐藏 fallback 或失效证据 | requirement traceability matrix、full clean run、deletion/provenance/API review | ADR acceptance |

L0–L2 不能替代真实 GPU 证据，L3–L4 不能替代正式 PERF，FPS 不能替代 correctness。测试层只表示证据类型，不授权跳过 `VALIDATION.md` 的宿主、clean commit、adapter 或固定 workload 要求。

每个 Step 的交付记录至少包含：Step id、implementation commit、changed paths、命中的 ADR 条款、已运行 Layer、命令/runner identity、通过/失败、deferred Gate 及原因、artifact id/content hash。记录不得只有“测试通过”的自然语言结论。

#### Step 0 · 迁移清单、来源边界与可比较基线

**实现范围**

1. 建立旧 owner → 新 owner 的一对一迁移矩阵，覆盖 ABI、Scene publication、Visibility MRT、classifier、material resolve、direct lighting、FrameProducts、diagnostics、Profiler 和 tests。
2. 用源码引用图确认第 16 节 deletion list 完整；发现新的旧路径 owner 时先补入 ADR/矩阵。
3. 在 `docs/porting/visibility.md`、`docs/porting/shading.md` 登记最终采用或拒绝的上游 revision、路径、许可证、保留不变量和 WGSL/OEngine 差异；candidate 不能继续写成来源结论。
4. 冻结新验证宿主落地后的旧生产路径 baseline commit、workload identity 与 capability fingerprint。旧 benchmark 只作历史参考，不冒充该 baseline。
5. 冻结 requirement id：至少为 Capability、Identity、Visibility、Queue、Classifier、Shading、Feature-off、Lifecycle、Diagnostics、Performance、Deletion 各条规范要求分配稳定 id，供最终 traceability matrix 使用。

**分层检查**

- L0：`rg` 确认旧 owner、公开导出、FrameProduct、shader generator、counter schema 和文档引用全部进入迁移矩阵。
- L0：文档链接、porting license/revision、ADR supersession 和 `STATUS.md` 当前事实检查通过。
- L0：在未修改生产代码的 clean baseline 上运行 `npm run typecheck`、`npm run build:test` 和当前命中的 ownership/ABI tests，证明起点可复现。
- L5：只有新浏览器宿主存在后才捕获旧路径 formal baseline；没有宿主时该项保持 open，不阻塞 Step 1–5 的 DEV 工作，但阻塞 Step 6 PERF 和 Step 7。

**Exit Gate**

- 每个待删除符号有 replacement owner 和验证 owner；没有“顺手清理”的未追踪范围。
- 每个外部实现有 adoption 状态；许可证不明或 `All Rights Reserved` 来源没有可迁移代码。
- baseline commit 与 candidate 采用同一新宿主、场景和证据 schema；无法同条件复现时不得作性能比较。

#### Step 1 · Shading identity、ABI 与 CPU reference model

**实现范围**

1. 新建内部 `GpuShadingProgramAbi.ts` 与 `GpuShadingBinAbi.ts`，冻结第 3、6 节全部常量、bit range、sentinel、offset、stride、alignment 和 usage。
2. 实现 material × geometry `ShadingDependencyMask → ShadingProgramId` 的唯一 versioned LUT；非法模型在 publication 前返回结构化错误。
3. 实现 bin encode/decode、dense active layout、heap byte sizing、2D indirect args sizing、maximum extent/limit preflight。
4. 实现纯 CPU reference classifier/finalizer：输入 `ShadingBinId` image、allowed mask/layout/capacity，输出 per-bin microtile set、counter、record 和 indirect args。
5. 本 Step 不接线 Renderer、不创建 GPU resource、不修改 `src/index.ts`。

**新增/命中测试**

```text
tests/shading-bin-abi.test.mjs
tests/shading-bin-reference.test.mjs
tests/advanced-frame-abi.test.mjs
```

- L1：0、63、0xff、reserved bit、全部 16 program × 4 set round-trip。
- L1：全部合法 Standard PBR dependency combination 唯一命中 fixed program 或 `PbrGeneric`；invalid shading model 原子失败。
- L1：struct byte offsets/strides 与 WGSL declaration 同源或逐字段互证；覆盖 32 B settings/control、16 B counter/layout、4 B record、12 B indirect record。
- L1：0×0、1×1、非 8/64 对齐、1080p、4K、最大 extent、0/1/64 active bins 的容量和 heap bytes。
- L1：indirect count 0、1、65,535、65,536、2D tail、Y overflow，三字段每帧完整覆写。
- L1：CPU classifier 覆盖 empty、single-bin、all-bin、partial macro、mixed microtile、invalid/inactive bin、exact-capacity 和 overflow。
- L0：`npm run typecheck`、`npm run build:test` 与上述 targeted tests 通过；公开导出没有新增内部 ABI。

**Exit Gate**

- CPU/WGSL ABI 无手写漂移点，所有容量运算使用 checked integer arithmetic。
- Reference model 成为后续 GPU tests 的唯一 oracle，不复制第二套期望算法。
- 任何 boundary failure 都在资源创建前可解释失败，不截断、不降低容量。

#### Step 2 · Capability negotiation、pipeline identity 与 binding budget

**实现范围**

1. 将第 2 节 required features/limits 表达为纯 capability-plan function：先读 adapter，再生成精确 `requiredFeatures`/`requiredLimits`，device 创建后冻结 actual record。
2. 加入 `ShadingProgramId × TextureBindingSetId × ShadingOutputDependencyMask × capability/format profile` cache key 和 descriptor schema。
3. 定义 4 个显式 bind group layout 及最宽 variant budget oracle；每个 specialized variant 从真实声明推导使用量。
4. 生成 classifier WGSL 时仅在已请求/启用 `subgroups` 的 module 写 `enable subgroups;`；不请求 `subgroup-size-control`。
5. Capability 硬失败在 Step 7 cutover 时才成为 production 初始化行为；本 Step 不允许提前改变旧 Renderer 的可运行设备集合。

**新增/命中测试**

```text
tests/webgpu-2026-capability.test.mjs
tests/shading-bin-pipeline-contract.test.mjs
tests/advanced-frame-abi.test.mjs
```

- L1：缺 `subgroups`、每个 limit 恰低 1、恰等阈值和高于阈值的 table-driven negotiation。
- L1：只请求 consumer 实际需要且 adapter 支持的 limit，不请求 adapter maximum，不遗漏 feature dependency closure。
- L1：cache key 对 program/set/output/capability 任一变化都改变，对无关 runtime value 保持稳定。
- L2：WGSL `enable/requires`、BGL binding number/type/visibility、storage texture format 和 pipeline layout 三方一致。
- L2：所有 concrete specialization 均不超过 4/16/8/10/5/4 budget；textureless/unlit/color-only variants 的无用 group/binding 物理不存在。
- L2：source audit 禁止 `@subgroup_size`、`subgroupBallot(...).x`、固定 lane-width shift 和 `diagnostic(off, subgroup_uniformity)`。

**Exit Gate**

- Unsupported error 在任何 Renderer-owned resource 创建前确定，错误文本携带 missing feature/limit、required/actual value。
- Pipeline/BGL 可以跨 frame 复用，创建点不在 frame loop。
- 没有 no-subgroup shader、旧 28-class pipeline 或 CPU visible-bin fallback 被注册到 cache。

#### Step 3 · Publication truth 与 ActiveShadingSummary

**实现范围**

1. 实现 material × geometry association 的 bin derivation 和 `ActiveShadingSummary` 纯事务计划。
2. 覆盖 bulk upload、instance add/remove、Active/Transparency patch、material patch、geometry/material association 和 TextureBindingSet relocation。
3. Summary、instance/MeshletWork bin、material/texture generation 与 pipeline/layout revision 作为同一 publish/rollback unit。
4. 建立 submitted-work retirement 和 device-loss rebuild 所需的 immutable revision snapshot。
5. Step 7 前只在测试和 candidate composition 中消费新 publication plan；禁止 live GPU 同时双写旧 KernelClass 与新 bin 作为两个生产 truth。

**新增/命中测试**

```text
tests/shading-bin-publication.test.mjs
tests/packed-render-world-contract.test.mjs
tests/runtime-geometry-instance-residency-v2.test.mjs
```

- L1：bin refcount/mask 的 add/remove、0↔1 边界、64 bins、textureless canonical set 0。
- L1：material/geometry/texture relocation 使 bin 改变时，旧 refcount 减一、新 refcount 加一且 revision 只推进一次。
- L1：OOM、unsupported material、invalid generation、capacity/limit preflight 任一点失败均完整 rollback。
- L1：透明实例不错误计入 opaque queue；透明 lit receiver 仍能维持自身 lighting/shadow consumer truth。
- L1：aborted submit 不推进 reusable generation/history/retirement；device loss 从 CPU truth 重建且不复用旧 revision。
- L0：稳定 frame 不扫描 Scene/material registry，不创建新 summary/pipeline/bind group，不产生 per-frame JS allocation owner。

**Exit Gate**

- 一个 revision 内 bin mask、layouts、pipelines 和 bind groups 可形成不可分割 snapshot。
- 所有更新路径共享一个事务实现，没有漏掉的旁路 patch。
- CPU summary 只表达 possible active bins，不读取本帧 GPU visible count。

#### Step 4 · Visibility MRT、classifier、heap 与 indirect args producer

**实现范围**

1. 实现 `r8uint ShadingBinId` attachment descriptor、0xff clear、flat integer varying 和 Visibility fragment 双 MRT 输出。
2. 实现 heap allocator/clear、64×64 classifier、width-agnostic subgroup 聚合、bounded CAS reservation、scatter 和独立 finalizer。
3. 实现独立 768 B `STORAGE | INDIRECT | COPY_DST` args buffer；heap 不带 `INDIRECT` usage。
4. 实现错误注入入口，仅供 diagnostics/test：invalid/inactive bin、revision mismatch、counter invariant、overflow、2D dispatch overflow。
5. 所有对象带稳定 label，shader module 检查 compilation info，resource/pipeline creation 使用 validation error scope。

**新增/命中测试**

```text
tests/shading-bin-visibility-contract.test.mjs
tests/shading-bin-classifier.test.mjs
validation/src/cases/shading-bin-component/main.ts
```

- L1：CPU raster ownership model 验证 background、depth loser、discarded MASK 保持 0xff，winner 的 key/bin 同域。
- L1：随机小尺寸 image 将 CPU reference 与预期 masks/records/counters/args 比较，覆盖 partial macro/microtile。
- L2：256 lanes 全部经过 subgroup operation/barrier；禁止边缘 early return、divergent subgroup call 和 barrier 后缺失 memory visibility。
- L2：workgroup memory、workgroup size、buffer binding size、texture format/usage 和 indirect offset/stride 全部经过 descriptor oracle。
- L3：上传 deterministic bin image，GPU classifier/finalizer readback 与 CPU oracle 逐 bin 集合相等；record 顺序按 set 比较，不要求 append 顺序。
- L3：验证 `attempted == written + overflow`、generated mask ⊆ allowed mask、零 work 写 `(0,1,1)`、2D tail 不消费额外 record。
- L3：故障注入不产生 OOB/partial reservation，classifier/finalizer 错误在 resolve 前把全部 args 归零，GPU validation/uncaptured error 为零。

**Exit Gate**

- L0–L2 通过后可记录本 Step `implementation-complete`。
- L3 只有真实 WebGPU 宿主运行后才能关闭；未关闭时不得进入 production cutover。
- Classifier 不读取 VisibilityKey、MeshletWork 或 material table，production shader 不含 per-success-pixel global atomic。

#### Step 5 · Specialized shading、direct lighting fusion 与输出裁剪

**实现范围**

1. 建立共享但按 compile-time dependency 裁剪的 reconstruction/PBR/lighting WGSL library，以及 16 个 `ShadingProgramId` entry variants。
2. 先完成 dependency 最窄的 `UnlitFactor`，再补齐 vertex-color/texture unlit、fixed PBR family 和 `PbrGeneric`；这是同一 B 管线内部实现顺序，不形成可发布的 A/B backend。
3. Texture variants 使用 perspective-correct UV/explicit gradients/`textureSampleGrad`；compute shader 不使用 implicit-derivative sampling。
4. Lit variants 在同一 kernel 完成 direct lighting/shadow；保持 ADR-0009 的 GI/AO/SSR/PreExposure source-stage 语义。
5. 按 output dependency 生成 ColorOnly、ShadingSurfaceLite、DiffuseSurfaceLite、Velocity variants；不用 dummy binding 维持共享 layout。
6. Production variant 不声明 claims buffer、valid/shaded/duplicate/unassigned success counters；diagnostics variant 物理隔离。

**新增/命中测试**

```text
tests/shading-program-specialization.test.mjs
tests/shading-bin-consumer-oracle.test.mjs
tests/shading-bin-gpu-component.test.mjs   # 新宿主落地后启用
tests/advanced-frame-abi.test.mjs
```

- L1：每个 supported Standard material/geometry combination 与 program LUT、texture set、output mask 一致。
- L1：canonical vertex reconstruction、barycentric、gradient、normal/tangent、vertex color、PBR/BRDF、PreExposure 与旧语义的数值 oracle；容差和颜色空间显式冻结。
- L2：`UnlitFactor/ColorOnly` source 不含 triangle/vertex/UV/texture/light/shadow/Surface/Velocity bindings 或函数调用。
- L2：unlit texture/PBR texture variants 只使用 explicit gradient/LOD 合法 builtin；subgroup、barrier、texture sample uniformity diagnostics 不被关闭。
- L2：每个 shader variant 的实际 bindings、storage formats、entry point、pipeline key 和 output stores 与 descriptor 相符。
- L3：每种 program 至少一个 deterministic GPU case；mixed material、mixed binding set、边缘 microtile 与矩形 dispatch tail 均与 CPU/numeric oracle 相符。
- L3：故意注入 meshlet/material/texture generation mismatch 时对应 lane 不写结果、frame invalid，Final Output 不展示部分帧。
- L3：diagnostics variant 捕获 duplicate/unassigned；同场景 production variant 的 claims resource/pass/readback 物理不存在。

**Exit Gate**

- 所有 16 program slots 有明确实现或合法地路由到 `PbrGeneric`，不存在 silent feature drop。
- 完整 material evaluation 每个命中 opaque pixel 只发生一次，direct lighting 不再需要第二轮 shading consumer。
- L3 未通过时不得进入 Step 6 candidate pipeline MILESTONE。

#### Step 6 · Candidate FrameGraph、生命周期与预切换性能门禁

**实现范围**

1. 在内部 candidate composition 中连接 Visibility MRT → clear → classify → finalize → active-bin indirect resolve → downstream GI/AO/SSR/Temporal/Post。
2. 全部命令由主 `ShadeGPUCommandContext` 编码并一次 submit；readback 只走异步 diagnostics/capture 边界。
3. 接入 `ActiveShadingSummary` snapshot、pipeline/bind-group cache、resize、scene replace、material patch、feature toggle、camera cut、aborted submit 和 device-loss recovery。
4. 接入 FrameGraph live resource/pass evidence、phase timestamp、queue/error counter 和 memory accounting。
5. Candidate 入口只存在于新验证宿主，不导出产品 runtime switch。旧 baseline 与 candidate 使用两个 clean commit/run group 比较，不在同一 binary 保留双 backend。

**新增/命中测试**

```text
tests/shading-bin-framegraph.test.mjs
tests/render-layer-ownership.test.mjs
tests/packed-render-world-contract.test.mjs
```

- L0/L1：FrameGraph static matrix 覆盖 no-opaque、unlit-only、textureless、velocity-off、SSGI off/on、diagnostics off/on。
- L2：pass edge 明确保证 Visibility→classifier→finalizer→indirect consumer 与 light/shadow producer→lit consumer；不依赖偶然记录顺序。
- L4：运行 BasicCubeNear/Far、UnlitVertexColor、UnlitTexture、MixedBins、RenderingLabFixed；检查截图/数值、queue closure、GPU diagnostics、one-main-submit。
- L4：逐项运行 resize、material/association patch、TextureBindingSet relocation、feature toggle、scene replace、camera cut、aborted submit 和 device loss；旧 snapshot 只在 submitted-work boundary 后退役。
- L4：feature-off 以 live topology 证明无 owner/resource/pass/history/readback/counter copy/独立 submit，不接受仅 uniform 分支。
- L5：在当前指定设备的真实 WebGPU adapter 上捕获旧 clean baseline 与 candidate 的相同条件数据；当前指定设备为 `NVIDIA GeForce RTX 2060 SUPER`。先分离 Visibility r8 MRT、classifier、finalizer、major programs 与 downstream phase，再看总 frame。其他 adapter 由用户后续补充，不阻塞本 ADR。
- L5：若 cube 改善但 `MixedBins`/`RenderingLabFixed` P50/P95、内存或画质不合格，Step 6 不通过；不能只凭平均 FPS 进入 cutover。

**Exit Gate**

- L0–L4 全绿，所有 correctness-critical counter/diagnostic 为零，生命周期无 stale generation/resource leak。
- L5 能解释 coverage slope、MRT 成本、classifier contention、mixed-tile rejected lanes 和 fused-lighting 收益；达到本 ADR `PERF gates` 的接受条件。
- 新宿主或当前指定 WebGPU adapter 不可用时 Step 6 保持 open，并明确阻塞 Step 7；不得以 WMI 设备名、任务管理器利用率或 CPU FPS 代替浏览器 capability/timestamp 证据。

#### Step 7 · 一次性 production cutover 与旧路径删除

**前置条件**

- Step 0–5 的 DEV Gate 和其中适用的 Runtime Gate 全部关闭。
- Step 6 的 MILESTONE/PERF 已在同条件 clean commits 通过。
- Requirement traceability matrix 没有未分配 owner，porting ledger 没有 candidate/unknown license 状态。

**实现范围**

1. 激活 required `subgroups`/limits 的 Renderer 初始化合同；在任何 Renderer-owned resource 前 fail fast。
2. 将 instance/MeshletWork publication 原子切换到 `ShadingBinId`，将 `MainRenderPipeline` 原子切换到 candidate composition。
3. 将下游 FrameProducts、Profiler/debug UI、counter schema 和 device-loss rebuild 指向新 owner；必要时升 counter ABI version，保留空洞必须标为 reserved 并有 oracle。
4. 在同一 cutover 中删除第 16 节所有旧 ABI、Pass、Shader、static class uniform、production claims 和只服务旧路径的 tests/docs。
5. 更新 `ARCHITECTURE.md`、`PIPELINE.md`、`STATUS.md` 和 porting ledger 为真实 owner；不是在 cutover 前预写未来事实。

**分层检查**

- L0：`rg` 对 deletion manifest 的每个符号、文件、public export、FrameProduct、shader string、pipeline label 和 counter name 执行零命中检查；允许的历史命中只限 ADR/冻结 benchmark narrative。
- L0：`npm run typecheck`、`npm run build:test`、全部命中 targeted tests、`npm run audit:shaders` 通过。
- L1/L2：全部 ABI/cache/binding/source audit 在删除旧 tests 后仍由新 tests 独立覆盖，不能靠旧 helper 间接通过。
- L4：production 入口重复 Step 6 全部 browser correctness/lifecycle matrix，证明测试 candidate 与真正主管线一致。
- L5：post-deletion clean candidate 至少做短 profile，确认删除/接线没有使 Step 6 evidence 失效；正式最终 PERF 仍由 Step 8 完成。

**Exit Gate**

- 源树、公开接口、已编译 shader audit 和真实 FrameGraph topology 四处均不存在旧 backend。
- 只有一个 opaque production pipeline；没有隐藏 env flag、URL 参数、quality switch 或 adapter-specific legacy path。
- Cutover 后任何失败都在新管线内修复；不通过恢复旧 backend 关闭问题。

#### Step 8 · 全量测试、独立审查与最终验收

Step 8 是唯一最终验收阶段，不再新增功能。它从 clean cutover commit 开始，先生成 requirement traceability matrix，再执行以下完整顺序。

**A. Clean reproduction 与全量静态/单元层**

```powershell
Set-Location OEngine
npm ci
npm run typecheck
npm run build:test
npm test
npm run audit:shaders
```

- L0：dependency/lockfile、generated source、shader allowlist、public exports、文档 links/provenance、deletion scan 全部干净。
- L1：运行 Step 1–7 全部 oracle/property/boundary/transaction/fault tests，固定随机测试必须保存 seed。
- L2：对所有实际创建的 program/set/output/capability variants 做 WGSL compilation info、BGL/pipeline creation、binding budget 和 uniformity review；warning 必须分类，不能批量忽略。

**B. 全量真实浏览器 MILESTONE**

- L3：classifier/finalizer/consumer component oracle、queue closure、indirect 2D tail、fault injection 和 diagnostics/production variant separation。
- L4：`MILESTONE gates` 定义的全部 deterministic states 加综合 workload；覆盖 cold start、warm cache、resize、scene replace、material/geometry/texture patch、feature toggle、camera cut、aborted submit、device loss/recovery。
- 每个 scenario 同时记录 console/page/request error、validation error scopes、uncaptured error、device loss、live graph、resource bytes、counter、screenshot/readback 和 submit count。
- 对 Feature-off 组合进行结构检查；不得用画面“看起来没变化”代替 owner/resource/pass 缺席证据。
- 当前指定的 `NVIDIA GeForce RTX 2060 SUPER` 是本 ADR 唯一阻塞性 adapter；Runner 必须证明浏览器实际选择该 adapter。其他设备的 correctness/PERF 结果是非阻塞补充，不进入本 ADR Exit Gate。

**C. 全量 formal PERF**

- 使用 Step 0 冻结的旧 baseline commit 与 clean cutover commit；两边必须使用同一新宿主、浏览器 build、adapter、1920×1080、DPR 1、fixed render scale、quality/features、scene/seed/camera、warm-up/sample cadence。
- 当前指定 adapter 使用多个独立 run group，保存逐 phase GPU P50/P95、CPU frame/build/submit、Present cadence、submit 数、memory 与所有 queue/error counters。
- BasicCubeNear/Far 用于 coverage slope，不单独代表综合成功；MixedBins 和 RenderingLabFixed 共同防止只优化单材质大三角形。
- GPU timestamp 不可用的 run 只能作为 correctness evidence，不能进入 formal PERF；CPU FPS、浏览器 overlay 和任务管理器 GPU utilization 不能代替 timestamp。
- 结果必须分别给出新增 r8 MRT、classifier/finalizer、各 shading family、删除第二轮 lighting 和删除 diagnostics 的成本/收益；无法解释的回归视为失败。

**D. 四类独立审查**

1. **Architecture/ownership review**：GPU producer→GPU consumer、单主管线、FrameProduct owner、feature-off、无 CPU visible list、无 public GPU internals。
2. **WebGPU/WGSL review**：feature/limit negotiation、resource usage、alignment、BGL/layout、MRT format、indirect buffer、pass ordering、subgroup/barrier uniformity、explicit gradients、device loss/error scopes。
3. **Performance/resource review**：pipeline/bind-group cache、stable-frame allocation/readback/submit、timestamp 完整性、resident/transient/history/shadow/upload/readback budget、当前指定 adapter 上的可解释结果。
4. **Source/deletion/documentation review**：upstream revision/license/adoption、无不可用源码派生、旧 owner 零残留、当前事实文档与实现一致、benchmark artifact 可复算。

审查结论只能是 `pass` 或带 requirement id 的 `fail`；“建议以后处理”不能关闭本 ADR 的 MUST/不得条款。

**E. 不合格修复循环**

任何测试、性能 Gate 或审查失败时执行同一闭环：

1. 将失败绑定到最早拥有该不变量的 Step 和 requirement id，保存复现输入、adapter/capability、seed、artifact hash 与 observed/expected。
2. 在该 Step 的 owner 内修复；若修复改变冻结架构，先修订 ADR 并使旧证据失效。
3. 先重跑失败 Step 的全部 Layer，不只重跑单个失败 case。
4. 再重跑所有依赖该 ABI、Shader、FrameProduct、capability 或 lifecycle 的后续 Step Gate。
5. 最后从 Step 8A 开始重新执行全量验收；旧 candidate 的成功结果不能拼接成新 revision 的全绿结论。
6. 循环直到当前指定 adapter 的适用 Gate、四类 review、deletion scan 和 requirement matrix 全部通过。

禁止通过提高容差、删除 workload、降低内部分辨率/画质、关闭 feature、缩短采样窗口、只换更快 adapter、隐藏 validation error 或恢复旧 backend 让失败“变绿”。确需改变验收条件时必须在 ADR 中说明新依据、代价和被作废证据。

**最终 Exit Gate**

- Requirement traceability matrix 每条 MUST/不得要求均指向 production owner、test owner 和当前 revision evidence；无 `N/A` 或无理由 deferred。
- Step 8A–D 全绿，Step 8E 没有未关闭 failure，正式 artifact 来自 clean commit 且可复算。
- 满足本 ADR `Completion criteria` 后，才可将状态改为 `complete`；否则保持 `accepted; implementation open` 或 `Implementation Complete`，不得使用更高完成语义。

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

第 17 节是实施顺序和逐 Step Exit Gate；本节以下 DEV/MILESTONE/PERF 条目是跨 Step 的汇总验收集合。两者必须同时满足，不能以某个 Step 的 targeted test 通过替代最终汇总 Gate。

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

本 ADR 的阻塞性性能门禁只使用当前指定的 `NVIDIA GeForce RTX 2060 SUPER`；Runner 必须保存浏览器实际 adapter identity，名称或设备选择不符时 run 无效。用户后续在 GTX 1650 Ti 或其他设备上的对比属于补充证据，不影响本 ADR 的 pass/fail。保存 GPU P50/P95、CPU build/submit、present cadence、one-submit、memory 与 counters，CPU FPS 不冒充 GPU timing。

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
- 新 browser host 下当前指定 adapter 的 MILESTONE/PERF 完成，正式证据没有 correctness-critical overflow 或 GPU diagnostics；额外 adapter 对比不作为本 ADR 完成条件。

在 ADR-0014 宿主中的全部命中 Gate 关闭前，本 ADR 最高只能达到 `Implementation Complete`，不得宣称 Performance Improved、Pipeline Feature Complete 或 ADR Complete；局部 L3/L4 证据只能关闭其明确覆盖的 Step/Gate，不能外推为整条管线 Runtime Validated。
