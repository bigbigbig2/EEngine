# ADR-0009 · R3 以 Cluster hierarchy 生成 GPU Raster Work

Status: accepted

## 背景

R2 已生成并驻留可渲染 Cluster hierarchy、独立 BVH8、Meshlet records 和 Packed Instance records。当前 Packed Visibility producer 仍逐 Instance 遍历 Geometry 的全部 Meshlet，尚未利用 hierarchy 在 Raster 前减量。

当前 `GeometryBvh8` 是全部 Cluster 的独立空间索引；leaf 可以同时引用同一 LOD tree 的 parent 与 descendant。它不编码“选择当前 parent 或展开 children”的互斥 cut。把该 BVH8 的空间查询结果直接交给独立 SSE 选择，不能证明不会同时选择父子层级。

WebGPU baseline 也没有跨 workgroup 全局同步、multi-draw-indirect、mesh/task shader、buffer device address 或 64 位原子。R3 必须在这些能力之外形成 GPU producer → GPU Hardware consumer 闭环，并为容量不足提供不漏绘的行为。

## 决策

1. R3 v1 从每个 Instance 对应 Geometry 的 Cluster hierarchy root 开始遍历，在同一状态机内完成 Frustum、SSE、选择或 children 展开。
2. 当前 R2 BVH8 不进入 R3 v1 热路径。它继续作为设备无关 package/validator/调试数据和后续 profile 候选；未来接入必须先获得与 LOD cut 对齐的语义，并通过 CPU reference、parent/child 互斥和 paired benchmark。
3. R3 使用内部深 module `HierarchicalWorkGenerator`。Renderer 只提供 Scene/View/配置并接收 `VisibleCluster + RasterWork + drawIndirect args + evidence`；ping/pong rounds、Queue header、原子预约、SSE、容量和 fallback 不泄漏给调用方。
4. WebGPU baseline 采用实际 scene hierarchy depth 上限的 ping/pong `dispatchWorkgroupsIndirect()` rounds。跨 workgroup 阶段通过独立 Compute Pass 排序，不依赖同 dispatch barrier。
5. children 使用有界 all-or-nothing 原子预约。容量不足时不写部分 children，而选择当前可渲染 parent 并记录 overflow/fallback；保底 Hardware RasterWork 不能通过截断漏绘。
6. R3 首个正确性闭环只启用 Frustum + SSE。Cone 和 previous HZB 在 CPU/GPU selected set 对齐后逐项接入；HZB 历史无效时 fail-open。
7. R3 继续使用现有 single `drawIndirect()` Hardware Visibility consumer。没有 Software Raster consumer 时不创建 SW queue、资源或 Pass；SW/Hybrid 属于后续 R4-C。
8. Bevy Meshlet 是 hierarchy scheduling/SSE 的主要局部移植来源；nanite-webgpu 用于 WebGPU queue/indirect 对照；Niagara 用于 Frustum/Cone/HZB 数学对照；AnKi 用于 staged ownership 对照。OEngine 自己拥有 ABI、容量证明、fallback、FrameGraph 接入和 benchmark。
9. R3-D 的 RasterWork expansion 使用一个 selected Cluster 对应一个 64-lane workgroup：lane 0 执行一次 bounded reservation，workgroup 内广播 base 后并行展开 Meshlet。不默认引入 Prefix Scan；是否替换原子预约必须由相同输出 ABI 的 benchmark 决定。

本 ADR 细化 [ADR-0002](./0002-gpu-ready-assets-and-hierarchy.md) 的 runtime traversal 决策，不推翻 R2 生成 Cluster hierarchy 与 BVH8 数据的资产决策。

## 后果

- R3 不会为了使用已有数据而把当前 BVH8 强行接入 LOD 主链。
- `GpuPackedSceneRegistry` 不再长期拥有 frame-local flat queue；Work Generator 统一拥有 traversal/selected/raster/indirect resources。
- R3 要先升级 multi-instance world-space CPU selector，才能把 GPU selected set 判为正确。
- Queue ABI 必须区分 `attempted`、`written`、`peak`、`overflow` 和 `fallback`；字段缺失不能伪装成零。
- 相比 flat 路径会增加若干 indirect Compute rounds 和 queue bandwidth；是否获得净收益必须由相同条件的 A/B/C 测量决定。
- 小 Geometry 若被 wavefront 固定成本拖慢，只能在相同输出 ABI 后新增经 benchmark 证明的内部 implementation，不恢复 CPU visible list，也不形成第二条产品管线。

## 验证

- CPU/GPU selected Cluster/Meshlet set 一致，输出顺序可以不同。
- 任意 Instance 的合法 cut 中 parent 与 descendant 互斥且覆盖完整。
- 强制小 traversal capacity 时 children 全写或 parent fallback，不出现部分 children 和几何洞。
- Perspective/Orthographic、near-plane、camera-inside、uniform/non-uniform/mirrored scale 有固定 regression。
- GPU 写完整 12 B dispatch/16 B draw indirect records，consumer 数量不超过 clamped `written`。
- HZB camera cut/resize/首帧 fail-open；Cone 未证明的 transform 保守禁用。
- A/B/C paired artifact 同时报告 traversal 新增成本、Raster 前工作减少、queue memory、P50/P95/P99 和低密度回退。
- G3 退出前删除 Packed flat producer、flat work owner 和无 consumer Shader。
