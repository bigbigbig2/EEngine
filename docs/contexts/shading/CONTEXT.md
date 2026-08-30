# Shading Context

## 职责

根据 VisibilityKey 重建 surface attributes，执行 Standard PBR、IBL、Clustered Lighting、CSM、Transparency、Temporal Reconstruction、Upscaling 和 Post；Decal 当前只保留接入 seam，implementation/Gate 延期。

## 约束

- Standard PBR 走单次通用 Material Resolve。
- Packed production 已由一次 `PackedMaterialResolvePass` 从 VisibilityKey 经 RasterWork 唯一定位 Meshlet，重建 Standard PBR Surface + velocity；active material 数不增加 fullscreen draw。
- R4-B 已迁移 R2-D-08/R2-D-09 的 perspective barycentric、analytic texture gradient、normal/tangent frame 与 motion 数学，没有重新实现第二套算法。
- Packed Velocity 使用 Instance ABI 的 CPU 预计算 `previous_from_current`；奇异 motion 显式输出零，Shader 禁止逐像素矩阵求逆，独立 Packed Velocity pass 已删除。
- 128 B MaterialTable 与 64-layer、`256×256`、9-mip texture array 是当前主材质数据源；streaming 不是 v1 Resolve 前提，后续 size-class/streaming 必须重新 benchmark 内存与画质。
- 不按材质数重复全屏扫描。
- internal/output resolution 必须分离；Velocity、TAA/Temporal Reconstruction、SSR 和 history 必须定义相机切换、resize、render-scale 与 LOD 切换失效规则。
- 所有效果位于同一主管线资源图，关闭后接近零成本；不建立三档独立管线。
- 当前不实现地形、角色、粒子、云、水等专用着色路径，只保留接入 seam。
