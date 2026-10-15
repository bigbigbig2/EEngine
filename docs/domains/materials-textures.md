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
    - OEngine/src/render/temporal/NativeTemporalSeed.ts
    - OEngine/src/gpu/GpuAuthoredEnvironment.ts
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/gpu/NativeMaterialPhysicalBanks.ts
    - OEngine/src/material/CanonicalMaterial.ts
    - OEngine/src/assets/AssetLoadBatch.ts
    - examples/demos/14-integrated/bistro-texture-compression/cooked-scene.ts
---

# Materials And Textures

## 当前 owner 与产品

2026-10-15 Cooked加载事实：Bistro和Dungeon的完整BC Texture容器由共享`CookedAssetPreparation` Dedicated Worker读取并执行container/section/Product完整SHA与布局验证，主线程只从实际任务receipt重建本realm immutable品牌；不再在demo主线程哈希大payload。已知MASK albedo/coverage按任务优先级先读，仍等待所有完整Product，尚未实施目录identity去重或INIT-3首屏依赖调整。128MiB输入上限保留，HEAD确定长度后预留输入与hash峰值，GET不允许超额或非identity编码；CPU不可变replay payload另计长期存储。Worker不执行BC重新编码，也不拥有texture GPU资源；`ShadeTexture.fromProduct`之后的唯一驻留/采样链不变。

2026-10-14以`2caf5fe2`核对生产资产→驻留→Native采样；以下为实现事实，不表示VT或整体加载性能已经验收。

production material 只走 BC-required、RuntimeAsset container2 / texture metadata3。GLTF/WebCook 保留 PNG/JPEG/WebP/KTX2 encoded source；KHR_texture_basisu 接通。Renderer 在 GPU scene publication 前 await PcMaterialTextures 完整批次，raw 用 bounded Basis WASM cold cook，KTX 用 pinned libktx parse/extract/transcode；fixed cooked ShadeTexture.fromProduct 直接上传，不启动 codec Worker。

TextureResidency 是唯一长期 material GPU texture owner。BC7/BC4/exact R8 按 format/storage extent/full mips 分 immutable array segment，neutral layer0、live layers1..N，batch admission 与 free layer复用。TextureRef ABI3 的0..15是材质本地 slot，不是全域16段上限；logical handle4095。完整 descriptor/device dimensions/2GiB所有段峰值在 allocation/write 前预检，失败明确拒绝。

segment创建时已按整张尺寸、全部mips和layer容量分配。tail-first/minMip promotion只改变已上传内容和采样clamp，不释放未上传mip的物理容量；只有全部live layer退休后才回收segment。TextureProduct每mip指向chunk，NativeMaterialBindings生成有限bank路由及显式梯度采样，NativeMaterialPhysicalBanks不拥有page table/feedback。当前没有按纹理tile的页索引、物理页淘汰和反馈读取链，不能把渐进mip上传称为VT。

全 mip 已烘焙；coverage 两 plane 全链先就绪，其他产品保留 tail-first/minMip promotion。Renderer 为新 immutable RenderWorld runtime 在普通 frame transaction 调用 promotion，完成后才推进live clamp/revision；abort重试，replacement/recovery新runtime重新处理，稳定帧不重复扫描。WebCook可接收catalog-scoped textureCache，把已校验的disk Product送入同一publication入口。queue writes abort 后 quarantine 到真实 completion，commit/release/refcount/generation/object guard/fence 统一。GpuRenderWorld routes→NativeMaterialScene/Publication→SurfaceV4/main Visibility/VSM exact alpha；Native directory 为 32B/slot，其中 words4/5 携带完整 signature/valueRevision，Seed writer 直接消费；单独 versions buffer 已退休。raster directory 仍为独立 16B/slot，不扩大 raster ABI。source/semantic/channel/recipe 区分身份，ORM/AO共享图不丢通道，normal保留完整XYZ而不改为BC5重建。

旧5 RGBA banks、旧metadata2/codec Worker/header parser、resize/source mip/variation GPU owner、portable fallback和全域4sets配额已退休。GPUTextureManager/MipmapGenerator 对 environment/effect 仍有实际用途；Environment float radiance/IBL保持独立 owner，BC6H/VT/完整transparency未新增。

Bistro cooked loader通过loadAssetBatch并发读取Texture Products，AssetReadBudget约束transport活跃字节并覆盖拼接/解析；已完成Products不在该预算内。纹理容器保留默认hash校验，批次失败取消并等待workers，geometry asset的早/晚成功结果均被清理。此loading helper不拥有长期GPU资源；并发/字节有界不自动证明整体冷启动加速。

## 证据与导航

真实 BC/R8 sampling、main/VSM、Surface/Temporal/FSR、abort/retry/replacement、controlled recovery 与 fenced clear 的阶段证据只读[Texture Execution](../next-execution/eengine-v4-texture-compression-execution-2026-10.md)。software资源账与driver物理峰值分开；component不证明完整authored质量或性能收益。

架构目标及Source Map见[Texture Design](../next-design/eengine-v4-texture-compression-2026-10.md)，全局不变量见[V4母稿](../next-design/eengine-v4-native-shading-2026-10.md)。owner导航 `vibe context OEngine/src/gpu/TextureResidency.ts`，检查范围见[VALIDATION](../VALIDATION.md)；单元状态不在本域复制。
