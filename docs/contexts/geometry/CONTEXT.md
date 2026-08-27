# Geometry Context

## 核心模型

```text
GeometryAsset
→ Cluster Groups / LOD hierarchy
→ Meshlets
→ ResidentGeometry
→ GPU hierarchy traversal
```

## 约束

- LOD 是资产期生成、GPU 逐帧选择，不是 GPU 在线简化。
- SSE 选择必须发生在大规模 Meshlet 展开前。
- Parent/child 必须满足覆盖与互斥语义，并有 hysteresis/debug view。
- Meshlet、Cluster Group、BVH Node 和 Geometry Page 是不同概念。
- 当前只实现全驻留 hierarchy；Geometry Page/streaming 保留在 deferred 研究，不进入阶段 Gate。
- R2-B 已生成 strict renderable Cluster tree、object-space monotonic error、CPU SSE selector 和独立未量化 BVH8；这些仍是设备无关 package 数据。R2-C 负责 residency，R3 才负责 GPU traversal/工作减量。
