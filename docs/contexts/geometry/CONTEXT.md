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
- Streaming 在全驻留 hierarchy 正确且可测后再设计。

