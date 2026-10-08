---
id: eengine-v4-texture-compression-execution-2026-10
state: current
verifies:
  files:
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - docs/next-design/eengine-v4-texture-compression-2026-10.md
    - OEngine/src/assets/TextureAssetPackage.ts
    - OEngine/src/assets/codec
    - OEngine/src/assets/web-cook
    - OEngine/src/loaders/gltf
    - OEngine/src/gpu/TextureResidency.ts
    - OEngine/src/gpu/NativeMaterialBindings.ts
    - OEngine/src/gpu/GpuNativeMaterialScene.ts
    - OEngine/src/gpu/GpuNativeMaterialPublication.ts
    - OEngine/src/gpu/GpuRenderWorld.ts
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/render/surface
    - OEngine/src/render/vsm
    - OEngine/src/render/temporal/NativeTemporalFactsPass.ts
    - OEngine/tests/unit/asset-codec-service.test.mjs
    - OEngine/tests/unit/runtime-asset-v2.test.mjs
    - OEngine/tests/contract/native-material-bindings.test.mjs
    - OEngine/tests/oracle/native-material-bindings-gpu.mjs
    - validation/cases/texture-residency-component
    - validation/cases/lighting-acceptance
    - validation/workloads/lighting-acceptance-v1.yaml
---

# PC Texture Compression 执行计划

本文件是 Texture Compression slice 的唯一单元状态/执行 authority；架构与Source Map见[Design](../next-design/eengine-v4-texture-compression-2026-10.md)。全局不变量、失败分类沿用[V4 execution](./eengine-v4-native-shading-execution-2026-10.md#validation-failure-contract)和[VALIDATION](../VALIDATION.md)。当前仅设计完成，**未开始 production 实现、未声明压缩验收通过**。

## 1. 单元与停止边界

| 单元                                        | 状态        | 责任闭包                                                                       | 结束边界                       |
| ------------------------------------------- | ----------- | ------------------------------------------------------------------------------ | ------------------------------ |
| T4.0 Current Texture Baseline & PC Contract | not-started | 当前source/quality/capability/成本与reference；有限 GPU encoder decision probe | baseline与采用裁决后STOP       |
| T4.1 PC BC Texture Product                  | not-started | upstream cook/import→schema3/mips/planes；条件化 GPU cold encode，非production | functional GPU oracle后STOP    |
| T4.2 Production BC Residency Cutover        | not-started | GLB/WebCook→Residency→Material→Surface/main/VSM/Temporal，原子切换并删除旧路线 | 单一production owner验证后STOP |
| T4.3 Texture Compression Acceptance         | not-started | 真实authored、quality、load/CPU/GPU、memory、lifecycle                         | 关闭slice后STOP，不自动开始VT  |

只接受明确授权的当前单元；不因设计已ready自动执行后续。若用户授权完整slice，仍以连续责任单元闭合后集中验证，不每helper跑heavy场景。

## 2. 开工与已有事实

第一轮源码审查 `579fd521b3e948ca2f3bb716aaec28f9d758cb0a`；Design V2 复核 HEAD/origin/master=`99ca968aced19cd8fbe99b2fec6320e16b8f79e0`。开始实施重新fetch/status/HEAD/remote，读workstream.authority和真实源码；不reset已有用户改动。用 `node tools/vibe.mjs context <path>` 定位owner和近目录AGENTS。

已有foundation保留：TextureAssetPackage/RuntimeAsset container2、encoded mips、实际BC package upload、bounded WorkerPool/Service、transaction/refcount/generation、native exact resource bindings、progressive publication与fenced retirement。当前authored默认RGBA、BC5正常法线消费不成立、schema2 NPOT upload和重复header parser有缺口；不是从零Codec系统。

生产目标冻结：2026 Chrome+ PC WebGPU BC-required、1650Ti4GB/1080p，唯一Renderer/统一frame submit。保留全部authored maps/quality、Geometry、Surface、Lighting/VSM/Temporal/FSR功能；不顺带优化别的模块、不建fallback matrix/Texture OS。

## 3. T4.0 — Current Texture Path Baseline & Production Contract

### Entry / 源码闭包

先读下列owner及全部直接consumer：

- TextureResidency、TextureRef/Handle/BindingSetPolicy、TextureVariation/Residency；ShadeImage/Texture/filter；GPUTextureManager/upload/mipmap。
- TextureAssetPackage、RuntimeAssetManifestV2/Residency、CodecPlanner/Service/Types/WorkerPool、Ktx2BasisCodec/Transcoder/workers/vendor、ReferenceTextureCodec。
- rawGLTF/WebCook image reader/catalog/mapper→GpuRenderWorld stage/release→NativeMaterialScene/Publication/Bindings→native shaders→Surface、mainCoverage、VSMCoverage、Temporal versions。
- Renderer初始化/恢复、Scene/Product replacement、Authored/Physical Environment。只记录没有完整production透明path的事实，不补透明Renderer。

### Tasks

1. 保存clean source SHA、build source SHA/buildId、Chrome/adapter/device features/limits、workload/source身份，保持当前Lighting/M2已关闭范围。
2. 复用现有texture component与authored runner/controller的observe入口，按需采一次ledger；加计时仅load/scene publication窗口，不在每帧遍历catalog。区分raw/direct/transcoded比例、source bytes、RGBA-equivalent与actual decoded bytes。
3. source identity：本地477,591,060B GLB，SHA256 `54b608872aec11ce07b26fad6c0ad14a662314e6480bf8d833e5088b59c9851f`，1,920 primitives、4,871,612 triangles、完整planned shards（历史66 Products，实际run核对）、518 routes历史目录。逐catalog image/semantic/route记账，source缺失则如实blocked，不换tiny scene。
4. 同条件authored recipe先采用现有 `complete-authored-textures-512-native-v4` 的512上限，**不再下调**。另外1K/2K/4K component完整mip验证高分辨率；512-authored性能不能宣称覆盖全部4K目录。保持1080p/renderScale1、camera、材质/灯光/纹理数量，不能去VSM/Temporal/FSR获益。
5. 只跑一次必要fresh authored baseline（如已有当前source/build完整匹配artifact可复用）；不要重测完整Lighting矩阵。保存result/events/screenshot/dispose/freshness/browser gates；旧dirty M3数据仅historical。
6. 冻结canonical CPU/GPU参考：sRGB/linear、LinearNormal mip signedZ/非unit、ORM/scalar channels、alpha cutoff/coverage、address/LOD/derivatives。既有numeric assertion不放宽；新增BC有损质量budget以source semantic和独立误差依据确定，在编码结果前记录。NPOT原始与whole-domain上采样reference并列。

### 小 decision probes（不是新的架构研究）

| probe                   | 输入 / 输出                                                                                                        | 判断标准                                                                                                                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BC/profile/capacity     | 目标adapter与enableddevice、当前完整目录最大native layout；合成Standard十maps+exactalpha+packedProduct+全providers | BC必须可用；16 minimum、保守19 sampled协商；每个完整descriptor合法。原已支持catalog不因新segmentfragmentation被拒绝。独立超限fixture显式admission failure，不丢map |
| Codec evidence validity | 两个既有KTX fixture+small Zstd/UASTC import、upstreamreadbinding getter inventory                                  | actualbinary支持与DFD匹配，记录unsupported。缺readshapegetter按Design薄适配，不继续扩展JS parser；非2D明确拒绝                                                     |
| Quality/reference       | 1K/2K/4K颜色/normal/ORM/scalar、odd NPOT257×129及边界/tail/alpha-cutoff pattern                                    | 固定reference/filter/qualitybudget、source signedZ/variance/alpha用途；不是以BC5节省猜改normal。exactcoverage plane明确需要                                        |
| Budget                  | 完整catalog ledger/segment forecast/old+new replacement、currentdecoded observations                               | 按bytes给最大resident/retiring/pending/host credits；不得靠减少目录或下调resolution达标。4GB总Renderer资源账纳入，无法装下则阻塞cutover，留未来VT解决              |

默认profile/格式/schema/upstream决定已在Design；probe只校验平台与合同，不能自行引入ASTC/RGBAfallback。数值未测保留UNKNOWN；现成softwareaccount不能冒称DRAM或driverpeak。

### GPU Encoder Viability Probe（T4.0 内的小裁决）

复用现有 component/oracle 和计时，不建 framework、不接 production、不额外重跑完整 authored。固定 Spark pin `b9ea643a08cb9eef3a9ddc64564089bdd6fd0daf`；外部评估依赖，JS adaptation 可独立试验，不 vendor proprietary shaders。当前学习研究用途可评估，记录 EULA/notice/attribution，不以未购商业许可阻塞；未来商业/引擎分发核对另列。

| 项目           | 输入 / 输出 / 合同                                                                                                                                                                                                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Input          | 同 GTX1650Ti/Chrome/device；1K/2K/4K BaseColor、BC7 XYZ normal、ORM、scalar，完整至1×1 mips；另257×129 NPOT、repeat/tail、coverage-cutoff patterns。所有路径用相同 decoded source/recipe/reference，raw PNG/JPEG/WebP/AVIF decode 能力分别记录，不假装 GLTF 已支持 AVIF                                                          |
| Compared paths | raw RGBA baseline、external Basis/libktx transcode、**raw Basis WASM encode**、Spark、cooked direct。raw encode 与 transcode 分开；现成 upstream harness/binary 可用于小 probe，缺项如实 UNKNOWN，不能无 matched raw WASM 对照就批准替换 browser cook                                                                            |
| Timing         | init/compile cold与warm分开；至少warm3/sample10×两个配对批次，记录P50/P95/max/N与timer/noise。decode、IO、queue、main CPU、GPU mip/encode/copy、wall、first-ready/full-mip-ready分开；readiness区分提交与完成。query不支持即UNKNOWN；stock getTimeElapsed 的额外 submit/wait 只作diagnostics，修正/核对有效 timestampWrites 接线 |
| Bytes/work     | source encoded/decoded current及peak、WASM high-water、retained recovery source；RGBA source upload、encoded useful/padded allocation/copy bytes、GPU temp/in-flight/cache峰值、persistent array容量；dispatch/pass/bind-group/submit数量。borrowedGPU source单列，不能计作0成本纹理                                             |
| Quality        | 先 canonical mips 逐级 encode，stock mip另测等价；不启用 normal auto/BC5、不丢signedZ/nonunitvariance、不替换exactR8coverage、不调qualitybudget。sRGB/linear/channel/normalScale/LOD/derivative/reference与main/VSM覆盖保持                                                                                                      |
| Ownership      | stock output hint/strict mismatch、array layer0实际行为、live layer>0与tail；拟 S2 caller encoder+origin/layer+strict identity 的最小 JS适配证明；备选 S3 buffer/layout交接。不得提交 standalone persistent texture、读回BC blocks、隐藏额外frame submit；无公共API支持之处明确写adaptation而非“已支持”                          |
| Lifecycle      | request-owned input/params/buffer不因取消/另一job/cache复用被覆盖；无await的encode区间、fence/abort/loss/lateepoch；raw bytes/replay recovery，无CPU final chunks时不声称GPU结果可持久化，不能靠readback→reupload伪造Product                                                                                                     |

裁决冻结为三选一：**ADOPT cold/runtime GPU encoder backend** 需全部质量/ownership通过，paired cold wall/CPU改善超过 timer与跨批次波动，GPU temp/总预算合规，正常帧争用检查无可信 P95回退；研究许可范围/notice清楚即可，商业授权单列。更快但 array/command/lifetime接入无法闭合则 **DEFER / OPTIONAL**；同质量无可重复收益则 **REJECT current slice**。信息不全记 DEFER，不以 Spark 新颖性采用，也不无限重测。stock demo 只能证明单组件，不能升级 production adoption claim。

输出一张成本/质量/shape/采用裁决表，注明 matched conditions、未测项与最小适配范围。主路线仍 Basis native/offline、browser默认WASM、external libktx、cooked direct；optional DEFER/REJECT 不阻塞 T4.0 主合同关闭。

### Exit

baseline ledger、same-condition recipe/quality/reference、format计划、capacity/budget、abort/recovery owner图完整；raw/direct/worker比例与missingfields明确；Spark有限probe有ADOPT/DEFER/REJECT结论（缺证据只能DEFER）。当前Node Material zero-coat/Texture decoded-peak若复现保存分类；decoded-peak assertion区分统计命名与真实budget缺陷，不预判无关而跳过。

只记录事实与必需小instrumentation；关闭T4.0后停止，不能在baseline中切production格式。

## 4. T4.1 — PC BC Texture Product（非production construction）

### Entry

T4.0合同冻结。重读Design §2格式、§3schema/capacity、§5pinned Source Map；非production harness直接构造新产品，不增production selector/bridge。

### Tasks / 连续责任模块

1. 从pin `99f52d63aa6799cbdaecfe977111dc5ec3b31d47`采用Basis direct BC7/BC4 encoder，native offline与WASM cold cook共用core。thin block-output bridge连接现有package writer，不自己编decoder/compressor/DDS parser；BC7 quality6、semantic weights固定，保存build recipe/hash/licenses/NOTICE及修改标记。
2. KEEP libktx4.4.2 parser/transcoder。thin C/embind read-only shape/levels/error getters与metadata-only parse，同pin重建read WASM，记录新binaryhash；禁不必要GL/ETC unpack。DFD/colorModel/transfer/supercompression由upstream判定；local只magic、input cap。先根据parsed extent/levels预计decoded/block bytes并获取credits，再加载/转码，固定WASM最大memory与task/output上限。支持已定义2D fullchain direct BC extraction/Basis transcode；Zstd依赖由upstream，失败不能改猜header。
3. 完成texture schema3：source/storage extent、typedsemantic/channelmap、BCplane/有限exactR8alpha、completeoffline mips、recipe identity、chunk/range/hash、capability和严格byte验证。RuntimeAsset container2不重写；旧texturemetadata2明确recook错误，无runtimeadapter。
4. in-memory owned chunks与diskopen采用同schema/product validator，Worker output无需serialize→reopen后才能上传；只有save调用writer。保持borrowedWASM→ownedchunk一次必要copy、deletefinally、输入transfer/sharedarchive/recoverysource规则。
5. 默认PNG/JPEG/WebP colddecode、KTXcoldimport→同CPU Product；缺mips/NPOT需上游decode+同recipe cook。**Cooked load** runtime mip为0；cold preparation允许已验证canonical mip/filter。whole-domainceil4上采样、storagechain逐级floor，BC tail与exactalpha一致，不用有损BC alpha替coverage。
6. 关闭coldtask责任：bounded memory credits/queue、取消当前worker、lateoutputepochguard、initfailure/failedpromise移除、retry、dispose。不开新streamingscheduler。完整cook结束可cache同identity，sampler不会无因复制payload，变semantic/recipe不能错误复用。
7. **只有 T4.0 ADOPT** 才加有限 raw GPU backend：按 Design §3.3 优先 S2、必要时 S3，JS glue负责 caller encoder/array layer/strict target、job独立参数/input/blocks、预算/epoch/fence；不改 proprietary encoder算法、不加registry。先在非production harness闭合同semantic/format/Residency destination，所有cook work在统一调用方submit中。GPU结果无CPUchunks时明确Transient Cold GPU Cooker，保留raw/replay source；不新建SparkProduct/Residency，不做compressedreadback缓存。GPU-only source无可重放recipe留后续dynamic模块。若ADOPT后接入/成本证伪，可记录失败降为DEFER，Basis主产品仍继续。

### Targeted 验证与功能 exit

- typecheck、shader compile、build与fresh `npm --prefix OEngine run build:test`；先少量codec/package/ownership tests，再集中必要真实GPU。
- 复用 `asset-codec-service.test.mjs`、`runtime-asset-v2.test.mjs`，增加新schema/坏chunk/fullmip/NPOT/channel/abort/loss意义断言；ReferenceTextureCodec仍test-only，不作生产quality证据。
- 1K/2K/4K BC7sRGB/linear normal/ORM、BC4scalar、exactR8coverage、tail/NPOT完整chain；同source多material、不同sampler、不同semantic、differentUV不得乱pack。
- CPU参考+真实GPU采样：sRGB只一次解码、signedZ/nonunitnormal、R/G/B/A映射、LOD/derivatives、repeat/clamp/mirror、main/VSM coverage等价。NPOT不报validationerror且原始/canonical质量预算通过。
- Worker/init/queue/encode/transcode/ownedcopy/peak分别测小代表case，记录MEASURED/ESTIMATE/UNKNOWN。没有matched证据不改Basis standalone runtime决策。
- 若Spark获准：真实GPU array layer>0/多layer邻层不污染、fulltail/NPOT、两job参数与source不覆盖、cancel/abort→retry、loss/replay/latefence；caller-owned submit、temp ledger归零、无BCreadback、无standalonepersistenttexture。同quality成本含canonicalmip逐级encode增加的passes；测试通过后才记录技术adoption，商业分发授权仍单列。
- source license/adaptation与真实shader消费证据齐备后才记录adoption；BC5/BC6H/ASTC/ETC2不扩primary范围。

新产品非production闭包全部通过后T4.1关闭并STOP；不切换部分active materials先试跑，不留第二runtime选择器。

## 5. T4.2 — Production BC Residency Cutover

### Entry

T4.1 complete；fresh product/quality/oracle已通过。一个architecture unit可以中间暂时不可运行，稳定提交只有同一production纹理path。

### 一次性 producer → 产品 → 全部 consumer

1. BCrequired能力在adapter/device与caller-owneddevice创建资源前验证；sampledlimits只请求所需16..19、完整shaderdescriptor预检。资产dimension/layer/bytes、material-local slots/epoch/generation容量一并检查。
2. GLTF raw/WebCook默认在scene stage前返回同BCProduct ShadeTexture，缓存目录走direct。若获准Spark，raw cache miss可先prepare同semantic/recipe，再由Residency预约/encode/copy/事务publish；临时job不是伪造CPUchunks或新asset类型，source/replayrecipe保留。KHRbasisu只走coldlibktx；固定cooked不启动Spark/Basis、不每load重新encode。已decodedbitmap在source upload安全后close，latecook取消不publish。
3. Residency所有material使用format/extent/mips arraysegments；按本批需求填free layers或新immutable段，budget覆盖neutral/live/pending/retiring。logical descriptor容量独立；remove全局4sets/16segments配额。物理TextureRefversion3，material-local0..15slots，exactnativebindings/bin资源比较保持。
4. native channel/plane sampling glue、Material publication、main alpha-tested Visibility、VSM alpha、Surface、Temporal版本一次对齐。alpha-only coverage不能读BC7alpha；coverage texture两plane完整chain准备好才首次publish，其他texture保留tail-first。promotion/texture change推进native revisions/VSM invalidation，Temporal不得依赖将删variationbuffer。
5. upload用tightqueuewriteTexture/ownedviews，删人工256rowpad与无条件slice；只保留encodercopy所需对齐。preflight在write前，queuewrites不可撤销，abort层/段quarantine到真实completion，再retry可复用。
6. 全部commit/abort/retry、replacement引用、release/gpuDone、oldgeneration/objectguard、device loss/new epoch闭合。sharedGPUlayer按content/recipe引用，resource tuples不每frame重建；graphics统计按需，descriptor/vRAM peak计入old+new。
7. 如采用Spark：在这同一个unit接通prepared cold work→Residency owned target→全部native consumers；移除stock hidden submit、hint自动新texture与共享params/input覆盖风险，temporary fence账完整。唯一长存owner仍TextureResidency，不允许“RGBA Residency + Spark GPUTexture owner + BC Product Residency”并存。

### 同单元 destructive purge

| 删除/退出生产                                                                           | 必须保留的语义                                                                              |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 5固定RGBA materialbanks、raw standalone source→resize→bankmip调用、只服务它们的settings | rawCPUdecode/coldcook入口、authored quality recipe、环境独立floattexture路径                |
| primary portable-rgba8 / ASTC/ETC2/BC1/BC3选择、worker provenance驱动format分支         | upstream自然toolingtarget表可独立保留，不加载/运行primary兼容矩阵                           |
| texturemetadata2路径、serialize→parse临时绕行、重复semantic KTX parser                  | container2、chunkchecksum、strict upstreamshape/DFD/errorvalidation、borrowedcopy           |
| global4 BindingSets/16package段上限、descriptor容量与rawbank绑定                        | perdescriptor限额、有限u32route、bin/queue完整capacity/显式失败                             |
| 无currentGPUconsumer的variationowner/buffers/build/version写、旧routevariationpayload   | CPUrevision/minMip/slot/generation、nativeexactProducts/normalmoments与Temporalchange语义   |
| 绑定退休表示的test/settings/helper                                                      | numeric、normal、coverage、LOD/HDR、publication、abort/retry/loss/fence assertions迁新owner |

delete前逐符号追真实consumer。GPUTextureManager/MipmapGenerator对environment仍有用途则保留；无引用materialsource不会继续创建它们。不要删除正常normalmoment产品，不顺手重写IBL/Lighting/Surface架构。

### Exit / concentrated checks

- architecture review确认只有一套Texture product语义/Residency/nativeconsumer；Basis/libktx/offline/Spark只作producer，GPU job不能变第二texture owner，无legacyadapter/fallbackselector。
- typecheck/build/freshbuild:test；texture/package/nativebinding/resource-stability targetedNode。fullNode一次按需要；真实失败保留，先分类，再最小修复，不救退休架构。
- 真实GPU串行：native-material-bindings oracle + texture-residency component增强BC/NPOT/exactalpha/progressive；nativeSurface/mainVisibility/VSM真实同接线。plain uploadhelper成功不算生产通过。
- lifecycle：Scene append/replacement、sharedtextures、failedinit、cancel/abort→retry、promotionabort、submitfailure、releasebefore/afterfence、latefencedreplacement、device loss/replay、lateWorker。owner账不能只数destroy调用。
- cooked Renderer无codecworker/Spark初始化、decode/encode/transcode/mipwork为0，无rawmaterialresizecopy；stablebindings不重建。可选coldGPUencoding不混入上述0成本宣称，无BCGPU→CPU→GPU/current-frame控制环或独立frame submit。
- capacity/fragmentation fixture：>16全域segments但各材质合法可运行；完整十maps超设备实际limits必须preallocation失败、不部分publication；目录的所有真实maps保留。

所有必需correctness/lifecycle成本检查完成才关闭T4.2；STOP在acceptance边界，不每patch重跑authored。

## 6. T4.3 — Texture Compression Acceptance

### Entry / 真实 workload

T4.2关闭；冻结freshsource/build/workload。复用现有validationrunner/controller与Lighting/authoredcase的cook/catalog/publication/recovery/resize/motion/dispose，不新建benchmarkframework。注册一个texturecompressionworkload可以，不能再做第二Renderer或改成小fixture。T4.0保存的原始baseline必须仍可比较。

完整477MB authored GLB、全部plannedshards/66Products、1920primitives、4.87Mtriangles、全texture/materialcatalog，1080p/renderScale1、相同camera/light/quality。GLBsourceSHA与bytes严格核对；1K/2K/4K矩阵另测完整mip，不替代authored。coldrawcook和warmcookeddirectload分别记录：同语义/质量合同，不要求不同encoder产生bit-identical BC。fixed生产验收仍以persisted finalBC direct为主；若采用Spark，单列rawGPUcook（无永久cache时）、source/recovery/temp峰值、争用P95与额外command数量，不能把其收益归directload。

### 必需 artifact 与指标

| 类别         | 要保存的结果                                                                                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 身份与runner | source/build SHA、dirty flag、Chrome/adapter/devicecapability、codecversions/hash、workloadhash、result/events/screenshot、freshness、dispose、browsererror gates                                   |
| Catalog      | textures/images/routes/semanticrecipes、repeatdedup、所有plannedshards/Products、exacttriangle/fullcatalogcoverage、实际compressed/uncompressed格式分布                                             |
| CPU/load     | sourceencodedbytes、actualdecodedcurrent/peak（不可得标UNKNOWN）、cook/read/decode/Workerinit/queue/encode/transcode/copy/publicationms，firstusefulframe/TTFMF、fullqualitytime                    |
| GPUmemory    | BC/R8liveblockbytes、arrayallocatedcapacity/neutral/freefragmentation、descriptorbytes、retiring/in-flight/pending、old+newreplacementpeak、effect-ownedmemory单列；driveractualVRAM不可得标UNKNOWN |
| Upload       | 每plane/mipblockbytes、actualwrite/copybytes、tailfirst与promotion；cookeddirect encode/transcode/mipwork=0，coldGPU preparation另计；rawCPUbytes不混成upload                                       |
| Frame        | normal renderer.render CPU P50/P95/max/N；GPUframe/Surface/Visibility/VSM P50/P95/max/N；shadertexture cost无法独立测时UNKNOWN，不把Lighting下降归压缩                                              |
| 稳定性       | resize/motion/recovery、alpha/clamp/LOD/normal/HDR质量、abort/retry/deviceepoch、lateIO/Worker/fence、完整teardownowner账                                                                           |

至少warmup30/sample120 stable frames，顺序串行GPU，normal与必要profiling分别标明；保持camera/samplecadence/reference相同。首次decode/cook时间不塞renderer.render。历史M3dirtyartifact仅辅助，freshT4.0才作前后对照。hardwareDRAM/registerspill/crossGPU/crossbrowser不具备条件则OPEN，不能凭BC理论bytes升级性能claim。

### Acceptance gates

- 有真实finalBCGPUformat且Surface/main/VSM正确消费，sRGB/linear/channel/normal/coverage/mips/NPOT固定qualitybudget全部通过；不调容差/删assertion。
- cooked direct runtime decode/encode/transcode为0，codecWorker/Spark不启动；rawcold汇入同Residency/语义合同，不再有RGBAmaterialGPUfallback或Spark独立persistentowner。若采用GPUcook，其temp、abort/loss/replay与无BCreadback必须有artifact，不以componentdemo代替。
- 保持全部纹理/material/routes/catalog/shards，distribution允许exactR8coverage与独立environmentfloat；不得把它们隐藏为“100%全部BC”。
- 实际totalallocated/retiring/hostbudget满足T4.0合同；reportedbytes可从ledger复算。没有owner残留、过期任务修改新epoch、晚fence释放replacement；共享/effectowner单独列合理存活引用。
- result/events/screenshot齐全，requiresDisposed/fullcatalog/exacttriangle/everyplannedshard均true；无unexpectedbrowser/page/GPUvalidation/failedrequest/source mismatch/timeout。
- 保存before/afterVRAM/upload/load/CPU/GPU数字与样本N；收益与loadtradeoff如实记录。若质量/必需容量失败不关闭；若仅性能不达预期，说明真实原因/范围，不自动发起VT/Lighting优化。

原失败先按production/lifecycle/runner/artifact/environment/GPUcorrectness/performance/unrelated分类，保留artifact。只修本单元根因；targeted→受影响oracle→最后完整authoredrerun。未运行/必需缺项保持未完成。Materialzero-coat等无关失败确认后单列OPEN；Texturedecoded-peak若是真实新增budget/ownership问题则本slice修复，不能以旧失败名豁免。

## 7. 关闭报告与后续边界

T4.3只有满足必需gates才closed，记录source/build/workload/codecidentity、finalcatalog/formatquality、lifetime归零、memory峰值、load/CPU/GPU对照、未运行项。更新本execution与currentSlice一次，不制造第二progress/status authority。

可以OPEN：BC5normal新semantic、BC6Hofflineenvironment、fulltransparency、hardwarecounter/crossdevice、真实VTpaging、DEFER/REJECT的Spark候选及未来商业分发许可。它们不是本slice已实现功能。若477MB源/目标BCdevice不可用如实not-run，不生成替代数据认证通过。

TextureCompression结束后STOP；后续VirtualTexture/PageResidency必须根据真实产品/成本重新授权和设计，不自动施工GI/Lighting/Temporal。

## 8. 设计交付记录（2026-10-09）

### 第一轮

设计交付轻量检查：`node tools/docs-verify.mjs` 当前问题0（66条history warnings不作已修复），`node --test tools/tests/document-system.test.mjs` 7/7，`vibe doctor` / `registry --check` / codec与Residency context导航检查，以及新Design/Execution和两份project YAML的scoped format检查、`git diff --check`。本轮不运行typecheck/build:test或Texture GPU component：没有production改动，避免以旧build或tiny RGBA fixture认证新架构。

本轮完成源码owner/consumer审计、四个upstream实际hotpath及license核对、格式/NPOT/exactcoverage/metadata/capacity/lifetime/CostCard选择；只改Design/Execution与必要navigation/currentfacts。未执行T4.0freshbaseline、codec移植、GPUoracle或authoredrerun，原因是用户明确本轮只设计。所有T4.\*仍not-started；设计可直接进入T4.0，不冒称compressionproduction完成。

### 第二轮 / Design V2

复核 `99ca968` 源码 ownership 与 Spark `b9ea643` 实际 encode/copy/submit、mip/normal、临时资源、API/tests、MIT/EULA。统一重组 fixed/external/raw 生命周期、S1/S2/S3、四路径 Cost Card、GPU-only结果的持久化与replay、VT乘法关系；T4.0增加有限决策probe，T4.1条件采用，T4.2 destructive cutover仍唯一Residency。学习研究许可不作评估阻塞，商业分发核对单列。只改现有Design/Execution，workstream保持planned、authority/VT后继导航不变。

轻量验证：docs-verify当前0 findings/66 history warnings；document-system 7/7；vibe doctor、registry --check、Residency context、两文档scoped format与diff whitespace检查通过。没有production改动，未跑typecheck/build/GPU probe/authored；所有Spark性能与真实接入仍待T4.0，未声称ADOPT或性能收益。**TEXTURE DESIGN V2 = READY FOR T4.0**，T4.\*仍not-started；提交设计后STOP。
