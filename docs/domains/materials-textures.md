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
    - OEngine/src/assets/ImageTextureSource.ts
    - OEngine/src/assets/ImageTexturePages.ts
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

## 当前代码ownership

2026-10-20：本页只记录当前源码ownership，不代表最终集成通过或性能资格。唯一目标和阶段要求由[workstream](../../project/workstreams/active/eengine-next-clean-rebuild.yaml)指向的设计/执行决定；不再把旧BC网络产品事实写成当前实现。

普通与VT共用schema4图片目录和`ImageTextureSource`。目录/recipe/来源身份、逻辑mip、semantic/target、image/exact item由`ImageTextureProduct`定义；`ImageTexturePages`拥有immutable空间索引和完整页依赖。`ShadeTexture.fromImageSource`是cooked纹理入口，不再提供旧Product/tiled factory。source只拥有准备session，不创建长期GPU资源，close退休其CPU工作。

`CookedAssetPreparation`和现有`AssetWorkerPool`统一拥有IO、Worker、credit和image/exact receipt；不另建图片线程池。离线工具从canonical生成AVIF，合法Web输入经新冷导入成为图片item；canonical重采样和KTX冷输入解码是新链依赖，不是最终BC产品直接上传。几何协议在E4前仍保持当前唯一版本，不冒称已切新几何ABI。

`ImageTextureTranscoder`只记录原Spark选定BC7 RGB/RGBA、BC5 RG、BC4 R及exact copy，拥有按设备epoch的pipeline和有限input/scratch；`ImageTexturePageAssembly`装配唯一decoded owner到物理页。scene隐藏批次由`RendererCore`原owner提交，最终scene command发布完整必需域；正常frame不为转码增加独立submit。Spark shader由显式kernel source提供，本地evaluation不等于公开生产再分发授权，未将原shader复制进公开vendor/dist。

`TextureResidency`是普通长期array/layer、handle、neutral层、refcount与fence退休owner；mandatory图片和完整resident exact coverage先隐藏准备，再沿scene事务发布。BC5在Native sample边界重建Z，provided XYZ/moment与之区分；padded物理尺寸不改变源逻辑尺寸，`image_texture_sampling`按逐层逻辑域过滤。

`VirtualTextureResidency`唯一拥有页表、format atlas、protected tail、主/query需求、父级闭包、pending、victim/eviction/rescue及mapping/退休；`VirtualTextureFeedback`保留延迟wanted/used/union和overflow恢复。新图片lease经GPU装配/编码进入真实slot/layer，不再下载最终BC+Zstd纹理页。VT同源尾层和普通exact plane沿现有材质publication接线；全部实际组合语义留最终集成验证，不据源码接线宣称画面通过。

## 退休与交付边界

旧`TextureProduct`、`TiledTextureProduct/Source`、旧texture cook/transport/cache/decoder生产入口、旧Worker纹理任务及专用BC/Zstd vendor/build工具已删除；不存在以这些入口维持的双生产链。旧表示测试删除，必要产品/准备/驻留/事务语义由新owner的定向检查承担，完整组合矩阵归E5。历史原始结果保留，不保留可运行的旧纹理全链。

KTX只读decoder已独立归属`vendor/image-ktx`，原生成模块名不改变其冷导入职责；canonical tent resampler分别有独立WASM/native构建，不依赖旧BC encoder。材质冷准备只在本批次去重，失败/取消关闭未发布source；成功source由CPU材质/场景持有，unload后调用`image_source.close()`，不能在GPU device replacement时提前关闭。调用方原bitmap不由材质准备擅自关闭，也不建立全图RGBA replay缓存。

Residency evidence schema8报告实际mandatory上传和image encoder计数，GraphicsContext总分配/临时池单独包含encoder RGBA及block/uniform staging。常规图片任务按实际尺寸收费；冷输入导入另预留256MiB，KTX为384MiB（包含96+64+64MiB模块上界及canonical/PNG临时项），任务结束退休Worker。默认全局临时信用384MiB、encoded 16MiB、ready 64MiB，local encoded replay另有64MiB上界；不是常驻分配，也不是浏览器RSS保证。

示例加载代码已经改用图片source，hello已有一次提前生成的AVIF资产；这些不是E5最终资产资格。Bistro完整cook已按用户要求停止，未完成本地目录不可发布。E2继续直接删旧引用，不为暂时不可运行的示例恢复旧路径；最终普通/VT/几何cook、manifest、静态部署、画面和完整生命周期测试统一归E5。

Environment/HDR/IBL及其GPUTextureManager/MipmapGenerator保持各自真实owner，不因材质纹理重构误删。Native材质publication、Visibility/VSM exact alpha、Surface/query沿现有消费者组合，不新增第二套材质系统。

## 离线选优与有界交付

唯一scene Cook入口现在调用有限High/Extreme搜索，最终GPU BC/R8及材质探针评价后选优，保留同路线donor；完整资产搜索在E5才运行。缓存绑定canonical/工具/argv/target/评价/browser/device，报告按身份发布并被scene manifest引用；部署module清单未知时网络总量明确为null，不当作零成本。

统一准备owner对已请求的同urgency pack段合并Range（≤256KiB、gap≤4096B、过取≤12.5%），不等凑批；每item仍经过原Worker完整性检查。decoded图片邻域LRU双backing≤8MiB、idle5秒释放、压力逐LRU退引用，source/session退休所有consumer handle；不缓存全图/BC页，不新增第二准备pool。引用共享不重复收费，只有最后引用关闭backing，失败批次不得归还仍被其它consumer使用的credit。

## 来源与验证导航

来源pin、license、具体函数与移植/本地glue差异见[来源账本](../porting/next-renderer.md#extreme-web-asset-compression-2026-10-20)。实际已运行与未运行结果只读[当前执行§12](../next-execution/eengine-extreme-web-asset-compression-execution-2026-10.md#12-本轮p准备记录与后续实施结果)；历史纹理/VT执行记录不约束当前owner或要求恢复旧ABI。当前设计见[极致资产压缩](../next-design/eengine-extreme-web-asset-compression-2026-10.md)，全局不变量见[V4母稿](../next-design/eengine-v4-native-shading-2026-10.md)。
