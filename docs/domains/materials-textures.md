---
id: materials-textures
kind: domain
owner: materials-textures
state: current
verifies:
  files:
    - OEngine/src/gpu/TextureResidency.ts
    - OEngine/src/gpu/VirtualTextureResidency.ts
    - OEngine/src/gpu/VirtualTextureFeedback.ts
    - OEngine/src/gpu/GraphicsContext.ts
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
    - examples/integrated/dungeon-warkarma-texture-compression/cooked-scene.ts
---

# Materials And Textures

## 当前 owner 与产品

VT复审（2026-10-16）：实际Surface反馈先经1KiB workgroup full-key mailbox，再以全局单调wanted/used位首写去重；保留全部C/X/Y查询、union overflow恢复和三slot延迟。tiled bootstrap最多4entry共用现有provider信用与scene事务，取消等待全部job释放；同graph不同mip extent采用固定15层实例route，不产生尺寸专用shader。压力下同级resident/in-flight需求优先且读取必须有free/reclaimable物理slot，活跃lease计入槽额度；仍保护实际used fallback，不降低目标或假报complete。结果和成本见当前VT执行§9。

2026-10-16 Streaming VT生产路径：`TiledTextureProduct/TiledTextureSource`发布独立认证目录和有界provider，冷cook为128 interior+8 gutter、144物理页、≤64起直到1×1的单槽tail。`VirtualTextureResidency`是页池/整数页表/逻辑与物理generation、protected tail、当前需求/粗层闭包、pending/eviction/rescue、上传/事务/退休的唯一owner；`VirtualTextureFeedback`拥有三slot延迟readback、wanted/used/union bitsets和overflow恢复。Native实际C/X/Y/custom graph查询反馈，LibVT显式梯度/LOD与Wicked双mip组合适配，无第二套材质系统。页上传只改residency，不改content/Temporal/VSM identity。

选中tiled shading planes不读完整Product、不建立完整extent、不promote、不保留整套细页replay。R8和真实alpha/UV依赖保持完整resident；不能安全虚拟化的RGB alpha依赖明确要求resident产品。`cooked-scene`按manifest选择tiled目录+tail+mandatory后发布，细页沿正常帧upload→mapping→Surface→feedback推进，无私有submit。旧完整Product仍服务raw输入、未提供tiled的资产和真正resident planes，验证语义不变。

Native constants/directory合并为16B header+原32B entries的raw-u32 publication，raster仍独立16B；最宽Product/compact/physicalSun/SSSR+VT为16 SSBO/4 storage textures。初始预算经RendererConfig进入owner；三格式物理池合计≤256MiB，页表+route≤32MiB，CPU运行页记录保守admission≤128MiB，provider目录/cache及mandatory resident另计。配置不可变，运行期改预算需重建Renderer。真实验证和未闭合事项只读[VT执行](../next-execution/eengine-streaming-vt-execution-2026-10.md)，此处不宣称整Renderer性能资格。

VT evidence区分atlas/page-table/feedback分配、映射页resident/pinned、route与staging；Graphics汇总显式包含VT owner。resident mandatory纹理按实际plane大小统计，不以CPU是否保留payload代替GPU字节。provider fetched/hash/overfetch仅统计成功receipt，failedTasks包括取消/重试；这些不是完整网络流量或hash失败次数。冷cook可复用认证完整Product，重放相同mip resampler并仅编码必要边界条带，不改变BC quality6、normal或sRGB recipe。

以下2026-10-15/14内容描述完整resident产品路线，tiled资产的差异以上段为准。
2026-10-15 Cooked加载事实：Bistro和Dungeon的完整BC Texture容器由共享`CookedAssetPreparation` Dedicated Worker读取并执行container/section/Product完整SHA与布局验证，主线程只从实际任务receipt重建本realm immutable品牌；不再在demo主线程哈希大payload。已知MASK albedo/coverage按任务优先级先读，共享Cooked入口按manifest中的期望Product identity只读取/验证一次，URI alias保留各自sampler与UV，仍等待所有完整Product；geometry metadata/root读取与真实Native物理layout/必要Pipeline准备重叠。128MiB输入上限保留，HEAD确定长度后预留输入与hash峰值，GET不允许超额或非identity编码；CPU不可变replay payload另计长期存储。Worker不执行BC重新编码，也不拥有texture GPU资源；`ShadeTexture.fromProduct`之后的唯一驻留/采样链不变。

2026-10-14以`2caf5fe2`核对生产资产→驻留→Native采样；以下为实现事实，不表示VT或整体加载性能已经验收。

production material 只走 BC-required、RuntimeAsset container2 / texture metadata3。GLTF/WebCook 保留 PNG/JPEG/WebP/KTX2 encoded source；KHR_texture_basisu 接通。Renderer 在 GPU scene publication 前 await PcMaterialTextures 完整批次，raw 用 bounded Basis WASM cold cook，KTX 用 pinned libktx parse/extract/transcode；fixed cooked ShadeTexture.fromProduct 直接上传，不启动 codec Worker。

TextureResidency 是唯一长期 material GPU texture owner。BC7/BC4/exact R8 按 format/storage extent/full mips 分 immutable array segment，neutral layer0、live layers1..N，batch admission 与 free layer复用。TextureRef ABI3 的0..15是材质本地 slot，不是全域16段上限；logical handle4095。完整 descriptor/device dimensions/2GiB所有段峰值在 allocation/write 前预检，失败明确拒绝。

segment创建时已按整张尺寸、全部mips和layer容量分配。tail-first/minMip promotion只改变已上传内容和采样clamp，不释放未上传mip的物理容量；只有全部live layer退休后才回收segment。TextureProduct每mip指向chunk，NativeMaterialBindings生成有限bank路由及显式梯度采样，NativeMaterialPhysicalBanks不拥有page table/feedback。该完整resident路线的渐进mip上传本身不构成VT；tiled路线由上述独立VT owner负责。

全 mip 已烘焙；coverage 两 plane 全链先就绪，其他产品保留 tail-first/minMip promotion。Renderer 在普通frame transaction调用有界promotion：每帧最多4MiB、128个物理copy，refinement staging共16MiB，256KiB块公平轮转；只传新增mip，partial cursor/全plane mip完成后才推进live clamp/revision，abort重试不暴露未完整mip，全部full后O(1)退出。初始tail/全部MASK alpha依赖使用最多256MiB staging的scene事务。WebCook可接收catalog-scoped textureCache，把已校验的disk Product送入同一publication入口。纹理上传统一mapped staging+encoder copy，不再queue.writeTexture；staging按所属submit fence销毁，commit/release/refcount/generation/object guard/fence统一。GpuRenderWorld routes→NativeMaterialScene/Publication→SurfaceV4/main Visibility/VSM exact alpha；Native directory 为 32B/slot，其中 words4/5 携带完整 signature/valueRevision，Seed writer 直接消费；单独 versions buffer 已退休。raster directory 仍为独立 16B/slot，不扩大 raster ABI。source/semantic/channel/recipe 区分身份，ORM/AO共享图不丢通道，normal保留完整XYZ而不改为BC5重建。

旧5 RGBA banks、旧metadata2/codec Worker/header parser、resize/source mip/variation GPU owner、portable fallback和全域4sets配额已退休。GPUTextureManager/MipmapGenerator 对 environment/effect 仍有实际用途；Environment float radiance/IBL保持独立 owner，BC6H/完整transparency未新增；VT按上述路径独立接入。

Bistro/Dungeon通过同一个shared/cooked-scene入口和CookedAssetPreparation信用控制并发读取唯一Texture Products；已完成且为replay保留的不可变Products不在临时信用内。纹理容器保留默认hash校验，批次失败取消并等待workers，geometry asset的早/晚成功结果均被清理。此loading helper不拥有长期GPU资源；并发/字节有界不自动证明整体冷启动加速。

Native snapshot只比较独立alpha依赖的代码、实际资源、常量/输入与cutoff来报告coverage变化；纯shading mip发布不再触发MASK/VSM全域失效。移除MASK、修改cutoff或coverage资源仍会失效。

## 证据与导航

真实 BC/R8 sampling、main/VSM、Surface/Temporal/FSR、abort/retry/replacement、controlled recovery 与 fenced clear 的阶段证据只读[Texture Execution](../next-execution/eengine-v4-texture-compression-execution-2026-10.md)。software资源账与driver物理峰值分开；component不证明完整authored质量或性能收益。

架构目标及Source Map见[Texture Design](../next-design/eengine-v4-texture-compression-2026-10.md)，全局不变量见[V4母稿](../next-design/eengine-v4-native-shading-2026-10.md)。owner导航 `vibe context OEngine/src/gpu/TextureResidency.ts`，检查范围见[VALIDATION](../VALIDATION.md)；单元状态不在本域复制。
