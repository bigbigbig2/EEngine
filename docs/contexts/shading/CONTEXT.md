# Shading Context

## 职责

根据 VisibilityKey 重建 surface attributes，执行 Standard PBR、IBL、Clustered Lighting、CSM、Transparency、Temporal Reconstruction、Upscaling 和 Post；Decal 当前只保留接入 seam，implementation/Gate 延期。

## 约束

- Standard PBR 走单次通用 Material Resolve。
- Packed production 已由一次 `PackedMaterialResolvePass` 从 VisibilityKey 经 RasterWork 唯一定位 Meshlet，重建 Standard PBR Surface + velocity；active material 数不增加 fullscreen draw。
- R4-B 已迁移 R2-D-08/R2-D-09 的 perspective barycentric、analytic texture gradient、normal/tangent frame 与 motion 数学，没有重新实现第二套算法。
- Packed Velocity 使用 Instance ABI 的 CPU 预计算 `previous_from_current`；奇异 motion 显式输出零，Shader 禁止逐像素矩阵求逆，独立 Packed Velocity pass 已删除。
- 224 B MaterialTable v3 与标准/高分辨率双 texture array 是当前主材质数据源：标准池为 64-layer `256×256` 9 mips，高分辨率池为惰性 16-layer `4096×4096` 13 mips。每张 baseColor/normal/ORM/emissive 纹理独立选择 UV0/UV1/UV2 与 transform。4K 池解决当前高分辨率资产验收，不等价于完成 streaming；后续压缩/size-class/streaming 仍必须重新 benchmark 内存与画质。
- 不按材质数重复全屏扫描。
- internal/output resolution 必须分离；Velocity、TAA/Temporal Reconstruction、SSR 和 history 必须定义相机切换、resize、render-scale 与 LOD 切换失效规则。
- 所有效果位于同一主管线资源图，关闭后接近零成本；不建立三档独立管线。
- 当前不实现地形、角色、粒子、云、水等专用着色路径，只保留接入 seam。
