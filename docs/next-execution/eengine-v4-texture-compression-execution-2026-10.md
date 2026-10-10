---
id: eengine-v4-texture-compression-execution-2026-10
state: current
verifies:
  files:
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - docs/next-design/eengine-v4-texture-compression-2026-10.md
    - OEngine/src/assets/PcMaterialTextures.ts
    - OEngine/src/assets/TextureProduct.ts
    - OEngine/tools/texture-codec
    - OEngine/tools/build-pc-texture-codec.mjs
    - OEngine/src/assets/codec
    - OEngine/src/assets/web-cook
    - OEngine/src/loaders/gltf
    - OEngine/src/gpu/TextureResidency.ts
    - OEngine/src/gpu/TextureSurfacePublication.ts
    - OEngine/src/gpu/GpuShadingMaterialAbi.ts
    - OEngine/src/gpu/GpuMaterialStore.ts
    - OEngine/src/gpu/NativeMaterialBindings.ts
    - OEngine/src/gpu/GpuNativeMaterialScene.ts
    - OEngine/src/gpu/GpuNativeMaterialPublication.ts
    - OEngine/src/gpu/GpuRenderWorld.ts
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/render/surface
    - OEngine/src/gpu/GPUTextureContext.ts
    - OEngine/src/gpu/GPUTextureDescriptors.ts
    - OEngine/src/gpu/GpuBindGroupResourceCache.ts
    - OEngine/src/gpu/GpuFrameGeometryArenaAbi.ts
    - OEngine/src/gpu/GpuFrameGeometryAttributesAbi.ts
    - OEngine/src/render/passes/fsr3
    - OEngine/src/render/passes/AerialPerspectivePass.ts
    - OEngine/src/render/lighting/LocalLightWorkGenerator.ts
    - OEngine/src/render/temporal/GpuRadiometryPass.ts
    - OEngine/src/shaders/native_surface.ts
    - OEngine/src/shaders/surface_geometry_completion.ts
    - OEngine/src/shaders/frame_geometry_vertices.ts
    - OEngine/src/shaders/native_raster_partitions.ts
    - OEngine/src/shaders/native_visibility.ts
    - OEngine/src/shaders/surface_frame_geometry.ts
    - OEngine/tests/unit/cached-gpu-bindings.test.mjs
    - OEngine/tests/contract/fsr3-luma-pyramid.test.mjs
    - OEngine/tests/oracle/fsr3-luma-pyramid-gpu.mjs
    - OEngine/tests/oracle/fixtures/fsr3-luma-reference.mjs
    - OEngine/tests/oracle/native-raster-triangle-count-gpu.mjs
    - OEngine/src/render/vsm
    - OEngine/src/render/temporal/NativeTemporalFactsPass.ts
    - OEngine/tests/unit/asset-codec-service.test.mjs
    - OEngine/tests/unit/runtime-asset-v2.test.mjs
    - OEngine/tests/unit/pc-texture-product.test.mjs
    - OEngine/tests/oracle/pc-texture-product-gpu.mjs
    - OEngine/tests/oracle/pc-texture-import-gpu.mjs
    - OEngine/tests/contract/native-material-bindings.test.mjs
    - OEngine/tests/oracle/native-material-bindings-gpu.mjs
    - OEngine/tests/oracle/pc-texture-residency-gpu.mjs
    - OEngine/tests/oracle/texture-renderer-gpu.mjs
    - OEngine/tests/contract/texture-residency.test.mjs
    - OEngine/tests/oracle/texture-encoder-probe-gpu.mjs
    - OEngine/benchmarks/texture-compression-t4-0.json
    - OEngine/benchmarks/texture-compression-t4-1.json
    - OEngine/benchmarks/texture-compression-t4-2.json
    - OEngine/benchmarks/texture-compression-t4-3.json
    - tools/test-build.mjs
    - tools/gpu-oracle/registry.mjs
    - tools/gpu-oracle/server.mjs
    - validation/cases/texture-residency-component
    - validation/cases/lighting-acceptance
    - validation/workloads/lighting-acceptance-v1.yaml
    - validation/cases/texture-compression-acceptance
    - validation/workloads/texture-compression-acceptance-v1.yaml
    - validation/src/runner/run-case.mjs
    - validation/vite.config.ts
---

# PC Texture Compression 执行计划

## Bistro 性能修复授权与执行顺序（2026-10-10）

用户在实际源码/GPU 分析后明确授权按五项顺序实施；这是已完成基础链的成本修复，不自动开始 VT 或下一大模块。执行方式为当前会话自行实施，不使用子 agent。保持 full-rate native、全部 authored 材质语义、单帧 submit、真实 fence、abort/retry、device loss、容量溢出与近裁剪/梯度语义。

1. **Surface 生命周期**：`SurfaceV4` 分离尺寸/publication 所有的执行资源与轮换的帧绑定；`NativeExecutionBins` 复用帧设置。先增加轮换输出/曝光/geometry binding 的稳态分配与 abort/fence 回归，再修改 producer/consumer/lifetime。目标为稳定尺寸下不新建 Buffer，不将新绑定误认为新尺寸。
2. **绑定与命令复用**：资源 view 使用真实 texture 身份/descriptor；绑定组按真实 layout/resource/offset/size 匹配、有界保留；Visibility 保持 draw 顺序，将每 route 的稳定 group 1–3 提到 partition 循环外。回归必须覆盖轮换、descriptor 区别、资源 replacement、resize、teardown。
3. **三角形准备成本**：研究当前 frame geometry/winner 及固定 Forge/Wicked 来源，选取局部、可摊薄的复用方式；完整覆盖 retained geometry、source capacity miss、透视导数和退化。若候选的 ideal/worst Cost Card 或真实 GPU 成本不成立，不将实验强行接入 production。
4. **FSR3 归约**：参考已冻结 SDK 1.1.4 SPD，workgroup 内多级归约、跨 workgroup 保持真实 dispatch 边界；保留 source/reduction 顺序、NPOT、mip5 fp16、frame-info 与 effect-owned history。独立 CPU reference 和 GPU oracle 验证后切换全部消费者。
5. **Visibility/属性**：GPU producer 获取真实 triangle count，减少 padded vertex work；按消费者检查属性布局与 coverage 依赖。所有几何表示、main/VSM/Temporal 的直接消费者一起核对，不丢 work 换预算。

**成本约束**：步骤 1 删除每稳态帧 30 个 Surface Buffer 创建及约 6.47 MB 队列重建，shader ALU/samples/dispatch 不增加；步骤 2 删除已稳定输入的绑定创建及冗余状态切换，固定 descriptor 保留必须有界。步骤 3 的三角形系数若物化需 48 B/triangle，另计目录/producer/读写，不默认全场景物化；0/50/100% 重用都计固定税。步骤 4 删除中间 mip 写回/读回和 dispatch，以 tile workgroup memory/barrier 替代，跨 tile 不使用全局自旋。步骤 5 删除 bucket padding 对应的 vertex invocation，不新增 CPU 可见 work 控制。

五项代码修复已实施；第 3 项采用消除重复解析，否决全局系数物化候选。以下记录实际闭包、成本与验证，不将测试通过提升为 FPS 或来源 adoption 声明。

### 修复闭包与 Cost Card

| 项目 | 实际工作、成本与边界 |
| --- | --- |
| Surface 生命周期 | 按 extent/publication/输出 ownership 复用 allocation，轮换 borrowed 图像、曝光和 Lighting 输入只换 frame snapshot。稳定帧 Surface Buffer 创建30→0，不再重建约6.47MB bins存储；必要 uniforms仍写。queue writes与submit顺序一致，snapshot随实际fence释放，abort撤销candidate，resize/publication replacement才退休物理资源。GPU bytes/ALU/samples/dispatch不新增；0%复用承担原分配加检查，50%/100%删除一半/全部重建，同尺寸第二个轮换帧即可摊薄。 |
| 绑定与命令 | 每layout最多16组descriptor，每texture最多32个view，身份包括实际资源、layout、绑定编号、offset/size、mip/layer、usage/swizzle。淘汰只丢引用，不销毁borrowed资源；有destroy的owner清缓存，其余随owner回收。增加有界CPU比较/引用，无新增GPU产品/dispatch；0%命中仍创建且多比较，持续唯一tuple的worst不保证收益。稳定帧BG76→1，其中Surface48→0；Visibility每route绑定调用32→11，88次draw和顺序不变，未新增RenderBundle。 |
| 三角形准备 | 使用已解析的decoded key、raster work、instance进入geometry_complete_resolved，删除重复解析及目录/instance读取，无新产品/缓存/atomics/barrier/dispatch。保留homogeneous近裁剪、导数、顶点与source fallback数学，独立ALU/访存收益UNKNOWN。全局48B coefficient+16B plane候选对2.829M triangles至少约181MB，另需目录与producer；0/50/100%重用都先支付ALU/写入/容量，低覆盖微三角无法摊薄，缺乏break-even证据，因此REJECT。 |
| FSR3 Luma SPD | 8×8 workgroup、1024B tile、最多四级归约，每额外级两次barrier，无atomics/global spin。1920×1080/842 dispatch13→6，删除mip0/1/2/4/6/7/8 rgba32float产品及对应写回/读回，分别减少10,922,032B/8,522,320B logical bytes，不等同driver allocation。保留source/log与加法顺序、逐级NPOT clamp、farthest R16、mip5 RG16 store/load、frame-info/history。source/reduce pipeline2→8变体，增加cold PSO/LDS/barrier；partial/tiny tile仍填充64 lanes，零融合级worst不保证加速。收益取决于尺寸与可删mip/dispatch，重用率不是此机制的成本变量。 |
| Visibility/属性 | 主视图在V5/generation/valid vertex count匹配时读committed directory真实triangle count；32/64/96/128档最多31 padding，capacity miss/stale保持完整source128，VSM不读取主视图命名空间。0/50/100%有效directory减少0/部分/全部可省padding；满128档收益0且多目录检查。opaque删alpha求值，MASK保留exact coverage/显式梯度，梯度在branch/discard前。frame attributes96→88B/vertex（8.33%），仅删UV2固定零z/w，保留全部authored FP32；main/Surface/VSM/Temporal与arena容量/V5 ABI同步，无新增dispatch/atomics/barrier。同arena预算可准备更多顶点，总frame_vertices时间不保证下降。 |

研究参考为冻结Forge Apache-2.0 `cd5046893faba2dc7869243873bf01f02a6f0df9` 的VisibilityBufferShadingUtilities、Wicked MIT `df44c3db4c4927492bc9c791eac715d98d7ed091`，以及FidelityFX SDK1.1.4 MIT `c6efa6bf7f2027b3ec94f28578bb5965eabb9e55` 的 `sdk/include/FidelityFX/gpu/spd/ffx_spd.h`。本轮Local/Adapt保留既有EEngine homogeneous数学，SPD吸收workgroup内多级归约，跨workgroup用WebGPU dispatch，不移植全局计数器协议，不新增来源adoption claim。

### 实际验证与限制

engine typecheck、production build、新鲜build:test、Bistro typecheck/build通过；相关Node contract/unit46/46通过，覆盖tuple/range/subresource、abort/retry、pending fence、resize/retirement、device loss、arena容量与命令顺序。7个fresh production GPU oracle串行通过：fsr3-luma-pyramid、native-raster-triangle-count、native-surface-production、native-surface-product-production、geometry-shadow-view、local-light-integration、native-surface-multi-product-production（含recovery）。原数值容差未放宽。

Luma oracle实际执行FrameGraph，覆盖2×2、3×5、9×17、65×33、129×257、1920×1080；mip5前独立f32 CPU reference（2e-5），frame-info与每个R16 depth像素严格比较开工HEAD `57f1499a` 冻结的旧per-mip GPU reference。不冒称全链独立CPU fp16 oracle；保留初始3×5 NPOT失败和CPU half RNE与硬件转换不符的原失败。Triangle count GPU oracle覆盖1/32/33/64/65/96/128、双sided、capacity miss与stale directory，诊断计数0。

全量Node首轮577项中572 pass；4项失败在隔离开工HEAD编译源码上原样复现：Material closure zero-coat sample、OEGPACK A8 bootstrap roots、offline cook缺本地pngjs、Nyx projected-error GPU evidence缺项。未修无关owner或放宽断言。另大型pc-texture-product native BC矩阵长时间编码后中止，为NOT-COMPLETED，不宣称全量通过或deadlock。原失败/中止/基线日志在 `.local/bistro-repair-*.txt`，GPU结果在 `.local/bistro-repair-final-*.json`。

Bistro使用用户请求的实际约1.035GB原场景，132材质/405图像、完整cooked mips、2.829M source triangles。街景[20,5,-45]→[20,5,5]，1920×842/scale1，FSR3/jitter开、VSM/GTAO/Bloom关；HEAD隔离源码与修改后同demo串行观测。GPU full profiling与普通CPU分开，各120帧弃前8、N112，未同时运行两个场景。稳定创建确认：全帧Buffer30→0、BindGroup76→1，Surface Buffer30→0、BindGroup48→0。

| GPU ms，P50/P95（诊断观察） | 开工HEAD | 修改后首轮 |
| --- | --- | --- |
| command span | 41.36/168.17 | 37.52/39.08 |
| Surface native opaque | 14.95/47.75 | 14.86/15.91 |
| Visibility native material | 9.95/47.99 | 4.94/5.52 |
| frame_vertices_build | 3.71/12.01 | 3.55/4.31 |
| FSR3 Luma SPD | 0.282/1.071 | 0.192/0.201 |
| FSR3全部 | 8.14/49.26 | 9.16/9.77 |

两轮89–90°C，修改后约810MHz、基线750→630MHz，长尾大，不能计算可信净收益或推断RTX2060 FPS。分项只计pass scope，span含未分类工作，中位数不可机械相加。基线实际提交帧CPU P50/P95为4.64/5.905ms；修改后最终仅实际提交帧复核4.07/5.235ms，N112，仍为全帧0 Buffer/1 BindGroup、Surface两项0、GPU errors/device loss0；不提升为正式性能claim。

docs-verify 0 findings/66 historical warnings，37个源码/测试文件格式检查与diff whitespace通过。诊断场景已fenced release，临时尺寸覆盖撤销，基线服务退出，未改用户5173服务。当前仍未达到60FPS，Surface与FSR3其他阶段仍占主要时间；未降低材质/纹理/分辨率/effect质量。同频配对、正式1080p P50/P95、RTX2060、register/spill/bandwidth、driver VRAM、全Renderer画质仍OPEN/NOT-RUN。五项授权修复到此停止，不跨入VT/下一大模块。

本文件是Texture Compression slice的唯一单元状态/执行authority；架构与Source Map见[Design](../next-design/eengine-v4-texture-compression-2026-10.md)。全局不变量、失败分类沿用[V4 execution](./eengine-v4-native-shading-execution-2026-10.md#validation-failure-contract)和[VALIDATION](../VALIDATION.md)。**T4.0–T4.3与Texture Compression slice均closed**，最终authored/质量/成本/生命周期结果与OPEN限制见§12；不代表整帧性能已改善或整个Renderer验收结束。用户明确排除400多MB模型，后续场景测试均不再运行它；改变的是验收workload范围，不是缩小同一个场景后声称等价。STOP，不自动开始VT。

## 1. 单元与停止边界

| 单元                                        | 状态   | 责任闭包                                                                       | 结束边界                       |
| ------------------------------------------- | ------ | ------------------------------------------------------------------------------ | ------------------------------ |
| T4.0 Current Texture Baseline & PC Contract | closed | 当前source/quality/capability/成本与reference；有限 GPU encoder decision probe | baseline与采用裁决后STOP       |
| T4.1 PC BC Texture Product                  | closed | upstream cook/import→schema3/mips/planes；Spark DEFER，非production            | composite功能验证后STOP        |
| T4.2 Production BC Residency Cutover        | closed | GLB/WebCook→Residency→Material→Surface/main/VSM/Temporal，原子切换并删除旧路线 | 单一production owner验证后STOP |
| T4.3 Texture Compression Acceptance         | closed | 真实authored、quality、load/CPU/GPU、memory、lifecycle                         | 关闭slice后STOP，不自动开始VT  |

只接受明确授权的当前单元；不因设计已ready自动执行后续。若用户授权完整slice，仍以连续责任单元闭合后集中验证，不每helper跑heavy场景。

## 2. 开工与已有事实

第一轮源码审查 `579fd521b3e948ca2f3bb716aaec28f9d758cb0a`；Design V2 复核 HEAD/origin/master=`99ca968aced19cd8fbe99b2fec6320e16b8f79e0`。开始实施重新fetch/status/HEAD/remote，读workstream.authority和真实源码；不reset已有用户改动。用 `node tools/vibe.mjs context <path>` 定位owner和近目录AGENTS。

以下为设计开工时事实，不是当前生产状态（当前见Design §1和本文§11）：已有foundation保留：TextureAssetPackage/RuntimeAsset container2、encoded mips、实际BC package upload、bounded WorkerPool/Service、transaction/refcount/generation、native exact resource bindings、progressive publication与fenced retirement。当前authored默认RGBA、BC5正常法线消费不成立、schema2 NPOT upload和重复header parser有缺口；不是从零Codec系统。

生产目标冻结：2026 Chrome+ PC WebGPU BC-required、1650Ti4GB/1080p，唯一Renderer/统一frame submit。保留全部authored maps/quality、Geometry、Surface、Lighting/VSM/Temporal/FSR功能；不顺带优化别的模块、不建fallback matrix/Texture OS。

## 3. T4.0 — Current Texture Path Baseline & Production Contract

### Entry / 源码闭包（T4.0开工时名称，旧owner已于T4.2退休）

先读下列owner及全部直接consumer：

- TextureResidency、TextureRef/Handle/BindingSetPolicy、TextureVariation/Residency；ShadeImage/Texture/filter；GPUTextureManager/upload/mipmap。
- TextureAssetPackage、RuntimeAssetManifestV2/Residency、CodecPlanner/Service/Types/WorkerPool、Ktx2BasisCodec/Transcoder/workers/vendor、ReferenceTextureCodec。
- rawGLTF/WebCook image reader/catalog/mapper→GpuRenderWorld stage/release→NativeMaterialScene/Publication/Bindings→native shaders→Surface、mainCoverage、VSMCoverage、Temporal versions。
- Renderer初始化/恢复、Scene/Product replacement、Authored/Physical Environment。只记录没有完整production透明path的事实，不补透明Renderer。

### Tasks

1. 保存clean source SHA、build source SHA/buildId、Chrome/adapter/device features/limits、workload/source身份，保持当前Lighting/M2已关闭范围。
2. 复用现有texture component与authored runner/controller的observe入口，按需采一次ledger；加计时仅load/scene publication窗口，不在每帧遍历catalog。区分raw/direct/transcoded比例、source bytes、RGBA-equivalent与actual decoded bytes。
3. 用户授权的新source：`examples/assets/three/rendering-lab/dungeon_warkarma.glb`，7,990,584B，SHA256 `cac0fc8c16d107e7ac4e69efde89c2cb6ef4bc66c34456a4dd0923218e5aafb1`；798 primitives、72,137 triangles、25 materials/images/textures。T4.0仅加载其完整image/material目录走真实TextureResidency，不构造Renderer几何场景；不是66Product验收。477MB旧source明确excluded，禁止自动跑。
4. dungeon保留全部25张2048²图，原sampler/semantic，无512cap；另1K/2K/4K完整mip与257×129 NPOT矩阵。未来完整Renderer比较保持1080p/renderScale1、camera、灯光与所有功能；本阶段component timing不冒称renderer.render/frame结果。
5. 集中一次fresh texture baseline+可选encoder probe+既有native material oracle；只为真实runner/覆盖缺口修正重跑受影响入口，不重测Lighting。source/build/oracle身份、完整catalog/ledger、GPU错误、retirement结果保存机器artifact；full frame screenshot/first-useful-frame不在component中伪造，后续authored闭包必测。
6. canonical source recipe/CPU-GPU reference与质量比较规则冻结见§9.4；已有numeric断言不变。区分当前raw LinearNormal归一化producer与signed XYZ/nonunitconsumer，不宣称当前mip保留方差。Spark只做探索质量观测，未完成canonical逐mip对照不允许ADOPT。

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

T4.0合同冻结（§9）。Spark裁决DEFER，下面条件化任务7本轮不执行；不得在T4.1重开Spark研究。重读Design §2格式、§3schema/capacity、§5pinned Source Map；非production harness直接构造新产品，不增production selector/bridge。

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
- 复用 `asset-codec-service.test.mjs`、`runtime-asset-v2.test.mjs`，增加新schema/坏chunk/fullmip/NPOT/channel/abort/loss意义断言；当时ReferenceTextureCodec仅test-only，不作生产quality证据；T4.2已删除，其必要语义由schema3/真实上游与native oracle验证。
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

**禁止运行477MB模型。** 完整dungeon authored source、798 primitives、72,137 triangles、全部25 materials/images/textures、原2048²尺寸，1080p/renderScale1、相同camera/light/quality；sourceSHA/bytes严格核对。用正常raw/cooked scene入口跑全部geometry/material/texture，不把T4.0仅image/materialstage当完整scene。1K/2K/4K与coverage/normal矩阵另测；dungeon主要ORM/AO复用，不代替其它semantic覆盖。coldrawcook与warmcookeddirect保持同recipe，固定生产以persisted finalBC direct为主。T4.0尚无完整frame baseline，T4.2切换前用此小场景补一次原raw完整frame artifact，再与T4.3比较；不能用历史477MB数据混比。未来另选真实场景须用户授权，禁止悄悄恢复旧large case。

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

可以OPEN：BC5normal新semantic、BC6Hofflineenvironment、fulltransparency、hardwarecounter/crossdevice、真实VTpaging、DEFER的Spark与未来商业分发许可。477MB/66Product范围是用户主动excluded，始终不认证该规模通过，也不作为新dungeon范围的关闭门禁；目标BCdevice不可用或新范围必需项缺失仍未完成。

TextureCompression结束后STOP；后续VirtualTexture/PageResidency必须根据真实产品/成本重新授权和设计，不自动施工GI/Lighting/Temporal。

## 8. 设计交付记录（2026-10-09）

### 第一轮

设计交付轻量检查：`node tools/docs-verify.mjs` 当前问题0（66条history warnings不作已修复），`node --test tools/tests/document-system.test.mjs` 7/7，`vibe doctor` / `registry --check` / codec与Residency context导航检查，以及新Design/Execution和两份project YAML的scoped format检查、`git diff --check`。本轮不运行typecheck/build:test或Texture GPU component：没有production改动，避免以旧build或tiny RGBA fixture认证新架构。

本轮完成源码owner/consumer审计、四个upstream实际hotpath及license核对、格式/NPOT/exactcoverage/metadata/capacity/lifetime/CostCard选择；只改Design/Execution与必要navigation/currentfacts。未执行T4.0freshbaseline、codec移植、GPUoracle或authoredrerun，原因是用户明确本轮只设计。所有T4.\*仍not-started；设计可直接进入T4.0，不冒称compressionproduction完成。

### 第二轮 / Design V2

复核 `99ca968` 源码 ownership 与 Spark `b9ea643` 实际 encode/copy/submit、mip/normal、临时资源、API/tests、MIT/EULA。统一重组 fixed/external/raw 生命周期、S1/S2/S3、四路径 Cost Card、GPU-only结果的持久化与replay、VT乘法关系；T4.0增加有限决策probe，T4.1条件采用，T4.2 destructive cutover仍唯一Residency。学习研究许可不作评估阻塞，商业分发核对单列。只改现有Design/Execution，workstream保持planned、authority/VT后继导航不变。

轻量验证：docs-verify当前0 findings/66 history warnings；document-system 7/7；vibe doctor、registry --check、Residency context、两文档scoped format与diff whitespace检查通过。没有production改动，未跑typecheck/build/GPU probe/authored；所有Spark性能与真实接入仍待T4.0，未声称ADOPT或性能收益。**TEXTURE DESIGN V2 = READY FOR T4.0**，T4.\*仍not-started；提交设计后STOP。

## 9. T4.0 实施结果（2026-10-09）

### 9.1 身份、范围与可复现入口

开工fetch后HEAD/origin/master均为 `b39f23a0e21a57c469cf2396d646ac80571fc48e`，工作区clean。只新增oracle/测试构建资产拷贝与静态host raw shader支持；**OEngine/src无改动**。记录的dirty probe工具不冒称clean production revision。

机器artifact：[texture-compression-t4-0.json](../../OEngine/benchmarks/texture-compression-t4-0.json)。各record保存source/output/oracle SHA、Chrome、adapter/device、P50/P95/max/N、完整ledger、质量观测与初始失败；原JSON和Node输出另留`.local/t4-0/`。fresh build source hash=`b146a6b552f92ef6cd639cac01cac7228bf8e7d0ddd1f444a0fcbe32829a2f65`，output hash=`0ffc2747ff16df19cb9fa402597eb6c56a7a987603031ef714d87a3d9cb5af59`。Chrome154.0.8037.98，hardware NVIDIA/Turing，非软件adapter；Windows inventory唯一NVIDIA为GeForce GTX1650Ti，driver32.0.15.8142，与browser identity一致。browser本身隐藏精确device名；OS inventory一并保存，不凭architecture单字段猜型号。

```powershell
npm --prefix OEngine run build:test
node --test OEngine/tests/unit/asset-codec-service.test.mjs OEngine/tests/unit/runtime-asset-v2.test.mjs OEngine/tests/contract/native-material-bindings.test.mjs
node tools/gpu-oracle.mjs texture-baseline --json
node tools/gpu-oracle.mjs texture-encoder-probe --json
node tools/gpu-oracle.mjs native-material --json
```

Spark入口须外部checkout `Ludicon/spark.js` 到`.local/texture-design-spark`，固定 `b9ea643a08cb9eef3a9ddc64564089bdd6fd0daf`，全tree clean。oracle核对`src/spark.js` SHA256=`7d3cfe62db69ac317d8288ec6820fc896ab5a39731aa8f6802d34151e69dc469`；不提交上游shader。使用生产KTX Worker的编译JS/WASM（build:test现在复制已有vendor并纳入output hash）。GPU作业串行、结束关闭device/browser/server。

477MB模型**未运行且后续不再运行**。新dungeon是完整真实texture catalog，不是原large缩规模；T4.0仅image/material→Residency component，未跑Renderer geometry/frame，所以frame P50/P95、first useful frame、screenshot、effect总VRAM为NOT-RUN。它们在T4.2切换前补小场景基线、T4.3闭合；不伪称旧66Product验收或压缩生产完成。

### 9.2 当前真实路径与内存

| 项目                  | 当前MEASURED结果                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------- |
| dungeon source        | 7,990,584B；798 primitives / 72,137 triangles；完整25 images/textures/materials                 |
| Source images         | 2,379,388B WebP；25张2048²，全部保留原尺寸，无texture cap                                       |
| Decode representation | 419,430,400B base RGBA-equivalent；browser actual/native peak UNKNOWN                           |
| Production path比例   | raw RGBA 25/25；direct BC package 0/25；Worker 0/25                                             |
| Source GPU mip chains | 559,240,500B；standalone source cache，未计入Residency账                                        |
| Residency             | 559,240,500B live texels；allocated771,752,376B（array容量/neutral/variation/descriptor）       |
| 合计可复算分配        | 1,330,992,876B=standalone+Residency；非driver VRAM，effects/driver暂存另计UNKNOWN               |
| 工作                  | 25 resize dispatch；bank mip batch计数1；32MiB variation仍分配，9 builds/16 rejected            |
| Lifecycle             | release+真实fence后resident/retiring均0；Graphics统计destroy后0，但25 standalone源texture仍存活 |

sourceOwner存活不是driver泄漏counter证明，也不能被软件统计归零掩盖。probe显式destroy source contexts/MipmapGenerator并close bitmaps只为测试清理，**没有修生产owner**；T4.2必须退休material source route并闭合相关lifetime。

Raw read35ms级，load/decode286.90ms，stage203.60ms，同步finish/submit1.10ms，finish至completion314.50ms，按需evidence7.50ms；均单次cold component observation，不能写P50。stable bindings N20为0/0.1ms（浏览器clock量化，0不代表零成本）。load与queue completion重叠，不将阶段和当critical path；raw evidence的upload/copy=0是统计缺口，不能说未上传。

KTX真实Worker：UASTC32² input1296B→BC7 1024B，首次Worker启动含cold86.9ms，warm P50/P95/max=0.20/0.40/0.50ms，N20；只有mip0，当前full-chain writer明确拒绝，不造missing mips。ETC1S64² input719B→BC7 sRGB fullchain5488B，同一已初始化Worker首次2.0ms（**不是独立cold init**），warm0.30/0.50/0.60ms，N20。serializer4.10ms、open2.40ms、stage1.90ms单次；不是一般package解析吞吐。

ETC package真实BC array2层分配10,976B（含neutral），tail mip6初始16B上传；abort promotion不推进minMip/revision，retry成功到mip0，cooked runtime mip=0。成功publication累计upload counter7728B大于5488B usefulblocks，源于当前人工row padding；aborted queue writes不进成功计数，不冒称该counter覆盖全部真实写。Service destroy后active/queued/in-flight credits均0。actual WASM峰值UNKNOWN，8MiB estimated credit不是测量。当前Zstd被local header reader拒绝，read shape/getter缺口留给已定义T4.1 upstream bridge。

### 9.3 Spark有限probe与裁决

14 cases：1K/2K/4K×BaseColor sRGB、BC7 XYZ Normal、ORM、BC4 scalar；另257×129→260×132 NPOT及2-layer target。明确fullchain到1×1；禁auto/BC5、ASTC/ETC。init/preload BC7/BC4=99.6ms单次；本enableddevice没有shader-f16，测的是上游f32变体。每case warm3/sample20，分两批10保留distribution；Spark后direct顺序测试，**探索比较而非paired adoption evidence**。timestampWrites由probe在compute/render pass正确接线，诊断resolve另1submit，不用stock getTimeElapsed。

| Case          | Spark CPU P50/P95 ms | Spark full-ready P50/P95 ms | Encode GPU P50/P95 ms | Mip GPU P50/P95 ms | Direct full-ready P50/P95 ms |
| ------------- | -------------------- | --------------------------- | --------------------- | ------------------ | ---------------------------- |
| 1K BaseColor  | 0.70/0.90            | 6.00/6.90                   | 0.209/0.210           | 0.209/0.211        | 0.80/1.80                    |
| 2K BaseColor  | 1.70/2.40            | 10.50/12.20                 | 0.570/0.576           | 0.454/0.472        | 2.50/6.60                    |
| 4K BaseColor  | 5.90/7.90            | 26.00/27.90                 | 1.942/2.256           | 1.323/1.497        | 10.80/12.00                  |
| 4K Normal XYZ | 6.20/8.70            | 27.60/32.00                 | 1.712/1.914           | 3.330/3.615        | 10.80/12.10                  |
| 4K ORM        | 5.70/7.80            | 23.60/26.30                 | 1.562/1.703           | 1.101/1.273        | 10.80/12.40                  |
| 4K scalar BC4 | 6.10/8.20            | 24.70/27.80                 | 0.482/0.492           | 2.978/2.994        | 5.70/8.50                    |

CPU含async API/command/source upload host提交，不含主动GPU wait；ready wall含completion，decode/init不在warm span。Spark目标texture由caller在span外预分配，direct comparator在span内allocate；这个差别与顺序测量一起明确保留，不能把表当matched生产break-even。timestamp只包含pass；block copy GPU独立时间、driver/native decode峰值、normal帧争用、Renderer CPU影响UNKNOWN。host timer观测为0.1ms步进，不能从0.xms宣称精细收益；GPU query与wrapper开销没有matched无instrumentation测量，结果保持component成本等级。

4K BaseColor PNG604,361B，decode99.6ms单次；source upload67,108,864B，RGBAchain89,478,484B+padded blockbuffer22,372,608B=temp descriptor upperbound111,851,092B，另output22,369,648B。encoded destination有13copies、25dispatch、2computepass、1stock submit；padded footprint不是硬件总线bytes。BC4输出11,184,824B；其GPU temp100,669,012B。direct comparator是相同预先owned blocks完整upload，含allocate/queue completion、不含package IO/parse/publication。

为了构造相同direct comparator，probe**诊断阶段**读回一次BC blocks；这不属于runtime producer、不计进direct warm timing，也不是计划中的GPU→CPU→GPU生产路径。采样每case mip0的4096像素：sRGB一次硬件decode后仅diagnostic re-encode比较源字节；方形BC7最大误差1–3/255，NPOT8/255；不从这些观察放宽任何gate。fullchain写入成功不证明canonical每mip质量、normalScale/variance/coverage/derivatives全部通过。

**裁决：DEFER / OPTIONAL。** stock能使用strict caller texture，也能收array texture，但所有copy origin隐含layer0（当前layer0是Residency neutral，不能拿来写live内容）；不能选layer>0，无公开block buffer或caller encoder，仍私有submit。S1长期standalone owner REJECT；S2至少需要JS caller encoder/layer/strict identity、request-owned输入/params/blocks及真实fence；S3备用，没有写适配代码。没有matched raw direct-BC WASM bridge、canonical逐mip等价与recovery接线，不能批准替换browser cook。学习研究许可不是本次DEFER理由。T4.1不执行Spark条件任务。

### 9.4 冻结的production合同、budget与owner

- Capability实测：adapter sampled limit48，baseline enabled device16；另只request19的device接受19-binding layout，20明确拒绝。此为能力/admission probe，不宣称未来完整十map native shader已闭合。enableddevice不启用unaligned：257×129 BC createTexture明确拒绝，whole-domain260×132存储方案保留，不能只算upload footprint就认为base extent合法。
- Profile/format/schema：BC REQUIRED；BaseColor/Emissive BC7 sRGB，normal/ORM BC7 linear，独立scalar BC4，exact coverage R8；BC5/BC6H DEFER，ASTC/ETC optional tooling。Runtime container2、texture metadata3，sole TextureResidency；固定cooked direct、external libktx、raw browser默认Basis WASM。
- Reference/quality：既有native binding budget **0.0001不变**，BC解码后的shader数值与独立读取同block参考比较；encode有损质量以pin Basis bc7e_scalar **quality6、同semantic weights/完整canonical mips**为参考，candidate不得比此独立encoder更差，记录color linear误差/normal angular+length/ORM通道误差。首次canonical reference必须在候选比较前生成保存hash，不能用Spark输出作自己的reference或从本表误差倒推容差。exact alpha每mip/阈值coverage不变；opaque lossy alpha不能替它。
- Normal recipe：当前raw GPU LinearNormal平均后normalize；保留此producer recipe。外部/预烘焙nonunit XYZ和signedZ仍保留consumer语义，不用XY正Z重建替换；NPOT整个domain上采样，storage chain floor至tail、uvScaleBias identity，与canonical CPU/GPU reference验证，不以stock resize结果认证等价。
- Budget：保持当前Texture **2,147,483,648B硬上限**，新owner计入neutral/live/free/pending/retiring、in-flight copy及material source临时纹理，不能只算live或重复排除旧owner。当前defaultWorker estimated in-flight256MiB、queue256保留；T4.1按parsed dimensions/fullmips获取credits，不能仅input×8估计。单task encoded input/output各上限128MiB、单Worker linear memory上限256MiB；source decode+所有owned buffers另记host峰值，不能把WASM maximum当实际消耗。无法满足明确admission failure，禁止降低尺寸/漏map。actual browser/driver peak保留UNKNOWN，不认证4GB全Renderer装入。
- dungeon BC forecast **ESTIMATE**：25张2K ORM/AO保持3channel BC7，同一图的AO复用；useful139,810,800B、一个26层段（25live+neutral）145,403,232B，old/new两完整BC段290,806,464B，未含descriptor/upload/effects。不是把当前array allocated直接除4；目录不是25 scalar BC4，不能丢ORM通道取节省。T4.2从真实new ledger验证forecast/全owner峰值，T4.3前后同catalog/quality比较。

| 生命周期            | 当前/目标 owner与必需边界                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Source/import       | GltfLoader/browser bitmap或可重读source；任务epoch、cancel/late output、bitmap close由cold preparation负责                          |
| Worker              | Service/Pool持有credits与Worker；cancel/init failure/retry/dispose已有unit coverage，实际WASM hard cap由T4.1 bridge补               |
| Immutable product   | CPU-ownedchunks或archive views；sampler与semantic/recipe identity区分，不serialize/reopen作为upload前置                             |
| GPU transaction     | TextureResidency reserve/write/commit/abort；queue writes已发生不能撤销，abort资源隔离到fence，promotion revision只在成功submit发布 |
| Replacement/release | GpuRenderWorld/Material publication引用，Residency generation/epoch+gpuDone retirement；旧fence不能释放新对象                       |
| Device loss         | 新device完整replay CPU product/raw source；旧Worker/fence不写新epoch；完整recovery acceptance仍T4.2/T4.3必需，不冒称本probe已测     |

### 9.5 验证、失败与停止

fresh build:test通过；codec/runtimeasset/nativebindings Node **18/19**：保留唯一`decodedPeakBytes`836≠340失败，根因是现有portable variant额外496B variation sidecar计入decoded字段，不是新增真实预算溢出。T4.1需拆清RGBA-equivalent/sidecar/actual peak的证据字段并迁移语义断言，不在baseline修改测试或把836硬改340。

三个GPU oracle通过、GPU scope/uncaptured error均空、无device loss/page exception/failed request。harness favicon403 console error单列，不当纹理请求失败。native-material真实bindings检查包含tail6→0、abort/retry/fence、coverage和packed Products，maxProductError1.192e-7，原1e-4 gate；不是新BC Product或全Renderer验收。runner初始label错误、单mip writer拒绝和Spark raw-module MIME错误保存artifact；只修oracle提交label/测试host原始WGSL模块接线，未吞异常。

测试构建/vendor身份检查及GPU JSON保真测试3/3通过；GPU host静态合同45/45。docs-verify **0 findings/66 historical warnings**，document-system7/7，vibe doctor/registry --check、scoped format与diff whitespace均通过；registry只格式化新条目，不改既有模块表示。不跑全Lighting/Geometry、477MB、production切换、VT或完整Renderer矩阵。剩余UNKNOWN有明确owner：host真实decode/WASM/driver峰值、完整frame/load readiness、canonical BC quality闭包、actual upload全账、source cache teardown、Spark接入/recovery。它们是后续产品/切换/acceptance项；T4.0以baseline事实、缺口和有限DEFER裁决关闭，**STOP在T4.1之前**。

## 10. T4.1 实施结果（2026-10-09）

### 10.1 产品、来源与生产边界

开工fetch后HEAD=`ceb40c2e75da7601ec35d6aa05162cc2b66cdf26`，origin/master=`b39f23a0e21a57c469cf2396d646ac80571fc48e`，工作区clean；没有reset本地领先提交。机器归档：[texture-compression-t4-1.json](../../OEngine/benchmarks/texture-compression-t4-1.json)，保存dirty source/build/oracle hash、原失败、受影响重跑和原始artifact checksum。不把parent SHA说成新代码clean build。

`TextureProduct.ts` 实现 container2 / metadata3、source/storage extent、semantic/channel、recipe/payload identity、full mip BC7/BC4和exact R8 plane；owned结果与diskopen使用同validator，schema2明确recook错误。立即上传使用owned chunks，只有save序列化；tight `writeTexture`写caller-owned array layer，不分配GPU对象、不submit、不发布material。逐plane/minMip写入可用于后续promotion，事务、fence与两plane原子publication仍由T4.2唯一Residency负责。

Basis pin=`99f52d63aa6799cbdaecfe977111dc5ec3b31d47`，BC7 scalar slowest/quality6，sRGB perceptual、linear uniform；BC4 high_quality。libktx4.4.2 pin=`4d6fc70eaf62ad0558e63e8d97eb9766118327a6`，同pin新read-only bridge负责metadata-only parse/DFD/shape/levels/load/transcode/image/error，Zstd由upstream依赖处理。兼容fullchain BC只extract、Basis只transcode；缺mips/NPOT/semantic转换才decode并coldcook。没有EEngine BC encoder/decoder或完整KTX parser；C++仅block gathering、resampler/normal glue与embind。新binary为Basis WASM97,020B、libktx520,112B；完整source/glue/binary hash与license/NOTICE在`vendor/pc-texture/source.json`及同目录。Zstd fixture来自另一个明确记录的upstream研究revision，不冒充codec pin。

复用既有WorkerPool：默认1Worker、256MiB estimated credits、queue256，task input/output各128MiB。Basis heap160MiB、KTX96MiB，**合计**硬上限256MiB；actual high-water为两个已初始化heap长度之和，不能取max。PNG/JPEG/WebP在Worker admission后decode，bitmap finally close；initfailure/cancel/lateepoch/retry/dispose闭合，WASM trap退休Worker实例。estimated credits不是host真实peak，browser-native decode/driver peak仍UNKNOWN。

NPOT全域ceil4存储、storage chain逐级floor到1×1、UV identity；provided/external完整mips按source domain校验，再逐级映射到storage，新增tail复用source末层，不normalize supplied signed/non-unit XYZ。raw normal保留normalize-after-linear-filter recipe。相同source在不同semantic/channel得到不同recipe/payload identity，sampler/UV不是block payload key；source URI不改变内容identity。

T4.0统计缺陷已修：旧load evidence schema2拆为`rgbaEquivalentBytes`、全部已加载unique variation chunks的`retainedSidecarBytes`、`actualDecodedPeakBytes:null`。340B/496B以及双variant340B/992B分别断言，不把sidecar改名成decodepeak，不伪造真实峰值。

**T4.1结束时production仍是旧schema2/旧KTX Worker/旧GLB与WebCook/TextureResidency/native material链。** 本轮只新增非production产品和独立consumer，不增runtime selector或第二GPU owner；T4.2原子切换并退休旧依赖尚未开始。Spark DEFER；BC5/BC6H/VT未实施。

### 10.2 验证与失败处理

GPU串行，Chrome154.0.8037.98、NVIDIA/Turing hardware adapter；测试使用BC REQUIRED，`float32-filterable`仅BC4独立采样参考，不加入production profile。既有native `1e-4`门限不变，exact coverage严格相等。

| 验证                  | 结果与证据边界                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Product GPU完整矩阵   | 1K/2K/4K×BaseColor sRGB/XYZ normal/ORM/BC4 G，full tails、array layer1、repeat/clamp/mirror、UV/normalScale/fractional LOD/gradients；另NPOT exact R8、provided signed/non-unit normal、PNG/JPEG/WebP Worker、assigned cancel/retry与credits归零。所有前置assertions已执行通过，最后recovery的第二次requestDevice因adapter consumed抛错；**原artifact仍failed、summary null**，不复写passed                        |
| Recovery受影响重跑    | helper改为每device fresh adapter；CPU Product save/open后旧/新device分别576 samples、864 exactcoverage checks，maxError0；controlled loss reason=destroyed，errors空。新增provided33×17 NPOT normal为288 samples/maxError0                                                                                                                                                                                         |
| KTX真实Worker import  | ETC1S full7mips5488B；UASTC missingmips recook full6/1392B；Zstd full11/1,398,128B。逐mip实际BC7 array layer1读取，maxError0；badimport→retry、active/queue/credits最终0，heap合计33,554,432B                                                                                                                                                                                                                      |
| 既有native-material   | 实际bindings/publication/progressive tail6→0、abort/retry/fence、coverage与packed Products通过；maxProductError1.192e-7，仍1e-4 gate。这不是新production cutover证明                                                                                                                                                                                                                                               |
| Native/WASM canonical | 原完整run的1K/2K/4K×4 semantics全mip hash equality均通过，NPOT mip0首次失败；保留原log。相同NPOT resample bytes证明不是filter差异；MinGW global sqrt/floor查找与Emscripten float overload不同，native-only `BcMath.h`导入std float overload，upstream/WASM/quality不变。受影响NPOT四semantic全mip hash重跑通过，保存reference先于candidate的hash；native与WASM共用upstream算法、独立编译/编码，不冒称独立codec实现 |
| Latest targeted Node  | codec/product/runtimeasset/nativebindings/test-build共28/28；最新provided NPOT/source-domain、sidecar、invalidresult/cancel/retry/dispose与native byte-domain检查包含在内。完整reference按dimension拆成可单独重跑的tests，逐case保存hash，防后续失败丢失prefix                                                                                                                                                     |

BC4初始参考失败保留：upstreamCPU decoder floor到u8与hardware RGTC精度不同，ideal float方程也不等价；删自写decoder reference，改test-only unfiltered `textureLoad`展开R32float，再独立采样验证native consumer。KTX sRGB初始参考失败同理：数学gamma与device转换精度不同，改upstreamRGBA8解码结果→hardware sRGB reference，未放宽gate。GPU error scopes/uncaptured errors与page/request failures均空；favicon403单列为harness非texture请求。

**闭合使用composite evidence**：保留完整GPU/native原失败及已完成prefix，只重跑对应recovery/native NPOT和最新代码受影响项；没有一份“完整矩阵最后全passed”的新artifact。原GPU summary在throw时丢失，case耗时/误差明细UNKNOWN；native旧prefix逐casehash也未落盘，其通过依据顺序assertion到达NPOT失败位置。不能从这个证据升级成完整Renderer或性能acceptance。昂贵不变部分未仅为runner最后一行重跑，未来runner已增强prefix保留。

### 10.3 成本、未运行与停止

完整GPU矩阵一次cold functional run约1,400,025ms；native/WASM完整reference原run约3,498,872ms。这是quality6 scalar cook/测试总wall，不是stable Renderer时间；独立CPU作业并行造成争用，不能当matched load P50/P95。当前4K冷WASM编码很慢的事实必须保留，固定资产应提前cook；T4.1不以此重开Spark adoption或降低quality。small KTX artifact记录prepare/transcode/recook、decode、queue/init、ownedcopy及heaphigh-water；单次cold数值不是分布或性能收益。

`typecheck/build`与fresh `build:test`通过；document-system7/7、docs-verify当前0findings/66historywarnings、vibe doctor/registry/context、scoped format与手写文件diff whitespace检查通过。upstream license/NOTICE原样复制的trailing spaces/EOF空行保留，不改授权文本来消除格式诊断。477MB模型未运行且后续禁止运行；authored Renderer scene/production source-cache teardown/真实预算/first-useful-frame/fullquality/frame P50/P95属于T4.2/T4.3，本轮NOT-RUN。跨GPU/browser、自然device loss和driver/host真实峰值未测，受控new-device replay不冒称这些已经完成。

**历史T4.1停止点：T4.1 = closed（非production functional closure）；当时T4.2 / T4.3 = not-started。STOP。** 不自动切换Residency、不启动VT或其它模块。

## 11. T4.2 实施结果（2026-10-09）

### 11.1 原子切换与当前 owner

开工fetch后HEAD=`2fdcab02114bd385f6830f96a9d76bd5ce3d2cbb`，origin/master=`b39f23a0e21a57c469cf2396d646ac80571fc48e`，初始工作区clean。机器归档：[texture-compression-t4-2.json](../../OEngine/benchmarks/texture-compression-t4-2.json)。最新dirty实现的source SHA256=`7c411d37f6d204431920badc589b55179e8d67923aef480dc0d5670d98b67112`，test build output SHA256=`782ab78f74952399973733217f8ca541d726a21d557592f5f2e872fd31e91ca2`；这些是源码/build内容身份，不把parent commit说成clean新实现。各oracle原始hash/设备/误差/错误与browser result/events/readback/screenshot校验和在归档中。

GLTF/WebCook保持encoded image来源，支持KHR_texture_basisu；缺MIME只做cheap magic识别，不扩写KTX parser。所有Renderer scene publication入口先完成bounded cold preparation，再进入唯一TextureResidency。PcMaterialTextures按reachable graph leaves、semantic/channel/exactAlpha去重并完整批次替换CPU材质，ORM/AO共享保留完整通道；custom graph更新同native binding，已close bitmap保留replay source。Renderer destruction/loss取消cold任务，GPU stage前检查device epoch。default Worker由literal new URL交给Vite打包，真实source browser验证已使用此入口。

Residency只接validated schema3 immutable Products，按format/storage extent/full mip chain的immutable array segments分配；neutral layer0、live层1..N，本批需求分配/复用free layer。logical handles4095，material-local slots0..15，global segments/tuples无旧4/16配额；完整lit descriptor与2GiB old+new/pending/retiring预算在allocation/write之前preflight。无独立material GPU source/resize/mip/variation或私有submit，cooked直接tight writeTexture，cold Basis/libktx/offline都是producer而非GPU owner。

TextureRef ABI3、ShadingMaterial ABI8、texture route64→32B；移除variation packed字段和旧[0,3] route validator。tuple identity为完整u32，classification/bin不再截成两bit。native channel/BC与exactR8 plane、GpuRenderWorld/MaterialStore/publication、main Visibility/VSM alpha/Surface/Temporal共同切换；coverage两plane首次fullchain，其他tail-first→promotion。revision/clamp只在commit发布，abort已queue-write的fresh layer隔离到真实completion，rejected fence不授予复用，generation/object guard保护晚fence与替换。

已删除metadata2 TextureAssetPackage、旧Planner/Service/codec Worker/header parser/重复libktx vendor、RGBA banks/settings/source resize、variation GPU owner/query/helper/tests和旧出口。CPU publication facts归TextureSurfacePublication，真实Appearance Products/normal moments与独立environment GPUTextureManager/MipmapGenerator保留。没有旧/新adapter、RGBA fallback、第二GPU ownership或本帧readback控制环。Spark、BC5、BC6H、VT均未实施。

### 11.2 必需检查与真实 GPU 闭包

GPU串行，Chrome154.0.8037.98 / NVIDIA Turing hardware adapter；最新ABI变更后重新集中跑下列受影响项，test source/build freshness gate均通过。native数值1e-4及coverage严格相等门限保持，完整Renderer HDR使用其既有独立reference gate，不能混成1e-4编码误差宣称。

| 检查                             | 实际结果 / 证据边界                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Node targeted                    | 最新62/62：Residency事务/共享/晚fence/underflow/queue部分失败账、ABI8完整u32 tuple65537、FrameProgram/native scene/packed world、resource stability、WorkerPool/RuntimeAsset/WebCook/glTF；另产品轻量positive 7/7此前通过。没有重跑不变的慢1K/2K/4K quality6完整矩阵                                                  |
| PC Residency GPU                 | 76 samples、maxError0；NPOT/BC4 channel2/exactR8、promotion abort/retry、raw default Worker1/cooked0；22 segments/21 tuples、十map实MaterialStore publication、18 sampled full native Surface shader在19 sampled/10 storage device成功；fencedBytes0                                                                  |
| Native material GPU              | standard/coated/unlit/custom/arithmetic、真实BC/R8 routes、梯度/LOD、packed Products/normal moments、stable/abort/retry/update/fence通过；正常Products maxError1.192e-7，独立native arithmetic maxError1.788e-7                                                                                                       |
| Native Surface integration       | 独立PBR、normal/ORM/coat/custom、main/VSM alpha逐像素depth maxError0、motion、Temporal/FSR、resize/abort/retry通过；不是独立全场景性能验收                                                                                                                                                                            |
| Product / Multi-Product Renderer | 两个实际production Renderer oracle通过，BC/R8 material、VSM8有效pages/22casters/overflow0、local light Scene swap、controlled device recovery/完整Scene release、stable graph cache hit16。cooked Worker0、material resize/mip/copy/privateSubmit0；恢复后卸载texture live/retiring/pending/quarantine/allocated全部0 |
| Browser component                | fresh-disk Chrome source/Vite Worker真实raw128²→BC Residency→native sample；tail[0.984375,0.01599,0,1]→promoted[0,1,0,1]，BC allocated43,744B→fenced0。result/events/readback/screenshot/dispose/error gates通过；runner标diagnostic-only，不冒称authored acceptance                                                  |
| External KTX Worker              | ETC1S/UASTC/Zstd真实bounded Worker、每mip BC7 layer1、maxError0、badimport→retry、active/queue/credits最终0通过。此import oracle也已在最新route ABI source/build上重跑；不是完整scene load验收                                                                                                                        |

保留17份原failed GPU/baseline报告及checksum，不复写passed。baseline先修test assets/Worker接线/未settled disposal、完整multiProduct bootstrap与原有Geometry512MiB配置；未改Geometry算法。native fixture迁完整source mip域；scalar fixture只请求合法channel；oracle submit label回归已有owner分类。integration最初漏promotion因传textures而非materials，修test调用后同PBR gate通过。容量fixture原device只启8 storage，实际Surface需10，改与production相同协商；最后MaterialStore release错传stage而非stage.handle修正。browser初始promotion constants未刷新、随后缺readback evidence均分类保留并受影响重跑。没有调容差、删必要assertion或把production错误列为无关豁免。

### 11.3 成本、文档与停止

切换前补全原始dungeon Renderer baseline：完整7,990,584B GLB/SHA256 `cac0fc8c16d107e7ac4e69efde89c2cb6ef4bc66c34456a4dd0923218e5aafb1`、798 primitives/instances、25 materials/images/textures原2048²、1080p/scale1、camera[10,7,12]→[0,3,0]、exposure1/autoExposure false。warm20/sample30 CPU P50/P95/max=2.3/3.4/4.0ms，upload wall约12,363ms；旧texture allocated771,752,376B/live559,240,500B、variation32MiB、resize25，旧upload ledger0仅缺统计。此数据在新实现前采集，有原build/source身份；不与477MB历史数据混比。

新Residency component测得4 Products初始6segments allocated3,174B/useful1,587B，接受的mip write共2,283B（含promotion/retry）→fenced allocated0；browser128² useful21,872B/allocated43,744B/upload21,904B。这是小组件实际账，**不能据此认证整个dungeon驻留、4GB全Renderer峰值或前后性能收益**。账按成功接受的逐mip写入累计，后续写失败不丢既有上传bytes；完整reserved chain、neutral/free/retiring计入allocated，RGBA-equivalent与actual peak分开。格式策略、quality6与完整authored源未降低。

engine typecheck/production build/fresh build:test、validation typecheck通过；Vite产出default pc-texture-worker约1.796MB。文档/导航/current事实与退休owner同步更新；最终docs-verify 0 findings/66 historical warnings、document-system7/7、build freshness/JSON3/3、GPU host contract45/45、vibe doctor/registry均通过；69个手写变更文件format与diff检查通过，生成registry按生成器内容校验，不为Prettier重写；三个新增/重写owner的style guard为0 findings。Shader代码/codec来源未因文档收尾再改。

**NOT-RUN / 下一单元必测：** dungeon after-cutover完整authored闭包、coldraw与persisted cookeddirect load/readiness/full-quality、同条件CPU/GPU P50/P95与全目录预算/fragmentation峰值属于T4.3；不能把§9 forecast当实测。真实browser decode/driver host/GPU峰值、crossGPU/browser、自然driver loss未测；当前只有软件ledger与controlled loss。477MB模型永久excluded，本轮及后续均不自动运行。没有production dist完整browser场景验收，不把source/Vite Worker组件通过说成所有打包入口已验收。

**T4.2结束时：T4.2 = closed；T4.3当时 = not-started；Texture Compression slice当时尚未验收关闭。** 这是T4.2历史边界，当前验收读§12。不得自动进入VT、Lighting或其它模块。

## 12. T4.3 实施与验收（2026-10-09）

### 12.1 当前源码与验收方法

开工 fetch 成功，HEAD `863a59bceb4fb78b25b443f3dd0ee22f83834f84`，origin/master `b39f23a0e21a57c469cf2396d646ac80571fc48e`，初始工作区 clean。本阶段只补必需接线和验收：WebCookedSceneOptions 开放 mapper 已有的 scene-scoped textureCache，raw/cooked 共用同一个 uploadWebCookedMultiProductScene、TextureResidency 和 Renderer。磁盘 schema3 包重新打开、hash/identity 检查后 seed cache；没有第二条 renderer/纹理 owner，没有 BC readback。

源码审查发现 T4.2 的 Residency promotion 和 native live clamp 已存在，但 Renderer 没有 promotion caller，非 coverage 纹理无法达到 full quality。修复为新 immutable RenderWorld runtime 的首个普通 frame transaction 调用既有 promote，成功 finish 才记入 WeakSet；abort 会保留 retry，replacement/recovery 新 runtime 自动失效，稳定帧不重复扫描。首次 coarse publication 仍合法，全 mip 为已烘焙 blocks，无 runtime mip generation、独立 submit 或新 scheduler。

独立 case `texture-compression-acceptance` 使用完整 dungeon；fitHeight=8、camera [10,7,12]→[0,3,0]、near=.05，与 §11.3 原始 oracle 源码保持一致。原 25 张 2048² ORM/AO 图、798 primitives、72,137 triangles、所有计划 shard 保留；1920×1080/scale1/exposure1，所有真实 Renderer 功能不变。normal/profiling 各 warmup30/sample120；同步 render CPU 与 harness queue completion wait 分离；HDR/winner readback 只在独立 inspection frame，不进入成本样本。

Vite 的固定目录 `.local/texture-compression-dungeon` 只保存验收输出，不是 production cache：bounded PUT、固定 filename、manifest 最后保存，包逐个 checksum 校验。每个 cold job 完成即保存唯一包，保存 IO 包含在 raw load wall 内并单列 `diagnosticArchiveWriteMs`；不能把这项诊断 IO 当作 production cook 必需成本。raw 首次完成后存真实 cold prefix/runId；受影响重跑可以重用包与原 prefix，但必须标注原始 source/build/run 身份，不能将 archived cold timing 说成新一轮 cold load。cooked package read/parse与Renderer initialize单列；`firstUsefulFrameMs/fullQualityMs`从geometry load开始，`endToEndFirstUsefulFrameMs/endToEndFullQualityMs`另包含此前包读取/解析和初始化。真实 GPU 作业串行；不运行 excluded 477MB 模型。

本节只说明方法；最终通过依据为§12.3–12.5的新鲜结果，不能由方法本身推断验收。

### 12.2 原失败与受影响重跑

原始 artifact 全部保留于 `.local/validation`，不得覆写为 passed：

- `2026-10-09T00-15-34-651Z-...-8a92787e-f130-4ed9-9263-9fa78b43d632`：cold完成后 `Incomplete texture catalog`。分类为validation assertion错误：GLB25张image有24个唯一SHA256，两张字节完全相同；独立读取原GLB bufferViews证实，不是漏图。改为仍强制25 authored引用、24唯一Product及24resident，未减目录或放宽容差。
- `2026-10-09T00-45-11-007Z-...-1994bd74-5490-4c46-b749-8ea58e4211d7`：raw/cooked、resize/motion/recovery/HDR全部完成，raw/cooked winner与HDR汇总完全一致；runner仍failed，24包和manifest的PUT共25条 `net::ERR_ABORTED`，另旧device主动destroy回调在共享intentional标志重置后误报。分类为宿主artifact IO/epoch观察错误。改PUT为200 JSON字节确认并消费完整响应；按GPUDevice WeakSet记录主动销毁，受控loss明确断言reason=destroyed，不放宽unexpected-error规则。
- `2026-10-09T01-13-47-870Z-...-24df8053-ea40-4a4d-bc9b-491f079cdfbf`：修复后全部runner gates passed。
- `2026-10-09T01-15-14-546Z-...-bd3cef68-026a-48ad-a095-1d145987122e`：补浏览器PUT receipt受影响验证、cooked cache miss/read/decode严格为0及raw/cooked HDR汇总精确相等；全部runner gates passed，errors空。重用第二轮真实cold包/prefix，明确非新cold测量。当时GPU独立矩阵仍待结束，最终结果读§12.3。

本轮误用root的旧TypeScript入口出现大量泛型typed array等错误；改用engine实际TypeScript5.9.3后validation typecheck通过。未修改无关源码以适配错误toolchain。

### 12.3 最终身份、质量与生命周期

机器汇总：[texture-compression-t4-3.json](../../OEngine/benchmarks/texture-compression-t4-3.json)。起始source commit为§12.1的HEAD；新实现的engine source SHA256=`422fe60fae9dd2da0f9695ad9b6a6c8be72414612742e1d042555a956390d9de`，fresh test output SHA256=`50c0f43e6ebf6e38e6edf533e89ccf04cd623d426afc37b303af45776ff44f6e`（完成于2026-10-09T00:15:13.535Z）。六个GPU oracle与最终authored runner使用同一engine source；汇总保存完整build、host、workload、codec recipe/binary与artifact hash身份。

最终run=`2026-10-09T01-41-40-786Z-texture-compression-acceptance-6dd67a0b-4d4f-4360-b715-45ee63b31ef6`，全部freshness/identity/browserErrors/pageOutcome/disposed/artifacts gates为true，errors空。raw prefix来自§12.2第二轮，冷数据复用有明确原run/source标记；最终cooked/load/frame/recovery是新测。完整目录保持798 primitives/instances、72,137 triangles、13 Products、25 material/texture/image引用、原2048²/full12mips；24个唯一内容都以`bc7-rgba-unorm`驻留。dungeon以ORM/AO为主，不能代替独立颜色/normal/alpha矩阵。

| 新鲜GPU验证                             | 实际结果与边界                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pc-texture-product                      | 完整1K/2K/4K×4 semantics及NPOT/exact coverage、provided signed/non-unit normal、PNG/JPEG/WebP，共17 cases；native sampling最大误差7.6294e-6，原1e-4门限不变。旧/新device各576 samples/864 exact coverage checks，maxError0；assigned cancel/retry、Worker/queue/credits清零。encoder有损误差/角度逐mip保存，不将sampling误差冒称压缩无损 |
| pc-texture-residency                    | 实际唯一Residency与native sampling76 samples/maxError0；NPOT、BC4 channel、exact R8、promotion abort/retry；22segments/21tuples/10maps/18sampled完整admission，fenced bytes0；cookedWorkerCount0                                                                                                                                         |
| native-material                         | 实际bindings/live tail6→0、abort/retry/update/fence、packed Products；maxProductError1.1921e-7。理想CPU filtering偏差仍单列，不偷换原hardware reference                                                                                                                                                                                  |
| native-surface-integration              | main/VSM exact alpha一致，VSM16,384比较像素maxDepthError0；normal/ORM、PBR、coat/custom graph、motion/Temporal/FSR与resize abort/retry通过。component不单独证明authored生产ownership                                                                                                                                                     |
| native-surface-multi-product-production | 实际Renderer多Product、alpha/Temporal、abort/retry、全source controlled recovery通过；不是恢复旧renderer                                                                                                                                                                                                                                 |
| pc-texture-import                       | ETC1S7mips/UASTC缺链recook6mips/Zstd11mips，经真实Worker逐mip BC array sampling，maxError0；failed import→retry与credits清零                                                                                                                                                                                                             |

authored raw/cooked winner count与Surface HDR汇总精确相等，没有调容差；native sampler constants实测full mip code7，而非只验证upload账。所有publication cooked cache misses/image reads/decode为0，cold texture tasks/encode/transcode/runtime mip均0。motion20帧、1280×720 resize→1080p恢复、受控device destroy→新epoch全部Products replay通过，无recook；old texture与old Geometry owner均0，最后真实fenced unload的allocated/live/pending/retiring/quarantine texture与Geometry allocations/metadata全0。截图已目视核对非空真实dungeon。自然driver故障、全局effect缓存清零不在此texture owner声明内。

### 12.4 成本结果（MEASURED，非driver VRAM）

normal与full profiling各warm30/sample120；queue completion等待单列，不进入同步render CPU。下面采用最终run，不挑最好的一轮；raw为已保存的真实第二轮prefix。

| ms，P50 / P95 / max        | Raw cold后的稳定帧    | 最终Cooked direct稳定帧                        |
| -------------------------- | --------------------- | ---------------------------------------------- |
| normal renderer.render CPU | 3.86 / 5.62 / 9.28    | 4.03 / 6.91 / 7.88                             |
| full profiling CPU         | 4.38 / 7.47 / 10.08   | 4.06 / 6.23 / 12.35                            |
| GPU command span           | 25.12 / 27.62 / 28.73 | 28.07 / 115.60 / 171.90                        |
| Surface GPU pass sum       | 9.08 / 10.74 / 12.31  | 9.95 / 52.59 / 65.66                           |
| Shadow GPU stage           | 见artifact            | 0.85 / 2.79 / 4.63                             |
| Local Light Work GPU       | 见artifact            | 0.0041 / 0.0082 / 0.0095；本场景0 local lights |

另外两个passed受影响run的GPU P50/P95分别45.81/52.16ms、42.13/103.65ms，CPU分别5.66/10.12ms、3.96/5.66ms；全部保存。GPU尾延迟与跨run漂移明显，原因未证明，不能归因为BC bandwidth或宣称加速。最终最大的已计时GPU范围是unclassified stage P50/P95=14.88/56.59ms与native Surface约9.97/52.62ms；shader texture samples的独立成本、driver preemption/clock/DRAM均UNKNOWN。旧基线CPU N30为2.3/3.4ms，当前观察值更高，不声明CPU改善；旧完整GPU未测，没有可用的GPU前后收益比较。

| Bytes / load                   | 实际结果                                                                                                                                                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| authored encoded images        | 25引用2,379,388B，24唯一内容2,270,654B；base RGBA-equivalent25×2048²×4=419,430,400B是布局ESTIMATE，不是decode peak                                                                                                                            |
| texture live / allocated peak  | 134,218,368B / 173,365,392B；旧live559,240,500B / allocated771,752,376B，allocated减少77.54%。当前7segments的neutral/slack39,147,024B全部计入，不隐藏fragmentation                                                                            |
| full upload                    | 134,251,776B=tail33,408B+promotion134,218,368B；tight writeTexture、0 private frame submit、0 runtime compressed mip。旧upload ledger0是缺统计，不能计算upload speedup                                                                        |
| graphics / resource / Geometry | Graphics snapshot465,788,068B；registered resource peak467,321,184B；Geometry独立预算页池536,870,912B+metadata67,108,864B。覆盖范围不同，不机械相加成driver峰值；Texture2GiB硬上限满足，无OOM/validation error，不认证driver4GB物理峰值       |
| cold raw                       | settled1,481.00s；first useful1,482.97s、full quality1,483.13s；含诊断包保存8.95s。25jobs encode sum1,458.09s、decode1.53s、Worker task1,463.94s、owned-copy279,620,900B、WASM high-water max41,025,536B；不可把各job high-water求和冒称peak  |
| cooked direct                  | package134,420,544B；read/hash/open/cache3,377.47ms，其中open parse1,624.82ms；Renderer initialize3,047.99ms。geometry/publication load起点到full quality20,127.20ms；含包读取与初始化的端到端first useful26,409.71ms/full quality26,552.76ms |

固定资产direct确实避免decode/encode/transcode/codec Worker，但final BC包远大于本场景JPEG等source，带来IO/storage成本。与旧upload wall12,363ms计时范围不完全一致，也没有proved load speedup。browser raw首次quality6 BC7 cook约24.7分钟是明确OPEN usability代价，推荐固定资产提前cook；本轮不重开Spark或降低quality。

### 12.5 关闭、检查与OPEN

engine typecheck/production build/fresh build:test及最终freshness核对通过；validation最终以engine TypeScript5.9.3通过。targeted Node30/30（跳过未变codec的完整native/WASM配对重编码矩阵），GPU host contract45/45；六个fresh GPU oracle与最终browser case均passed。最终docs-verify为0 findings/66历史warnings，文档/导航/构建身份工具测试8/8，vibe doctor与registry check均通过；scoped Prettier、diff whitespace及artifact/Execution source/build SHA一致性核对通过。不以旧文档代替新验证。

OPEN/NOT-RUN：真实browser decoder/driver host与VRAM峰值、hardware bandwidth/register/spill/crossGPU/crossbrowser、自然driver fault；production dist独立完整browser load未运行，当前是source/Vite生产Renderer。完整native/WASM配对矩阵曾因误选入口启动，未完成即停止，非断言失败，本轮不计其passed；算法/quality/binary未改，T4.1原参考保留，当前完整GPU矩阵新跑通过。用户excluded的477MB/66Product场景未运行、未认证。Spark DEFER、BC5 normal、BC6H环境、完整transparency、VT未实施。

实际性能OPEN为raw冷烘焙、direct包IO/校验、7segments neutral成本与GPU尾延迟；shader/driver归因尚不足，不把Geometry/Lighting/GI的优化算本slice完成。按§6，只有性能低于预期可公开记录而不自动发起新架构；质量、完整目录、容量、正确消费、恢复与teardown必需gates已通过。

**T4.3 = closed；Texture Compression slice = closed。STOP。** BC REQUIRED、唯一TextureResidency与同一Renderer保持；Virtual Texture/Page Residency仍是后续独立授权/设计模块，未启动。
