---
id: materials-textures
kind: domain
owner: materials-textures
state: current
verifies:
  files:
    - OEngine/src/gpu/TextureResidency.ts
    - OEngine/src/assets/TextureProduct.ts
    - OEngine/src/assets/PcMaterialTextures.ts
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
    - OEngine/src/render/pipeline/RendererCore.ts
---

# Materials And Textures

## 当前 owner 与产品

production material 只走 BC-required、RuntimeAsset container2 / texture metadata3。GLTF/WebCook 保留 PNG/JPEG/WebP/KTX2 encoded source；KHR_texture_basisu 接通。Renderer 在 GPU scene publication 前 await PcMaterialTextures 完整批次，raw 用 bounded Basis WASM cold cook，KTX 用 pinned libktx parse/extract/transcode；fixed cooked ShadeTexture.fromProduct 直接上传，不启动 codec Worker。

TextureResidency 是唯一长期 material GPU texture owner。BC7/BC4/exact R8 按 format/storage extent/full mips 分 immutable array segment，neutral layer0、live layers1..N，batch admission 与 free layer复用。TextureRef ABI3 的0..15是材质本地 slot，不是全域16段上限；logical handle4095。完整 descriptor/device dimensions/2GiB所有段峰值在 allocation/write 前预检，失败明确拒绝。

全 mip 已烘焙；coverage 两 plane 全链先就绪，其他产品保留 tail-first/minMip promotion。Renderer 为新 immutable RenderWorld runtime 在普通 frame transaction 调用 promotion，完成后才推进live clamp/revision；abort重试，replacement/recovery新runtime重新处理，稳定帧不重复扫描。WebCook可接收catalog-scoped textureCache，把已校验的disk Product送入同一publication入口。queue writes abort 后 quarantine 到真实 completion，commit/release/refcount/generation/object guard/fence 统一。GpuRenderWorld routes→NativeMaterialScene/Publication→SurfaceV4/main Visibility/VSM exact alpha；Temporal 仍读取 native material versions。source/semantic/channel/recipe 区分身份，ORM/AO共享图不丢通道，normal保留完整XYZ而不改为BC5重建。

旧5 RGBA banks、旧metadata2/codec Worker/header parser、resize/source mip/variation GPU owner、portable fallback和全域4sets配额已退休。GPUTextureManager/MipmapGenerator 对 environment/effect 仍有实际用途；Environment float radiance/IBL保持独立 owner，BC6H/VT/完整transparency未新增。

## 证据与导航

真实 BC/R8 sampling、main/VSM、Surface/Temporal/FSR、abort/retry/replacement、controlled recovery 与 fenced clear 的阶段证据只读[Texture Execution](../next-execution/eengine-v4-texture-compression-execution-2026-10.md)。software资源账与driver物理峰值分开；component不证明完整authored质量或性能收益。

架构目标及Source Map见[Texture Design](../next-design/eengine-v4-texture-compression-2026-10.md)，全局不变量见[V4母稿](../next-design/eengine-v4-native-shading-2026-10.md)。owner导航 `vibe context OEngine/src/gpu/TextureResidency.ts`，检查范围见[VALIDATION](../VALIDATION.md)；单元状态不在本域复制。
