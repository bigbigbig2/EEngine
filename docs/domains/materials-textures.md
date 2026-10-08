---
id: materials-textures
kind: domain
owner: materials-textures
state: current
verifies:
  files:
    - OEngine/src/gpu/TextureResidency.ts
    - OEngine/src/assets/TextureAssetPackage.ts
    - OEngine/src/assets/codec
    - OEngine/src/assets/web-cook/WebCookSceneSource.ts
    - OEngine/src/loaders/gltf
    - OEngine/src/gpu/NativeMaterialBindings.ts
    - OEngine/src/gpu/GpuNativeMaterialScene.ts
    - OEngine/src/gpu/GpuNativeMaterialPublication.ts
    - OEngine/src/render/surface/NativeVisibilityPass.ts
    - OEngine/src/render/vsm/VsmAtlasRasterPass.ts
    - OEngine/src/render/temporal/NativeTemporalFactsPass.ts
    - OEngine/src/gpu/GpuAuthoredEnvironment.ts
---
# Materials And Textures

## 当前 owner 与产品

2026-10-09 源码核对入口为 [TextureResidency](../../OEngine/src/gpu/TextureResidency.ts)、TextureAssetPackage、codec、GLTF/WebCook 与全部 native 材质 consumers。TextureResidency 维护 5 个 RGBA banks 与 4 package slots/最多 4 sets、residentMipRange、logical generation 和资源账；GpuRenderWorld transaction 将 routes 交给 NativeMaterialScene/Publication，SurfaceV4、main alpha-tested Visibility 与 VSM native coverage 消费。Geometry Product 不拥有图像 bytes，Loader 不持有长期 GPU texture owner。

当前 raw GLB/WebCook 图像仍 createImageBitmap → ShadeImage/Texture → standalone GPU texture/mip → RGBA bank resize/mip。GLTF required KHR_texture_basisu 仍拒绝；公开 KTX2 Worker helper 没有接入该默认 loader。显式 TextureAssetPackageV2 则确实创建 variant.format 的 array texture 并上传 BC blocks，不再展开 RGBA；它不证明真实 authored 默认场景已压缩。

KTX-Software libktx_read 4.4.2 已 vendor，Worker/helper 会转码再 serialize/reopen package；test-only ReferenceTextureCodec 不是 production offline BC cooker。progressive cooked upload 分配完整 GPU mip chain，仅减少初始上传量；现有 minMip clamp/revision 由 transaction 发布。NativeTemporalFacts 读取 native material versions。独立 Environment owner 生成 float radiance/IBL，当前没有完整 BC6H 路径。

解码/发布、物理 residency 和 shader 采样是不同责任。一个 residentMipRange 或库存在不证明采样 clamp、完整格式/材质组合、正确退休或实际释放内存；它们需要调用生产 consumer 的独立验证。本次工具重构不将这些目标认证为完成。

## 目标与验证范围

native 材质遵循[V4 全局边界](../next-design/eengine-v4-native-shading-2026-10.md)。下一纹理产品目标和 publication/cutover 边界遵循 [Texture Compression Design](../next-design/eengine-v4-texture-compression-2026-10.md)，逐单元接线遵循 [Texture Execution](../next-execution/eengine-v4-texture-compression-execution-2026-10.md)。它们是未实施目标；本域记录当前源码，不将 BC-required、schema3 或 Virtual Texture 写成已完成。

owner 导航用 `vibe context OEngine/src/gpu/TextureResidency.ts`；检查范围见[VALIDATION](../VALIDATION.md)。已退休的 claims 与旧材质协调器不进入当前入口。
