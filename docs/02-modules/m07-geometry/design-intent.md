# M07 · Geometry — 设计意图

> 母本：设计 v2 meshlet；Shade v3 §8（无 mesh shader、divergence）

```txt
规范化几何 + meshlet/cluster 构建
服务细粒度 cull 与 VB
WebGPU 用 compute/indirect 路径承接
承认 expansion 负载不均问题（设计层）
```
