# Asset Pipeline Context

## 职责

把 glTF/其他源资产转换为设备无关、可版本化、GPU-ready 的 Runtime Asset。包含规范化、Meshopt、Meshlet、Cluster Group、LOD hierarchy、BVH、压缩和验证。

## 不职责

- 不创建长期 GPU Buffer/Texture owner。
- 不决定逐帧 LOD。
- 不把源格式对象暴露给渲染热路径。

## 关键契约

- `Source Asset → Runtime Asset Package` 可离线重建。
- ABI 变更需要版本、迁移或明确拒绝旧资产。
- Cooker 输出必须包含 bounds、geometric error、父子关系和材质范围验证。

