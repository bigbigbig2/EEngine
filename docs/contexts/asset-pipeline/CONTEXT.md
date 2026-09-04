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
- 通用 package kernel 只拥有 header/directory/hash/range；Geometry sections 与不变量以当前 `OEngine/src` 和 [STATUS](../../implementation/STATUS.md) 的事实为准。
- runtime 打开 package 只做验证、驻留和上传，不重复 Meshlet、simplify、hierarchy 或 BVH build。
- R2-A 已冻结 `SourceGeometry`、`GeometryCookRecipe` 与 Package Kernel v1；精确容器 ABI 见 ADR-0008。
- R2-B 已冻结完整设备无关 Geometry package：Meshlet、可绘制 Cluster hierarchy/error、未量化保守 BVH8、未压缩 vertex/index/material sections、CPU selector、最终 bytes reopen validator 与报告。`single-level` recipe 只保留 R2-B-01 黄金兼容；完整资产使用 `renderable` recipe。
- R2-C core 已接通 validated section views → `GpuAssetStore` → compact Geometry/Cluster/Meshlet records 与连续 payload；package load 不执行 Cooker，Package ABI 也不直接冒充 WGSL ABI。
- R2-D/G2 已关闭：`load_gltf_packed()` 将真实静态 glTF 直接输出为 SourceGeometry、材质 dictionary 和 typed-array instances；A/B 的 Teapot/Damaged Helmet 与 C 的程序化几何均经过 Cooker/package 后进入生产 Packed consumer，不构造等量 `Mesh/Node3D`，runtime package open 不执行 Cooker。
- Packed glTF 的规范依据与支持边界登记在 [R2-D-10](../../references/porting/R2-D-10-packed-gltf-import.md)；multi-primitive/material 与 nested world transform 由独立 fixture 冻结，静态导入不扩张为 skin/animation runtime。
- legacy `load_gltf()`、USD/shade loader 与普通 Scene adapter 仍可服务旧对象路径；它们不再是 Packed/package 主路径 owner，随 R3/R4 consumer 迁移逐项删除或重接，不能把其存在解释成新主路径双驻留。
