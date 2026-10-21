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

日期：2026-10-20。唯一目标依据：[设计](../next-design/eengine-extreme-web-asset-compression-2026-10.md)。设计最初核对源码为`5f3f4153`，准备提交为`1f856ea0`，E0/E1提交为`eddb8669`；后续施工状态只读§12，不把初始快照当当前源码事实。

**用户已授权先提交E4，再推进最终E5；E4已提交为`f6398625`。** P为`1f856ea0`，E0/E1为`eddb8669`，E2为`4ee234cf`，E3为`9329af7d`；E4实现与最小检查见§12。E0–E4以连续实现、设计对照与必要编译/少量正确性检查收口，不保兼容旧路径；完整场景cook/recook、部署、GPU全路径与组合成本统一E5。E5发现问题必须回到设计规定的owner修复，不打兼容补丁，不自动启动其他模块。

## 1. 执行合同：连续实现，最后集中验证

主线已确定为“全套常规LDR PBR图片传输→GPU编码”，不是竞争实验候选；以完整上游为可工作的基线，移植与架构适配优先。验证检查忠实度、集成、安全、语义和成本，不再用单RGBA内核或错误计时淘汰整条路线。

每个实现闭包包含producer→产品→准备→全部直接consumer→capacity/reset→提交/中止/重试/退休。原子切换是代码ownership约束，不是“先保持旧链可运行，完成全场景验证后才删除”的门禁。阶段内允许编译/示例暂时断链；在同一实现单元直接改完全部consumer并删除被替换的生产parser、writer、owner、vendor/build依赖、导出和兼容测试，不按consumer渐进上线。不得为中间可运行建立新旧schema桥、旧owner fallback、A/B开关、adapter或两套资源管理/Worker调度，也不先上线RGBA再补BC。

按实际工程量划单元，不按文件数/天数估计。大单元内部连续施工，不每个helper跑全Renderer，不把每轮性能对比设为下一patch许可。停止点服从用户授权，不能自动越过当前模块。

### 1.1 唯一推进顺序

`设计/源码 → 连续实现完整闭包 → 直接删除旧路径 → 设计对照 → 必要编译与少量最小测试 → 已授权下一阶段 → E5统一cook与全路径验收`。

阶段内允许暂时断链；阶段退出前修复本阶段真实编译错误。不以完整场景可运行作为删除旧路径或继续实现的前提，也不为中间状态制造临时adapter。提交可以是明确未完成的施工检查点，不能把提交等同阶段完成。

### 1.2 E0–E4统一退出条件

1. 对照设计核对完整算法阶段、唯一owner、直接consumer、容量/错误路径与退休代码；实现不因测试延期而省步骤。
2. 修改完成后集中做必要的相关编译/typecheck或shader编译，以及少量最小输入/输出、ABI或生命周期测试；不每patch重复执行，不扩大为整Renderer宿主。只有某个具体实现问题无法靠源码/小检查定位时，才运行能定位该问题的最小GPU检查。
3. 不运行hello/Dungeon/Bistro等完整资产cook/recook，不运行全路径browser、整场景画面/质量/性能对照、完整组合生命周期或宽泛回归；这些只在E5集中执行。小型固定输入用于codec/API正确性不等于全量资产cook，不展开成多档搜索或资产报告。
4. 已发现的真实错误立即修实现；未运行的集成检查明确留给E5，不冒称通过，也不作为拖住连续实现或恢复旧路径的理由。“实现单元完成”与“最终集成通过”分开记录。
5. 仅为旧生产路线服务的离线reference/工具也删除，不以“历史参考”留下可运行旧全链。来源原文、原始日志/结果和确被新路径使用的独立canonical resampler/冷输入decoder可保留，但必须明确新owner和调用关系，不提供旧资产兼容入口。

### 1.3 实现与验证分工

| 工作 | E0–E4 | E5 |
| --- | --- | --- |
| 全部producer/consumer、算法分支、容量及生命周期代码 | 当阶段完整实现并按设计核对，不留简化替身 | 验证实际组合，发现错误局部修复 |
| 旧schema/owner/兼容入口/专用vendor与工具 | 替换时直接删除，不等完整场景验证 | 只确认无遗漏，不负责拖到最后才删 |
| 编译与少量最小字节/ABI/输入输出检查 | 阶段末集中执行；最小GPU仅用于具体实现疑点 | 最终新鲜构建及必要受影响检查 |
| 完整cook/recook、多档资产搜索、报告、manifest/部署 | 只实现工具与引用代码，不执行完整资产任务 | 使用最终合同统一生成并检查部署 |
| 全路径browser、画面、所有采样/reader组合、完整生命周期/成本 | 不运行，不当退出门禁 | 本模块唯一集中执行阶段 |

几何在E4前仍由当前唯一几何owner承载，不是新几何ABI的兼容fallback；E4同切后删旧ABI。保留成熟VT反馈/驻留算法作为新图片路径唯一owner的能力，也不等于保留旧BC网络链。

## 2. 单元、依赖和当前状态

| 单元 | 工程量 | 完整交付与稳定边界 | 依赖 / 当前状态 |
| --- | --- | --- | --- |
| P：重建设计准备 | 中 | 新唯一设计/执行、来源映射与导航，删除旧主张，记录证据边界 | 已提交；实际结果见§12 |
| E0：上游依赖与移植基线准备 | 中 | 固定编码工具/许可、donor完整路径、产品/能力细节与构建身份；无生产切换 | 已实施；实际结果与许可交付边界见§12 |
| E1：忠实内核与新产品准备闭包 | 大 | 新图片产品、语义Cooker、浏览器decode/lease、GPU recorder、有限内存，覆盖RGB/RGBA/BC5/BC4和mip | 隔离闭包已实现并验证；本地evaluation来源边界及结果见§12 |
| E2：纹理全链原子切换 | **很大，主工作项** | 普通/VT、材质/coverage/query、统一准备/缓存、加载/部署代码直接切换、旧产品与依赖删除；不跑场景recook | 实现闭包及相关编译/最小检查完成；最终集成与许可边界见§12，停在E3 |
| E3：离线极限码率与交付优化 | 大 | 实现双质量档有限搜索、最终GPU评价缓存、资产报告生成、VT cell布局与请求优化；不跑完整资产搜索/报告 | 实现与最小检查完成；完整资产搜索/质量/部署在E5，仍只一个生产owner |
| E4：几何紧凑ABI与无损传输原子切换 | 很大，独立资产类别闭包 | F32-exact SoA、Zstd/raw、全部Cooker/reader/query/lifecycle代码同切并删旧ABI；不跑场景recook | 本轮已授权并完成实现；结果见§12 |
| E5：最终集中cook、全路径集成与成本收口 | 大 | 统一全量cook/recook与manifest发布、新鲜build、全部直接路径/示例部署、组合生命周期/上界/质量及粗成本 | 已授权，进行中；全路径验证唯一阶段，尚未通过 |

E1是即将接入生产的新模块，不是永久第二套runtime；生产入口在E2一次替换。E2必须带最基本的正确边界和资源预算，不能把接缝/缺页/失控容量当E3优化延期。E3不为优化另建ABI或再选一轮基础codec。E4不混入纹理切换以免最大闭包失控，但几何本身不得按reader分批迁移。

## 3. E0：直接准备移植，不再做方向选型

### 3.1 开始时核对事实

```powershell
git status --short
node tools/vibe.mjs context OEngine/src/assets/ImageTextureSource.ts
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
- 普通runtime-mips/provided-mips与VT逐mip owner/cell/tail在同一产品合同内；实现High/Extreme上游锚点配置，E3实现有限码率搜索，完整资产输出归E5。
- 路径、toolhash、recipe变动使旧收据失效。manifest写临时产物后校验、再原子替换引用；失败不发布半份目录。

### 4.2 浏览器解码与信用

复用Spark `loadImageDecoder/loadImageFromBlob`的有效语义与浏览器差异处理，整合进入现有AssetWorkerPool/统一准备owner，不复制上游独立网络系统。优先ImageDecoder、适用时ImageBitmap；API能力差异是同一图片表示的宿主适配，不是codec/旧schema fallback。

IO/hash校验、pixel/尺寸/CICP/静态profile检查后解码，转移独占ImageBitmap/VideoFrame或受支持的同表示结果；transfer失败明确关闭并报错，不默默增加JS RGBA整图copy。超时/cancel后继续计入未完成工作，stale reply关闭/释放；模块、decoder内部估算、backing复制与ready分别计账。

浏览器API适配不得误改data通道：按设计§8单独控制decoder与external copy，normal/ORM/标量不执行隐式transfer/primaries变换。必要VideoFrame→ImageBitmap是同表示宿主适配而非旧路径fallback；先按实际backing保留双份信用，再交接/close。实现对应检查入口，data ramp、透明边缘及Identity图片的完整独立检查集中归E5；不能仅凭`colorSpaceConversion:none`判断全链无转换。

### 4.3 GPU recorder与小闭包消费

直接引入有权使用的对应完整内核；上游shader如为minified生成资产，保留vendor源/hash，使用可追溯机械格式化/构建方式，不手工改写数学。EEngine手写WGSL/glue保持可读。所选f16/f32路径按donor支持方式及真实device协商，不让缺shader-f16静默改变精度合同。

新recorder在调用方command记录预处理/mip/编码/copy，不调用上游私有submit。外部图片copy、输入池复用、GPU fence与CPU对象close时机明确；实现BC7 RGB/RGBA/BC5/BC4真实采样consumer以及非零layer/origin/mip，不用固定0的简化接线替代。

阶段末按设计核对所有variant、完整mip与输入/输出/退休分支，只挑少量最小输入输出检查，不按格式/精度/consumer逐个启动完整宿主。完整donor对照与采样/生命周期矩阵统一列在§8.3，E5集中执行。

### 4.4 退出

新模块隔离可构建、所有选定内核和图片结果表示完整；按§1做设计对照、必要编译和少量最小正确性检查，尚无生产入口切换。E1已运行的真实GPU结果保留为历史事实，不因文档调整重复跑。完整矩阵归E5；实现不得省略选定语义，最小检查通过也不自动提升生产adoption。

## 5. E2：纹理全链Clean-Cut，最大工作单元

### 5.1 同一闭包施工范围

| 架构面 | 当前新owner/入口 | 必须闭合 |
| --- | --- | --- |
| canonical、AVIF、部署 | `ImageTextureCook/Import/KtxImport/Resample`、tools/texture-codec、`cook-offline-scene.mjs` | 新语义/目录/完整mip或base-only、tail、source/cache identity、离线/合法Web输入；只实现工具，不跑场景cook |
| 产品与公开来源 | `ImageTextureProduct/Pages/Source`、ShadeTexture及公开导出 | 新source/receipt/lifecycle；旧schema前置拒绝，无adapter |
| 统一准备层 | `codec/CookedAssetProtocol.ts`、`CookedAssetPreparation.ts`、Worker/pool/credit/cache | image/exact/geometry有限表示、transfer、去重请求/公平性、峰值/取消/重试 |
| GPU转码 | 新recorder、pipeline/input/scratch owner、真实command接口 | 所有格式、mip、复制、层/区域、能力/容量、abort/fence |
| 普通与VT Residency | `TextureResidency.ts`、`VirtualTextureResidency.ts`、texture refs/banks | mandatory/渐进、owner cell→页装配、mapping/victim、失效/退休 |
| 材质与全部消费者 | native material graph/codegen、Surface、coverage、VSM/shadow、query/SCGI实际采样点 | BC5重建和通道含义一致，alpha/UV依赖完整，绑定/重置/neutral层正确 |
| 帧和scene事务 | `FrameProgramLowering.ts`、`ShadeGPUCommandContext.ts`及真实scene publication owner | 正常提交顺序，不私有submit/等待GPU控制，不公开半初始化产品 |
| 入口与部署 | hello、现有Dungeon/Bistro cooked入口、manifest/fixtures | 加载/部署代码只认新合同，删除旧引用及旧资产部署入口；实际全量recook/生成manifest和部署验证放E5；hello不强开VT/VSM |

### 5.2 普通纹理子闭包

实现完整基础图输入→GPU mip/压缩→最终array/layer→真实材质。preview和细层只在设计允许的依赖域发布；无preview则完整隐藏准备。大图按预算分片时使用正确provided mip/邻域，不独立生成错误边缘。可选unaligned能力前置协商；tiny/NPOT的block padding、逐层有效域、混合U/V寻址、显式导数与LOD贯通全部采样点，不拉伸源图。无unaligned能力时不能仅缩放UV：补齐后逐层尺寸不成比例，必须实现逐层过滤和跨缝/anisotropic/trilinear语义，实际额外采样/边缘存储列入成本；完整独立验证归E5。CPUready在upload接受后逐任务释放，GPU scratch按fence退还，scene未发布不阻止临时资源回收。

BC5是新target布局，所有format bank/array分组、readMask/normal重建、neutral texture、采样导数/LOD、动态材质引用与销毁必须一起改。透明度或通用表达式依赖normal原RGB时保留/重建原语义；不能只修改一个PBR normal helper。

### 5.3 VT子闭包

按设计唯一decoded owner建立空间索引、有限邻域依赖、Range与lease。支持128/256/512 owner布局，不把cell当驻留slot；128网格常见九依赖、NPOT极窄末格/repeat与混合布局按通用最多16依赖求实际集合，不误用四邻居上界。页请求需要的owner先整批容量准入，避免hold-and-wait；assembly保持wrap/clamp/mirror和NPOT数学，然后原内核压缩144²、复制真实非零slot/layer并原子更新mapping。

本单元必须在实现上覆盖：相邻页重叠块一致、cell边界、fine/tail连续、trilinear/anisotropic/运动、query-only需求、victim/retry/abort、冷尾层与最小合法容量。阶段末对照设计和源码检查这些分支，挑必要的最小用例，不在E2运行全部路径/组合/画面检查；完整验证统一归E5。已发现的错误立即修，不能写成“E3优化项”。大cell过取/邻域开销保留可解释计数，不恢复原BC网络路径。

### 5.4 必须删除/迁移的东西

- 旧schema3普通产品和schema2 tiled产品的生产parser、writer、收据、source桥与对应导出；旧资产必须recook，不自动升级。
- “磁盘payload等于GPU native-ready”“必须完整BC product才能构造普通纹理”等假设。
- 只为旧纹理路径服务的BC/Zstd decoder/vendor/build/初始化及native tile replay/cache；被新canonical、合法冷输入、几何或精确段真实使用的独立内核只保留其明确owner，不以旧离线reference为由留整套旧链。
- 旧XUBC7竞争路线生产占位，以及仅服务旧路线的可运行工具/构建依赖；只保留不执行的来源资料、历史结果/失败日志。新路径确实使用的独立内核按新owner保留，不保留旧全链入口。
- 为旧ABI存在的测试表示、无消费者的compat flags；其normal、coverage、数值与生命周期语义迁移到新owner，不恢复旧实现跑绿旧测试。

### 5.5 原子切换与退出

直接完成全部普通/VT生产consumer和加载/部署代码切换，立即删除旧生产owner/schema/parser/writer、专用vendor/build依赖、导出与兼容入口；不等待完整场景验证，也不保留旧路径使示例暂时可跑。按§1完成设计对照、相关编译和少量最小检查即可关闭E2实现。示例资产暂未生成或入口暂不可运行，明确归E5全量recook/部署，不为此回接旧owner。E2只声明“代码ownership已切换”，不声明全路径、画面、性能或公开分发资格通过。

## 6. E3：在忠实基线之上做极限压缩

### 6.1 离线搜索闭包

将High/Extreme、donor锚点、有限Q/effort候选与成熟评价工具接入Cook。先真实复现donor配置，再对相同canonical资产优化；输入/工具/全部argv/target/评价/设备能力身份参与缓存。使用最终GPU编码结果与材质，而不只测AVIF解码图。离线GPU作业串行，不进入runtime读回热路径。

每个产品保存可解释选择：原候选/选中候选字节、质量向量、硬语义结果、编码耗时；没有合格更小候选就保留同路线donor码流，不回XUBC7、不强降分辨率。非单调编码行为不使用未经证实的纯二分搜索假设。

常量通道消除、语义去重、去alpha、基础层传输优先在E1/E2具备正确最小实现，本单元强化搜索与交付，不第二次另造资源管理。相同采样依赖时的打包可作为具名有限候选，若新增分支/metadata/质量成本不能回收则不加入默认hot path；不是所有纹理强行NRM打包。

### 6.2 VT与请求优化

使用固定完整需求trace或明确无trace条件，选择有限owner cell布局；同时计算payload、目录/请求、fetched overfetch、decoded依赖与GPUassembly。稀疏区域选小cell，连续区域才利用大cell，不以完整pack大小代替实际流送收益。

Range合并有总字节/过取上限及同urgency约束；不能为吞吐延迟mandatory tail/coverage。decoded邻域LRU有界，无效需求取消/过期释放，不默认编码/驻留下载cell中所有页。preview起点和粗细切换要计入首屏/完成时间，不能把“画面出现”当“目标质量已达到”。

### 6.3 实现退出与最终资产检查归属

本阶段实现完整资产搜索/报告的代码与缓存身份，用少量固定输入检查候选选择、质量拒绝和结果发布；不运行完整hello/Dungeon/Bistro的cook、搜索或报告。E5再依次运行hello全部15纹理及当前允许的Dungeon/Bistro，不将裁片外推为整场景。对照旧路径使用已保存的资产/结果身份，不恢复旧生产链或旧可执行工具；donor、本地忠实适配和优化后的比较也集中到E5。

报告代码必须覆盖High/Extreme相同尺寸/功能下的全部下载字节（含module/目录/preview/精确段）、编码成本和最终质量；VT另含相同trace实际fetched。完整报告和实测在E5生成。E3以设计核对、必要编译和最小选择逻辑检查退出；没有整场景数字不阻塞实现，也不允许先声称“更好”。

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
| 生命周期 | retain/evict、replacement/generation、bank growth/abort、地址发布、device loss、scene unload、部署代码；实际recook归E5 |

全reader直接读新紧凑流，不将新产品展开为旧V3页，不另存精确query副本。payload沿原有效前缀direct write，publication沿encoder事务；保留growth双份峰与旧lease退休顺序。

### 7.3 检查与退出

先实现并对照设计核对全部直接reader、corner/remap/UV/barycentric、bounds/SSE/motion、growth/abort/retry及资源上界；直接删除旧V3生产schema/reader/ABI与兼容入口。阶段末只集中做必要C++/WASM/TS编译及少量layout/byte/source-exact往返检查，不逐reader启动GPU宿主、不运行全量cook和完整生命周期组合。全部路径真实消费、极端输入和组合验证统一归E5。精度合同不变，不能改成对量化产品精确。

## 8. E5：最终集中cook、全路径集成、质量和成本

### 8.1 运行方式

这是全模块唯一集中执行完整资产cook/recook、最终manifest/示例资产发布、部署与全路径测试的阶段。E2/E4只替换代码和删旧路径，E3只实现搜索/报告；不得因它们没有完整场景结果而反复把本阶段提前。先确认最终合同/工具/全部consumer已一致，再一次性生成普通/VT/几何资产，避免每个前置阶段重复重cook。已删除的旧owner不因测试需求恢复。

顺序固定为：最终构建 → 全量cook/质量档搜索 → 校验目录/payload/manifest并原子发布 → 静态包/HTTP部署 → 全路径语义与生命周期 → 质量/资源/粗成本报告。失败保留后局部修复，只重跑受影响部分，不退回旧链。来源许可未满足则不公开分发kernel，不把本地evaluation通过当分发授权。

```powershell
npm --prefix OEngine run typecheck
npm --prefix OEngine run build:test
npm --prefix OEngine run build
node tools/gpu-oracle.mjs --list
```

只列当前实际存在的命令。新增codec/native/WASM构建与GPU oracle在实施时接入真实入口再记录；不预填不存在的case/命令。受影响测试从产品/Worker/Residency/normal/coverage/geometry-query等实际直接文件挑选，不按宽泛文件名扫整类测试。GPU作业串行。

### 8.2 真实组合

- hello：全部15纹理新来源、普通非VT、VSM保持示例设置，HDR单列；不是只替换颜色或只展示preview。
- 当前允许的Dungeon/Bistro及其playground部署入口：使用最终合同完整recook，检查VT fine/tail、普通plane、几何与Native/Surface/shadow/query组合；保持完整场景/材质/尺寸。
- cold/warm cache、持续移动/快速转向/teleport、稀疏页、evict/reload、Range错误/损坏、Worker替换、scene/source replacement/unload、device loss、增长双份峰与fence失败。
- 正式browser/画面/FPS证据由独立validation宿主承担，不把example计时当formal runner；本模块必要的真实接线、语义、生命周期与粗成本不能延期成“最终性能”。

### 8.3 质量验收，不以错指标否定路线

前置阶段实现下列全部分支，E5集中执行矩阵；不是逐阶段重跑的退出门禁：

| 域 | 最终独立检查 |
| --- | --- |
| 完整donor与目标 | RGB/RGBA、normal XY、标量、ORM，f16/f32同能力同输入对照；完整目标格式、非零layer/origin/mip真实采样 |
| 数值/颜色 | data ramp、straight alpha/透明边缘、CICP/transfer、normal方向/高光、provided非单位moment、exact coverage、任意graph原通道/UV依赖 |
| 普通/VT采样 | tiny/NPOT、混合U/V、导数/LOD、bilinear/trilinear/anisotropic、cell重叠块/接缝、fine/tail、运动 |
| VT与容量 | 主/query-only真实反馈→准备→编码→mapping→consumer、父级闭包、最小容量、稀疏页、victim/evict/reload、溢出/完整写域 |
| 几何 | F32-exact bit、全部reader真实消费、corner/remap/UV/barycentric、bounds/SSE/motion、无展开副本 |
| 生命周期 | 并发未提交输入/scratch、取消/abort/retry、迟到reply、OOM/损坏/Range错误、Worker替换、scene/source更换/unload、device loss、增长双份峰/fence失败 |
| 部署 | 最终普通/VT/几何manifest与payload/hash、Worker/WASM/kernel路径及来源范围、实际HTTP；无旧ABI兼容入口 |

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

`docs/domains/`在代码ownership变化后只更新实际事实，稳定ABI定型后写spec/contract；不在中间阶段造重复progress/evidence。实现完成、E5集成通过、来源adoption与正式性能资格分开。中文commit标题与正文记录动机、范围、实际检查与未运行原因；本次用户要求先重构文档并提交现有代码，E2仍按未完成检查点记录，不自动授权E3。

## 10. 旧U0证据的保留与结论撤销

机器快照为[results.json](../../OEngine/tools/web-asset-u0/results.json)，原日志在 `.local/web-asset-u0/`；它们不是新计划状态或生产采用证据。按本次流程调整，`OEngine/tools/web-asset-u0/`内仅服务已退休路线的可执行工具/依赖随E2清理，历史JSON/来源/失败日志保留，不据此要求恢复旧CPU BC路径。旧快照`baseRevision`复制有笔误，实际P提交为本文件头部HEAD；不静默改写旧快照伪造实验身份。

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

当前用户已授权E5最终集成，并要求E5闭合后提交，再分析和优化初始化性能（重点VG）。E5仍须按实际结果关闭，不以后台任务启动或少量通过代替完整验收；初始化优化不混入E5修复提交，不自动启动其它效果、HDR/神经压缩或有损几何精度变更。

## 12. 本轮P准备记录与后续实施结果

本节是唯一详细状态入口，后续E0–E5结果在本节追加，不另建status/progress。workstream只导航，不复制单元完成表。

### E2续作收口：2026-10-20新图片链与退休依赖

**结论：E2已提交为`4ee234cf`，E3本轮实现与最小检查完成，停在E4边界；不代表E5全路径通过，也不代表Spark生产分发许可或性能/质量资格已取得。** 本轮没有执行完整资产cook/recook、browser/GPU矩阵、整包部署或正式性能检查，旧失败/原始日志不改写。前两节施工检查点描述其当时事实，本节为本轮最新实施结果。

#### 唯一代码路径与职责

- 复核schema4 source/目录/owner索引→统一`CookedAssetPreparation/AssetWorkerPool`→image/exact lease→GPU assembly/Spark recorder→普通array及VT atlas/page table→Native、Surface、visibility/VSM exact alpha与query。完整resident链/protected tail由原scene owner有限隐藏批次准备后提交；正常frame VT编码沿现有command，不新增独立frame submit，不发布未初始化尾层。
- 删除退休`vendor/pc-texture` BC encoder、`vendor/tiled-zstd`、专用native/WASM构建、BC/Zstd工具及U0纹理build/encoder/browser/worker/report执行入口。只保留原始结果/失败与独立几何参考；不恢复旧产品parser、Worker纹理协议、A/B桥或CPU BC生产fallback。按设计保留VT调度/映射和当前几何V3独立owner，不误删未替换的几何模块。
- 只读libktx移至`vendor/image-ktx`并建立独立构建、完整许可树和原构建身份；原内部模块名保留。native canonical重采样从旧BC工具拆出，只调用原Pinned Basis tent滤波，无自写近似滤波或新BC encoder。离线recipe纳入canonical工具binary/receipt/wrapper身份；新AVIF仍从canonical而非旧BC反解生成。
- 材质实际compiled sample readMask决定精确alpha；冷导入只在本批次共享source/texture，不保留全局promise/整图RGBA replay，取消/异常关闭未发布source且不提交部分材质。成功source由CPU材质/场景持有，unload关闭，device replacement保留其encoded来源。raw/bitmap分配前拒绝超2048域，bitmap/编码输入转RGBA不经过premultiplied canvas，调用方bitmap不擅自关闭。浏览器实际颜色/透明RGB语义完整矩阵归E5，不把API选项当实证。
- 离线cook按live graph叶子生成产品，不因source存在未使用图片而保留无consumer输出；manifest区分source images与cookedImages。标准glTF的RGB仍可virtual，exact alpha独立resident，不因alpha读取把整张RGB强制降回resident。任意graph的alpha/UV依赖仍按真实closure要求resident，不省略通道。
- 移除普通纹理旧promotion/no-op调度和伪零成本字段，evidence schema8报告实际image encoder/上传；GraphicsContext总分配和临时池计入encoder RGBA、block/uniform/exact staging。冷输入导入另预留256MiB，KTX384MiB（96+64+64MiB可能同存的WASM heap及canonical/PNG临时项），Worker任务完成退休；默认共享temporary信用384MiB、encoded16MiB、ready64MiB，local replay另≤64MiB。这是保守accounting/准入，不是每任务常驻分配、性能改善或进程RSS上界。
- hello、Dungeon、Bistro加载/错误/销毁/evidence和静态nested image/exact资源路径改新合同；hello检查异步初始化/迟到source/geometry结果的销毁。playground只接受新schema组合，旧资产不作兼容。完整资产/manifest/静态HTTP部署仍由E5统一生成，阶段内示例资产尚非最终可发布资格。

#### 最小检查、原失败与未执行项

- 引擎`typecheck`和新鲜`build:test`通过；hello、Dungeon、Bistro相关TypeScript编译通过。首次示例检查发现退休minimumMip/tail/promotion evidence引用，修为mandatory/实际上传/完整resident readiness后重跑受影响编译通过，没有加兼容字段。改变的23个JS工具/检查入口通过`node --check`。
- 新产品/准备/material批次检查**10/10通过**，包含canonical工具身份改变recipe、真实Worker exact16-owner来源、aggregate admission、失败/cancel/retry/source retirement和材质批次去重/取消不发布/关闭source/分配前容量拒绝。普通/VT驻留最小结构检查**7/7通过**，覆盖mandatory未完成拒绝发布、query引用、成功/失败fence、query fairness、隐藏producer取消等待、NPOT完整父级闭包与encoder失败回收slot。结构fake GPU不冒称真实GPU质量/成本验证；日志`e2-final-targeted.log`、`e2-residency-final-small.log`。
- 新独立native resampler构建通过；17×9→8×4的linear、sRGB、normal三组与保留WASM逐字节一致，结果`checks/e2-native-resampler/result.json`。不是资产cook、多档码率搜索或全尺寸资格。KTX JS/WASM原构建收据逐字节核对；发现旧Git曾把JS从CRLF归一为LF，恢复收据对应原生成字节并加新目录`-text`，不改hash掩盖差异；未重建libktx或冒称新compiler字节等价。
- 本轮早期小检查18项中15通过/3失败，归fixture缺ResourceAccounting；之后VT fixture补GPUBufferUsage及真实1045宽父级交集后3/3通过，原`e2-clean-cut-small-tests.log`及后续失败日志均保留。未通过放宽算法容差、删生命周期断言或恢复旧ABI解决。原U0工具套件15/16的无关fixture失败继续保留，不重跑整套。
- 新fine-demand GPU oracle已改为primary和query-only独立fine页，必须先看到query页缺失再证明新需求抵达；原GPU consumer夹具迁至lossless image→真实新准备/encoder，registry补显式evaluation源路径。**本轮没有运行这些GPU oracle**；此前270组采样/9导入/24Native报告只属于当时源码，不能证明本轮新VideoFrame路径、query-only修改或最终质量已通过。全部采样/颜色/接缝/反馈/evict-reload/迟到IO/第三次重试失败/device loss矩阵仍明确归E5。
- 文档首轮17 findings为历史文档仍verifies已删工具/测试，已删失效依赖声明而非恢复旧实现；修后`docs-verify`为209 documents、0 findings、86 historical warnings。原失败日志`checks/e2-docs-initial.log`保留；收口复核与diff空白检查不替代实际集成。

Architecture review核对唯一生产owner/writer、完整层和精确面、输入/metadata/ready/GPU scratch容量、publication/abort/fence及退休依赖。Local NPOT逻辑滤波的最坏64次load与aligned hardware分支已记来源/成本，不伪称Spark/LibVT原样移植或“优化已达成”。Spark原完整kernel仍受显式local-evaluation范围约束；适用生产分发权必须在公开交付前解决，不能以实现收口越过许可。

### E2施工中：2026-10-20执行节奏纠正

- 用户要求停止当前施工并先调整流程。本次已停止尚在运行的Bistro完整cook及其本轮子进程；不继续实现、启动GPU oracle或全路径检查。未完成cook的目录不能当作最终部署产物。
- 源码核对：旧`TextureProduct.ts`、`TiledTextureProduct.ts`、`TiledTextureSource.ts`及旧texture cook/transport/cache/decoder生产入口已删除；新`ShadeTexture`、普通/VT residency以图片source为输入。未发现新旧纹理生产主链并联，但旧`vendor/pc-texture/basis_bc`、`vendor/tiled-zstd`、专用构建/历史可执行工具和部分测试/资产清理尚未完成，故E2不能称完成。
- 新路径确有独立canonical resampler及KTX冷输入解码；它们不等于旧产品兼容桥，但其来源/部署/依赖边界仍须按E2新owner清理。几何V3在E4前仍是该资产类别唯一当前owner，不是新几何ABI的兼容fallback；E4同切时删除，不在本次流程调整中盲删未替换模块。
- 此前hello和Dungeon完整recook及较多GPU检查已提前运行，属于执行节奏偏离，不据此要求重跑或追加前置全链验收。现有工作区改动/原始结果保留，不回滚、不冒称最终集成通过；最终资产和部署在E5按最终合同统一生成/核验。
- 后续E2以新代码完整接线、旧路径/专用依赖直接删除、设计对照及少量最小检查收口；完整cook、全部采样/反馈/生命周期组合、示例画面和报告归E5。本次仅调整流程，不自动跨入E3，也不提高来源adoption/质量/性能状态。
- 本次仅运行文档校验和diff空白检查，未新增cook/GPU执行。`git diff --check`通过；`docs-verify`返回24 findings、86 historical warnings（209 documents），当前输出为其它文档仍引用已删除的旧纹理文件。该失败按E2退休引用清理处理，不恢复旧文件、不扩展本次流程调整为全仓文档修复，也不冒称文档校验通过。

### 文档重构与E2检查点提交：2026-10-20

- 按用户“先重构文档，再提交代码”要求，重写执行顺序和阶段检查分工，消除E1/E2/E3/E4提前完整验收的条款；E5集中列出最终构建→cook/质量档搜索→manifest发布→部署→全路径语义/生命周期→成本报告。没有继续E2实现、启动cook或GPU检查。
- 旧纹理/VT设计与执行六篇标记为history，保留原始结果和失败；删除其已退休verifies依赖。现行roadmap/初始化导航及来源账本修正新owner引用，材质纹理域改写为当前源码事实，不再声称BC+Zstd旧链仍是生产实现。
- 本次提交保存当前E2代码/工具/检查和已经生成的hello AVIF资产，属于未完成施工检查点，不是E2完工。旧专用vendor/build/工具与部分测试/部署引用、evidence退休字段仍待清理；新增fine-demand oracle尚未运行，不能引用此前oracle结果冒称它通过。最终Bistro及playground等部署检查归E5。
- 既有检查结果保留：引擎、hello、Dungeon、Bistro相关typecheck通过；最近GPU报告`e2-residency-encoded-inputs.json`包含270组逻辑域采样、9种Web导入、24个Native样本及protected tail/cancel-retry，限当时源码与local-evaluation身份。此前定向测试18项中16通过、2项旧预期失败（exact默认resident和route常量48字节）；对应测试已按新合同修改，未重跑，不记为通过。未执行本检查点完整package build、最终全路径或正式性能验证。
- 文档重构后`node tools/docs-verify.mjs`为209 documents、0 findings、86 historical warnings；此前24 findings原日志保留，不改写为当时通过。`git diff --check`通过。提交前仅核对资源身份/依赖与暂存范围，不通过重跑完整测试拖住本轮文档交付。
- 提交静态核对：hello现有15产品/65 items、payload 6,565,667 B的目录/图片/geometry manifest身份一致，非新cook或全路径测试。新增两份生成JS/WASM及source.json在暂存区逐字节hash一致；`.gitattributes`保留生成资产及上游NOTICE原字节，避免CRLF归一化破坏构建身份。`docs-verify --staged`同为0 findings，`git diff --cached --check`通过。

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


### E3：离线选优与交付闭包（2026-10-20）

用户要求先提交再继续E3；E2已提交为`4ee234cf`。本节记录实现事实，不代表完整资产压缩率、最终画质或性能资格。

- `tools/extreme-web-asset/search/optimize`接入唯一scene Cook入口。High Q80/speed4、Extreme Q50/speed4原配置为首候选；有限Q={95,90,85,80,75,70,60,50,40,30}×speed={4,2}，resident20、VT60（cell128/256/512），完整枚举而非二分。全部维度不劣于同路线donor且硬语义通过才参与选小；donor硬语义失败拒绝发布。不回旧BC网络路径、不降尺寸、不删mip。
- `evaluation-host/gpu-evaluate/evaluation-input`在本地显式evaluation来源上，运行同一Worker解码、recorder、GPU mip/VT assembly和最终BC/R8 textureLoad；canonical losslessPNG取同recorder的pre-BC逻辑图。覆盖各mip、所有VT页和144²gutter；完整域逐32行读回落盘比对，不把AVIF解码指标当最终GPU指标。材质六方向探针复用原lighting BRDF；moment复用原appearance normal filter。该离线诊断有自己的submit/readback，runtime没有新增回读或frame submit。
- 颜色调用实际FFmpeg libavfilter SSIM；固定32行窗口、极小窗口边缘扩展到8²并按原像素加权，明确不是整图全窗口SSIM。normal统计P50/P95/P99/最大夹角，moment统计XYZ和长度，data/scalar各通道最大误差；全像素/全部gutter的最大误差、六探针最大材质误差及exact字节均参与。局部包装/直方图不是伪称上游移植，也不冒称六方向探针等价全部材质/照明场景；完整画面归E5。
- canonical、完整recipe/coverage/trace/module inventory、encoder二进制、argv生成器、target build、评价源码/FFmpeg二进制与版本、browser/device/features/limits共同绑定选优缓存。AVIF编码缓存另外绑定输入RGBA/尺寸/语义和去路径argv；缓存内容hash/长度先校验。GPU作业进程锁串行，异常退出锁需操作者核PID，不自动抢锁。候选工作目录只在`.local/extreme-web-asset/jobs`，最终仅拷贝选中产品并核hash；report按搜索/产品身份命名，scene receipt/manifest保存report SHA，再原子发布directory/manifest。
- `delivery`复用runtime同一Range规划。显式trace报告冷页请求/fetched/过取/decoded/assembly；无trace明确用目录+resident必需段+最坏单页依赖作为有界稀疏代理，同时保留全部payload，不虚构视角或LRU命中。`EENGINE_IMAGE_DEMAND_TRACES`指向按scene纹理key映射的trace JSON，pages每项包含plane/mip/x/y/priority。它不是实际首屏/完成时间；这两项待E5实测。
- `ImageTextureDelivery`已接统一准备链，不只是估算：最多256KiB、gap≤4096B、过取≤12.5%、同URI/object长度/urgency，仅合并本次已请求段，不等凑批。共享range与每item副本分别预收费；HTTP206/范围/长度/编码/流上界检查后，逐item仍由原Worker核SHA/AVIF。单对象仍按原有bounded fetch，不引入第二pool。
- decoded邻域LRU≤8MiB（双backing收费）归既有准备owner，命中不重复占原ready credit；每consumer独立lease共享不可变backing，最后引用释放，source退休使所有引用立即失效。source registration身份隔离同recipe不同generation；压力先逐LRU释放冷引用，存在credit waiter时不新增缓存引用；闲置5秒过期，取消批次清本批cache，source/session关闭全部退休。失败批次不能整体释放其它并发consumer仍持有的credit。
- 报告区分High/Extreme候选、donor/选中质量向量、编码墙时/缓存命中、目录/payload/exact/preview、trace fetched、module与总冷字节。`EENGINE_IMAGE_MODULE_INVENTORY`可提供实际部署的uri/sha256/fetchedBytes列表；未提供时module/总冷字节为null、显式未取得完整网络资格，不能填0。该模块税跨候选相同时不改变选优，但不得从最终成本报告遗漏；完整资产报告统一E5运行。

**Cost Card：** decoded缓存新增0..8MiB已收费CPU backing，零任务稳态无GPU作业；LRU查找按≤16个请求owner，idle timer每秒仅在有缓存时存在。Range新增最多每batch16×256KiB×2共享保守buffer预算，再计原item input/decoder/ready预算；无新GPU常驻分配、原assembly/BC工作量按实际页不变。收益0/50/100%对应重复需求不命中/半命中/全命中时0/半数/全部相关fetch+decode减少，命中仍需原上传/assembly/BC；Range没有可合并段则不增加请求或等待。离线搜索最多20/60个产品与全部域GPU评价，编码cache可少做相同输入编码，离线磁盘结果由操作者管理，不混入runtime内存。完整break-even/实测成本留E5，不声称已经提速。

**实际检查：** engine typecheck、build:test通过；`image-search.test.mjs`与`image-texture-preparation.test.mjs`共7项通过，覆盖有限非单调选优/坏结果拒绝、缓存环境与篡改/上界、Range urgency/过取/HTTP错误/取消、真实准备链pack一次Range供16-owner、decoded缓存不重复解码/收费与generation隔离、共享lease信用与source退休、原cancel/retry。串行`image-search-gpu.mjs`8×8颜色实际解码→完整mip→BC→材质/SSIM检查通过（这是评价器最小检查，不是20/60候选搜索）；receipt在`.local/extreme-web-asset/evaluator-smoke/receipt.json`。首次失败是评价器sRGB view继承了storage usage，已显式限定TEXTURE_BINDING后复跑通过；不改Spark算法或质量阈值。未跑完整资产Cook/recook、完整候选搜索、全部格式/GPU矩阵、部署、整场景质量/FPS与网络报告，统一E5；Spark生产分发许可仍未记录。

E3收口：新增/修改MJS均经`node --check`；`docs-verify`为209 documents、0 finding、86 historical warnings，`git diff --check`通过。


### E4：几何紧凑ABI与无损传输原子切换（2026-10-21）

**结论：E3已按用户要求提交为`9329af7d`；E4实现与阶段最小检查完成并提交为`f6398625`。以下是E4结束时记录；当时没有启动完整场景cook/recook、全路径GPU/部署/性能验收，不冒称E5通过。**

#### 唯一生产闭包

- 删除GeometryAbiV3/OegPackV3/scene-manifest-V3/旧decode模块，无alias、A/B、adapter展开或旧schema fallback。native/portable/pthread同用SoA4：OEGPACK4.0、scene-v4、Product schema3/binary3/profile4、Web ABI7、geometry Worker协议6。ordinary非Product几何既有owner未被误删，不是旧Product兼容路径；OGQ2 query section仍v3（字段语义未变）。部署consumer与validation入口迁新major，完整资产E5统一生成。
- position为F32 x[n]/y[n]/z[n]逐bit搬运，normal/tangent原oct16、UV原half2、color原RGBA8，optional独立stream。tangent尾流仅所有canonical/coarse W严格±1时用bit，否则保留SNORM16值；44B meshlet header包含U8 counts、U16 flags及原完整bounds/refine/material。triangle仍U8、corner/source primitive/source vertex/LOD remap不改序。JSON事实源生成C++/TS常量，WGSL直接引用；C++offsetof及generator --check核对。
- shared bank/目录/有效前缀direct write→visibility/hierarchy/软硬raster/Surface/VSM/shadow/query/picking/SCGI/motion均经共享reader直读新页，不存旧展开页或query精确顶点副本。Surface frame-cache分支补恢复vertexCount，避免SoA基址错误。GPU bank growth/epoch/abort、publication、generation及末读fence退休仍归原Residency/BytePool/QueryDirectory；不新增本帧readback或独立frame submit。
- Native writer复用完整Zstd1.5.7 revision `f8745da6ff1ad1e7bab384bd1f9d742439278e99`（BSD-3-Clause选项），逐页9/15/19有限比较，最小合法frame严格小于raw才选。encoded≤256KiB，decoded恰256KiB；checksum、content size、window≤256KiB、dictID0、单frame终止严格受检。旧raw-threshold CLI/recipe字段退休，ABI7 word76为受检零reserved。CPU/WASM使用完整上游decoder，无自制熵或精简近似。
- Runtime decoder懒加载、固定4MiB heap/256KiB静态context，HTTP依赖流式上界及WASM hash校验；所有后续geometry/image/import成功/失败回执上报实际retained0/4MiB。默认temporary400MiB，最多4Worker预留16MiB，task至少384MiB保留原KTX冷导入容量；显式不足预算创建前失败。不是每任务分配400MiB或RSS上界。Vite静态URL和Worker/root双入口保留manifest/WASM为独立可核hash资源，避免动态glob将二进制错误导入/内联。
- source/build/hash覆盖native本地receipt、portable/pthread成对JS/WASM receipt与decoderreceipt，记录实际compiler/cache/参数/源码/产物；donor原字节及许可证保留，Node/CMake都核来源hash。来源账本明确Local布局适配与Adopt完整CPU codec，尚未宣称新GPU采用/性能资格。

#### Cost Card与边界

- 每meshlet header48→44，固定节省4B（8.33% header，不是整包）；position仍12B/vertex，无量化损失。全optional旧32B/vertex→sign bit档约28.125B/vertex（另≤3B meshlet尾对齐），非sign档30B/vertex；只有position/normal仍16B。padding/分组/LOD acceptance按真实或保守上界bytes计费，真实节省看E5。
- GPU原bank direct读取；position三个stream、属性各4B顺序load，sign每顶点一次bit或u16读取，无新dispatch/pipeline/barrier/atomics/长期position副本，query仍共享；地址计算新增vertexCount乘法，缓存恢复一标量。CPU增加Zstd完整解压及最多16MiB retained heap，输入/输出/ready依原credit有界；offline最多三次完整Zstd encode及有限scratch，不算runtime成本。压缩率/延迟/显存收益未测，不用算法名字或测试通过宣称提速。

#### 实际检查、原失败与未运行

- native CLI、独立C++ ABI oracle、portable/pthread及固定heap decoder均构建通过；TypeScript typecheck、新鲜build:test和package build通过。C++ oracle新增实际producer的F32 signed-zero/大平移bit保真、±1 bit与非sign SNORM16精确字节，保留原position seam/bounds/LOD/page capacity/两阶段/remap检查。pthread本轮仅编译和receipt核对，没有冒称浏览器多线程执行通过。
- 定向8文件37项通过：布局optional/sign/corruption、44B header、Surface缓存接线、Product binary3/profile4及负例、query精确cut/remap/bounds、Web ABI7、portable真实producer→新reader、source/buildhash、Worker真实transfer/cancel/重注册/信用及图片缓存。冷布局6项、极小Native glTF instance/recipe/scene-v4拒旧语义1项另通过；不是完整场景recook或组合生命周期验收。日志`e4-focused-final.log`、`e4-cold-layout.log`、`e4-native-small.log`，位于`.local/extreme-web-asset/`。
- 独立Zstd native三档最小选择/raw不膨胀→实际TS loader/hash/WASM完整decoder四次逐字节往返，十个invalid frame/extent拒绝（checksum、串联、trailing、unknown size、无checksum、截断、错误decoded/encoded上界），固定4MiB检查通过；`e4-zstd-final.log`。不是浏览器吞吐/大资产压缩率结论。
- 失败保留：初次旧oracle要求interleaved positionEncoding/旧ABI golden，迁新encoding与逐字节SoA断言；Product binary旧golden首次24/25，新header3/profile4/SoA字段独立断言后更新新fixture SHA；CWD误用导致一次命令未执行，正确cwd重跑。原失败日志不覆盖；不改容差、不删精度/lifecycle断言或恢复旧路径。docs初次1finding为历史V5 verifies已删V3文件，删除失效声明，不恢复文件。
- package build后静态检查发现动态URL会将codec目录变成glob/内联资源，改静态URL并接现有Vite asset插件；重新构建核独立manifest/WASM bytes，不以能build代替部署可加载性。既有Emscripten/node:module externalization、WASM_BIGINT/MAXIMUM_MEMORY和donor unused警告如实保留。
- E4结束时留给E5（现已授权）：全部示例/资产统一cook、完整有限质量档搜索与原子manifest/HTTP发布；全部production GPU/颜色/接缝/反馈/query/motion/VSM、growth/abort/retry/device-loss/unload组合、来源许可（Spark生产分发权仍未记录）、尺寸/内存显存/网络/延迟与同条件成本报告。未运行项不能追认为通过，旧失败与baseline golden不会因新major自动追认为修复。

收口复核：最终typecheck、build:test、package build与Zstd loader往返通过；dist独立geometry-zstd manifest/WASM逐字节hash一致。`docs-verify`为209 documents、0 findings、86 historical warnings；`git diff --check`通过。validation registry首次重建因旧workloadId失败，迁移新major workload后重建成功（11 cases），未执行browser case；原失败日志保留。

### E5：最终集成实施记录（2026-10-21，进行中）

**E5尚未完成；已提交检查点`25c813c0`及加载优化`5b560a1d`，不是最终验收提交。** 本节只记录已运行事实；Dungeon/Bistro双质量档、playground、完整部署/组合与成本报告未齐，不因hello画面正常或局部oracle通过而关闭E5。GPU作业串行；长时间cook不与browser/oracle同时运行。按用户后续继续授权，加载优化已先行完成，其结果单独记录，不替代E5矩阵。

#### 已修复的真实闭包错误

- `virtual_geometry_work`仍使用48B meshlet stride及旧U16 counts，导致新44B/U8页面的camera/shadow work无合法输出；改为直接引用SoA4布局事实源及字段位移。新增生成WGSL回归断言；不改层次/LOD/精度、容量或裁剪算法。首次hello“就绪”但模型空白、product winners为空及shadow invalid-cut原失败日志保留，修复后实际模型显示、预算驻留与shadow生产链通过。
- Worker/WASM共享Vite URL插件原在dev调用build专用`emitFile`，导致Zstd URL为undefined；限定`apply: build`，dev使用正常Vite源码URL，静态构建保留独立manifest/WASM。不是增加旧decoder fallback。
- 完整scene根现在引用不可变geometry manifest、image directory、receipt和search report，依赖核验/复制后最后原子替换唯一可变根。部署publisher拒绝immutable冲突、损坏/越界payload、错receipt、缺失完整20/60候选报告；静态插件只打包最终闭包。hello目录移除65个不再被该闭包引用的旧生成文件，保留全部最终依赖，不保留旧ABI供兼容。
- offline评价F32回传改精确字节/base64，仍逐32行覆盖全部像素/探针；canonical磁盘参考按完整recipe/cell分别缓存，至多3个；FFmpeg SSIM只批量摊薄进程启动，各独立窗口/小窗口扩边/像素权重不变。独立bit-preserving与逐窗口旧调用对照通过，不降低候选数、质量门限、normal/ORM或exact断言。

#### 实际检查与用例迁移

- engine typecheck、新鲜build:test、package build，以及hello静态构建通过。新metric/publisher/meshlet回归共9项通过，publisher加强receipt核验后2项复跑通过；此前47项定向闭包、真实Zstd与源corpus结果按原日志保留，不反复当作新运行计数。
- 真实GPU通过：`image-texture-transcode`及f16（完整donor、颜色/alpha/目标和取消/损坏/OOM/loss）；`image-texture-page`及f16（各18页、16-owner、NPOT/address、432重叠块、exact与压力）；`image-texture-residency`（270独立logical采样、9导入、24 Native sample、primary与query-only fine demand）；`scgi-query-vt`、`scgi-query`；`geometry-budgeted-residency`、`geometry-shadow-view`；`native-surface-product-production`、`native-surface-multi-product-production`及`geometry-product-scale`（19组）。原失败单独保留；上述通过只覆盖各实际输入和设备，不自动等于整场景或跨设备性能资格。
- E3有界decoded LRU有意保留信用，旧测试“提交后所有信用为0”迁成`total=ready=decoded cache bytes, encoded=0`，source/session关闭后必须全归零；不删图像/donor/生命周期断言。multi-product独立query在Renderer普通帧后通过同一native publication owner准备/提交自己的投影需求，避免被GI-off帧重置；不改Renderer的feature-demand规则。
- 独立validation宿主`texture-residency-component`真实通过，artifact为`.local/validation/2026-10-20T19-31-45-255Z-texture-residency-component-05dace48-3166-4df1-bcb1-13559eb62e32/`，明确为diagnostic-only。首次失败漏`residency.prepare()`已补正确异步准备；依赖扫描中的retired V3 URL helper直接迁V4。完整Dungeon宿主已迁新产品，保留1920×1080、原场景/25张2K纹理、30warmup/120普通+120profile样本、运动/resize/recovery/卸载断言；等待VG与VT真实view-settled，不用两帧或FullMipCode冒充fine-demand收敛。该完整case尚未运行。

#### hello完整High与部署观察

- source SHA256 `fe5873882034b3071fab964d72b58f8184b8a86f8b20dc539dfb8da75f0227be`、295600三角形/5实例/15纹理不变，普通非VT，VSM/HDR设置未改。完成300个候选，纹理payload 12873120B、directory 60571B（115 AVIF+55 raw exact item）；几何15543856B/102页，完整部署闭包218文件/29101659B（含非runtime报告/receipt）。编码搜索墙时约6413.6秒，不是运行时加载时长。旧选样纹理21092132B/几何18026400B不是完整网络基线，不能据此承诺FPS或整体网络下降比例。
- 完整包核验、不可变发布、dev画面、真实静态HTTP画面通过，无页面/GPU错误。静态build不公开分发evaluation kernels，测试由单独本地只读evaluation挂载提供。Spark仍未记录生产分发授权，不提升adoption或把静态包称作无需配置即可公开部署。
- 单个独立Chrome profile的1280×720限速观察：100Mbps/10ms冷缓存UI就绪12542ms，暖缓存6142ms；10Mbps/40ms冷缓存38993ms。UI就绪不是首个完成GPU帧；每档仅1样本，不是P50/P95或初始化性能资格。画面截图已人工检查。
- **网络初稿有明确测量缺口：**page CDP只统计主target，看到冷约16142687B（modules9022929、HDR1398087、metadata23665、texture directories64961、geometry5536966、evaluation kernels96079），没有覆盖Dedicated Worker中的图片/payload/decoder请求，不能称完整冷网络字节。暖缓存geometry Range仍约5536966B也只是该观测范围。后续需含Worker target的实际请求/bytes/module inventory，不能将图片payload缺失解释成只下载目录即可渲染。原观察文件保留，不能回写成完整口径。

#### 正在执行与未关闭项

- Dungeon High VT完整25纹理/1500候选曾在`.local/extreme-web-asset/e5-dungeon-high`执行，日志`e5-dungeon-high.log`；2026-10-21为优先处理用户当前加载优化请求，中止本次未完成cook，保留编码/评价缓存与原日志，未发布半成品。中止时首图完成18/60候选，25图完整搜索未完成。完整几何已生成：72137三角形、798源primitives、1187页；没有发布未完成图片目录。单候选native AVIF高effort及全域GPU评价为分钟级，当前不能承诺整个矩阵很快完成，也不删候选规避耗时。
- hello Extreme、Dungeon Extreme、Bistro High/Extreme、完整playground发布、完整Dungeon validation、Worker-inclusive HTTP/冷暖与网络/启动/内存显存/steady-state成本矩阵仍未关闭。前述local GPU/语义检查不能替代这些结果。Spark许可边界保持本地evaluation；公开生产分发需要调用方合法授权配置。
- 初始化源码预审已定位待实测候选：GraphicsContext无条件加载vec1/2/3 STBN与split-sum；hello初始化之后才关闭FSR/bloom；HDR→目录→VG activation cut→材质准备有串行等待，现有prepared-material token可用于保持单一事务下重叠；VG根页按64页批次准备/逐页发布。它们目前只是候选，尚未修改生产行为，不据静态分析声称已经提速。

### E5检查点与加载优化（2026-10-21）

`25c813c0`仅保存已验证集成修复及hello High产物，不代表E5完成；Dungeon/Bistro/Extreme及完整验收仍未关闭。根据用户反复强调初始化/VG加载性能，本轮优先进行独立加载优化，不启动其它效果模块、不缩场景/尺寸/mip/选优域。

**实际改变：** GraphicsContext不再等待无内部consumer的导出静态catalog（STBN vec1/2/3与split-sum）；VSM、SSSR等保留其真实owner加载。VG材质准备只编译Product顶点profile，不再同时编译ordinary的5个PSO。hello在initialize之前设置原有FSR/bloom/HZB关闭值，不改变效果选择；HDR和catalog/VG目录读取并行，真实schema/hash/完整元数据检查保持。ProductSceneOptions接一次性PreparedSceneMaterials，在现有GPU Render World单事务验证实际材料/profile再消费，admission失败取消token，提交前检查abort。两个受统一credit约束的纹理CPU读取槽与现有串行hidden GPU batch重叠；失败取消兄弟任务、等待清理，迟到lease不再提交。没有增加GPU并行scratch、帧submit、第二Worker pool或兼容owner。环境图增加HTTP状态与AbortSignal检查。

**Cost Card：** 删除无consumer约6.3MB响应/CPU静态图和ordinary的5个无用编译；零新增常驻GPU产品/稳定帧dispatch。两个CPU槽而非全场景prefetch，最多两个正在消费的完整item/VT邻域；总encoded/decoded/ready信用及原容量上界不增加，实际峰值可能在既有预算内升高，不宣称RSS更低。单item峰值仍为2×encoded+4×decoded；GPU scratch仍串行持有至fence。0/50/100%可重叠IO对应零/部分/全部相关IO隐藏，质量工作不减少，单item/信用压力下收益可为零；无新增帧热路径队列。hello两份观测首帧均约124377154B已注册GPU分配（不是驱动VRAM/RSS），不宣称显存改善。简单调度/胶水为Local；Spark、AVIF和几何算法不改、不冒称新移植。

**测量口径：** 同Chrome155、本机硬件、1280×720、完整hello High固定场景，静态HTTP服务器对全部response body（含Dedicated Worker）共享100Mbps/10ms节流；不含TLS/header，未压缩JS、非公网/CDN benchmark。冷/暖各3次，首个queue完成帧与原有SceneRefinement.view-settled分别计时；不把粗层首帧冒充精细模型完成。baseline使用25c813c0源码隔离构建，仅加同一收敛观测，不切换工作区或恢复旧production owner。完整报告/请求hash在.local/extreme-web-asset/loading-{baseline-settled,optimized-settled}.json；截图检查收敛完整模型，原首帧粗层截图亦保留。数值由实际报告更新，不将3样本宣称正式P50/P95性能资格。

**实测结果与检查：** 冷启动首个完成帧中位24286→11357ms（约53.2%更短），当前视角目标收敛25061→12007ms（约52.1%）；暖启动首帧9069→5901ms（约34.9%），收敛9774→6693ms（约31.5%）。全部响应body冷31351219→25043003B，减少6308216B（约20.1%）；暖两边7750387B，几何完整收敛Range同为7750387B，未减少必需几何。非JS/HTML共享资源含纹理/几何的响应hash一致。首帧pipeline completed57→41，active/queued/failed均0。hello提示区分基础层发布与view-settled完整目标，不提前报完整就绪。

12项直接CPU检查通过，覆盖两个读取槽、同任务不重复、失败取消/等待清理、迟到lease不record、顶点profile、材质准备和统一信用/Range生命周期。真实GPU串行image-texture-residency通过；native-surface-product-production新增initial provider失败取消token、重新prepare、真实消费/退休检查，并保留原winner/HDR/Temporal/abort/resize/device-recovery断言，最终passed。该oracle预期注入empty replacement abort在pageErrors保留，属于已断言负控制，不是hello页面错误；最初运行遇到stale test build后新鲜构建重跑，原文件保留。新CPU夹具初次缺features/ChangeSignal已修夹具，未改生产降级。engine typecheck/build:test、hello typecheck/static build通过，docs-verify为209documents/0finding/86historicalwarnings。完整E5场景矩阵仍未完成，不因加载优化实测提升最终验收/生产许可资格。

### E5继续：离线全量任务调度与容量修复（2026-10-21）

**范围：** 继续最终集成，不重新选路线。当前全量任务最慢部分为原生AVIF编码和完整GPU评价。保留全部20/60候选、源尺寸/mip、原生flags、最终BC真实采样、六组BRDF probe、F32精度、原32行SSIM独立窗口及原顺序累计；未将局部结果外推为整场景完成。以下胶水/调度为Local，原生codec、Spark内核及BRDF不改，不称新算法移植。

- `ImageTextureCook`预先分配稳定item ID，按原mip/y/x顺序写最终目录；离线sink启用有界并发，默认最多8个独立AVIF子进程，每个仍为原`-j 2`。通用sink默认1，显式上限16；失败停止派发并等待已启动工作清理后拒绝，不发布目录。native相同输入去重正在执行的编码，相同payload只落盘一次，修复Windows并发rename冲突；子进程错误/诊断超限也等close才结束。缓存命中携带原实际argv/status/stdout/stderr，不能凭缓存捏造一次新编码。
- GPU→离线host只批量搬运原始F32/base64 stripe，最多16条/16MiB并await回压（容纳完整2048宽×32行约9.79MB wire stripe，不拆SSIM窗口），不合并逻辑窗口或降低精度。SSIM暂存最多64个独立窗口/8MiB RGB帧，按相同尺寸调用原FFmpeg滤镜，分数恢复原到达顺序累计；144×144页尾16行不再迫使每页反复启动进程。GPU作业仍串行，不改runtime帧提交或增加GPU并行scratch。
- 原canonical F32参考约0.8GB/2K纹理/cell布局，不能跨405图无限保留。成功图的最终payload、目录、search report及每候选content-addressed原生命令日志先保留；清除evaluator对应引用后，校验直属UUID/realpath的本任务scratch才递归退休。原生PNG/AVIF临时文件在编码、校验及缓存成功后逐项释放；失败输入/日志保留，不删除历史失败现场。最终publisher仍只复制运行时完整闭包，不把scratch或每候选命令文件当运行时下载依赖。

**Cost Card：** 新增仅离线CPU并发和元数据job数组（全部plane最多65536个item）；最多8个正在处理的RGBA cell/native encoder，codec内部实际RSS仍需独立观测，不能由该数量宣称精确内存上界。SSIM RGB帧池8MiB，FFmpeg输入拼接最多另8MiB，不含codec内部；wire字符串16MiB，不含CDP/browser内部复制和解码F32暂存。0/50/100%可重叠编码工作对应零/部分/全部该部分延迟隐藏，磁盘/codec竞争可能抵消收益，不宣称线性8倍。无新增runtime GPU bytes/ALU/sample/dispatch，全部GPU评价域仍执行；任务成功释放scratch减少累计磁盘占用，不证明运行时内存/显存下降。

**实际检查：** engine typecheck、新鲜build:test和package build通过，Dungeon/Bistro typecheck通过。最终定向22项通过（含完整2048宽stripe容量/精确F32、wire batch回压）（`e5-cook-final-tests.log`），另11项真实Worker/准备/初始化重叠生命周期检查通过（`e5-resume-worker-lifecycle.log`）。原生512→1全mip/128-cell对照28items，串行/并发8目录与每payload hash一致，最终目录sha256为`a880f3be1b281dff8febf8cc6830d90575c19e30021550a3330c270f34f12f8f`；该对照第二次运行含磁盘缓存，时间不作编码加速证据。最初Windows EPERM失败保留，修复后对照通过。

同80个原SSIM窗口，旧尺寸切换批次32次FFmpeg/15779ms，新批次4次/2131ms，逐分数及顺序一致（`e5-ssim-scheduling-cost.json`）；只证明此离线CPU步骤，不代表全cook加速7.4倍。真实GPU小输入完成全部20候选、选中硬语义、相同输入cache retry/目录逐字节一致、两次任务均退休scratch，结果`e5-search-retirement-gpu.json`；该输入是工具生命周期检查，不代替完整场景。

**完整资产事实与剩余：** Bistro当前离线`parseGltfMaterial`+canonical graph实读405源图/132材质全部映射，132albedo、132normal、131specular-color、10emissive，无漏图（`e5-bistro-source-mapping.json`）；raw WebCook importer的既有specular缺口仍单列，不伪称已修。两个集成示例状态文字和Dungeon重cook/发布说明移除已退休CPU BC描述，Spark继续显式kernel scope，不提升分发资格。

Dungeon High全量25图/1500候选已用最终工具恢复，日志`e5-dungeon-high-capacity.log`；完整新几何复用校验成功。较早`e5-dungeon-high-resume.log`、`e5-dungeon-high-grouped.log`及`e5-dungeon-high-final.log`保留中止原因/已完成候选，工具/评价身份变化不伪复用旧cache。后续同一串行作业链仅在cook成功后执行verify→原子发布→独立`texture-compression-acceptance`→playground生成，任何失败停止；运行中的任务和已排定步骤不能计为passed。hello Extreme、Dungeon Extreme、Bistro High/Extreme及§8完整部署/生命周期/质量/粗成本仍需实际完成，E5保持进行中。

**Bistro完整几何新增结果：** 使用当前原生Cooker重新读取完整源buffer的分材质geometry描述，2线程/64MiB分片，生成`.local/extreme-web-asset/e5-bistro-geometry`，不是使用旧ABI包。保留2829226三角形/1591实例/1513唯一资产，4个最终pack共204392059B、6040页；四pack原生`validate`及当前TypeScript V4 reader核验均通过（`e5-bistro-geometry-{native,native-validate,verify}.log`）。Cooker报告123227ms/peakWorkingBytes1780305920，uniqueGeometryBytes241925184，bootstrapGeometryBytes4809728；没有GPU并发任务，该CPU几何步骤与Dungeon评价重叠，时间不是独占benchmark。compressedPageBytes134591355只统计压缩页，不能把其0.0850042相对padded decodedBytes的比例当整pack压缩率；完整pack还有索引/元数据/未压缩bootstrap。该结果不提升Bistro图片、材质画面或整场景生命周期资格，尚未发布半份场景。

进一步逐页运行当前production `openOegPackV4.readPage`和原WASM decoder：Bistro全部6040页均解压、CRC/完整decoded SHA及结构校验通过，decoded共1583349760B分批释放，并非同时驻留（`e5-bistro-geometry-all-pages.json`）。另用源GLB POSITION/index独立构建保留绕序的三角形F32位模式多重集，与新包全部LOD0 leaf按scene实例倍数还原后比对；Bistro2829226、Dungeon72137、hello295600三角形均精确匹配且剩余0（`e5-{bistro,dungeon,hello}-geometry-source-exact*.{json,log}`）。每个位置分量按u32位模式比较，不用浮点容差，也不以同decoder自往返当source expected；检查不证明UV/normal、transform或GPU reader质量。最初Bistro诊断脚本按唯一资产而非1591实例计数，得到2796810并失败；修正脚本按manifest实例倍数后通过，原日志保留，未修改生产几何或放宽断言。该source multiset检查只针对上述完整固定源，Node helper未定义test条目，不能把输出的0tests计成额外contract测试数。
