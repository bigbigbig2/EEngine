# ADR-0008 · GPU-driven Geometry 与 Visibility V2

> **Status:** accepted
> **Date:** 2026-09-10
> **Scope:** GPU Geometry Work Generation、LOD/Hierarchy、Raster Work、Exact 路径、VisibilityKey
> **Depends on:** ADR-0007 的 compact geometry / instance contract
> **Feeds:** ADR-0009 的 Compute Shading / FrameProducts
> **Proposed supersession:** 接受并完成 cutover 后，替代 ADR-0004 的 per-triangle work identity 与 VisibilityKey material-class 决策；此前 ADR-0004 仍是当前权威
> **Design source:** `OEngine Performance Architecture V2` Design Draft

## Context

OEngine 当前已经是 Hardware-first、GPU-driven 的 Visibility 架构，这个方向不需要推翻。当前真正的问题是 GPU-driven 工作粒度过细。

生产 ABI 已经说明当前路径的成本形态：

```text
GpuWorkGenerationAbi
  per-triangle RasterWork
  stride ≈ 24 B

GpuExactRasterAbi
  per-triangle ExactRasterWork
  stride ≈ 32 B

TriangleSetup
  additional per-triangle setup record
```

并且当前 VisibilityKey 与 frame-local raster/exact work table 紧密耦合。

一个选中的 meshlet/cluster 在真正 Hardware Raster 前可能经历：

```text
Hierarchy / Cluster acceptance
        ↓
展开为 per-triangle work records
        ↓
ExactTriangleFilter
        ↓
再次生成 per-triangle exact records
        ↓
Hardware Visibility
```

这会导致：

- 选中 meshlet 数增加时，queue bytes 按 triangle 数放大；
- 同一 primitive 在 Work Generation、Exact、Hardware Raster 中重复读取 geometry；
- Visibility identity 被临时 per-triangle table 绑死；
- 相机靠近、SSE refine、微三角形密度上升时 Geometry phase 容易出现 work amplification；
- 后续 Material Resolve 又需要从 VisibilityKey 反查这些 work records。

本 ADR 的任务不是“让 GPU-driven 更复杂”，而是让 normal path 回到更粗粒度：

> **普通路径按 meshlet 调度；triangle 只作为最终硬件 primitive 和局部 identity。**

## Decision

Geometry Frontend V2 采用：

```text
GpuScene
   ↓
Instance / Geometry visibility
   ↓
Flat or Hierarchy-local strategy
   ↓
Cluster/Meshlet cull
   ↓
GpuMeshletRasterWork
   ↓
GPU compact / bucket queue
   ↓
Bounded indirect hardware raster
   ↓
VisibilityKey V2 + Depth
```

ExactTriangleFilter 从所有 triangle 的 mandatory stage 降为：

```text
correctness-risk path
```

Large Triangle Setup 作为独立 performance cache candidate，不再和 correctness risk 混为同一概念。

WebGPU 2026 Desktop 主要使用：

```text
subgroups
primitive-index
indirect-first-instance
```

Capability fallback 保持同一逻辑 ABI 和 FrameProducts，不形成第二 Renderer。

能力协商、WGSL enable、feature dependency 和证据格式统一遵循 [WEBGPU.md](../WEBGPU.md)。`subgroups` 不代表固定 lane width；只有显式启用 `subgroup-size-control` 并验证目标 size 时才允许固定宽度算法。

---

## 1. Preserved invariants

以下继续保持：

- Hardware raster 是普通生产路径。
- GPU 负责形成最终 raster/dispatch work。
- CPU 不读取本帧 GPU queue count 再循环发 draw。
- bounded 数量的 pass/draw 可以由 CPU encode，但 consumer count 来源必须是 GPU indirect args。
- stable frame 不扫描 Scene object tree 生成最终 visible list。
- HZB、frustum、cone、SSE/LOD 可以继续存在。
- 一帧仍由 `MainRenderPipeline` / FrameGraph 统一 encode，并保持一个 main submit。
- feature/candidate off 时不留下多余 queue、clear、readback 或 submit。
- overflow 不能静默丢掉 correctness-critical visible work。

---

## 2. Work granularity

### 2.1 Normal work unit

V2 normal path 的调度单位是：

```text
Meshlet Work
```

而不是：

```text
Triangle Work
```

逻辑字段至少能够恢复：

```text
instance
geometry
meshlet
material/raster state
vertex profile
LOD/profile metadata
```

本 ADR 不把 stride 写死为 16/20/24B；由 CPU/WGSL ABI、alignment、cacheline 和 downstream access 决定。

### 2.2 Why meshlet

Meshlet 已经是 Cooker/Hierarchy 的自然 GPU unit，可承载：

```text
bounds
cone
material/raster-state homogeneity
bounded vertices
bounded triangles
LOD/hierarchy mapping
```

把它作为 normal queue record，可以避免为同一 meshlet 中每个 triangle 重复写：

```text
instance
geometry
meshlet
material
flags
```

### 2.3 Triangle remains the primitive

本 ADR 不改变硬件 triangle-list primitive。

Triangle 仍负责：

- hardware clipping；
- hardware raster；
- depth；
- primitive identity；
- VisibilityKey local primitive 部分。

变化仅在于：triangle 不再必须先拥有一条常规 GPU work record。

---

## 3. GpuMeshletRasterWork ABI

初始逻辑字段：

```text
instance_slot
geometry_slot
meshlet_slot
material_slot_or_range
packed_raster_flags
packed_profile_lod
```

必须可以独立恢复：

```text
current transform
previous transform/motion
compact geometry profile
meshlet-local indices
material kernel class
cull/raster flags
debug identity
```

### 3.1 Material homogeneity

首选 Cooker 保证：

```text
one meshlet work
→ one material/raster-state class
```

如果真实 asset 的 material boundary 导致 meshlet 填充率严重下降，可以研究：

```text
meshlet subrange work
```

但不允许在 raster shader 中对每 triangle 任意 material branching。

### 3.2 CPU/WGSL oracle

每个 ABI 必须有：

```text
CPU pack/unpack
WGSL layout
stride/alignment check
boundary values
invalid generation
```

这是必须保留的轻量测试，因为 ABI 错误会直接造成 GPU silent corruption。

---

## 4. Queue Infrastructure

### 4.1 Common contract

Meshlet/Risky/Material 等 queue 共享设计原则，但不要求同一 element layout。

统一 header 语义：

```text
attempted_count
written_count
consumed_count
capacity
overflow_count
generation
reserved...
```

`attempted_count` 可以超过 capacity，用于观察真实申请；`written_count` 只能统计 index `< capacity` 的安全写入，`overflow_count = attempted_count - written_count`。`consumed_count` 由 GPU consumer/debug counter 解释实际消费，不能由 CPU 猜测。

每个具体 queue ABI 还必须声明：

```text
element schema / stride / alignment
capacity derivation
producer
GPU consumer
indirect record offset and complete initialization
CorrectnessCritical or OptionalOptimization
overflow action
```

`MeshletRasterWork`、Risk/Exact 与任何影响可见结果的 queue 都是 `CorrectnessCritical`：Geometry budget/LOD 必须在 append 前把 worst-case 控制在已分配 capacity 内；若仍发生 overflow，受影响 indirect args 清零、该帧标记失败并保留上一张可呈现结果或明确 diagnostic，不允许呈现截断后的部分几何。`LargeTriangleShadingSetup` 是 `OptionalOptimization`：overflow 必须回退到逐像素 setup，并计数，不影响像素正确性。

### 4.2 WebGPU 2026 Desktop append

WebGPU 2026 Desktop 首选：

```text
per lane test
   ↓
subgroup ballot
   ↓
subgroup prefix/count
   ↓
one/few global reservations
   ↓
contiguous scatter
```

目的：

- 减少 global atomic contention；
- 让 queue output 更连续；
- 减少 shared-memory/prefix plumbing。

### 4.3 Capability fallback append

Fallback：

```text
workgroup-local count
+
shared-memory prefix
+
one global atomic reservation/workgroup
```

必要时保留简单 per-thread atomic 作为 diagnostic baseline，但不把它作为长期性能中心。

### 4.4 Consumer

GPU producer 写：

```text
queue
+
indirect draw args
```

CPU 只 encode bounded consumer：

```text
bucket draw 0
bucket draw 1
...
```

不能：

```text
GPU writes count
↓
CPU readback
↓
CPU for-loop draw
```

---

## 5. Meshlet Bucket Raster

### 5.1 Why buckets

WebGPU 主路径不假设 mesh shader。

为了用标准 indirect draw 处理不同 meshlet triangle count，可把 meshlet work 分到少量 bounded bucket。Bucket 同时也是 pipeline-compatible work 的边界，不能只按 triangle count 分类。

初始候选：

```text
≤ 32 triangles
≤ 64
≤ 96
≤ 128
```

这只是 benchmark starting point，不是永久 ABI。

完整逻辑 key 冻结为：

```text
MeshletBucketKey
= triangle_capacity_class
× vertex_decode_profile
× raster_pipeline_class
× coverage_class
```

其中 `raster_pipeline_class` 至少覆盖会改变 WebGPU render pipeline 或 fixed-function state 的 topology、cull/front-face、depth/sample 约定；`coverage_class` 区分 opaque 与需要 `EvaluateCoverage()` 的 MASK 等合法 visibility variant。一个 bucket draw 内不得逐 instance 改变这些状态。

初始化根据 cooked profiles、目标 feature set 与 pipeline limits 冻结 `max_bucket_keys`，为每个合法 key 建立一个完整 indirect record。超出组合上限的 Runtime Package 在发布前失败；不通过动态创建无界 pipeline/draw 数吸收内容。

### 5.2 Raster mapping

每个 bucket 的 draw：

```text
vertex_count_per_instance = bucket_triangle_capacity * 3
instance_count            = GPU queue count
```

Vertex shader：

```text
work = MeshletQueue[instance_index]
local_triangle = vertex_index / 3
corner         = vertex_index % 3

if local_triangle >= actual_triangle_count:
    output all three vertices outside the clip volume
else:
    local index
    → compact vertex
    → transform
```

启用 `indirect-first-instance` 时，可以把多个 bucket region 放入共享 queue，并令 indirect `firstInstance` 指向 region base；vertex shader 使用包含该 base 的 `instance_index`。缺失该 feature 时，所有 indirect record 的 `firstInstance` 必须为 0，每个 bucket 绑定独立 queue view/固定 region base，`instance_index` 从 0 定位。两种 specialization 输出同一 `meshlet_work_identity`，并通过目标 adapter parity 验证；非零 `firstInstance` 不能出现在 fallback indirect record 中。

### 5.3 Primitive identity

WebGPU 2026 Desktop 优先使用：

```wgsl
@builtin(primitive_index)
```

获得 rasterized local primitive identity。

这样 VisibilityKey 可以直接表达：

```text
meshlet_work_slot + local_primitive
```

而不必把 local triangle identity 复制到 per-triangle work record。

缺少 `primitive-index` 时，vertex shader 根据 `vertex_index / 3` 计算 `local_triangle: u32`，并以 `@interpolate(flat)` 的整数 user-defined output 将同一值传给三个 corner 的 fragment invocation。该 varying 与 `primitive_index` specialization 必须通过逐 primitive oracle；它只替代 local primitive input，不替代 meshlet work identity。

### 5.4 Padding evidence

Bucket 会产生 padding invocation。

必须记录：

```text
actual_triangles
bucket_capacity_triangles
padded_vertex_invocations
padding_ratio
meshlets_per_bucket
```

如果 padding 抵消 queue 节省，应调整 bucket boundaries，或研究 alternative indirect layout。

### 5.5 Multi-draw

若目标浏览器/WebGPU 后续正式暴露高质量 multi-draw 能力，可以作为 encode optimization。

它不是本 ADR 的逻辑前提：

```text
Queue ABI
VisibilityKey
MeshletWork
```

不得依赖 multi-draw 才成立。

---

## 6. VisibilityKey V2

### 6.1 Logical identity

V2 冻结逻辑语义：

```text
VisibilityKeyV2
=
meshlet_work_identity
+
local_primitive_identity
```

不再冻结当前 per-triangle exact work slot。

### 6.2 Frozen physical layout

Step 4 冻结：

```text
bits  0..23  meshlet_work_slot
bits 24..31  local_primitive
```

`local_primitive` 的有效范围固定为 `0..127`，与当前 meshlet triangle ceiling 一致；`128..255` 全部非法。这样 `0xffffffff`（empty）与 `0xfffffffe`（invalid）不会和任何有效 key 冲突。`meshlet_work_slot` 最大为 `0x00ffffff`，单帧最多寻址 `16,777,216` 条 work；超过该容量必须在资源准备阶段失败，不能截断。

当前只支持 partition 0。partition 不占用 key bit，而由 `MeshletWork.packed_profile_lod` 的高 8 bit 与绑定的 queue partition 共同验证。generation 也不占用 key bit，由同一 `VisibilityFrame` 携带的 queue header generation 约束；generation 为 0、queue generation 不匹配或 partition 非 0 时不得解引用。由此以下边界均已冻结：

```text
max visible meshlet works/frame
meshlet max triangle count
empty/invalid representation
risk-path identity
future capacity（超过 24-bit slot 时必须升级 ABI/partition contract）
```

如果未来 32-bit 不足，只能通过新 ABI 研究：

```text
partitioned tables
two-word key
separate high bits
```

而不是静默截断。

### 6.3 Material class

Material kernel class 不再强制塞进 VisibilityKey。

优先从：

```text
MeshletWork
→ material slot
→ material kernel class
```

恢复。

如果实际 shading classification 证明这次 indirection 更贵，再以 evidence 讨论 cached bits；不能为了沿用旧布局把 material class 永久绑定进 key。

### 6.4 Normal/risk path parity

Normal、Selective Exact、LargeTriangle Setup 最终必须写完全相同逻辑语义的 key。

ADR-0009 不应该知道 pixel 来自哪条 raster subpath。

### 6.5 Frame-local lifetime

物理 `meshlet_work_slot` 只在当前 frame/queue generation 内有效。VisibilityKey consumer 必须在对应 MeshletWork queue 被复用前完成；key 的 physical bits 不得作为跨帧 stable asset、material、temporal 或 history identity。

Temporal/SSR 只能使用 Velocity、MotionValidity、RepresentationChange 与明确的 persistent generation 判断历史有效性。Debug capture 若跨帧保存 key，必须同时保存 queue generation 与可重放映射，generation 不匹配时视为 invalid。

---

## 7. Selective Exact correctness path

### 7.1 Exact 的新角色

ExactTriangleFilter 从：

```text
all triangles mandatory
```

改为：

```text
only triangles/meshlets with demonstrated correctness risk
```

### 7.2 Risk categories

初始候选：

```text
near/camera-plane crossing
clip-space numerical risk
degenerate / nearly-degenerate
special conservative MASK coverage case
special winding/two-sided correctness case
debug/oracle forced exact
```

这里必须区分：

```text
correctness risk
≠
performance cache opportunity
```

### 7.3 Risk classification hierarchy

尽量分层：

```text
Cook-time static risk
   ↓
Meshlet projection risk
   ↓
route risky meshlet away from normal buckets
   ↓
expand and exact-raster all triangles in that meshlet
```

普通 meshlet 不进入 per-triangle exact shader。

Step 5 冻结第一版实现为单个 canonical MeshletWork queue 的双 route 分区：`0..31` 为 normal bucket，`32..63` 为 selective-exact bucket。GPU classifier 在 compact 后、prefix/scatter 前读取当前 camera、Instance/Geometry/Meshlet 与 vertex/index payload；`ForceExact`、MASK special coverage、near/clip boundary、非有限投影和 nearly-degenerate 投影进入 risk route。普通 two-sided 仍由 mirrored-winding-aware fixed-function pipeline 处理；只有 oracle/debug 显式 `ForceExact` 时才因 two-sided 身份进入 risk，避免把整个双面场景误判为 correctness risk。

Risk meshlet 的全部 local primitive 由它所在的 exact bucket 间接绘制展开；normal 32 个 bucket 不包含该 work，exact 32 个 bucket 不包含 safe work。两条 route 共享 canonical work slot，因此均写第 6 节的同一 VisibilityKey V2，不存在跨表 identity 转换。

### 7.4 Overflow

Risk queue overflow 是 correctness failure。

不允许：

```text
overflow
→ silently drop triangle
```

Risk/Exact queue 按第 4 节属于 `CorrectnessCritical`。生产 capacity 必须由 `max risky triangles` 与 worst-case expansion 在 append 前受控；运行时 overflow 时清零受影响 indirect args、整帧失败并保留上一张可呈现结果或显示明确 diagnostic。不得让已经安全写入的前半条 queue 被当成完整结果继续呈现。

第一版不做第二次 risk append：risk 是 canonical correctness-critical MeshletWork queue 内的互斥 partition，因而继承同一 attempted/written/overflow/generation header。任一 compact、scatter、validation 或 bucket overflow 都在 raster 前把 64 条 indirect record 的 `instance_count` 全部清零；不能只清 risk half 或只清发生 overflow 的 bucket。

### 7.5 Normal/Exact exclusivity

第一版以 meshlet 为互斥路由边界：被判定为 correctness-risk 的 meshlet 不再进入 normal bucket，而是展开其全部 triangle 进入 Exact 路径；Exact 路径负责写同一 reverse-Z Depth 与 VisibilityKey 语义。这样同一 primitive 不会被 Normal/Exact 重复 raster 后依赖 depth-equal 顺序仲裁。

后续若要只抽取 meshlet 内的 risky subset，必须先定义 safe/risky primitive 的互斥 bitset/subrange 和 oracle；禁止同一 primitive 同时进入两条路径。

---

## 8. Large Triangle Setup Cache

### 8.1 Separate from Exact

当前 TriangleSetup 的思想保留，但改定位为：

```text
LargeTriangleShadingSetup
```

候选依据：

```text
projected pixel coverage
expected shading reuse
```

而不是 correctness risk。

### 8.2 Purpose

缓存：

```text
projected vertices
barycentric coefficients
gradient-related data
```

使 ADR-0009 的 compute shading 不必为覆盖大量 pixels 的同一个 triangle 重复做完整 setup。

### 8.3 Gate

记录：

```text
setup_records
setup_build_gpu_ms
setup_bytes
setup_hit_pixels
fallback_pixels
reuse_ratio
overflow
```

只有 amortized saving 为正才启用。

Step 5 冻结独立 owner `LargeTriangleSetupCache`。它不读取 ExactRasterWork，也不改变 risk 分类；仅在显式启用时分配最多 8 MiB 的 40 B setup records，并以 `meshlet_work_slot * 128 + local_primitive` 做 frame-local dense 映射。超过 cache bound、near crossing、degenerate、非有限或低于 projected coverage threshold 均保持逐像素 reconstruction fallback。Material Resolve 可以直接消费命中 record；关闭时没有 cache resource、build dispatch、evidence dispatch 或 readback。

---

## 9. Flat vs Hierarchy local strategy

### 9.1 One renderer, local strategy

不是所有 geometry 都必须走完整 hierarchy。

同一个 Work Generation Feature 根据 cooked metadata 选择：

```text
Flat meshlet cull
Shallow hierarchy
Full hierarchy
```

这不是第二套 Renderer。

### 9.2 Flat candidate

适合：

```text
very few meshlets
hierarchy overhead > direct meshlet tests
small props
simple proxies
```

仍由 GPU：

```text
instance/geometry table
→ meshlet cull
→ MeshletWork queue
```

禁止退回 CPU 每帧 meshlet traversal。

### 9.3 Cooker hint

ADR-0007 可以生成：

```text
recommended_visibility_path
meshlet_count
hierarchy_depth
coarse cost hint
```

Runtime 可覆盖 hint，但不能依赖 CPU scene scan。

GeometryDirectory V2 的 cooker hint 冻结为 `flags[7:5]` 的 one-hot 编码：

```text
bit 5 = Flat
bit 6 = Shallow
bit 7 = Full
```

`oengine-geometry-cooker-v2.1.0` 根据 `hierarchy present / meshlet_count / hierarchy_depth` 写入 hint，并在 cook evidence 中记录 `recommendedVisibilityPath` 与 `visibilityCoarseCostHint = meshlet_count + cluster_count`。无 hint 的旧 V2 包只在 residency 时推导一次，frame loop 不扫描 CPU scene。第一版阈值为：无 hierarchy 选 Flat；有 hierarchy 且 depth ≤ 2 或 meshlet_count ≤ 64 选 Shallow；其余选 Full。Shallow 最多 refine 到 depth 2，Full 使用完整深度；三者共享同一 GPU instance cull、VisibleCluster、MeshletWork 与 VisibilityKey V2 consumer。

---

## 10. Geometry budget and hysteresis

### 10.1 Problem

静态 SSE 只表达质量误差，不表达：

```text
这一帧最多能承受多少 geometry work
```

近距离/复杂场景可能把 selected meshlets、risk work、raster vertices 一起推高。

### 10.2 GeometryWorkBudget

统一表达：

```text
max tested hierarchy nodes
target/max meshlet work
target/max raster vertices
max risky triangles
max setup bytes
```

Budget 影响 LOD/refinement 决策，而不是在 queue 已生成后静默截断 visible work。

### 10.3 Dynamic SSE

Adaptive 模式可以根据延迟统计调整 measured geometry work / target，但必须有：

```text
hysteresis
dead zone
slow recovery
camera-cut reset
quality floor
```

Benchmark 使用 fixed SSE/fixed budget，避免 adaptive quality 掩盖回归。

`GeometryWorkBudget` 的冻结字段为 `maxTestedHierarchyNodes / targetMeshletWork / maxMeshletWork / targetRasterVertices / maxRasterVertices / maxRiskyTriangles / maxSetupBytes`。`maxTestedHierarchyNodes` 约束有界 traversal reservation，溢出时选择可呈现父 cluster；`maxMeshletWork` 约束 correctness-critical MeshletWork queue，不能容纳完整 reservation 时沿用全 queue draw args 清零的 fail-visible 合同；`maxSetupBytes` 直接限制 optional setup owner，cache 不足逐像素 fallback。meshlet、raster vertex 与 risk 的 delayed truth sample 只用于下一帧 refinement pressure，禁止在 queue 生成后静默裁掉 visible work。

Adaptive SSE 冻结为 10% dead zone、过载快速上调、4% 慢恢复和显式 quality-floor SSE 上限。`indicate_view_change()` 将其重置到 authored base SSE；fixed 模式不订阅反馈、不改变 SSE，正式综合 benchmark 必须保持 fixed。

### 10.4 Representation changes

LOD/page representation 变化应输出 temporal signal，使 ADR-0009 history 降低 confidence。

当前 fully-resident LOD 的 representation signal 是 VisibilityKey V2 identity 自身：refinement cut 改变时 MeshletWork/local primitive identity 改变，ADR-0009 的 identity history comparison 必须降 confidence；同一 cut 的稳定生成顺序保持 identity 稳定。未来 page residency 不能复用这个隐式条件，必须按 ADR-0007 的 generation/partition 生命周期增加显式 page-generation signal。

---

## 11. WebGPU 2026 Desktop capability specialization

无论 capability：

```text
MeshletWork
→ indirect hardware raster
→ VisibilityKey V2
```

逻辑语义一致。

WebGPU 2026 Desktop preferred：

```text
subgroups
primitive-index
indirect-first-instance
```

Fallback：

```text
workgroup prefix/atomic
flat local-triangle varying
firstInstance = 0 + bucket-local queue base
```

`shader-f16` 只用于非 identity/precision-critical intermediates。

对应 Shader variant 分别使用 `enable subgroups;`、`enable primitive_index;` 和 `enable f16;`，且只能在 feature 已进入 `device.features` 后创建；`primitive_index` 只解决 fragment primitive input，不替代 work slot、meshlet identity、barycentric 或 derivative 合同。

---

## 12. Migration plan

### Step 0 · Geometry truth

**Scope**

增加能解释 work amplification 的 counters：

```text
nodes tested
clusters accepted
meshlets selected
meshlet works produced
candidate triangles
risky triangles
exact survived
raster triangles
padded vertices
visible pixels
queue bytes
```

**Verification:** DEV + PERF baseline

**Exit**

能区分 LOD/refinement、queue、exact、raster、padding 各自成本。

### Step 1 · MeshletWork ABI

**Scope**

定义 CPU/WGSL ABI；让当前 pipeline 在 non-production candidate seam 中生成 MeshletWork，暂不替换 production visibility。

**Verification:** DEV + MILESTONE

**Exit**

ABI/oracle/capacity/overflow 正确；没有 CPU consumer 回读。

### Step 2 · WebGPU 2026 Desktop queue generation

**Scope**

subgroup compact path、portable fallback、bucket classification、GPU indirect args。

**Verification:** MILESTONE + PERF

**Exit**

producer/consumer count 闭合；无 overflow；subgroup path 在目标 GPU 上有可解释的 contention/phase 或复杂度收益。

### Step 3 · Bucket hardware raster

**Scope**

标准 indirect bucket draw、compact vertex profile、primitive identity、reverse-Z/depth/culling parity。

**Verification:** MILESTONE + PERF

**Exit**

opaque/double-sided/MASK 基础 visibility parity 通过；padding evidence 可接受。

### Step 4 · VisibilityKey V2

**Scope**

冻结逻辑 key；normal producer；current material/debug consumer 迁移；risk path parity seam。

**Verification:** MILESTONE

**Exit**

ADR-0009 只依赖 key 逻辑语义，不依赖旧 ExactRasterWork slot。

### Step 5 · Selective Exact + LargeTriangle Setup

**Scope**

risk classifier、risky triangle expansion、exact correctness path、independent large-triangle setup cache。

**Verification:** MILESTONE + PERF

**Exit**

near-plane、degenerate、MASK/two-sided correctness workloads 通过；normal path 的 exact work 接近零或仅剩明确 risk。

### Step 6 · Flat/Hierarchy + Geometry Budget

**Scope**

cooked path hint、local strategy、hysteresis、fixed/adaptive budget。

**Verification:** MILESTONE + PERF

**Exit**

small geometry workload 不因 hierarchy 固定税明显回退；near/far workload cost 更稳定；fixed benchmark deterministic。

### Step 7 · Cutover and deletion

删除：

```text
normal per-triangle RasterWork
mandatory Exact path
old VisibilityKey semantics
dead counters/layouts/shaders
```

只保留真正 selective risky ABI。

**Verification:** MILESTONE + final PERF

**Exit**

production normal visibility 不再依赖旧 per-triangle work table。

---

## 13. Verification

公共 DEV/MILESTONE/PERF 强度、Browser Runner、证据持久化和性能比较遵循 [`VALIDATION.md`](../VALIDATION.md)。本 ADR 只增加以下领域 Gate：

- Geometry truth：hierarchy test、selected meshlet、candidate/risky/exact/raster triangle、padding、visible pixel 与 queue bytes 必须能解释 work amplification；ADR 开始前保存正式 baseline。
- MeshletWork ABI：stride/alignment、instance/geometry/meshlet identity、material/raster flags、LOD/profile、generation、capacity 和 overflow 必须有 CPU/WGSL oracle；candidate 路径不得通过 CPU readback 成为 consumer。
- Queue generation：目标 adapter 的 subgroup specialization 与 portable fallback 使用同一 compact oracle，覆盖零/单元素、实际 subgroup 边界、partial workgroup 和 capacity 边界；`attempted/written/consumed` 在无 overflow 时闭合。
- Bucket raster：CPU 计算的 bucket 与 padding 结果必须匹配 GPU counter；opaque、double-sided、MASK、reverse-Z、culling 与 primitive identity 通过真实浏览器 parity，padding primitive 不得产生有效 VisibilityKey。
- VisibilityKey V2：sentinel、work slot、local primitive、generation/partition 和 normal/risk parity 必须有 CPU/GPU oracle；下游 consumer 只能依赖逻辑 identity，不能继续读取旧 ExactRasterWork slot。
- Selective Exact：near-plane、degenerate、MASK/two-sided 等 risk 在集成 Scenario 中覆盖；correctness-critical overflow 必须失败，optional cache overflow 必须 fallback 并计数，normal 与 exact 路径不得重复或漏画。
- Flat/Hierarchy 与 Geometry Budget：正确性和正式 A/B 使用 fixed budget；adaptive 仅验证边界、hysteresis 和无振荡，不能通过自动降质隐藏回归。

PERF 重点比较 Geometry GPU phase、GPU frame envelope、queue bytes、candidate/accepted/exact work、PaddingRatio、ExactRatio、selected meshlets、raster triangles、visible pixels 和 overflow。最终 formal group 覆盖基础、near/far、occlusion-heavy 与 geometry-heavy workload，并证明 production normal path 不再依赖 mandatory per-triangle work。

---

## 14. Consequences

### Positive

- normal path 从 O(triangles) 中间 work records 收敛到 O(meshlets)。
- Visibility identity 与 temporary exact table 解耦。
- Subgroups/primitive-index 真正服务 WebGPU 2026 Desktop 主路径。
- ExactTriangleFilter 回到 correctness guard 的定位。
- 为 ADR-0009 compute shading 提供稳定 primitive identity。
- Geometry budget 可以解决 camera-near 等 worst-case work spike，而不靠 silent drop。

### Costs

- Bucket padding 可能增加 vertex invocations。
- Raster shader 需要 meshlet-local index decode。
- Material homogeneity 会反向约束 Cooker。
- Risk classifier 需要严谨 correctness workload。
- VisibilityKey 迁移会影响 debug/material consumers。
- WebGPU 2026 Desktop 与 fallback kernel 都需要最小 parity 维护。

### Deferred

```text
Mesh/task shader
full software raster
hybrid software/hardware raster
production multi-draw dependency
GPU-driven world streaming
virtualized geometry paging
```

---

## 15. Porting / research ledger

主要进入：

```text
docs/porting/visibility.md
docs/porting/geometry.md
docs/porting/platform.md
```

重点研究：

```text
meshoptimizer meshlet conventions
Nanite/public GPU-driven geometry material
meshlet indirect raster without mesh shader
WebGPU subgroups
WebGPU primitive-index
GPU queue compact/prefix algorithms
```

任何移植记录：

```text
upstream revision
license
retained invariant
OEngine/WebGPU difference
added resource/dispatch cost
local benchmark
```

---

## 16. Completion criteria

ADR-0008 当前范围完成时：

- normal visibility work unit 是 meshlet，不是 per-triangle record；
- GPU producer → indirect consumer 闭环成立；
- VisibilityKey V2 与 old ExactRasterWork identity 解耦；
- Selective Exact 只处理明确 correctness risk；
- LargeTriangle Setup 是独立、可裁剪 cache candidate；
- queue capacity/overflow/attempted/written/consumed 可以解释，correctness-critical overflow 不会呈现部分结果；
- bucket key 覆盖 triangle capacity、decode profile、pipeline/raster 与 coverage compatibility；
- VisibilityKey 的 frame-local generation 与 temporal/history 边界明确；
- Flat/Hierarchy 是同一 Work Generation Feature 内局部策略；
- fixed geometry budget 可用于 deterministic benchmark；
- production normal path 的旧 ABI/shader/counter 已删除；
- `PIPELINE.md` 只在 cutover 后更新为真实新链路。
