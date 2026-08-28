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
- R2-D Packed flat queue 的 header 为 `written/attempted/visible/rejected`，element 为 Instance/Meshlet record index；共享 Geometry capacity 必须乘实例数，adapter limit 在 owner 变更前拒绝。生产路径已由 R3 hierarchy traversal + RasterWork 替换并复用同一 Hardware indirect consumer；flat 只作为 R3-D 待删的内部 paired reference。
- R3-A 已冻结 TraversalWork `instanceRecordIndex + clusterRecordIndex`、VisibleCluster 稳定 lookup seam、RasterWork `visibleClusterSlot + meshletRecordIndex`、32 B Queue header 和完整 indirect records；当前 R2 BVH8 不直接参与 LOD cut。
- R3-B 已创建并消费真实 GPU root/ping-pong queue，以 `dispatchWorkgroupsIndirect` 运行 InstanceCull + Cluster Frustum/SSE，输出 CPU oracle 对齐的 VisibleCluster；root、每轮和 selected 都保存真实 header evidence，R3-B 测试 readback 不进入主帧决策。
- R3-C 已将 VisibleCluster 展开为 RasterWork，GPU 完整写入 16 B `drawIndirect` record，并由生产 Packed Hardware consumer 直接消费。线性 workgroup 超过 65,535 时使用二维 indirect dispatch；`NoHierarchy` tiny Geometry 通过 runtime-only virtual leaf Cluster 归一化 ABI，不改 Package。VisibleCluster `selectedClusters` 与 RasterWork `hwClusters` 必须分开登记。
- R3-D 负责优化当前 `workgroup_size(1)` 大规模阶段和低密度固定成本，加入 Cone/previous HZB，并删除 flat producer/owner；在此之前 G3 未关闭。Cone/HZB/SW feature-off 不得创建无 consumer 资源。
- children queue 使用 all-or-nothing bounded reservation：整组成功写入，否则选择当前 renderable parent。每条队列区分 attempted/written/peak/overflow/fallback，HW RasterWork 不允许截断漏绘。
- 首个 GPU/CPU selected-set 闭环只启用 Frustum + SSE；Cone 和 previous HZB 之后逐项接入。没有 SW consumer 时不得创建 SW queue 或相关资源/Pass。
- HW-only 必须先形成完整正确主链；SW/Hybrid 是后续 profile optimization。
- Hardware 与 Software Raster 共享 VisibilityKey、深度和边规则。
- HZB 只负责遮挡，不负责决定当前帧 LOD。
- HZB 是 per-view ping-pong history：initial 只能读已 commit 的 previous，late/alpha/lighting 读本帧 current/final；resize、camera cut 和 view discontinuity 后 previous 无效。
- 当前 HZB build 使用 `rg16float` storage Compute；每次 build 上界为一个 Compute Pass、每 mip 一个 dispatch，不允许恢复逐 mip Render Pass。
- second-chance 是可测调度选择，不是永久固定步骤。
- Prefix Scan/Scatter 只有在原子 compact 不满足需求时使用。
