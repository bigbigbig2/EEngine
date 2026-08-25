# Geometry 所有权

- 拥有设备无关 GeometryAsset、Meshlet/Cluster 构建、LOD hierarchy、BVH 和几何误差。
- 不拥有 GPU residency、帧剔除、材质着色或 Renderer 调度。
- 资产 ABI 必须可序列化、可版本化，并能由离线 Cooker 生成。
- Meshlet 不等于 Geometry Page；未完成全驻留 hierarchy 前不得混入 streaming/page 语义。
- 更改压缩或布局时同步检查 CPU 解码、GPU 读取和 benchmark。

