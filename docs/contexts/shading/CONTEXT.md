# Shading Context

## 职责

根据 VisibilityKey 重建 surface attributes，执行 Standard PBR、IBL、Clustered Lighting、Shadow、Transparency、Temporal 和 Post。

## 约束

- Standard PBR 走单次通用 Material Resolve。
- MaterialTable 与 resident texture page 是主材质数据源。
- 不按材质数重复全屏扫描。
- Velocity、TAA、SSR 和 history 必须定义相机切换、resize、LOD 切换和页面恢复时的失效规则。
- 所有效果位于同一主管线资源图，关闭后接近零成本；不建立三档独立管线。

