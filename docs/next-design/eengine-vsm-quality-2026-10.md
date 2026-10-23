---
id: eengine-vsm-quality-2026-10
state: current
verifies:
  files:
    - OEngine/src/gpu/GpuVsmProjectionAbi.ts
    - OEngine/src/gpu/FinalPixelAbi.ts
    - OEngine/src/shaders/scgi_lighting_gather.ts
    - OEngine/src/render/vsm
    - OEngine/src/render/ShadowGeometryWork.ts
    - OEngine/src/render/ShadowTileDomain.ts
    - OEngine/src/render/surface/NativeRasterWorkPartitions.ts
    - OEngine/src/render/surface/SurfaceV4.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/shaders/native_visibility.ts
    - OEngine/src/shaders/vsm_caster_records.ts
    - OEngine/src/shaders/vsm_sampling.ts
    - OEngine/src/shaders/vsm_page_table.ts
    - OEngine/src/gpu/GpuNativeMaterialScene.ts
    - OEngine/src/render/temporal/NativeTemporalV2.ts
---

# Directional VSM：源算法对齐与硬件光栅重构

2026-10-23 按用户最新要求重写。本文是**目标设计，不是当前实现完成声明**。
替代旧 Q1-Q4 的推进方式；仅保留这一份设计与[三步执行计划](../next-execution/eengine-vsm-quality-execution-2026-10.md)。
用户随后授权实施步骤1并提交；实际结果只读执行计划，步骤2/3仍等待授权。最终场景调参、效果取舍和硬件调优由用户手动主导；
实现者负责完整能力、正确执行、受控容量和消除已知浪费，不能把结构问题留给用户调 bias。

## 1. 决策：一条生产路径，不造两套后端竞赛

采用 **Timberdoodle 页面/dirty 算法 + compute 共享几何准备 + Sundial 硬件页裁剪 + depth atlas**。
移植的是选定的完整机制，不引入 Daxa/Vulkan 框架，不把本地容量策略冒称 donor 算法。

- 对齐 Timberdoodle 的 distance clip selection、toroidal 页面、free/unvisited 回收、dirty hierarchy、meshlet/triangle 提前拒绝。
- 将 mesh/task 工作表达为 compute 几何准备、紧致 triangle/page 工作与有限 native raster bins；不再以整个 meshlet/page 为最小昂贵绘制单位。
- 页裁剪优先忠实移植 Sundial 的四个 clip planes；缺少该可选特性时，使用真正的 polygon clipping，**不保留页外 fragment discard 作为常规后端**。
- 保留硬件深度、原生 MASK coverage、reverse-Z 和完整 gutter。不实现一套常驻软件 depth atlas，也不先跑硬/软光栅 A/B 再决定架构。
- 基础档选 Bevy Castano Gaussian PCF；软档选同 revision 的完整 directional PCSS + Jimenez 过滤及已有最终 Temporal 消费。
- 不把双池静态/动态缓存列为本轮必做：它增加至少一张 atlas 和页面合成。先消除重复几何、页外覆盖、过宽 refinement 和错误 invalidation。

### wgpu / Bevy 的 mesh shader 边界

用户指出得对：wgpu 原生已有 `EXPERIMENTAL_MESH_SHADER`，Bevy 0.20 也有 mesh shader 接口。
但这是 **native-only 扩展**，不是浏览器 WebGPU capability。当前 `RendererCore.initialize()` 使用
`navigator.gpu`，不是 Rust wgpu 原生设备。WASM 或换成 Bevy 不会让浏览器获得该扩展。
本轮不重写 Rust renderer、不建 native-only 第二管线；未来若用户另行启动 native backend，才可直接承接 donor mesh 输出。

依据：[wgpu mesh shading](https://wgpu.rs/doc/wgpu/documentation/extensions/mesh_shading/index.html)、
[wgpu native feature](https://docs.rs/wgpu/latest/wgpu/struct.FeaturesWGPU.html#associatedconstant.EXPERIMENTAL_MESH_SHADER)、
[Bevy 0.20](https://bevy.org/news/bevy-0-20/#mesh-shaders)。
`clip-distances` 则是标准 WebGPU 可选设备 feature：先查询 adapter、创建时申请，最终以 device.features 为准；
调用方提供的 device 没启用时走等价显式裁剪，不能在 shader 里偷偷启用。
[WGSL clip distances](https://gpuweb.github.io/gpuweb/wgsl/#builtin-values-clip_distances)。

## 2. 重构前源码基线与目标处置

此表保存启动时源码基线，不是改动后的实现状态；完成项读执行计划。旧 Q1 的通过结果只证明旧指定策略，不能证明其质量最优。

| 当前源码 | 目标处置 |
|---|---|
| `vsm_receiver_demand` / `vsm_page_table`：first-containing XY 两端；Q1 加权/log2 admission | 选级改为 donor distance profile 的共享函数；完整 raw demand、容量显式化保留。本地 admission 见下文，不假称源 allocator。 |
| `VsmCapabilities`：128 pages × 128 texels，6 clips；4096 atlas / 136 pitch，900 slots，150 coarse，750 fine | 不再把这组本地选择当作 WebGPU 上限；统一资源与投影 profile，移除 shader 中硬编码六层。 |
| `ShadowGeometryWork` / `hierarchical_work_generation`：coarse requested 区域驱动 SSE 0 refinement | 改为实际 selected dirty 域驱动；refinement 使用该域真实 shadow texel 的误差目标，保留完整 off-camera caster。 |
| `vsm_caster_records`：meshlet/page count、完整页选择、再次 write；随后 native partition count/prefix/scatter | 合并为共享几何准备、triangle/page 计数与有限 bin 输出；重复 pass 只有真实容量/前缀依赖才能保留。 |
| `native_visibility`：VSM 强制 cached=false，非索引角点按 pair 重复解码/变换，fragment 才裁页 | 删除该 VSM 专用分支，接共享准备产品、紧致 triangle/page draw 与光栅前裁剪。主 Visibility 路径不被顺带重写。 |
| `vsm_sampling`：disk4 默认；独立 compact descriptor 发布；管理 mip1..4 没有 sampling consumer | 删除 disk4 作为产品质量档、删除无 consumer 的管理 mip；采样描述只维护实际有效/失效写域。 |
| `GpuNativeMaterialScene.viewDependentCoverage` 扫整个 MASK graph | 只沿实际 lowered alpha dependency 失效；已有 `nativeCoverageChanged` 的真实参数/纹理比较保留。 |

## 3. 固定来源与移植边界

完整映射同步记录在[既有来源账本](../porting/next-renderer.md#2026-10-23-vsm-重构来源选择)；表内是完整模块目标；步骤1的实际 port/adapt 范围与证据单列于账本，不把步骤2/3提前声明 adopted。

| 来源 / 固定 revision / license | 移植范围 | 明确不照搬 |
|---|---|---|
| [Timberdoodle](https://github.com/Ipotrick/Timberdoodle/tree/1987cf3b8ddda42585d2470bb5806efbc96c6cae) / `1987cf3b8ddda42585d2470bb5806efbc96c6cae` / Apache-2.0 | `vsm_util::clip_info_from_uvs` active distance 分支；mark/free/allocate/invalidate/roll；`gen_dirty_bit_hiz`；directional/shared task/mesh 的 meshlet/triangle 拒绝条件 | wave32、64-bit 打包原子、device address、DispatchMesh；point/spot 常驻政策不当作 directional coarse 来源；四 raw taps 不作为新质量档 |
| [Sundial](https://github.com/increasinglyHuman/poqpoq-sundial/tree/c262b6f16bc1cf9ee41ac9c796d29fa5053e0d3d) / `c262b6f16bc1cf9ee41ac9c796d29fa5053e0d3d` / MIT | `raster.ts::rasterWGSL` 页裁剪、atlas vertex pulling、indirect 批量绘制；`kernels.ts` selected-page rect 的提前工作排除 | cluster/page 重复 transform、fragment discard 后端、稀疏 receiver 标记、邻页缺失 clamp、固定 alpha texture/cutoff、预算竞争语义 |
| [Colossus](https://github.com/apollo-2006/colossus/tree/7e8855f3bd0d2e1c45b7f8012c8719876f422b40) / `7e8855f3bd0d2e1c45b7f8012c8719876f422b40` / MIT | `web/vsm.wgsl::vsm_raster` 唯一顶点 workgroup 准备与 dirty page span skipping 的执行参考 | 不复制软件光栅、>1023 texel 三角形拒绝、队列截断、固定太阳、缺失 MASK；不是本轮生产 raster donor |
| [Bevy shadow sampling](https://github.com/bevyengine/bevy/blob/fd98063564218bd210308675602a3e9643014c31/crates/bevy_pbr/src/render/shadow_sampling.wesl) / `fd98063564218bd210308675602a3e9643014c31` / MIT OR Apache-2.0 | Castano Gaussian 全部九 tap/权重；directional 八 blocker 搜索、无 blocker 分支、blur 公式、八点 Jimenez 全部偏移/归一化/旋转；配套 `utils.wesl` 与 `shadows.wesl` 调用坐标 | 不只抽点表；不把 native mesh shader、cubemap/spot PCSS 或经验系数换成本地公式却称同 profile |

Sundial/Colossus 只补足已列出的机制，不取代 Timberdoodle 的页面责任。Bevy 过滤是明确更换所选质量 profile，
不是假称 Timberdoodle 原四点过滤已经拥有软阴影质量。Kooch 当前 All Rights Reserved，不复制；其余只有 scaffold/roadmap 的项目不作为 donor。

## 4. 页面、需求与容量合同

### 投影与分辨率

目标基础布局对齐 donor：**64 texels/page、64 pages/clip、最多 16 clips**，每 clip 虚拟分辨率 4096。
保留 gutter=4，pitch=72。不是把当前相同世界 extent 下的 16384 分辨率直接降四倍：初始化转换必须保持
`旧有效 finest world texel = 新实际可选 finest clip extent / 4096`，并保持/扩大原最远覆盖。
相应缩小最细 extent、增加 clip 层数；donor distance 分支实际从 level 1 起选，转换以**有效 level 1**计算，不能按未采样 level 0 假算精度。
这只是最细能力和覆盖换算，**不证明distance selector在所有receiver上与旧XY selector同精度**：
减小base extent还会提高被选level，二者可能抵消。实际质量由donor公式的selection bias控制；
步骤1需对支持距离/角度域算出新旧实际world-texel分布，给出保守默认bias及明确差异，不靠缩extent宣称精度无损。
不能同时无条件承诺旧XY局部偶然高精度、donor原默认bias和原750页成本；请求增加须显式由容量/预算承接。
远端覆盖由所需层数和世界尺度决定，不能仅因旧 ABI 是六层就截断；支持的最高世界范围须显式报告。

| atlas | depth bytes | floor(atlas/72)^2 slots | 16 clips 的 coarse 最大预留 | fine 上界 |
|---|---:|---:|---:|---:|
| 2048 | 16 MiB | 784 | 144 | 640 |
| 4096，正常基础资源档 | 64 MiB | 3136 | 144 | 2992 |
| 8192，显式高容量档 | 256 MiB | 12769 | 144 | 12625 |

这是容量算术，不是同画质下容量提升倍数：64 texel 页的核心面积只有旧 128 页的 1/4，gutter 相对成本从约 12.9% 增到 26.6%。
高容量档不是仅凭 maxTextureDimension2D 自动开启，必须显式资源预算授权；低容量档不保证复杂大场景全效果。
场景 extent/clip profile 属初始化资源配置，filter/bias/预算属于运行期调参；需要重建的设置有明确 transaction，不伪装成廉价 slider。

### 步骤1确定的初始化与距离精度合同

`Renderer.initialize({vsmResourceBudget:{atlasMiB:16|64|256,clipLevels:10..16}})` 在建资源前协商，
默认64MiB、10层，最大16层。不是无条件铺满最远16层：默认10层预留最多90个coarse槽，
4096 atlas可供3046个fine；2048档694个fine。16层档仍为2992/640，8192档需显式256MiB预算。

令旧level0全宽为E：新level0全宽E/8，实际最低选择level1全宽E/4，
`(E/4)/4096 = E/16384` 保持最近端能力；新9层的名义最远全宽等于旧6层，
但旧forward偏心与新64页snap的边缘并不完全重合，所以默认10层留2倍名义宽度，
覆盖旧最远边缘，而非铺满16层造成128倍线性覆盖扩张。center改为donor相机中心，
不再随cameraForward偏移；页坐标仍是本地world-grid floor snap（donor在其NDC坐标ceil snap），
两者都保留最多一页偏差及`62/64` guard。

默认乘法bias=1，允许[1,8]；更小值破坏这个containment guard，因此不把降bias当作免费增清晰度。
实际公式为 `L=clamp(ceil(log2(d/(E/16*62/64)*bias)),1,N-1)`，world texel为`E*2^L/32768`。
以E=32、相机/旧窗口同中心、receiver沿light XY轴为例：

| d | 旧XY选择texel | 新distance texel（bias1） | 精度关系 |
|---:|---:|---:|---|
| 1 | 0.001953125 | 0.001953125 | 最近端相同 |
| 4 | 0.001953125 | 0.00390625 | 2倍粗 |
| 10 | 0.001953125 | 0.0078125 | 4倍粗 |
| 16 | 0.00390625 | 0.015625 | 4倍粗；旧边界前可到8倍 |
| 60 | 0.0078125 | 0.03125 | 4倍粗 |

这不是已测画质结论，而是两种selector的数学差异；沿light Z距离大而XY很小，差异还可更大。
不能把最近端保持说成全距离无损，也不能把本步宣称为所有边缘都更细。
该代价来自所选donor 4096虚拟clip及distance profile；本地未保留XY选择器来伪装同源，
后续更完整PCF改善过滤与稳定性，不会恢复不存在的原始shadow texel分辨率。

### 同一选级与过滤需求

- donor active distance 公式及其页对齐 guard、乘法 selection bias 和 clamp 范围由一个 helper 定义；需求、查询、相邻 support、过渡共同消费。
- 所有有限 `0 < receiverDepth <= 1` 的有效 receiver 都参与；不按 depth epsilon、抽样 stride 或 ticket 容量漏 receiver。
- primary 为选定 clip；support 是下一相邻有效 clip。请求覆盖实际过滤 footprint和过渡两端；当前normal只修正比较深度、不偏移XY，因此不额外产生位置需求。
- 基础 PCF 完整 footprint 落在 gutter 内。PCSS 大核通过跨虚拟页解析；不能扩到 gutter 外仍从相邻物理槽误读，也不能 clamp 核来维持旧成本。
- soft 模式按配置允许的最大 search/filter footprint 保守请求并统计额外需求；滤波增大可能增加驻留和更新成本，不能只计算 shader taps。
  任意配置下的保守最坏query footprint必须在步骤3启用前从完整源公式求出并参与能力协商；
  不把source blur中除receiverDepth产生的无界核悄悄截断。端点若不能给出有限足迹，则该soft配置明确不可用，receiver仍走stable完整需求，不能被深度阈值漏掉。
- fine miss 按邻近 clip 逐层查找，不直接跳 mip5；所有需求中的过渡端均需 ready。普通过渡只在 2 倍尺度两端进行。
- 每 clip mip5 coarse 仍作为**本地 emergency 产品**保留：64/32=2 页主窗口，滚动最多 3×3；16 clips 最多144槽。
  它不是 donor directional 机制，绝不进入正常宽过渡环；只承担所有可用 fine 均缺失时的可靠兜底。

### 明确保留的本地容量适配，而非新的“源移植”声明

完整 raw request 与 admitted request 分离。继续复用已经实现的 Q1 **2:1 primary/support coverage score、log2 tier、固定 page-key tie**，
随新选级/footprint 更新其输入；本轮不再发明另一套排序/公平分配器。它不依赖现有 slot 或 arrival order，避免先占槽长期获益。
这是用户所需有限容量质量分配的**本地政策**，不是 WebGPU 必然要求，也不是 Timberdoodle port；它不保证感知最优或每个 primary 都胜出。
移植 source free/unvisited queues 时保留这一明确额外 admission 前置，不用 donor 大容量下的分配失败语义覆盖已有质量合同。
raw/admitted、primary/support、footprint 扩张和未 ready 计数必须可见；原始需求不得被偷偷减少以维持旧成本。
若用户后续要求纯 donor allocator，可独立讨论这一差异，不能实施时悄悄换策略。

## 5. 单一 GPU 数据流与 ownership

```text
有效 receiver → shared clip/footprint → raw/admitted demand
  → roll + 精确 old/new damage → free/unvisited allocation → selected complete-page batch
  → selected dirty hierarchy（含 gutter）
  → Geometry 按 shadow texel 选叶与 streaming 请求
  → source meshlet 唯一顶点/三角形准备（ordinary + Product）
  → triangle dirty/page 拒绝 → 页面完整成本/容量选择 → 有限 native bins
  → clip-distances 或等价 polygon clipping → clear + depth raster
  → 完整页 commit → descriptor mutation publication → Native sun PCF/PCSS
  → 已有 HDR/Temporal/Presentation
```

VSM 拥有 page/dirty/depth/descriptor/更新状态；Geometry 拥有层次选择和 source residency；Material 拥有 compiled alpha；
Native raster 拥有有限 program/bin 执行；FrameGraph 仅声明宏依赖；Renderer 只组合。无新全局 effect cache、私有 submit 或本帧 GPU→CPU→GPU 控制。

### 进入昂贵阶段前避免工作

1. dirty hierarchy 从本帧**实际 selected page**构建，coarse/fine 分开记录 texel 尺度。没有更新时 Geometry/refinement/setup/raster 的 indirect 计数为零。
2. hierarchy traversal 在 refine 前拒绝不交 selected dirty 域的节点；不能用主相机 occlusion/SSE 排除 off-camera caster。
   采用 donor shadow-texel LOD 语义并保留用户可设误差目标；不保留 SSE 0 一路细化作为正常路径。
3. 以 source meshlet/instance 为单位准备实际被选几何；唯一顶点解码和 object→world/light transform 不按 page pair 重复。
   结果是 transient frame scratch，不建立跨帧 geometry cache/history。world/light position 可共用一个16B位置记录；真实 coverage 属性按编译依赖准备/读取。
4. 移植 donor meshlet/triangle dirty hierarchy/backface 接受拒绝条件，考虑镜像、双面、保守误差、退化和 gutter。
   只输出真正影响目标页面的 triangle/page 工作，不把整块 meshlet 的所有三角形交给 fragment 淘汰。
5. material class 在 source setup 确定一次，triangle 输出直接分配其 native bin；删除随后再次遍历全部 page pairs 的 class scatter。
   仍允许容量计数/前缀所必需的轻量记录扫描，不许为“融合”强行消除真实全局依赖。

### 页裁剪与 MASK

- clip planes 使用 gutter 扩展后的虚拟页坐标，写入对应物理 slot；不是四个核心 page planes 误裁 gutter。
- 无 clip-distances：triangle 与四条 XY 边界真正求交，最多7顶点/5三角形；深度范围再按标准 primitive clipping 处理。
  不 clamp 原顶点，不以面积/跨度阈值丢大三角形。
- 新顶点保留原三角形 barycentric lineage，覆盖程序使用原始输入插值与解析梯度；不得把已求值非线性材质结果插值。
  MASK 的原 UV/world/normal、隐式 LOD/导数、texture residency、镜像绕序和 sidedness 全部保留。
  clip 后人工三角边不能成为新的 coverage derivative discontinuity；边界退化需规范化，不以宽容差掩盖裂缝。
- OPAQUE fast path 不为 alpha 分配属性，不强求有 fragment；MASK 保留完整 native compiled program，不降为一张 alpha 贴图。

### 容量与完整提交，不让大页永久饥饿

scratch、triangle records、clip 输出、每 bin indirect 参数在设备 epoch 前置协商；明确 attempted/written/failure。
正常批次先以轻量 triangle/page 成本确定完整页集合，再输出；未选页保持 dirty，不能部分 ready。
单页超过常规 stream 容量时，在**同一个普通 frame command**中按有界 source chunks 顺序清页一次、累积绘制，最后 commit。
每 chunk 共享 source 准备可跨目标页复用；禁止因一个页大就永远拒绝或截断 triangles。固定 chunk 数由已协商 source capacity 推导，
GPU 写每块 indirect 工作，不逐页 CPU readback。若实际设备容量连最小 chunk 都不能容纳，应在创建资源前拒绝该资源档，不谎称可运行。
chunk 不是无限循环：最大轮数由 source triangle 上界、选中 page 上界、每轮 clip 最坏5倍输出及 scratch 容量共同推导，
计入 CPU 编码/空 indirect 和 GPU pass 税；不能仅给 scratch 一个32MiB数字就宣称总工作已经受控。
常规一轮足够时不启动 chunk 管理 GPU 工作；超大页的完整绘制本身可能超过常规预算，必须报告该页实际成本，不能承诺页数预算等于毫秒预算。

所有已入选 source/triangle/chunk 必须终结并成功，空页完整 clear 同样可 ready。提交持有 namespace/epoch/generation/reverse owner；
abort、资源替换、geometry streaming、projection/sun 改变不能让旧深度发布为新页。稳定边界只有新 owner，立即删除旧显式/隐式 pair raster。

## 6. 过滤：两个完整能力档

### stable-pcf（默认）

移植 Bevy `sample_shadow_map_castano_thirteen`：完整 base UV 相位、三组可分离权重、九个 bilinear comparison tap 和 `/144`。
每个 bilinear comparison 用 raw 深度的四次**实际 texel**比较重建，保留 local receiver-plane correction、reverse-Z 空零及负 reference 语义；
不能改成硬件单 reference 后宣称等价。可以 gather 取四深度，但实际样本数/四比较成本必须如实记录。
不逐帧旋转，不依赖 Temporal 才获得稳定核。point 仅作诊断，不列为第三个生产质量档；退休旧 disk4/gather2x2 配置及噪声资源，无旧 ABI 桥。

### soft-pcss

移植同一 Bevy revision 的 directional 链：八个 D3D blocker 位置、对应过滤取深度、blocker 接受条件/平均/无 blocker 分支、
`sample_shadow_map_pcss` blur 公式与最小核、完整八点 Jimenez spiral/经验尺度/归一化/旋转。
配套 `shadows.wesl` 的 directional 投影和 texel-size 输入一起核对；不能把 local reverse-Z 数字直接塞入不同 depth 参数化的分母。
shadow profile depth 与本地稳定 depth 域之间使用显式可逆转换，blocker 深度/receiver/bias 同域；空 texel 绝不成为 blocker。
这是带本地 per-texel correction/空深度适配的 Bevy profile，不宣称逐位等于其单 reference 硬件 sampler。

Temporal 开启时采用源时变采样，通过现有最终 HDR Temporal 链重建；检查实际 motion、disocclusion 和 shadow 内容变化的响应/拒绝，
不是只接 frameIndex 就称已重建。不另建 shadow 全屏 history。Temporal bypass 时使用源非 temporal 分支，明确它仍可能有空间噪声；
默认 stable-pcf 不受此限制。不承诺八样本 PCSS 达到离线面积光质量，不引入未指定的 denoiser。
最大 search/filter 世界 footprint 由资源 profile 给定，越界配置明确拒绝；不能运行时默默截核，也不能用增大固定 gutter 代替跨页。

## 7. 更新、发布与成本约束

只按实际 alpha dependency 触发 coverage invalidation；普通材质光照项变化不应重画阴影。
source/influence 的移动、删除、MASK 参数/纹理、Product promote/evict 各保留 old/new 影响；太阳/深度域改变使用明确 projection epoch。
删除管理 mip1..4；coarse 与 dirty hierarchy 是不同产品，后者有真实工作拒绝 consumer，不因“删除 mip”一并误删。

descriptor 由实际 mutation（alloc/evict/roll/invalid/commit）维护；任意新 scratch/final-lighting destination 首次必须完整初始化，
不可只写 delta 到未初始化的三帧轮转缓冲。稳定直接读 persistent descriptor；若 final lighting 要复制，列出真实拷贝成本，不能声称零发布带宽。
不再为未变化内容构造无消费者的完整中间 descriptor。没有增量收益的分支不增加第二份 history。
更新选择同时观察 page 数、source vertices、triangle/page 工作、MASK bin、clip 输出和 raster 工作；dirtyPageBudget 是上限，不再是唯一成本解释。

### Cost Card（算术与执行预期，不冒称实测提速）

记 V=实际准备唯一顶点，T=候选三角形，P=最终 triangle/page incidences，C=显式裁剪输出三角形。

| 机制 | 删除 / 新增成本 | ideal / expected / worst |
|---|---|---|
| 共享位置 | ADD 至少16V写与后续读；REMOVE 每 pair 的压缩解码/矩阵变换；MASK 活性属性另算 | 多页/高复用获益；单页小几何可能付额外 scratch 流量；无 dirty 不运行。对削减比例0/50/100%，收益分别为 `-A`、`0.5E-A`、`E-A`，break-even `A/E`；E 为原可消除工作，A 为新增准备/流量，E=0 不宣称获益。 |
| dirty/triangle 拒绝 | ADD hierarchy 构建和保守 bbox/bit 查询；REMOVE 无关 refine、triangle/page/fragment | 稀疏更新最有利；全 dirty 最少拒绝但仍有检查；全局 barrier/dispatch 计入。 |
| 页裁剪 | feature 路径 ADD 四 plane varying；显式路径 ADD 最多5×输出与lineage；REMOVE 页外覆盖 | 页外覆盖比例p的净省 `pF-A`，p=0/0.5/1 为 `-A/0.5F-A/F-A`；不把atlas/页面积比当提速倍数。 |
| triangle/page streams | 基础记录目标16B/P，clip输出按实际属性；REMOVE 16B meshlet pairs 与后续重复 class passes | P可大于旧pair数；不能只报删pass。按batch上界分块复用，不分配场景最坏P常驻缓冲。 |
| 过滤 | stable最多9个四深度重建；soft八blocker+八bilinear比较，含跨页查找/Temporal | 提升核覆盖和软阴影能力，过滤自身通常比disk4贵；不承诺采样优化净提速。 |
| 固定元数据 | coarse地址环4×4容纳最多3×3 live；target为最多16×(4096+16)=65792项；descriptor最大1052672B，默认10层657920B；旧高档1579008B | 删除无消费者mip/中间发布；本地score+admission税仍在；新足迹可能增加需求，不能把两种配置直接当同质量比较。 |

初始 transient scratch 预算上限为基础档32MiB、高容量档64MiB，含位置、triangle/bin、裁剪记录；实现必须列出分项与峰值，
不能仅凭单buffer limit隐式扩大总额。分页chunk按此预算分块，不用漏工作换上界。cutover 双代峰值按实际fence寿命计入。
本轮不新增随机depth atomics/全atlas转换/第二深度池；不新增固定全屏阴影 denoise。

## 8. 三步与验证节奏

执行步骤只有三个：**页面/选级资源闭包 → 几何光栅更新闭包 → 过滤集成与手动调优交接**。
不再有单独“候选竞赛”“每patch oracle”“先测试平台”等步骤。
实施过程中按真实编译错误使用 typecheck/shader compile；前两步结束各做一次集中 architecture review 和至多一个小型 GPU 合同检查，
已有未受影响结果不重跑。第三步只集中核对关键独立语义、实际完整Renderer接线、生命周期与粗粒度成本；不重跑历史全套。
不能靠测试次数决定设计，不为旧测试恢复退休owner。测试省略不等于允许错影、漏几何或失控容量。

交付用户：两档过滤、真实世界texel/clip/容量可视化、raw/admitted/ready/fallback/延期原因、Geometry/setup/raster/filter分项时间、
资源和更新上界，以及明确区分无需重建/需要重建的参数。实现者提供合理默认值与基本画面闭合；最终艺术效果、场景预算和参数搜索由用户掌控。
