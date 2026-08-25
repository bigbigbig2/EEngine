# ADR-0002 · GPU-ready 资产与层次几何

Status: accepted

## 背景

平坦 Meshlet 在高密度几何中会先产生大量候选，再支付 scan、expand、cull 和 raster 成本。

## 决策

资产阶段生成版本化 Runtime Asset，包含压缩顶点流、Meshlet、Cluster Group、几何误差、父子层次和 BVH。GPU 在展开大量 Meshlet 之前按 SSE 选择层次。

## 后果

- Loader 临时对象不拥有 GPU residency。
- LOD 是资产期生成、GPU 逐帧选择。
- 全驻留 hierarchy 正确前不实现 geometry page streaming。

## 验证

固定 benchmark 记录 visited BVH nodes、selected clusters、SSE 分布和 raster 前减少的候选量。

