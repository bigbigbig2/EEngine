---
id: materials-textures
kind: domain
owner: materials-textures
state: current
verifies:
  - OEngine/src/gpu/TextureResidency.ts
  - OEngine/src/assets/TextureAssetPackage.ts
---
# Materials And Textures

## 当前 owner 与产品

本轮核对入口为 [TextureResidency](../../OEngine/src/gpu/TextureResidency.ts)、TextureAssetPackage 和材质/纹理 publication。TextureResidency 维护 bank、residentMipRange、material descriptors 及资源账；GPU 材质/纹理身份供唯一 Surface 链消费。Geometry Product 不拥有图像 bytes，Loader 不持有长期 GPU texture owner。

解码/发布、物理 residency 和 shader 采样是不同责任。一个 residentMipRange 或库存在不证明采样 clamp、完整格式/材质组合、正确退休或实际释放内存；它们需要调用生产 consumer 的独立验证。本次工具重构不将这些目标认证为完成。

## 目标与验证范围

未来 native 材质目标和 publication 边界遵循[当前设计](../next-design/eengine-v4-native-shading-2026-10.md)，逐单元接线遵循[执行计划](../next-execution/eengine-v4-native-shading-execution-2026-10.md)。当前 TextureResidency 不等于未来完整 Virtual Texture 已实现。

owner 导航用 `vibe context OEngine/src/gpu/TextureResidency.ts`；检查范围见[VALIDATION](../VALIDATION.md)。已退休的 claims 与旧材质协调器不进入当前入口。
