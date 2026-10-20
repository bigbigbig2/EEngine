---
id: eengine-extreme-web-asset-compression-execution-2026-10
state: current
verifies:
  files:
    - docs/next-design/eengine-extreme-web-asset-compression-2026-10.md
    - docs/porting/next-renderer.md
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - OEngine/src/assets
    - OEngine/src/material
    - OEngine/src/gpu
    - OEngine/src/shaders
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/src/framegraph/ShadeGPUCommandContext.ts
    - OEngine/tools
    - OEngine/tests
    - tools/gpu-oracle/registry.mjs
    - tools/test-build.mjs
    - examples/modules/hello-hdr-gltf/main.ts
    - examples/integrated/dungeon-warkarma-texture-compression/cooked-scene.ts
    - examples/integrated/bistro-texture-compression/cooked-scene.ts
---

# 极致 Web 资产压缩：移植与 Clean-Cut 执行文档

日期：2026-10-20。唯一目标依据：[设计](../next-design/eengine-extreme-web-asset-compression-2026-10.md)。源码 HEAD `5f3f41533e25901cbbd1da9c3ae751c64bc0a9c9`；工作区原有旧U0工具/规范等未提交改动保留，不归零或回退。

**用户已追加授权实施E1。** P准备已提交为`1f856ea0`，E0与E1结果见§12；当前停在E2边界，无生产ownership切换或示例recook。新文档删除并替换旧设计/执行，旧U0的“完成/冻结”不成为新计划的完成状态。

## 1. 执行纪律与目标

主线已确定为“全套常规LDR PBR图片传输→GPU编码”，不是竞争实验候选；以完整上游为可工作的基线，移植与架构适配优先。验证检查忠实度、集成、安全、语义和成本，不再用单RGBA内核或错误计时淘汰整条路线。

每个实现闭包包含producer→产品→准备→全部直接consumer→capacity/reset→提交/中止/重试/退休。先在非生产边界建立完整新闭包，再原子切换全部生产ownership并删除旧依赖；不按consumer渐进上线。可以保留纯离线reference，不允许新旧schema桥、旧owner fallback、两套资源管理/Worker调度或先上线RGBA再补BC。

按实际工程量划单元，不按文件数/天数估计。大单元内部连续施工，不每个helper跑全Renderer，不把每轮性能对比设为下一patch许可。GPU验证串行；单元末集中编译和少量独立检查，模块基本连通后集中组合接线/成本收口。停止点服从用户授权，不能自动越过当前模块。

## 2. 单元、依赖和当前状态

| 单元 | 工程量 | 完整交付与稳定边界 | 依赖 / 当前状态 |
| --- | --- | --- | --- |
| P：重建设计准备 | 中 | 新唯一设计/执行、来源映射与导航，删除旧主张，记录证据边界 | 本轮文档准备；实际结果见§12 |
| E0：上游依赖与移植基线准备 | 中 | 固定编码工具/许可、donor完整路径、产品/能力细节与构建身份；无生产切换 | 已实施；实际结果与许可交付边界见§12 |
| E1：忠实内核与新产品准备闭包 | 大 | 新图片产品、语义Cooker、浏览器decode/lease、GPU recorder、有限内存，覆盖RGB/RGBA/BC5/BC4和mip | 隔离闭包已实现并验证；本地evaluation来源边界及结果见§12 |
| E2：纹理全链原子切换 | **很大，主工作项** | 普通/VT、材质/coverage/query、统一准备/缓存、全部加载/部署/recook、删除旧产品与依赖 | E1后；待授权；本单元内部不分两次上线 |
| E3：离线极限码率与交付优化 | 大 | 双质量档的有限搜索、最终GPU评价缓存、完整资产报告、VT cell布局与预览/请求优化 | E2基础闭包后；待授权；仍只一个生产owner |
| E4：几何紧凑ABI与无损传输原子切换 | 很大，独立资产类别闭包 | F32-exact SoA、Zstd/raw、所有Cooker/reader/query/lifecycle与部署一次切换 | 公共准备合同在E2已定；待授权 |
| E5：模块集中集成与成本收口 | 中到大 | 新鲜构建、真实普通/VT/几何组合、生命周期/上界/质量和粗成本、删除余留 | E2/E3/E4后；待授权 |

E1是即将接入生产的新模块，不是永久第二套runtime；生产入口在E2一次替换。E2必须带最基本的正确边界和资源预算，不能把接缝/缺页/失控容量当E3优化延期。E3不为优化另建ABI或再选一轮基础codec。E4不混入纹理切换以免最大闭包失控，但几何本身不得按reader分批迁移。

## 3. E0：直接准备移植，不再做方向选型

### 3.1 开始时核对事实

```powershell
git status --short
node tools/vibe.mjs context OEngine/src/assets/TextureProduct.ts
node tools/vibe.mjs context OEngine/src/gpu/VirtualGeometryResidency.ts
```

读取当时源码/直接消费者和近目录AGENTS。固定donor按[来源账本](../porting/next-renderer.md#extreme-web-asset-compression-2026-10-20)，记录取回文件与hash，不依赖可变master。新准备不能误用旧U0的Basis初始化、Q100结果或八组geometry模型当新产品代码。

### 3.2 来源、许可与构建

1. 核Spark JS MIT、shader EULA、引擎/下游分发条件；明确当前可做的评估、开发与公开分发范围。未取得适用权利不向生产包复制shader，也不重新写一个近似内核假冒完成；这是具名依赖问题，不是技术否决。
2. gltf-tex声明MIT，锁具体文件/notice；libavif/libaom使用设计指定tag/commit构建，记录依赖许可证/PATENTS、tool版本/hash、flags和完整argv。`tune=iq/ssim`与Identity实际可用；不静默删flag或换Sharp后继续叫相同基线。
3. 对照完整donor路径：用途分类→图片解码→颜色/alpha处理→mip→BC7 RGB/RGBA/BC5/BC4→block copy→PBR normal消费；记录本地对应职责和选定完整profile，不要求支持未选中的全部平台/格式。
4. 工具准备好可直接复现上游配置；不是再次比较“要不要用Spark”。缺工具/许可时能继续的本地合同/宿主工作继续，不能捏造已完成内核。

### 3.3 合同细化与退出

细化新目录/receipt tagged union、target bank/normal reconstruction、图像尺寸/encoded/pixel cap、单任务最坏邻域、profile能力拒绝点、正常帧/scene初始化两种记录入口。明确ImageBitmap/VideoFrame到external copy的颜色/alpha合同、可选unaligned能力和无该能力的NPOT逐层过滤/容量合同。API/类命名由真实闭包决定，不预建generic codec registry或通用manager。

退出是：可追溯donor、可用工具身份、许可状态、完整阶段映射和可实施合同。不要求全Renderer成绩、不重跑旧所有oracle；没有新的路线淘汰裁决。

## 4. E1：忠实移植内核与新产品准备闭包

### 4.1 离线producer与产品

- 建新版本目录/reader/writer与manifest recipe，按设计§4区分canonical、encoded、prepared、GPU表示；有限静态AVIF item和精确段，合法decoded大小先于分配检查。
- 从canonical源直接生成AVIF，不先把旧BC解码再编码。复用donor原生avifenc路径；语义分类、通道消除/常量、Identity/linear与normal XY完整实现。
- 单位normal与非单位XYZ/moment分开声明；所有provided mip不被自动normalize。标量真实通道提取，alpha/coverage独立，颜色空间元数据固定。
- 普通runtime-mips/provided-mips与VT逐mip owner/cell/tail在同一产品合同内；先生成High/Extreme上游锚点，E3再深化有限码率搜索。
- 路径、toolhash、recipe变动使旧收据失效。manifest写临时产物后校验、再原子替换引用；失败不发布半份目录。

### 4.2 浏览器解码与信用

复用Spark `loadImageDecoder/loadImageFromBlob`的有效语义与浏览器差异处理，整合进入现有AssetWorkerPool/统一准备owner，不复制上游独立网络系统。优先ImageDecoder、适用时ImageBitmap；API能力差异是同一图片表示的宿主适配，不是codec/旧schema fallback。

IO/hash校验、pixel/尺寸/CICP/静态profile检查后解码，转移独占ImageBitmap/VideoFrame或受支持的同表示结果；transfer失败明确关闭并报错，不默默增加JS RGBA整图copy。超时/cancel后继续计入未完成工作，stale reply关闭/释放；模块、decoder内部估算、backing复制与ready分别计账。

浏览器API适配不得误改data通道：按设计§8单独控制decoder与external copy，normal/ORM/标量不执行隐式transfer/primaries变换。必要VideoFrame→ImageBitmap是同表示宿主适配而非旧路径fallback；先按实际backing保留双份信用，再交接/close。加入data ramp、透明边缘及Identity图片的解码后/上传后独立检查，不能仅凭`colorSpaceConversion:none`判断全链无转换。

### 4.3 GPU recorder与小闭包消费

直接引入有权使用的对应完整内核；上游shader如为minified生成资产，保留vendor源/hash，使用可追溯机械格式化/构建方式，不手工改写数学。EEngine手写WGSL/glue保持可读。所选f16/f32路径按donor支持方式及真实device协商，不让缺shader-f16静默改变精度合同。

新recorder在调用方command记录预处理/mip/编码/copy，不调用上游私有submit。外部图片copy、输入池复用、GPU fence与CPU对象close时机明确；BC7 RGB/RGBA/BC5/BC4均有真实采样消费，非零layer与origin/mip不能只测默认0。

独立检查只覆盖这次移植的关键点：

| 输入 | 输出与独立检查 |
| --- | --- |
| RGB、RGBA、normal XY、标量、ORM | 与相同donor路径同输入比较；目标格式/通道与真实GPU采样；不再全用RGBA内核 |
| sRGB梯度、透明边缘、normal mip | 上游过滤结果及最终材质语义；默认完整1×1链，NPOT/tiny无越界 |
| 特殊XYZ/moment provided mip | 非单位长度和各层保持语义，不触发XY重建或再次normalize |
| cancel、abort、迟到reply、OOM | 不发布部分输出，租约/credit回收，允许同session合法重试 |
| 复用输入/输出scratch | 两个不同图片并发、前command未submit时不覆盖、fence后正确复用 |

同device/同能力应在donor等价条件下比较；跨浏览器不要求BC物理字节恒等。额外oracle不能用同一被测shader生成expected；精确数据保持精确断言。只测一页不声称完整场景质量；也不因GPU等待微测很大否决上游。

### 4.4 退出

新模块隔离可构建、所有选定内核和图片结果表示完整、最小真实GPU producer→consumer与失败回收成立；尚无生产入口切换。完成一次architecture review后进入E2，不为每helper增加多轮benchmark。缺少任一选定语义不能称“完整Spark路线已移植”。

## 5. E2：纹理全链Clean-Cut，最大工作单元

### 5.1 同一闭包施工范围

| 架构面 | 当前定位文件/目录，可整体重写 | 必须闭合 |
| --- | --- | --- |
| canonical、AVIF、部署 | `assets/codec/PcTextureCook.ts`、`TiledTextureCook.ts`、tools/texture-codec、`cook-offline-scene.mjs` | 新语义/目录/完整mip或base-only、tail、source/cache identity、离线/合法Web输入 |
| 产品与公开来源 | `TextureProduct.ts`、`TiledTextureProduct.ts`、`TiledTextureSource.ts`、ShadeTexture及公开导出 | 新source/receipt/lifecycle；旧schema前置拒绝，无adapter |
| 统一准备层 | `codec/CookedAssetProtocol.ts`、`CookedAssetPreparation.ts`、Worker/pool/credit/cache | image/exact/geometry有限表示、transfer、去重请求/公平性、峰值/取消/重试 |
| GPU转码 | 新recorder、pipeline/input/scratch owner、真实command接口 | 所有格式、mip、复制、层/区域、能力/容量、abort/fence |
| 普通与VT Residency | `TextureResidency.ts`、`VirtualTextureResidency.ts`、texture refs/banks | mandatory/渐进、owner cell→页装配、mapping/victim、失效/退休 |
| 材质与全部消费者 | native material graph/codegen、Surface、coverage、VSM/shadow、query/SCGI实际采样点 | BC5重建和通道含义一致，alpha/UV依赖完整，绑定/重置/neutral层正确 |
| 帧和scene事务 | `FrameProgramLowering.ts`、`ShadeGPUCommandContext.ts`及真实scene publication owner | 正常提交顺序，不私有submit/等待GPU控制，不公开半初始化产品 |
| 入口与部署 | hello、现有Dungeon/Bistro cooked入口、manifest/fixtures | 同一批recook与引用切换；hello仍普通纹理，不强开VT/VSM |

### 5.2 普通纹理子闭包

实现完整基础图输入→GPU mip/压缩→最终array/layer→真实材质。preview和细层只在设计允许的依赖域发布；无preview则完整隐藏准备。大图按预算分片时使用正确provided mip/邻域，不独立生成错误边缘。可选unaligned能力前置协商；tiny/NPOT的block padding、逐层有效域、UV/address/显式导数与LOD贯通全部采样点，不拉伸源图。无unaligned能力时不能仅缩放UV：补齐后逐层尺寸不成比例、repeat/mirror跨缝与anisotropic/trilinear都要独立验证，实际额外采样/边缘存储列入成本。CPUready在upload接受后逐任务释放，GPU scratch按fence退还，scene未发布不阻止临时资源回收。

BC5是新target布局，所有format bank/array分组、readMask/normal重建、neutral texture、采样导数/LOD、动态材质引用与销毁必须一起改。透明度或通用表达式依赖normal原RGB时保留/重建原语义；不能只修改一个PBR normal helper。

### 5.3 VT子闭包

按设计唯一decoded owner建立空间索引、有限邻域依赖、Range与lease。支持128/256/512 owner布局，不把cell当驻留slot；128网格常见九依赖、NPOT极窄末格/repeat与混合布局按通用最多16依赖求实际集合，不误用四邻居上界。页请求需要的owner先整批容量准入，避免hold-and-wait；assembly保持wrap/clamp/mirror和NPOT数学，然后原内核压缩144²、复制真实非零slot/layer并原子更新mapping。

本单元必须解决：相邻页重叠块一致、cell相接边界质量、fine/tail连续、trilinear/anisotropic/运动、query-only需求、victim/retry/abort、冷尾层与最小合法容量。不允许将已发现的错误写成“E3优化项”。大cell过取/邻域开销是可见计数，不因它存在就恢复原BC网络路径；在已定图片路线内用有限cell布局修正。

### 5.4 必须删除/迁移的东西

- 旧schema3普通产品和schema2 tiled产品的生产parser、writer、收据、source桥与对应导出；旧资产必须recook，不自动升级。
- “磁盘payload等于GPU native-ready”“必须完整BC product才能构造普通纹理”等假设。
- 只为旧纹理路径服务的BC/Zstd decoder/vendor/build/初始化及native tile replay/cache；被几何、精确段或离线reference真实使用的内核只保留其明确owner，不误删共享依赖。
- 旧XUBC7竞争路线生产占位；旧U0工具可作为隔离历史reference，不进入production import。
- 为旧ABI存在的测试表示、无消费者的compat flags；其normal、coverage、数值与生命周期语义迁移到新owner，不恢复旧实现跑绿旧测试。

### 5.5 原子切换与退出

先完整构建新closure和独立直接检查，再在本单元一个稳定边界切换全部普通/VT消费者与manifest，删除旧依赖。相关TS/build/shader编译和少量关键产品/Worker/GPU/材质/生命周期检查通过。此时才可以说新路线接入production；完整组合与正式性能资格分别归E5/最终集成，不要求本阶段整Renderer先净提速。

## 6. E3：在忠实基线之上做极限压缩

### 6.1 离线搜索闭包

将High/Extreme、donor锚点、有限Q/effort候选与成熟评价工具接入Cook。先真实复现donor配置，再对相同canonical资产优化；输入/工具/全部argv/target/评价/设备能力身份参与缓存。使用最终GPU编码结果与材质，而不只测AVIF解码图。离线GPU作业串行，不进入runtime读回热路径。

每个产品保存可解释选择：原候选/选中候选字节、质量向量、硬语义结果、编码耗时；没有合格更小候选就保留同路线donor码流，不回XUBC7、不强降分辨率。非单调编码行为不使用未经证实的纯二分搜索假设。

常量通道消除、语义去重、去alpha、基础层传输优先在E1/E2具备正确最小实现，本单元强化搜索与交付，不第二次另造资源管理。相同采样依赖时的打包可作为具名有限候选，若新增分支/metadata/质量成本不能回收则不加入默认hot path；不是所有纹理强行NRM打包。

### 6.2 VT与请求优化

使用固定完整需求trace或明确无trace条件，选择有限owner cell布局；同时计算payload、目录/请求、fetched overfetch、decoded依赖与GPUassembly。稀疏区域选小cell，连续区域才利用大cell，不以完整pack大小代替实际流送收益。

Range合并有总字节/过取上限及同urgency约束；不能为吞吐延迟mandatory tail/coverage。decoded邻域LRU有界，无效需求取消/过期释放，不默认编码/驻留下载cell中所有页。preview起点和粗细切换要计入首屏/完成时间，不能把“画面出现”当“目标质量已达到”。

### 6.3 完整资产与退出

先完整hello15个纹理，随后使用当前允许的Dungeon/Bistro真实资产，不将512²裁片外推为整场景。对照当前生产旧资产、donor完整图片路线、本地忠实适配与本地优化后四种身份，离线reference不恢复生产双路径。

报告High/Extreme在相同尺寸/功能下的全部下载字节（含module/目录/preview/精确段）、编码成本和最终质量；VT另给相同trace实际fetched。目标为不丢donor能力且在选定维度有增量；没有增量如实保留基线，不降低断言宣称“更好”。这是一轮产品优化，不重新进行基础路线淘汰。

## 7. E4：几何布局与传输一起切换

### 7.1 新布局与producer

新major定义F32-exact位置SoA、已有oct/half属性、tangent/sign有限精确档、紧凑header与显式section范围、triangle U8及source remap。CPU/WGSL一处ABI事实源。保留所有合法顶点身份/corner/LOD语义，不为了压缩使用会改变角顺序却未同步remap的index codec。

Zstd9/15/19离线有限比较，输出独立单frame无字典段，不省字节选明确raw。页decoded≤256KiB，encoded不因压缩膨胀超过合同；格式/字节/窗口/frame终止和OOM严格检查。继续直接复用完整Zstd，不实现自制熵编解码器。

### 7.2 必须同切的面

| 面 | 完整范围 |
| --- | --- |
| 全部Cooker | asset-core GeometryCooker/Recipe/ABI/Writer；native、portable、pthread、WebGeometryCooker ABI；source/build/hash |
| 产品/准备 | OegPack/GeometryProduct/parser/admission、Worker/receipt/credit、内存provider/远程source/目录完整性 |
| GPU与reader | shared byte bank/directory、visibility/hierarchy、软硬raster、Surface、VSM/shadow、query/BLAS/ray/picking/SCGI、motion |
| 生命周期 | retain/evict、replacement/generation、bank growth/abort、地址发布、device loss、scene unload、部署recook |

全reader直接读新紧凑流，不将新产品展开为旧V3页，不另存精确query副本。payload沿原有效前缀direct write，publication沿encoder事务；保留growth双份峰与旧lease退休顺序。

### 7.3 检查与退出

相关C++/WASM/TS编译，独立layout/byte/finite/extreme读数、source-exact bit往返、所有直接reader真实最小消费、corner/remap/UV/barycentric、bounds/SSE/motion、growth/abort/retry及资源上界。删除旧V3生产schema/reader/ABI与失效fixtures；精度合同不变，不能改成对量化产品精确。完整场景组合归E5。

## 8. E5：集中集成、质量和成本

### 8.1 运行方式

```powershell
npm --prefix OEngine run typecheck
npm --prefix OEngine run build:test
npm --prefix OEngine run build
node tools/gpu-oracle.mjs --list
```

只列当前实际存在的命令。新增codec/native/WASM构建与GPU oracle在实施时接入真实入口再记录；不预填不存在的case/命令。受影响测试从产品/Worker/Residency/normal/coverage/geometry-query等实际直接文件挑选，不按宽泛文件名扫整类测试。GPU作业串行。

### 8.2 真实组合

- hello：全部15纹理新来源、普通非VT、VSM保持示例设置，HDR单列；不是只替换颜色或只展示preview。
- 当前允许的Dungeon/Bistro：VT fine/tail、普通plane、几何与Native/Surface/shadow/query组合；保持完整场景/材质/尺寸。
- cold/warm cache、持续移动/快速转向/teleport、稀疏页、evict/reload、Range错误/损坏、Worker替换、scene/source replacement/unload、device loss、增长双份峰与fence失败。
- 正式browser/画面/FPS证据由独立validation宿主承担，不把example计时当formal runner；本模块必要的真实接线、语义、生命周期与粗成本不能延期成“最终性能”。

### 8.3 质量验收，不以错指标否定路线

固定源/工具/资产/构建/浏览器/设备/能力/尺寸/相机/曝光/热状态；High、Extreme与donor对应档分开。图像评价经过实际GPU编码；normal用方向/高光，ORM逐通道/BRDF，coverage精确，provided moment保长度；包含跨cell/fine-tail/anisotropic/导数/LOD/运动。

历史XUBC7接缝失败不充当AVIF失败；RGB PSNR不作为所有材质唯一门限；同shader往返不替代独立expected。发现真实算法或产品缺口具名定位、修适配/配置/边界，不能删断言、调大容差或恢复旧owner；确需改变算法profile/质量范围时显式说明，不能冒称忠实移植。

### 8.4 性能与大小口径

| 维度 | 必记内容 |
| --- | --- |
| 网络 | 完整pack/外部图片、目录/module/preview/精确段；HTTP实际bytes、useful/fetched、过取、重复/缓存与请求数 |
| 启动 | 冷pipeline/decoder、解码、上传/编码、首个合法材质/首屏、达到目标质量；不只记录Promise返回 |
| GPU | timestamp分离mip/assembly/BC encode/copy，及正常帧竞争；submit-to-completion仅作另一个宿主指标 |
| CPU | 主线程/Worker准备、并发、encoded/decoded/ready/module与浏览器未知内部项；不把accounted cap叫RSS |
| GPU内存 | 最终BC/VT、临时RGBA/scratch、映射/目录、几何、增长双份，分清有效bytes与allocator实际分配 |
| 稳态 | 无流送时新增工作为0的检查，流送时P50/P95及样本数；不凭文件缩小宣称FPS提升 |

网络至少受限与高速/暖缓存两类；包含冷模块费用，0/50/100%节省模型按设计§11。几何布局模型与选组压缩率不能相乘当整场景结果。若局部优化比直接donor更差，先修/删本地额外税，不把基础路线回退为默认Q100。

## 9. 失败分类、审查与提交

原输入/输出、构建/hash、日志和失败保留，按[VALIDATION](../VALIDATION.md#validation-failure-contract)定位源码/移植、产品/元数据、数值语义、容量、生命周期、宿主测量或基础设施问题。原失败不追认为修复；一次偶然绿色不覆盖原失败。

每单元末一次architecture review：唯一owner/writer、全部consumer、能力前置、完整写域、信用与复制、cancel/abort/retry/loss/fence、retired依赖删除。新内核source mapping、独立检查和production消费齐备后才升级采用状态，不把上游成熟自动变成本项目adoption。

`docs/domains/`在生产切换后更新真实事实，稳定ABI定型后写spec/contract；不在中间阶段造重复progress/evidence。中文commit标题与正文记录动机、范围、实际检查与未运行原因；本次用户已授权复核后提交准备改动，不由此推定E0以后已授权实施。

## 10. 旧U0证据的保留与结论撤销

隔离工具保留在 `OEngine/tools/web-asset-u0/`，机器快照为[results.json](../../OEngine/tools/web-asset-u0/results.json)，原日志在 `.local/web-asset-u0/`；它们不是新计划状态或生产采用证据。旧快照`baseRevision`复制有笔误，实际P提交为本文件头部HEAD；不静默改写旧快照伪造实验身份。

可以继续引用的有限事实：XUBC7构建/往返/有界内存、旧选样的码率/误差、geometry source-exact资格与SoA模型、所选group压缩和最小GPU读数。原报告记录279编码小样、36纹理Worker/GPU、15负例、2058几何读数、72transport往返等；这些计数不等于新模块检查已完成。

**撤销以下设计推论，不删除原测量：**

1. 全语义默认XUBC7 Q100；Normal/ORM不允许图片路线；普通固定256²、Spark路线被否决。
2. 用单个`spark_bc7_rgba.wgsl`的Normal/ORM结果代表BC5/BC7 RGB及上游完整PBR路径。
3. Normal/ORM只有lossless WebP、颜色才有Sharp AVIF的实验，推导“数据纹理AVIF无收益”。
4. 串行submit→`onSubmittedWorkDone`的约3–4ms推导真实shader耗时/每帧编码预算；该数不含完整上游准备路径，不是GPU timestamp。
5. XUBC7 Q90/Q75重叠不一致推导Spark/AVIF分页接缝已失败，或低PSNR自动等于不可接受材质。
6. 几何旧选组结果否定整个meshoptimizer家族、精确资格为0证明所有紧凑编码不可能。

旧OOM/初始化表遗漏、并行构建/生成导致的身份错误、BC4 CPU近似与硬件差异、fixture缺失等原失败日志继续保留。新计划不以重复跑旧工具代替忠实移植，也不把旧失败重新命名为新路线bug。

## 11. 完成与停止条件

本模块实现完成需要：新全套PBR/普通/VT产品与全部真实consumer已切换、旧依赖删除、合法来源/许可、质量档/边界/精确语义、容量与组合生命周期成立，成本如实报告。正式跨设备FPS/画质资格可按仓库节奏归最终集成，但已发现错误、漏工作与失控容量不能延期。

当前停止在E2生产切换前，后续E2需另行授权。以后用户授权某单元就完成该单元，授权整模块则按依赖连续推进；不自动启动其它效果、HDR/神经压缩或有损几何精度变更。

## 12. 本轮P准备记录与后续实施结果

本节是唯一详细状态入口，后续E0–E5结果在本节追加，不另建status/progress。workstream只导航，不复制单元完成表。

### P：2026-10-20重建设计准备

- 已重新核对实际schema/Worker协议、CPU信用、普通/VT publication、direct geometry upload/query、normal/moment特殊语义和hello入口。
- 已核对Spark全PBR接入与四种BC内核、gltf-tex原生语义配置、实际PBR示例；固定来源、许可区分和工具版本基线写入设计/账本。
- 已删除旧设计/执行，建立新唯一文档并同步导航/来源引用；原U0工具/原始数值保留、过度推论明确撤销，无生产代码/资产改动。
- 已运行`node tools/docs-verify.mjs`：209 documents、0 finding、86 historical warnings；`git diff --check`无错误。普通纹理和几何各一次`vibe context`都已路由新唯一设计/执行，旧文档路径/旧来源anchor无当前引用。
- 设计复核修正了128 cell两侧gutter与NPOT repeat的依赖上界，明确最坏任务整体容量准入；补齐普通NPOT压缩块padding与真实UV/导数/LOD合同。
- 未运行TS/C++/WASM/GPU/browser/benchmark，因为本轮未实施新生产路径。不宣称已有新AVIF全资产大小、画质/吞吐、来源adoption或许可授权。

### P复核：2026-10-20提交准备

- 用户追加授权检查并提交准备改动，仍停在E0开工前；本次提交包含原有未提交的U0隔离工具/快照及注册入口，用于保存§10所述历史，不作为新路线production实现或新验证结果。
- 复核修正decoder与GPU external copy的颜色/alpha双阶段合同，补齐VideoFrame→ImageBitmap适配/复制信用；普通NPOT加入可选unaligned能力及无该能力时逐层过滤/边缘/LOD成本要求，不再将一次UV缩放视为完整方案。几何handedness其它合法值继续保留原精度，不因新布局收窄输入。
- 重新运行docs-verify：209 documents、0 finding、86 historical warnings；diff whitespace检查及旧authority/anchor引用清理通过。两次owner导航均指向新文档。
- 对7个U0 JS工具与oracle registry执行`node --check`；`gpu-oracle --list`和reference registry存在性/entry/features/prefix检查通过；旧快照11个工具SHA256与实际源码全部匹配，原快照未重生成，baseRevision笔误继续按§10注明。
- 未重跑旧U0 native/WASM/GPU实验或生产编译/benchmark：本次只修改准备文档/导航，旧工具原样保存，新生产代码未改；以上静态完整性检查不提升旧实验或新路线资格。Spark shader适用授权与新浏览器数据链验证仍为E0/E1具名工作，不冒称已解决。

### E0：2026-10-20依赖与移植基线准备

**结论：E0准备交付完成，停在E1边界；没有生产切换、recook或自动提交。** 技术路线不重选。完成指工具可用、来源/许可状态明确、完整阶段和实际合同已细化，不表示Spark生产再分发授权或E1 GPU移植已完成。

#### 已落地的工具与来源

- `OEngine/tools/extreme-web-asset/prepare.mjs`、`sources.json`取回8个精确revision：Spark、gltf-tex、真实PBR示例、libavif、libaom及zlib/png/jpeg依赖。每个checkout核HEAD/无tracked改动，完整tracked tree与来源/许可文件SHA256写本地source identity。未执行npm安装脚本、未复制shader到production。
- libavif1.3.0/libaom3.12.0完整native encoder/decoder，MSVC19.51.36257.0、CMake4.4.2、NASM2.16.03，Release/x64、完整SIMD、aom encode/decode。png/jpeg/zlib从固定源链接本地static依赖；libyuv明确OFF，使用完整libavif自身RGB/YUV转换，不伪称已验证有libyuv的吞吐。libavif默认LOCAL会取aom3.12.1，故采用显式本地SYSTEM查找并核CMakeCache实际路径，未混用版本。
- `native-profiles.mjs`明确High80/Extreme50、speed4锚点和speed2候选、IQ/SSIM、10-bit、444/400、full/CICP及alpha策略。`native-smoke.mjs`分别跑donor原始argv与本地显式配置，18组编码→元数据→native解码通过，1组非法tune明确拒绝；它只证明工具配置，不是AVIF材质质量/浏览器上传结果。
- 最新`avifenc.exe` SHA256为`c2b8e632f6c8cf85ce953316eb6405f276eeb70958cb89dc6d5691f315761d32`；`avifdec.exe`为`1f7f31eb6f9effe11c23d02ca8273bce1f234fbfee5cbb42da9986e96392055e`。有限身份快照为`OEngine/tools/extreme-web-asset/e0-baseline.json`；完整commands/flags、compiler/cache/binary和license/PATENTS哈希在`.local/extreme-web-asset/native-build.json`、`sources.json`、`native-smoke.json`。后续重建可能因MSVC构建身份变化得到不同exe，须更新实际hash并重做受影响smoke，不要求跨构建位相等。

#### 许可交付边界

2026-10-20取回Spark EULA与Commercial网页，SHA256分别为`c60e4a134f140a6e48bb5b729a48136248f414c633b7d27ec32412d9a7305f88`、`2a849f1aaa40f0124a121a66503ba88d4d313c9a2b05d57ca8a43a4b4bd50e66`。仓库JS MIT不覆盖shader；当前EULA引擎/工具例外限evaluation并有下游/attribution条件，生产分发权未记录。Commercial还要求相应项目和下游条件，不能凭页面存在宣称已购买/授权。本轮不联系第三方/不购买/不向公开包复制shader。E1可以继续合法宿主/产品工作，实际vendor/分发选定shader前必须满足适用权利，不能自写近似版绕过。

gltf-tex固定pin只有package/README MIT声明，无独立版权notice；本轮研究完整处理路径、复现有效CLI配置而不直接vendor实现。需要代码复制时取得适用notice；若只按native工具参数和本地canonical合同接入，必须继续标Reference/Local，不能冒称源码port。libavif/aom及相关依赖的license/third-party/PATENTS保留在本地工具license目录，未来公开交付再随实际包附带。

#### E1可直接施工的合同

- 设计§4固定纹理目录schema4/准备协议4；普通与VT共享根合同，GPU与网络四域分开、三种成功receipt/失败分支、u64范围/u32索引与先验容量。E2几何仍显式major3，E4才切major4，不通过错标签假装原子完成。
- 设计§5明确canonical前置、normal XY解码后恢复B常量、scalar精确提通道、XYZ/moment不归一化；provided chain与coverage独立。normal XY mip相对旧XYZ滤波是显式语义变化，不能称数学等价。
- 设计§8.1固定BC7 RGB/RGBA、BC5、BC4/R8 bank语义、donor f16/机械f32精度profile、可选unaligned、API/limits/usage前置；保留compute magic/alpha box和browser fragment路径的真实差异。E1要核data上传和alpha/mip语义，不能按上游项目名自动通过。
- 设计§8.2明确FrameCoordinator唯一frame command、scene owner的隐藏准备批次与最后原子publication、observeSubmission/abort/fence退休。修正“持有整场景未提交command却等待scratch fence”的活性缺口；不是transcoder每图私有submit，不增加独立frame submit。
- 来源账本已补源阶段/条件→本地owner与不可简化边界；VT assembly/receipt/容量/scene批次为Local，Spark完整所选编码kernel尚未vendor/编译/生产消费，不提升adoption。

#### 实际检查、原失败与未运行项

- native构建及上面18+1 smoke通过；新增定向TestsStream为3 passed、0 failed/cancelled/skipped/todo。3个新增JS工具及定向测试均通过`node --check`；有限快照与当前recipe、来源manifest、8个来源tree、2个exe、许可页面及18+1结果身份一致。
- 收口运行`node tools/docs-verify.mjs`：209 documents、0 finding、86 historical warnings；`git diff --check`通过。普通纹理与几何各一次`vibe context`均路由当前唯一设计/执行。architecture review核对完整donor阶段、颜色/alpha双阶段、normal常量恢复、唯一command owner及scratch退休活性；本轮只新增隔离工具/检查并细化文档/导航，未改production src、资产、依赖lockfile或既有生产ownership。
- 按现有`CHECK_RUNNERS['tooling-suites']`运行完整工具套件，两次均16 tests、15 passed/1 failed：`tools/tests/test-build.test.mjs`临时repo只创建codec夹具，但`tools/test-build.mjs`还必需复制`src/render/assets/sssr`（后续还有STBN）；真实repo资源存在，失败是旧临时fixture不完整，不是E0 native或GPU故障。没有改生产build脚本跳过资源、没有放宽/删除断言；原失败保存在`.local/extreme-web-asset/checks/tooling-suites.json`。不将整套工具验证写成通过，修该无关夹具不作为E0开工反复中断项。
- 构建准备原失败保留：首次fetch末尾Node24.1 libuv shutdown断言（改为自然结束后未复现）；PowerShell展开archive的args传参错误（改明确literal路径）；libaom缺Perl（固定Git Perl/允许EENGINE_PERL）；上游zlib CMake重命名tracked zconf.h导致清洁检查拒绝（核原blob一致后只恢复该工具变更，改在独立build-source副本构建并逐文件核hash）。原日志未删，后续原构建/受影响smoke已重跑通过；未通过删SIMD、改codec或省算法步骤“解决”。
- 未运行新GPU/browser、全Renderer TS/build/画质/FPS与整场景压缩测量：本轮不改production src，也未授权E1。E1拥有新GPU最小输入→输出/lease回收、E2拥有生产全消费者接线、E5拥有组合检查，不把native smoke冒称这些结果。

### E1：2026-10-20忠实内核与新产品准备闭包

**结论：E1的隔离新产品→共享准备→真实GPU编码/采样闭包完成，停在E2边界。** 此处完成的是文档允许的本地evaluation实现，不是Spark生产shader分发授权、正式production adoption或普通/VT全消费者切换；没有公开导出新入口、recook现有示例或提交代码。

#### 实际产品与producer

- 新`ImageTextureProduct.ts`统一resident/virtual schema4，明确完整逻辑mip、semantic/target、channel常量、address、alphaScale和有限image/raw-exact item；u64十进制范围、encoded/decoded/元数据上界、完整item索引、无洞/无重叠owner sweep与source范围检查。128网格/NPOT尾格支持provided owner；页依赖/VT assembly和逐层采样元数据归E2，不冒称已实现。
- `ImageTextureCook.ts`从已定向/canonical RGBA8直接生成native AVIF：全6类语义、原XYZ同时计算单位normal XY、标量真实提通道、精确常量、全opaque去alpha；provided XY不再次normalize，XYZ/moment保持长度，coverage独立提alpha为raw精确段。无consumer删除/全材质依赖分析与跨资产调度是E2接线，不在隔离Cooker猜测不存在的consumer。
- `tools/extreme-web-asset/cook.mjs`核实际avifenc哈希，recipe包含binary/native profile/Cooker/glue身份，content-addressed payload先写，最终directory最后原子替换。运行时不搜索质量、不装WASM图片decoder，不把旧BC反解为canonical。raw是设计允许的精确段基线，不伪称已经有新通用Zstd精确段优化。
- `fixtures.mjs`实际生成14个产品（6语义×High/Extreme及7×5/1×1）、另一个straight-alpha独立产品。文件只在`.local/extreme-web-asset/e1-fixtures/`；不是hello/Dungeon/Bistro recook，不报告整场景压缩率。

#### 统一准备、能力与生命周期

- 在**原有**`CookedAssetPreparation`/`AssetWorkerPool`/cooked worker增加显式version4 image-item入口，不新增pool/IO/Worker调度owner，不把旧schema包装为新产品。单目录验证/冻结注册，全局目录accounting≤8MiB，逐任务只传选中item/plane；source release/session close销毁ready并取消未完成任务。
- 读取前整任务encoded/decoded/ready容量准入，HTTP状态/Range/Content-Range/Content-Encoding/长度和SHA检查，静态AVIF箱体/主图/alpha关联/direct extent/10-bit/444或400/CICP/方向/尺寸在browser decode前拒绝不符profile。该parser只是固定native产物admission，不称通用AVIF parser或AV1 decoder。
- ImageDecoder优先、同表示ImageBitmap宿主路径；VideoFrame→ImageBitmap双backing收费、frame/decoder finally close、transfer失败显式报错。仅已分配pool任务结果签发一次lease，release后不能再编码；迟到/retained receipt失败关闭图片。30秒任务timeout按同一pool取消/Worker退休处理，不继续后台无信用运行。
- encoded/decoded/ready沿共享credit；E1 composition选16MiB encoded，CPU峰值保守`2×encoded+4×decoded`，ready至少双份；浏览器未知内部内存不是RSS硬上界。生产旧构造默认预算在E2统一切换，不在本单元提前改变旧消费者。
- 新`ImageTextureTranscoder.ts`调用方command encode-only，支持完整原始BC7 RGB/RGBA、BC5、BC4、canonical常量恢复、完整1×1 mip、R8 exact copy。没有finish/submit/readback权、最终texture分配权或长期Residency所有权。按实际logical mip各建精确尺寸scratch，physical block copy不resize原图；非零mip/layer/origin通过真实消费。
- pipeline按设备/precision初始化；GPU RGBA默认≤48MiB，block/params默认≤16MiB，完整任务和实际limits先检查。槽按尺寸/层数/target分组，queue external copy之前独占至fence；不足返回needs-drain，不等自身未提交command。abort、failed fence、dispose与device loss退休；exact staging单独同域计费。
- compute magic/alpha box完整保留；fragment mip直接使用donor fullscreen/mipmap_fs完整函数。在core宿主可显式选择；Firefox自动选择该宿主profile。fragment未实现alpha weighting/scale时明确要求provided chain，不静默当等价。Compatibility mode不属于当前Renderer core binding profile，创建前拒绝；本轮实测Chrome，不声称已验证Firefox/Safari。

#### 忠实来源与许可

四个BC WGSL与完整utils均从E0固定checkout读取并核SHA256，未复制进src/vendor/公开dist；f32严格沿上游五种机械替换，f16用原kernel。本地oracle页面保留Spark attribution/EULA链接及evaluation下游条件。原始Spark JS作为独立donor宿主；本地glue不执行其私有submit，诊断oracle可正常提交/回读，不进入production hot path。JS参考实现与Local canonical/产品/容量/lease明确分开，不假称所有代码源码移植。

**Spark生产shader再分发权仍未记录。** E2可以继续合法产品/消费者工作，但实际公开集成前仍需适用权利；本轮本地evaluation通过不升级为生产采用，也不自写近似版规避许可。

#### 实际检查与原失败

- `npm --prefix OEngine run build:test`、`typecheck`及完整`build`通过；Vite保留既有Emscripten `node:module` browser externalization warning，无新增构建错误。
- 定向TestsStream：image新产品6项，加直接受影响cooked/tiled worker回归7项，合计**13 passed，0 failed/cancelled/skipped/todo**。记录`.local/extreme-web-asset/e1-targeted-final.json`。
- 真实GPU串行跑`image-texture-transcode`和`image-texture-transcode-f16`，Chrome155.0.8059.84、NVIDIA Turing硬件，分别无shader-f16的f32与启用shader-f16的f16。每条14产品/22图片item，**56个donor block/mip逐字节比较、682个coverage精确字节**通过；全部所选格式真实采样。7×5/1×1不冒称stock resize等价，只核完整logical输出、无越界及实际消费。
- decoder→upload独立data/color-rgb字节检查、常量恢复、BC5半球重建、provided非单位moment、完整1×1链、两个不同未提交图片逆序submit、needs-drain保留lease/abort重试、超容量拒绝、损坏源、source/session retirement和真实独立device destroy检查通过。最后CPU credit/GPU scratch归零；完整报告在`.local/extreme-web-asset/e1-gpu-f32-final.json`与`e1-gpu-f16-final.json`。
- 原失败保留：首次donor输出诊断回读漏COPY_SRC（修oracle显式outputTexture，不改算法）；随后RGBA诊断把VideoFrame.copyTo透明RGB取整结果当ImageBitmap上传位相等oracle（原失败JSON保留，确认两种诊断转换舍入不一致后拆正确断言：alpha保持精确，独立恒定[255,0,0,128] straight RGB/alpha逐值检查，donor同输入BC仍逐字节比较）。不是放宽normal/ORM/coverage或BC对照容差；原`first/second/third`结果不改写为通过。初次TS错误为discard回调插入assign而非finish，修本地接线后新鲜编译通过。
- 本轮没有重跑E0完整tooling-suites，原15/16旧fixture失败继续保留。没有运行正式整场景画质/FPS/压缩率/VT接缝或生产publication，归E2/E3/E5，不用隔离最小GPU结果代替。收口`docs-verify`为209 documents、0 finding、86 historical warnings；`git diff --check`通过。
