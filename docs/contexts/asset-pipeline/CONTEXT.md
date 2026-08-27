# Asset Pipeline Context

## 职责

把 glTF/其他源资产转换为设备无关、可版本化、GPU-ready 的 Runtime Asset。包含规范化、meshoptimizer 优先的 Meshlet、Cluster Group、LOD hierarchy、BVH、压缩、纹理预处理和验证。

## 不职责

- 不创建长期 GPU Buffer/Texture owner。
- 不决定逐帧 LOD。
- 不把源格式对象暴露给渲染热路径。

## 关键契约

- `Source Asset → Runtime Asset Package` 可离线重建。
- ABI 变更需要版本、迁移或明确拒绝旧资产。
- Cooker 输出必须包含 bounds、geometric error、父子关系和材质范围验证。
- 当前输出优先全驻留紧凑数据；streaming page 只保留未来扩展字段，不支配 v1 ABI。
- 通用 package kernel 只拥有 header/directory/hash/range；Geometry sections 与不变量由 `implementation/04-geometry-cooker-and-hierarchy.md` 拥有。
- runtime 打开 package 只做验证、驻留和上传，不重复 Meshlet、simplify、hierarchy 或 BVH build。
- R2-A 已冻结 `SourceGeometry`、`GeometryCookRecipe` 与 Package Kernel v1；精确容器 ABI 见 ADR-0008。
- R2-B 已冻结完整设备无关 Geometry package：Meshlet、可绘制 Cluster hierarchy/error、未量化保守 BVH8、未压缩 vertex/index/material sections、CPU selector、最终 bytes reopen validator 与报告。`single-level` recipe 只保留 R2-B-01 黄金兼容；完整资产使用 `renderable` recipe。
- 当前唯一入口是 R2-C：validated section views → GPU residency/compact tables。package load 不得执行 Cooker；legacy Loader/`niMeshlets` consumer 按 R2-B-06 矩阵在 R2-C/D 迁移删除。
