---
id: eengine-extreme-web-asset-compression-2026-10
state: current
verifies:
  files:
    - docs/next-execution/eengine-extreme-web-asset-compression-execution-2026-10.md
    - docs/porting/next-renderer.md
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - OEngine/src/assets/TextureProduct.ts
    - OEngine/src/assets/TiledTextureProduct.ts
    - OEngine/src/assets/TiledTextureSource.ts
    - OEngine/src/assets/codec
    - OEngine/src/assets/GeometryAbiV3.ts
    - OEngine/src/assets/OegPackV3.ts
    - OEngine/src/assets/geometry-product
    - OEngine/src/gpu/TextureResidency.ts
    - OEngine/src/gpu/VirtualTextureResidency.ts
    - OEngine/src/gpu/VirtualGeometryResidency.ts
    - OEngine/src/gpu/GeometryProductBytePool.ts
    - OEngine/src/gpu/GeometryQueryDirectory.ts
    - OEngine/src/material/AppearanceNormalCooker.ts
    - OEngine/src/shaders/native_material.ts
    - OEngine/src/shaders/geometry_source_decode.ts
    - OEngine/src/framegraph/ShadeGPUCommandContext.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/tools/oengine-asset-core
    - OEngine/tools/oengine-web-geometry-cooker
    - OEngine/tools/texture-codec
    - OEngine/tools/extreme-web-asset
    - OEngine/tools/cook-offline-scene.mjs
    - examples/modules/hello-hdr-gltf/main.ts
---

# 极致 Web 资产压缩：图片传输、GPU 编码与紧凑驻留

日期：2026-10-20。源码 HEAD：`5f3f41533e25901cbbd1da9c3ae751c64bc0a9c9`，工作区另有未提交的旧 U0 工具与文档改动；本设计不把它们视为生产迁移。唯一配套文件：[执行文档](../next-execution/eengine-extreme-web-asset-compression-execution-2026-10.md)。

本文件与配套执行文档完全替换并删除上一对 Web asset delivery/residency 文档，不保留并行设计、旧参数冻结或第二份 progress。准备改动已提交为`1f856ea0`；用户随后授权E0及E1隔离闭包，尚未授权E2生产切换或示例recook。

## 1. 已定方向，不重新做路线公投

1. **常规 LDR PBR 纹理统一以 AVIF 图片传输、浏览器解码、GPU 原生压缩为主线。** BaseColor、Emissive、Normal、ORM、独立标量全部覆盖，不只优化颜色。首个生产目标是当前 BC 设备；同一图像来源可扩展 ASTC/ETC/EAC，但不宣称本轮已经覆盖所有设备。
2. **移植优先。** 以 Spark.js 全套对应编码内核、图片加载/mip 路径及 gltf-tex 语义编码策略为上游基线；先忠实接入，再做本地增量优化。不能先自写简化算法，再用它的失败否定上游。
3. **网络表示不等于显存表示。** 普通纹理优先只传 base image 并在 GPU 生成 mip；VT 使用较大图片传输单元、确定性 decoded texel owner、GPU 页面装配/编码，仍按真实需求驻留。
4. **追求给定质量与能力范围内的最小交付字节，而不是默认 Q100。** 使用 High / Extreme 两个离线质量档，最终质量评价经过真实 GPU 编码与材质消费。允许常规纹理有损，不允许丢通道、缩场景、静默缩分辨率或破坏精确 coverage。
5. **一个生产产品合同、一套准备调度、唯一 GPU owner。** 完整新闭包实现后原子切换普通纹理与 VT 的全部生产消费者，立即删除旧 schema、旧回执/入口和旧依赖；没有 XUBC7 fallback、RGBA 常驻过渡或新旧双 runtime。
6. **几何同步采用新紧凑可读 ABI 与成熟无损传输编码。** 位置保留 source-exact F32 合同，布局/元数据压紧、Zstd 离线高 effort；不因纹理允许有损就默许几何量化，不另存一套 query 精确几何。

“比直接接入上游更好”是工程目标：完整继承其能力，再用常量消除、语义去重、离线码率搜索、mip 策略、请求合并和有界批处理获得增量。不是预先承诺所有资产/所有设备/大小、画质、时间三者都严格占优。验证只负责发现移植、集成和具体产品错误；不重新以失真的微测否决已经确定的路线。

## 2. 当前源码事实与替换边界

| 当前实现 | 源码事实 | 本轮替换 |
| --- | --- | --- |
| `TextureProduct.ts`、`codec/PcTextureCook.ts` | schema 3；离线完整 BC7/BC4/R8 mip；provided normal mip 可保留非单位 XYZ | 新图片产品与 recipe，移除产品必须等于最终 BC 全链的前提 |
| `TiledTextureProduct.ts`、`codec/TiledTextureCook.ts` | schema 2；fine 为 BC+Zstd；128 interior+8 gutter=144；tail/部分 plane resident | 传输 cell 不再等于 GPU 页；保留正确的采样域、反馈和 mapping owner，重做 producer/网络合同 |
| `codec/CookedAssetPreparation.ts`、协议 v3、Worker pool | CPU 任务、IO、credit 与 tile native cache；整 product 或原生页作为结果 | 同一准备体系改为表示明确的 image lease / exact bytes / compact geometry，图片不是假 native payload |
| `TextureResidency.ts` | 分段 array/layer、mandatory plane、scene publication；coverage 会分析真实依赖 | 隐藏纹理中编码/复制，完整必需域就绪才发布；BC5 及重建语义贯通所有材质消费者 |
| `VirtualTextureResidency.ts` | 独立需求/物理槽/淘汰/query feedback，帧内上传后 mapping | cell 请求与 decoded 邻域准备交统一 CPU 层，VT 继续唯一拥有需求与映射 |
| hello 示例 | 15 个产品全部普通纹理；fetch 完整 product，再 `ShadeTexture.fromProduct`；不要求 VT/VSM | 加载新目录和图片来源，证明普通纹理实际受益；不得靠开启 VT 偷换目标 |
| 几何 V3 | F32 position、已有 oct16 normal/half UV、U8 local triangles、raw/LZ4 页 | 新 SoA/紧凑元数据与 Zstd/raw；不重复计算已有属性压缩收益 |
| `VirtualGeometryResidency` | payload 已 direct `queue.writeBuffer`；地址表另有 encoder publication/growth 顺序 | 不虚构“删除 staging copy”收益；保持隐藏 lease、地址发布与增长事务 |
| query 与 Appearance | source primitive/corner/remap、精确位置；部分 normal/moment 有非单位含义 | 新 reader 全消费者同切；不得把精确改为“对有损产品精确”，不得把 moment 长度抹掉 |

旧 source/API 名称只定位改动面，不要求保留签名。raw/procedural 的合法生产输入继续作为 canonical producer，直接进入新准备/GPU 路径，不转换回旧产品维持兼容。HDR 环境、IBL 预过滤与几何 LOD 算法不在本轮重写范围。

## 3. 来源与忠实移植合同

详细本地映射统一维护在[来源账本](../porting/next-renderer.md#extreme-web-asset-compression-2026-10-20)，本节只列决策依据。

| 固定 donor | 实际选中内容 | 保留与适配 |
| --- | --- | --- |
| [Spark.js](https://github.com/Ludicon/spark.js/tree/b9ea643a08cb9eef3a9ddc64564089bdd6fd0daf) `b9ea643a08cb9eef3a9ddc64564089bdd6fd0daf` | `src/spark.js`、`src/utils.js`、`src/three-gltf.js`、BC7 RGB/RGBA、BC5、BC4 WGSL、`utils.wgsl` | 保留选定内核的输入、候选决策/精度/端点/索引/打包，及选定 mip/颜色/alpha/normal 处理；只替换宿主资源、命令与生命周期。JS MIT；shader 另受 EULA，非全仓 MIT |
| [gltf-tex](https://github.com/Ludicon/gltf-tex/tree/a05bd5950fb46fdffb813542f4258192ce6aa889) `a05bd5950fb46fdffb813542f4258192ce6aa889` | `src/processors/avif.js::avifArgsForTexture/processTextureAVIF`、用途分类和去重思路 | 仓库声明 MIT；取得适用 notice 后复用。native avifenc 路线，不把 Sharp 便利路径当等价实现；normal 的可变性/归一化和灰度提取须按实际语义适配 |
| [Spark PBR 接入](https://github.com/Ludicon/webgpu-clustered-shading/tree/42ba9b8e0db0707207c38a1c2d0bd5bc09bce37d) `42ba9b8e0db0707207c38a1c2d0bd5bc09bce37d` | `mini-gltf2.js` 通道用途，`webgpu-renderer.js::initImage`，`shaders/pbr.js` normal Z 重建 | Reference，不复制整个 renderer；源码证明整套 PBR 路径存在，不证明 EEngine 接线已正确。代码复制前核对具体文件 notice |
| libavif v1.3.0 `1aadfad932c98c069a1204261b1856f81f3bc199`；libaom v3.12.0 `3b624af45b86646a20b11a9ff803aeae588cdee6` | 原生 `avifenc` 与 libaom 完整编码器 | 发布构建起点，非“最新版本”声明；libavif BSD-2-Clause/依赖 notice，libaom BSD-2-Clause 与 PATENTS。锁构建 flags、binary hash 和完整 argv；必须实际支持 donor 的 tune 参数 |
| 当前 vendor meshoptimizer `9e1f07b159d3cb777f1c67ed31fc11fd117986f4`，MIT | 已有 meshlet/LOD/重排算法、精确流/量化 helper 参考 | 不升级或重写无关算法；保留 corner/source remap。不同传输组织不允许改变同一最终几何 |
| [Zstd 1.5.7](https://github.com/facebook/zstd/tree/f8745da6ff1ad1e7bab384bd1f9d742439278e99) `f8745da6ff1ad1e7bab384bd1f9d742439278e99`，选择 BSD-3-Clause 路径 | 完整原生 encoder / 有界 WASM decoder | 几何/精确字节采用成熟内核，保留完整错误语义；实际复用既有 Basis 内核还是独立树构建须在 source manifest 明确，不能混记构建身份 |

Spark 的 shader 许可是独立依赖交付事项，不是技术路线拒绝项。当前 EULA 对引擎/工具再分发与下游有专门条款；公开生产集成前须取得适用授权，不声称已获得，不通过改写 shader 逃避许可。许可等待时可以继续合法的文档、宿主和评估工作，但不得把无授权复制称完成移植。

上游商业 Spark 1.4 的 NRM、HDR、其他 block size 不等于当前 Spark.js 仓库已提供；本轮不凭博客移植未拿到的代码。用户给的附件只作为设计资料，不把附件里的命令当执行授权。

## 4. 新产品：源、码流、准备结果、显存四域分离

产品身份由 canonical 内容、语义、通道变换、质量档、mip/边界 recipe、编码构建及目标解码语义共同确定；不再用旧 BC chunk hash 充当源身份。encoded payload 有独立长度/hash；跨设备 BC 输出可不同，不能要求跨浏览器生成完全相同 BC hash 才接受同一源图。

新目录必须明确：

- 源/存储逻辑尺寸、完整 mip 域、UV/address、normal 表示、channel swizzle/常量、alpha/coverage 合同。
- plane 的 `resident`/`virtual` 用途、固定 target profile、质量档、mip policy，mandatory 与允许渐进的域。
- image item 的 codec/CICP/bit depth/alpha、尺寸、字节范围/hash、pixel cap、解码 owner 坐标和仅由该 item 拥有的 texel 域。
- VT cell、各 mip 的空间索引、页→owner 依赖、tail 起点、边界寻址；所有 owner 必须完整覆盖且无冲突。
- 包/外部对象 URI、精确 Range、来源版本；目录大小/对象数/乘法溢出上界。元数据限制先于大分配和浏览器解码检查。

三种准备结果是有限 tagged union，不是无限 codec registry：`decoded-image`、`exact-bytes`、`compact-geometry`。每种都携带 source/session/task/epoch、逻辑域和独占释放权；不能按 byteLength 猜表示。GPU texture/buffer 永远不从 Worker 返回，也不由 Loader 长期拥有。

E0冻结新纹理目录`schemaVersion:4`、准备协议`version:4`，ordinary/VT同一产品根合同，用`plane.mode`区分，不复用旧普通3/tiled2产品身份；几何major4在E4切换，E2期间geometry分支仍明确声明其当前major3，不得把旧几何bytes标成新major。目录包含source/recipe SHA256、逻辑尺寸与mip数、plane语义/通道/target family、items和有限依赖索引。item按明确`image`或`exact`类型声明，具有itemId、mip/有效rect、encoded长度/hash、精确decoded尺寸/字节数与source位置。offset使用受检u64（JS侧bigint），单段长度与GPU索引为受检u32；目录索引与owner rect须不重叠/完整覆盖，所有乘法先用安全整数验证。目录/encoded cap按§9，单目录最多65,536 items、每个page最多16 owner；超过上限离线分包并计入总目录预算，不以无界JSON或隐式递归引用绕过容量。

成功receipt保留`protocol/sourceRevision/session/task/epoch/itemId`，`decoded-image`携带ImageBitmap/VideoFrame实际类型、width/height、orientation/alpha/encoding事实与ready charge；`exact-bytes`携带独占ArrayBuffer及exact role/尺寸/stride；`compact-geometry`携带新major页和完整checked section描述。失败是独立`ok:false`加具名错误，不伪装零长度成功。只有当前pool任务可签发有效receipt，GPU层再次核对epoch/recipe/域并接收或释放；lease不是可复制的用户自填JSON。取消和错误重试生成新task，source revision不变也不能复用已释放的结果对象。

AVIF item 自身可解码；pack 仅组织独立图片，不依赖浏览器对整个 pack 解码。HTTP Range 基于稳定字节对象，禁止透明 Content-Encoding 改变偏移；不支持 Range 的服务必须在下载前选择明确的有界外部图片部署形式，不能收完整大包后假称按需。有限 LDR profile 只接受静态单图、已支持 bit depth/颜色元数据和确定方向，不开放动画/任意辅助图/无界 item 链。

## 5. Cooker：先消无用数据，再做语义编码和码率搜索

### 5.1 固定处理顺序

真实材质依赖分析 → 无 consumer 删除 → 精确常量/通道识别 → 语义去重 → 必要 canonical 变换 → mip/VT owner 规划 → AVIF → 最终 GPU 输出质量评价 → 选择最小合格码流 → 新目录/manifest 原子生成。

常量识别默认逐值精确；近似常量化属于有损搜索，必须占用同一质量预算，不能使用任意 tolerance 当无损。跨语义冲突的同图分开 recipe；同一个图既作为 normal 又作为普通 RGB 时，不能全局丢 B。通道合并只有尺寸、UV、sampler、变换与过滤依赖一致才合法，不为少一次采样强行打包不相关纹理。

### 5.2 语义配置

| 语义 | AVIF 基线/表示 | GPU target 与消费 |
| --- | --- | --- |
| 不透明颜色 / LDR emissive | donor `tune=iq`、10-bit 编码起点；本地显式 4:4:4，固定颜色元数据；不靠缩图换码率 | BC7 RGB，sRGB 消费；opaque alpha 从合同推导，不走 RGBA 内核 |
| 带 alpha 颜色 | 同上，独立 alpha quality；正确 straight/premultiplied 策略及透明边缘 | BC7 RGBA；精确 coverage 不由有损 BC alpha 代替 |
| 单位切线空间 normal | donor Identity `--cicp 1/8/0`、`tune=ssim`、10-bit 起点，XY 有效、B 为已声明常量；normalScale/翻转约定固定 | BC5 linear，材质以 XY 重建正半球 Z 并执行约定 normalize；不用 BC7 RGBA 对照否决 BC5 路线 |
| ORM / 独立数据 RGB | Identity/linear、`tune=ssim`、无色度降采样、每通道含义固定 | BC7 RGB linear；当前 donor 有颜色权重，先继承原内核，再按最终材质选码率，不伪称已有 ORM 专用内核 |
| 单标量 | 明确从所用通道提取并无损复制为灰度源，再编码 AVIF；声明 transfer/range，不能让 luma 变换改变 AO 含义 | BC4 linear；提取/通道映射是本地适配。donor 灰度预处理存在禁用分支，不原样照搬其未处理路径 |
| 非单位 normal / 三维 moment | 保留 XYZ 和长度/符号语义，Identity；原有专用 mip 作为 provided chain | 三通道保真需求对应 BC7 linear，不归一化、不重建丢失的 Z；仍走图片传输/GPU 编码主线 |
| 精确 coverage / 标识 | 精确通道 → Zstd/raw 有界独立段；字节精确 | R8 或既定精确布局，必要时原子携带关联 plane |

AVIF 编码 10 bit 不代表当前浏览器→RGBA8→Spark 全程 10 bit。产品只承诺选定解码路径实际交付的精度，不把 decoder 内部位深当材质精度。unit normal 的 XY 合同先检查源范围/半球和下游用途，不能把一般三维向量误分类；normalize 影响与原有语义在 cook 中显式处理。

E0实际原生配置由`OEngine/tools/extreme-web-asset/native-profiles.mjs`唯一表达：颜色显式444/full/CICP1/13/6、IQ；XY/ORM/XYZ显式444/full/1/8/0、SSIM；标量先精确提取R再400/full/1/8/6、SSIM。忽略ICC/Exif/XMP只对已经转到canonical域、方向已应用的中间PNG成立，不允许对任意源图直接剥metadata假装完成颜色转换。gltf-tex donor原始argv另外复现，不将本地显式配置冒称上游原样代码。带alpha显式qalpha与qcolor同档起步；coverage仍独立精确。

normal-xy的已声明B=0是**解码后预处理也必须恢复的常量**，不能要求有损AVIF重建恰好保持0后才触发Spark `normalize_vec4` 的XY分支。GPU预处理按recipe恢复无consumer通道/opaque alpha后再生成mip；XYZ/moment不走该分支。保留donor XY mip算法不等于它等价于原EEngine XYZ归一化滤波：该表示变化按最终normal/高光评价明确验收，provided非单位moment不改变既有数学。

### 5.3 两个质量档与有限离线搜索

High 从 donor Q80/speed4 配置开始；Extreme 从 donor Q50/speed4 开始。它们是复现上游的搜索锚点，不是“80%/50%画质”，也不是所有语义最终使用同一 Q。

最终 Cook 对每个语义产品保留 donor 原始候选，再作有限候选搜索：Q 集 `{95,90,85,80,75,70,60,50,40,30}`，包含档位锚点；speed4 为基线，最终 speed2 为完整实现支持时的高 effort 候选。离线缓存以全部输入/构建/argv/评价版本为键。若 95 仍不满足既有硬语义合同，报告该产品不合格，不自动转无损档掩盖失败。候选数和并发有显式上限，不在运行时搜索或下载多份。

比较分两层：

1. donor-relative：同资产/尺寸/质量档/target 下，检查最终 GPU 输出与材质表现，沿相同指标比较候选；候选不合格可保留原 donor 码流，不因追求字节而强行降质。
2. 产品硬合同：精确 coverage、normal/moment 含义、UV、HDR 不混用、合法精确 query 等独立成立。原 donor 图像“看起来正确”不能替代 EEngine 特殊语义。

颜色采用成熟感知指标及最终画面；normal 记录方向 P50/P95/P99/max、高光变化；ORM 分别记录 roughness/metal/AO 和 BRDF 输出；所有有损产品覆盖梯度、平坦光滑、高频、motion 与边界。指标实现直接复用成熟工具，实际版本/hash 在实施中锁定，不另写一个简化感知指标。门限继承已声明合同或对应 donor 档的基准，不在这里捏造普适 PSNR 阈值。Extreme 允许比 High 更大损失，但不得越过精确语义或偷偷缩小功能。

## 6. 普通纹理：base-only、GPU mip 与渐进发布

默认 `runtime-mips`：单张基础图片 → 浏览器解码 → GPU 上传 → 语义正确的 mip → 对应 Spark 内核压缩全部层 → 最终 array/layer。声明完整 1×1 链，不照搬 donor 默认只到 4×4；tiny/NPOT 采用物理块与逻辑域分离，不把自动 resize 当语义不变。

若设备实际支持并启用`texture-compression-unaligned`，可按协商profile保留原逻辑base尺寸；这属于同一图片产品的能力适配，不假定所有浏览器已支持。未启用时base物理尺寸满足块对齐，最后块和tiny mip按真实逻辑域/地址模式补齐；若原尺寸无法在既有bank中精确表示，则进入明确的padded尺寸类，而不是拉伸图片。

metadata保留逐层有效域；padded物理mip尺寸与逻辑mip未必同倍率，因此不能仅缩放一次UV就使用整链硬件trilinear。实现必须按每层有效域修正坐标/过滤边界，必要时显式选相邻层并混合；repeat/mirror的跨缝过滤与anisotropic footprint不能落入未定义padding，导数来自寻址前逻辑UV，LOD来自逻辑尺寸。所需边缘扩展或显式过滤及额外samples/metadata列入Cost Card，由真实消费者验证。所有直接采样consumer一并实现，普通NPOT不因开启图片传输被静默转成另一分辨率。

`provided-mips` 是有限显式产品策略：特殊 normal/moment、coverage 约束或超大分片需要正确离线 mip 时，由 canonical producer 输出各层图片；GPU 只编码，不重新滤波。整图 base-only 优先，但不能为了省 mip 抹掉现有抗走样/方差语义。

图片单元起始上界为普通设备 2048²、受限设备 1024²；这只是单任务容量，不是降低纹理分辨率。较大图使用逐 mip 的 canonical 分片/owner 规则，保留完整逻辑尺寸；分片不能各自生成截断邻域的 mip。独立的 base-only 整图若设备预算可以容纳，可通过明确的大输入能力 profile 扩展，不无界启动 4K/8K 解码。

preview 是可选且确定的低分辨率产品；quality 档与全分辨率 recipe 相同，不能把 preview 冒充完成。只有材质依赖允许、全部必需 mip 已初始化并有正确有效 LOD 范围时才公开；更细层完成后由原子 metadata 更新解锁，不采样未初始化层。mandatory coverage/其 RGB/UV 依赖未准备完的材质不得提前发布。无 preview 时完整隐藏准备后一次公开，上传期间逐任务退还信用，不能积压所有 ready 图像等场景发布造成死锁。

## 7. VT：传输 cell、唯一 texel owner 与 GPU 页装配

### 7.1 固定所有权，容量可分档

保留现有 128² interior、8 texel gutter、144² physical 页和正确地址/LOD 数学。每个 mip 划分不重叠的 owner cell：普通设备从 512²、受限设备从 256²起步，目录可对冷/稀疏区域显式使用 128² cell。cell 边界按 BC 4 texel 及 VT interior 对齐；NPOT 最后一格有精确有效域。不是运行时任意尝试三种 codec，也不要求全内容同一 cell 尺寸。

**每个逻辑 mip texel 只能有一个 decoded owner。** 不为两个 cell 各自编码一份重复 gutter，再期待有损结果相等。某页需要的 144² texel 先执行 wrap/clamp/mirror，再查询 owner cell；远离NPOT尾边界的统一256/512网格每页最多四个owner，但128网格两侧都需gutter，最多3×3即九个owner。NPOT的极窄末格加repeat跨边界还可能额外跨格，通用单页合同按最多4×4即16个owner检查；混合尺寸同样按最小128网格和实际寻址求去重依赖，不能写死四依赖。整cell批量装配独立计算依赖，不把普通3×3邻域当所有边界的上限。

### 7.2 装配与发布闭包

1. VT 将目标页集合转为去重 owner cell 集合，合并同源/同 urgency 的 IO，并统计实际过取。
2. 准备层保留有界 decoded cell lease；GPU transcoder 拥有短期输入 texture，不交给 Loader。一次任务先预留完整依赖与输出信用，不能拿住一半邻居等待另一半造成死锁。
3. local assembly 根据目录坐标将唯一来源 texel 装成完整 144² 页面；此处是新增 EEngine 集成算法，不伪称 Spark 已有 VT 实现。输入对齐、地址模式、细 mip、边角都必须覆盖。
4. 原 Spark 对应内核编码完整物理页，block buffer 复制到真实 slot/layer。边界重复块读取相同已解码来源与相同编码参数；页面不能使用不匹配的 recipe。
5. 同一个帧事务中先编码/复制、再写 mapping；最后消费者按已有事务顺序看到有效内容。abort 不发布半页，不提前覆盖仍被旧映射引用的 victim；沿用 VT 既有隐藏 slot/顺序约束并完整复核。

同一源 owner 消除了“同一个 texel 两份有损重建”的矛盾，**不自动消除相邻 cell 内部侧的 AVIF 边界伪影**。这些通过离线全局边界评价、cell 大小/编码质量选择处理；不许声称单靠 gutter 已解决全部接缝。所有可能邻居组合都计入离线评价，不能只测单个 cell。

fine 的 mip 由 canonical 全图语义先生成，再逐 mip 编码 cell；不对独立 cell 自动 mip，否则会产生过滤边界。tail 也用新图片产品准备后编码，不下载整套原生 BC tail 形成第二种普通纹理路径。fine/tail 重建差异、最后层过渡与各向异性是本单元验收内容；先准备 mandatory tail，再开放 fine mapping。

### 7.3 cell 大小不是越大越好

512² 一个 cell 包含 16 个 128² interior 页；稀疏请求时可能多取大量无用 texel。普通网格单页跨四个512² cell时，decoded/source texel数相对144²约50.6倍；这还不是所有NPOT/混合布局的全局最坏上界。目录必须给实际依赖/有效尺寸，上界逐任务检查，不能拿“大块压缩率更好”掩盖过取。

因此 Cooker 用固定完整 trace/空间使用分布在 128/256/512 三个有限档之间选择，目标是 `fetched useful+overfetch bytes + 有界准备成本`，不是只最小化 pack。没有 trace 时按容量与已知稀疏性选择，并保留 worst-case 计数；不虚构普遍最优 512。一次装配只编码有实际需求的页，不因下载一个 cell 就强占 16 个 residency slot。邻居解码共享可在有界 LRU 中复用，不引入全分辨率常驻 RGBA 镜像。

## 8. 唯一 GPU 转码 owner 与帧事务

新 `TextureTranscoder` 是暂定职责名，不新增通用 manager。它只拥有按设备 epoch 的 pipeline、临时 input/scratch、批次记录与 fence 退休；不拥有 texture handle、VT demand、长期 atlas 或网络缓存。

生产 recorder 只记录到调用方 `ShadeGPUCommandContext`/现有 scene/frame command：外部图片上传、预处理/mip、压缩 dispatch、block-buffer→最终纹理 copy、metadata publication。外部图片 copy 属于 queue 操作的真实顺序必须保持：GPU input lease 不得在先前 command 尚未提交时被下一次 queue copy 覆盖。复用仅在先前读已排队且顺序明确后进行；池不足背压，不自行 submit 解锁。

图片解码和GPU external copy是两个独立的颜色/alpha处理阶段。`ImageDecoder.colorSpaceConversion:none`不自动保证`copyExternalImageToTexture`仍按原数据通道上传；必须明确源对象的实际encoding、目标`colorSpace`/premultipliedAlpha和线性或sRGB view。Normal/ORM/标量优先使用保持原通道的ImageBitmap路径；VideoFrame若会按标签执行transfer/primaries转换，则用经核对的同表示ImageBitmap适配，不能把Identity数据当sRGB颜色自动变换。仅改目标texture为unorm不能关闭external copy转换。Firefox等需要VideoFrame→ImageBitmap时沿donor有效宿主适配，复制/双backing计入信用，不默认JS整图RGBA copy；设备/浏览器无法满足数据语义则在能力阶段具名拒绝。解码后、上传后分别用独立data ramp/alpha样本核对，不能只比较最终BC的RGB PSNR。

ImageBitmap/VideoFrame 的关闭、GPU input/scratch 的释放和最终纹理的发布是三个不同事件。CPU 对象在允许关闭且 upload 已接受后结束，GPU 临时资源保留到相应 command fence，最终资源归 Residency。编码 command abort 后隐藏输出销毁或重新完整覆盖；不把未执行的 copy 当已上传。

### 8.1 E0冻结的能力与目标配置

必需`texture-compression-bc`及完整当前Renderer binding profile；BC7 RGB/RGBA共用BC7格式bank但保留不同encoder variant/recipe，BC5 RG与BC4 R为独立format class，R8为exact plane。format class沿既有binding-set policy分配，不能因添加BC5突破实际采样绑定数或偷偷去掉材质通道。normal XY重建作为显式sample语义传播到Material Graph/Native/coverage/query，不由format名字全局猜测。

`shader-f16`不是硬前置：支持时用原f16内核，不支持时严格沿Spark `#loadPipeline`的五类机械替换移除enable/half标量/half向量/矩阵/half字面量，保留所有运算/控制/搜索，pipeline/cache键含precision。两种输出可有数值差别，分别与同能力donor对照，不冒称bit-identical。`texture-compression-unaligned`可选；未启用使用§6完整padded合同。每kernel固定16×8=128 invocation，8×8 mip；创建前核maxComputeInvocationsPerWorkgroup/各维、texture size/layers、buffer和storage binding容量。输入external copy texture需COPY_DST|RENDER_ATTACHMENT|TEXTURE_BINDING；compute mip再有STORAGE_BINDING，压缩目标只有合法COPY_DST|TEXTURE_BINDING，不能作为storage texture。

浏览器有ImageDecoder且支持AVIF时可返回VideoFrame；数据语义优先no-conversion ImageBitmap，适用时VideoFrame→ImageBitmap；都不满足同表示语义/transfer则能力失败，不自动装另一个WASM图片decoder。浏览器srgb/storage alias问题沿donor的fragment mip路径作具名宿主profile，保留它与compute magic/box的实际差异；alpha/coverage不允许在fragment profile静默漏alpha weighting/scale，不能满足时provided chain或明确拒绝，不能冒称等价。E1需分别核真实产品；E0不把API存在性当GPU消费通过。

### 8.2 两种命令入口与初始化活性

正常帧沿`FrameCoordinator`唯一command，在render消费前记录有界ready批次；pipeline/decode异步准备在录制前，不在帧中await GPU。scene初始化沿`RendererCore`现有residency transaction，由composition root接收同一个encode-only recorder；transcoder没有finish/submit权。`ShadeGPUCommandContext.observeSubmission`提供submitted/aborted/failed，fence只负责退休，不回读工作控制。

当前scene准备会长时间持有未提交command；若全部纹理编码后才允许submit，而scratch必须等fence退还，大场景会死锁。新scene事务必须可由原scene owner按预算提交**不公开scene的隐藏准备批次**：每批record→原owner正常submit→异步fence回收，最后publication command只发布完整必需域。并非transcoder每图自submit，不新增frame submit；render运行时准备并入正常frame command。无frame且离线scene bootstrap由原scene owner驱动有界批次，不能等不存在的下一帧。取消已提交批次的输出继续隐藏并fence退休，最后publication可原子中止；scratch不足但当前批已有工作时返回needs-drain，不拿住未提交command等待自己的fence。

BC5 增加的 target bank/format、绑定选择、材质 normal 重建必须贯通 native/coverage/shadow/query 所有实际消费者。不能只改主图 shader；任意图表达式若读取原 RGB，要通过新语义重建或选择保持原语义的 plane，不能读到 BC5 默认 B=0。FrameGraph 只声明宏依赖与寿命，不调度 shader 内部端点搜索。

热路径不调用 Spark 的 `format:auto` GPU readback、不每图等待 `onSubmittedWorkDone`，不把 `getTimeElapsed()` 放生产路径。保留 16×8 等 donor 执行方式起步，不先改成 megakernel 或简易 mode6。timestamp 查询只在测量工具里使用；相关 API 按当前 WebGPU 规范适配，不照搬上游旧计时拼写。

## 9. IO、内存、缓存与失败边界

下表是准备实现的起始容量合同，不是已测峰值；最终创建前同时满足 negotiated device limits、配置和最坏依赖 reservation。容量不足先等待/拆合法批次，不截断、降分辨率或回旧产品。

| 项 | 普通设备起点 | 受限设备起点 |
| --- | ---: | ---: |
| 并发 HTTP / 图片解码 | 4 / 2 | 2 / 1 |
| 单 image 编码 bytes / 解码尺寸 | ≤4 MiB / ≤2048² | ≤1 MiB / ≤1024² |
| VT owner cell / 最大页依赖 | 512² 起，允许 128/256 / 每页≤16 owner | 256² 起，允许128 / 每页≤16 owner |
| encoded in-flight / decoded CPU accounting | 16 MiB / 64 MiB | 4 MiB / 8 MiB |
| GPU 临时 RGBA 输入池 / block+assembly scratch | 48 MiB / 16 MiB | 8 MiB / 4 MiB |
| 几何 Worker / 单 decoded 页 | ≤2 / 256 KiB | 1 / 256 KiB |
| encoded CPU cache / 目录 accounting | ≤32 MiB / ≤8 MiB | ≤8 MiB / ≤2 MiB |

CPU 解码按保守至少 `2×4wh` 收费，RGBA mip 按 `4×Σ(w_l h_l)`，GPU 临时字节与最终显存分别收费；实际 VideoFrame/浏览器复制差异需记录，无法精确控制浏览器内部 decoder scratch，不能称此表为整个进程 RSS 硬上界。超过单 item encoded cap 由 Cooker 重新形成合法 item，不从网络收到后无界扩容。

VT 普通批量3×3的512² decoded邻域为9 MiB GPU RGBA输入；受限256²为2.25 MiB，CPU按至少双份分别计18/4.5 MiB。保守按16个最大cell预留时分别为16/4 MiB GPU输入、至少32/8 MiB CPU accounting；不能同时保留额外ready占满这一最小合法任务预算。单页128网格九依赖为0.5625 MiB GPU输入、至少1.125 MiB CPU accounting。混合尺寸按实际去重依赖逐项求和，不能用最小cell估算大邻居。装配页和block scratch另计，任务整体预留后仍要容纳现有帧临时资源。整个GPU总预算为最终纹理/VT工作集、几何、效果资源、准备临时池与增长双份之和；受限设备没有复杂场景/全效果保证。

cache 只保留有界 encoded 源和正在复用的 decoded 依赖；不保留完整 native replay、完整 RGBA mip 或所有 victim 页。几何 Zstd module 固定内存计入每个活跃 Worker，懒加载，不沿用旧 U0 的每 Worker 两个 16 MiB 模块默认配置。HTTP cache 命中与应用 cache 分开统计，不实现默认 IndexedDB 大副本或压缩块 GPU readback 缓存。

取消后不能假设浏览器立即停止图片解码；未完成工作继续占信用，完成的过期对象立即 close/discard，必要时终止所属 Worker 但不能丢记存量。任务有 session/source revision/device epoch，迟到结果拒绝且释放；device loss 取消 GPU 批次并重开 encoded 来源，只恢复实际需求，不整场景重放。

## 10. 几何：新紧凑布局与成熟无损传输一起切换

本轮默认继续 source-exact：position F32×3、已有 normal oct16×2、UV half2/颜色等既有合法格式；tangent 方向与 sign 分离，只有原有handedness表示精确±1才用bit，其它既有合法值保留原SNORM16等精度档，不能为压紧新布局拒绝旧合同的合法输入。header/offset/padding按真实流压紧，CPU/WGSL共享ABI事实源，最终consumer直接读紧凑字节，不创建全展开position/vertex副本。

网络采用新 page 的 Zstd 独立单 frame、无字典；Cook 对 level9/15/19 有界比较并选最小合法结果，不省字节则写新合同 raw 段。decoded≤256 KiB，frame/window/encoded 上界受检；不是把巨大任意 Zstd 流交 runtime。离线 level 高不代表自动增加同数量级 runtime 工作；实际浏览器延迟和内存仍记录。

现有 meshoptimizer/Nyx 的 LOD、meshlet、weld、source/corner/remap 规则继续复用。旧八组 semantic meshopt 样本不足以否定算法家族，但也不要求为了“采用更多库”额外叠加一个无净收益的 runtime 子流。主线确定为新 resident SoA+Zstd/raw；meshopt 继续承担其已存在的几何生产工作。

新 major 必须一次贯通 native/portable/pthread Cooker、Web ABI、pack reader/validator、Worker/admission、GPU directory/bank、visibility/raster/Surface/VSM/query/motion 与部署 recook。默认源精度不变，旧 U16/U24 合格为0只是旧资格规则的结果，不证明所有精确压缩都不可能；本轮不预埋无用途量化 decoder，也不冒称 geometry 获得纹理同等倍数收益。

## 11. Cost Card 与可检验的收益目标

| 机制 | 减少 | 新增 / expected / worst |
| --- | --- | --- |
| AVIF→GPU BC | 网络 bytes、CPU 专用纹理 WASM/native-ready；最终 BC 采样保留 | 浏览器解码、RGBA upload、编码 ALU/textureGather、block buffer copy；冷 pipeline 与临时峰单列 |
| 常量/通道/去重 | 对应输入、传输、准备、常驻，可完全删除工作 | 离线分析；常量 descriptor/必要 shader 恢复；有损近似须质量预算 |
| base-only GPU mip | 不传普通完整 mip 链；理论少约25%全链像素量，不是固定文件节省 | GPU mip samples/dispatch、RGBA mip scratch；特殊语义使用 provided chain |
| 较大 VT cell | 可提高图片码率、减少请求/任务 | 过取、邻域依赖、assembly samples/copy、decoded LRU；极端稀疏可比小 cell 更差 |
| 普通NPOT精确保域 | 不拉伸源图、不降低原逻辑分辨率 | 无unaligned能力时的padding/边缘扩展、逐层metadata与必要显式过滤samples；不能当零成本UV缩放 |
| 新几何 SoA+Zstd | 实际 payload/padding、压缩传输；不重复计算已有 oct/half | metadata/读数方式变化、CPU Zstd；无新增 position 常驻副本/独立 frame submit |

BC7/BC5 为8 bpp，BC4为4 bpp；2048²基础 RGBA16 MiB、全链约21.33 MiB，BC7全链约5.33 MiB。144² RGBA为82,944 B，BC7页20,736 B，256对齐 block scratch为27,648 B。当前已经用BC，因此新网络方案本身不减少同尺寸同格式最终纹理显存。

设原同工作集传输为 `S`、新增冷模块/目录税为 `F`、实际节省比例为 `r`：0/50/100%收益分别为 `-F`、`0.5rS-F`、`rS-F`。网络收益约 `rS/B`，准备与下载可重叠；不把它直接减去 submit-to-completion 微测当净收益。VT 必须把 fetched overfetch 与重复请求加入 S，不能只算 useful 页。稳态没有新任务时不得无条件 dispatch/readback/分配。

hello 现有15个纹理产品21,092,132 B、几何pack18,026,400 B，非完整场景总量且不是实网字节。旧U0颜色144页AVIF+RGBA内核5,663 B对XUBC7 Q10012,804 B，仅是不同最终质量的小样；旧Normal/ORM只测lossless WebP+RGBA内核，不具备路线否决资格。原始快照保留在 `OEngine/tools/web-asset-u0/results.json`。

作者Sponza的AVIF HQ17.6 MB、LQ6.5 MB对UASTC56.7 MB是[上游案例](https://www.ludicon.com/castano/blog/2026/02/an-updated-sponza-gltf/)，不是本项目预测。目标是同条件不丢上游能力并在有收益的维度推进，不把“成熟上游”写成我们已经更快/更省内存。完整输出分网络大小、首屏、清晰度到达、流送帧成本、CPU峰、GPU峰、稳定帧、质量八项。

## 12. 不保留的路线与实施边界

- 删除“全部 XUBC7 Q100 默认”“Normal/ORM 不进入图片路线”“普通页固定256²”“Spark 已被同质量实验否决”的旧冻结；不是仅在其后追加一个例外。
- XUBC7 和旧 BC+Zstd 留作隔离历史 reference，不进入新生产 import、cache 或失败fallback。旧schema在资源创建前明确拒绝，发布必须recook。
- 不同时下载AVIF与原生BC双份，不默认RGBA常驻，不通过降低分辨率/删mip/删材质/删query省字节。
- 不复制上游独立线程池、renderer、自submit、auto readback 或任意 fallback；直接复用的是完整选定算法，不是整个宿主框架。
- 不把成熟内核重新做一轮路线资格选举；真实数值/生命周期失败修适配根因，只有明确的许可/平台/产品合同冲突才上报具名缺口，不悄悄恢复旧架构。

当前授权推进至E1，实际完成与具名未决事项只读配套执行§12。生产实施按闭包授权推进；模块结束停在边界，不自动进入HDR重构、神经压缩、SCGI或其它效果。
