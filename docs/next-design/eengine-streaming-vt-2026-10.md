---
id: eengine-streaming-vt-2026-10
state: history
supersededBy: ../next-design/eengine-extreme-web-asset-compression-2026-10.md
verifies:
  files:
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - OEngine/src/assets/RuntimeAssetManifestV2.ts
    - OEngine/src/assets/RuntimeAssetPackage.ts
    - OEngine/src/assets/codec
    - OEngine/tools/cook-offline-scene.mjs
    - OEngine/src/gpu/TextureResidency.ts
    - OEngine/src/gpu/GpuMaterialVisibilityAbi.ts
    - OEngine/src/gpu/GpuNativeMaterialPublication.ts
    - OEngine/src/gpu/GpuNativeMaterialScene.ts
    - OEngine/src/gpu/NativeMaterialBindings.ts
    - OEngine/src/gpu/AppearanceProgramRegistry.ts
    - OEngine/src/gpu/GraphicsContext.ts
    - OEngine/src/gpu/GeometryPageStreamingRuntime.ts
    - OEngine/src/gpu/VirtualTextureResidency.ts
    - OEngine/src/gpu/VirtualTextureFeedback.ts
    - OEngine/src/gpu/NativeMaterialPhysicalBanks.ts
    - OEngine/src/gpu/GeometryPageDemandAbiV1.ts
    - OEngine/src/gpu/GeometryDemandReadbackRing.ts
    - OEngine/src/shaders/native_material.ts
    - OEngine/src/shaders/native_surface.ts
    - OEngine/src/shaders/virtual_texture.ts
    - OEngine/src/shaders/vsm_geometry.ts
    - OEngine/src/shaders/vsm_allocate_pages.ts
    - OEngine/src/render/vsm
    - OEngine/src/shaders/native_execution_bins.ts
    - OEngine/src/render/surface
    - OEngine/src/render/program
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/render/SceneRefinement.ts
    - OEngine/src/render/ShadowGeometryWork.ts
    - examples/integrated/dungeon-warkarma-texture-compression/cooked-scene.ts
    - docs/porting/next-renderer.md
---

# Streaming VT：按可见需求流送的压缩材质纹理

> 历史设计/实施记录：原数值、失败与阶段结果保留，不再约束当前实现。当前唯一设计和执行由[workstream](../../project/workstreams/active/eengine-next-clean-rebuild.yaml)导航；旧路径不作为兼容保留。


> 后续更新（2026-10-20）：本文保留原 VT 算法/提交/过滤与历史验证；传输表示已由[无损细页设计](../next-design/eengine-v4-vt-transport-transcode-2026-10.md)与[执行 §7](../next-execution/eengine-v4-vt-transport-transcode-execution-2026-10.md#7-实施与集中验证记录2026-10-20)更新为 schema 2 / Zstd fine / Worker 协议 3。原文“运行期无编解码”仅适用于原生 tail/resident/普通 Product，不再概括 fine。当前模块只读 workstream，旧下一模块边界不自动启动其它路线。

## 1. 决定、目标与边界

2026-10-16，以 `4a52d400` 为源码起点建立本设计；用户随后授权实施VT-1。唯一实施状态、结果和后续边界见[执行计划](../next-execution/eengine-streaming-vt-execution-2026-10.md)，本文规定完整模块目标，不能因CPU产品已实现就认为GPU分页已接通。Streaming VT优先于Local Reflection Probes，唯一当前模块入口见workstream；总体方向见[功能粗路线](eengine-feature-expansion-roadmap-2026-10.md)。

选择 **离线 Streaming Virtual Texturing，压缩物理 atlas、软件页表、Native 显式梯度采样、延迟反馈和有界 Worker 读页**。目标同时覆盖：

- 首屏只等待目录、受保护粗尾和完整 coverage 依赖，取消当前全量 shading payload 读取前置。
- GPU 只分配配置的物理页池；CPU 只保留目录、在途数据和有界缓存。不可见细页不因“最终加载完成”而读入。
- 保留当前 Native 材质图、BC7/BC4、normal/ORM/颜色域、8× RGB 各向异性、Main/VSM coverage、AO/SSSR/Temporal 行为；精化至目标 mip 后保持对应纹理能力。
- 镜头静止后按当前真实工作集收敛，容量不足明确报告；不以全场景所有 mip0 为收敛条件。

实际开发/测量设备为 **RTX 2060 8GB**。GTX 1650 Ti 4GB / 1080p 是既有受限平台目标，必须独立测量才有资格声明支持；不能把 2060 结果写成 4GB 验收。VT 能减少纹理 I/O、常驻量与无需求上传，**不保证采样更快，不解决几何/VSM 全量工作，也不预报节省秒数或净 FPS**。

范围不含 RVT、地形材质烘焙、Probe、GI、多视图捕获、硬件 sparse/feedback、运行期 BC 编解码、自动降质量 mip bias。完整 coverage 依赖和小纹理继续采用合法 resident 资源类型；它们与 VT 共享一个 Native 生产体系。

## 2. 源码证据与改动边界

| 当前事实 | 设计决定 |
|---|---|
| `cooked-scene.textureReady` 去重后读完整 Product，再准备材质，场景 publication 等待这条链 | 启动改成 metadata/directory + tail + mandatory resident planes → 材质/几何可发布；细页反馈独立推进 |
| `TextureProduct` schema3 验证全部 mip chunks，保留完整 chunks 供 replay | 不伪造“已验证完整 Product”。新增 tiled 产品及 directory/provider 合同；旧完整产品验证语义不变 |
| `TextureResidency` 按完整 extent/mip 创建数组，tail-first 只减少先上传的字节 | 虚拟 planes 从独立页池取物理页；不能只给 promote 换个名字，仍分配整张纹理 |
| `CookedAssetPreparation` 已有 Worker、信用额度、task/session/epoch、取消和 transfer | 扩展现有协议支持目录与 tile batch；不创建第二个 Worker 系统，不把 GPU 资源交 Loader |
| `nativeMaterialCoverageProgram` 通过 `selectAppearanceProductProgram` 提取 alpha 的真实依赖 | 用同一图裁剪规则计算必须 resident 的 plane/read-mask/UV 依赖闭包；不能仅按贴图名字分类 |
| `native_material` 查询可执行 C/X/Y 三个位置，RGB 与 exact alpha 分开 | 每个实际执行查询都正确采样/反馈；不能只记录主像素或只扫描固定 PBR 五张纹理 |
| 最宽 Product+compact+lit+SSSR Surface 已用 16 个 storage buffer、4 个 storage texture | 合并同一 Native publication 的 constants/directory，腾出一个反馈 SSBO；保留 SSSR receiver 与 Surface 四张输出 |
| 旧 `SceneRefinement` 依赖 texturesFull，质量键含 publication revision | 改为新鲜当前需求完成度，区分内容 revision 和 residency revision；逐页上传不能重启语义 epoch |

INIT-3 的两次完整 Bistro 记录：首帧约 13.05/13.16s，纹理 fully resident 约 45.29s，view-settled 约 53.82/54.96s；精化期间约 4–12FPS。纹理 202 个唯一 Product / 405 aliases，累计上传 1,034,645,106B，分配 1,051,428,279B；首批 coverage+tails 为 112,078,482B，后续细 mip 为 922,566,624B。完整 CPU replay payload 也约 1GiB，不包含在 Worker 临时信用额度内。原始身份与限制只读 [INIT 执行记录](../next-execution/eengine-initialization-scheduling-execution-2026-10.md)；这些是设计动机，不能当作 VT 结果。

几何当前仍有约 1664MiB banks/metadata 的容量分配、6085 页和约 242MiB payload；`ShadowGeometryWork` 的 shadow demand 还会请求全量相关几何。不得把纹理改为按需就宣布启动瓶颈全部解除。

## 3. 参考组合与移植合同

本模块是有明确接缝的组合移植，不存在一个可原样搬入 WebGPU 的完整 donor。下表决定实施时的核心来源；完整 revision/license/file 映射另见 [Source Map](../porting/next-renderer.md#streaming-vt-2026-10-16设计来源尚未-adopt)。

| 阶段 | 主来源与保留算法 | 必要适配和不采用内容 |
|---|---|---|
| 梯度→LOD、地址变换、缺页向粗 mip 查找、物理显式梯度 | LibVT `renderVT.frag` 的 `mipmapLevel`、`samplePagetableMultiple`、`calulateVirtualTextureCoordinates`、`calulateCoordinatesFromSample`、`sampleVirtualTexture` | 使用项目显式 C/X/Y 梯度、真实矩形尺寸和整数目录；保留非 fallback-entry 查找算法，以上游有效完整尾链替代固定10次后越界采样的错误兜底 |
| 相邻两个虚拟 mip 的确定性采样/混合、packed tail 概念 | Wicked `ShaderTextureSlot::SampleVirtual` | 移植双 mip 结构；实际物理访问采用 LibVT 梯度过滤。不能照搬 `SampleLevel(0)` 后声称保留 8× anisotropy；不照搬固定 packed mip 数、8bit 坐标和 bindless |
| 粗层优先、请求与实际驻留分离、refcount、撤销/救回、淘汰 | Intel `StreamingResourceBase.cpp::SetMinMip/AddTileRef/DecTileRef/ProcessFeedback/AbandonPendingLoads/QueuePendingTileEvictions` | CPU 状态算法移植；硬件反馈换成本项目反馈，reserved resource/copy queue/DirectStorage 换成压缩 atlas + Worker + 正常帧提交。NPOT parent 使用真实覆盖关系 |
| 请求的粗层闭包 | Wicked `virtualTextureTileRequestsCS.hlsl` 的 min-LOD/parent closure | 保留请求所需粗层，改为实际查询页去重后由 scheduler 展开；不建立低分辨率 feedback 图而漏小物体，不扫描所有预留纹理容量 |
| 原子去重与延迟 readback 接线 | 本仓库 `GeometryPageDemandAbiV1`、`GeometryDemandReadbackRingV1` | 复用已存在的 atomicOr 首次命中及完成帧状态机制，独立 VT ABI/owner；不把几何 256KiB 队列/身份格式当万能虚拟资源 ABI |
| 格式/冷 cook/原生绑定与 frame integration | EEngine 当前 TextureProduct、BC cooker、Native publication/FrameGraph | 本地工程代码；不伪称外部算法移植 |

Hork 的 `MakePageResident/MakePageNonResident/UpdateBranch_r/CommitPageResidency` 用作祖先映射交叉参考，**不作为本版主页表算法**：其 POT quadtree、12bit physical index/4bit LOD 和整 dirty mip 上传不适合直接套用本项目。POT/方形以外不能用 `page >> delta` 假装完成 fallback；本版统一使用真实 mip 目录的有界查找，成本明确列在 §10。不能为追求单次 lookup 擅自改变当前 NPOT 纹理内容或地址语义。

移植须完整保留所选 profile 的有效分支、粗尾、跨 mip 过滤、pending/eviction rescue 和迟到结果处理；上游无效输入/平台死分支可按严格本地合同替换并记录依据。来源测试先固定原文计算和合法输入预期，再做 WGSL/CPU 差分；不能用与生产同写的一段 helper 相互证明。许可证和原作者 notice 随实际移植文件保留。当前全为 **selected / planned**，未提升 adopted。

数学参考：J.M.P. van Waveren《Software Virtual Textures》(2012-02-25，§3、§4.4、§5)；Albert Julian Mayer《Virtual Texturing》(TU Wien 硕士论文，2010，§4)。Epic SVT 文档仅辅助理解 lookup/过滤/border 成本，不是开放许可证源码 donor。

## 4. 产品、离线 cook 与输入可用性

### 4.1 独立 tiled 产品

新增 `assets` 下的 tiled texture 产品合同，区分 **不可变目录、可重新读取的 provider、已校验 tile payload、mandatory resident planes**。不往完整 `TextureProduct.chunks` 放 lazy 占位，也不削弱 schema3 validator。

目录至少包含：schema/recipe/source/content identity；每个 plane 的 semantic/format/channel；与当前 GPU 采样一致的每 mip width/height、tile grid、页基址；tail 起点及每级矩形；tile→范围/长度/hash；address-border profile；完整 coverage 依赖的资产身份。布局大小、乘加、偏移、重叠、解压上界、重复 ID、hash 和 mip 连续性先验证，不能创建 GPU 后才拒绝。

入口 manifest 独立认证目录 hash，目录认证各 tile hash。启动验证目录和首屏 payload；其余 tile 在使用前逐块验证。这样保留“消费字节已验证”的完整性，同时明确不再提供“首屏前对未读取全文件算过 hash”的旧时序保证。source/recipe hash 不能替代 payload hash。

首版对不在 coverage 闭包且 max dimension >128 的 shading planes 生成 VT；小纹理与 mandatory planes 为 resident。现行排除格式/资产的限制保持显式，不自动把 VT 错误转成全量载入。BC7 sRGB/linear、BC4 的通道和当前 normal 编码不变；不顺便改成 BC5、重建 normal Z 或换 mip 滤波。

### 4.2 固定 tile recipe 与完整尾部

- fine tile interior 为 **128×128**，四边 **8 texels gutter**，物理 **144×144**，全部 BC block 对齐；末行/列有效范围由目录给出。
- tail 从真实 mip 尺寸的 max(width,height)≤64 开始，直到 1×1 全保留。一个 plane/address profile 的 tail 打包进一个受保护的 144×144 slot，使用固定 block-aligned 子矩形、每级独立 8-texel gutter。
- 64/32/16/8/4/2/1 的带边界外框上界分别为 80/48/32/24/20/20/20。可按两行放置：第一行起点 (0,0)、(80,0)，第二行 (0,80)、(32,80)、(56,80)、(76,80)、(96,80)。矩形/NPOT 的实际 mip 使用不超过这些上界的区域；每级 offset 和真实尺寸写目录，不能按 POT 坐标猜。
- 物理 atlas 只有 mip0。虚拟 mip 过滤由 shader 明确执行，禁止给 atlas 生成会混入邻槽的硬件 mip。

gutter 必须来自**同一源 mip、同一地址模式**的邻域，包括 repeat 负 UV、mirror 的方向和 clamp 边界。现行 sampler 支持同轴 clamp/repeat/mirror、nearest/linear 的范围保持；未支持的混合轴/filter 不能在 VT 中静默转义。相同源用于不同地址 profile 时，分别列出边界 tile/尾部身份，内部相同 bytes 可按 hash 共用冷存储，不强迫复制整套内页。

尽量复制现有完整 BC mip 中未改变的、block 对齐的内页块；边缘/镜像/亚 block 小 mip 和 packed tail 无法等价直接复制的块，**仅在离线 cook** 从现有 mip 算法的输入构造 gutter，调用当前固定 recipe 编码器。不得运行期解码再拼 gutter；不得复用原块中的无效 padding 冒充正确 wrap；不能重新生成另一套 normal/sRGB mip。缓存键含 tile recipe、border/address profile、编码器 revision 和 source/mip 身份。现有 donor `99f52d63aa6799cbdaecfe977111dc5ec3b31d47` 的编码路径不因分页换成低质量实现。

8-texel border 是为现有 maxAnisotropy=8 选择的初值，**不是硬件过滤足迹已被证明的声明**。独立斜视/页角/高频 oracle 必须验证物理梯度足迹；若不满足，修正 footprint/recipe 或增加 border 并重 cook，不能降 anisotropy、偷偷加 mip bias 或放宽容差过关。

### 4.3 Range provider 与 Worker

目录支持独立小文件或 manifest 的有界 range。tile batch 按文件邻接合并读取，初始合并上限 1MiB、允许间隙≤64KiB 且 overfetch≤2×；无邻接则不合并。HTTP 206 必须核对 Content-Range、资源版本和长度；返回 200 不能悄悄缓存整个大包：服务端不支持 range 时使用 cook 生成的有界 tile shard URL，或明确报告输入能力缺失。

扩展现有 `CookedAssetProtocol` 的版本、注册、directory/task/batch/receipt；信用额度在 fetch 前取得，临时/encoded/ready bytes 全部记账。维持现有 Worker 1–4、网络默认4的上界，不启动额外无界并发池。校验在 Worker 完成，主线程用严格 receipt/session/epoch 接收，不重复整包 hash。完整目录仅由主线程资源源记录保留；Worker只注册identity/pack路由，每任务携带最多64条已认证的range记录，不为每个Worker克隆整套页目录。

CPU encoded tile LRU 初值128MiB，pending/ready 沿现有信用额度；缓存限额包含 retained typed-array backing storage。ready lease持有独占的精确大小ArrayBuffer，释放时转移backing store并使旧视图失效，再进入有界缓存；session取消则丢弃并释放额度。目录另按JSON字节与对象/数组开销保守admission，峰值解析也预留临时信用。GPU staging独立16MiB。回放只保留目录/provider/不可变内容身份及有界缓存，device loss后重新取tail和当前需求，不能长期保留所有细页作为replay。

## 5. 所有权、GPU 数据与能力

| owner | 拥有内容与责任 |
|---|---|
| Cooker / tiled product validator | 冷数据、格式、recipe、认证目录、range/shard 映射 |
| `CookedAssetPreparation` / provider | 有界异步读取、验证、缓存、取消和 transfer；不拥有 GPUTexture |
| 新 VT residency/runtime，置于现有 `gpu` 资源体系 | logical handle/generation、页表、格式池、tail pin、scheduler、反馈状态、publication 与退休 |
| `GpuNativeMaterialPublication` / scene | 原生程序/常量/目录/route 快照；消费 VT 逻辑描述，不能因页搬迁重新编译 |
| `SurfaceV4` / FrameProgram | 宏依赖、实际 profile/资源绑定、正常帧内 upload→sample→feedback copy |
| `SceneRefinement` | 消费真实完成反馈，报告 current-view convergence / limited；不指挥同帧 GPU work |

页表为一个 sampled integer `rg32uint` 2D array，`textureLoad` 读取；一个全局页索引经已协商的 row/layer stride 寻址。每 mip 有独立真实 dimensions/grid/base。entry 两个完整u32分别为 physical slot、physical generation，slot=0xffffffff表示缺页并查更粗级；不借generation高位塞flags，不截断资源身份。generation将回绕时须先完成相关旧epoch退休并重新建立身份，不能直接复用。全局页 ID 仅在所属不可变目录快照内有意义，CPU readback 还必须持有 product slot/generation、frame/view epoch 和 snapshot 身份。释放前等最后一个相关反馈/任务/消费者完成，不靠低32bit frame 猜身份。

BC7-linear、BC7-sRGB、BC4 按实际需要创建格式池；physical slot 解码为 atlas tile x/y/layer。基准 atlas 每层 16×16 slots，即 2304×2304，无物理 mip；同一格式多个 array layers 不增加 sampled binding。BC7 每层5.0625MiB、BC4每层2.53125MiB。默认物理池总上限256MiB，含 pinned tails；初始 color/linear/scalar 预算上限128/96/32MiB，按整层向下取整，无该格式就不分配。预算可显式调节，先满足 mandatory bootstrap；不能假定256MiB就能容纳任何目标场景。

原 resident coverage/小纹理仍有独立预算，不能把它们藏在256MiB之外却宣称“纹理总共256MiB”。页表/CPU目录/反馈另列成本；页表和 immutable GPU route 数据合计配置上限32MiB，CPU目录（含原始bytes与解析表示）上限128MiB，初版 admitted virtual pages 上限1,048,576。超过 metadata/页数/池/绑定 limit 在创建前明确拒绝或由用户调整配置，不能丢尾页、截断 ID 或自动改质量。

材质每个 execution bin 的**完整资源 union**必须包含实际 resident banks、VT 格式池和页表；按现有 `NativeMaterialPhysicalBanks` 机制形成合法 bins，不按材质实例逐 draw。取样纹理/sampler/array layers、storage buffer/binding size、buffer size、纹理尺寸和 BC feature 共同协商；不能只数 VT 的四个 sampled views 而忽略光照、VSM、AO 等已有资源。BC 不可用时沿项目明确能力错误，不用 runtime RGBA 展开兜底。

### 5.1 腾出反馈绑定，不增加 Surface 输出

将 `GpuNativeMaterialPublication.constants` 与 `.directory` 合成一个不可变 `u32` buffer：小 header 给出 word offset/count，目录每条仍为原始32B，常量按 f32 原始 bits 存放。单一 accessor 读取原字段/bitcast 常量；完整 identity/value/resource revision 与 Seed 语义保持。

原子更新 `native_surface`、`SurfaceV4` 的 frame resources/bind groups/cache keys、`NativeExecutionBins`、`native_execution_bins` 以及全部直接测试/consumer。主目录与常量不能同时保留另一套 production buffer；rasterConstants/rasterDirectory 是 coverage 自身产品，继续独立。合并在冷 publication 创建时进行，不每帧 repack/copy；超过 maxStorageBufferBindingSize 先拒绝。

由此最宽 Surface 从16降至15个 SSBO，加入一个 VT feedback 后回到16；storage textures 仍4。反馈 buffer 含 header/bitsets/queue 的 offsets；不用额外 storage texture 或第二个反馈绑定。不改 SSSR 的32B receiver，不将 VT 生命周期塞入 SSR/Temporal owner。

## 6. Native 采样与 coverage

一次 Native texture query 的完整算法为：

1. 取得与旧路径相同的原 UV 和显式 dx/dy，以及源 texture 的真实采样 dimensions。先计算导数，再做 wrap；repeat 用 floor 处理负值，mirror 保留反射方向，clamp/gutter 复现当前地址行为。NaN/退化导数按有限合同处理，不能造成越界。
2. 按 LibVT anisotropic `Pmax/Pmin/N` 结构求 lambda，向量乘真实宽高；N 受8²限制，零导数给出放大采样的合法极限。依据源 mip clamp 夹到完整虚拟链；不得把“当前 resident 最细级”当目标 LOD。
3. linear profile 对 floor(lambda) 和相邻 coarse mip 分别求页。每级均使用该级真实尺寸和页坐标，未 resident 就逐级查至受保护 tail；到达 tail 用目录矩形。查找次数受实际 mip count 约束，绝不返回未初始化槽。若两个查询解析到相同 mip/slot/rect，可做精确 CSE。
4. 在解析到的真实 mip 计算 `uv × mipExtent − tileOrigin + gutter`，转换 atlas 坐标；dx/dy 同样缩放到该 mip/atlas。使用 mip0-only、linear、maxAnisotropy8 的 sampler 做 `textureSampleGrad`。跨虚拟 mip 在 shader 确定性 lerp；fallback 仍使用正确原 mip 权重，不能把不同 mip 的 UV/梯度混用。nearest profile 保留 nearest texel/mip 语义，不强行双线性。
5. sRGB 硬件解码、BC4 channel routing、normal decode、alpha 和 Native C/X/Y 求值仍由原有语义层执行；不增加第二次材质求值。
6. 对两个目标页记录 demand，对实际 sample 的 fine/tail 页记录 usage。C/X/Y 每个真实执行查询、纹理驱动 UV 和 custom graph 均覆盖；精确重复 query 只允许语义等价 CSE。gutter 已包含过滤邻域的源数据，不需要同帧把邻页调入才可过滤。

LibVT 和 Wicked 的组合是本地明确适配的 deterministic trilinear/anisotropic profile，**不承诺与某显卡 resident 隐式 LOD 的每位结果相同**。必须用独立图案验证 LOD、通道、normal、sRGB、负 UV、NPOT、page corner、mip transition、斜视与 tail，并为可接受的过滤差异给出算法/精度依据；不能用“移植”跳过数值检查。

coverage 以实际 alpha 输出后向依赖闭包为准，包括 RGB、UV 变换和间接 texture query。仅依赖原 exact R8 时，该 R8 完整 resident，RGB plane 可以 VT；依赖 RGB/normal/ORM 等数据时，对应源 plane 也完整 resident。不能只给 alpha 值保底却让决定 alpha 的 UV 缺页。Main Visibility、VSM raster 和 Surface alpha 共用既有原生 coverage 合同；VT shading 精化不得改变 coverage、重建 VSM 内容或抖动 winner identity。

## 7. 反馈、调度与帧事务

### 7.1 精确查询反馈，正常帧延迟读回

不增加 feedback geometry redraw，不抽样跳像素，不依赖 subgroup/64bit atomics。每个 Surface feedback slot 使用同一个 SSBO：header、wanted/used/union 三个 bitsets、首次 union 命中的 append queue。移用本仓库 atomicOr 首次命中机制，wanted 与 used 保持可区分；同页同帧只 append 一次。slot 包含容量/overflow/epoch，offset 与数组边界创建时验证。

基准 append capacity 65,536 个 u32 页 ID，正常 readback 固定 header+256KiB queue；CPU 根据当帧不可变目录恢复完整身份。页数P时三 bitsets为3×ceil(P/32)×4B。overflow 后仍完整置 bit，不能只保留先到的65,536条而遗忘余下页。下一次普通帧提交复制该**仍被保留的 snapshot bitsets**，CPU 全量恢复本次有界 admitted domain 的 demand/usage 后才可回收 slot；这是异常恢复路径，不常规全表扫描。缺少恢复结果前不可报 settled。

使用3个独立帧 slot；free→encoded→submitted→mapping→ready/recovery→free。只 map 已完成提交，主帧不 await。无空槽时本帧可继续从已有页表渲染，但反馈记录缺口必须计入 freshness/limited，不能报新鲜收敛；不复用 GPU 仍在写/CPU仍在映射的 slot，不通过私有 submit 解堵。

### 7.2 CPU 调度与有界工作

移植 Intel 的 desired/refcount、pending load、resident、pending eviction 状态区别；先处理新反馈及 rescue，再决定撤销/淘汰。当前 view miss 优先，粗覆盖优先于细化，多个相同需求合并；used 页只维护年龄，不重复 I/O。NPOT/矩形的 parent closure 按真实归一化覆盖交集建立，不能盲用 x/y 右移；祖先不是目标 mip 的替代完成条件。

provider/网络/CPU ready/GPU staging/页池五层信用分别记账，暂停不等于丢任务。默认每帧上传上限4MiB、128 copies，单个 staging≤256KiB，live staging≤16MiB；同时限制 CPU admission 工作量，已完成大批任务不能集中在主线程逐页 hash/重编。低 FPS 时每帧预算会拉长墙钟时间，实际结果须报告，不能写成固定时长保证。

容量不足时 protected tail 永不驱逐，近期使用页以真实已观察反馈帧和 completion fence 判断年龄；持续 miss/反复下载记为 pressure/thrash/limited。缺少反馈时保守保护，不能把 completion clock 当 usage clock。调度不得无上限尝试 resident→evict→reload；无空间则保留 coarse fallback 并报告目标工作集超预算。v1 不自动增 mip bias；调整质量需显式授权和设置变更。

### 7.3 publication、abort、复用与 device loss

目录/content identity、logical handle generation、physical slot generation、residency revision 独立。tile 上传只改 residency，不改材质值、PSO key、Temporal identity 或 VSM coverage revision。池/页表对象更换需要真实资源绑定快照切换；slot 内数据更新不重编 Native program。

帧顺序为：VT admission/ready selection → 正常 encoder 内 BC copies → 页表有效映射更新 → Native Surface → feedback finalize/copy。FrameGraph 声明真实资源读写，queue-order 保证 consumer 不读半上传页；CPU active 状态只在对应帧提交成功后推进。不能先 `queue.writeBuffer` 公开新映射再等待稍后 copy 的 payload。

淘汰必须先安排旧映射失效、保证所有旧提交读取已被队列顺序或已完成 fence 覆盖，再复用物理槽；旧 CPU feedback snapshot 的身份仍保留至读取完毕。不能用“隔两帧”替代安全性。若使用队列顺序优化重用，须覆盖编码后 abort、未提交候选和 resource retirement，禁止跨提交读写竞态。

submit 前失败/abort：不推进 active map/slot owner；保留或取消 ready credit 按单一所有权处理，重试幂等。提交后失败/device loss：旧 device epoch 全部结果失效，释放 GPU 与任务所有权，目录/provider可重建 tail 与需求；不能将旧页 receipt 发布到新设备。replacement/release 取消旧请求，迟到结果核对 session/product generation/task epoch 后释放，不能污染新 slot。尾链或 mandatory 数据验证失败需明确失败，不能靠永久默认色继续声称场景完成。

## 8. 启动、精化与公开诊断

`cooked-scene` 必须一起改变：读取目录/mandatory payload → 建立逻辑引用和首批 tail → 准备 Native route/PSO → 发布初始 scene；细页不再进入 `textureReady` 的全量 Promise 前置。aliases 仍按真实内容/recipe/profile 去重，不能用 URI 相同就合并不同语义。

`SceneRefinement` 对纹理使用 `demandPending / demandComplete / capacityLimited / failed` 及 frame/view/content/profile epoch。完成需要新鲜当前视图反馈、无未恢复 overflow、无所需页缺失/校验/上传/发布 backlog，并延续当前“最后发布后两次新鲜确认”的观察原则；对已知不可满足目标报告 limited，不冒充 fullyResident。只完成 ancestor 不等于目标 mip 已完成。镜头变化启动新 view epoch，tile residency 变化不启动 content epoch。

与几何/VSM convergence 保持组合观察，各自真实未完成原因分别输出。VT 不降低 VSM 更新质量、不强制全局同步，也不把纹理反馈接成同帧 GPU→CPU→GPU visible/work control。

只增加有真实消费的设置/诊断：物理/metadata/CPU缓存预算、请求与上传上限、target mip/actual mip、page/tail/miss/pressure计数、pending/overflow/readback age、range fetched/overfetch/失败任务、CPU/GPU bytes。VT-3当前提供owner evidence与demo/export，不声称已有逐像素VT debug overlay；失败任务包含取消/重试，不等于hash失败次数，保留错误message区分根因。fetched/hash字节目前统计成功receipt，失败请求已传输部分不在该计数内，不能称网络总流量。设置经 `RendererConfig` 初始profile交到VT owner；本轮配置不可变；运行期预算/池尺寸/绑定布局变更通过重建Renderer实施，没有未验证的热resize API。后续确有consumer需求时再设计候选资源→完整切换→fence退休，不原地破坏在途帧。tile recipe属于冷产品，不能运行期改一个参数就解释旧payload。

无VT consumer时不声明页表/反馈产品，不分配页池/readback或调度任务；不增加一个关闭VT后自动读取完整大纹理的兼容开关。默认配置必须经 limits 和 mandatory 容量 admission；统计关闭时不要每像素 atomicAdd 计数。小计不能漏 resident coverage、normal、atlas rounding、旧新对象重叠和 pinned tail。

## 9. 切换与删除

VT-1 只建完整 CPU 产品/提供者闭包。VT-2 将 GPU owner、Native publication/采样/反馈、provider调度、bootstrap 与 convergence **作为一个生产单元切换**。允许该单元内部暂时编译断链，不发布半套系统。

对选中 tiled planes，删除旧“读完整 Product→完整 extent 分配→遍历 promote 到0→texturesFull”的生产依赖与无界 replay；更新全部直接 consumer 和演示入口。保留真正 resident 的 coverage/小纹理与原完整 Product 支持，不另建 renderer/VM/legacy VT 后端。测试中可保留独立 resident reference 用于数值比较，不把它接成生产运行期静默降级。

不恢复旧 effect/renderer owner，不新建万能 VirtualResourceOS/EffectsManager，不把所有资源缓存都抽成一个框架。不同时实施 Local Probes 或几何物理页 ABI 重构。

## 10. Cost Card 与风险

| 工作 | 理想 / 常规 / 最坏与上界 |
|---|---|
| GPU 分配 | 删除选中 plane 的完整 mip array；新增按实际格式分配的有界 atlas，预算包含 tail；resident coverage/小纹理、页表、反馈单列。替换时旧新对象 fence 重叠须纳入同时峰值 |
| Tile bytes | BC7 144²=20,736B，较128²额外26.5625%；buffer→texture 每行576B→768B、36行，staging27,648B。BC4为10,368B，row288→512、staging18,432B；实际 payload与staging不能混账 |
| lookup/sample | 完全驻留目标通常两个 page loads + 两次物理 gradient samples；精确相同解析可复用。miss 时每个虚拟 mip最多查到 tail，按真实 mip 数而非固定10次。16K源 tail从mip8起，单次两级查找上界≤18个entry loads，另有route/tail数据访问；C/X/Y可放大到三次 |
| 采样 ALU | 加真实尺寸LOD、wrap、page index、循环、物理梯度和lerp。理想cache全命中仍有此税；不可用节省I/O推导其GPU采样净收益 |
| 反馈 | 每个实际 wanted/used 标记含 bitset atomics，union首次命中才 append；高共享页有竞争，高材质/UV熵接近每次新页。不能声称“每页一次atomic”：每查询仍做去重atomic。3slot常规GPU scratch约3×(header+3P/8+256KiB)，CPU readback另记，P≤1,048,576 |
| 页表/上传 | CPU维护真实resident entries，只上传有变化的合并行段，不整dirty mip重传。4MiB/frame、128copies、16MiB staging 有界；批内 payload→mapping 顺序不增独立submit |
| dispatch | 常规反馈直接append，无全虚拟容量 GPU 扫描、无feedback redraw。清零/必要finalize按有界slot批处理；CPU overflow恢复才读全bitsets。trace/Surface仍既有调度 |
| CPU/I/O | 首屏由全payload变目录+tail+mandatory；后续0/50/100%纹理页需要时，读取节省约为未需payload减目录/border/overfetch，全部页最终需要时可能读得更多。CPUcache128MiB，不保留整套replay |
| 工作集 | 可见页远小于全场景时最有利；全场景被访问且超池时会thrash。尾链保正确可用，limited保诚实，不能靠自动低质量伪造收益 |

**优化收益口径：** 对避免细页加载/整分配的收益，分别记录0/50/100%需求下的 bytes、requests、hash、上传与墙钟；break-even 是跳过的 I/O/上传/常驻收益能否覆盖 directory/gutter/反馈/查表的实际额外成本。若当前完整工作集始终更慢，报告真实边界并定位；不把功能可运行、预算有界或2060稳定60FPS直接等同“AAA+性能完成”。

主要风险：NPOT fallback 多查表；8×过滤/页角footprint；coverage导致节省受限；feedback高竞争与overflow；pool format分配失衡；压缩边界离线重编码；低FPS延迟；服务器range能力；大geometry/VSM剩余瓶颈。验证和修复在本模块闭合，不拿最终整Renderer性能延期代替当前正确性。

## 11. 验证与闭合原则

按[执行计划](../next-execution/eengine-streaming-vt-execution-2026-10.md)分三个工程单元。开发前中期仅必要 typecheck、shader compile 和极小格式/算法 oracle，不每个 patch 跑全库/GPU/Bistro；完整闭包后集中检查 build、新鲜 Node、独立算法/生命周期、真实GPU、完整目标场景和粗成本，GPU作业串行。

不写成移植即正确：源算法、WGSL和真实Native调用三者必须对上。已有 Product normal 数值失败在 INIT 中独立复现于 `419d7a28`，继续保留原失败身份；本轮 VT normal/导数/LOD 仍有独立必需检查，不能继承一个“全部豁免”。未跑、必需失败、容量不足或未完成的生产consumer如实未完成。

正式多设备全Renderer P50/P95、完整最终画质/claims与4GB OS驻留资格留 F11；本模块必须具备实际可用的VT、正确coverage/过滤/生命周期、有界同时峰值、完整场景启动与采样成本记录。闭合后停在 Local Reflection Probes 边界，用当时源码重新细设计。


## 12. VT 后虚拟资产与初始化复审（2026-10-16）

用户在VT-3后授权继续修复效果、性能和架构问题，连同几何流送/VSM/首帧链一起检查；不自动进入Probes。以2f6b66fd为本轮起点，实际结果只写执行计划§9。保持既有产品、完整过滤与单提交合同，不以丢feedback、降质量或缩场景取得提速。

完整Bistro近景、相同shader/页表/采样的反馈诊断开关true→false→true，Surface中位约38.33→10.87→38.64ms。几何此时仍在精化并引发VSM重画，整帧数字不能用于净收益。生产不能关闭反馈。方案是对**帧内只增不减的wanted/used位**先atomicLoad，已置位即返回，未置位才atomicOr竞争首写；首写继续union去重、append和overflow恢复。没有采样子集、跨帧缓存或新GPU资源。

| 机制 Cost Card | 工作、上界与取舍 |
|---|---|
| 单调反馈首写 | 重复query删除kind和union两次全局RMW及union头读取；增加一次kind bit atomicLoad。0%重复多一次load，原RMW保留；50%重复约一半免RMW；100%重复除首写外全部免RMW。原完整位域/queue不变，无barrier或新能力要求，需真实GPU复测 |
| bootstrap有界并行 | entry串行改为最多4entry并行，共用现有Worker/IO/byte credits；单entry顺序处理完整tail/mandatory。无新Worker/submit，最多4个在途lease，仍受ready64MiB、encoded32MiB、temporary256MiB与既有GPU staging总额约束。无稳态税 |
| 稳态调度 | 无ready时不扫描/排序全部resident；仅满池需要淘汰时构建该pool候选。pump仅在需求/IO/lease变化时扫描，4batch已满时不生成待发列表。无新GPU工作，保留粗层优先/完整NPOT父级/救回/失败重试/回滚 |

初始化指标分catalog、directory、bootstrap上传、Surface/raster program ready、geometry roots、首次FrameGraph准备、首completed；不能把一个Promise.all命名成纯pipeline耗时。几何/VSM保留按damage精确失效方向；不能为减少重画漏caster，不能以主视图SSE代替shadow质量。需要修改时先补owner和成本，整体切换生产路径。


本轮进一步定位：全局atomicLoad仍需约29.5ms Surface。采用1KiB（256×u32）workgroup direct-mapped mailbox，每个page/kind存完整非零键，atomicExchange相同键才免全局反馈。冲突只额外记录，不丢需求；首写者在同dispatch结束前完成全局记录，finalize在下一pass消费。没有barrier，兼容Surface所有提前return。0%重复增加一次共享原子与1KiB shared/初始化；50%重复减少一半全局header/bit访问；100%重复每workgroup每键只一次全局记录，跨workgroup继续monotonic位去重。baseline不依赖subgroups，不改LOD/纹理样本数，新增shared必须在完整Surface pipeline真实编译和高竞争/碰撞oracle检查。

管线拓扑修正：原VT callback把mip数量/tail写成WGSL字面量，并按可变mip数追加常量，导致相同graph不同贴图尺寸衍生不同shader/后续slot偏移。改为每query固定15层route（16384最大extent→15层）及levels/tail实例常量。新增每query至多400B常量（相对1mip的28B，固定route加levels/tail共428B），完整常量域与预算照常preflight；实际查询只读真实选中层，不扫描padding。删除仅因extent/mip不同的pipeline编译，不合并不同材质图或资源类型/采样器拓扑。不加runtime VM，不二次求材质。代价是少量冷metadata与动态levels/tail读取，需完整场景检验编译数/墙钟和GPU。

VSM复审采用完整页工作额度，而非扩大pair缓存：已有allocation先给出coarse/request/age排序候选；相同保守相交算法先按physical slot统计每页pair数量，GPU顺序选择总pair不超过已有容量的完整页，再以每页prefix+cursor写入精确pair域。未选页保留dirty/content无效，已有最老页置首保证公平；第一不可分割页超过容量时只让这一页走完整implicit。第二次相交严格复用同一函数/矩形与gutter，不能只保留前C个pair。Shadow需求/usage遍历不缩减，raster/clear/commit均消费筛选后的同一allocation版本。
Cost Card：最多residentSlots×16B scratch（高档14,400B），多一次相交遍历、一次有界候选prefix、每overlap一次slot counter；换掉多页溢出时source×dirty×bucketVertices域。0%溢出增加计数遍历成本，50/100%溢出收益依实际draw域，不能预先称净快；单页仍可昂贵。不新增submit/readback/CPU可见工作控制，abort不改变active页内容；须独立比较完整每页pair集合、跨容量公平性/abort和Bistro实际成本。

Native compile admission：冷启动实际9个不同resource/graph family并非132材质实例各编译；单job异步PSO约3–4.6s，原4job队列形成三波。诊断4/8/16上限的首completed分别18.95/15.45/13.35s，目录时刻4.38/4.48/4.75s。默认改16，并保留128family/512KiB source硬限，最多8MiB在编source，driver内部内存另计；不随硬件线程数无限扩展，不换VM或删材质算法。getCompilationInfo/失败/device loss/lease仍完整。Worker不能消除driver异步编译等待，原资产Worker继续负责IO/认证。

受限池的IO admission必须和物理可发布容量相连：先满足粗层，同级保留仍有需求的resident/in-flight页；扣除所有活跃batch持有的ready/pending lease，只对free或满足既有usage cooldown的reclaimable slot发起新读取。没有slot时等待后续新鲜反馈，不反复从Worker cache取得随后被丢弃的tile；观察used仍保护实际fallback，目标缺页继续limited。只在存在missing候选时统计slot，不给完整稳态添加resident扫描。Cost Card：压力下增加有界pool扫描与batch计数，删除不能发布的IO/transfer/认证receipt churn；无新增GPU资源或shader工作。used消失或lease归还后恢复原pump，不锁死取消/重试。

Graphics总账按device共享geometry ledger只计一次原始bank和metadata；容量、实际payload与slack分别解释。沿INIT已批准边界保留256KiB逻辑页单槽ABI，本轮不半迁移几何寻址；跨资产Cooker紧凑打包或变长GPU分配须成为独立完整单元，不能靠扩大池或缩影子工作量替代。复审中细视图VSM曾因TAA边界持续evict而limited，下述冷槽优先处理；真正容量不足仍可limited，诊断使用现有延迟72B receipt拆出miss/eviction/coarse/failure/pending，不增加同步。不把未收敛晋级为view-settled，进入limited必须撤销之前同epoch的settledAtMs。

VSM回收顺序沿现有free/reclaimable×coarse/fine四类保持合同，每类内先选超过8个submitted-frame未访问的冷槽，再选近期槽；后者仍可在容量不足时被回收，不丢本帧请求、不把历史需求永久pin。使用已有last_visited，不增加history资源；Cost Card为每slot一次年龄比较、第二次64lane prefix和一个vec4计数，删除边界页优先于真正冷槽被来回替换的重画。单元需重跑有界容量/年龄公平/scroll和Dungeon近景，不能只靠减少evictions认定画面正确。
