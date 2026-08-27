# 05 · R3 层次工作生成

## 阶段目标

把现有“先展开大量 Meshlet，再 bucket/scan/cull”的路径改成 GPU producer → GPU consumer 闭环：先剔除实例，再按 BVH8/Cluster hierarchy 与 SSE 选择层次，最后只为已选 Cluster 生成 HW/Alpha 工作并由现有 single `drawIndirect` 直接消费。SW queue 只预留稳定分类字段，不阻塞 R3。

## 非目标

- 不让 CPU readback 可见列表后再循环 draw。
- 不让 HZB 决定当前帧 LOD；HZB 只做遮挡。
- 不默认使用 Prefix Scan/Scatter；只有需要稳定顺序且 benchmark 证明值得时使用。
- 不在本阶段实现软件覆盖；先让新工作链由 Hardware Visibility 完整消费。

## 当前代码入口

| 当前入口 | 当前职责 | 目标处理 |
|---|---|---|
| `OEngine/src/gpu/MeshletDrawList.ts` | instance/meshlet candidate、scan、second chance、indirect args 和 single draw consumer 输入 | 替换平坦工作生成；保留并深化 GPU indirect consumer 不变量 |
| `OEngine/src/gpu/MaterialMeshletDrawList.ts` | material bucket 与 draw commands | opaque 主链删除；alpha/transparency 单独迁移 |
| `OEngine/src/render/passes/VisibilityPass.ts` | 编排 bucket/cull/scatter/drawIndirect | 拆成 WorkGeneration + UnifiedVisibility |
| `mesh_instance_cull*.ts` | 现有 instance cull shader | 作为行为对照，按新 InstanceTable ABI 重写 |
| `meshlet_expand*.ts`、`meshlet_prefix_scan.ts`、`meshlet_bucket*.ts` | 平坦展开和分类 | 新链稳定后删除无 consumer shader |
| `meshlet_hzb_cull*.ts` | previous/current HZB cull | 按 hierarchy/queue ABI 重写并保留可验证算法 |

## 目标数据流

```text
InstanceTable
  → InstanceCull
  → RootTraversalQueue
  → BVH8 / ClusterHierarchy rounds
       ├─ reject frustum/cone/HZB
       ├─ descend when SSE too high and budget available
       └─ select current renderable cluster otherwise
  → VisibleClusterTable + SelectedClusterQueue
  → Classify
       ├─ HardwareRasterQueue
       └─ AlphaTestQueue
  → GPU fills indirect instanceCount
  → single drawIndirect Hardware consumer
```

从 RootTraversalQueue 开始全部由 GPU 产生和消费。CPU 只在帧开始提供表、相机、配置与容量，不读取数量来决定当帧 draw。

当前 Hardware consumer 已存在：每个可见 Meshlet 作为 indirect draw 的一个 instance，固定 `vertexCount=384`。R3 必须补充 `submittedVertices/usefulVertices` 或等价证据，量化不足 128 triangles Meshlet 的浪费，而不是把“只有一次 draw”直接当成最优。

## SSE LOD 语义

首版使用透视投影的保守像素误差：

```text
worldError = objectError × maxScale(instanceTransform)
pixelError ≈ worldError × projectionScaleY × viewportHeight / max(viewDepth, nearClamp)
```

- `pixelError > thresholdHigh`：尝试展开 children。
- `pixelError < thresholdLow`：选择当前节点。
- 中间带使用上一帧选择层或稳定 hash/hysteresis 状态，避免边界闪烁。
- 正交相机使用独立无 depth 衰减公式。
- near-plane 交叉、相机位于 bounds 内、负/非均匀 scale 必须走保守路径。
- HZB reject 发生在 LOD 选择之外，不用历史相机深度改变几何精度。

SSE threshold 是统一主管线的质量参数，不创建不同真实管线。

## Queue ABI v1

所有元素按 16 字节或更小对齐，实际 stride 由共享 schema 断言。

### TraversalWork · 8 bytes

```text
instanceSlot  u32
nodeIndex     u32
```

Producer 是 InstanceCull 或上一 traversal round；consumer 是下一 round。Geometry 通过 InstanceRecord 获取。

### VisibleClusterRecord · 初始 16 bytes

```text
instanceSlot  u32
geometrySlot  u32
clusterIndex  u32
materialSlot  u32   // override 已解析；flags 可在高位或旁表
```

数组下标就是 frame-local `visibleClusterSlot`。Producer 是 traversal select；consumer 是 classifier、SW/HW raster 和 Material Resolve。

### RasterWork · 8/16 bytes

最小字段为 `visibleClusterSlot` 和 meshlet/triangle range。若一个 renderable cluster 含多个 Meshlet，classifier 可以为每个 Meshlet 输出一项：

```text
visibleClusterSlot  u32
meshletIndex        u32
```

其余 bounds/triangle count 从 Cluster/Meshlet table 回查，避免重复宽记录。只有 benchmark 证明随机回查更贵时才扩展为 16 bytes。

### Indirect arguments

- traversal rounds 使用标准 `dispatchWorkgroupsIndirect` 三个 `u32`。
- Hardware path 使用标准 `drawIndirect` 四个 `u32`。
- SW path 使用标准 `dispatchWorkgroupsIndirect`。
- 参数 producer 在 GPU 内根据已 clamp 的 queue count 写入；consumer 不读未 clamp 的原始 overflow counter。

## Capacity 与 fail-visible overflow

| 队列 | Capacity | Overflow/fallback |
|---|---|---|
| visible instances/root | 配置的最大 resident instances | 超过表示场景超出已声明能力；frame 标错并拒绝静默 present |
| traversal ping/pong | frame hierarchy work budget | children 使用一次 atomic reservation；放不下整组 children 时选择当前可绘制父级 |
| VisibleCluster | frame selected-cluster budget | 在下降前使用预算压力停止细分并选择父级；root 数必须可容纳 |
| HW queue | 至少等于 SelectedCluster/Meshlet 最大输出 | 作为所有 opaque 工作的保底，不能 overflow 后漏绘 |
| SW queue | profile 配置，不大于 HW 保底能力 | reserve 失败时重新路由 HW，增加 `swFallbackToHw` |
| Alpha queue | alpha resident/work 预算 | 不透明路径不能代画；超预算时父级 alpha fallback 或显式 frame error |

每个 queue 有 `attempted`、`written`、`peak`、`overflow` counter。release build 也保留 overflow bit；benchmark gate 要求 0 个不可恢复 overflow。

## Wavefront traversal 调度

WebGPU baseline 不依赖跨 workgroup 全局同步。首版采用固定上限的 ping-pong rounds：

1. Cooker 写入 `maxHierarchyDepth` 并验证不超过 runtime 上限；
2. FrameGraph 编码最多 N 次 `dispatchWorkgroupsIndirect`；
3. round N 只读 current queue、写 next queue/selected、生成下一 indirect args；
4. 空队列的间接 dispatch 为零工作；
5. 超过 N 仍有 work 是 hard counter/error，不能丢弃。

固定 rounds 的 command 成本必须在 A/C 测量。如果按实例/工作组 local-stack 原型在特定场景更好，可以作为同一 queue/output 契约下的 capability/profile 实现，但不得改变下游 Visibility ABI。

## Culling 顺序

建议的便宜到昂贵顺序：

```text
instance frustum
→ instance previous-HZB（可选）
→ BVH/cluster frustum
→ normal cone/backface
→ SSE select/descend
→ selected cluster previous-HZB（按收益可选）
→ classify
```

实际顺序由 counter 与 GPU time 调整。每个 reject counter 的统计口径要明确，避免同一项被多个原因重复计数。

## 执行任务

### WORK-01 · CPU reference traversal

基于 Cooker v1 package 实现确定性的 CPU reference：相机、SSE、frustum/cone 与 hierarchy 选择。用于小场景集合对比，不进入性能主帧。

### WORK-02 · 冻结 queue schema 和预算

生成 TypeScript/WGSL layout、capacity config、counter bit 和 indirect args。用最坏 root/child reservation 测试 fail-visible 规则。

### WORK-03 · InstanceCull → RootQueue

读取新 InstanceTable，输出 root work 和 visible instance counters。Packed 与独立对象走同一 shader。无 CPU visible list。

### WORK-04 · BVH8/Hierarchy wavefront

实现 ping-pong rounds、frustum/cone、SSE、budget fallback 和 indirect dispatch。先关闭 HZB，与 CPU reference 逐项比对。

### WORK-05 · SelectedCluster/VisibleCluster

为最终选中的 renderable node/meshlets 分配 frame-local slot，写完整 lookup record。验证 parent/child 互斥、material mapping 和 bounds。

### WORK-06 · previous-HZB culling

接入 R1 HZB，定义 mip 选择、reverse-Z compare、bounds expansion 和 camera-cut 禁用。错误遮挡优先 fail-open（保留工作），并计数。

### WORK-07 · SW/HW/Alpha 分类骨架

R3 先把所有 opaque 路由 HW，alpha 路由 AlphaTest。创建 SW queue ABI 和 counter，但 feature off 时不分配/清零/dispatch SW 资源。

### WORK-08 · 生成 indirect args 并由 HW 消费

新 Hardware Visibility shader 从 RasterWork/VisibleCluster 读取三角形并 `drawIndirect()`。这一步是 R3 垂直闭环，不能仍回到旧 MeshletDrawList。

### WORK-09 · 同质 Packed Instance 快路径实验

相同 geometry/material 的 set 可共享根和数据绑定，但输出仍是统一 VisibleCluster。只有 A/C 同条件证明收益且没有异构回退，才保留实现。

### WORK-10 · 删除旧平坦工作链

新 HW 垂直链通过 gate 后删除旧 expand/bucket/scan/scatter 主链及无 consumer shader。Prefix Scan 工具若仍被其他模块使用，保留为通用 owner，不再由 Visibility 默认调用。

## Debug views 与 counters

必须可视化/输出：instance reject、visited BVH nodes、visited hierarchy nodes、选择层级、SSE、hysteresis、parent fallback、selected clusters、每 queue peak/overflow、HW/Alpha 数量和 HZB reject mip。

## 验收

### 正确性

- GPU 与 CPU reference 在小场景选中集合一致，允许顺序不同但不允许集合漏失。
- parent/child 不重复，camera cut/resize 时 previous HZB 自动 fail-open。
- 强制小 capacity 测试触发父级 fallback，仍无洞；不可恢复 overflow 让测试失败。
- Packed/独立实例、透视/正交、非均匀 scale、近裁剪交叉均覆盖。

### 性能

- A/B/C 记录 flat candidate meshlets 对比 visited nodes/selected clusters/raster triangles。
- CPU 不读取 queue count 来循环 draw，稳定帧仍满足 R1 submit 门禁。
- 高密度远景中，Raster 前候选显著减少；减少量和 traversal 成本一起报告。
- 简单低密度场景不得因固定 traversal rounds 明显退化；若退化，使用同契约短路径或压低空 round 成本。

## 回退与失败条件

- hierarchy traversal 比平坦链更慢：先看候选规模、round/queue 带宽和场景密度；允许保留经证据选择的同质/小几何短路径，但不得恢复 CPU draw list。
- SSE 闪烁：修正 error、hysteresis 和 previous selection 语义，不用 TAA 掩盖错误。
- HZB 漏绘：禁用该 reject 并 fail-open，修正 bounds/mip/reverse-Z 后再启用。
- queue 预算频繁触发父级 fallback：提高预算或改进上游 LOD，不允许静默漏绘。

## 阶段退出

新 Instance → hierarchy → SelectedCluster → HW Visibility 闭环完全替换旧主链；A/B/C 能量化 Raster 前消除的工作；queue ABI、capacity、overflow 与 counters 闭环。更新 geometry/visibility/performance Context、`CURRENT-STATE`，再进入软件微光栅。
