# Shading Context

## 职责

根据 VisibilityKey 重建 surface attributes，执行 Standard PBR、IBL、Clustered Lighting、CSM、Transparency/Decal、Temporal Reconstruction、Upscaling 和 Post。

## 约束

- Standard PBR 走单次通用 Material Resolve。
- MaterialTable 与有界 texture bank/resident handle 是主材质数据源；streaming 不是 v1 Resolve 前提。
- 不按材质数重复全屏扫描。
- internal/output resolution 必须分离；Velocity、TAA/Temporal Reconstruction、SSR 和 history 必须定义相机切换、resize、render-scale 与 LOD 切换失效规则。
- 所有效果位于同一主管线资源图，关闭后接近零成本；不建立三档独立管线。
- 当前不实现地形、角色、粒子、云、水等专用着色路径，只保留接入 seam。
