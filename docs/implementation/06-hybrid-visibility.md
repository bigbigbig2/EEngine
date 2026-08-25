# 06 · R4 软硬件混合 Visibility

## 阶段目标

在 R3 的统一 VisibleCluster/queue 契约上实现真实 Compute 软件微三角形光栅，并与固定功能 Hardware Raster 合并为同一 `VisibilityKey + depth`。Hybrid 只在目标 GPU/场景有证据时承担微三角形；Hardware 永远是正确性 fallback。

## 非目标

- 不给旧 `VisibilityPass` 简单追加一个孤立 SW Pass。
- 不用软件光栅全量替换硬件光栅。
- 不依赖 WebGPU baseline 不具备的 64 位原子。
- 不让 Material Resolve 区分像素来自 SW 还是 HW。
- 不把 HW/SW/Hybrid 变成三档产品管线；它们是同一 Visibility 契约的验证/实现选择。

## 当前代码入口

`OEngine/src/render/passes/VisibilityPass.ts` 最终在 Meshlet 路径使用 `drawIndirect()`，`visibility_meshlet.ts`/`visibility_alpha_tested.ts` 是固定功能硬件光栅 shader。当前仓库没有 Compute triangle coverage、software atomic depth 或统一 SW/HW transfer 路径。因此 R4 以 R3 新模块为唯一上游，不在旧类中继续堆叠。

## VisibilityKey v1

```text
bits  0..6   localTriangle        0..127
bits  7..31  visibleClusterSlot   0..33,554,430
0xFFFFFFFF   empty; slot 0x1FFFFFF 整体保留

key = (visibleClusterSlot << 7) | localTriangle
```

约束：

- Meshlet 最多 128 triangles，由 Cooker validator 保证。
- `visibleClusterSlot` 查 R3 `VisibleClusterTable`，再取得 Instance/Geometry/Cluster/Material。
- key 是 frame-local，不可跨帧保存为对象身份；picking/debug 返回稳定 object ID 时必须回查。
- 超过有效 slot 容量在工作生成阶段触发 budget/error，不截断高位。
- final visibility attachment 使用 `r32uint`，depth 使用 `depth32float` reverse-Z。

如果一个 hierarchy node 含多个 Meshlet，RasterWork 对每个 Meshlet持有同一个 visible cluster slot；`localTriangle` 是该 Meshlet 内索引。VisibleCluster record 或 RasterWork 必须能让 Resolve 唯一找到 meshlet。若 32 位 key 无法表达，应在 `VIS-01` 调整 lookup table 层次，而不是偷占深度位。

## 软件光栅资源

| 资源 | 格式/大小 | Owner | 生命周期 |
|---|---|---|---|
| `swDepthAtomic` | `width × height × u32` | HybridVisibility | 仅 SW queue 非空/功能启用的帧 |
| `swVisibilityAtomic` | `width × height × u32` | HybridVisibility | 同上 |
| final Visibility | `r32uint` texture | unified visibility graph node | 本帧 resolve/debug consumer |
| final Depth | `depth32float` | view render targets | HZB/resolve/lighting/history |

reverse-Z depth 范围为正浮点 `[0,1]`。将有限、clamped depth `bitcast<u32>` 后使用 `atomicMax`，0 表示 far/empty。NaN、负值和超范围在投影/clip 阶段拒绝或 clamp，不能进入原子比较。

## 两阶段 Compute 软件光栅

### Stage 1 · SW Depth

1. 从 SW RasterWork 读取 Meshlet/triangle；
2. clip near plane/viewport，背面规则与 HW cull mode 对齐；
3. 计算保守屏幕包围盒；
4. 使用固定点 top-left edge rule 测试像素中心；
5. 计算 perspective-correct depth，转换为 ordered `u32`；
6. `atomicMax(swDepthAtomic[pixel], depthBits)`。

### Stage 2 · SW Visibility

重复相同 coverage/depth 算法。只有 `depthBits == atomicLoad(swDepthAtomic[pixel])` 时，执行 `atomicMin(swVisibilityAtomic[pixel], VisibilityKey)`。clear sentinel 是 `0xFFFFFFFF`。这提供同一 VisibleCluster table 内不依赖 workgroup执行顺序的 tie 选择。

两阶段必须共享一份 coverage/depth WGSL 函数，避免数值细节不同导致 winner 无 key。

## 与 Hardware Raster 合并

建议使用一个 Unified Visibility Render Pass：

1. final Visibility clear 为 `0xFFFFFFFF`，final Depth clear 为 reverse-Z far `0.0`；
2. SW queue 非空时画一次 fullscreen transfer：空像素 discard，其余写 `VisibilityKey` 和 `frag_depth`；
3. 切到 Hardware Visibility pipeline，消费 HW `drawIndirect()`；
4. depth compare 使用 reverse-Z `greater`，load 已有 SW 结果；精确同深度时 SW winner 保留；
5. AlphaTest queue 使用同一 attachment/depth 语义，在 fragment alpha discard 后写 key。

当 SW feature 关闭或 SW queue 为 0 时，不分配/clear atomic buffers、不编码 SW compute/transfer，只执行 clear + Hardware。若实际 queue count 只在 GPU 可知，使用 indirect dispatch 和条件性工作；资源是否常驻由 profile 决定，但关闭 feature 必须完全裁掉。

## Triangle coverage 契约

- 采用像素中心与 top-left fill convention，固定点精度在 `VIS-02` 通过边界测试冻结。
- near-plane clip 后最多生成有限个三角形；clip overflow 有 counter 并路由 HW，不能漏面。
- degenerate、零面积和超大屏幕包围盒路由 HW 或安全丢弃（仅真正退化）。
- double-sided、front-face 和负 determinant transform 与 HW 一致。
- perspective-correct attribute 不在 raster 阶段写 GBuffer；Resolve 由 key + depth 重建 barycentric。
- MSAA 暂不进入 v1 SW visibility；若启用必须新增 sample-level ABI/ADR，不假装 per-pixel 结果等价。

## GPU 分类策略

首版 classifier 只使用可测量字段：

```text
projected cluster rectangle
triangle count
estimated average pixels/triangle
clip/alpha/double-sided flags
device profile threshold
current SW queue pressure
```

保守路由规则：alpha-tested、clip 复杂、超大 bbox、unsupported primitive 和 SW queue overflow 全部走 HW。阈值存于 capability/performance profile，不写死为跨 GPU 通用的 `16×16`。

每个 profile 至少通过 `HW only`、`SW only（支持范围）`、`Hybrid` 三种验证模式产生数据；发布默认值只从跨场景结果选择。

## 执行任务

### VIS-01 · 冻结 key 与 lookup

实现 TypeScript/WGSL encode/decode、empty、最大 slot/triangle、非法值测试。确认 multi-meshlet cluster 的唯一回查方式，然后冻结 VisibilityKey v1。

### VIS-02 · CPU coverage reference

实现小型 CPU reference，覆盖 winding、top-left 共享边、subpixel、near clip、viewport edge、reverse-Z、透视和 degenerate。生成期望 depth/key images。

### VIS-03 · SW depth prototype

先对直接输入的少量三角形实现 atomic depth，不接主帧。与 CPU reference 逐像素比较，并记录 clear/coverage/atomic contention。

### VIS-04 · SW visibility tie stage

接入第二阶段和 deterministic `atomicMin`。验证完全重叠、共享边、多 workgroup、不同提交顺序和 empty sentinel。

### VIS-05 · 接入 R3 SW queue

由 classifier 输出 RasterWork 和 indirect dispatch args。SW queue capacity不足自动回退 HW，并记录原因。

### VIS-06 · Fullscreen transfer + HW merge

让 SW/HW/Alpha 输出同一 final attachments；逐像素对照 HW-only reference，重点检查路径交界、reverse-Z 和同深度。

### VIS-07 · Material Resolve 垂直验证

在正式 R5 前先做最小 attribute resolve/debug color，证明两条路径回查到相同 instance、meshlet、triangle 和 barycentric。

### VIS-08 · 分类器与 profile

扫 projected size、triangles/cluster、可见比例和 SW queue pressure，在至少目标离散/集成 GPU 类别上记录交叉点。阈值包含版本和 adapter profile fallback。

### VIS-09 · same-frame late visibility

如果 R1/R3 数据证明 second chance 有收益，让 late work 继续使用相同 VisibleCluster/key/merge 契约。无收益时 graph 裁掉，不建立另一套 Visibility。

### VIS-10 · 删除旧 Visibility

新 HW/Hybrid 完整覆盖 opaque/alpha 后，删除旧 `VisibilityPass`、旧 visibility shader 与只服务旧 mesh/triangle ID attachment 的资源。HW fallback 保留在新模块中。

## Counters 与 debug views

至少记录：classified SW/HW/Alpha clusters、triangles、SW bbox pixels、coverage pixels、depth atomic attempts/wins、tie attempts、clip fallback、SW queue fallback、transfer pixels、HW fragments（可测时）和各阶段 GPU time。

Debug views：SW/HW 分类、software atomic depth、software key、final key、路径边界、triangle size heatmap、atomic overdraw、empty/invalid lookup。

## 验收

### 正确性

- CPU reference、HW-only、SW-only 和 Hybrid 在规定支持范围内深度/ID 一致；容许的浮点误差必须量化。
- 共享边无裂缝，near clip/viewport edge 不越界，invalid key 不进入 Resolve。
- SW overflow/unsupported 全部路由 HW，无静默漏绘。
- resize、camera cut、feature toggle、device lost 正确重建/裁掉 SW resources。

### 性能

- A 的微三角形 sweep 显示 Hybrid 相对新 HW-only 的收益区间和交叉点。
- B/C 普通/大三角形场景不得因 SW 固定资源、clear 或 transfer 明显退化。
- 两阶段额外带宽、atomic contention、transfer 成本与节省的 HW primitive 成本同时报告。
- 跨 GPU profile 没有通用收益时，默认路由 HW，但保留已验证的同契约可选 Hybrid；不得宣称软件路径普遍更快。

## 回退与失败条件

- 两阶段成本始终高于 HW：保留 HW 主路径，将 SW 默认关闭；继续研究前先保存证据，不为“架构完整”强开。
- depth/key 不一致：停止 classifier 调优，修复共享 coverage/depth 函数。
- 原子热点导致长尾：缩小 SW 适用 bbox/coverage，热点工作路由 HW。
- 某 adapter 原子或 storage 性能异常：capability profile 禁用 SW，Unified Visibility 输出契约不变。
- 32 位 key 容量不满足真实场景：在 R5 前新增 ADR 并改 lookup 方案，不压缩 depth 精度。

## 阶段退出

新 Visibility 模块能以同一输入切换 HW/SW/Hybrid 对照，统一 key/depth 通过正确性；Hybrid 在明确目标区间有收益，其他区间由 HW fallback；旧 Visibility 主链删除。更新 visibility/platform/performance Context、ADR（若 key/算法改变）和 `CURRENT-STATE`。
