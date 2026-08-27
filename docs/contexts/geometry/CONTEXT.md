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
- R3 v1 只以 Cluster tree root→children 形成合法 LOD cut。当前 BVH8 leaf 可同时包含 parent 与 descendant、没有互斥选择语义，因此不进入首版 runtime 热路径；未来接入必须先重建语义或新增同输出 ABI adapter，并通过 reference/benchmark。
- R3-A 已把当前单资产 CPU selector升级成应用完整 Instance transform 的 multi-instance world-space oracle，覆盖透视/正交、near-plane、非均匀和镜像 scale；它是 validator/tool path，不进入稳定渲染帧。当前下一步是 R3-B GPU selected-set 对齐。
