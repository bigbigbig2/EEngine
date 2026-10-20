---
id: eengine-web-asset-delivery-residency-execution-2026-10
state: current
verifies:
  files:
    - docs/next-design/eengine-web-asset-delivery-residency-2026-10.md
    - docs/porting/next-renderer.md
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - OEngine/src/assets
    - OEngine/src/gpu
    - OEngine/src/shaders
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/src/framegraph/ShadeGPUCommandContext.ts
    - OEngine/tools
    - OEngine/tests
    - tools/test-build.mjs
    - tools/gpu-oracle/registry.mjs
    - examples/modules/hello-hdr-gltf/main.ts
    - examples/integrated/dungeon-warkarma-texture-compression/cooked-scene.ts
    - examples/integrated/bistro-texture-compression/cooked-scene.ts
---

# Web 资产传输与 GPU 紧凑驻留执行计划

唯一目标依据：[设计文档](../next-design/eengine-web-asset-delivery-residency-2026-10.md)。源码准备基线 `49111c6a265fb219db5514cca5ebc7ef95a4b31b`，日期2026-10-20。

**授权边界：本准备版本仅完成设计准备；U0及以后尚未运行。** 文档进入authority不证明新codec、GPU格式、worker协议或性能已经切换。现有生产仍为普通纹理schema3原生块、tiled纹理schema2 BC/Zstd与几何V3 Float32页面；后续实施授权与实际结果记录在§9。

## 1. 执行原则：大闭包，不做新旧混接

按用户2026-10-20追加要求：大胆重构，不让旧API、旧测试和中间可运行性拖累实现。每个实现单元按producer→产品→全部直接consumer→提交/中止/重试/退休连续完成；阶段内允许编译失败和断链。先在非生产隔离边界构建新算法/产品闭包，验证基本合同后原子切换所有production ownership，立即删除旧依赖。

禁止逐文件/逐consumer上线、legacy flag、旧格式fallback、临时adapter、decode到旧page的桥、两套scheduler/Worker池/Residency；也不为每个helper设审批、文档、browser或benchmark门禁。Git保留旧实现，不把它保存在新runtime里。

保留的是现有正确语义和唯一owner职责，不是旧类名和函数签名。旧ABI测试删除/迁移，源精度、normal、coverage、LOD/导数、motion、query身份、publication atomicity、cancel/retry/loss等由新owner直接验证，不降低阈值换通过。

用户后续若授权某单元，仅做该单元；若授权整模块则按依赖连续推进，不在内部任务小项停顿。本轮结束停在设计准备边界，不自动开始U0，不跨到其它渲染效果。

## 2. 按实际工程量划分

| 单元 | 工程量/风险 | 完整交付闭包 | 依赖与状态 |
| --- | --- | --- | --- |
| P：设计准备 | 中；源码/来源调查 | 本设计/执行一对、来源映射、唯一导航、明确未测项 | 本轮完成；文档验证见§9 |
| U0：有限可行性与参数冻结 | 中；codec安全/质量和几何精度风险高 | 独立离线/reference探针、真实Worker小样、必要最小GPU实验；冻结codec/质量/边界/内存/位宽，无生产接线 | 待实施授权 |
| U1：纹理全链clean cut | 大；资产/协议/内存/两个消费域 | 新产品与Cooker→Worker/信用/cache→普通纹理及VT→所有加载入口/部署资产；一次切换并删除旧传输合同 | U0纹理裁决完成后；待实施 |
| U2：几何常驻ABI全链clean cut | 很大；本模块最大工作项 | 新布局/量化域→全部Cooker→产品/admission/Worker→所有GPU reader与query→生命周期/重cook，原子替换 | U0几何裁决完成后；待实施 |
| U3：新几何传输编码收口 | 中到大；取决于子流编码净收益 | 对新ABI选编码，native/WASM decoder→容器/Worker/验证→source与资产一次切换；不改变U2精度合同 | U2后；待实施 |
| U4：模块集中集成与成本收口 | 中；跨资源组合 | 新鲜build、少量直接测试/串行GPU、真实非VT/VT/几何组合生命周期和粗成本；修复实际缺陷、删除余留 | U1/U2/U3后；待实施 |

不按天数承诺工作量。U2的工作远大于替换一个LZ4 helper；不能压成“改encoder/改decoder/跑测试”三个表面步骤。U1和U2是两个可独立稳定的资产类别切换，不允许同一种产品按consumer分批迁移。

若U0已经证明某几何子流组合胜出、且U3可与U2在同一次ABI切换中闭合，**合并U2/U3为一个原子单元**，不为表格保留第二次全场景recook。若编码仍需实测，则U2新格式先采用单一已验证页级编码，U3只替换传输段合同，不重开量化架构。

## 3. U0：有限实验，不建设第二套生产runtime

### 3.1 开始时一次核对

```powershell
git status --short
node tools/vibe.mjs context OEngine/src/assets/TextureProduct.ts
node tools/vibe.mjs context OEngine/src/gpu/VirtualGeometryResidency.ts
```

阅读当时源码、近目录约束和设计映射，发现代码变化先修正文件表，不机械沿用基线行号。不能回退用户改动，也不复跑完整历史门禁。新工作区参考只放明确隔离的工具/测试边界，未胜出的候选不进入生产import图。

### 3.2 纹理实验闭包

样本包括hello的颜色/法线/ORM，以及现有允许的Dungeon/Bistro代表性页、BC4、coverage、NPOT/wrap/跨页/尾mip。固定样本hash与分布，不把单语义结果推广为整个场景，不自动加载用户已排除的旧大资产。

1. 以同canonical输入生成当前基线和XUBC7 Q100/RDO-off/bc7e6；颜色再选少量有损档，normal/ORM默认保真。确认公开 `pack_image` 的真实像素输入，不伪造已有BC块输入API。
2. 构建只含所需decode/pack代码的有界WASM，核blob与logical scratch；查出尺寸和总展开检查先于所有大分配的实际调用点。编译/模块下载/初始化与warm decode分开记录，不用Node native吞吐代替浏览器WASM。
3. AVIF/WebP+Spark只做相同样本的端到端对照：解码、真实输入准备、最小command录制、GPU最终BC消费与质量。许可不阻止评估，但生产依赖必须单独满足授权。
4. 非VT候选分块仅比较144/256/512；同一全部mip与VT gutter口径下比较文件/目录/HTTP，不拿源GLB的base-only WebP直接对全mip包。
5. 检查重复gutter重建、跨fine/tail差异与语义误差。选失败的码率档明确否决，不补临时边界sidecar掩盖问题。

产出一份在本执行文档§9追加的决策：选定语义profile、源revision与构建hash、target/重建域、最大输入/输出/scratch/H、resident分块粒度、质量范围与拒绝项。若图片路线胜出，先修订设计主线、ready表示与U1范围再实施；不得让U1边写边改为双runtime。

### 3.3 几何实验闭包

读取实际模型的属性分布、每meshlet/group payload、重复position等价类和LOD边界，区分当前已有oct/half与新增收益。独立CPU参考验证：

- 共享指数/舍入/整数重建，16/24位与f32-exact；精确坐标往返、signed zero处理、极值/负数/tie、重复位置跨材质及LOD。
- 默认source-exact合同下可压缩覆盖率；有损profile的授权范围、量化/LOD误差和query行为，不能偷偷将exact重定义为“同一量化产品”。
- SoA/紧凑属性/metadata净字节与实际解码ALU；最小WGSL输入→输出对照，验证query/raster可共用新decoder，不在本阶段搭完整Renderer。
- 新resident字节的LZ4/Zstd/meshopt子流代表性对照；检查triangle旋转与4B stride，不为codec把resident永久膨胀。

冻结一个有限layout、精确性规则与新major计划，不要求U0实现完整产品格式。若紧凑档理想情况下也不能覆盖其元数据/ALU成本，则拒绝该档，不强行把所有模型UNORM16化。若需改变既有质量/精确性范围，明确呈报后再实施，不把算法困难当作默许。

### 3.4 U0退出条件

选定候选有可构建reference、真实解码/必要GPU输出、来源与许可、有限内存及质量合同；各待裁决点有冻结或否决记录。没有结果就仍未完成，不写“准备采用”等同生产资格。不要求本阶段完整大场景FPS或重复重跑旧实验。

## 4. U1：纹理新产品到全部GPU消费者，一次切换

### 4.1 工作范围

| 架构面 | 施工位置/可重写范围 | 必须同时删除的旧假设 |
| --- | --- | --- |
| canonical与Cooker | `PcTextureCook.ts`、`TiledTextureCook.ts`、texture-codec包装、构建/身份、离线/Web cook入口 | 必须先保存完整原生Product才能生成Web传输；从旧BC解码再encode作为正常cook |
| 产品/来源 | `TextureProduct.ts`、`TiledTextureProduct.ts`、`TiledTextureSource.ts`、材质manifest/绑定 | source identity=旧BC chunks、磁盘编码长度=ready长度；旧schema读取/自动升级 |
| CPU协议 | `CookedAssetProtocol.ts`、`CookedAssetPreparation.ts`、Worker、`AssetWorkerPool`与decoder wrapper | 旧协议3回执、固定4MiB/2S+2D预算照搬、输出表示靠长度猜 |
| CPU cache/credit | 现有cache/credit及session生命周期 | 无界普通纹理native replay、RGBA误入native cache、取消遗漏scratch/module |
| GPU纹理 | `TextureResidency.ts`、`VirtualTextureResidency.ts`及绑定 | 普通常驻必须输入完整原生文件、tiled-only传输；若主选Worker→BC不新增GPU encoder |
| 帧事务/所有读者 | `FrameProgramLowering.ts`、native material来源、raw/Web cook适配位置 | production新来源转成旧source的adapter、每页独立submit、coverage依赖漏平面 |
| 真实入口 | hello、Dungeon/Bistro cooked入口、`cook-offline-scene.mjs`、部署manifest与收据 | 示例继续fetch全原生BC、旧hash复用、页面/shard混版本 |

不同文件命名由新闭包决定，不为了保存旧公共接口增加层级。公开导出同步切换并说明source/lease/错误/释放语义。raw/procedural输入可以有独立canonical producer，但必须输出新产品，不可成为新生产失败时的fallback。

### 4.2 连续施工顺序

先完成新产品/codec/Cooker与受限reader，再贯通共享Worker和信用/cache，最后一次改全部材料来源、普通/VT residency、部署入口与fixtures。非生产隔离构建时允许两个算法reference，**不允许把两个生产schema接入同一source**。新source一旦接入production，同单元删除旧读取、旧cook复用与旧测试表示。

ordinary resident矩形完整覆盖与VT coarse/fine在同一事务语义下工作。小tail/native startup不初始化fine decoder；大mandatory采用压缩时必须准备完整后scene才发布。device loss只重开所需工作集，不保存整套full-resolution回放副本。

大resident矩形须边准备边写隐藏纹理并退CPU信用，不让“等待全部完成才发布”变成“全部native数据同时留CPU”的死锁。跨帧隐藏上传走正常frame owner，完整覆盖后原子公开；取消销毁/重试与每帧scratch fence分别结算，不能用每块独立submit绕预算。

若U0选择图片路线，U1还须连续完成低层GPU recorder、pipeline初始化、独占输入、scratch pool、layout/layer copy、FrameGraph依赖、encode预算与fence退休；这些属于U1闭包，不拆成先上线RGBA再慢慢换BC的生产过渡。

### 4.3 单元末直接检查

相关编译、产品/decoder恶意输入、真实Worker、cache hit/miss、cancel/crash、ordinary/VT实际GPU输入输出、非零layer/victim/abort/retry、coverage与query-only需求。hello非VT验证新网络来源，不要求先跑完整Renderer全矩阵。原语义oracle未变的结果不无条件重跑；发现实际错误在本单元修，不延期。

## 5. U2：几何新resident ABI最大闭包

### 5.1 子任务是施工顺序，不是逐个生产迁移

| 闭包组成 | 具体范围 |
| --- | --- |
| 数值/layout事实源 | 新major/profile；position域、anchor/位宽/精确档、section偏移/对齐、属性编码、误差；CPU/WGSL ABI生成/验证一处定义 |
| 全部producer | asset-core `GeometryCooker/GeometryCookRecipe/GeometryAbi/OegPackWriter`、native导出、portable/pthread WASM、WebGeometryCooker ABI及source recipe/hash；LOD/cook按新真实payload分组 |
| CPU产品 | `GeometryAbiV3.ts` / `OegPackV3.ts` / GeometryProduct相关模块可替换；目录和段范围、layout、索引、finite、误差/bounds、source remap、work容量验证；不可把新页转成旧V3 |
| Worker/admission | 准备receipt新版本、信用、数值预验证、memory/custom provider快照、native/Web加载与全部source；query内容hash与新format一致 |
| GPU owner/metadata | `GeometryProductGpuAbiV1`、shared directory、multi-runtime、byte pool/residency及容量规划；保留按有效前缀分配而非固定槽 |
| 全部reader | shared geometry decode、hierarchy/visibility、软硬raster、Surface、VSM及shadow work、query目录/BLAS/ray/picking、motion/历史数据读取 |
| 生命周期/部署 | replacement/generation、query retain、bank growth冻结/abort、eviction、source退休、loss/replay、scene释放、全部资产recook与manifest切换 |

构建新producer与独立CPU/GPU reference后，连续实现上述全闭包。全部直接consumer在同一单元切换新ABI；不保留V3/F32旧reader使部分画面先“能跑”。精确档属于新ABI，不是旧renderer桥。

### 5.2 必须在切换前解决的难点

1. 量化域覆盖跨材质重复position与全LOD，共享边界一致；分开属性seam与位置焊接，不能误合UV/normal。
2. 精确query不被默认有损化；紧凑/精确档均通过新reader。无法满足source-exact则明确精确档或拒绝非法profile，不另建query几何副本。
3. query directory目前内联16B format且shader沿shared reader；新layout可能改变大小/索引，必须全链更新，不能只改主图position读取。
4. 输入三角形旋转、barycentric、source remap与MASK UV一致；bounds、SSE/LOD、motion、negative/nonuniform实例一致。
5. bank物理容量、30-bit地址namespace、storage binding/dispatch上界协商；溢出明确错误或有界继续，不截断ID、不漏工作。

### 5.3 删除清单与退出

删除旧产品生产parser/schema分支、旧F32-only format校验/decoder、旧WASM ABI与复用收据、过期fixture和raw flags。保留新精确档、完整身份及生命周期语义。新产物具有唯一可用major/manifest，旧资产在GPU创建前拒绝；所有直接reader无legacy import/开关。

单元末集中相关C++/WASM/TS编译、独立numeric与layout检查、最小真实raster/query/Surface/shadow消费、增长与退休。U4归属组合场景资格，不替本单元隐藏reader缺失或数据损坏。

## 6. U3：只针对新布局做几何传输收口

若与U2合并，本节成为U2内部任务，不新增生产阶段。

先对新layout比较按页LZ4、Zstd、meshopt子流+可选通用压缩，记录raw/有效payload/metadata/码流/CPU scratch与解码延迟。输入是U2新产品，不再给已退休旧Float32页面做一个永久“先行优化”。

胜出后一次完成编码器、容器段目录/校验、C/WASM有界decoder、Worker协议/credit/ready/source、manifest/收据/recook及直接测试；新产品minor/major按实际合同决定，不在设计阶段抢占若干版本号。拒绝旧encoded布局的自动兼容和逐codec热fallback。若高熵允许raw段，必须是新profile明确的有限段表示，不是旧schema兜底。

默认保持payload隐藏direct write与encoder地址发布，不另起上传系统。不为“优化上传”重复实现已有writeBuffer。只有真实测量指出元数据聚合或GPU copy瓶颈才在其owner局部改动；不能为节省一个copy破坏abort/growth顺序。

退出：新产品传输→真实Worker→compact ready→新GPU reader闭合；所选编码净收益有数据，否决项有记录，旧传输依赖随同退休。没有净收益则选择简单新profile，不能用更高预算和漏验证凑压缩率。

## 7. U4：集中集成，不逐patch重跑全场景

### 7.1 检查节奏与真实入口

源码改动后按需typecheck/shader compile/极小测试。U1/U2/U3基本连通再集中新鲜构建：

```powershell
npm --prefix OEngine run typecheck
npm --prefix OEngine run build:test
npm --prefix OEngine run build
node tools/gpu-oracle.mjs --list
```

C++/WASM沿实际build脚本按变更构建，不捏造尚不存在的命令。选定文件在`OEngine`工作目录中执行 `node --test <explicit-files>`，不使用宽泛geometry/texture通配符扫整类测试。

按实际改动从这些窄入口迁移/挑选：`pc-texture-product`、`tiled-texture-product/decoder`、`tiled-texture-worker`、`texture-residency`、`virtual-texture-residency`；几何`oegpack-v3`与`geometry-product-binary/gpu-abi/admission`、query section/directory/cut、budgeted-lifecycle/multi-runtime、web-cooker-abi。旧文件可重命名，不能为了保留名称恢复旧格式。

真实GPU串行，从registry选`pc-texture-product/residency`、`streaming-vt`、`scgi-query-vt`及对应geometry/query oracle，按新ABI迁移；独立expected与production输出分离，不只验证“能出图”。新的decode能力测试必须进入真实注册入口，未登记不虚构已可运行命令。

### 7.2 组合场景与生命周期

hello证明新网络入口、全部原语义材质、普通非VT与VSM关闭；现有允许的Dungeon/Bistro证明VT、几何与真实Native/query消费。正式browser证据沿`validation/`宿主，不把examples当性能runner，不缩场景和降低质量来凑通过。

集中覆盖冷启动/warm cache、持续移动/快速转向/teleport、eviction/reload、部分下载失败、Worker替换、source/scene replacement、unload、device loss/retry、growth双份峰、异步fence失败与资源计数回基线。一次完整闭包后的变更只重跑受影响项，不每helper循环全场景。

### 7.3 成本报告和结论等级

固定源码/构建/资产/浏览器/设备/尺寸/feature/相机/热状态；网络测试至少下载受限与高速暖缓存两类，另记冷decoder初始化。收集设计Cost Card全部字节和阶段时间，区分HTTP范围、pack/shard磁盘副本、目录、完整mip与VT有效工作集。报告P50/P95及样本数，不从一次微测推吞吐资格。

报告纹理真实网络收益、准备和发布延迟、CPU/GPU临时峰；几何精确/紧凑覆盖率、有效payload/headers/padding、实际上传与bank分配、decoder ALU/寄存器/GPU时间。0/50/100%收益模型和break-even注明假设，不用容量减小宣布帧率提升。

实现完成、直接验证通过、组合验收与正式跨设备性能资格分开。完整Renderer正式动态画质/同条件FPS/低内存OS驻留仍归最终集成；已发现错误、漏工作、失控容量不能归“只欠性能验证”。

## 8. 失败处理、文档和停止边界

失败保留原输入、原输出、日志与身份，按[验证合同](../VALIDATION.md#validation-failure-contract)分类后修根因；不吞异常、放宽容差、删语义断言、切回旧owner或把偶然重跑绿色称修复。

每单元末做一次architecture review：唯一writer/owner、新闭包全reader、协议/身份/容量、取消/发布/退休、删除清单。必要局部错误修复在同owner完成，不进入patch→全benchmark→改架构循环。

来源状态只在原始源码核对、独立CPU/WGSL oracle和真实production消费证据齐备后提升。`docs/domains/`只在实际代码切换后更新；新稳定ABI合同在实施定型后更新，不能本轮把目标当已实现规范。详细状态与结果只写本执行文档，workstream不复制每项进度。

提交中文标题/正文，一个提交一个连贯意图。可在大单元内部记录非稳定开发提交，但不能用新旧兼容换取每个提交可运行。模块完成停在边界，不自动进入SCGI、其它效果或全局性能重构。

## 9. 本轮准备记录与后续结果位置

### P：2026-10-20设计准备

- 已核对本地基线源码、真实直接上传/地址发布区分、当前query精确语义、ordinary/VT来源与示例入口、Worker/credit/cache边界；未改生产代码与资产。
- 已核对Basis XUBC7 encoder/decoder、meshoptimizer共享指数/helper/传输codec与GPU示例、Spark低层录制行为与EULA；pin/入口/适配限制见来源账本，不宣称已采用新codec。
- 已建立新设计/执行一对，按本轮授权导航设计准备，上一Zstd模块文档转历史而保留实施结果；未自动开U0。
- 已运行 `node tools/docs-verify.mjs`：0 findings，209份文档，86条historical warnings；不把历史警告当正文/算法验证。`git diff --check`无问题；`vibe context TextureProduct.ts`已实际返回新authority/currentSlice。
- TS/C++/WASM/build/browser/GPU/benchmark未运行，因为本轮只有设计与导航变更；U0候选实验、质量/吞吐/内存数值和新生产GPU消费均未取得，不预填结果。

U0参数裁决与样本结果、U1/U2/U3实施/删除/直接验证、U4组合与成本结果，今后在本节按单元追加真实记录；不预填通过，不新建并行progress/status文档。
