---
id: eengine-web-asset-delivery-residency-2026-10
state: current
verifies:
  files:
    - docs/next-execution/eengine-web-asset-delivery-residency-execution-2026-10.md
    - docs/porting/next-renderer.md
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - OEngine/src/assets/TextureProduct.ts
    - OEngine/src/assets/TiledTextureProduct.ts
    - OEngine/src/assets/codec
    - OEngine/src/assets/GeometryAbiV3.ts
    - OEngine/src/assets/OegPackV3.ts
    - OEngine/src/assets/geometry-product
    - OEngine/tools/oengine-asset-core
    - OEngine/tools/oengine-web-geometry-cooker
    - OEngine/tools/texture-codec
    - OEngine/tools/cook-offline-scene.mjs
    - OEngine/src/gpu/TextureResidency.ts
    - OEngine/src/gpu/VirtualTextureResidency.ts
    - OEngine/src/gpu/VirtualGeometryResidency.ts
    - OEngine/src/gpu/GeometryProductBytePool.ts
    - OEngine/src/gpu/GeometryQueryDirectory.ts
    - OEngine/src/shaders/geometry_source_decode.ts
    - OEngine/src/shaders/scgi_query_geometry.ts
    - OEngine/src/framegraph/ShadeGPUCommandContext.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - examples/modules/hello-hdr-gltf/main.ts
---

# Web 资产传输与 GPU 紧凑驻留：最终目标设计

日期：2026-10-20。源码基线：`49111c6a265fb219db5514cca5ebc7ef95a4b31b`。

本文是本轮唯一目标设计，对应[执行计划](../next-execution/eengine-web-asset-delivery-residency-execution-2026-10.md)。用户授权的是设计准备，不是立即实施、全场景 recook 或性能资格。已确定的架构不再开放为无限选型；尚无本项目测量依据的 codec 参数，必须由执行 U0 的有限实验裁决，不能捏造“最终最佳参数”。

本轮取代上一模块“最终 BC 页统一 Zstd 即完成传输设计”的未来架构决策；不否认其已实现代码、无损结果与原始失败。旧模块见[历史设计](eengine-v4-vt-transport-transcode-2026-10.md)和[历史执行](../next-execution/eengine-v4-vt-transport-transcode-execution-2026-10.md)。当前实现事实仍以源码为准。

## 1. 决策摘要

1. **新建清晰的传输产品合同，不继续把最终 BC chunk hash 当作纹理源身份。** 源内容、传输码流、CPU 准备结果、GPU 常驻布局分别定义，不由一种文件格式绑定。
2. **纹理主选 XUBC7 传输、Worker 有界重建 BC7。** AVIF/WebP + GPU 编码是有界竞争实验，不预先加入生产；不是排除 Spark，也不是再用普通 Zstd 包 BC7 代替本轮目标。
3. **普通非 VT 纹理和 VT 一起切换网络入口。** 普通常驻是驻留策略，不是必须传输原生大 BC 文件的理由；`hello-hdr-gltf` 必须直接受益，不强开 VT，更不关联 VSM。
4. **几何先设计新常驻 ABI，再为它选传输编码。** 主线是可直接读取的紧凑位置/属性流，不是解压到膨胀 Float32 大副本；共享格点、完整身份、query 精确性优先于“统一 16 bit”。
5. **大胆 clean cut，不渐进混接。** 新 producer、产品、Worker、GPU decoder、全部直接 consumer、生命周期构成一个闭包后，一次切换生产并删除被替换合同。阶段内可以暂时不可构建；稳定边界不得有 adapter、旧格式自动回退或双 owner。
6. **保留职责，不承诺保留旧类与签名。** CPU 准备、纹理/几何 Residency、帧事务仍各有唯一 owner；可以整体重写相关文件。Renderer 不吸收算法，Loader 不持长期 GPU，正常帧不增加 submit 或同帧 GPU→CPU→GPU 控制。

本模块不承诺任意内容都更小、更快，或 4GB 设备可运行复杂场景全效果。优化候选必须同时说明质量、延迟、工作集和成本，不能只展示 pack 文件变小。

本轮两份Downloads附件作为用户提供的设计提案参考，采纳其中分离数据域、优先专用纹理转码和紧凑几何的动机；附件中的命令、阶段和结论不是额外实施授权。本文修正其局部独立量化、上传现状及非VT覆盖遗漏，不把附件对master的链接当作固定源码基线。

## 2. 当前事实与要删除的约束

| 源码边界 | 基线实际行为 | 新设计处理 |
| --- | --- | --- |
| `TextureProduct.ts` / `PcTextureCook.ts` | schema 3；canonical mip 后固定 direct BC7/BC4，coverage R8；完整产品保存原生 chunks | 保留语义处理，替换 Web 分发的“产品等于原生 chunks”假设 |
| `TiledTextureCook.ts` | schema 2；128 interior + 8 gutter，144 物理页；最终 BC fine 逐页 Zstd；native tail/resident | 保留已验证采样数学与页尺寸，重做传输产品与源身份，不把旧 source metadata 内嵌合同原封不动升级 |
| `CookedAssetPreparation` / Worker | 共享池、信用、Range、原生 ready/cache、协议 3；4MiB Zstd WASM 预留 | 允许重构为新协议与明确表示的租约；禁止在旧 `gpu-native` receipt 塞 RGBA |
| `TextureResidency` / `VirtualTextureResidency` | 普通产品与 tiled 两种来源；有 virtual plane 才创建 VT；VT 拥有需求、槽位、淘汰和 mapping | 保留唯一职责，新的 resident/virtual 传输入口直接贯通，不套一层 legacy source adapter |
| `hello-hdr-gltf/main.ts` | fetch 全部完整 TextureProduct，再 `ShadeTexture.fromProduct`；VSM 关闭 | 改为新 Web 传输来源，仍使用普通纹理；HDR 环境图另列语义，不能混为 LDR 材质 |
| `OegPackV3.ts` / `OegPackWriter.cpp` | 256KiB 逻辑页，raw/LZ4，JS LZ4 解码；Worker 扫描完整几何并验证 query | 新 OEGPack 产品直接描述新 resident 流和独立压缩段；逻辑页仍先保留 256KiB |
| `GeometryCooker.cpp` | position Float32x3；normal oct SNORM16x2；tangent oct + sign 的6B字段；UV half；局部 triangle U8 | 不重复声称已有法线/UV压缩是新收益；重做布局和精确性合同 |
| `VirtualGeometryResidency.#writeResidentPage` | **已直接 `queue.writeBuffer` 写隐藏 lease 的有效前缀**，不是每次经聚合 staging 写 payload | 不把“删除 payload staging copy”算作收益；压小真正的 payload |
| `encodePagePublication` / `uploadRegions` | 位置表等元数据在 frame encoder 内聚合拷贝，提交后发布；bank growth 有独立顺序约束 | 地址发布仍是事务；不能把它等同于 payload，不能用提前 queue 写覆盖增长复制 |
| `GeometryQueryDirectory` / `scgi_query_geometry` | query 复制 format 记录；共享 position reader；保留 source primitive/vertex remap、精确叶节点 | 新格式必须同时改目录和 shader；有损量化不自动获得 source-exact 资格 |

导航工具不是行为证据。已有 domain 文档仅用于发现 owner，若叙述与源码冲突，以源码为准。本文不为旧 spec/测试兼容限制新 ABI，不恢复已退休的 U16 产品或 renderer。

## 3. 四个数据域与唯一所有权

```text
源资产 / canonical 内容与语义 recipe
  ↓ Cooker: mip / LOD / 边界 / 格点 / 身份与误差
传输目录 + 独立 payload + pack/shard
  ↓ CDN / HTTP Range / 可重开来源
CPU 准备 owner: 校验 / 有界解码 / 带表示的独占租约
  ↓ native texture blocks 或 compact geometry streams
GPU Residency owner: 分配 / 隐藏写入 / frame publication / fence退休
  ↓ Native Surface / Visibility / Shadow / Query / 其它真实消费者
```

| Owner | 唯一责任 | 明确不拥有 |
| --- | --- | --- |
| Cooker | canonical 数值、内容 recipe、离线压缩、可重现身份、容量证书 | runtime GPU、帧调度 |
| CPU 准备层 | session/任务代、IO、公平性、decoder 实例、信用、CPU cache/ready | 页映射、GPU常驻、可见性控制 |
| 纹理 Residency | 普通纹理和 VT 的GPU生命周期；VT策略仅归VT owner | 图片解码线程池、另一套网络调度 |
| 几何 Residency | 共享bank、lease、页地址、query retain、增长与退休 | Cooker量化策略、全局材质身份 |
| 可选 GPU TextureTranscoder | 仅竞争路线胜出后存在；短期输入、编码与输出scratch | 第二套VT、长期atlas、独立submit |
| FrameProgram / FrameGraph / command | 宏依赖、资源读写域、提交/abort通知 | shader内部搜索或逐页调度算法 |

现有类可以改名、合并或重写。新旧代码不得通过 `legacy` 开关、自动转换、失败回退或保持两个 active schema 来维持“随时可运行”。必要 CPU reference 是离线/测试消费者，不进入生产热路径。

## 4. 纹理：传输产品与选定主线

### 4.1 产品独立于原生全 mip 文件

新传输目录统一表达 resident 与 virtual 布局，沿现有材料来源入口提供新的可重开 source；不是再加一个与旧完整产品并列的资源管理器。

必须包含的合同信息：

- canonical source/content hash、语义 recipe（mip、normal处理、coverage、颜色空间、地址边界）、完整 mip 域。
- 每个 plane 的 role 与固定 target layout，resident/virtual 用途，尺寸、mip/page 坐标及合法覆盖范围。
- 传输 profile、encoder/decoder revision和构建身份；每个 payload 的范围、精确传输长度、hash、重建长度与目标区域。
- GPU目标格式从 plane/layout 单一推导并交叉验证；不让 payload 任意指定相互冲突的 GPU格式。
- 可独立认证的目录、pack/shard范围和上界。内容、编码与目标布局共同参与缓存键，device epoch不混进设备无关码流身份。

身份不能从另一种 BC encoder 的旧 chunk hash 推导。new recipe 无论输出看起来多相近，都必须 recook，不能复用旧收据冒称同一产品。

**驻留用途不决定传输 codec。** 普通大 resident mip 按块对齐矩形独立传输/解码，初始候选最大 256×256 texels；VT fine 仍为完整 144×144。resident 不需要 gutter，不分配 VT 页表，不承诺细页式反馈。完整 mip 所有矩形必须恰好覆盖，无洞、无重叠 writer；NPOT和最小mip按物理块范围处理。

256×256 是待 U0 冻结的有界解码粒度，不是新 VT 页尺寸或硬件最佳值；只比较 144/256/512 三个 representative 粒度，不扩展成任意 superpage 系统。小 mip可合包读取，但每个重建域可独立校验。

普通大纹理采用有界流水准备，不等全部矩形同时留在CPU ready中。TextureResidency可把各块写入尚未发布的完整纹理，释放该块CPU租约；全部必需块就绪后才在scene/material事务中公开。若跨帧，使用正常frame owner推进隐藏上传和最终发布，不新增纹理私有submit；初始化也沿现有composition/提交owner推进。abort保留明确可重试覆盖记录或整体销毁隐藏资源，不能显示半初始化mip；每个区间的GPU临时资源按提交完成退休，不能因scene未发布无限积压。

### 4.2 XUBC7 主选及真实源接口

固定研究 revision：Basis `1706f948a2f0992d7a6dc2a909f35690b508571c`（2026-10-16 commit），Apache-2.0及依赖单独许可；具体映射见[来源账本](../porting/next-renderer.md#web-asset-delivery-2026-10-20)。不是当前本地 `99f52d63` 的编码器已经支持新产品。

源码实际流程：`xbc7::pack_image(orig_img, opts, comp_bytes, coded_log_blocks)` 从像素生成 BC7 base blocks，canonicalize 后执行可选 RDO、DCT/DPCM、stripe编码、blob Zstd和自验证。**公开入口不是“输入任意旧BC字节原样超压缩”。** 新 Cooker直接消费 canonical RGBA，不对已有BC先解码再编码，不把旧完整Product作为必经中间产物。

初始质量基线显式选择 `bc7e_scalar` level6、按语义设置 perceptual/linear、DCT Q100、RDO全关、self-validation开启、一个stripe；不使用上游默认 fast bc7f 冒充当前 quality6。BaseColor/Emissive 的数个有损档在 U0 做独立竞争；Normal/ORM默认不新增有损超压缩。Q100只说明相对于其base编码的重建texel无额外损失，可能因BC canonicalization发生字节变化；不等于源RGBA无损，也不保证和当前encoder相同。

Runtime：payload hash → 限长blob检查 → 有界XUBC7解码 → logical BC7 pack → 精确大小 native blocks → Residency。解码器保留 logical block邻域状态，不能把“不展开RGBA”误写成“没有scratch”。初版按页并行利用现有Worker，不依赖stripe线程、SharedArrayBuffer或跨源隔离。

必须适配的安全边界：上游 `image_unpacker::init` 先调用blob reader再读尺寸；默认blob总展开上限很大，且在 caller init callback 前分配logical block图。不能仅在最终callback校验144尺寸。包装必须在分配前验证目录与码流的尺寸/块数/全部展开长度，并把显式上限传进decoder或做小范围受审查patch；tiny marker、seek table、尾随垃圾、溢出和分配失败也必须覆盖。不得把整个冷Cooker/WASM搬入下载Worker。

### 4.3 固定语义 profile，而非无限 codec registry

| 用途 | 目标常驻 | 本轮主选 | 不允许的简化 |
| --- | --- | --- | --- |
| BaseColor / LDR Emissive | BC7 sRGB | XUBC7 Q100基线与有限有损档，按质量裁决冻结 | 用低码率图片的观感代替最终BC质量 |
| Normal | BC7 linear | XUBC7无额外有损基线；图片lossless对照 | 自动改BC5、归一化有意非单位输入或启sRGB |
| ORM | BC7 linear | XUBC7保通道基线，检查每个通道与BRDF响应 | YUV串扰、共用感知权重抹掉roughness |
| 标量 | BC4 | 现有受限Zstd/原生表示作为明确BC4 profile | 为统一XUBC7而翻倍为BC7 |
| 精确coverage | R8 | 有界无损表示或native，精确字节验证 | 任何有损编码、仅保alpha却漏掉真实RGB/UV依赖 |
| VT tail / 首屏小块 | 原目标BC/R8 | native startup产品，不等待fine decoder初始化 | 先显示错误mapping再补内容 |
| 大mandatory resident plane | 原目标BC/R8 | 可用同语义压缩传输，但必须准备完整后才允许发布 | 以“启动资源”为由始终传输整个大原生产品 |

native tail可保持快启动，但base encoder/recipe应与fine协调，验证最后fine→tail的LOD过渡。普通纹理的低mip初始化与强制完整resident闭包遵守真实材质依赖，不能把有损fine用作精确coverage证据。

HDR环境/光照产品不冒充LDR XUBC7；保留现有HDR语义，本轮明确计入下载总量但不同时重写环境预过滤/IBL。跨BC/ASTC/ETC设备可使用离线能力profile；本轮先闭合现有BC目标，不宣称WebGPU全平台已覆盖，创建资源前明确协商BC能力，不静默退为巨大RGBA。

### 4.4 有损分页接缝：必须解决，不靠gutter口号

同一canonical mip映射到相邻页时，几何重叠texel相同，不代表独立有损编码后的块相同。XUBC7的上下文/RDO/DCT同样可能改变块，不只AVIF有这个问题。

主选Q100、RDO关闭、同一block-local base encoder/颜色权重/块对齐，理论上可保持共享块解码相同；必须由冷独立reference验证clamp/repeat/mirror、NPOT、四角、跨mip与tail。不同profile的base参数也要逐项入recipe，不能只写Q值。

有损fine只有以下条件满足才进入生产：重复区域重建一致，或明确证明最终过滤接缝不超冻结的语义误差合同。需要混合边界无损等新机制时必须先补完整成本和解码合同；不默认引入sidecar边界补丁、跨页依赖或runtime解码邻页。不合格则该语义选择保守档，不降低画质要求换文件体积。

### 4.5 AVIF/WebP + GPU encoder 的有限竞争分支

实验覆盖颜色AVIF、法线/ORM lossless WebP，必要时UASTC/XUASTC作直接转码对照；KTX2只是容器，不证明可读任意新codec。Spark pin `b9ea643a08cb9eef3a9ddc64564089bdd6fd0daf`。JS为MIT，shader受EULA；2026-10-20公开条款对引擎/中间件再分发另有条件，研究/评估可以继续，生产授权不能假设。

胜出后才建立低层command recorder，禁止原样用会自submit的 `encodeTexture()`；禁stock mip生成、auto format分析、normal→BC5和readback。输入必须确切尺寸，BC存储写入buffer再copy目标layer/origin。首版一个compute pass按页dispatch；任意batch-z不是现成能力，不做未验证的megakernel承诺。

同帧顺序：独占输入准备 → encode → copy atlas/普通纹理 → mapping/资源发布 → reader。外部图像queue操作若无法回滚，只写尚未发布的独占输入，abort不得公开输出；已排队引用按真实完成边界退休。不能对同一输入先queue写多页再录dispatch，导致全部读最后一页。image解码须固定色彩、orientation、premultiply，并关闭Bitmap/VideoFrame；不能宣称浏览器内部必然零拷贝。

这条分支若胜出，U0先更新本设计相应主选与执行范围，再进入U1；不让主线中途偷偷混入GPU编码和新的ready表示。

## 5. 几何：新的紧凑常驻合同

### 5.1 选择数据布局，不恢复旧U16

新 Geometry Product / OEGPack 采用明确新major/profile；C++/native/WASM Cooker、CPU validator、GPU ABI和全部直接reader一次切换。256KiB只是逻辑容器上界，物理bank仍按有效前缀分配；不恢复固定物理槽，更不扩成每vertex 96B解码副本。

目标布局：meshlet/group元数据 + 紧凑triangle流 + 独立position流 + 属性流，section对齐，单个position不强制4B/16B stride。normal维持oct16x2，UV维持half2，color维持现有语义；tangent方向oct32与handedness bitset分离候选避免6B字段引起padding。字节收益按真实section、padding与header计算，不能只做12→6算术。

新版本允许有限的position表示：共享格点上的U16 delta、24-bit delta，以及明确的`f32-exact`。它们是同一新产品的合法精度档，由离线确定，不是旧产品fallback，不恢复旧reader。具体两种紧凑档是否都保留由U0成本与覆盖结果冻结，不能为了覆盖所有位宽写通用bitstream VM。

### 5.2 同一格点域，整数重建，禁止局部独立scale/bias

参考meshoptimizer共享指数算法，但不复制DXR/mesh shader接口。量化域在Cook阶段按**焊接位置等价关系、跨材质边界和全部LOD**确定，不能简单等同于material domain、单个meshlet或单页。共享边界位置的副本必须使用同一整数坐标规则；不把几何接缝处的不同normal/UV错误焊接为同一属性。

对允许量化的域定义唯一二进制步长 `s = 2^e`：

```text
q = round_ties_away_from_zero(p / s)   // cook，整数与溢出受检
a = min(q)                           // meshlet每轴anchor
d = q - a                            // unsigned delta
p' = f32(a + d) * s                   // 先整数相加，再转f32乘二次幂
```

同域不同meshlet可以有不同anchor，但不能改变格点、舍入和重建顺序；禁分别计算 `f32(a)*s + f32(d)*s` 引入不同舍入。anchor+delta及转换前整数须落在明确定义的精确f32整数域内，保守使用绝对值不超过 `2^23-1`，不依赖WGSL i64/u64。选择位宽不足时升位宽/精确档或拒绝该量化候选，**不能偷偷增大s让误差越过合同**。

Cook参考用受检高精度计算求q，不在有限f32乘法先溢出后再转整数；runtime的signed anchor、unsigned delta和相加转换顺序须有明确无溢出实现。初版紧凑档限制s与非零重建结果处于可验证的正常有限f32域；subnormal、signed-zero位语义无法精确保留的域进入新精确档，不依赖GPU flush-to-zero或乘法收缩行为。

基础坐标误差上界为每轴`s/2`、欧氏`√3*s/2`，加上实际浮点重建/世界变换界；SSE、LOD误差、meshlet/group/hierarchy/query bounds必须以重建结果重新计算并向外保守舍入。simplifier用的拓扑/边界锁和所有LOD之间既有数学不能被格式打包绕过；先确定域和精度约束，LOD构建与最终打包交叉检查完整链。

默认不加任意floating origin/bias降低整数范围，避免跨组重建不一致；若对象坐标过大或精度不容纳，使用新产品精确档。未来origin方案要有单独数值依据，不能作为本轮隐藏补丁。

### 5.3 精确query与损失预算：硬合同

当前query叶节点保持源primitive/vertex对应，不能仅保留triangle ID就把有损位置称为“精确”。默认产品不改变source-exact坐标合同：

- 若一个格点域的源位置可按新紧凑表示逐坐标精确往返，可使用紧凑档，Cooker输出往返检查结果。
- 对允许的有损表示必须显式记录非零误差；不能用于要求zero-error/source-exact的cut。是否启用新的有损资产profile，需在U0冻结质量范围；本轮没有默许降低query精度。
- 若域含不容纳量化的精确约束，域内相连边界统一采用`f32-exact`；不能在共享边一侧移动顶点、另一侧保持原坐标。不另造只给query的Float32重复几何或独立页树。
- 新query section区分拓扑覆盖、位置重建误差和coarse simplification误差；zero-error请求遇到非零量化误差明确拒绝/unknown，不谎称命中精确叶。默认生产必须仍能服务已有合法精确请求。

这意味着**不能预先承诺所有位置都从12B降到6B**。若真实资产精确格点覆盖率低，报告实际收益；属性布局和传输压缩仍可独立有收益，不制造“压缩率通过”假象。新产品支持精确档是精度能力，不是保留旧V3生产路径。

### 5.4 全部直接消费者闭合

新layout必须被以下闭包直接消费，不能只改Surface：

- native/portable/pthread Cooker及Web cook输入/输出ABI、recipe、scene manifest与cache复用。
- Page目录、布局/索引/有限值/误差/bounds验证、prepared receipt、admission与work上界。
- GPU Product table、format/meshlet metadata、bank地址范围和shared geometry decoder；shader ABI单一事实源。
- 主/阴影visibility、软/硬raster、Surface几何恢复、normal/tangent/UV/导数与motion使用的新旧帧数据。
- `GeometryQueryDirectory` 的内联format/stride复制、query retain/cut/BLAS、SCGI ray/picking reader和source remap。
- 多Product、重复实例、negative/nonuniform transform、replacement、growth、device loss、scene release及延迟反馈generation。

streaming demand/调度的职责不变；若实际函数依赖旧layout则整体重写，不加decode-to-old-page adapter。新格式内容hash与元数据hash涵盖误差/格点/精度档，旧assets一次recook，错误版本在分配GPU前拒绝。

## 6. 几何传输与 CPU→GPU

以新resident布局为输入比较：页级LZ4、页级Zstd、meshopt vertex/triangle子流 + 可选页级压缩。按页独立解码，不依赖前页历史或网络外部字典。codec选择在Cook时固定，不在每帧试探。

meshopt使用自定义段目录，不把glTF bufferView扩展塞进OEGPack。meshlet triangle是局部U8，不能用通用32-bit index codec假设；GPU meshlet示例只解topology/reference，不解全部属性。meshopt可能旋转三角形，必须同时重排barycentric/corner/remap或采用保序编码，不能损坏source primitive与coverage。vertex codec要求4B stride，紧凑6B position流要评估转置/plane打包等成本，不能为适配codec把GPU布局永久补回12B。

Worker输出新compact resident payload，直接写隐藏lease。保留queue写payload和encoder内地址发布的区别：abort可遗留不可见隐藏字节，不能发布旧generation，也不能提前复用尚被GPU引用的区间；映射撤销与末读fence之后才能释放。bank增长冻结期间不得先queue写candidate再被旧bank复制覆盖，等待增长事务或在encoder正确顺序写入。

本轮默认不做GPU LZ4/Zstd/meshopt解压，也不建GPU解压后Float32常驻副本。只有测量证明CPU准备或上传成为主瓶颈、且完整解码验证/发布合同明确时，才另作候选；不是把native的DirectStorage/GDeflate/mesh shader假定为WebGPU能力。

## 7. 信用、缓存与生命周期

### 7.1 按真实表示与backing分账

令`S`为HTTP实际保留输入，`E`为有效码流，`D`为交付ready字节，`W`为decoder峰值scratch，`H`为固定WASM/module常驻，`G`为GPU临时资源。目录和bootstrap单列。准入前必须满足：

```text
CPU task charge >= 所有同时存活的输入/输出副本 + W + receipt/校验scratch
CPU total = task + ready + cache + directory + 所有活跃Worker的H
GPU peak = resident + retiring + growth candidate + G + texture copy scratch
```

不能把旧`2S+2D`或4MiB解码器预算直接沿用给XUBC7；要从实际C ABI/allocator和二进制构建清单导出安全上界。WASM默认禁止无界memory growth，OOM明确失败并释放任务；Worker替换时旧实例未退休和新实例并存的峰值也要入账。

初始调度仍最多4个Worker、4个Range；已有256MiB temporary/32MiB encoded/64MiB ready与≤128MiB native cache是可配置基线，不是新decoder已获资格。U0按最小设备profile冻结可容纳单任务的预算和并发，不能只提高限额来通过。一次任务在获取全部必要信用后才fetch/decode，不部分占额等待下游造成死锁。

### 7.2 有界缓存，不制造重复全量回放

主选Worker→BC路径复用一个明确native BC/R8 LRU，键含product/profile/payload；take转移独占ownership，release使旧view失效后归cache，cancel/source退休幂等结算。普通大resident资产也不得无限保存整套native chunks作为replay；保留可重开source与有界cache，loss后按真实工作集重放。

传输码流可利用现有HTTP缓存，但Range不保证浏览器持久缓存命中；不把它当显式CPU cache。初版不同时新增encoded RAM LRU、native LRU与持久存储三套缓存。图片路线若胜出，decoded Bitmap/RGBA不能进入native cache或无界pending；其cache策略在U0明确冻结，并把重访重复解码/编码成本算入。

### 7.3 状态转换与失败

```text
registered → admitted → fetching → verified → preparing → ready lease
  → GPU hidden write/encode → candidate publication → submitted resident
  → unmap publication → last-use fence → reusable
```

取消/失败可在任何CPU阶段终结；提交前abort撤candidate、退租约或保留明确可重试stage，不能两次释放。submit成功但通知/fence失败不等同未提交，不能回滚已执行写入。迟到Worker结果核对session/task/generation/decoder身份后丢弃，不能复活销毁source。device loss清GPU epoch和临时引用，保留合法CPU来源；重放失败可观察且可重试。

VT fine尚未可用保持已有真实粗层覆盖与公平性，不缩目标mip假装收敛；普通mandatory资源未全准备则scene不发布。损坏/未知产品明确错误，不自动转旧schema、原始GLB或巨大RGBA fallback。

## 8. Cost Card 与裁决规则

以下是模型，不是测量。U0和各闭包末填写ideal/expected/worst，优化候选报告0/50/100%收益与break-even；没有真实数据的格子写未测。

| 机制 | ADD / DELETE | 执行与访存 | 上界/风险 |
| --- | --- | --- | --- |
| XUBC7替换plain BC+Zstd | 少网络字节的机会；ADD blob/logical scratch、decoder代码与CPU pack；GPU resident不变 | CPU按stripe顺序重建邻域；GPU零新增encode dispatch、原copy不变 | codec冷初始化、小页容器、高熵膨胀；native cache hit免decode |
| 图片+GPU编码竞争项 | 少网络字节的机会；ADD decoded图像、输入上传、storage输出和encode | GPU纹理读+block buffer写+copy；每页dispatch，无新增submit/必需readback | GPU争用、峰值临时显存、decode队列和许可 |
| 紧凑position/属性流 | DELETE实际属性/stride bytes；ADD anchor/format/bitset与decode ALU | 顺序属性load，可能cross-word；元数据按meshlet复用；零新增pass/atomic | 精确档覆盖率、重复读取、寄存器、shader变体；不承诺全12→6 |
| meshopt子流 | DELETE传输字节；ADD CPU结构解码/scratch | WASM SIMD能力按实机探测；不新建Worker池 | 4B stride、triangle旋转、二次通用压缩税 |
| 上传 | DELETE紧凑payload相应字节；地址copy仍保留 | 已有direct writeBuffer，CPU→GPU内部copy由浏览器决定 | 不宣称zero-copy或省掉不存在的staging；growth双份峰值 |

144×144：RGBA8=82,944B；BC7=20,736B；BC4=10,368B。当前buffer→texture路径BC7 row576→pitch768，36行buffer布局27,648B；BC4 row288→pitch512，对应18,432B。有效块字节、staging布局容量和GPU物理显存分开统计，不能混叫“纹理大小”。`queue.writeTexture`紧密输入不受同一256B行pitch限制；实际选择按路径验证，不把padding说成所有上传必然成本。

下载受限简化模型：节省时间约`ΔnetworkBytes / effectiveBandwidth`；新增CPU/GPU工作须与它比较。流水线吞吐由最慢阶段、排队和帧预算决定，不能把全部阶段时间机械相加，或用网速单点宣布赢家。

几何position净节省模型：`N*(旧实际bytes-新实际bytes) - meshlet格点metadata - section padding - 新query/目录开销`；半覆盖时按真实精确/紧凑分布算，零覆盖仍支付的header/dispatch税必须报告。CPU/GPU fetch字节估算不等同实际cache/显存事务，最终以归因测量说明。

codec裁决先过质量/容量/生命周期，后做Pareto比较：同质量下网络减少且就绪/帧成本不出现不可接受倒退；若一方仅低带宽占优，冻结一个明确产品profile和适用范围，不建runtime自动猜测系统。无候选胜出则保留当前生产事实、记录否决并修订目标，不悄悄宣布现有Zstd就是本轮成功。

## 9. 验证范围与不变量

| 领域 | 必须验证 |
| --- | --- |
| 纹理质量 | canonical→最终GPU解码的颜色/linear/HDR边界、法线角误差、ORM逐通道及BRDF、exact coverage、C/X/Y导数/LOD、gutter/NPOT/wrap/邻页/tail |
| 产品与decoder | 范围/hash/长度/维度、重复/孤儿/洞、错误recipe、tiny/普通slice、截断/拼接/seek/展开炸弹、所有分配前上界、固定WASM OOM |
| 非VT与VT | hello保持非VT；真实Worker输出分别进入普通纹理和atlas；非零layer、victim、ready背压、query-only需求与主/query公平性 |
| 几何数值 | 同源位置跨meshlet/材质/LOD重建一致，舍入tie/负数/极值、16/24/exact档、保守bounds、triangle角顺序、source remap、world nonuniform/mirror、motion |
| GPU消费 | 新共享decoder进入visibility/raster/Surface/VSM/query，不能只测独立unpack；新query目录不复制旧16B format后误读 |
| 生命周期 | cancel/crash/retry、部分批次、scene替换/释放、abort、submit后失败、eviction、bank growth冻结、device loss/replay、资源回基线 |
| 成本 | payload/HTTP/overfetch/目录/bootstrap、CPU阶段与初始化、ready/queue P50/P95、上传有效/对齐bytes、resident/retiring/growth/scratch峰、真实GPU工作 |

开发中按需编译和极小oracle；完整闭包接通后集中新鲜build/直接测试与真实GPU。正式多设备完整Renderer画质/同条件FPS留最终集成，不将已发现的实现/容量/生命周期错误推迟为“只欠集成”。不每patch跑整场景，不为旧表示测试恢复旧owner。

## 10. 切换与非目标

纹理与几何分别是完整clean-cut单元，具体顺序见执行文档。允许先在离线/reference隔离边界构建新闭包，但不向现有production reader分批投放新产品。切换提交必须包含全部直接reader、fixture、manifest/cook身份和删除清单；本机大资产在授权实施时recook，不能在本轮设计阶段改写用户资产。

新部署只引用新manifest和新hash，拒绝混合旧页面；旧版本整体使用Git追溯或整版本回退，不在新runtime里加兼容桥。不同资产类型分别切换不等于新旧纹理/几何同owner混接。

不做：重写效果系统、自动恢复SCGI未完成资格、跨平台全部纹理格式、神经纹理生产移植、DGF硬件依赖、GPU通用熵解压、无限codec插件系统、每页独立submit、完整geometry/texture回读副本、无需求的cache/proof/history，以及为测量框架扩展生产架构。

## 11. 来源与仍待裁决项

完整revision、license、入口与本地映射统一见[来源账本](../porting/next-renderer.md#web-asset-delivery-2026-10-20)。已读原始源码的行为可以作为设计依据，来源adoption与性能资格仍未取得。

只留以下有界裁决，不以“以后研究”替代架构：XUBC7 profile/解码内存上限与resident分块粒度；图片竞争项的最终质量/接缝/端到端收益；真实几何精确格点覆盖率与保留的紧凑档；新布局的页压缩组合。它们由U0给出测量、否决或冻结记录，生产切换前关闭，不逐个变成重型子模块。
