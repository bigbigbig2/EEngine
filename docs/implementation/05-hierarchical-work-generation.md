# 05 · R3 层次工作生成与 Hardware Consumer

Status: R3-A、R3-B、R3-C Completed；R3-D Planned / Next；G3 尚未关闭

长期决策见 [ADR-0009](../wiki/adr/0009-r3-cluster-hierarchy-work-generation.md)，上游来源、许可证与采用边界见 [R3-01 移植登记](../references/porting/R3-01-hierarchical-work-generation.md)。本文件只拥有执行顺序、工程契约、验证和删除条件。

## 阶段目标

R2 已经把 Meshlet、可渲染 Cluster hierarchy、Geometry/Cluster/Meshlet GPU records 和 Packed Instances 驻留到 GPU。R3-C 已经在大规模 Meshlet 展开前完成实例剔除、Cluster hierarchy/SSE 选择和 compact work generation，并由现有 fixed-function Hardware Visibility `drawIndirect()` consumer 直接消费。旧 `compact_packed_meshlets()` 现在只作为内部 paired reference，待 R3-D 删除：

```text
Packed InstanceTable + resident Geometry/Cluster/Meshlet tables
→ Instance Frustum Cull
→ RootTraversalQueue
→ Cluster hierarchy ping/pong traversal
→ Selected VisibleCluster records
→ RasterWork queue
→ GPU writes complete drawIndirect arguments
→ existing Hardware Visibility vertex pulling consumer
```

从 RootTraversalQueue 开始，数量和工作项全部由 GPU 产生并由 GPU 消费。CPU 只提供 view、驻留表、配置、容量和 FrameGraph topology；不得 readback 可见数量来决定当前帧 draw/dispatch。

R3 的性能假设是“层次选择减少 Raster 前工作量后，总 GPU 时间在目标高密度场景中下降”。R3-C paired 数据只在 B 证明该假设；A 虽减少 90.1% RasterWork，但总 Visibility P50 因三个大规模 `workgroup_size(1)` 阶段回退 14.1%；C 则暴露约 0.262 ms 固定成本。因此不得宣称 hierarchy 普遍更快，R3-D 必须继续处理粒度、queue bandwidth 和低密度短路。

## 首版冻结决策

### Cluster hierarchy 是 R3 v1 的正确性主干

当前 `GeometryBvh8` 是对全部 Cluster 的独立空间索引，leaf 同时可能包含 LOD parent 和 descendant；它没有编码“选择当前 parent 或展开 children”的互斥 cut。若先用当前 BVH8 筛 Cluster 再独立做 SSE，可能同时选择同一 hierarchy 的父节点和子节点，造成重复绘制或不稳定 LOD。

因此 R3 v1：

- 从每个 Geometry 的 Cluster hierarchy root 开始遍历；
- 每个节点在同一状态机内执行空间拒绝、SSE 判定、选择或展开；
- 当前 R2 BVH8 保留为设备无关 package 数据、validator/调试结构和后续 profile 候选，不进入 R3 v1 热路径；
- 若未来使用 BVH8，必须先获得与 LOD cut 对齐的数据语义或新增独立 adapter，并通过 parent/child 互斥 reference 与 paired benchmark；不得把当前 BVH8 直接插入主链。

这不推翻 R2 对 BVH8 数据正确性的结论，只限定其当前 runtime consumer。

### 首个闭环只启用 Frustum + SSE

R3-B 首先对齐 CPU/GPU 的 `Instance Frustum + Cluster Frustum + SSE` 选择集合。Cone 和 previous-frame HZB 在该闭环正确之后由 R3-D 逐项加入：

```text
Frustum + SSE reference 对齐
→ Cone（镜像/非均匀变换先保守关闭）
→ previous HZB（camera cut/resize/首帧 fail-open）
```

这样画面缺失时可以区分 hierarchy、transform、SSE、cone 与 reverse-Z/HZB 错误。

### R3 不提前创建 Software Raster 工作

R3 的真实 consumer 是 Hardware Visibility。SW/Hybrid 属于 R4-C：

- R3 可以在稳定 record flags 中保留未来分类位；
- 没有 SW consumer 时不得创建 SW queue、counter、BindGroup、Pass、readback 或 submit；
- alpha-tested 工作先保留显式分类/Hardware fallback，完整 alpha contract 由 R4-A 冻结；
- 不设计 HW/SW 两套产品管线。

## 当前真实入口与迁移边界

| 当前入口 | 当前事实 | R3 处理 |
|---|---|---|
| `OEngine/src/shaders/packed_visibility.ts` | hierarchy Hardware consumer 读取 RasterWork；flat producer 仍可由内部 paired 开关启用 | R3-C 已替换生产 work 输入；R3-D 删除 flat producer 分支 |
| `OEngine/src/render/passes/PackedVisibilityPass.ts` | 生产 hierarchy 路径直接消费 RasterWork 和 16 B indirect record；flat 只用于 paired reference | 保留 Hardware vertex pulling/Visibility 输出不变量；R3-D 删除 paired flat 接线 |
| `OEngine/src/gpu/GpuPackedSceneRegistry.ts` | 长期 Scene 关联与待删的 frame-local flat work owner 仍并存 | 保留 Scene/asset/instance/material 关联；R3-D 删除 flat queue/indirect owner |
| `OEngine/src/geometry/GeometryHierarchy.ts` | CPU selector 主要验证单资产 object-space hierarchy | R3-A 升级成 multi-instance CPU oracle，不进入性能主帧 |
| `OEngine/src/geometry/GeometryBvh8.ts` | 所有 Cluster 的独立空间索引 | R3 v1 不消费；保留 package/validator，后续由证据决定 |
| legacy `MeshletDrawList`/bucket/scan/expand | 旧 Scene consumer | Packed R3 通过后核对调用方；只删除已被统一新链替换且无 consumer 的部分 |

重构默认迁移真实调用方并删除死代码，不给 flat producer 保留公开兼容 interface。

## 深 Module 与 interface

R3 新建内部深 module `HierarchicalWorkGenerator`。复杂的 round 调度、Queue header、原子预约、SSE、容量、fallback 和统计都留在 implementation 内，Renderer/FrameGraph 只跨一个稳定 seam：

```ts
interface HierarchicalWorkGenerator {
  prepare(scene: PackedSceneBindings, view: ViewBindings, config: WorkGenerationConfig): PreparedWork;
  addToGraph(graph: FrameGraph, prepared: PreparedWork): GeneratedRasterWork;
}
```

逻辑输出：

```text
GeneratedRasterWork
├─ VisibleCluster table/range
├─ Hardware RasterWork queue
├─ complete 16-byte drawIndirect args
└─ frame evidence/counter bindings
```

调用方不得知道或操作：

- ping/pong queue 和 round 数；
- Queue header 的 byte offset；
- atomic reservation 与 capacity fallback；
- Cluster children 展开顺序；
- SSE/HZB 数学；
- indirect arguments 字段写法。

Frame-local traversal/selected/raster buffers 和间接参数由该 module 管理。`GpuPackedSceneRegistry` 只关联长期 Scene、InstanceSet、Geometry assets 与 material dictionary，不再拥有 frame-local flat work queue。

当前只需要一个 implementation，不为假想的第二种 traversal 提前建立公开 adapter seam。未来若 local-stack 与 wavefront 都经 benchmark 保留，它们仍隐藏在同一 interface 和输出 ABI 后。

## 目标数据流与 producer/consumer

| 阶段 | Producer | 输出 | Consumer |
|---|---|---|---|
| InstanceCull | Compute，读取 InstanceTable/view | RootTraversalQueue | hierarchy round 0 |
| Hierarchy round N | Compute，读取 current queue + Cluster table | next queue 或 VisibleCluster | round N+1 / Raster expansion |
| Raster expansion | Compute，读取 VisibleCluster + selected Cluster | RasterWork | Hardware vertex shader |
| Indirect fill | GPU Compute，可与 expansion 合并但要保持 ABI 可测 | 16 B `drawIndirect` record | Hardware render pass |
| Evidence | 各真实 producer 的原子 counter | fixed evidence schema | sampled readback/benchmark，不决定本帧调度 |

所有跨 workgroup 的 producer/consumer 排序依靠独立 Compute Pass 和同一 command encoder 中的编码顺序；不得假设 `storageBarrier()` 能同步不同 workgroup。

## Queue ABI v1

ABI 先在 R3-A 以一个可审查的 TypeScript schema/显式常量冻结，再生成或验证 WGSL offsets。未冻结前以下为目标逻辑布局，禁止下游散落手写 stride。

### TraversalWork · 8 bytes

```text
instanceRecordIndex  u32  // GpuScene record index
clusterRecordIndex   u32  // resident global Cluster record index
```

- Geometry、transform、bounds、material 通过 Instance/Cluster table 回查；
- 不重复携带 Geometry index、scale、bounds 或 child range；
- producer：InstanceCull 或上一 hierarchy round；
- consumer：下一 hierarchy round。

### VisibleClusterRecord · 16 bytes

```text
instanceRecordIndex  u32
geometryRecordIndex  u32
clusterRecordIndex   u32
materialHandle       u32
```

数组下标是 frame-local `visibleClusterSlot`。这是 R3 到 R4 VisibilityKey/Material Resolve 的稳定 lookup seam，不把 raster adapter 私有字段放进 record。

### RasterWork · 8 bytes

```text
visibleClusterSlot   u32
meshletRecordIndex   u32
```

每个被选 Cluster 的 renderable Meshlet 产生一项。Hardware vertex shader 通过 VisibleCluster 找回 Instance/Geometry/Material；只有同条件 benchmark 证明回查成本不可接受时才提案扩宽 record。

### Queue header 与 counter

每条有界队列至少保留以下独立语义：

```text
written              // 已完整写入、consumer 可安全读取的 clamped 数量
attempted            // producer 想产生的原始数量
peak                 // 本帧达到的最高 written/预约水位
overflow             // 任何容量预约失败，release 也保留 bit
fallback             // 因容量压力选择 parent 或改走 HW 的次数
```

字段缺失、真实零、unsupported 不得混为一谈。Gate 禁止把 `attempted` clamp 后冒充真实 counter，也禁止为通过测试写假值。

### Indirect arguments

- traversal 使用标准 12 B：`workgroupCountX/Y/Z`；
- Hardware 使用标准 16 B：`vertexCount/instanceCount/firstVertex/firstInstance`；
- GPU 必须写完整 record，包括固定为零的字段；
- `firstInstance` 保持 0，不把可选 `indirect-first-instance` 作为 baseline；
- buffer usage 必须包含真实 producer/consumer 所需的 `STORAGE | INDIRECT`；
- consumer 只读取基于 `written` 生成的安全数量，不读取 raw `attempted`。

## Capacity 与 fail-visible fallback

### children 必须整组预约

不能使用无界 `atomicAdd` 后只写得下部分 children。R3 使用 WGSL `atomicCompareExchangeWeak` 循环做 all-or-nothing reservation：

```text
load current written
→ current + childCount <= capacity ?
  ├─ compare-exchange 成功：预约全部 child slots，写入全部 children
  ├─ compare-exchange 竞争失败：重新读取并重试
  └─ 容量不足：不写任何 child，选择当前 renderable parent，记录 overflow/fallback
```

这部分是 OEngine/WebGPU 的 `reimplement`，借鉴 Bevy 的 wavefront scheduling，但不照搬其预分配容量假设。禁止出现“写入部分 children 后回退 parent”的重复/破洞状态。

### RasterWork 的可证明上界

不再用“所有 Instance × Geometry 所有 LOD Meshlet 总数”作为长期容量。R3-A 在资产/注册 reference 中计算任意合法 hierarchy cut 的最大 Meshlet 数：

```text
maxCutMeshlets(node) = max(
  node.renderableMeshletCount,
  sum(maxCutMeshlets(child))
)
```

Geometry 的结果写入可验证 metadata 或 runtime derived record；Packed Scene 上界为所有 Instance 对应 Geometry 的 `maxCutMeshlets` 之和。需要验证 `u32`、`maxBufferSize` 和 `maxStorageBufferBindingSize`，超过已声明能力时在创建/prepare 阶段明确拒绝，不能运行中静默截断。

### 各队列 fallback

| 队列 | 容量来源 | 失败行为 |
|---|---|---|
| RootTraversal | 当前 Packed Scene instance 上界 | 无法容纳 root 是不可恢复配置错误，拒绝 present |
| Traversal ping/pong | scene hierarchy budget + adapter limit | children 整组预约失败时选择当前 renderable parent；root 不可回退 |
| VisibleCluster | 至少覆盖合法 selected cut，或显式 budget | 在 descend 前施加预算压力并选择 parent；仍不足则 frame error |
| Hardware RasterWork | `sum(instance.maxCutMeshlets)` 的可证明上界 | 不能 overflow 后漏绘；若 owner/limit 无法满足则 prepare 失败 |
| Alpha | 后续 R4-A 冻结 | R3 不创建无 consumer 的独立 queue；保守 Hardware fallback/显式 unsupported |
| SW | R4-C profile | R3 feature-off：资源、Pass、counter、readback 全部不存在 |

## CPU reference 与数学契约

当前 CPU selector 必须先升级为 multi-instance oracle：

```text
Instance object-to-world
+ object-space Cluster bounds/error
+ perspective/orthographic view
→ conservative world bounds/error
→ selected Cluster/Meshlet set
```

CPU reference 必须覆盖：

- translation、rotation；
- uniform、non-uniform 和 negative/mirrored scale；
- perspective、orthographic；
- near-plane crossing、camera inside bounds；
- parent/child exclusive 与完整覆盖；
- 容量不足时 parent fallback；
- 非有限输入、奇异 transform 和空 hierarchy 的明确失败语义。

GPU 与 CPU 比较集合，不要求 atomic 输出顺序相同。失败随机 seed 必须保存成固定 regression。

### SSE

具体公式先从固定 Bevy 源码局部移植并以 CPU reference 固化，不凭聊天中的近似式直接写 Shader。必须保留以下语义：

- `worldError = objectError × conservativeMaxAxisScale(instance)`；
- 使用 bounds 到相机的最近保守距离，而不是仅使用 center depth；
- perspective 与 orthographic 分开计算；
- near-plane crossing/camera inside bounds 选择更细或 fail-open；
- threshold 是同一主管线的质量参数，不创建三档真实管线；
- 若启用 hysteresis，previous selection 的 owner、失效和 camera cut 语义必须独立冻结，不能用 TAA 掩盖 LOD 闪烁。

### Frustum、Cone 与 HZB

- Instance/Cluster Frustum 采用保守 world-space sphere/box reference；
- Cone 参考 meshoptimizer bounds + Niagara/Bevy 公式；non-uniform/mirrored transform 未证明前禁用 reject；
- HZB 只做遮挡，不决定当前帧 LOD；
- HZB 使用 R1 已提交的 previous reverse-Z pyramid；首帧、resize、camera cut、history discontinuity 必须 fail-open；
- HZB bounds expansion、mip 选择、nearest depth compare 先由 CPU 数值 case 验证；错误遮挡优先保留工作。

## Wavefront 调度

WebGPU baseline 不依赖跨 workgroup 全局同步、subgroup、64 位原子、MDI、mesh/task shader 或 buffer device address。R3 v1 采用 Bevy 已验证结构的 ping/pong indirect rounds：

```text
InstanceCull direct dispatch
→ round 0 dispatchWorkgroupsIndirect(current root count)
→ round 1 dispatchWorkgroupsIndirect(previous output count)
→ ...
→ round sceneMaxHierarchyDepth
→ RasterWork + drawIndirect
```

- round N 只读 current queue，写 next/selected 和下一轮完整 12 B indirect args；
- 空 queue 产生 `workgroupCountX=0`，不做 Shader 工作；
- round 数取当前 Prepared Packed Scene 的实际最大 hierarchy depth，不无条件编码 package 允许的 32/64 最大值；
- FrameGraph topology/cache key 包含 round 数和真实 feature bits；
- 超过计划 depth 仍有 work 是 hard counter/error；
- 记录 encoded/effective/empty rounds 及每轮 input/output/peak/GPU time。

若小几何场景被固定 dispatch 成本拖慢，先测量，再允许同一输出 ABI 下的 local-stack/small-geometry implementation；不得恢复 CPU visible list 或暴露第二套 Renderer interface。

## 开源实现采用方案

| 来源 | 决策 | R3 使用范围 | 明确拒绝 |
|---|---|---|---|
| Bevy Meshlet `5f8270f...` | `port` 为主 | instance→root、ping/pong indirect rounds、SSE/scale/distance、保守 frustum/HZB 结构 | Bevy BVH record、ECS、push constant、64-bit/subgroup/native backend、完整 SW/early-late 链 |
| Scthe/nanite-webgpu `b9cd33f...` | `port/reimplement` 对照 | WebGPU Compute→indirect consumer、紧凑 work item、完整 indirect record、LOD crossing/统计语义 | flat Meshlet×Instance dispatch、固定巨型 queue、demo owner、SW/HW 双端 queue |
| Niagara `eefec27...` | `port/reimplement` 数学对照 | sphere frustum、nearest-distance LOD、cone、reverse-Z HZB/mip | Vulkan push constant、mesh/task、MDI/DGC、native 8/16-bit 假设、overflow drop |
| AnKi `98d4ce3...` | `reimplement` 架构对照 | staged visibility ownership、compact queue/counter、shadow-view work generation | Vulkan DGC/MDI/bindless runtime |
| meshoptimizer `1.0.0` / `73583c3...` | 已由 R2 `adopt` | 直接消费已冻结 Meshlet/bounds/cone/hierarchy 输入 | R3 不重写 Cooker 算法 |

任何源码移植提交都必须回链 [R3-01 移植登记](../references/porting/R3-01-hierarchical-work-generation.md)，标明具体函数区段、保留 notice、精度差异和本地 regression。参考项目不能替代 OEngine 的 capacity、owner、fallback 与 paired benchmark。

## 执行包

R3 只拆成四个可运行包；包内可以有提交，但不得把“类存在/Shader 编译”当作包完成。

### R3-A · Reference、ABI 与容量冻结

目标：在 GPU 热路径修改前冻结可否决错误实现的 oracle 和数据契约。

交付：

1. 将 CPU selector 升级为 multi-instance world-space reference；
2. 冻结 TraversalWork、VisibleCluster、RasterWork、Queue header/counter 和 indirect args TS/WGSL schema；
3. 实现/验证 `maxCutMeshlets`，替代长期 flat all-LOD capacity 假设；
4. 固定 porting ledger 中的源码区段、许可证、不变量和拒绝项；
5. 增加 transform、projection、near-plane、parent/child、all-or-nothing reservation 和 fallback property tests。

退出证据：CPU selected set deterministic；ABI layout test；容量上界穷举/随机树验证；强制小容量只降 LOD、不破洞；尚未宣称 GPU hierarchy 已完成。

当前状态（2026-08-28）：Completed。

- `selectGeometryHierarchyInstances()` 已成为 multi-instance world-space CPU oracle，覆盖 Instance translation、非均匀/镜像 scale、Perspective/Orthographic、near-plane fail-open、Instance/Cluster Frustum、parent/child exclusive 和 singular transform 显式失败；
- `GpuWorkGenerationAbi` 冻结 TraversalWork 8 B、VisibleCluster 16 B、RasterWork 8 B、Queue header 32 B、dispatch indirect 12 B 与 draw indirect 16 B，并由同一 TS schema 生成 WGSL record；
- WGSL `atomicCompareExchangeWeak` 整组预约与 CPU reference 都区分 attempted/written/peak/overflow/fallback，失败不发布部分 children；
- `computeGeometryMaxCutMeshlets()`/`computePackedMaxCutMeshlets()` 已用 64 组固定随机树的全量合法 cut 穷举对照，u32 overflow 显式拒绝；
- 定向回归为 15/15；完整 `npm test` 为 148/148，并通过 production build 与 test compilation。该证据只关闭 R3-A，不声明 GPU hierarchy、浏览器画面或性能完成。

### R3-B · Cluster Hierarchy GPU Producer

依赖：R3-A。

交付：

1. `HierarchicalWorkGenerator` owner 与 frame-local resources；
2. InstanceCull → RootTraversalQueue；
3. Cluster hierarchy ping/pong indirect traversal；
4. 首版只启用 Frustum + SSE，Cone/HZB feature-off 不分配对应资源；
5. GPU selected Cluster set 的测试 readback 与 CPU reference 对齐。

退出证据：透视/正交、多 Instance/Geometry、非均匀/镜像 scale、near-plane、空 queue 和小 capacity case 通过；每轮 attempted/written/peak/overflow/fallback 为真实 producer 值；此时可以保留测试 consumer，但不能把孤立 selected buffer 写成 G3 完成。

当前状态（2026-08-28）：Completed。

- `HierarchicalWorkGenerator` 是 root、ping/pong traversal、VisibleCluster、dispatch args、view uniform 与 evidence buffer 的唯一 owner；`prepare()` 负责拓扑容量，`encode()` 只向调用方 encoder 编码，不创建私有 submit/readback。
- InstanceCull 从 R2 resident Instance/Geometry 表产生 RootTraversalQueue；随后按 Prepared Scene 的真实最大深度编码 ping/pong `dispatchWorkgroupsIndirect`，Cluster Frustum + SSE 在 Meshlet 展开前形成 VisibleCluster selected set。
- traversal children 使用 32 B Queue header 与 `atomicCompareExchangeWeak` 整组预约；容量不足时选择当前 renderable parent。root、每轮输出和 selected header 都保存真实 `attempted/written/peak/overflow/fallback/capacity`。
- Cone、HZB 与 Software Raster 在 R3-B 显式关闭，owner evidence 均为 0 resources；当前独立 BVH8 未进入热路径。
- `examples/r3-hierarchical-work-generation` 使用真实 `GpuAssetStore + GpuScene` 覆盖两份 Geometry、四个 Instance、near-plane、镜像/非均匀 scale、Perspective、Orthographic、empty queue 和 traversal capacity pressure。
- live WebGPU 结果为 `passed=true`：Perspective 68、Orthographic 16、empty 0、capacity parent fallback 3 个 selected Cluster，四组 GPU set 均与 CPU oracle 完全一致；pressure case 首轮 `attempted=6/written=0/overflow=1/fallback=3/capacity=1`。Shader diagnostics、validation、uncaptured errors 与 console errors 均为空。
- 浏览器验证额外冻结 runtime-array binding 最小尺寸：Traversal queue 为 `32 + 8 = 40 B`，VisibleCluster queue 为 `32 + 16 = 48 B`；Node regression 防止回退到仅 header 的无效布局。
- 定向 R3-A/R3-B/source-audit 回归为 20/20；完整 `npm test` 为 152/152，OEngine production build、test compilation 与 examples production build 均通过。
- R3-B 只关闭 GPU selected-set producer。其当时未完成的 RasterWork、16 B draw indirect producer、Hardware consumer 和 paired A/B/C 现已由 R3-C 关闭；flat 链删除、Cone/HZB 与性能债务仍由 R3-D 阻塞 G3。

### R3-C · Hardware Vertical Closure

依赖：R3-B。

交付：

1. Selected Cluster → VisibleCluster + RasterWork；
2. GPU 写完整 16 B `drawIndirect` args；
3. 复用/迁移当前 Packed Hardware vertex pulling consumer，生产 Visibility/depth；
4. flat 与 hierarchy 仅保留内部 A/B 开关，用同输入、相机、分辨率和输出做 paired A/B/C；
5. 输出 visited/selected/raster/submitted/useful/fixed-vertex-waste/round/queue/timestamp 证据。

退出证据：真实 GPU producer → GPU consumer 闭环，不 readback 决定 draw；Visibility/Depth reference/截图无回归；目标高密度场景同时报告减少的工作与新增 traversal/dispatch 成本；低密度回退在门槛内或有同 ABI 短路径提案。

当前状态（2026-08-28）：Completed；性能债务转入 R3-D，G3 仍未关闭。

- `HierarchicalWorkGenerator` 在 GPU 上把 VisibleCluster 展开为 `RasterWork(visibleClusterSlot, meshletRecordIndex)`，并完整写入 `[384, written, 0, 0]` 的 16 B `drawIndirect` record；生产 `PackedVisibilityPass` 直接 vertex-pull 该 queue，当前帧不读回 count。
- 超过 65,535 的线性 indirect workgroup count 在不改变 12 B ABI 的前提下映射为二维 dispatch，WGSL 用 `num_workgroups.x` 还原线性 invocation；16 万 workgroup 回归锁定为 `65,535 × 3`。
- evidence 分开登记 VisibleCluster `selectedClusters` 和 RasterWork/Meshlet `hwClusters`，不再以同一数值冒充两个 counter。`NoHierarchy` tiny Geometry 通过 runtime-only virtual leaf Cluster 归一化到同一 consumer ABI；没有改写 R2 Package ABI。
- 自动回归为 OEngine `npm test` 156/156、examples production build 通过、R3-C GPU/CPU RasterWork oracle 通过。
- clean/full 证据基于 commit `0b77ce8cf67e110aef5d6cf82ee9e0e2f9c837d0`，NVIDIA Turing / Chrome 150、1280×720、DPR 1、60 warm-up + 180 sample frames。六组均为 `dirty=false`、`gateEligible=true`、`counterIssues=0`、`queueOverflowMask=0`，且 validation/uncaptured/device-lost/timestamp/counter diagnostics 均为 0。A/B 只保留 SW Visibility blocker，C 保留 Cone + SW Visibility blocker；`hierarchy-sse-lod` 已是真实 supported counter。

paired 时间按 P50/P95/P99 登记，单位 ms；`Producer` 为 InstanceCull、hierarchy rounds、RasterWork preparation/expansion 与对应 evidence 成本，`Visibility total` 为 Producer + Hardware raster：

| Case | 模式 | Producer | HW Raster | Visibility total | RasterWork |
|---|---|---:|---:|---:|---:|
| A | hierarchy | 112.427 / 116.651 / 117.288 | 10.289 / 10.355 / 10.355 | 122.749 / 126.940 / 127.624 | 273,750 |
| A | flat | 1.114 / 1.311 / 1.311 | 106.562 / 107.243 / 107.479 | 107.577 / 108.357 / 108.593 | 2,776,888 |
| B | hierarchy | 5.767 / 6.685 / 6.731 | 10.355 / 10.551 / 10.551 | 16.253 / 17.105 / 17.151 | 281,286 |
| B | flat | 0.262 / 0.262 / 0.262 | 53.150 / 53.710 / 53.740 | 53.412 / 53.972 / 54.002 | 1,437,568 |
| C | hierarchy | 0.328 / 0.328 / 0.328 | 0 / 0.066 / 0.066 | 0.328 / 0.393 / 0.393 | 127 |
| C | flat | 0 / 0.066 / 0.066 | 0 / 0.066 / 0.066 | 0.066 / 0.066 / 0.066 | 127 |

结论不得合并为“hierarchy 更快”：A 的 RasterWork 减少 90.1%，但 Visibility P50 回退 14.1%；B 减少 80.4% RasterWork 且 Visibility P50 改善 69.6%；C 工作量与 `shadedPixels=187,368` 完全相同，hierarchy 多约 0.262 ms 固定成本。A 的主要问题是 `workgroup_size(1)` 的 InstanceCull 约 35.6 ms、round 0 约 37.8 ms 和 VisibleCluster expansion 约 38.5 ms。A 的 hierarchy/flat `shadedPixels` 约差 2.4%，配套视觉截图显示为预期 LOD 轮廓差异，无明显破洞；B 基本一致，C 画面与像素计数一致。本地 JSON 和 `*-visual.png` 在 `temp/r3c-0b77ce8-artifacts/`，`temp/` 不纳入 Git。

### R3-D · 性能、Cone/HZB、删除与 G3 收口

依赖：R3-C 正确闭环。

交付：

1. 首先针对 A 的 InstanceCull、round 0 和 VisibleCluster expansion 把单 invocation workgroup 改为经 benchmark 验证的并行粒度，同时减少 queue header/record 带宽与不必要的分段；
2. 在不分裂 output ABI、不恢复 CPU draw list 的前提下为 C 类低密度工作研究 GPU-side/coarse preparation 短路；只有 paired 数据证明时才保留；
3. 加入 Cluster cone cull；镜像/非均匀 transform 只有 reference 通过后才启用 reject；
4. 接入 previous HZB，验证 reverse-Z、mip、camera cut/resize/history fail-open；
5. 删除 `compact_packed_meshlets()`、Packed flat queue/indirect owner 和只服务旧 ABI 的 Shader/adapter；
6. 核对 legacy `MeshletDrawList`/bucket/scan/expand 的剩余真实 consumer，删除已被替换部分，不误删其他路径；
7. 重跑 clean/full paired A/B/C，更新 Context、CURRENT-STATE、性能结果与 G3 evidence。

退出证据：旧 Packed flat producer 不再可达；不可恢复 overflow 为 0；feature-off 无 Cone/HZB/SW 多余资源与 Pass；A/B/C paired artifact 可解释；只有满足全部条件才把 G3 标记 Completed。

## 示例与验证

新增根目录 `examples/r3-hierarchical-work-generation`，通过相对路径使用 OEngine 源码，至少包含：

- two-level hierarchy reference view；
- 多 Geometry、多 Packed Instance、远近分布；
- perspective/orthographic 切换；
- mirrored/non-uniform transform；
- 强制小 traversal capacity 的 parent fallback；
- HZB on/off、camera cut 和 resize；
- flat/hierarchy 内部对照与 JSON 下载；
- selected LOD、reject reason、queue overflow/fallback debug view。

普通批次采用中等验证：命中 Node tests、`npm run build`、一个相关浏览器场景、WebGPU validation/console 检查；改变可见集合、LOD 或 HZB 时保存 JSON，并在画面异常或 Gate 收口时保存截图/序列。若当前环境不能运行浏览器，必须列为未运行并交给人工采集，不能用 TypeScript build 代替。

### 正确性 Gate

- GPU/CPU selected Cluster/Meshlet set 相同，顺序可以不同；
- 任意 Instance 中 parent 与 descendant 不同时选择；selected cut 覆盖完整可见几何；
- children reservation 要么全写，要么选 parent，不能部分写；
- Perspective/Orthographic、near-plane、camera-inside、uniform/non-uniform/mirrored scale 有固定 case；
- camera cut/resize/history invalid 时 HZB fail-open；
- GPU 写完整 indirect record，consumer count 不超过 `written`/capacity；
- 无 WebGPU validation error、NaN/Inf、越界或不可恢复 overflow。

### 性能 Gate

使用 `docs/PERFORMANCE.md` 的固定 A/B/C 条件，至少同时报告：

```text
flat candidate Meshlets
instance accepted/rejected
visited hierarchy nodes
selected clusters/Meshlets
frustum/cone/HZB rejected
encoded/effective/empty rounds
each queue attempted/written/peak/overflow/fallback
indirect instance count
submitted/useful triangles and fixed 384-vertex waste
CPU encode + GPU traversal/raster/frame P50/P95/P99
resident/transient/work queue bytes
```

不能只展示远景最佳样例。A/B/C 都要包含 hierarchy off/on paired result，简单低密度场景回退超过仓库阈值时阻塞默认启用。

## 失败与回退

- hierarchy 比 flat 更慢：先定位 round 固定成本、queue bandwidth、atomic contention 和候选规模；允许同输出 ABI 的小几何 implementation，但不恢复 CPU draw list；
- SSE 闪烁：修复 error/scale/distance/hysteresis，不用 TAA 掩盖；
- Cone/HZB 漏绘：关闭对应 reject 并 fail-open，修复 reference 后再启用；
- queue 预算经常选 parent：调整可证明容量或资产 hierarchy；不静默丢 children；
- adapter limit 无法容纳保底 RasterWork：prepare 明确 unsupported/blocker，不用截断画面通过 Gate；
- 当前 BVH8 未证明适合 LOD traversal：保持非热路径状态，不为“已经有 BVH8”强行接入。

## 阶段退出

只有以下全部成立，R3/G3 才结束：

1. `Instance → Cluster hierarchy/SSE → VisibleCluster/RasterWork → Hardware drawIndirect` 是生产 Packed 主链；
2. CPU 不遍历最终可见列表，GPU queue 数直接被 GPU consumer 使用；
3. ABI、容量、all-or-nothing fallback、owner、counter 和 feature-off 已验证；
4. CPU/GPU reference、浏览器画面和 A/B/C paired 性能 artifact 完整；
5. Packed flat producer、flat queue owner 和无 consumer Shader 已删除；
6. CURRENT-STATE、Context、ADR、porting ledger 与真实代码一致。

R3 完成后进入 R4-A Visibility contract；不得在 R3 收口前用 Software Raster 或 Material Resolve 扩张掩盖工作生成缺陷。
