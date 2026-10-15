---
id: materials-textures
kind: domain
owner: materials-textures
state: current
verifies:
  files:
    - OEngine/src/gpu/TextureResidency.ts
    - OEngine/src/assets/TextureProduct.ts
    - OEngine/src/assets/TiledTextureProduct.ts
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
    - examples/demos/14-integrated/shared/cooked-scene.ts
---

# Materials And Textures

## 当前 owner 与产品

2026-10-16新增CPU侧tiled产品准备能力：`TiledTextureProduct`认证独立目录并检查完整mip/plane/payload/tail布局；`TiledTextureCook`通过原PcTextureCook的实际mip回调冷生成128+8 gutter的BC tiles、到1×1的packed tail及完整resident planes。offline scene工具的显式`--vt`选项发布内容寻址pack/directory/shards和manifest入口，未修改现行演示的生产资源选择。Cooked协议2沿同一Worker池打开目录、按range/shard读并校验请求tile；完整目录留主owner，每批最多64条记录、1MiB合并range，ready租约/独占transfer与128MiB有界缓存分开记账，session关闭/取消/重试可释放。这里只实现CPU/冷产物链；GPU长期owner仍是下述TextureResidency，尚无生产VT页池/页表/采样/反馈，不能据此宣称加载或GPU性能已改善。详细实现范围与检查只读[VT执行](../next-execution/eengine-streaming-vt-execution-2026-10.md#6-vt-1实施与逐项复核2026-10-16)。

2026-10-15 Cooked加载事实：Bistro和Dungeon的完整BC Texture容器由共享`CookedAssetPreparation` Dedicated Worker读取并执行container/section/Product完整SHA与布局验证，主线程只从实际任务receipt重建本realm immutable品牌；不再在demo主线程哈希大payload。已知MASK albedo/coverage按任务优先级先读，共享Cooked入口按manifest中的期望Product identity只读取/验证一次，URI alias保留各自sampler与UV，仍等待所有完整Product；geometry metadata/root读取与真实Native物理layout/必要Pipeline准备重叠。128MiB输入上限保留，HEAD确定长度后预留输入与hash峰值，GET不允许超额或非identity编码；CPU不可变replay payload另计长期存储。Worker不执行BC重新编码，也不拥有texture GPU资源；`ShadeTexture.fromProduct`之后的唯一驻留/采样链不变。

2026-10-14以`2caf5fe2`核对生产资产→驻留→Native采样；以下为实现事实，不表示VT或整体加载性能已经验收。

production material 只走 BC-required、RuntimeAsset container2 / texture metadata3。GLTF/WebCook 保留 PNG/JPEG/WebP/KTX2 encoded source；KHR_texture_basisu 接通。Renderer 在 GPU scene publication 前 await PcMaterialTextures 完整批次，raw 用 bounded Basis WASM cold cook，KTX 用 pinned libktx parse/extract/transcode；fixed cooked ShadeTexture.fromProduct 直接上传，不启动 codec Worker。

TextureResidency 是唯一长期 material GPU texture owner。BC7/BC4/exact R8 按 format/storage extent/full mips 分 immutable array segment，neutral layer0、live layers1..N，batch admission 与 free layer复用。TextureRef ABI3 的0..15是材质本地 slot，不是全域16段上限；logical handle4095。完整 descriptor/device dimensions/2GiB所有段峰值在 allocation/write 前预检，失败明确拒绝。

segment创建时已按整张尺寸、全部mips和layer容量分配。tail-first/minMip promotion只改变已上传内容和采样clamp，不释放未上传mip的物理容量；只有全部live layer退休后才回收segment。TextureProduct每mip指向chunk，NativeMaterialBindings生成有限bank路由及显式梯度采样，NativeMaterialPhysicalBanks不拥有page table/feedback。当前没有按纹理tile的页索引、物理页淘汰和反馈读取链，不能把渐进mip上传称为VT。

全 mip 已烘焙；coverage 两 plane 全链先就绪，其他产品保留 tail-first/minMip promotion。Renderer 在普通frame transaction调用有界promotion：每帧最多4MiB、128个物理copy，refinement staging共16MiB，256KiB块公平轮转；只传新增mip，partial cursor/全plane mip完成后才推进live clamp/revision，abort重试不暴露未完整mip，全部full后O(1)退出。初始tail/全部MASK alpha依赖使用最多256MiB staging的scene事务。WebCook可接收catalog-scoped textureCache，把已校验的disk Product送入同一publication入口。纹理上传统一mapped staging+encoder copy，不再queue.writeTexture；staging按所属submit fence销毁，commit/release/refcount/generation/object guard/fence统一。GpuRenderWorld routes→NativeMaterialScene/Publication→SurfaceV4/main Visibility/VSM exact alpha；Native directory 为 32B/slot，其中 words4/5 携带完整 signature/valueRevision，Seed writer 直接消费；单独 versions buffer 已退休。raster directory 仍为独立 16B/slot，不扩大 raster ABI。source/semantic/channel/recipe 区分身份，ORM/AO共享图不丢通道，normal保留完整XYZ而不改为BC5重建。

旧5 RGBA banks、旧metadata2/codec Worker/header parser、resize/source mip/variation GPU owner、portable fallback和全域4sets配额已退休。GPUTextureManager/MipmapGenerator 对 environment/effect 仍有实际用途；Environment float radiance/IBL保持独立 owner，BC6H/VT/完整transparency未新增。

Bistro/Dungeon通过同一个shared/cooked-scene入口和CookedAssetPreparation信用控制并发读取唯一Texture Products；已完成且为replay保留的不可变Products不在临时信用内。纹理容器保留默认hash校验，批次失败取消并等待workers，geometry asset的早/晚成功结果均被清理。此loading helper不拥有长期GPU资源；并发/字节有界不自动证明整体冷启动加速。

Native snapshot只比较独立alpha依赖的代码、实际资源、常量/输入与cutoff来报告coverage变化；纯shading mip发布不再触发MASK/VSM全域失效。移除MASK、修改cutoff或coverage资源仍会失效。

## 证据与导航

真实 BC/R8 sampling、main/VSM、Surface/Temporal/FSR、abort/retry/replacement、controlled recovery 与 fenced clear 的阶段证据只读[Texture Execution](../next-execution/eengine-v4-texture-compression-execution-2026-10.md)。software资源账与driver物理峰值分开；component不证明完整authored质量或性能收益。

架构目标及Source Map见[Texture Design](../next-design/eengine-v4-texture-compression-2026-10.md)，全局不变量见[V4母稿](../next-design/eengine-v4-native-shading-2026-10.md)。owner导航 `vibe context OEngine/src/gpu/TextureResidency.ts`，检查范围见[VALIDATION](../VALIDATION.md)；单元状态不在本域复制。
