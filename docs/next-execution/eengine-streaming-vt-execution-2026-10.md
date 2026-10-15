---
id: eengine-streaming-vt-execution-2026-10
state: current
verifies:
  files:
    - docs/next-design/eengine-streaming-vt-2026-10.md
    - docs/porting/next-renderer.md
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - OEngine/src/assets
    - OEngine/src/gpu
    - OEngine/src/shaders/native_material.ts
    - OEngine/src/shaders/native_surface.ts
    - OEngine/src/shaders/native_execution_bins.ts
    - OEngine/src/render/program
    - OEngine/src/render/surface
    - OEngine/src/render/SceneRefinement.ts
    - OEngine/tools/cook-offline-scene.mjs
    - OEngine/tests
    - examples/demos/14-integrated
    - tools/gpu-oracle.mjs
    - tools/gpu-oracle/registry.mjs
---

# Streaming VT 执行：产品闭包、生产切换、集中验收

唯一设计为 [Streaming VT](../next-design/eengine-streaming-vt-2026-10.md)。2026-10-16 起点 `4a52d400`；用户在细设计之后授权完成**VT-1**，本轮结束停在VT-2之前。本文是唯一细单元状态和实施结果入口；粗路线/workstream只负责模块导航，不复制下表状态。

## 1. 工程量与执行单元

| 单元 | 状态 | 实际工程量与稳定边界 |
|---|---|---|
| VT-1 产品与异步读页闭包 | 已完成，结果见§6 | 中等：tiled格式/冷cook、目录/range/shard、Worker任务/校验/信用/取消与CPU缓存完整连通；生产仍原路径，没有假VT |
| VT-2 GPU与全部生产consumer原子切换 | 待实施 | **最大单元**：页池/页表/尾部、完整过滤、反馈/调度/事务、Native publication合并与全部consumer、coverage、bootstrap与收敛一次接通；结束时唯一生产ownership |
| VT-3 集中验证、修复与文档核对 | 待实施 | 运行已连通模块的完整必要检查与真实完整场景，修复局部根因、重跑受影响项，更新事实/Source Map/成本，停在下一模块边界 |

三个单元是工程闭包，不是等量任务，也不是把复杂模块压成三处改动。VT-2 内部可连续实施多个文件/算法阶段、临时断链；不能为了“先完成一个小步骤”先让生产走缺反馈/缺回收/缺coverage的VT。开发中不按每个小patch重复benchmark或全场景。

## 2. VT-1：完整产品、Cooker与有界Provider

### 完成内容

1. 固定 LibVT/Wicked/Intel revision、license、原文件函数和移植映射；保存必要原算法最小 reference fixture/notice。先读完整相关函数和有效分支，不从本文描述反向自写核心算法。Hork只交叉参考，不声称移植其POT页表。
2. 在 `assets` 明确 tiled directory/provider/payload 类型与验证身份；完整 `TextureProduct` 验证不变。实现真实 mip/NPOT/矩形、plane语义、range/hash、tile/address recipe、tail至1×1和mandatory resident引用；全部偏移/长度/算术/容量先验证。
3. 扩展现有 offline cooker：128 interior+8 border，144物理tile；tail从≤64开始单slot打包。保留现有BC/normal/mip recipe；内块可复制，边界/小mip按源mip及地址模式离线编码，完整记录cache key。验证repeat/mirror/clamp及末行/列，不在运行期转码。
4. 扩展 `CookedAssetPreparation/Protocol/Credit`：目录注册、tile batch、range/shard、逐tile hash、credit before fetch、session/task/epoch、取消/worker crash/transfer；CPU缓存有界且可重新读取。HTTP206核对严格，不支持range不得全包预载。
5. 接通“请求一个真实tile→Worker读校验→主线程接receipt→持有/释放ready credit”的CPU闭包。新目录可单独打开；不等待所有tile、不保留全细页replay。现有完整resident assets仍合法；尚不切换生产scene。

### 本单元轻检查

只跑受影响typecheck和一个小的CPU格式/读页集合，覆盖：

- 独立手算的BC block/row pitch、NPOT/矩形/tail布局、地址gutter、目录与chunk身份。
- 截断/重叠/错误hash/range版本变化/返回200/shard替代的输入处理。
- 一次真实Worker batch及cancel/retry/迟到receipt，信用释放和缓存上界。

不跑完整Bistro/Dungeon、全Renderer GPU矩阵、长性能测试或全库反复build。只验证实际产品合同，不为glue写逐行镜像测试。退出标准是冷数据与提供者完整可信，**不宣称VT已生产接入或性能改善**。

## 3. VT-2：完整GPU与生产切换

### 按依赖连续实现

| 工作包 | 生产闭包要求 |
|---|---|
| A. Native publication与能力 | 合并主constants/directory为一个raw-u32 publication，原32B entry和f32 bits不变；原子更新SurfaceV4、NativeExecutionBins、两个shader及全部直接consumer/cache key；raster独立。最宽SSSR组合15+1反馈=16 SSBO、4 storage textures，完整sampled union在创建前协商 |
| B. 资源与事务 | VT逻辑generation/metadata、format atlas、pinned tail、integer page table、budget/accounting、候选/提交/abort/重试/退役、旧新对象同时峰值；CPU目录/provider/device epoch与GPU分离 |
| C. 完整核心采样 | 移植LibVT梯度/LOD/缺页查找，组合Wicked双mip；真实尺寸、NPOT、nearest/linear、8×RGB、gutter、tail至1×1、sRGB/BC4/normal全闭合；无临时“先bilinear、以后anisotropic”生产替代 |
| D. 反馈与调度 | 所有实际Native C/X/Y/custom graph查询；单SSBO三bitsets+首命中append、overflow可恢复；三slot延迟map。移植Intel desired/pending/resident/eviction/rescue与粗层闭包；Worker/CPU/GPU信用、LRU、staging/copy/frame预算、防thrash与late结果 |
| E. coverage与原生route | 用现有图裁剪提取完整alpha依赖；R8及参与alpha/UV的其他planes保持resident；Main/VSM/Surface使用同一coverage值。完整物理bank union进入Native programs/bins，无按材质实例绘制或每tile重编 |
| F. 主图与初始化 | 正常帧payload→mapping→Surface→feedback copy，真实FrameGraph读写、唯一submit；`cooked-scene`目录+tail+mandatory后发布，细页不在全量textureReady前置；别名、预编译、geometry发布及VSM事务保持连通 |
| G. 收敛、诊断与删除 | SceneRefinement按新鲜view需求观察complete/limited/failed，两次最后发布后确认；tile不改content/Temporal/VSM identity；暴露budget/miss/actualmip/pressure/overflow/fetched bytes。删除选中planes旧整纹理分配/promote/全payload等待/全replay依赖 |

这些工作包不是七个单独的生产里程碑。执行时沿实际依赖推进，B/C/D可在单元内部反复接线；稳定边界必须A–G全部闭合，不能留下两套可选production owner或测试专用fallback。

### 开发检查与单元复核

按需要typecheck、实际shader compile和小CPU/GPU算法oracle，验证正在改的高风险数学/绑定/生命周期；发生真实失败立即定位。**不每个工作包跑全库测试、完整场景、长帧率统计。** 昂贵验证集中VT-3，进入前先修复真实编译错误并进行一次architecture review：

- 每个producer的产品、全部directconsumer、绑定、reset/capacity/overflow/retirement是否清楚？
- 16 SSBO / 4 storage textures与完整sampled textures是否实际成立？
- 两个virtual mip、所有真实query、fine缺页、1×1 tail、NPOT、coverage闭包是否都处理？
- payload未完成、abort、旧帧reader、迟到反馈、slot重用、release/loss/reload是否无竞态？
- 是否已删除选中tiled planes的整包前置、整extent分配与全量replay？是否有静默降质量/漏请求？
- VT residency是否仅更新实际页位置，不逐页重编/重建VSM/清Temporal？是否仍只在正常帧submit？

退出标准是唯一生产闭包可运行，所有必需验证列入VT-3；未跑GPU/画面/资源成本必须明确待验证，不能提前标模块完成。

## 4. VT-3：集中验收与局部返工

### 4.1 运行顺序与规模

源码闭包稳定后集中执行一次，后续只因真实改动/失败重跑受影响项。GPU作业串行：

1. architecture/source review；`npm --prefix OEngine run typecheck`、`npm --prefix OEngine run build`、**新鲜** `npm --prefix OEngine run build:test`。以新build执行Node测试；最终统一跑现有Node集合，不能用旧`.test-dist`。`build`含tsc，可据当时脚本合并重复编译，勿为了表格机械重复。
2. CPU格式/Worker/scheduler与publication生命周期集合；独立源reference→本地CPU/WGSL算法差分；小真实GPU过滤/边界/feedback/事务oracle。
3. 真实Native主链接线与有代表性的组合：AO/SSSR开关，Native/FSR/bypass，ordinary/Product、direct/compact、opaque/MASK/custom-alpha。按资源最宽/数学不同路径挑最小覆盖集，不做所有开关笛卡尔积。
4. **完整Bistro与Dungeon**的冷启动、静止精化、镜头移动、回访与容量压力；RTX2060实际设备/adapter/浏览器/冷暖cache/分辨率/feature settings固定记录。完整最终场景不缩减；诊断可用小图案，但不能替代真实场景。
5. 粗粒度成本和同时峰值，逐项对照设计与全部直接consumer；更新唯一执行结果、porting和已实现domains，运行docs检查，再闭合。

无需在本模块搭重型通用benchmark/proof系统，不要求正式全Renderer P50/P95/4GB资格先通过；也不省略当前VT的真实GPU、完整场景和必要成本。人工可理解的小序列/固定图案足够时不做数百帧大矩阵。

### 4.2 必需语义与独立预期

| 集合 | 最小有效证据 |
|---|---|
| 来源与算法 | pin/原文/notice；独立保留的LibVT LOD/梯度/lookup、Wicked双mip、Intel状态转换预期；源有效分支本地映射无漏项，记录NPOT/显式导数/单队列适配，不冒称bit-exact整个donor |
| 过滤/颜色/normal | 高频/斜视/页角、负UV、repeat/mirror/clamp、放大/缩小/零梯度、不同长宽/NPOT/末页、双mip过渡、缺页到tail至1×1；BC7 sRGB/linear、BC4通道、normal向量与8× footprint。resident独立参考只在测试使用 |
| 图与coverage | texture-driven UV、多纹理参与alpha、RGB参与alpha、R8-only alpha+virtual RGB、C/X/Y查询；Main/VSM coverage与winner一致，VT精化不错误触发VSM重绘/Temporal identity重置 |
| 反馈完整性 | 重复页只append一次、同页wanted+used保留、所有实际query与两mip、故意小队列overflow→bitset恢复、满readback ring/延迟map freshness；无永久漏页或假settled |
| 调度/输入/生命周期 | 新旧view、粗层优先、pending撤销/eviction rescue、hash失败、网络/range错误、Worker crash/retry、release/replacement迟到任务、encoded abort→retry、提交后loss→reload、旧consumer fence及slotgeneration |
| 能力与容量 | 最宽SSSR Surface compile/真实dispatch；sampled完整union、BC/尺寸/layers/maxbinding/maxbuffer创建前拒绝；tail/mandatory不足明确失败，working-set超池明确limited，无身份截断 |
| 主链结果 | 新鲜Native Surface直接消费新tile、SSR/AO和颜色/Seed输出真实有效；开关/resize/cut/普通motion/FSR切换；实际场景无需全场细页即可展示并在可满足工作集下收敛 |

数值容差来自源算法、BC块编码变化、WGSL/硬件过滤边界，先定义预期再比较；不宽容差/吞异常/跳断言/换低质量profile。原Product normal GPU失败已在INIT独立复现于`419d7a28`，保留原失败，按baseline/本轮回归分类；新的VT normal数学不因旧失败免验。来源差分通过也不能代替真正production GPU消费。

### 4.3 性能与初始化记录

用同质量、同内容/视角、同分辨率/功能组合记录原路径既有基线与本轮结果，区分以下时刻和byte口径：

- directory/mandatory/tail ready、首frame/首个可交互窗口、首次feedback、当前需求完成、geometry/VSM完成、view-settled；不继续以“全纹理mip0时间”作为VT目标。
- 网络实际fetched/overfetch、hash bytes、CPU retained/peak、ready/staging、GPU allocated/resident/pinned、旧新资源同时峰值；不把payload/staging、预算/实际分配混为同一数。
- 目标与实际mip、unique需求/used、pending/overflow/recovery、readback age、eviction/reload/thrash；容量压力下记录limited，未完成目标不得记settled。
- Surface采样增加、反馈/上传成本、粗粒度帧时间与初始化精化窗口；可用GPU timestamps时记录GPU，否则如实注明测量能力，不用墙钟推断精确GPU时间。
- 至少一个小的0/50/100%需求实验支持Cost Card/break-even，完整Bistro/Dungeon支持真实收益边界。运行性能可能因查表/过滤/原子变慢，不能只报I/O节省。

原始INIT wall-clock/4–12FPS及其非纹理瓶颈保留，不强行把本轮收益全归VT。2060不是1650，缓存热读不是冷网络；4GB资格/长窗口正式性能留F11，当前有界资源和功能成本不能延期。

### 4.4 失败、修复与关闭

保存原失败与revision/profile；按输入/算法/ABI绑定/帧生命周期/平台能力/baseline/成本分类。先修根因、重跑受影响集合，只有新变动影响全闭包才再次跑全套。不得恢复旧整包生产路径、降低coverage/anisotropy/最终场景或关闭SSR换通过。

模块关闭必须同时满足：

1. VT-1/2完整，唯一owner和旧依赖删除经过代码review；设计每条高风险合同有consumer或证据。
2. 本节必需检查实际运行且无未说明必需失败；adoption仅对已核对来源、独立差分、真实GPU消费的具体范围提升。
3. `docs/domains/materials-textures.md`及实际受影响domain写已实现事实；Source Map写真实映射/适配/license，设计与本文按最终源码纠偏。只保留一对当前authority，无重复progress文。
4. `node tools/docs-verify.mjs`、`node --test tools/tests/document-system.test.mjs`、`git diff --check`；检查实际输出并记录已有finding，不吞失败。

结束停在 **Local Reflection Probes细设计边界**。不自动实施Probes/GI/几何物理页重构，不把VT模块关单写成全Renderer性能资格完成。

## 5. 初始文档交付记录

2026-10-16：已按源码闭包选择产品/Worker、VT资源/Native/初始化整体切换、集中验收三个单元；核心组合为LibVT过滤/查找、Wicked双mip和请求闭包、Intel驻留状态，独立生命周期接线复用本仓库机制。来源均为selected/planned，所有实现与GPU验证尚待实施。

本轮仅文档/导航/协作规则；未运行引擎build、全库Node、GPU或场景性能，因为未改生产代码/资产。实际检查：`docs-verify` 为0 findings、81条historical warnings；`document-system` 7/7通过；`vibe doctor` 无errors/warnings、registry与预期hash一致；TextureResidency的context只路由新VT设计/执行一对；`git diff --check`通过。另用一次性算术检查核对7级tail矩形不重叠、block对齐/范围及BC7/BC4 payload/staging/atlas层字节；它不证明gutter过滤正确。历史warnings未在本轮清理，检查结果不代表VT算法/性能已验证，不冒用既有INIT/SSSR结果。

## 6. VT-1实施与逐项复核（2026-10-16）

完成CPU产品与准备闭包，未创建GPU页池/页表、未改Native shader或生产场景等待条件。此边界按§2结束，VT-2/3未开始。未提交代码或推送远程。

| 要求 | 实际实现与核对 |
|---|---|
| 独立目录与认证 | `TiledTextureProduct.ts`定义metadata-only目录、virtual/resident plane、真实逐mip尺寸/grid、payload offset/hash/shard、protected tail。认证目录字节再解析；严格核对source metadata3、格式/role、完整mip、范围/身份/容量、tail与所有payload引用。没有削弱完整TextureProduct validator |
| 完整冷cook | `PcTextureCook`新增借用式onMip回调，`TiledTextureCook`消费同一RGBA/BC mip；128+8→144，tail≤64直到1×1，exact coverage和显式residentRoles保持全链。有效完整BC块直接复制，边缘/partial blocks按原mip及地址profile用现有固定编码器处理。无新mip算法、运行期编解码或normal重编码方案 |
| 冷文件与cache key | `cook-offline-scene.mjs ... input.glb output 4 --vt`为显式冷产物选项，按实际sampler收集address profiles；canonical glTF alpha使用R8，custom graph须由调用方传真实residentRoles。生成hash命名pack/directory/shards和manifest中的tiled期望hash/长度；原完整Product仍供当前生产路径使用。复用检查source/recipe/profile、目录及逐payload/shard，不改写已发布内容地址 |
| 有界IO | `TiledTextureTransport`按≤1MiB、gap≤64KiB、overfetch≤2×合并；206检查Content-Range/总长/identity encoding/精确body域，选用ETag时也核对。200取消pack body后只读已烘焙的有界shards；其他错误明确失败，不拉全包兜底。目录可单独打开，fine与tail均按请求读取 |
| 同一Worker系统 | Cooked协议升至2，现有geometry/完整texture同步更新；目录在真实Worker认证，tile逐块SHA并transfer精确大小buffer。主线程核对pool品牌、session/task/epoch、payload ID/hash/extent，不再对大payload重复hash。Worker只注册小identity/pack信息，每批最多64条记录，避免全目录多副本 |
| 信用、缓存与生命周期 | fetch前一次性预留批次encoded/total/ready，结果交lease后缩至实际ready；release或session cancel后释放。ready独占buffer，release转移后旧视图detach，缓存128MiB上限包含完整backing stores；LRU take独占移出、入缓存前淘汰，不保留整套细页replay。目录budget独立，支持逐资产release/cancel及重新打开；closeSession忘记注册，Worker中止/崩溃后可重新注册重试。修复了信用刚获准、租约尚未注册时session关闭的竞态，确保归还全部额度 |
| 来源保留 | `tests/oracle/reference/vt/sources.json`固定三方revision/license和逐文件SHA；保留LibVT shader、Wicked双mip/请求源、Intel完整StreamingResourceBase及MIT notices。GPU采样/scheduler的移植与独立算法执行仍属于VT-2/3，当前不提升adoption；冷BC编码沿已采用的原pin |

轻检查实际结果：

- `npm --prefix OEngine run typecheck`通过；新鲜`build:test`通过。未跑生产Vite build、全库测试、GPU或完整Bistro/Dungeon，按VT-1边界留VT-3。
- tiled格式/真实VT Worker/原Cooked Worker集合 **13/13**通过；独立gutter手算、NPOT/BC块/tail/BC7 sRGB三地址profile、完整R8及>1MiB的mandatory分片、坏目录/hash/range、source fixture SHA、实际transfer/detach、LRU上界、ready信用、逐资产释放/重新打开、取消/崩溃/retry均有覆盖。最终修复后使用新鲜build重跑13项，额外断言“admission后同轮关闭session”不会泄漏total/ready/metadata额度，consumer已transfer的buffer也可正常release归还信用。
- 用名称过滤运行原纹理小集合 **5/5**通过：schema3 NPOT/exact-alpha；scalar通道与provided signed/non-unit normal；provided NPOT normal尾链；libktx；quality6 native/WASM对应范围。
- 原生离线小样本133×69→storage136×72，BC7 sRGB三address+resident coverage，目录11,315B、20 payloads、261,880B payload、11个bootstrap payload；cook及完整cache reuse成功。另做同输入不带VT回调的完整resident cook，**source Product identity完全一致**，确认没有改变既有mip/编码产品。该小样本证明冷链，不能代表完整场景I/O/过滤质量或GPU性能。

一次未过滤的旧`pc-texture-product`命令误包含1024/2048/4096全canonical编码矩阵，发现后人工停止（该命令exit1，不能记通过）；已完成18项没有报告数值失败。保留为“超出本单元范围而中止”，随后仅选5个小项重跑通过，未删除/修改旧断言或容差。局部记录与小样本位于`.local/vt-1-review/summary.json`，非正式GPU evidence/性能claim。

架构复核确认：Loader/Worker没有GPU owner；原完整resident产品和生产路径保持；tiled输入只依赖目录/provider及有界租约；地址/gutter/NPOT不套POT索引；coverage无虚拟化；没有同帧GPU→CPU→GPU或私有submit。正常数据依赖闭合，资源页表/过滤/反馈/SceneRefinement切换仍须在VT-2整体实施，8×过滤的真实GPU证明也不能由本轮CPU检查替代。

文档/导航检查：`docs-verify`为0 findings、81条historical warnings；`document-system` 7/7通过；`vibe doctor`无errors/warnings、registry与预期hash一致；`git diff --check`通过。历史warnings保持原分类，不计为本轮新增问题。
