# Visibility Context

## 数据流

```text
Instance Cull
→ Hierarchy Traversal + SSE
→ Cluster Cull
→ SelectedCluster Queue
→ SW/HW/Alpha classification
→ Unified VisibilityKey + depth
```

## 约束

- 每个 Work Queue 说明 producer、consumer、capacity、overflow 和 counters。
- Hardware 与 Software Raster 共享 VisibilityKey、深度和边规则。
- HZB 只负责遮挡，不负责决定当前帧 LOD。
- second-chance 是可测调度选择，不是永久固定步骤。
- Prefix Scan/Scatter 只有在原子 compact 不满足需求时使用。

