# Visibility Context

## 数据流

```text
Instance Cull
→ Cluster Hierarchy root/children Traversal + SSE
→ Cluster Cull
→ SelectedCluster Queue
→ HW/Alpha classification
→ GPU indirect args + single drawIndirect consumer
→ optional SW classification/raster
→ Unified VisibilityKey + depth
```

## 约束

- 每个 Work Queue 说明 producer、consumer、capacity、attempted/written、overflow 和 counters。
- 当前 Hardware baseline 是 GPU list count 写入 indirect `instanceCount`，每 Meshlet instance 固定最多 384 vertices；必须统计无效提交和多 bucket 成本。
- R2-D Packed flat queue/indirect owner 与对应 Compute/Raster Shader 已在 R3-D 删除；历史 flat 只存在于 commit `0b77ce8` 的 paired artifact，不再是运行时模式。
- R3-A 已冻结 TraversalWork `instanceRecordIndex + clusterRecordIndex`、VisibleCluster 稳定 lookup seam、RasterWork `visibleClusterSlot + meshletRecordIndex`、32 B Queue header 和完整 indirect records；当前 R2 BVH8 不直接参与 LOD cut。
- R3-B 已创建并消费真实 GPU root/ping-pong queue，以 `dispatchWorkgroupsIndirect` 运行 InstanceCull + Cluster Frustum/SSE，输出 CPU oracle 对齐的 VisibleCluster；root、每轮和 selected 都保存真实 header evidence，R3-B 测试 readback 不进入主帧决策。
- R3-C 已将 VisibleCluster 展开为 RasterWork，GPU 完整写入 16 B `drawIndirect` record，并由生产 Packed Hardware consumer 直接消费。线性 workgroup 超过 65,535 时使用二维 indirect dispatch；`NoHierarchy` tiny Geometry 通过 runtime-only virtual leaf Cluster 归一化 ABI，不改 Package。VisibleCluster `selectedClusters` 与 RasterWork `hwClusters` 必须分开登记。
- R3-D 已把 RasterWork expansion 改为每 selected Cluster 一个 64-lane workgroup、一次整组预约并行写 Meshlet；Cone/previous HZB 与真实 reject counter 已接入，flat producer/owner 已删除。`R3-D-08/09` 进一步融合 InstanceCull + root Cluster，root/traversal children 和 SelectedCluster 先做 workgroup-local compaction 再全局整组预约；depth-zero 小场景用同 ABI fused-leaf 单 Pass 直接写 VisibleCluster/RasterWork/16 B indirect。commit `aff3ab8` 的 clean/full A/B/C 已关闭 G3 performance；下一入口是 R4-A Visibility contract。
- queue evidence 默认跟随 counter sampling；非采样稳定帧不分配 evidence buffer、不复制 header、不运行 reducer。四个 contention counter 只在采样时由真实 GPU producer 写入，不得为了观测恢复每帧固定 Pass。
- children queue 使用 all-or-nothing bounded reservation：整组成功写入，否则选择当前 renderable parent。每条队列区分 attempted/written/peak/overflow/fallback，HW RasterWork 不允许截断漏绘。
- GPU/CPU selected-set 先以 Frustum + SSE 对齐，再接 Cone 和 previous HZB。Cone 对 mirrored/non-uniform/shear/double-sided/invalid cone fail-open；HZB 对首帧、resize、camera cut、history invalid 与异常投影 fail-open。没有 SW consumer 时不得创建 SW queue 或相关资源/Pass。
- HW-only 必须先形成完整正确主链；SW/Hybrid 是后续 profile optimization。
- Hardware 与 Software Raster 共享 VisibilityKey、深度和边规则。
- HZB 只负责遮挡，不负责决定当前帧 LOD。
- HZB 是 per-view ping-pong history：initial 只能读已 commit 的 previous，late/alpha/lighting 读本帧 current/final；resize、camera cut 和 view discontinuity 后 previous 无效。
- 当前 HZB build 使用 `rg16float` storage Compute；每次 build 上界为一个 Compute Pass、每 mip 一个 dispatch，不允许恢复逐 mip Render Pass。
- second-chance 是可测调度选择，不是永久固定步骤。
- Prefix Scan/Scatter 只有在原子 compact 不满足需求时使用。
