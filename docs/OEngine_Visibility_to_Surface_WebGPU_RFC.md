# OEngine Visibility-to-Surface 架构重构设计

**Material Resolve v2 / WebGPU Portable Rendering RFC**

| 仓库 | bigbigbig2/EEngine |
| --- | --- |
| 基线提交 | a5ea18f494ebfaaf6cdff77503c951339ce70948 |
| 设计日期 | 2026-09-07 |
| 目标平台 | 桌面浏览器 WebGPU / wgpu-compatible baseline |
| 状态 | Conditionally Accepted — M0/M1 可执行；后续阶段必须满足各自进入 Gate |

## 核心决策

- 保留 GPU Scene → Hierarchy → ExactTriangleFilter → Hardware VisibilityKey/Depth 前半段。
- 重构 VisibilityKey → Surface：删除 screen-sized Pixel Queue、递归 prefix scan、scatter 与“每像素一个 point primitive”。
- 第一阶段采用 MaterialClassDepth + 7 个有界 Kernel fullscreen draw 作为 WebGPU portable baseline。
- MaterialClassDepth 只是一条优化快路径；保留无需 depth-equal 的 class-discard correctness fallback。
- 第二阶段引入 DAIS-inspired、仅面向大屏幕三角形的 bounded adaptive TriangleSetup cache。
- Tile Material Backend 作为验证后的可选后端，不作为第一阶段复杂度。

## 目录

- 1. 执行摘要与重构结论
- 2. 当前仓库基线与问题定位
- 3. 设计目标、非目标与 WebGPU 约束
- 4. 参考架构与移植取舍
- 5. 目标总体架构
- 6. ABI 与 FrameProduct 所有权重构
- 7. Phase 1：VisibilityKey v3 + MaterialClassDepth
- 8. Phase 2：Adaptive TriangleSetup Cache
- 9. Phase 3：Surface ABI v2
- 10. Phase 4：Tile Material Backend（可选）
- 11. 与 Renderer / FrameGraph 的集成
- 12. 文件级改造清单
- 13. 迁移顺序、回滚与兼容
- 14. 验证、测试和观测体系
- 15. 性能预期与验证原则
- 16. 风险与缓解
- 17. 验收标准
- 18. 参考资料
- 附录 A. WGSL / ABI 草案
- 附录 B. TriangleSetup 数学推导
- 附录 C. Benchmark 矩阵

# 1. 执行摘要与重构结论

本 RFC 的目标不是对当前 Packed Material Resolve 做局部加速，而是重新定义 OEngine 从“最终可见性”到“Surface”的执行架构。当前前半段 GPU-driven 几何工作生成已经形成了清晰的 GPU Scene、层次工作队列、ExactTriangleFilter 与硬件 Visibility Raster 路径；真正需要推倒重建的是 VisibilityKey 到 Surface 的桥。

> **最终推荐路线**
>
> 保留 Visibility Buffer。删除 Pixel Queue / point-list Material Resolve。第一阶段用 MaterialClassDepth 让固定功能深度测试完成 7 个有界材质 Kernel 的像素选择；第二阶段只对屏幕覆盖大的三角形建立 TriangleSetup cache，把透视插值设置从“每像素重复计算”变成“每三角形一次”。

| 层 | 现状 | 目标 |
| --- | --- | --- |
| 几何生产 | Hierarchy → Exact OPAQUE/MASK RasterWork | 保留；只把 exact output 提升为正式 FrameProduct |
| 可见性 | r32uint VisibilityKey + depth32float | 保留；VisibilityKey v3 附带 3-bit KernelClass |
| 材质分类 | 全屏 count → prefix → scatter → ShadeWork | 删除；改为 1 个 MaterialClassDepth pass |
| 材质执行 | 每 visible pixel → point primitive | 删除；最多 7 个 fullscreen triangle + depth equal |
| 属性插值 | 每像素重新投影 3 顶点并求 bary/derivative | Phase 2：大三角形 TriangleSetup cache；小三角形保留 fallback |
| Surface | 22/26 Bpp MRT | Phase 3 独立优化，不与 Phase 1 正确性耦合 |
| 扩展后端 | 无 | Phase 4：NanoMesh/Wicked 风格 tile backend，可选 |

这一设计是“可解释重构”：每一个新模块都有明确 owner、输入输出 ABI 和替换对象；任何性能收益都能通过独立 A/B benchmark 归因，不依赖隐藏启发式。

# 2. 当前仓库基线与问题定位

## 2.1 当前真实 Packed 主链路

```text
GpuPackedSceneRegistry
  → GpuScene / GpuAssetStore / GpuMaterialStore
  → HierarchicalWorkGenerator
  → candidate RasterWork
  → ExactTriangleFilter
  → exact OPAQUE / MASK RasterWork
  → PackedVisibilityPass
  → r32uint VisibilityKey + depth32float
  → VisiblePixelClassifier
       count → recursive scan → add → prepare → scatter
  → ShadeWork[pixelIndex]
  → 7 × point-list drawIndirect
  → PackedMaterialResolvePass
  → Surface MRT
  → LightingFeature / GI / AO / SSR / Temporal / Post
```

`ExactTriangleFilter` 当前已经在 compute 中读取三角形三个源顶点、变换到 clip space、执行 clip/orientation/backface/small-primitive 判定，并把保留下来的三角形写进 OPAQUE/MASK exact queue。这意味着 Phase 2 所需的三角形 screen-space setup 数据已经在一个天然合适的位置被计算过。

当前 `GpuWorkGenerationAbi.ts` 的 `OEngineRasterWork` 只有 24 B：instance、geometry、meshlet、local triangle、material handle、raster flags。VisibilityKey v2 则把整个 32-bit key 都用作 `rasterWorkSlot`。

## 2.2 当前 Material Resolve 的结构性成本

| 阶段 | 复杂度 | 主要问题 |
| --- | --- | --- |
| count_visible_pixels | O(P) | 无论物体覆盖多少，都扫描 internal resolution 全屏 |
| prefix / add | O(groups × 7) | 为了形成 pixel queue 引入多层 scan 与 scratch |
| scatter_visible_pixels | O(P) | 第二次扫描全屏并写 `ShadeWork` |
| point-list VS | O(Nvisible) | 每个 visible pixel 被重新表达成一个 synthetic vertex/point |
| Material FS | O(Nvisible) | 每像素再次读取 RasterWork + 3 顶点并重建 barycentric/derivatives |
| Surface MRT | O(Nvisible / attachment clear) | 当前 22/26 Bpp Surface，随后 Lighting 再读取 |

P 是内部渲染像素数，Nvisible 是最终几何覆盖像素。1920×1080 时 P=2,073,600。当前 Rendering Lab 的 fixed-FOV 距离实验中，`shadedPixels` 从近处约 1.92M 降到远处约 158k，而 `hwTriangles` 反而在远处更多。这一事实与用户实际“cube 靠近掉 FPS、拉远恢复”的现象在机制上高度一致，但仓库现有静态 CPU 数据并未证明单一像素因素就是全部原因，因此本 RFC 把它定义为需要 GPU A/B 验证的首要架构假设，而不是既成测量结论。

## 2.3 一个必须顺手修复的架构异味

> **生产数据不应走 Debug ABI**
>
> `PackedVisibilityOutputs` 目前通过 `PackedVisibilityDebugSource.resolve()` 暴露 `rasterWork / instances / materials`，而正式 Surface producer 实际依赖这个“debug”对象。这说明 exact raster 数据没有被建模为正式 FrameProduct。重构必须把它改成正式 `ExactRasterFrame / VisibilityFrame`。

# 3. 设计目标、非目标与 WebGPU 约束

## 3.1 目标

- 消除 screen-sized Pixel Queue 架构：删除 count/prefix/scatter/ShadeWork 与 point-list resolve。
- 保留 Visibility Buffer 在高三角密度 / 小三角形场景的优势，不回退成传统 G-Buffer prepass。
- 基线只依赖 WebGPU 核心 render/compute/storage/indirect/depth 能力；不依赖 mesh shader、descriptor heap、64-bit atomics、subgroup。
- 让“一个大三角形覆盖百万像素”不再导致百万次重复 triangle setup。
- 所有 persistent/transient GPU 资源有唯一 owner、容量策略、释放路径和 FrameGraph 依赖。
- 重构能够分阶段上线，每一阶段都可以旧/新路径 A/B。
## 3.2 非目标

- 第一阶段不实现软件光栅或 Nanite 式完整 virtual geometry。
- 第一阶段不重写 Lighting/GI/AO/SSR；它们继续消费稳定 `SurfaceFrame`。
- 不为了追求理论最小字节数立即改变所有 Surface normal/emissive 语义。
- 不把 Tile Compute 当成默认答案；弱 GPU / 浏览器驱动上 compute visibility shading 可能更慢。
## 3.3 WebGPU 特殊约束

| 能力/限制 | 设计处理 |
| --- | --- |
| 无通用 mesh/task shader baseline | 继续使用现有 drawIndirect + vertex pulling |
| 无原生 bindless descriptor heap baseline | 保持 TextureResidency array bank + 7 个 bounded material kernels |
| depthCompare="equal" 可用 | MaterialClassDepth backend 使用固定功能深度比较；性能不依赖规范保证，正确性失败时切 class-discard fallback |
| Early fragment rejection 性能不是规范保证 | 作为 benchmark gate；若特定实现表现差，切 Tile backend |
| depth16unorm / depth32float 可用 | ClassDepth baseline 使用 depth32float；depth16unorm 仅在 equal correctness + 性能跨实现验证后启用 |
| WGSL analytical derivatives 可手写 | 沿用当前/Bevy/The Forge/DAIS 的解析插值，不依赖 quad ddx/ddy |

# 4. 参考架构与移植取舍

| 参考 | 核心做法 | OEngine 采用/不采用 |
| --- | --- | --- |
| Burns & Hunt 2013 | 4-byte VisBuffer，shade 时通过 triangle/instance 重建属性 | 采用：薄 Visibility；不直接复制其资源模型 |
| UE5 Nanite 2021 | opaque geometry 一次 visibility；后续 deferred material 写 GBuffer | 采用：visibility/material execution 解耦；不移植 mesh shader/64-bit 软件 raster |
| Bevy Meshlet / wgpu | VisBuffer → Material Depth；每 material fullscreen triangle；解析 bary/derivatives | 强参考：最接近 WebGPU/wgpu 的 portable 实现 |
| Tencent NanoMesh 2024 | Material Depth + 每材质 64×64 tile list + Depth Equal | Phase 4 参考；第一阶段先利用 OEngine 只有 7 kernel classes 的优势 |
| The Forge VisibilityBuffer2 | triangle filtering 与 visibility shading utilities | 继续沿用 exact filter 的 WebGPU port；公式作为对照 |
| DAIS HPG 2015 | visible triangle 用 sample point + screen derivatives 表示 | Phase 2 核心参考，但改成 bounded adaptive cache |
| Microsoft VisibilityBuffer | compute final shading，说明 synthetic point primitive 不是必要结构 | 作为 compute backend 对照，不移植 bindless HLSL 6.6 |
| Wicked Engine | 按 material type bin screen tiles；compute shading optional | Phase 4 参考，保留“可选”而不是强制 |
| John Hable 2021 | count/prefix/reorder 在大三角形场景有额外 VisUtil 成本 | 直接支持删除当前 pixel reorder 层 |

## 4.1 为什么不直接“第二遍重画所有三角形 + depth equal”

二次 triangle raster 对大三角形非常自然，硬件插值便宜；但 OEngine 的产品定位包含高几何密度、小三角形场景。Visibility Buffer 的重要优势恰恰是避免小三角形的 fragment quad helper 浪费。Hable 的测试显示，当三角形缩小到约 1 pixel 量级时 Visibility 路径显著领先 Deferred。故“二次 triangle material raster”可以作为实验 backend，但不作为唯一新架构。

# 5. 目标总体架构

```text
┌──────────────────────────────┐
GPU-ready Assets ───────►│ GPU Render World             │
Packed Instances ───────►│ assets / instances / materials│
                         └──────────────┬───────────────┘
                                        │
                              HierarchicalWorkGenerator
                                        │
                                  candidate RasterWork
                                        │
                                 ExactTriangleFilter
                                        │
                          ┌─────────────┴──────────────┐
                          │ ExactRasterFrame            │
                          │ exact records + draw args   │
                          │ optional TriangleSetup cache│
                          └─────────────┬──────────────┘
                                        │
                              Hardware Visibility Raster
                                        │
                          ┌─────────────┴──────────────┐
                          │ VisibilityFrame             │
                          │ VisibilityKey v3 + depth    │
                          └─────────────┬──────────────┘
                                        │
                            MaterialClassDepthPass
                                        │
                         MaterialClassificationFrame
                                        │
                         MaterialResolveBackend (v2)
                         ├─ baseline: ClassDepthRaster
                         └─ optional: TileMaterialBackend
                                        │
                                  SurfaceFrame v1/v2
                                        │
                          Lighting / GI / AO / SSR / TAA
```

> **边界原则**
>
> VisibilityFeature 只负责“最终可见性产品”；SurfaceFeature 只消费正式 VisibilityFrame / ExactRasterFrame，不允许再调用 debugResolve() 读取上游内部状态。

# 6. ABI 与 FrameProduct 所有权重构

## 6.1 新产品类型

```ts
export interface ExactRasterFrame {
  readonly records: ResourceId;          // ExactRasterRecord queue
  readonly drawIndirect: ResourceId;     // OPAQUE / MASK args
  readonly classCapacity: number;
  readonly setupRecords: ResourceId | null;
  readonly setupCount: ResourceId | null;
}

export interface VisibilityFrame {
  readonly visibilityKey: ResourceId;
  readonly depth: ResourceId;
  readonly exactRaster: ExactRasterFrame;
  readonly domain: TextureDomain<"internal-full">;
}

export interface MaterialClassificationFrame {
  readonly classDepth: ResourceId;
  readonly domain: TextureDomain<"internal-full">;
}
```

这些类型应进入 `render/pipeline/FrameProducts.ts`，与当前 `SurfaceFrame` 同级。`PackedVisibilityDebugSource` 只保留给 Inspector/Debug View（如果仍需要），不能再承担生产数据通道。

## 6.2 Persistent owner 与 FrameGraph

当前 exact filter 的 `rasterWork`/draw args 是 `PackedVisibilityPass` 内部 prepared state。目标做法是把它们包装成 `VisibilityWorkSet`，仍由 VisibilityFeature 唯一拥有，但通过 `graph.import_resource()` 以正式 ResourceId 进入 FrameGraph。这样 Surface 的 read dependency、生命周期和 profiler 都能被图显式看见。

`VisibilityWorkSet` 的缓存身份只能包含会改变资源形状或 GPU 对象身份的字段：Packed Scene、asset/scene `resourceEpoch`、capacity 与 backend layout。camera、counter sink、Inspector cadence 和 material content revision 不得成为大 Buffer 的 cache key。它们进入独立的轻量 `VisibilityBindingSet`；diagnostics 开关最多重建 bind group，不能复制 exact/setup Buffer。

```text
VisibilityFeature owns persistent VisibilityWorkSet
  ├─ hierarchy prepared buffers
  ├─ exactRasterRecords
  ├─ exact drawIndirect
  ├─ triangleSetupQueue (Phase 2)
  └─ setup counter / overflow evidence

VisibilityFeature owns lightweight VisibilityBindingSet
  ├─ camera binding
  ├─ optional profiler counter sink
  └─ material/texture bindings required by MASK

FrameGraph per frame
  import exactRasterRecords
  import drawIndirect
  import setupRecords
  Visibility pass: write exact/visibility/depth
  Material pass: read exact/visibility/setup
```

与此前发现的 `GpuScene.epoch` 问题配套：prepared resource cache 必须依赖 `resourceEpoch`，transform/material 内容变化只提升 `contentRevision`，否则一次实例 patch 会重建整个 work set。这个 epoch split 是 M1 的前置交付，不是无 owner 的并行任务。

资源记账必须与生命周期一致：`VisibilityWorkSet` 中跨帧复用的 exact/setup Buffer 记为 resident work cache；`MaterialClassDepth` 记为 transient texture；profiler counter/readback 分别记入 profiler/readback。所有 owner 都必须在 Packed Scene release、resource epoch 替换、device loss 和 Renderer destroy 时 retire。

# 7. Phase 1：VisibilityKey v3 + MaterialClassDepth

## 7.1 VisibilityKey v3

| 位段 | 内容 | 说明 |
| --- | --- | --- |
| 0..28 | exactRasterSlot | 29 bit，最大 536,870,911 个 slot |
| 29..31 | kernelClass | 0..6 对应当前 7 个 Kernel；7 保留给 invalid/empty |
| 0xFFFFFFFF | EMPTY | class=7 + slot all-one，保持清屏 sentinel 直观 |

29-bit slot 看似比 v2 的 32-bit 少，但对 WebGPU 没有实际容量损失：单个 ExactRasterRecord 至少 24~32 B，任何现实 `maxStorageBufferBindingSize` 都会先于 5.36 亿记录成为限制。

```wgsl
const SLOT_BITS  = 29u;
const SLOT_MASK  = 0x1fffffffu;
const CLASS_SHIFT = 29u;
const CLASS_MASK  = 0xe0000000u;
const CLASS_INVALID = 7u;

struct VisibilityKeyEncodeResult {
  key: u32,
  valid: u32,
};

fn vis_try_encode(slot: u32, cls: u32) -> VisibilityKeyEncodeResult {
  if slot > SLOT_MASK || cls >= CLASS_INVALID {
    return VisibilityKeyEncodeResult(0xfffffffeu, 0u);
  }
  return VisibilityKeyEncodeResult(slot | (cls << CLASS_SHIFT), 1u);
}
fn vis_slot(key: u32) -> u32  { return key & SLOT_MASK; }
fn vis_class(key: u32) -> u32 { return key >> CLASS_SHIFT; }
fn vis_valid(key: u32) -> bool { return vis_class(key) < 7u; }
```

禁止通过 `slot & SLOT_MASK` 把越界 slot 截断成另一个合法 triangle。exact producer 必须在 capacity negotiation 时限制 class capacity，并在运行时 encode 失败时写 invalid sentinel、增加 `visibility.keyEncodeInvalid`，最终 fail-visible；CPU 与 WGSL oracle 必须覆盖高位截断反例。

## 7.2 KernelClass 不应让 OPAQUE Visibility 新增 Material Buffer 依赖

当前 OPAQUE visibility 刻意只有 position/scene/geometry/work bindings。为了维持这一点，把 3-bit kernelClass 在 Packed Scene stage/material patch 时编码进 `OEngineInstanceRecord.flags` 高位。Visibility VS 本来就读取 instance，所以没有新增 storage binding。

```ts
// GpuInstanceAbi.ts
export const GPU_INSTANCE_MATERIAL_KERNEL_SHIFT = 8;
export const GPU_INSTANCE_MATERIAL_KERNEL_MASK  = 0x7 << 8;

function encodeKernelClass(flags: u32, cls: u32) -> u32 {
  return (flags & ~KERNEL_MASK) | ((cls & 7u) << KERNEL_SHIFT);
}
```

`GpuPackedSceneRegistry.materialClassificationFlags()` 在 stage 与 material patch 两条路径都应写入这个字段；`GPU_INSTANCE_MATERIAL_CLASSIFICATION_MASK` 同时扩展。这样材质被 patch 后 key 的 class 在下一帧自然正确，而不需要 CPU 重建 render list。

## 7.3 MaterialClassDepthPass

这是 Phase 1 的核心替换：用一次极轻的全屏 pass 把 VisibilityKey 里的 3-bit kernel class 写进独立深度纹理。推荐 `depth32float` 作为 correctness baseline；7 个类使用 1/8 的二进制精确值。`depth16unorm` 只作为后续 A/B 优化候选，因为量化后的 stored depth 与 raster depth 做 `equal` 需要跨实现验证。

```wgsl
// clear = 0.0
// class 0..6 -> 0.125, 0.250, ... 0.875
fn class_depth(cls: u32) -> f32 {
  return f32(cls + 1u) * 0.125;
}

@fragment
fn fs(@builtin(position) p: vec4f) -> @builtin(frag_depth) f32 {
  let key = textureLoad(visibility_key, vec2i(p.xy), 0).r;
  if !vis_valid(key) { discard; }
  return class_depth(vis_class(key));
}
```

这里写 `frag_depth` 只发生在这个分类 pass；真正昂贵的 material shader 不写深度。WebGPU 规范提供 `depthCompare:"equal"`，但规范不保证所有实现都以同样方式提前拒绝 fragment。因此 Phase 1 的性能 gate 必须分别在 Chrome/Dawn + 主要桌面 GPU 上测 depth16/depth32。

## 7.4 Material Kernel Shading

随后在同一个 Surface render pass 内最多绘制 7 个 fullscreen triangle，每个 pipeline specialization 对应现有一个 material kernel class。vertex shader 把 fullscreen triangle 的 z 设为该 class 的固定 depth；material class depth attachment `load`，`depthWriteEnabled=false`，`depthCompare="equal"`。Surface MRT 只 clear 一次。

```wgsl
override OENGINE_ACTIVE_KERNEL_CLASS: u32 = 0u;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let xy = fullscreen_triangle(i);
  let z = f32(OENGINE_ACTIVE_KERNEL_CLASS + 1u) * 0.125;
  return vec4f(xy, z, 1.0);
}

// Pipeline:
// depthStencil.format = classDepthFormat
// depthWriteEnabled = false
// depthCompare = "equal"
```

Material FS 不再从 `ShadeWork[vertex_index]` 反推 pixel。它直接使用 `@builtin(position).xy` 读取 VisibilityKey。通过 `vis_slot(key)` 得到 ExactRasterRecord，再执行当前 7 类 shader 的材质逻辑。

ClassDepth 快路径必须保留一个无需该附件的 correctness fallback：使用 `depthCompare="always"`，并在 fragment shader 最前面比较 `vis_class(key)` 与 pipeline class，不匹配立即 `discard`。适配器首次验证或 image parity 失败时使用 fallback；Tile backend 不是 correctness fallback。ClassDepth pass 和 Surface pass 之间不得采样仍作为可写 attachment 的 classDepth；二者必须是两个结束完整的 render pass。

## 7.5 Active Kernel Mask

当前 worst case 固定 7 draw 很小，但仍应避免画场景中完全不存在的类。`GpuPackedSceneRegistry` 已维护 material classification 状态，可增加 `activeKernelMask`（7 bits）与每类 opaque/MASK instance presence 计数，material patch 时增量更新并支持 abort rollback。

该 mask 是 late-bound runtime state，不属于建图时冻结的 `MaterialClassificationFrame`。Surface pass 的 execute callback 每帧从当前 runtime 读取它。M3 的 correctness baseline 先固定发出 7 个 draw；只有 late-binding/patch/abort 测试通过后才允许启用 mask 跳过。mask 只能减少 draw，绝不能决定 key 的合法性。

## 7.6 Phase 1 删除内容

- `render/VisiblePixelClassifier.ts`
- `shaders/visible_pixel_classification.ts`
- `GPU_SHADE_WORK_RECORD_STRIDE` 与 screen-sized ShadeWork capacity 计算（确认无其它消费者后删除）
- `PackedMaterialResolvePass` 中 `classifier.encode()`、scan scratch、pixel queue drawIndirect
- point-list vertex shader 与 `shade_work` binding
# 8. Phase 2：Adaptive TriangleSetup Cache

> **为什么不是“所有 exact triangle 都分配 48 B setup”**
>
> 当前 transient pool 已接近预算上限。若 TriangleSetup 按 `hierarchyRasterWorkCapacity × 2` 全量预分配，会在高几何场景引入很大的常驻/临时内存。更好的策略是只缓存“大屏幕三角形”——它们正是重复 barycentric setup 最浪费的对象；微三角形继续走现有解析 fallback。

## 8.1 新 ExactRasterRecord

```text
struct OEngineExactRasterRecord {
  instance_record_index: u32;
  geometry_record_index: u32;
  meshlet_record_index: u32;
  local_triangle_index: u32;
  material_handle: u32;
  raster_flags: u32;
  setup_index: u32;     // 0xffffffff = fallback
  exact_flags: u32;     // SetupValid / NearCrossing / ...
} // 32 B
```

建议新建 `gpu/GpuExactRasterAbi.ts`，不要继续扩张通用 `GpuWorkGenerationAbi.ts`。上游 HierarchicalWorkGenerator 继续生成 24 B RasterWork；ExactTriangleFilter 的下游产品升级为 32 B ExactRasterRecord。这样 shadow/transparent 等其它 work consumer 不被主视图 material 需求污染。

## 8.2 Bounded TriangleSetupCandidateQueue

```text
struct TriangleSetupRecord {
  // 9 × f32 = 36 B; + flags/padding = 40 B
  q_center_0: f32; q_center_1: f32; q_center_2: f32;
  dqdx_0: f32;    dqdx_1: f32;    dqdx_2: f32;
  dqdy_0: f32;    dqdy_1: f32;    dqdy_2: f32;
  flags: u32;
}
```

默认按“字节预算”而不是 triangle capacity 定容量，例如 8 MiB / 40 B ≈ 209k setup records。只有投影包围盒面积或估计 coverage 超过阈值（首轮建议 16/32 pixels A/B）的三角形才尝试 reserve。队列满时只把 `setup_index=INVALID`，材质结果仍然正确。

这里缓存的是 ExactTriangleFilter 保留的候选，不是 Hardware Visibility 后的最终可见 triangle。被遮挡的大三角形可能提前占满队列，原子 reservation 顺序也不承诺稳定。M5 必须先把该策略作为 `candidate-cache` A/B，并增加 heavy-overdraw/large-occluder profile。只有 `visiblePixelSetupHitRatio` 达标且跨 run 稳定时才可成为默认；否则转向 coverage bucket、按 exact slot 的 bounded sidecar，或 visibility 后的稀疏 setup producer。

## 8.3 为什么放进 ExactTriangleFilter

`exact_triangle_filter` 已经拿到了 source0/source1/source2、clip a/b/c、viewport 和最终 exact slot。把 setup 计算放这里不会新增三角形读取，也不需要再起一个 full triangle compute pass。保留 triangle 后，先 reserve exact slot；若满足 large-triangle 条件，再 reserve setup slot 并写记录。

```text
if keep {
  let exactSlot = ... reserve exact queue ...;
  var setupIndex = INVALID;

  if setup_is_safe(a,b,c) && projected_area_px(a,b,c) >= threshold {
    setupIndex = try_reserve_setup();
    if setupIndex != INVALID {
      setup_records[setupIndex] = build_setup(a,b,c, viewport);
    }
  }

  exact_records[exactSlot] = ExactRasterRecord(..., setupIndex, flags);
}
```

## 8.4 DAIS-inspired 透视插值算法（WebGPU WGSL 可直接实现）

设三角形投影到屏幕后的普通 screen-space barycentric 为 λ0, λ1, λ2。λ 对 x/y 是线性的，因此 `dλ/dx`、`dλ/dy` 对整个三角形恒定。透视正确插值可写成 qᵢ=λᵢ/wᵢ，最终权重 bᵢ=qᵢ/Σq。DAIS 的核心思想就是把这些 screen-space 线性量的 sample point 与导数按三角形存下来。

```text
// 选屏幕中心作为 reference point，降低坐标量级
center = vec2(width * 0.5, height * 0.5)

q_center[i] = lambda_i(center) * invW[i]
dqdx[i]     = dLambdaDx[i] * invW[i]
dqdy[i]     = dLambdaDy[i] * invW[i]

// 任意 pixel：
delta = pixel - center
q = q_center + delta.x * dqdx + delta.y * dqdy
bary = q / dot(q, vec3(1))
```

插值任何顶点属性 a：`a(pixel)=a0*bary.x+a1*bary.y+a2*bary.z`。UV 的 `textureSampleGrad` 梯度不要用硬件 ddx/ddy，而是解析求导。

```text
N     = Σ(q_i * uv_i)
D     = Σ(q_i)
dNdx  = Σ(dqdx_i * uv_i)
dDdx  = Σ(dqdx_i)

dUVdx = (dNdx * D - N * dDdx) / (D * D)
// y 同理
```

这套公式只需要 f32 arithmetic 和 storage buffer read，完全可移植到 WGSL。它把当前 Material FS 中“三次 world/project + determinant + bary derivative setup”移到每三角形一次。

## 8.5 Fallback 与 near-plane 安全性

当前 ExactTriangleFilter 对 near/w crossing 是 fail-open。TriangleSetup v1 不需要在第一版实现 homogeneous clipping：只要发现 `w<=0` 或 near crossing，就 `setup_index=INVALID`，Material FS 调用现有 `perspective_barycentric_with_derivatives()`。这让 Phase 2 是纯性能缓存，不改变可见性正确性。

## 8.6 对大三角形 / 小三角形分别优化

| 场景 | 策略 | 原因 |
| --- | --- | --- |
| 贴脸 cube / 地面 / 墙面 | 使用 cached TriangleSetup | 少量 triangle 被百万像素复用，摊销极高 |
| 中等 triangle | 阈值 A/B 决定 | ALU 节省与 setup buffer bandwidth 需要测量 |
| 1~数 pixel 微三角 | 不建 setup，走 fallback | cache coherence 差且 setup record 可能比重新算更贵；保留 VisBuffer quad 优势 |
| near-crossing | fallback | 避免 Phase 2 引入复杂 clipping 与精度 bug |

## 8.7 Velocity 的后续简化

Phase 2 的确定收益只宣称消除每像素重复 projection、determinant 和 barycentric derivative setup。当前 geometric normal 仍依赖三个 position；除非 setup record 增加可验证的 face-normal/position reconstruction 数据，否则 velocity-off 不能宣称完全不读取 position attribute。

velocity-on 可以在独立后续实验中尝试用主 depth + inverse view-projection 重建 current world position，再乘 `previous_from_current` 和 previous VP，避免仅为 motion 再读取三个 position。该实验不属于 M5 验收条件，必须先确认 `ViewManager` 的 viewport/projection/reverse-Z convention。

# 9. Phase 3：Surface ABI v2

当前 Surface v1 为 22 B/pixel（无 velocity）或 26 B/pixel（有 velocity）。Phase 1/2 首先解决执行架构；Surface ABI 改动应放后面，以免同时改变 shader correctness 和 bandwidth。

| Attachment | 当前 | Phase 3 原则 |
| --- | --- | --- |
| PBR | rg8unorm / 2 B | 保留可能性高 |
| Normal | rgba16uint / 8 B | 优先测能否减少 geometric/shading normal 双存储；不先拍脑袋压缩 |
| Albedo+AO | rgba8unorm / 4 B | 保留 |
| Emissive | r32uint / 4 B | 评估是否可条件化/折叠 |
| Velocity | rg16float / 4 B | 继续 feature-conditioned，不需要时不创建 |
| Metadata | r32uint / 4 B | 保留稳定语义；可评估 bit packing |

性能目标不是一个固定“16 Bpp”数字，而是按 downstream consumers 做证据驱动删减：关闭某 feature 时，其 attachment 必须能被 FrameGraph prune；SurfaceFrame 保留语义字段，不允许 Renderer 按 attachment 顺序猜含义。

`SurfaceFrame` 同时携带 `abiVersion`。所有 producer/consumer 必须在 seam 处校验该版本；M6 v2 不能只替换纹理格式而让 v1 consumer 静默读取。当前 v1 producer 和 Lighting consumer 已接入该检查。

# 10. Phase 4：Tile Material Backend（可选）

如果 Phase 1 在某些 WebGPU 实现上出现 7 个 fullscreen depth-equal pass 固定成本过高，或未来 kernel class 超过 7 类，再引入 NanoMesh/Wicked 风格 tile backend。它不是第一阶段依赖。

```text
VisibilityKey v3
   ↓
TileClassMaskPass (建议 16/32/64 tile A/B)
   每 tile 输出 7-bit mask
   ↓
compact class tile lists
   ↓
Class 0: draw/dispatch only relevant tiles
Class 1: draw/dispatch only relevant tiles
...
   ↓
Surface
```

桌面 WebGPU 初始建议测试 32×32；NanoMesh 的 64×64 是移动平台与其材质系统下的经验值，不能直接当作 OEngine 常数。若只有 1~2 类材质覆盖整屏，tile build 可能得不偿失，因此 backend 应由 benchmark 选择而不是默认打开。

## 10.1 M6/M7 证据 artifact 合同

后续阶段的实现触发必须由可审计 artifact 驱动，而不是由源码形状或一次本地测量推断：

- **M6 Surface ABI v2**：每个候选 run 必须携带唯一 `runId`、`runGroupId`、`sessionId`，并同时记录 baseline/candidate 的 attachment bytes per pixel、resident bytes、transient peak、conversion pass 数和 correctness parity。至少三个独立 session 全部 parity、每次 attachment bytes 下降、无 conversion pass 且 resident/transient peak 不增加，才允许把 v2 layout 接入生产 consumer；缺少任一字段时保持 v1 并报告 `insufficient-evidence`，有明确负收益时报告 `rejected-by-evidence`。
- 当前 M6 candidate contract 只冻结 `normal: rgba8uint`（v1 为 `rgba16uint`）、`octahedral-unorm-trunc`（candidate max value=255）对应 schema 和 CPU oracle，预期在 velocity-on 时从 26 B/pixel 降至 22 B/pixel；schema 还固定 velocity-off Bpp 与三次独立 run 的 parity/conversion/resident/transient promotion gate。它不接入默认 RenderTargets，也不改变 `GPU_SURFACE_ABI_VERSION = 1`，直到上述 gate 通过。
- 实现中以 `GPU_SURFACE_ABI_V1_PROFILE` 与 `GPU_SURFACE_ABI_V2_CANDIDATE_PROFILE` 作为 active/candidate 的单一 profile 来源；candidate profile 仅供 isolated benchmark 使用。
- `PackedMaterialResolvePass` / `SurfaceFeature` 的 profile seam 允许 isolated producer 生成版本化 v2 SurfaceFrame；默认 Renderer 仍构造 v1，所有 consumer 在 seam 处按同一 profile 校验，避免半迁移路径静默混用。
- Direct Lighting、AO、SSR、GI/IBL/LPV/Brick4、Opaque Resolve 与 Render Debug shading-normal 已支持显式 profile specialization；candidate 可以进入完整 Packed composition A/B，bent-normal 仍保持独立 16-bit 合同。
- SSR descriptor 仅对包含 Surface normal decoder 的阶段注入 candidate specialization，prefilter-only 阶段保持无 override；默认仍是 v1。
- SSAO raw/spatial/joint-resolve 具备同一 specialization seam；bent-normal 仍固定 16-bit，避免 candidate 压缩改变 AO 方向语义。
- Brick4 diffuse/specular/fused descriptor 已具备同一 profile specialization；GIService 仍默认 v1，candidate 只能在完整 GI composition A/B 中启用。
- `GIService` / `OpaqueLightingPipeline` 以单一 profile 原子配置 IBL specular、Opaque resolve、Brick4 与 LPV provider，isolated candidate 不需要逐 pass 切换；生产默认仍为 v1。
- RendererConfig 提供启动期 `surfaceAbiProfile`，Rendering Lab 通过 `?surfaceAbiProfile=v2-candidate` 启动独立实验；禁止在已初始化 Renderer 上热切换 profile，以保持 FrameGraph/resource identity 稳定。
- candidate profile 只接受 Packed Scene producer；legacy MaterialExpand 仍生产 v1，若误用 candidate 会在 FrameGraph 建图边界明确失败。Rendering Lab report 从 runtime migration evidence 写入真实 active ABI/profile，保证候选 capture 不会被静态 v1 常量误标。
- **M7 Tile backend**：每个 vendor 至少提供满足正式 run 数量的独立 artifact，记录 ClassDepth+Resolve 与已验证 tile prototype/model 的 P50/P95、样本覆盖和同一 `runGroupId` 下的 run/session 身份。只有至少两个 vendor 的 P50 或 P95 均超过 tile 对照 10% 才创建 tile queue/backend；否则报告 `not-needed-by-evidence` 或 `insufficient-evidence`，不保留无消费者的 tile 资源、pass 或 submit。
- 在 gate 触发前，`TileBackendCostModel` 只作为 debug/benchmark model：输入 row-major class ids，输出固定 16/32/64 tile 的 7-bit mask、bounded record overflow 和 class-tile dispatch 工作量；它不创建 GPU queue、pass 或 runtime backend，也不替代跨 vendor 的真实 prototype/model timing。
- Rendering Lab report 将这些输入保存在 `domainEvidence.surfaceAbiRuns` / `tileBackendRuns`，并生成 `surfaceAbi.v2Gate` 与 `migrationGates`；没有候选 artifact 不得被序列化为通过。
- Rendering Lab fixture 的 benchmark API 可以显式接收上述 identity-bearing artifacts 以及 evidence-only tile model input；默认 run 不提供这些字段，不会伪造候选证据或创建 tile runtime。
- `profile-formal.mjs` 支持通过 `OENGINE_SURFACE_ABI_PROFILE=v1|v2-candidate` 选择独立启动期 profile，并将 profile 写入 artifact；baseline/candidate 的配对与 correctness/memory 字段仍必须来自正式 A/B 采集，不能由脚本默认推断。
- Renderer 在设备初始化时用 7 个 class 的真实 GPU readback 验证 `depth32float + depthCompare="equal"`；失败会在 Surface owner 创建前选择 `class-discard`，并记录 backend、选择来源和原因。Rendering Lab 可用内部 `OENGINE_MATERIAL_RESOLVE_BACKEND=class-depth|class-discard` seam 固定 A/B，公开 `RendererConfig` 不暴露迁移 backend。
- formal runner 默认保持 TriangleSetup off；只有 `OENGINE_TRIANGLE_SETUP_ENABLED=true` 才分配 setup cache，threshold 由 `OENGINE_TRIANGLE_SETUP_THRESHOLD_PIXELS` 控制。off 状态必须保持 `setupRecords=null`，没有 setup FrameGraph resource 与 setup clear。

# 11. 与 Renderer / FrameGraph 的集成

## 11.1 Renderer 应看到的接口

```text
const visibility = visibilityFeature.addToGraph(...); // VisibilityFrame
const classes = surfaceFeature.classifyToGraph(graph, visibility);
const surface = surfaceFeature.resolveToGraph(
  graph,
  materialJob,
  visibility,
  classes,
  { velocity: needsVelocity }
);

// Renderer 不再持有：
// packedVisibilityDebug
// PackedVisibilityDebugSource
// ShadeWork details
```

Renderer 只做 feature orchestration，不关心 ExactRasterRecord、setup queue、material class depth 的具体 layout。SurfaceFeature 变成真正的 owner，而不是 `PackedMaterialResolvePass` 的薄壳。

## 11.2 MaterialResolveBackend 接口

```ts
export interface MaterialResolveBackend {
  readonly kind: "class-depth-raster" | "tile";

  classify(
    graph: FrameGraph,
    visibility: VisibilityFrame,
    job: MaterialResolveJob
  ): MaterialClassificationFrame;

  resolve(
    graph: FrameGraph,
    visibility: VisibilityFrame,
    classification: MaterialClassificationFrame,
    job: MaterialResolveJob
  ): SurfaceFrame;
}
```

第一阶段只实现 `ClassDepthRasterBackend`。接口存在的目的不是制造“双管线”，而是把 Material Execution Policy 从 Visibility/Renderer 中隔离；所有 backend 必须消费相同 VisibilityFrame 并输出相同 SurfaceFrame。

# 12. 文件级改造清单

| 动作 | 路径 | 职责 |
| --- | --- | --- |
| 修改 | OEngine/src/gpu/GpuVisibilityKeyAbi.ts | ABI v3：29-bit slot + 3-bit kernel class；CPU/WGSL encode/decode oracle。 |
| 修改 | OEngine/src/gpu/GpuInstanceAbi.ts | 增加 kernel class bitfield；扩展 material classification mask。 |
| 修改 | OEngine/src/gpu/GpuPackedSceneRegistry.ts | stage + material patch 写 kernel class；维护 activeKernelMask / class counts。 |
| 修改 | OEngine/src/gpu/GpuScene.ts | 拆分 resourceEpoch/contentRevision，内容 patch 不重建 WorkSet。 |
| 新增 | OEngine/src/gpu/GpuExactRasterAbi.ts | 32 B ExactRasterRecord、setup handle/flags、packing/oracle。 |
| 修改 | OEngine/src/render/ExactTriangleFilter.ts | 输出 ExactRasterFrame；Phase 2 加 bounded setup buffers。 |
| 修改 | OEngine/src/shaders/exact_triangle_filter.ts | 写 ExactRasterRecord；大三角形 build TriangleSetup；near-cross fallback。 |
| 修改 | OEngine/src/shaders/packed_visibility.ts | VisibilityKey v3 encode；OPAQUE 从 instance flags 取 kernel class。 |
| 修改 | OEngine/src/render/passes/PackedVisibilityPass.ts | 移除生产用途 debugResolve；正式 expose exact resources。 |
| 修改 | OEngine/src/render/features/VisibilityFeature.ts | 拥有 VisibilityWorkSet / 正式 VisibilityFrame。 |
| 修改 | OEngine/src/render/pipeline/FrameProducts.ts | 增加 ExactRasterFrame / VisibilityFrame / MaterialClassificationFrame。 |
| 新增 | OEngine/src/render/MaterialResolveBackend.ts | Surface backend contract。 |
| 新增 | OEngine/src/render/passes/PackedMaterialClassDepthPass.ts | VisKey → class depth。 |
| 新增 | OEngine/src/shaders/packed_material_class_depth.ts | fullscreen class-depth WGSL。 |
| 重写 | OEngine/src/render/passes/PackedMaterialResolvePass.ts | 移除 classifier/point-list；7 bounded fullscreen class draws。 |
| 重写 | OEngine/src/shaders/packed_material_resolve.ts | 直接按 frag_coord 取 key；setup fast path + fallback。 |
| 修改 | OEngine/src/render/features/SurfaceFeature.ts | 成为 classifier + backend owner。 |
| 删除* | OEngine/src/render/VisiblePixelClassifier.ts | Phase 1 A/B 通过后删除。 |
| 删除* | OEngine/src/shaders/visible_pixel_classification.ts | 同上。 |
| 修改 | OEngine/src/render/Renderer.ts | 只传正式 FrameProduct；删除 packedVisibilityDebug 生产依赖。 |
| 修改 | OEngine/src/debug/GpuFrameCounters.ts | 新增 class-depth/setup hit/fallback/overflow counters。 |
| 修改 | OEngine/src/debug/profiling/ResourceAccounting.ts 及 owner 接入点 | exact/setup persistent cache 与 ClassDepth transient 分类、创建/销毁证据。 |
| 修改 | docs/porting/visibility.md、docs/README.md、文档 allowlist | 固定上游 revision/license/差异并接入文档系统。 |
| 新增/修改 | OEngine/tests/... | ABI、数学 oracle、image parity、near plane、benchmark gates。 |

# 13. 迁移顺序、回滚与兼容

| 里程碑 | 内容 |
| --- | --- |
| M0 — Measurement Harness | 先加入 surface GPU timestamps：classify / resolve / lighting，新增 close-cube、projection-normalized、heavy-overdraw effects-off profile。旧路径不动。 |
| M1 — Formal Products | 拆分 resourceEpoch/contentRevision；把 debugResolve 生产依赖替换成 ExactRasterFrame / VisibilityFrame；WorkSet 与 diagnostic bindings 分离，不改变 shader。 |
| M2 — VisibilityKey v3 | 加入 kernelClass bits；所有旧算法 consumer 同时改用 v3 helper 只解低 29 bit；CPU/WGSL oracle 验证越界不别名。 |
| M3 — ClassDepth Backend | 实现 MaterialClassDepth + fullscreen kernel material；用 config/benchmark flag A/B。 |
| M4 — Remove Pixel Queue | 新路径满足 correctness + perf gate 后删除 VisiblePixelClassifier / ShadeWork。 |
| M5 — Adaptive TriangleSetup | 先以 8 MiB bounded cache + 32 pixel threshold 落地；保留每像素 fallback。 |
| M6 — Surface ABI v2 | 单独做 attachment/bandwidth A/B。 |
| M7 — Tile backend（如需要） | 只有跨浏览器/硬件数据证明 class-depth fullscreen 固定成本是热点才实现。 |

回滚策略：M3/M5 在开发期保留 benchmark-only flag，例如 `materialResolveBackend="legacy-pixel-queue" | "class-depth" | "class-discard"`、`triangleSetupEnabled`。这些 flag 不进入长期公开 interface。完成多硬件 gate 后删除 legacy；class-discard 仅作为 adapter correctness fallback。不要长期把 legacy 变成第三条产品管线。

# 14. 验证、测试和观测体系

## 14.1 GPU Counter

| Counter | 意义 |
| --- | --- |
| material.classDepthPixels | ClassDepth pass 有效 VisKey 像素 |
| material.classDraws | 本帧实际 active kernel draws（0..7） |
| material.visiblePixelsByClass[7] | profiler sampling cadence 下的精确 GPU histogram；普通帧不生产 |
| material.setupAttempted | 超过 coverage threshold、尝试申请 setup 的 exact candidates |
| material.setupWritten | 成功写入 setup queue 的 candidate 数 |
| material.setupVisiblePixelHits | 最终 Surface 中实际消费 setup 的 pixel 数 |
| material.setupVisiblePixelFallbacks | 最终 Surface 中因 near crossing / queue full / invalid setup 走旧公式的 pixel 数 |
| material.setupOverflow | bounded queue reserve 失败次数 |
| material.surfaceBytesPerPixel | 继续保留 |
| visibility.exactTriangles | 和 shaded pixels 一起用于 triangle/pixel density 分析 |

上述 pixel histogram/setup pixel counters 只能在 profiler counter cadence 或独立 counter-coverage profile 中执行，不得在普通稳定帧加入 fragment atomic。`material.classDepthPixels` 优先复用现有最终 Visibility 有效像素统计；若需要按类 histogram，使用独立 sampled reduction pass，并在未采样帧报告 unavailable。diagnostics 关闭时不得保留该 pass、counter copy、readback 或额外 submit。

## 14.2 Correctness Tests

- VisibilityKey v3 encode/decode：随机 slot/class、sentinel、容量边界。
- VisibilityKey v3 越界 slot/class：GPU/CPU 都产生 invalid，禁止截断别名到合法 slot。
- GpuPackedSceneRegistry stage/material patch：kernel bits 与 materialKernelClass() 一致，abort rollback 正确。
- activeKernelMask：cached graph 复用、runtime 切换、material patch/abort 后读取当前 late-bound 值。
- MaterialClassDepth：7 类固定值、empty discard、depth16/depth32 精确 equal。
- 旧/新 Surface image diff：BaseFactor/BaseTexture/ORM/Normal/Emissive/Unlit/Generic 各一例。
- MASK alpha test：VisibilityKey class 与透明/alpha 路由不串。
- TriangleSetup CPU oracle：随机三角形 + 随机 pixel，对比现有 perspective_barycentric_with_derivatives。
- near-plane / mirrored / double-sided / degenerate triangle：setup fallback 与旧路径一致。
- velocity on/off：motion flags、previous_from_current、camera motion parity。
- resource lifecycle：counter cadence 切换不创建第二份 WorkSet；scene release/resource epoch/device loss/destroy 后记账归零。
## 14.3 Benchmark Profiles

| Profile | 目的 | 关键指标 |
| --- | --- | --- |
| cube-far / cube-near effects-off | 复现用户核心症状 | Surface GPU ms、visible pixels、class draws、setup hit ratio |
| Rendering Lab 4/6/10/18/32/56m | 保持现有距离归因 | GPU Surface phase 随 shadedPixels 的曲线 |
| projection-normalized | 固定 pixel coverage，隔离 geometry density | Surface vs Visibility 时间 |
| microtriangle stress | 验证不伤害高密度优势 | 旧/新 Surface + total GPU |
| heavy-overdraw / large occluder | 验证 candidate setup 不被不可见大三角垄断 | setup written、visible-pixel hit/fallback、overflow、run 离散度 |
| material mosaic 7 classes | 压测 fullscreen class depth | class-depth fixed cost / tile backend 触发条件 |
| near-plane motion | 正确性与 fallback | setupFallback、image diff、GPU ms |

# 15. 性能预期与验证原则

本 RFC 不把性能百分比作为设计前提。重构的直接目标是删除当前 `VisibilityKey → Surface` 中不必要的像素重排与 synthetic point primitive 层，并把大三角形的重复 TriangleSetup 从“每像素”摊销到“每三角形”。

预期收益主要来自三点：

- **Phase 1**：删除 `VisiblePixelClassifier`、递归 scan、scatter、screen-sized `ShadeWork` 以及 point-list material resolve，降低固定全屏调度和像素队列读写。
- **Phase 2**：对大屏幕三角形使用 bounded `TriangleSetup` cache，减少每个 visible pixel 重复进行的投影、determinant、barycentric derivative setup。
- **Phase 3**：若后续测量证明 Surface MRT 明显受带宽限制，再单独压缩 Surface ABI；不与前两阶段正确性重构耦合。

性能验证不看单一 FPS，而按 pass 拆分 `Visibility / MaterialClassDepth / MaterialResolve / Lighting` 的 GPU timestamp，并重点比较 `cube-near`、`cube-far`、Rendering Lab 距离组和 microtriangle stress。

正式 A/B 沿用 Rendering Lab 的 1920×1080、DPR 1、固定 seed、120 warm-up + 480 measured frames、timestamp cadence 8、counter cadence 11；每个 release Gate 至少三个独立 run，并同时报告 P50/P95/P99 与样本覆盖。M0 smoke 使用 30+60，只用于开发回归。

阶段量化 Gate：

- M1：shader 输出 bit-identical；counter sink/cadence 切换不增加 WorkSet 数或 resident work-cache bytes。
- M2：全部 key oracle 通过；越界 encode 只产生 invalid；invalid/overflow 在正式 workload 为 0。
- M3：Phase 1 Surface attachments 相对 legacy bit-identical；`cube-near` Surface GPU P50 至少改善 15%、P95 至少改善 10%；microtriangle total GPU P50/P95 回归均不超过 5%。如果 ClassDepth 未达标，保留 class-discard 结果并停止 M4 删除。
- M4：删除 legacy 后，FrameGraph 不再包含 count/prefix/add/scatter/ShadeWork；普通帧无对应 Buffer、readback、counter copy 或额外 submit。
- M5：Phase 2 metadata/emissive 必须 bit-identical；albedoAo/PBR 解码值 P99 绝对误差不超过 1/255，normal P99 角误差不超过 0.5°，velocity P99 误差不超过 0.05 internal pixel，且无 NaN/Inf；heavy-overdraw 的 `visiblePixelSetupHitRatio` 三个 run 均不低于 90%，否则 candidate-cache 不设为默认。
- M6：只在相同正确性下接受 Surface ABI；新路径 resident/transient 峰值不得高于旧路径，且全局预算状态必须如实报告，已有超预算不能被写成通过。
- M7：只有至少两个 GPU vendor 上 M3 的 MaterialClassDepth+Resolve P50 或 P95 比经过验证的 tile prototype/模型高 10% 以上，才进入正式实现；否则状态为 `not-needed-by-evidence`，不是未完成。

# 16. 风险与缓解

| 风险 | 后果 | 缓解 |
| --- | --- | --- |
| WebGPU 实现对 depth-equal fullscreen 的 early reject 不理想 | 7 draw 固定成本高 | M3 多 GPU/浏览器 gate；Tile backend 作为替代 |
| depth-equal 在适配器上 image parity 失败 | Surface 丢像素 | 自动切 class-discard correctness fallback，记录 diagnostics；该 adapter 不启用 ClassDepth |
| VisibilityKey v3 改 ABI | debug/counter/oracle 全部受影响 | 集中在 GpuVisibilityKeyAbi，版本化测试，禁止手写 bit 操作散落 shader |
| material patch class 不同步 | 错材质 kernel | class bits 由 registry 单一函数生成；stage/patch 共用 |
| TriangleSetup 容量过大 | transient/resident 爆炸 | bounded byte budget + coverage threshold + fallback |
| 不可见大三角占满 setup queue | 可见像素 hit ratio 低且 run 不稳定 | heavy-overdraw Gate；coverage bucket/sidecar/visibility 后 producer 备选 |
| TriangleSetup 数值误差 | 纹理 mip/normal 抖动 | CPU oracle + image diff；near crossing fallback |
| Phase 1 对微三角回归 | 破坏核心定位 | microtriangle acceptance gate ≤5% 回归 |
| 同时改 Surface ABI | 难以定位 correctness/perf | Phase 3 延后，逐阶段 A/B |
| Renderer 再次吸收 backend 细节 | 架构重新耦合 | Renderer 只传 FrameProduct；backend 内部资源不可外泄 |

# 17. 验收标准

| Gate | 验收条件 |
| --- | --- |
| Correctness | 按 M3/M5 数值阈值验证 7 个 kernel class、MASK、motion、near-plane；不得以“无不可解释差异”代替阈值 |
| Architecture | 生产路径不再依赖 `PackedVisibilityDebugSource`；FrameGraph 能显式展示 exact/visibility/classification/surface 依赖 |
| Close-camera | M3 三次独立 run：Surface P50 ≥15%、P95 ≥10% 改善 |
| High-density | microtriangle total GPU P50/P95 回归均 ≤5% |
| Memory | 报告 exact delta=`16 × classCapacity`、ClassDepth、setup cache 和删除项的 owner/峰值；新路径不高于旧路径且不伪造全局预算通过 |
| TriangleSetup | cache overflow 或 near-crossing 时必须正确 fallback，不能影响最终图像正确性 |
| Portability | baseline 不依赖 mesh shader、subgroup、bindless descriptor heap 或 64-bit atomics |

# 18. 参考资料

[O1] EEngine / OEngine baseline commit a5ea18f. https://github.com/bigbigbig2/EEngine/tree/a5ea18f494ebfaaf6cdff77503c951339ce70948 — 本文所有“当前实现”判断以此 commit 为基线。

[R1] Burns & Hunt, The Visibility Buffer: A Cache-Friendly Approach to Deferred Shading (JCGT 2013). https://jcgt.org/published/0002/02/04/ — 4-byte visibility buffer 与 deferred attribute reconstruction 的基础参考。

[R2] Karis et al., Nanite: A Deep Dive (SIGGRAPH Advances 2021). https://advances.realtimerendering.com/s2021/Karis_Nanite_SIGGRAPH_Advances_2021_final.pdf — Visibility 与 deferred material 解耦、高三角密度设计背景。

[R3] Bevy meshlet renderer (wgpu), commit `b70463f072a3380ebb37c8803f1c4941357e64fa`. https://github.com/bevyengine/bevy/tree/b70463f072a3380ebb37c8803f1c4941357e64fa/crates/bevy_pbr/src/meshlet — 重点：resolve_render_targets.wesl、material_shade_nodes.rs、visibility_buffer_resolve.wesl。

[R4] Tencent NanoMesh — Seamless Rendering on Mobile (SIGGRAPH 2024). https://advances.realtimerendering.com/s2024/content/Cao-NanoMesh/AdavanceRealtimeRendering_NanoMesh0810.pdf — Material Depth + 64×64 material tiles + Depth Equal。

[R5] Schied & Dachsbacher, Deferred Attribute Interpolation for Memory-Efficient Deferred Shading (HPG 2015). https://cg.ivd.kit.edu/publications/2015/dais/DAIS.pdf — Triangle sample point + screen-space partial derivatives。

[R6] The Forge. https://github.com/ConfettiFX/The-Forge — VisibilityBuffer2 / triangle filtering；OEngine exact filter 已记录其 WebGPU porting provenance。

[R7] Microsoft Visibility Buffer Sample. https://learn.microsoft.com/en-us/samples/microsoft/xbox-gdk-samples/visibilitybuffer/ — VisBuffer → compute shading；object/primitive ID 与解析 interpolation。

[R8] Wicked Engine graphics in 2024. https://turanszkij.wordpress.com/2024/12/10/wicked-engines-graphics-in-2024/ — material-type tile binning 与 optional visibility compute shading。

[R9] John Hable, Visibility Buffer Rendering with Material Graphs. https://filmicworlds.com/blog/visibility-buffer-rendering-with-material-graphs/ — count/prefix/pixel reorder 的 VisUtil 成本与 triangle-density 对比。

[R10] WebGPU Specification. https://gpuweb.github.io/gpuweb/ — depth compare / texture formats / pipeline 行为。

[R11] WGSL Specification. https://gpuweb.github.io/gpuweb/wgsl/ — shader storage、fragment depth、interpolation 语义。

# 附录 A. WGSL / ABI 草案

## A.1 VisibilityKey v3 CPU/WGSL 合同

```ts
export const GPU_VISIBILITY_KEY_ABI_VERSION = 3;
export const GPU_VISIBILITY_KEY_SLOT_BITS = 29;
export const GPU_VISIBILITY_KEY_SLOT_MASK = 0x1fffffff;
export const GPU_VISIBILITY_KEY_CLASS_SHIFT = 29;
export const GPU_VISIBILITY_KEY_CLASS_MASK = 0xe0000000;
export const GPU_VISIBILITY_KEY_CLASS_INVALID = 7;
export const GPU_VISIBILITY_KEY_EMPTY = 0xffffffff;
export const GPU_VISIBILITY_KEY_INVALID = 0xfffffffe;

export function tryEncodeVisibilityKey(
  slot: number,
  kernelClass: number
): Readonly<{ key: number; valid: boolean }> {
  if (!Number.isInteger(slot) || slot < 0 || slot > GPU_VISIBILITY_KEY_SLOT_MASK ||
      !Number.isInteger(kernelClass) || kernelClass < 0 || kernelClass >= 7) {
    return Object.freeze({ key: GPU_VISIBILITY_KEY_INVALID, valid: false });
  }
  return Object.freeze({
    key: (slot | (kernelClass << GPU_VISIBILITY_KEY_CLASS_SHIFT)) >>> 0,
    valid: true
  });
}
```

## A.2 ClassDepth pass resource descriptor

```ts
const classDepth = builder.create("material-class-depth", {
  kind: "transient_texture",
  width,
  height,
  format: selectedClassDepthFormat, // baseline "depth32float"; optional A/B "depth16unorm"
  usage: GPUTextureUsage.RENDER_ATTACHMENT
});
```

## A.3 Surface material pass pseudo-pipeline

```ts
for (let cls = 0; cls < 7; cls++) {
  if ((activeKernelMask & (1 << cls)) === 0) continue;
  pass.setPipeline(materialPipeline[cls][velocity ? 1 : 0]);
  pass.setBindGroup(0, materialGroup);
  pass.draw(3, 1, 0, 0); // kernel class 由 pipeline override 固定
}

// depthStencil:
//   format = classDepthFormat
//   depthCompare = "equal"
//   depthWriteEnabled = false
```

# 附录 B. TriangleSetup 数学推导

令屏幕三点为 p0=(x0,y0)、p1、p2。普通重心坐标满足 λ0+λ1+λ2=1，并且每个 λ 是 x,y 的一次函数，因此导数在整个三角形内为常量。以下是可直接在 ExactTriangleFilter 中实现的一种形式：

```text
D = (y1-y2)(x0-x2) + (x2-x1)(y0-y2)

dλ0/dx = (y1-y2) / D
dλ0/dy = (x2-x1) / D

dλ1/dx = (y2-y0) / D
dλ1/dy = (x0-x2) / D

dλ2/dx = -(dλ0/dx + dλ1/dx)
dλ2/dy = -(dλ0/dy + dλ1/dy)
```

在 reference point c 计算 λ(c)，再乘 `invW` 得 q。透视正确权重是 `q / Σq`。对于 UV/normal/color 等顶点属性都可共用同一 bary；只对 UV 额外用 quotient rule 求 dUVdx/dUVdy。OEngine 当前 Y 轴与 viewport transform 约定必须通过 CPU oracle 对齐，不能直接复制论文符号方向。

Adaptive cache 的关键是：这个 setup 只有在 triangle 的 screen coverage 足够大时才值得存。ExactTriangleFilter 已有 fixed-point small-primitive 判断，可复用其 screen-space 坐标，并新增粗略 bbox/area 估计。第一版 threshold 不应硬编码为最终产品值，而应配置到 benchmark profile 中。

# 附录 C. Benchmark 矩阵

| 变量 | 取值 |
| --- | --- |
| 分辨率 | 1280×720 smoke；1920×1080 release；可加 2560×1440 |
| Material backend | legacy pixel queue / class-depth / tile（后期） |
| TriangleSetup | off / threshold 16 / 32 / 64 pixels |
| ClassDepth format | depth32float baseline / depth16unorm optional A/B |
| 场景 | cube、Rendering Lab、microtriangle、7-class mosaic |
| 相机 | static far/near、normal interaction path、projection-normalized |
| 效果 | effects-off；full；full-minus-shadow（用于隔离） |
| 硬件/浏览器 | 至少 NVIDIA / AMD / Intel 各一；Chrome/Dawn 主线，条件允许补 Edge |

每个正式 profile 建议：独立 warm-up；至少 300~500 measured frames；GPU timestamp 与 counter 不要每帧强制 readback；报告 P50/P95、置信区间或重复 run 离散度。近景性能问题尤其要同时记录 `shadedPixels / exactTriangles / setupHits / classDraws`，否则 FPS 数字无法归因。

RFC 结论：先把 Visibility→Surface 的执行模型改正确，再继续做局部缓存。
