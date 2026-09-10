# ADR-0007 · GPU-native Runtime Assets 与 Residency V2

> **Status:** accepted
> **Date:** 2026-09-10
> **Scope:** Runtime Asset、Geometry/Texture Cook、GPU Residency、Instance Runtime Data
> **Depends on:** ADR-0002 Runtime Assets and GPU-driven；ADR-0006 Packed Render World Convergence
> **Feeds:** ADR-0008 GPU-driven Geometry & Visibility V2；ADR-0009 Compute Shading & Advanced Frame Pipeline V2
> **Evolution:** 扩展 ADR-0002 的数据与 residency 合同，不替代其 owner/GPU-driven 决策
> **Design source:** `OEngine Performance Architecture V2` Design Draft

## Context

ADR-0002 与 ADR-0006 已经把 OEngine 的资源与 Render World 所有权收敛到正确方向：Importer/Loader 不拥有长期 GPU 资源，设备无关 Runtime Asset 与 `GpuAssetStore`、`GpuScene`、`GpuMaterialStore`、Texture Residency、`GpuRenderWorld` 分离，普通 Scene 与 Packed source 最终进入同一个 Render World。

下一轮性能问题不再主要是“谁拥有资源”，而是：

> **资源进入 Runtime 与 GPU 后到底长什么样，以及为了这些数据要付出多少网络、CPU RAM、GPU VRAM、Upload 与 Hot-path Bandwidth。**

当前生产代码已经暴露出几类结构性成本：

- Geometry 已经 Cook 出 meshlet / hierarchy 等 GPU-ready 数据，但 Runtime 仍保留较通用的 vertex stream 描述与解码能力；GPU 热路径仍需要处理 format、stride、normalized 等来源格式语义。
- `OEngine/src/gpu/GpuInstanceAbi.ts` 当前实例 record 为 192 B，身份/flags、bounds、current transform、previous transform 等高低频数据位于同一 record。
- `GpuScene` 为 GPU patch/rebuild 保留 CPU shadow，实例规模上升时 RAM 与 VRAM 会同步放大。
- Texture Residency 当前仍以 size-class bank 为重要组织方式；未压缩 GPU residency、Runtime mip generation、bank grow/copy 都会增加显存、transaction peak 与加载成本。
- glTF、PNG、WebP 等 Source Format 仍承担了过多 Runtime 语义。Source Format 应是 Import Format，而不是稳定 GPU Runtime ABI。
- CPU staging、Worker decode/transcode、GPU upload、retiring 等阶段尚缺少统一可测量 transaction contract。

如果不先解决这些数据问题，ADR-0008 的 Meshlet Frontend 与 ADR-0009 的 Compute Shading 仍会被过宽的顶点、实例、纹理与 descriptor 数据拖住。

## Decision

OEngine 将把 Asset Pipeline 重构为 **GPU-native cooked runtime asset pipeline**：

```text
Source Assets
GLTF / GLB / Images / future formats
        ↓
Importer
        ↓
Canonical Import Semantics
        ↓
OEngine Cooker
        ├─ Geometry Package V2
        ├─ Texture Package V2
        └─ Runtime Package Manifest
        ↓
Runtime Asset / Package
        ↓
GpuAssetStore / TextureResidency / GpuScene
        ↓
GpuRenderWorld
```

关键决策：

1. **Importer 可以通用，GPU Runtime Format 必须有界、专用、紧凑。**
2. **能在 Cook 阶段完成的工作，不留到每帧或每像素完成。**
3. Geometry、Texture、Instance 同时按 resident bytes、upload bytes、CPU peak、GPU bandwidth 评价。
4. **逻辑 stable handle 与物理 residency 分离。**
5. **WebGPU 2026 Desktop 是设计中心。** 主路径优先使用 `WEBGPU.md` 登记并由设备实际启用的 texture compression、format/f16 等能力；缺失能力时使用同一逻辑 ABI 的正确 specialization，不形成另一套 Renderer。
6. 第一轮不实现完整 Virtual Texture / World Streaming，但 package/handle/mip-page metadata 不得堵死后续 partial residency。
7. 不长期保留“新旧 Runtime Format 双轨”；production candidate 最终必须 replace 或 reject。

## Product capability dependency

本 ADR 的 feature、limit、WGSL/API probe 与 fallback 统一依赖 [WebGPU 2026 能力合同](../WEBGPU.md)，不再自行定义另一份 feature baseline：

```text
Primary design target:
OEngine WebGPU 2026 Desktop

Capability fallback:
same logical ABI specialization
```

资产侧 WebGPU 2026 Desktop 重点：

```text
texture-compression-bc
texture-compression-astc
texture-compression-etc2
texture-formats-tier1
shader-f16（仅用于适合的 runtime decode/intermediate candidate）
texture-compression-unaligned（工具链与浏览器支持后，仅用于避免 partial edge block padding）
```

三种 compression family 不是同时 required：Cooker 生成已声明的 variants，Runtime 只请求并选择 adapter 支持且当前资产实际使用的一族；无匹配 variant 时选择显式 uncompressed variant 或在发布 GPU owner 前失败。

`subgroups`、`primitive-index` 等主要由 ADR-0008/0009 使用。

## Preserved ownership invariants

以下现有边界保持不变：

- Loader/Importer 不持有长期 `GPUBuffer` / `GPUTexture`。
- Runtime Asset/Package 仍是设备无关事实。
- `GpuAssetStore` 继续拥有 geometry GPU residency。
- Texture Residency 继续拥有 texture physical residency。
- `GpuMaterialStore` 继续拥有 material GPU records。
- `GpuScene` 继续拥有 instance GPU state。
- `GpuRenderWorld` 继续作为这些 runtime owner 的统一组合边界。
- `MainRenderPipeline` 继续是帧内 encode / FrameGraph owner。
- 资源系统不得自行 `queue.submit()`。
- device loss 后由正式 owner 依据 Runtime Asset/Package 确定性重建。

---

## 1. Runtime Package V2

### 1.1 文件角色

本 ADR 冻结职责，不强制冻结扩展名。

候选：

```text
.oasset
  logical asset manifest / recipe / dependencies / variants

.opack
  binary chunks / pages / byte ranges
```

### 1.2 Manifest

至少表达：

```text
magic
container_version
asset_schema_version
asset_id
asset_type
cooker_version
recipe_hash
source_provenance

dependency_table
variant_table
chunk_table
integrity_table
optional_debug_names
```

每个 chunk 至少记录：

```text
chunk_type
compression
alignment
offset
compressed_bytes
decoded_bytes
expected_resident_bytes
variant/profile
checksum
```

Manifest 的职责可以由独立 schema/生成代码承载，但进入生产前必须冻结完整 binary ABI：

```text
byte order and integer widths
header/table entry byte size
offset/size overflow and whole-file bounds
alignment and overlap validation
version compatibility and unknown-record policy
checksum coverage
duplicate asset/chunk identity policy
```

Parser 必须先验证全部范围和整数运算，再创建 TypedArray view、decode job 或 GPU transaction；不能把 JavaScript number、宿主字节序或当前 struct 偶然布局当成文件格式。

### 1.3 Stable identity

必须区分：

```text
LogicalAssetHandle
        ↓
Descriptor/Table indirection
        ↓
Physical Residency Location
```

Material、Scene、Visibility 不允许长期把 texture bank layer 或 buffer physical offset 当作不可移动业务 identity。

---

## 2. Canonical Geometry Package V2

### 2.1 目标

Geometry Package V2 需要直接服务：

- ADR-0008 Meshlet Work；
- Visibility reconstruction；
- ADR-0009 Compute ShadeLighting；
- GPU upload / residency；
- 后续 geometry partial residency。

Package 至少包含：

```text
geometry ID
vertex profile ID
compact vertex payload
compact index payload

meshlet topology
meshlet local vertex/index tables
meshlet bounds / cone
material/raster-state range
hierarchy / LOD metadata
decode scale/bias

optional page/chunk mapping
checksum / provenance
```

### 2.2 Bounded runtime vertex profiles

第一轮禁止继续扩大“任意 Runtime Vertex Format”能力。

优先只保留少量 profile：

#### Static PBR

```text
Position  : local-AABB quantized 16-bit candidate
Normal    : octahedral signed-normalized candidate
Tangent   : packed tangent + handedness
UV0/UV1   : f16x2 or normalized 16-bit candidate
Color     : rgba8unorm or absent
Index     : meshlet-local compact index
```

#### Future Skinned PBR reservation

在 Static PBR 基础上可以预留 bounded joint/weight representation 的 profile namespace，但它属于未来 schema reservation。当前产品仍按 `PRODUCT.md` 将完整动画/蒙皮生态列为 Deferred；在新的范围决定和垂直验证完成前，不创建生产 Skinned PBR profile、GPU owner 或 shader variant。

#### Explicit fallback profile

仅用于 precision/unsupported case；必须是显式 profile，不恢复“任意 source descriptor 在 GPU 热路径动态解码”。

### 2.3 Profile selection

Cooker 根据实际 asset semantic 决定：

- 没有 vertex color，不为它保留 bytes。
- 没有 UV1，不保留 UV1。
- 不需要 tangent 的 material path，不强制长期存 tangent。
- 极端大坐标/高精度 geometry 可以进入明确 fallback profile。
- unsupported source attribute 在 Cook 阶段报错、显式降级或声明 unsupported。

### 2.4 Quantization correctness

Position quantization 必须保存：

```text
decode_bias
decode_scale
conservative_bounds
```

验证：

- AABB/sphere 不因 quantization 变成非保守；
- triangle 不产生不可接受 crack；
- near-plane / LOD / HZB correctness 不破坏；
- UV wrap、高频纹理误差可接受；
- normal/tangent angular error 可测量。

### 2.5 Meshoptimizer

优先复用成熟实现，不自研：

```text
vertex remap / dedup
vertex cache optimization
overdraw optimization
vertex fetch optimization
meshlet build
bounds/cone
simplification/LOD
payload compression（如适合）
```

具体 upstream revision、许可证、使用文件、OEngine 差异进入 `docs/porting/geometry.md`。

### 2.6 Recommended cook order

```text
Import source
 → normalize semantic inputs
 → topology/material validation
 → remove unused attributes
 → remap / dedup
 → vertex-cache optimization
 → overdraw optimization（适用时）
 → vertex-fetch optimization
 → canonical quantization/packing
 → meshlet build
 → meshlet locality optimization
 → bounds / cone / error
 → hierarchy / LOD
 → package/chunk layout
 → optional payload encoding
 → deterministic package validation
```

---

## 3. Texture Package V2

### 3.1 Source encoding != GPU residency

明确区分：

```text
PNG / JPG / WebP / HDR / EXR
        ↓
source/transport encoding

KTX2 / package variant
        ↓
runtime transport/container

BC / ASTC / ETC2 / fallback
        ↓
GPU resident format
```

文件压缩率不能代替 GPU resident bytes 指标。

### 3.2 Offline mip

普通 Runtime Asset 的 mip chain 必须在 Cooker 生成。

按 semantic 正确处理：

- BaseColor：正确 sRGB filtering。
- Normal：filter 后重新归一化。
- ORM：线性数据逐通道处理。
- Alpha MASK：保持 coverage。
- Emissive/HDR：避免不必要 clipping。
- Wrap/atlas：正确 gutter/边界。

Runtime mip generation 只保留给：

```text
dynamic texture
render target
development-only uncooked input
```

### 3.3 GPU compressed variants

Desktop candidate：

```text
BaseColor   : BC7 sRGB
Normal      : BC5
Single mask : BC4
ORM         : BC-family based on measured quality/cost
HDR         : BC6H where appropriate
```

Other/mobile：

```text
ASTC
ETC2
uncompressed fallback
```

物理格式由 adapter、图像质量、sampler/use-case 验证，不在 ADR 中永久锁死。

### 3.4 KTX2 / Basis strategy

#### Universal variant

```text
KTX2 + transcodable payload
   ↓
runtime selects/transcodes
   ↓
BC / ASTC / ETC2
```

#### Performance variant

```text
desktop-bc
mobile-astc
portable
```

Runtime 直接选择兼容 variant 并上传。

两者使用同一 stable texture ID。

### 3.5 Upstream policy

优先研究/使用：

```text
KTX-Software
Basis Universal
```

不把上游对象模型传播到 OEngine Runtime API；Runtime 只消费 OEngine Texture Package contract。

---

## 4. Texture Residency V2

### 4.1 第一轮要解决的问题

1. GPU resident format 过宽；
2. Runtime mip 工作；
3. size-class bank grow 全量 copy / old+new transaction peak；
4. logical resident 与 physical allocated/retiring 混淆；
5. stable handle 与物理位置耦合风险。

### 4.2 Physical layout

首选候选：

```text
FormatClass × SizeClass × Segment
```

例如：

```text
BC7-1024 Segment0
BC7-1024 Segment1
BC7-2048 Segment0
BC5-1024 Segment0
```

segment 满时新增 segment，不复制已有 segment。

### 4.3 Descriptor indirection

Texture logical handle 指向 descriptor：

```text
format_class
size_class
segment
layer
logical_size
uv_scale_bias
resident_mip_range
generation
```

Material 只保存 stable handle。

stable handle 至少由 `slot + generation` 验证。Descriptor slot 释放后只有在相关提交完成并递增 generation 后才能复用；generation 不匹配必须解析为 invalid/non-resident fallback，不能命中其他纹理。物理 relocation 通过提交边界原子发布新 descriptor，不改变业务侧 logical identity。

`GpuMaterialRecord` 可以附带由 texture descriptors 派生的 GPU routing metadata，但它不是 Runtime Package 的业务 identity：

```text
GpuMaterialTextureRouting
  binding_set
  residency_generation
  per texture semantic:
    binding_slot
    array_layer
    sampler_class
    descriptor_generation
```

物理 relocation 必须在同一 publication transaction 中更新 descriptor 和全部受影响 material routing generation；旧提交完成前保留旧 descriptor/set，不能产生一半新 generation、一半旧 generation 的可见材质。

### 4.4 Bounded TextureBindingSet contract

标准 WebGPU 生产路径不假设 bindless、descriptor indexing 或 sized binding arrays。一个 `GPUTextureView`/sampler 仍占用显式 bind-group binding，因此 segment 可以在 owner 内增长，但不能假设 `ShadeLighting` 能通过任意整数直接访问所有 segment。

V2 冻结以下绑定模型：

```text
TextureBindingSet
  fixed pipeline layout
  bounded sampled texture-array slots
  bounded sampler classes
  per-set semantic fallback/default layers
  reserved bindings for shadow/environment/frame products
  binding_slot → physical segment GPUTextureView

TextureDescriptor
  physical segment
  array_layer
  resident_mip_range
  generation

GpuMaterialTextureRouting
  binding_set
  per-semantic binding_slot / array_layer / sampler_class
  residency_generation
```

同一 material 一次 `EvaluateShading()` 需要的全部 physical segments 必须同时出现在一个 `TextureBindingSet`，其 derived routing 把每个 semantic 映射到该 set 的 local slot。相同 physical segment 可以出现在多个 bind group/set 中而不复制 GPU texture residency；descriptor 仍只有一个 physical `segment + layer` 事实。

Residency transaction 在发布 material/texture handle 前完成 set coverage/preflight；无法满足时只能：

1. 在预算内新建尚未超过 renderer policy 的 binding set；
2. 在提交完成边界执行 eviction/repack 并原子更新 descriptor；
3. 选择已声明的 fallback texture/variant；
4. 在发布任何部分 residency 前明确失败。

不得把跨 set 材质留给 shader 静默少采样，也不得运行时回读可见材质后由 CPU 重建 draw/dispatch list。ADR-0009 的 GPU Material Classification 按有界 `KernelClassId × TextureBindingSetId` 直接生成 GPU consumer 的 indirect args。

初始化必须根据实际 `device.limits` 和启用的 shading resources 冻结：

```text
texture_slots_per_binding_set
sampler_class_count
max_resident_binding_sets
reserved_sampled_texture_bindings
max_shading_dispatch_classes
```

这些值进入 capability record、pipeline/layout cache key、Runtime Package compatibility 和综合 benchmark provenance。超出 policy/device limit 是 preflight failure，不通过无限新增 segment/bind group 隐式改变可执行管线数量。

### 4.5 Residency accounting

独立统计：

```text
logical_resident_bytes
physical_allocated_bytes
retiring_bytes
transaction_peak_bytes

upload_bytes
copy_bytes
transcode_bytes

segment_count
binding_set_count
binding_slot_utilization
binding_set_preflight_failures
grow/copy_operations
```

### 4.6 First-round non-goal

不在第一轮实现完整 Virtual Texture，但 descriptor/package 必须保留：

```text
mip range
chunk/page mapping
generation
physical indirection
```

---

## 5. Instance Runtime ABI V2

### 5.1 Why now

当前 `GpuInstanceAbi.ts` 的实例 record 为 192 B，并将：

```text
identity/flags
bounds
current transform
previous transform
```

放在同一结构中。

这会让 static metadata 与 high-frequency transform patch 耦合，并让 GPU resident、CPU shadow、patch bandwidth 同步放大。

### 5.2 Decision

第一阶段只做**更新频率拆分**，不追求极限 transform compression：

```text
StaticInstanceData
  geometry
  material
  flags
  bounds
  debug/stable identity

DynamicInstanceData
  current transform
  previous transform / motion state
  revision
```

具体 SoA/AoS、3x4 matrix、quaternion+scale 等物理形式由 benchmark 决定。

### 5.3 Patch rules

Scene change set 必须区分：

```text
static-instance patch
transform patch
material patch
visibility/lifecycle patch
```

稳定帧不得为了一个 transform 变化重写整条 192B 等价 record。

### 5.4 CPU shadow

CPU shadow 只保留 GPU patch/recovery 真正需要的 canonical state。

记录：

```text
CPU shadow steady bytes
transform patch bytes/frame
static patch bytes/frame
device-loss rebuild source
```

禁止为了方便 pack，永久保留与 Runtime Package、Scene object、GPU buffer 三份等价大数组。

---

## 6. Worker / Loading Transaction

### Worker responsibilities

```text
container parsing
meshopt/payload decode
Basis/KTX2 transcode
checksum
large TypedArray transform
chunk/page request preparation
```

Worker 不拥有 GPUDevice、GPUTexture、GpuAssetStore。

### GPU owner thread responsibilities

```text
capability/profile selection
GPU residency transaction reservation
GPU upload encode
submission lifetime
stable handle publication
```

这里不把 owner 永久绑定到 Window main thread。GPU device、residency 与 submission lifetime 必须共置于 Renderer/GPU owner 所在线程；未来若 Renderer 使用 Dedicated Worker + OffscreenCanvas，同一职责整体迁移，decode worker 仍不成为 GPU resource owner。

### Transaction lifecycle

一次加载至少区分：

```text
compressed source
container staging
decoded canonical bytes
transcode scratch
GPU upload staging
published metadata
retiring bytes
```

必须记录 cold-load peak，不能只看最终 VRAM。

每个 transaction 明确执行：

```text
preflight
→ reserve
→ decode/transcode
→ encode upload
→ submit
→ commit and publish

or

abort
→ release reservation/scratch
→ retire submitted-but-unpublished resources after GPU completion
```

OOM、取消、校验失败、submit failure 与 device loss 都必须进入同一 abort/retire 语义；不得留下已增加 refcount、但没有 published handle 的 binding slot、descriptor 或 material record。

### Publication boundary

逻辑 handle 只有在 required chunks validated + descriptor/GPU residency 达到约定完成边界后才对 Render World 可见。失败/abort 不允许留下半可见 asset。

---

## 7. Streaming seam

### First-round scope

第一轮必须支持：

```text
async whole-asset/chunk loading
stable handle
budgeted upload
retirement
device-loss rebuild
```

### Evidence-triggered partial residency

后续可以扩展：

```text
texture mip groups
geometry pages
coarse LOD always resident
GPU visibility feedback
```

仅在 compressed + segmented residency 仍无法解决真实 resident/load hitch 时实现。

### Future virtual texture

Virtual Texture 属于后续 ADR/extension：

```text
virtual texture descriptor
 → page table
 → physical tile cache
 → mip-tail fallback
```

本 ADR 只要求 stable handle、mip range、package chunks 不堵死它。

---

## 8. Migration plan

### Step 0 · Memory/asset truth

**Scope**

增加 asset load、CPU peak、GPU resident、upload、bank-copy 的可信计数，固定 texture-heavy / geometry-heavy workload。

**Verification:** DEV + PERF baseline

**Exit**

能够回答：

```text
source bytes
decoded peak
GPU resident bytes
transaction peak
upload bytes
runtime mip cost
bank grow/copy cost
```

### Step 1 · Package/variant contract

**Implementation:** completed 2026-09-11；`RuntimeAssetManifestV2.ts` 在现有 little-endian binary envelope 上冻结 manifest/dependency/variant/chunk 语义；chunk 记录物理 byte range、compressed/decoded/resident bytes、variant membership 与 checksum，variant 记录 feature/limit compatibility，CPU oracle 覆盖确定性与损坏输入。

**Scope**

定义 Runtime Package header/manifest/variant/chunk contract；暂不要求所有资产切换。

**Verification:** DEV + MILESTONE

**Exit**

同一输入+recipe 产生确定性 package metadata；invalid/corrupt variant 明确失败。

### Step 2 · Texture Cooker V2

**Implementation:** completed 2026-09-11；首个 desktop physical profile 使用 BC1/3/4/5 并离线保存到 1×1 的完整 mip chain，base block 未对齐时显式选择 portable RGBA8 variant；`surface.texture-package-bc` 是真实 Chrome/WebGPU consumer。

**Scope**

Offline mip、KTX2/physical compressed variants、capability-based selection、开发 fallback。

**Verification:** MILESTONE + PERF（texture workload）

**Exit**

至少一个 desktop compressed path 完成：

```text
cook → load → upload → sample
```

且 color/normal/MASK 无不可接受回归。

### Step 3 · Texture Residency V2

**Implementation:** completed 2026-09-11；当前有界 binding set 为每个 size-class 一个 immutable RGBA8 segment，stable handle 使用 version+slot+generation 且提交前不对全局 descriptor 查询发布，MaterialRecord 消费同事务派生 routing；slot/sampler/set/dispatch 上限进入 capability fingerprint，logical/physical/retiring/transaction 计数由 owner 产生。多 format/multi-set 扩展仍受 4.4 的 preflight policy 约束。

**Scope**

segmented immutable allocation、stable descriptor indirection、logical/physical/retiring accounting。

**Verification:** MILESTONE + PERF

**Exit**

目标扩容路径不再搬迁全部已有纹理；device loss/load-abort 可恢复。

### Step 4 · Canonical Geometry Profile V2

**Implementation:** completed 2026-09-11；`static-pbr-compact-v2` 已成为默认 production profile：position 使用 source-AABB UNORM16、normal 使用 oct SNORM16、tangent 使用 SNORM16、UV 使用 float16、color 使用 UNORM8，meshlet/cluster bounds 对 position quantization 做保守扩张；`explicit-float32-fallback-v2` 是唯一保留的显式 generic fallback。Runtime Package V2 manifest/profile/hash 与 GeometryDirectory 双向校验，当前 Visibility、Shadow、Material Resolve、Transparency 和 hierarchy consumer 直接解码该 ABI。

**Scope**

第一套 Static PBR compact profile、meshoptimizer/cook pipeline、current renderer 临时消费新 profile 建 baseline。

**Verification:** MILESTONE + PERF

**Exit**

position/normal/UV/material parity 通过，并降低 package/resident/fetch 成本中的至少一类；对应 generic production branch 删除。

### Step 5 · Instance ABI V2

**Implementation:** completed 2026-09-11；Instance ABI v4 将每条记录划为 64 B static region 与 112 B dynamic region，总 resident stride 从 192 B 降为 176 B；current 与 previous-from-current 使用 affine 3×4 表达。`static-instance`、transform、material、visibility 与 lifecycle 已有独立 mutation 合同，transform 不再重写整条 record，material/visibility 使用 4–8 B field write；CPU shadow、各类 patch bytes 与 stable no-op 由 `GpuScene`/FrameProfiler owner 计数。

**Scope**

static/dynamic split、patch narrowing、CPU shadow accounting。

**Verification:** MILESTONE + PERF（instance/update workload）

**Exit**

transform-heavy workload 的 patch bytes、resident bytes、CPU shadow 得到可信下降或结构性解耦，无生命周期回归。

### Step 6 · Optional page/mip seam

**Implementation:** completed 2026-09-11；`RuntimeAssetResidencyState` 只冻结 asset/chunk identity、logical/physical resident range、`unrequested → requested → resident → retiring` 状态、原子 reserve/commit/abort、budget hook、retire 和 device-loss reset。Geometry/Texture production upload 已接入该 seam，physical resource identity 不进入或改变 stable asset/material handle；未加入 priority、feedback、IO 或 page scheduler。

**Scope**

只实现 chunk/page identity、resident range、request state、budget hooks，不实现复杂 scheduler。

**Verification:** DEV + MILESTONE

**Exit**

ADR-0008/0009 可以在不改变 stable asset/material handle 的前提下消费当前 residency。

---

## 9. Verification

公共 DEV/MILESTONE/PERF 强度、Browser Runner、证据持久化和性能比较遵循 [`VALIDATION.md`](../VALIDATION.md)。本 ADR 只增加以下领域 Gate：

- Runtime Package：header/manifest/chunk 的版本、端序、对齐、范围、checksum、variant 选择、损坏输入和确定性序列化必须有 CPU oracle；production loader 的真实浏览器消费必须成功。
- Texture Cooker：mip 尺寸、颜色空间、normal/ORM/MASK 过滤、压缩格式选择和 fallback metadata 必须有 oracle；只有现有 Scenario 无法证明实际物理压缩格式时才新增独立 Browser Case。
- Texture Residency：stable handle、generation、reserve/commit/abort、release/reuse、增长失败和 device-loss 重建必须可验证；增长不得改变已发布 handle、全量搬迁既有 resident texture 或发布 provisional handle。
- Compact Geometry：position、normal、tangent、UV、profile、meshlet local index 与 conservative bounds 使用明确数值容差做 CPU/WGSL parity；浏览器 Gate 覆盖 silhouette、材质采样和 LOD consumer。
- Instance ABI：static/dynamic pack、revision/generation、previous transform、patch range 和 CPU shadow accounting 必须闭合；transform-heavy workload 分别覆盖 stable frame、小比例 patch 和大比例 patch。
- Memory truth：source/container/decoded/transcode peak、upload/copy/retiring、logical/physical GPU resident、instance shadow、runtime mip 与 grow-copy 都必须由 owner 计数，不能从文件大小或 DOM 推断。

Architecture enabler 不要求独立 FPS 提升；residency 与 data-layout 优化分别以 memory transaction、upload/load hitch、bytes/fetch/patch 和下游 GPU phase 判断。ADR 开始保存一次正式 baseline，最终只运行一个涵盖 texture-heavy、geometry-heavy 与 instance-update 的 PERF group；中间 Step 仅在 keep/revise/reject 需要时升级到 PERF。

---

## 10. Acceptance model

### Architecture enabler

Package schema / stable handle 不要求单独提高总 FPS，要求能够解锁后续并降低结构耦合。

### Residency optimization

看：

```text
GPU resident bytes
CPU peak
upload/transaction peak
load hitch
texture bandwidth proxy
```

### Hot-path data layout

看：

```text
bytes
fetch/update bandwidth
downstream GPU phase
cache/locality evidence
```

### Micro optimization

只有 profiler 命中热点才做。

---

## 11. Consequences

### Positive

- Source Format 与 GPU Runtime ABI 解耦。
- Geometry/Texture/Instance 数据量成为可控设计对象。
- 降低 VRAM、CPU RAM、upload 和 GPU bandwidth 压力。
- ADR-0008/0009 获得更简单、可预编译的 Runtime data contract。
- 为后续 streaming/VT 留出 stable-handle seam，而不提前实现复杂系统。
- 大量格式复杂度从每帧/每像素迁移到一次性 Cooker。

### Costs

- 增加 Cooker、package schema、variant 管理与 provenance 成本。
- Quantization/block compression 引入可测量质量误差。
- 多平台 texture variant 增加构建/CDN 管理复杂度。
- Instance ABI 迁移会波及 GpuScene、shader binding 与 patch logic。

### Deferred

```text
完整 Virtual Texture
world-scale streaming
GPU decompression
bindless resource model
极限 transform compression
animation/skinning 全生态重构
```

---

## 12. Porting and provenance

主要写入：

```text
docs/porting/geometry.md
docs/porting/platform.md
```

优先研究：

```text
meshoptimizer
KTX-Software
Basis Universal
KTX2 / GPU compression specifications
```

必须记录：

```text
upstream repository
exact revision/tag
source path
license
adoption type
retained invariants
OEngine differences
WebGPU/browser differences
local validation
```

---

## 13. Completion criteria

ADR-0007 当前范围完成要求：

- Runtime Package/variant contract 成为生产事实；
- 普通 texture runtime asset 不再依赖 runtime mip generation；
- 至少一个 WebGPU 2026 Desktop GPU-compressed texture path 成为生产路径；
- Texture Residency 目标增长路径不再全量搬迁旧 bank；
- 至少一个 canonical compact geometry profile 成为生产路径；
- Instance static/dynamic 生命周期完成目标拆分；
- logical handle 与 physical residency 明确分离；
- `TextureBindingSet` 的 slot/set 上限、材质 colocate、preflight failure 与 generation-safe relocation 已成为生产合同；
- CPU/GPU memory transaction 可以被 profiler/benchmark 解释；
- 被替换 production generic path 已删除或只剩明确 fallback profile；
- `ARCHITECTURE.md`、`PIPELINE.md`、`STATUS.md` 只在相应代码真正落地后更新事实。

接受本 ADR 不自动授权删除 ADR-0008/0009 仍依赖的旧 consumer；跨 ADR 删除必须发生在 consumer 迁移完成之后。
