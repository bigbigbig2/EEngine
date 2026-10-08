---
id: eengine-v4-texture-compression-2026-10
state: current
verifies:
  files:
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - OEngine/src/assets/TextureAssetPackage.ts
    - OEngine/src/assets/RuntimeAssetManifestV2.ts
    - OEngine/src/assets/RuntimeAssetResidency.ts
    - OEngine/src/assets/codec
    - OEngine/src/assets/web-cook/WebCookSceneSource.ts
    - OEngine/src/loaders/gltf
    - OEngine/src/texture
    - OEngine/src/gpu/TextureResidency.ts
    - OEngine/src/gpu/GpuTextureRefAbi.ts
    - OEngine/src/gpu/TextureBindingSetPolicy.ts
    - OEngine/src/gpu/TextureVariation.ts
    - OEngine/src/gpu/TextureVariationResidency.ts
    - OEngine/src/gpu/GPUTextureManager.ts
    - OEngine/src/gpu/MipmapGenerator.ts
    - OEngine/src/gpu/NativeMaterialBindings.ts
    - OEngine/src/gpu/GpuNativeMaterialScene.ts
    - OEngine/src/gpu/GpuNativeMaterialPublication.ts
    - OEngine/src/gpu/GpuRenderWorld.ts
    - OEngine/src/gpu/GpuAuthoredEnvironment.ts
    - OEngine/src/material/StandardAppearanceGraph.ts
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/render/surface
    - OEngine/src/render/vsm
    - OEngine/src/render/temporal/NativeTemporalFactsPass.ts
    - validation/workloads/lighting-acceptance-v1.yaml
---

# PC-First GPU Native Texture Compression

这是 virtual-resources-v4 的 Texture Compression slice 设计 authority；阶段状态、施工入口和实测结果只在[执行计划](../next-execution/eengine-v4-texture-compression-execution-2026-10.md)。[V4 母稿](./eengine-v4-native-shading-2026-10.md)仍是全局 authority。本文冻结目标，不宣称已经实现或验收。

2026-10-09 已执行 `git fetch`；审查起点 HEAD/origin/master 均为 `579fd521b3e948ca2f3bb716aaec28f9d758cb0a`，工作区干净。审查沿实际 producer/publication/consumer 展开，Git 历史只作辅助。M3 关闭记录留在 Lighting execution；本轮不改 production TS/WGSL，不运行重型 authored benchmark。

## 1. 当前源码事实

### 1.1 实际数据流

```mermaid
flowchart TD
  GLB[Raw GLB PNG/JPEG/WebP] --> Decode[createImageBitmap / ShadeImage / ShadeTexture]
  Web[WebCook geometry catalog + authored image reader] --> Decode
  Decode --> Source[GPUTextureManager standalone RGBA texture + source mip generation]
  Source --> Raw[TextureResidency resize copy + RGBA array bank mip generation]
  External[Explicit KTX2 helper caller] --> Worker[AssetCodecService / Worker / libktx_read]
  Worker --> Repack[BC mip arrays / serialize TextureAssetPackageV2 / reopen]
  Encoded[Explicit encoded TextureAssetPackageV2] --> Segment[TextureResidency package segments / compressed writeTexture]
  Repack --> Segment
  Raw --> Publish[GpuRenderWorld transaction / TextureRef / Native Material publication]
  Segment --> Publish
  Publish --> Surface[SurfaceV4 native material sampling]
  Publish --> Alpha[NativeVisibility + VSM native alpha coverage]
  Publish --> Temporal[Native material versions / NativeTemporalFacts]
  Environment[Authored or Physical Environment owner] --> IBL[float radiance / GGX / irradiance / DFG]
  IBL --> Surface
```

| 层                    | 当前事实 / ownership                                                                                                                                           | 证据入口                                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Raw input             | GltfLoader 解 PNG/JPEG/WebP；required `KHR_texture_basisu` 明确拒绝；没有把公开 KTX helper 接入该 loader                                                       | `loaders/gltf/GltfLoader.ts`、`gltfTextures.ts`                                  |
| WebCook input         | Geometry 已是 Product；图像仍 range read 后 `createImageBitmap`，按 source/sampler/usage 缓存 Promise；失败 Promise 没有自动移除                               | `assets/web-cook/WebCookSceneSource.ts::createWebCookSceneSourceAsync`           |
| CPU asset             | ShadeImage 保存 decoded image；ShadeTexture 保存 sampler/usage 或 runtime package。当前 cache 的 usage 分 srgb/linear/normal，不是完整 scalar-channel identity | `texture/*`、WebCook mapper                                                      |
| Raw persistent GPU    | standalone source texture 与 RGBA array bank 并存；先 source mip，再 resize copy，再给整个 touched bank 生 mip                                                 | `GPUTextureManager.obtain`、`TextureResidency.stage`、`MipmapGenerator`          |
| Cooked persistent GPU | package segment 按 `variant.format` 创建 2D array，直接上传 encoded blocks。BC 不会又展开成 RGBA8                                                              | `TextureResidency.applyPackageSegmentPlans`、`stageTextureAssetPackageV2ToLayer` |
| KTX ingestion         | lazy WASM Worker 输出 BC；helper 再 serialize/reopen package。是可调用 codec 基础，不能据此称 authored GLB 已走 BC                                             | `Ktx2BasisCodec.prepareKtx2TextureAssetPackageV2`                                |
| Offline writer        | V2 writer 支持 final encoded variants；低质量 `ReferenceTextureCodec` 是 test-only，不是 production BC cooker                                                  | `TextureAssetPackage.ts`、`ReferenceTextureCodec.ts`                             |
| Shader binding        | native bindings 只声明实际用到的 bank/resource，静态 WGSL；不是 bindless，也不是总会绑定 9 张纹理                                                              | `NativeMaterialBindings.createNativeMaterialBindings`                            |
| Coverage              | main alpha-tested Visibility / VSM 共用 native alpha graph，自己的 geometry producer 提供 C/X/Y                                                                | `nativeMaterialCoverageProgram`、`NativeVisibilityPass`、`VsmAtlasRasterPass`    |
| Temporal              | 生产 NativeTemporalFacts 读 native material versions；旧 `temporal_facts.ts` 的 texture route reader 不是当前 pass                                             | `NativeTemporalFactsPass.ts`、`native_surface_aux.ts`                            |
| Transparent           | 当前 Renderer/FrameProgram 没有完整 authored transparent texture shading producer；classification/mask 留存不等于功能完成                                      | Renderer/FrameProgram、native pass 接线                                          |
| Environment           | authored octahedral source、radiance mip、GGX、irradiance/DFG 属独立 owner；主要 GPU 产品是 rgba16float                                                        | `GpuAuthoredEnvironment`、`GPUSceneEnvironmentManager`、PhysicalEnvironment      |

因此答案是：**BC compressed package upload 已存在生产可消费入口；真实 large authored GLB/WebCook 默认链仍是 decoded RGBA。** 不把 test fixture 的 BC 格式覆盖追认为所有 native material 数值正确。

### 1.2 当前容量、mip 和成本陷阱

- 5 个 RGBA size classes：256/512/1024/2048/4096；默认 layer 上限 64/32/16/32/2，实际可由场景配置改大。另有 4 个 package 槽位 × 最多 4 个 sets，最多 16 个 package segments，材质最多引用 4 个 package segments。
- segment 按 format/width/height/mipCount 精确分组；capacity 不原地增长，新批次容易新建 segment。logical descriptor capacity 又与 RGBA bank capacities 绑定，不能支持大目录而不一起增加 RGBA allocation。
- TextureRef ABI2 是 version4 / bank4 / routing2 / layer22；logical handle/generation 与物理 route 不同。一个 format 一个 GPU array，同 format 不同 base extent/mipCount 也不能混在同一个 array。
- 当前 `GPU_TEXTURE_BANK_COUNT=9` 的 5+4 分配是历史物理分工；native 实际资源生成不要求这套分工。完整 Standard graph 最多 10 个 texture roles，不能假定 4 package slots 足够。
- cooked coarse-first 会分配**完整 mip chain**，只先上传 tail；不是稀疏分配，不减少 reserved VRAM。alpha-mask 当前从 mip0 开始；base-color 含 alpha 不自动等价于 alpha-mask semantic。
- minMip 编码是有限 0..6/full，promotion 小于 6 会跳到 0；不是任意逐 mip scheduler。revision/minMip 在成功提交后发布，失败不能发布新 clamp。
- package uploader 将行补到 256B 并 `.slice()`；`queue.writeTexture` 本身不要求 256B row 对齐，encoder buffer-to-texture copy 才要求。GPU/driver copy 仍不可避免，不能宣称 upload 零复制。
- `physicalTextureExtent` 是 block upload footprint，**不是 GPUTexture base extent**。当前 createTexture 使用 source logical extent：没有 `texture-compression-unaligned` 时，非 4 倍数 BC base extent 不合法。逐 source mip 独立 round 也不等于合法 storage mip chain。
- `decodedPeakBytes` 目前按 logical mip texels ×4 算，包括 BC variant；这是 RGBA-equivalent，不是实际 WASM/browser decoded peak。`copyBytes=0`、service transfer counters 也不能证明无内部复制。
- TextureResidency 分配 32MiB variation owner、stage/promote 写 variation/version GPU 数据。符号闭包没有当前 production variation-query GPU consumer；NativeMaterialBindings 只要 slot/generation/revision/minMip。旧 route 的 variation 字段仍被 CPU pack，但不证明 shader 有 reader。
- GPUTextureManager 的 source cache 没有独立 release/destroy API，GraphicsContext.destroy 未调用它；这是需审计的 owner 缺口，不能仅凭统计断言 driver 泄漏。切换后 material 不再创建 standalone source GPU texture；环境 owner 不顺带改写。

与旧文档/命名冲突：`desktop-bc` / `worker-transcoded` / `portable-rgba8` 是 package provenance/profile，不是完整 production 覆盖证明；`normal-linear → BC5` policy 不证明当前 signed XYZ consumer 正确；`hdr-linear` 候选为空，不代表 BC6H 已支持。

### 1.3 当前 KTX owner

本地 pin：KTX-Software v4.4.2，commit `4d6fc70eaf62ad0558e63e8d97eb9766118327a6`；vendor WASM 769,795B、JS 277,279B，WASM SHA256 `8336a23659f306c93f45816022dcdfae122f66eaf566488a2b7cf40e0bf65f0e`。2026-10-09 GitHub release 查询仍以 v4.4.2 为最新 stable；调查 upstream HEAD `4f2d7bc7e26d92b0f0e61a7381b92e48a4485a5d`，不自动升级。

当前 local header reader 读 80B、以 supercompression 0/1 猜 UASTC/ETC1S，拒绝 Zstd2，再让 libktx parse。它已超过 magic/byte-cap preflight，形成重复 semantic parser。upstream C texture 有 shape/levels；JS texture binding 有 colorModel/transferFunction/supercompressScheme/vkFormat，但**当前 read binding 没有完整暴露 numLevels/numLayers/numFaces/baseDepth**；createInfo 的同名字段不是 read texture getter。T4.1 在同一 upstream pin 上增加薄 read-only getter/error bridge 并重建，不能假装现有 JS 已可直接取得全部字段。

libktx constructor 将 JS 输入复制进 WASM，再创建 loaded texture；`getImage` 返回借用 heap view，本地逐 mip copy 在 delete/transfer 前必要。`finally delete()` 和 Worker transferable ownership 保留。当前 estimatedPeak=`max(8MiB,input×8)` 是调度估计；不是测量。默认最多 4 Worker、256MiB in-flight estimate、256 queued、3 failures，需要保留可取消/销毁行为，不把这些值认证为 4GB 预算最优。

薄 bridge 同时提供 upstream metadata-only parse（不带 `KTX_TEXTURE_CREATE_LOAD_IMAGE_DATA_BIT`）：先验证 dimensions/shape/levels/DFD 与预计 decoded/block bytes，再申请 cold-task credits 并加载数据。不能让很小 supercompressed input 绕过 host budget，先展开巨大纹理后才验证限额。Worker WASM maximum memory 与 task/output byte cap 有明确上限，超额明确失败并释放 credits；估计峰值与 actual linear-memory high-water 分开。不是另写 parser，也不增加本帧控制环。

## 2. 最终决策

| 对象                          | 决策                                                             | 原因与实施边界                                                                                                         |
| ----------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Primary PC profile            | **BC REQUIRED**                                                  | adapter + enabled device 均验证 `texture-compression-bc`，不支持则初始化失败；无 ASTC→ETC→RGBA production 回退         |
| Cooked path                   | **Final blocks → direct package → GPU**                          | 加载 cooked product 时 decode/transcode/codec Worker 启动均为 0                                                        |
| Raw PNG/GLB/WebCook           | **Cold cook ingestion 保留**                                     | 先 decode/cook 成同一种 BC Product，再 scene stage；压缩不在 render hot path，不建第二 Renderer                        |
| KTX-Software                  | **KEEP + ADAPT 4.4.2**                                           | 保留成熟 KTX parser/transcoder；薄 metadata/error getters，委托 DFD/shape/Zstd/container validation                    |
| Basis Universal               | **ADOPT offline/cold BC encoder；DEFER standalone runtime 替换** | 实读 direct DDS BC pack；复用 block encoder，不经 Basis universal 中间格式；未测得替换 libktx 的收益                   |
| ASTC / ETC2                   | **KEEP OPTIONAL，移出 primary**                                  | upstream/tooling 自然能力不删；production 不选、不打包、不启用对应 feature，不维护 primary test matrix                 |
| BC1 / BC3                     | **移出 primary**                                                 | 第一版不为更多组合维护选择矩阵；外部已编码输入在 cold import 标准化或明确拒绝                                          |
| TextureAssetPackageV2         | **KEEP family/container，REVISE texture metadata schema**        | RuntimeAsset container schema2 不改；texture assetSchemaVersion 2→3，旧 cooked asset recook，禁止 runtime adapter      |
| TextureResidency              | **局部 owner 重写物理分配**                                      | 沿既有 transaction/refcount/fence 产品责任；所有 material 段按 BC format/extent 分配，删除固定 5 RGBA + 4 package 分工 |
| Binding/material              | **KEEP native exact resource sets，ALIGN route slots**           | 不造 Material Binding OS；去掉全局 4 sets/16 segments 限制，完整 descriptor 先验证限额                                 |
| Progressive mip               | **KEEP 有限 clamp/promotion 与 revision**                        | cooked full chain 离线生成，逐 mip blocks 上传；coarse-first 不声称减少物理分配                                        |
| Cooked runtime mip generation | **DELETE material 调用**                                         | 无 BC render/storage mip encoder；环境 float mip owner 保留                                                            |
| Variation GPU                 | **DELETE 无消费者的部分**                                        | 保留 CPU publication revision/minMip、native exact Products/normal moments；删资源、dispatch 和对应表示测试            |
| HDR / BC6H                    | **DEFER**                                                        | 独立 Environment 需要 source HDR→prefilter→BC6H→sampling 全闭环；当前动态 float/storage 产品不改                       |
| RGBA fallback                 | **不属于 production profile**                                    | raw decoded CPU input 和 effect-owned float texture 合法；不能以 fallback 让缺 BC 的 material 入场                     |

### 2.1 格式与质量合同

| 实际 semantic / channels                 | 第一版格式                                                          | B/texel 大尺寸近似 | shader / quality                                                                                   |
| ---------------------------------------- | ------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------- |
| BaseColor、Emissive、SpecularColor RGB   | `bc7-rgba-unorm-srgb`                                               | 1                  | hardware sRGB→linear，一次转换；straight alpha，不 premultiply                                     |
| Normal / CoatNormal XYZ                  | `bc7-rgba-unorm`                                                    | 1                  | 保留 signed Z 和 mip 非单位长度；原 normal_scale、normal moments 不变                              |
| ORM RGB                                  | `bc7-rgba-unorm`                                                    | 1                  | 原 R/G/B 语义；拆 3×BC4 为 1.5B+3 samples，拒绝                                                    |
| 经 graph 证明只读单通道的 AO/coat/scalar | `bc4-r-unorm`                                                       | 0.5                | cooker 选 source R/G/A，native 静态 channel mapping 恢复该 role 的 vec4；同图多通道用途走 BC7      |
| 含 RGB 的非 coverage alpha               | BC7 保留 RGBA                                                       | 1                  | 不以 BC4 丢掉 RGB；透明路径本模块不新增                                                            |
| alpha-tested / shadow coverage           | BC7 RGB + **exact `r8unorm` alpha plane**；纯 mask 只需 exact plane | 2 / 1              | alpha 与 mip 数值和既有 cutoff 语义一致；main/VSM 使用同一 plane，不依赖 lossy BC alpha 的偶然结果 |

BC5 **DEFER 第一版 normal**：BC5 与 BC7 都为 16B/4×4，沒有额外 VRAM 节省；当前 graph 用 `RGB*2-1` 的 signed Z，XY 重建正半球 Z 会改变非单位 normal/mip variance。未来单独确立可证明的 normal encoding 后再用 BC5；本轮不提前更改 material 算法。Basis universal BC5 transcode 还可能从 R/Alpha 取通道，与 direct encoder 的 RG 不同，必须用语义验证，不按名称认定一致。

exact coverage plane 是有真实消费需求的有限语义产品，**不是设备/codec fallback**。BC4 和 BC7 alpha 有损，不保证阈值附近不翻转；禁止放宽 coverage assertion。alpha plane 以 canonical uncompressed mip reference 的 8-bit alpha 存储，线性/导数/LOD/地址模式保留。native lowering 分开 RGB 与 alpha 依赖，coverage graph 只绑定/读取 alpha plane；Surface 只在 alpha 输出需要时取 alpha。纯标量且无 exact coverage 要求才用 BC4。两个 plane 的成功 publication/retirement 同一事务，不允许 RGB/alpha 跨 revision。

需要 coverage 的 texture 在首次 publication 前上传 mip0 到 tail 的完整两套 plane，不能用 coarse-first 改变 alpha-tested winner；其他材质纹理保持现有 tail-first/minMip promotion。这样不引入两套 plane 独立 clamp 状态；同 image 同时供 opaque 与 alpha-tested material 使用时，该共享 product 按更严格 coverage readiness 入场。

不强行 channel-pack 使用不同 UV、sampler 或 mip recipe 的纹理。缺 map 的 constant/default 语义保留；缺 asset/capability/capacity 不得伪装成 default texture。质量不是 lossless BC 宣称：T4.0 冻结既有 numeric assertions 与有损质量预算、reference/camera/LOD；BC7 选择 upstream bc7e_scalar quality6，linear/perceptual weights 按 semantic 固定。先以最高质量施工；未来降低编码质量必须有独立授权与证据，不靠验收后改容差。

### 2.2 NPOT、mip 与颜色

基线不依赖新 optional `texture-compression-unaligned`。offline/cold cooker 对非 4 倍数 base extent 将**整个 UV domain 上采样**为 `storageW=ceil(sourceW/4)*4`、`storageH=ceil(sourceH/4)*4`；不 crop、不下采样，不贴 padding 后用 source/storage UVscale。source extent 独立保留，runtime `uvScaleBias=[1,1,0,0]`。既定 workload resolution cap 先明确作为同条件 recipe，不能为压缩再调小；超 device dimension/budget 则 admission 失败。

storage mip `w(l)=max(1,floor(storageW/2^l))`，h 同理，完整 levels=`floor(log2(max(storageW,storageH)))+1`；每级 upload footprint round 到 4×4，tail 1×1/2×2 仍一个 block。例如 source257→storage260，下一 mip logical130、physical132；不能给它旧 source mip128。GPUTexture 使用 storage base，BC 与 alpha plane 使用相同 storage chain；source/UV 与 mip byte footprint 分别验证。

Whole-domain 上采样会改变离散滤波结果，不能宣称与原 NPOT 逐 sample 位等价。T4.0 固定 raw/reference 与 canonical-storage 两组 NPOT sample/coverage 对照，T4.1 需证明边界/repeat/LOD 质量满足冻结预算；失败则修 cook/filter，不放宽预算或默默改成 crop。`texture-compression-unaligned` 只记录 capability，不在首版添加另一设备分支/asset variant。

source 色彩解释属于 cook key。RGB sRGB mip 在 linear 域滤波后重编码；alpha 始终 linear。Normal source mip 保留已定义 LinearNormal 与非单位数据语义，不借压缩重做 normal/roughness 模型；offline 与 reference filter 必须有 CPU/GPU oracle。标量/ORM 在线性域滤波。新 BC hardware sRGB 路径不沿用“解成 linear 然后量化 RGBA8 bank”的中间损失，不叠加 shader pow。压缩质量与此前 bank 二次过滤差异分别记录。

## 3. Producer / Product / Consumer

```text
Offline cooker (native; 同一 codec core 可编 WASM cold ingestion)
  source decode / semantic + mip recipe
  → upstream final BC encoder / exact alpha
  → immutable TextureAssetPackage family (texture schema3)

Raw KTX2 (cold only)
  libktx parser / DFD / loaded mip / transcode if necessary
  → same immutable Product; incompatible shape/channel/mip explicit error

Cooked load
  RuntimeAsset manifest/chunk checks + one compatible PC variant
  → TextureResidency plan / allocate / tight block upload
  → material-local routes + native publication
  → SurfaceV4 / main alpha / VSM alpha
```

KTX2 是交换/import 容器，**不成为 Renderer runtime abstraction**。final BC KTX2 由 libktx cold extraction 写内部 product；不实现第二 KTX2 GPU residency。内部继续用 RuntimeAsset manifest/chunks/checksums，已有 per-mip chunks 适合 coarse-first/range read；container2 无需换代。

Offline primary 不先 encode ETC1S/UASTC 再 transcode BC。Basis `dds_mode → process_source_images → build_dds` 已有 direct BC7/BC4/BC5 pack；窄适配提取 block vectors 到 EEngine chunk writer，不新写 DDS parser，不迁入完整 tool framework。相同 core 提供 browser Worker cold raw cook；复用 bounded WorkerPool/Service、取消和预算。worker binary lazy，不随 cooked load 初始化。浏览器 RGBA readback/CPU extraction 若 raw source 需要，属于 load/cook 成本，绝不能入 frame CPU。

Raw `KHR_texture_basisu` 接入 cold libktx；完整可兼容 2D mip chain 优先直接转 BC7/BC4。缺 mips/需 NPOT canonicalization/不匹配 scalar 通道时，upstream decode 后按同一 cook recipe 生成完整 product，或明确报告不支持的输入；不运行时生成 GPU compressed mip。新增支持不包括 raw HDR/cube/array；旧普通 GLB 功能不减少。

Worker 临时输出采用与 package-open **同一种 validated product view**：owned mip chunks + metadata，避免为了立刻上传先 serialize→parse；只有持久化时调用 writer。不是新的 GPU product/adapter，内存入口与磁盘入口共享 texture-schema validator。WASM borrowed views仍须一次 owned copy；shared archive subviews 持有原 bytes，不能 transfer 使别的 asset detach。hash/validation 在 load，不在 render，每个 immutable package 一次。

### 3.1 Texture asset metadata schema3

| 字段            | 合同                                                                                                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| identity        | sourceContentHash、sourceByteLength、sourceUri/provenance、cook recipe hash、codec revision/binary hash；assetId 内容寻址                      |
| extent          | sourceWidth/Height 与 storageWidth/Height；storage mapping 固定 whole-domain resample、UV identity；超限拒绝                                   |
| semantic        | color/normal/ORM/scalar role、source channel、transferFunction、straight alpha、coverageRequired；不同解释不能误 dedup                         |
| planes          | 一个 color/normal/ORM/scalar BC plane；需要 coverage 时一个 exact R8 plane；每 plane format/block layout/完整 mip chunks；不造任意 plane graph |
| channel mapping | 有限 RGBA selectors（source channel/0/1），native 编译为 static component/constant；不扩大每像素动态路由分支                                   |
| mip             | level、storage logical dims、physical block extent、chunkId/bytes/checksum；strict complete contiguous chain，验证精确 byteLength              |
| capability      | PC BC feature，texture dims/layers/usage limits；只有一个 primary final variant，provenance 不参与 hotpath negotiation                         |
| recipe          | 原 authored quality cap、canonical filter/edge mode、alpha policy、encoding settings；变更产生新 identity                                      |

新 texture metadata schema 必须 bump；原名 `TextureAssetPackageV2` 的 container 家族可保留，类型/constant 清楚声明 texture schema3，不能继续声称接受 metadata2。旧 assets 离线 recook，旧 primary variants/schema tests 迁移；不写隐式 runtime conversion。public Shader Material graph 本身不换架构，native constant routes 增加 static channel/plane glue。

### 3.2 Residency 与绑定容量

TextureResidency 仍唯一 material GPU owner；用现有 package array segment 作主物理表示。segment key=`format + storage extent + mipCount`，layer0 为该段 neutral/default，其他层为 live content。去掉固定 RGBA banks 和全局最多16段：段数按真实 capacity、GPU bytes budget、live/retiring accounting 有界，**不是无限增长**。

第一版物理策略：stage 批次预先统计 fresh layers；优先填已有 free layers，不扩大 live GPU texture；不足时创建新 immutable segment，容量为本批需求+1（受 maxTextureArrayLayers 与预算约束，超出拆段）。不预留大量 speculative layers；有消费者才分配，空段 fence 后回收。跨批次 fragmentation 纳入 acceptance，不先造 defrag/allocator OS。

logical descriptor slots 由 live/pending/retiring unique contents 决定并受显式 descriptor-byte budget，不能从 RGBA bank capacities 推导。payload 同 content/recipe 可以共享 GPU layer；sampler 独立。不同 semantic 导致不同 bytes/mapping 时 cook identity 必须分离；重复 image 不必因不同 sampler 复制 block payload，若 mip edge recipe 不同则不能共用。

BindingSet 只是 material-local immutable resource tuple，供现有 native bins 比较 exact resource identity；取消 global 4-set quota、每材质4个 package限制。物理 TextureRef 保留 u32 的 version4/bank4/routing2/layer22 形状，version bump3，bank改为 material-local slot0..15（最多16个实际 segments，包括 alpha plane）；layer>0、u32 invalid、external logical generation/context 保留。不往 ref 塞 universal swizzle：channel/plane 在 native compiled callback。

`GPU_TEXTURE_BANK_COUNT=9` 退出固定全域 bank 含义。最多16个 route slots 是 ABI 上限，**不等于 device 能绑定16个 material纹理**。逐完整 descriptor 算实际 sampled/sampler/storage/uniform/resources；现有 native Surface fused providers 占7 sampled（Visibility1+IBL3+VSM1+AO1+Sun1），packed native exact Products 再占1，coverage alpha plane另占1。10个独立 Standard maps+packed Products+alpha+全 providers 的保守需求是19。

初始化只协商所需 sampled上界：adapter>=19 时 request19，adapter16..18 时 request其可支持的这一下界区间，最低16，caller-owned device 同检查；不是复制全部 adapter limits。material/scene plan在创建纹理之前运行完整 descriptor admission，超过实际 limit 明确失败并保留旧 Scene，不能遗漏地图、压缩 Products、降画质或新增 renderpass逃限。既有 finite sun continuation 保留，但不能宣称解决所有 overflow；它仍需完整 preflight。T4.0 在目标1650上记录16/19可用性与完整目录最大实际 footprint，T4.2不得让原本可接纳的 authored catalog 因 format fragmentation失败。

CPU BindingSet 数随实际 immutable resource combinations，有显式 live/pending/retiring计数与现有 native bin/queue限额；不是16段全域上限，也不是16^N预枚举。large directory 的 unique segment数量不直接成为单个shader的资源数；dynamic material-instance identity不生成新shader。稳定 frames不重建bindings、不全扫 evidence。

## 4. Lifetime / publication

| 产品                                     | 创建 / writer                                   | reader                          | lifetime owner                                       |
| ---------------------------------------- | ----------------------------------------------- | ------------------------------- | ---------------------------------------------------- |
| source/cooked CPU bytes                  | loader/cooker 或 range source，immutable chunks | cook/Residency upload/recovery  | asset/scene CPU source；GPU loader不拥有长期资源     |
| codec task/WASM                          | Service/Worker upstream                         | cold ingestion                  | Service，取消/销毁/失败可重试；bounded bytes credits |
| GPU BC/alpha arrays                      | TextureResidency stage，queue.writeTexture      | native Surface / coverage       | GraphicsContext内Residency；最后引用与last-use fence |
| logical descriptor / generation / minMip | TextureResidency transaction                    | native bindings/publication     | Residency，generation耗尽明确拒绝不截断              |
| native binding/constants/version         | GpuNativeMaterialScene/Publication              | Surface/Visibility/VSM/Temporal | 既有 publication candidate/active/fenced retire      |
| environment float GPU                    | Authored/Physical Environment                   | Surface/IBL                     | 独立 environment owner，保持当前 fence               |

按 `GpuRenderWorld.stage → texture plan/upload → material/native candidate → command onFinished commit`，abort不改变active material/clamp。submit成功不等于GPU完成；移除最后引用/Scene replacement后等真实 `command.gpuDone` 才recycle/destroy层/段，object+generation+device epoch guard 防止晚fence删除replacement。共享Product由引用持有，borrowed source不因一次Scene release错误销毁。

`queue.writeTexture` 即刻入队，abort不能撤销。upload前必须完成preflight和reservation；fresh失败层以及promotion已写区间进入quarantine，等覆盖这些queue writes的completion token后才复用。成功可用已有统一submit的queue fence；abort没有submit时允许completion registration，不额外frame submit、不做GPU→CPU→GPU控制。active promotion失败只保留旧minimumMip；写入更细mip不代表提前可采样。一次new revision不能暴露半套RGB/alpha。

device loss：先撤销publication/停codec或失效task epoch，再销毁旧设备owners；晚Worker/fetch/map callback不得进入新stage。恢复从仍保留的CPU product/source重建新GraphicsContext/Residency，不把已detached Worker buffers当recovery source；失败Promise从cache移除、同identityretry可进行。readback仅delayed diagnostics，不参与本帧texture readiness。release与abort分别验证pending、live、retiring、decoded、Worker、banks/metadata归零（允许共享Scene和effect-owned资源，分owner记账）。

删除 variation GPU buffers/builds/old CPU packed variation fields之前重跑直接consumer搜索；保留 native Products/normal moments和publication语义。`AppearanceStaticResidency`共享helper若仍有活跃非纹理用途不机械删除。原旧temporal shader/helper若无人使用可删除，不能为删buffer恢复旧Temporal owner。

## 5. 开源 Source Map

以下为**实际源码阅读和拟采用**，不是本轮vendor/port已完成。T4.1必须补本地移植/构建diff、binary hash、NOTICE以及independent oracle后才升级adoption claim。

| Reference / pin / license                                                                                                                                                                                                                    | 实读 hot path                                                                                                                                                                                                                          | Local / Adopt / Adapt / Reject                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [KTX-Software v4.4.2](https://github.com/KhronosGroup/KTX-Software/tree/4d6fc70eaf62ad0558e63e8d97eb9766118327a6)，Apache-2.0及per-file第三方许可；额外调查HEAD `4f2d7bc7e26d92b0f0e61a7381b92e48a4485a5d`                                   | `interface/js_binding/ktx_wrapper.cpp` ctor/getImage/transcodeBasis/embind，release `lib/texture2.c::ktxTexture2_CreateFromMemory/inflateZstdInt`（HEAD移入`lib/src/`）、`basis_transcode.cpp::ktxTexture2_TranscodeBasis`、LICENSE.md | Local Ktx2BasisTranscoder/worker/vendor。KEEP parser+DFD/transcode、borrowed-memory deletion；Adapt read metadata和失败error bridge、关闭不需要GL/ETC software unpack；Reject重复JS semantic parser及broad renderer format negotiation                                        |
| [Basis Universal](https://github.com/BinomialLLC/basis_universal/tree/99f52d63aa6799cbdaecfe977111dc5ec3b31d47)，pin `99f52d63aa6799cbdaecfe977111dc5ec3b31d47`（不是v2_50 tag），Apache-2.0+NOTICE/per-file notices；latest stable查询v2_50 | `basisu_tool.cpp::dds_mode`、`encoder/basisu_dds_export.cpp::build_dds/pack`、`basisu_bc7e_scalar.*`；`transcoder/basisu_transcoder.h`、`webgl/transcoder/basis_wrappers.cpp` ktx2_file / transcodeImageWithFlags                      | Local thin offline/native+WASM cook integration。Adopt direct BC7高质量/BC4 encoder；Adapt per-mip block output，不写DDS后自己parse；Reject把BC5 RG与R/Alpha转码混同、额外Basis中间编码。standalone runtime替换DEFER：没有matched启动/吞吐/peak实测，wrapper也有输入/输出copy |
| [Twinklebear/webgpu-gltf](https://github.com/Twinklebear/webgpu-gltf/tree/bdfc2e562b30d303700aa533a11cec7b971d9c3f)，MIT                                                                                                                     | `src/glb_import.js` imageBitmap/createTexture/copyExternalImageToTexture，LICENSE.md                                                                                                                                                   | Local raw GLB路径对照。**该pin没有KTX/BC upload实现**，Reject将其当compressed donor或移植renderer；只参考raw upload与明确sRGB descriptor，原source也有semantic TODO                                                                                                           |
| [Three.js](https://github.com/mrdoob/three.js/tree/e9a8a1264c58150907230122ac17f5760a1ebab1)，MIT                                                                                                                                            | `examples/jsm/loaders/KTX2Loader.js` Worker init/transfer/transcode/dispose；`src/renderers/webgpu/utils/WebGPUTextureUtils.js::_copyCompressedBufferToTexture/writeTextureLayer`；LICENSE                                             | Local Worker生命周期和package uploader。Adopt lazy codec、finally清理、按block tight rows逐mip/layer writeTexture；Reject万能fallback priority与renderer架构                                                                                                                  |
| [WebGPU living spec](https://gpuweb.github.io/gpuweb/)，读取2026-10-09                                                                                                                                                                       | texture creation、texel copy layout、GPUQueue.writeTexture、`texture-compression-bc`与`texture-compression-unaligned`                                                                                                                  | normative contract，非codec donor。Original是EEngine PC profile、typed semantic产品、material-local residency/lifetime integration                                                                                                                                            |

KTX LICENSE 明确 `external/etcdec/etcdec.cxx` 是特殊 Ericsson non-open-source license，GL ETC软件解码可通过 `LIBKTX_FEATURE_ETC_UNPACK=NO` 不纳入新build；不能把整个vendor笼统称“全Apache”。保持已vendor完整licenses，新build保留实际依赖BOM/notices；Basis修改文件标变更并附NOTICE，BC7派生文件也保留来源版权。当前direct encoder LDR，`build_dds`不提供完整BC6H cook；transcoder列有BC6H不证明HDR owner闭环。

## 6. Cost Cards 与测量边界

定义 `B_f(W,H)=Σ_l ceil(w(l)/4)*ceil(h(l)/4)*blockBytes`；BC7/BC5 block16B、BC4 block8B；RGBA=`Σ4*w*h`，exact alpha=`Σw*h`。以下是**ESTIMATE：布局精确算术，不是driver VRAM实测**，包含完整mips/tail，不含segment空层、metadata、driver overhead。

| storage base | RGBA8 chain B | BC7 chain B | BC4 chain B | BC7 + exact R8 alpha B |
| ------------ | ------------- | ----------- | ----------- | ---------------------- |
| 1024²        | 5,592,404     | 1,398,128   | 699,064     | 2,796,229              |
| 2048²        | 22,369,620    | 5,592,432   | 2,796,216   | 11,184,837             |
| 4096²        | 89,478,484    | 22,369,648  | 11,184,824  | 44,739,269             |

### 6.1 三条路径

| 成本            | 当前 uncooked RGBA                                           | Basis Worker → BC                                                        | Cooked final BC direct                                                                  |
| --------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| storage/network | 原PNG/JPEG/WebP；bytes UNKNOWN                               | KTX2 source，bytes按input实记                                            | final BC package，通常比Basis大；按真实archive/chunks记                                 |
| CPU             | browser decode + mapper/publication                          | init/queue/libktx/transcode/必要heap copy；当前多一次serialize/hash/open | metadata/chunk验证+plan+publication；transcode=0，encoder/codec worker=0                |
| peak host       | decoded images+source/chunks，UNKNOWN                        | input+WASM loaded/transcoded+owned输出+当前repack；UNKNOWN actual peak   | retained package+views+bounded upload暂存；UNKNOWN peak，不能把RGBA-equivalent当decoded |
| GPU bytes       | standalone RGBA source+5bank capacity+增长retiring+variation | BC arrays实际allocated capacity，可能仍受旧segment碎片                   | BC/alpha层+neutral layers+retiring，按预算创建，无material standalone                   |
| upload/work     | external source copy+resize copy+两阶段mip GPU work          | BC blocks上传；无compressed runtime mip                                  | 同；tight queue rows，不人工256pad、不无条件slice                                       |
| frame shader    | 原RGBA samples                                               | BC hardware samples；当前normal语义未闭合                                | 同原sample数量/滤波；scalar静态mapping；coverage需要R8独立sample                        |
| diagnostics     | full evidence可扫描全部entries                               | service counters只包含task                                               | 按需snapshot；无新增全帧scan/readback/submit                                            |

GPU压缩本身增加硬件block decode（吞吐/cache效果UNKNOWN），不新增compute encoder、atomics/barriers/full-screen products。BC7理想resident/upload节省约75%，BC4约87.5%；exact alpha双plane约50%，不是统一“4x”。全chain本来无consumer的variation32MiB和bank resize/mip工作可删，收益归各owner，不算作codec吞吐。

0/50/100% cooked coverage：0%仍需完整cold decode/encode（load可能更慢，不能允许运行时RGBA逃逸）；50%只为raw半数付cold cook，duplicate semantic recipes各计一次；100%为正常生产，Worker/start/decode/transcode为0。cold encoder成本可能高，必须独立记first useful frame/fullquality时间。Direct与Basis传输比较break-even：节省的init+transcode+copy CPU是否大于 `(B_direct-B_basis)/实际IO吞吐`；不假定BC archive总更快，可在离线container层压缩storage但解压成本另记，不新增primary universal codec。

Residency ideal为exact live blocks；expected加neutral/free容量与metadata；worst replacement peak=`old live + new live + retiring + pending upload`。fragmentation=`allocated block capacity-live block bytes`，预检加入retiring后仍超预算就延迟/拒绝publication，不能破坏old scene。每像素sample/read成本使用实际native graph，包括C/X/Y与coverage；不将compression ratio当DRAM硬件counter。register/spill/bandwidth均UNKNOWN除非有counter。

### 6.2 已有实际 artifact，仅作历史输入

已读取 `.local/validation/2026-10-08T16-02-26-761Z-lighting-acceptance-e2d764bb-a318-4fac-a296-51e7d7d12ce6/result.json`：commit `f36b2feca13409179a957c2c82b3c9cb912bd1d8`，**dirty:true**，engineSourceSha `ee84ed30f0a750d2d4c73a530b66b31a0571d08ae63099d34c62958578b8d981`，hostBuildId `1a55a25b74acc5375d2317431e8221363eda3ebd08f703d1080e8f740304b4c9`，Chrome154.0.8037.98。workloadSha `1e806834c189df03355ea9801fea7d2411b6bcf3d7178835a3557e0cbc085a11`，quality为complete-authored-textures-512-native-v4。

**MEASURED historical software accounting**：518 unique texture routes，RGBA最大bank容量749,381,536B，materials+texture allocated793,030,832B，residentLogical346,537,572B，resident textures518；capability记录BC。该artifact无完整TextureResidency ledger，不足证明518都BC、source texture bytes或driver实际VRAM。不能把793MB直接除4，也不能当当前HEAD新baseline。source encoded bytes、actual decoded peak、Worker/load times均UNKNOWN，T4.0补同catalog ledger和fresh build身份；不因设计阶段缺hardware run伪造数字。

## 7. VT seam、验收与施工结论

保留 per-mip format/extent/chunk/range/hash/source recipe，这是未来whole texture→compressed page source的必要seam。KTX2 level index是整级，不是2D page index；当前mip chunk也不意味着具备VT gutters/borders/page addressing。未来离线从source/mips构建带border的BC pages，runtime始终compressed storage→physical cache；不把今天BC整级当可无损重新拼border的完整VT page产品。

本slice不创建feedback/page table/page scheduler/eviction学习系统。wholetexturebudget与fenced segments只是当前真实residency责任；后续VT重新按实际consumer设计。Environment BC6H、完整transparency、跨手机/WebGL/Safari均不扩展本轮范围。

验收需真实GPU证明format、sampling、sRGB一次解码、normal signedZ/length、ORM channels、exact main/VSM alpha、NPOT/repeat/tail/derivatives/LOD、progressive clamp、generation与replacement/abort/retry/loss/fence。source catalog全部覆盖、同quality不减少maps、compressed distribution和owner accounting可核对；historical测试通过不代替当前product消费。现有tiny texture component仅4×4 RGBA clamp，不足作BC闭包。

**最终 architecture 已选择，可从 T4.0 直接施工。** capability footprint/encoding质量/host bytes为有明确输入输出的小baseline probes，不能悄悄改架构；probe若显示必需合同在目标设备不可满足，保留失败并在该单元停下报告。设计准备完成不等于压缩性能/quality已通过；T4.2一次切换producer→Residency→所有native consumers并删除旧material路线，T4.3完成后STOP，不能自动开始VT。
