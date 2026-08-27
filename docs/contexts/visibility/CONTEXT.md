# Visibility Context

## 数据流

```text
Instance Cull
→ Hierarchy Traversal + SSE
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
- HW-only 必须先形成完整正确主链；SW/Hybrid 是后续 profile optimization。
- Hardware 与 Software Raster 共享 VisibilityKey、深度和边规则。
- HZB 只负责遮挡，不负责决定当前帧 LOD。
- HZB 是 per-view ping-pong history：initial 只能读已 commit 的 previous，late/alpha/lighting 读本帧 current/final；resize、camera cut 和 view discontinuity 后 previous 无效。
- 当前 HZB build 使用 `rg16float` storage Compute；每次 build 上界为一个 Compute Pass、每 mip 一个 dispatch，不允许恢复逐 mip Render Pass。
- second-chance 是可测调度选择，不是永久固定步骤。
- Prefix Scan/Scatter 只有在原子 compact 不满足需求时使用。
