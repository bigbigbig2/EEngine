---
id: eengine-geometry-residency-startup-2026-10
state: current
verifies:
  files:
    - OEngine/src/gpu/GeometryProductSlotPool.ts
    - OEngine/src/gpu/GeometryProductResidencyProfile.ts
    - OEngine/src/gpu/GeometryProductGpuBudget.ts
    - OEngine/src/gpu/GeometryProductGpuAbiV1.ts
    - OEngine/src/gpu/GeometryProductMultiRuntime.ts
    - OEngine/src/gpu/VirtualGeometryResidency.ts
    - OEngine/src/gpu/GeometryPageStreamingRuntime.ts
    - OEngine/src/gpu/GPUDescriptorCaches.ts
    - OEngine/src/gpu/GpuNativeMaterialScene.ts
    - OEngine/src/gpu/AppearanceProgramRegistry.ts
    - OEngine/src/shaders/virtual_geometry_product.ts
    - OEngine/src/shaders/geometry_source_decode.ts
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/src/render/HierarchicalZBuffer.ts
    - examples/demos/14-integrated/shared/cooked-scene.ts
    - docs/porting/next-renderer.md
---

# 几何紧凑驻留与首帧准备

## 1. 决定与范围

2026-10-16，以 `17252477` 为源码基线。VT模块已实施并做追加评审，用户随后授权本轮详细设计；本轮只建立设计和[执行计划](../next-execution/eengine-geometry-residency-startup-execution-2026-10.md)，未实施下述变化。它是Local Reflection Probes之前的独立专项，不恢复全Renderer性能资格，也不重做INIT/VT。

选择两个相互配合的改动：

1. 保留Cooked逻辑Page、完整性校验、Worker解压和GPU直接解码，物理存储从固定256KiB槽改成**16B对齐的有效前缀区间**；四bank与metadata按目录真实需求规划初始容量，在预算内支持事务式增长。
2. 在现有DescriptorCache和Renderer/scene owners内补齐**真实异步管线准备**，生产编码只消费已准备的准确描述符；把首帧剩余CPU工作分段记录，不用假帧或私有submit预热。

目标是减少无效分配、显存压力和首帧编译阻塞，同时保持最终几何、coverage、VSM、AO、SSSR、Temporal与VT质量。测量设备为RTX2060 **8GB**；历史1650 Ti 4GB资格独立。没有预报启动减少几秒，降低分配也不等于直接提高FPS。

不含：逻辑Page重新切块/重Cook、GPU页内压缩新算法、驻留顶点展开、运行期活页搬移压实、第二套加载器、GPUDevice迁移Worker、VSM算法重写、Probe/GI、新的通用资源操作系统。显存压力由明确预算和真实需求处理，不自动提高LOD误差或降低阴影质量。

## 2. 实际代码与问题归因

| 源码事实 | 本轮处理 |
|---|---|
| `GeometryProductSlotPool`每device共享四bank；固定256KiB槽，bank提前整块创建；`VirtualGeometryResidency.#writeResidentPage`实际只写`rawPayloadBytes` | 上传本来已紧凑，浪费在物理分配和地址ABI；更换分配与容量规划，不能宣称省掉尚不存在的256KiB全量上传 |
| 有效前缀由各group的`offset+payload`最大值决定；不是各group字节简单求和 | 用经验证目录预估前缀，读页后核对；保留内部offset和空隙，不搬排group |
| PageLocation为16B，当前GPU ABI版本为5；slot地址`<<18`，还有已无外部consumer的resident-directory地址字段 | 原子切到ABI6的字节区间；文件名V1不代表当前GPU ABI仍是1，不改变Cooked产品schema |
| `geometry_source_decode`把bank放高2位、字节地址放低30位，后续frame geometry消费该地址 | 每bank地址上界为1GiB，还受真实WebGPU limits约束；不能只看GPUBuffer最大尺寸 |
| `GeometryProductMultiRuntime`metadata固定容量并按固定百分比分段；demo设128MiB，先创建runtime再等待geometry目录 | 等已有并行目录完成后规划metadata与bank；texture准备继续并行，不把整页读取提前 |
| 四bank绑定、产品generation、主视图与VSM共享解码、publication/abort/fence已存在 | 完整迁移直接消费者，保留身份与帧事务，不创建兼容双路径 |
| RenderPipelineCache已有async `prepare/requirePrepared`；ComputeCache只有同步`obtain`；Native材质光栅已async准备 | 扩展现有ComputeCache，同一descriptor只创建一次；不把已有材质准备重复实现为新compiler |
| HZB等仍在首用`obtain`；Renderer初始化还有同步pipeline创建；SSSR已有异步initialize | 按真实启用profile逐owner盘点并接入准备，不能用全库create调用数量代替首帧miss证据 |

VT追加评审的诊断基线：Bistro raw banks 1,610,612,736B、metadata 134,217,728B，有效payload约242MB；Dungeon有效payload约5.71MB，已占槽约311MB、bank分配512MB。这些量分别是**payload、占用区间、buffer分配**，不能相互替换。Bistro目录4.24s、mandatory9.03s、programs14.52s、首个completed frame25.04s来自先前运行；firstUseful24.39s是另一事件。原结果与条件见[VT执行§9](../next-execution/eengine-streaming-vt-execution-2026-10.md)，不是本设计的新测量或正式A/B。

## 3. 所有权与数据流

```text
Authenticated Geometry directories ──→ CPU capacity plan
             │                         │
Existing Worker read/hash/LZ4           ├─→ device shared four-bank byte pool
             │                         └─→ runtime metadata sections
             ↓
Validated raw prefix → unpublished allocation → upload
             ↓
normal frame publication → PageLocation ABI6
             ↓
VG traversal / frame geometry → Visibility + MASK / Surface / VSM
             ↓
mapping revocation → last-consumer fence → allocation reuse
```

| Owner | 拥有 / 不拥有 |
|---|---|
| Cooked loader/provider | 目录、现有Worker读取/完整性验证/解压；不拥有长期GPU bank，不另建GPU控制通道 |
| device共享physical pool | 四bank、区间allocator、bank binding epoch、容量/预算/退休；多个runtime看到同一事务结果 |
| MultiRuntime | 产品身份、metadata ranges/heap、目录容量计划、替换与恢复；不抢占VT/VSM调度 |
| VirtualGeometryResidency | 页状态、区间lease、有效前缀、上传/publication/撤销；只在安全fence后归还lease |
| GeometryPageStreamingRuntime | 现有延迟需求、优先级、读取/上传credit；单位分别为IO bytes、GPU bytes、页数，不再全部按256KiB解释 |
| DescriptorCache / feature owner | 唯一pipeline对象、准确描述符、异步准备与设备epoch；owner决定实际需求，cache不决定feature |
| Renderer / FrameProgram | composition、准备状态和正常帧宏依赖；不拥有另一套资源allocator/compiler，不做本帧GPU→CPU→GPU控制 |

## 4. 紧凑几何物理存储

### 4.1 完整算法来源与本地适配

选用Sebastian Aaltonen的 **OffsetAllocator**，MIT，固定revision `3610a7377088b1e8c8f1525f458c96038a4e6fc0`。已读取完整`offsetAllocator.hpp/.cpp`、测试、LICENSE和README。移植其SmallFloat分桶、32×8两级bitmask选桶、空闲链、切分、双向物理邻居合并和有界node freelist；**不改成JS对象列表、线性first-fit或二次幂大小分配**。具体来源及本地映射见[porting记录](../porting/next-renderer.md#geometry-residency-startup来源计划2026-10-16)。当前只是planned port，未提升为adopted。

TS以TypedArray SoA表达nodes与bin heads，`Math.clz32`实现位搜索，明确u32转换、bit31和shift32边界。零长度Page不发GPU allocation；只迁移本地非零16B unit请求，不声称复制donor零长度行为。每bank一个allocator，最多检查四个bank；按轮转起点选首个能成功分配的bank。桶上取整仅用于找候选，**实际分配长度为请求unit数**，不能额外按桶尺寸预留。

请求长度 `A(p)=align16(max(group.offset+group.payload))`；该前缀必须大于0、不超过逻辑Page 256KiB，与读回后的validated payload一致。目录错误、溢出和读页失败不发布。16B unit不等于dynamic storage binding offset，本方案绑定整bank，内部字节地址不需要按256B对齐；`writeBuffer/copyBufferToBuffer`仍满足4B规则。

allocator节点上限与GPU字节预算独立。容量计划给出最大同时存在的页lease数L，包含active/unpublished/retiring；每bank至多`2L+1`个interval node可作为保守上界，实际TypedArray总字节需列入CPU Cost Card并受显式CPU预算约束。node耗尽单独报告，不能误报成GPU bytes不足。配置增长node存储只发生冷路径；不得每页遍历全部nodes。donor的`largestFreeRegion`是bin下界近似，不能当作精确可分配连续区间；README的12.5%分桶精度也不是全heap碎片上界。

### 4.2 GPU ABI6：保留16B，不保留slot语义

| PageLocation word | 新含义 |
|---|---|
| 0 | `bankAndFlags`：bits0..1 bank，bits2..3 resident/pinned，其他位0；非驻留使用明确sentinel |
| 1 | 16B对齐`byteOffset` |
| 2 | 完整`productGeneration` |
| 3 | 经验证的`payloadBytes`，4B对齐，`0 < bytes <= 256KiB`；allocator容量按align16计 |

metadata header word12由slotsPerBank改为四bank共同的`bankByteCapacity`，其他section描述和16B stride保留；ABI版本5→6，reserved bits必须校验。合法驻留必须同时满足bank范围、generation、flags、offset对齐以及`payloadBytes <= bankBytes`、`offset <= bankBytes-payloadBytes`，避免u32加法溢出。任何group/header/vertex/index读取还须验证其内部range在payload内，不能只检查整个bank。非驻留、旧generation、越界地址均fail closed，不用截断身份掩盖错误。

删除旧slot/resident-directory编码字段与`resident_bank/resident_word`无消费者返回值。物理位置CPU结构统一为bank/byteOffset/allocatedBytes/payloadBytes/lease identity，不把byteOffset塞进原slot字段。`#groupLocations`、budget、stats、回收比较、recovery和oracle同步迁移。

必须在一个architecture unit中切完：ABI pack/validate/WGSL lookup → VG traversal → frame vertex source packed address → frame geometry cached addresses → Native Visibility/MASK → Surface → ShadowGeometryWork/VSM。packed低30位契约继续存在，故`bankBytes <= 2^30`且所有访问end不超过该界。Cooked group内部offset、顶点格式、数值解码和导数语义不变。

### 4.3 初始容量：budget是上限，buffer按需求创建

Profile的设备能力、四bank、storage-binding limits保留；将**最大允许容量**与**初始创建容量**分离。旧caller的configured容量转换为显式上限，demo不再无条件创建该上限，也不再固定128MiB metadata。不能按RTX型号猜可用VRAM。

目录准备保持现有4并行与共享IO credit，等待的是已在读取的目录，不等待全部Page。计划先算：所有已知目录前缀之和D、必须首发pinned/root集合P、最大页、活页/候选/退休lease上界、各metadata section真实计数。默认初始总bank目标为`min(协商后配置上限, align(1.25×D))`，分为四个等大bank并向16B取整；每bank再受maxBufferSize、maxStorageBufferBindingSize和1GiB地址上界约束，不能用先创建后捕获validation error代替协商。1.25是可调容量余量，不是碎片保证。非空catalog每bank至少容纳最大单页；空catalog按API最小合法绑定需求创建，不用固定数百MiB。必须用同一allocator对启动P做一次CPU admission，保证页级连续区间和node容量真的可用；不能只凭字节和通过。

当D超过预算，初始pool使用预算内容量，仍由现有需求调度控制工作集；不为“载完所有细页”阻塞首帧。若P及必要事务余量都不能满足，初始化前明确容量错误，不部分发布后永远等待。已知完整D较小时收益来自实际缩小buffer；只减occupied统计而不减buffer不算目标达成。

metadata按asset-reference、asset、root、hierarchy、group、page、vertex-format的**实际stride×section容量**求和，加64B header和真实product table。不再固定百分比分区。每section初始容量至少为已知目录计数的1.25倍并向整record取整，再加最大单产品同section计数作为一次replacement重叠余量；product table同样覆盖实际产品和候选。超预算时可压缩可选余量，但必须明确可支持的replacement admission，不能悄悄失去原子替换能力。24bit group / 27bit hierarchy relocation等现有编码上界逐项预检，不截断。

### 4.4 后续增长、碎片与帧事务

允许后加产品，不把demo目录静态性写进引擎前提。需求增长时先做预算/admission；容量不足且仍有显式headroom，候选容量按`max(必要容量, 旧容量×1.5)`规划并限制到所有limits。四bank等大增长，**offset保持不变**；新建bank带`STORAGE|COPY_DST|COPY_SRC`，普通帧encoder将旧有效地址区复制到相同offset，再由本帧所有consumer统一绑定新bank。可按已用高水位拷贝，不需要逐页dispatch。allocator只在末尾新增free interval，沿donor已有邻居合并逻辑连接；grow是本地适配，不能重新分配现有页或只增GPUBuffer却未增allocator。初始bank也需COPY_SRC。

metadata增长保持各section内全局record index稳定，扩大section并改变section基址；旧section内容复制到新基址，新header指向新布局。asset/hierarchy内的全局索引不变，所有直接缓存的绝对word地址必须重建。范围allocator扩尾，不重排活记录；无需为此把metadata改成第二套通用分配框架。

共享pool与metadata候选组成一次binding publication：冻结该候选的页/metadata变更快照，复制在consumer之前编码；所有runtime/FrameProgram bindings、bind-group cache与frame geometry地址缓存使用同一个候选epoch。未提交时不推进公开committed epoch；encode期可暂用candidate binding，abort完整恢复旧snapshot并撤销候选写入，retry不能引用销毁buffer。成功submission后按现有`onFinished`规则commit，旧buffer/metadata/lease仅在最后消费者`gpuDone`成功后退休。不能等`onFinished`后才临时给当帧部分consumer换binding，也不能向旧资源补写新布局。device loss清理整代，重建从合法CPU产品/provider恢复。

特别约束上传顺序：增长候选创建至提交/abort期间，pool冻结所有owner对旧bank的新写入与allocation变更；Worker可以继续完成读取，但完成结果进入有界pending队列。该帧新页数据以普通encoder upload/copy在bank复制**之后**写入candidate，不能先`queue.writeBuffer(candidate)`再被旧bank整段copy覆盖。其他runtime不允许并行编码混合epoch的增长事务；共享pool在CPU编码边界串行协调一次切换，已提交旧帧继续合法读旧bank。abort后解冻旧代并重试，不能遗失pending数据或泄漏credit。此冷路径协调属于pool owner，不扩展成全资源全局调度器。

新旧buffer同时存在的峰值纳入device ledger：active + unpublished + retiring，**不能先减旧bank预算再分配新bank**。增长credit不足就保留旧绑定并等待既有退休，或给出容量不足；不额外submit，不阻塞主线程等待GPU。每次至多一个pool增长候选，多个runtime请求合并。失败/abort不挤掉当前可用场景。

正常路径不搬活页。free合并仍可能外部碎片，处理顺序为：精确allocation失败分类 → 现有冷页逐出/撤销 → fence后重试 → 有预算时增长；pinned不可逐出。调度按可回收字节与有界retry推进，记录真实失败原因；若仍不够，报告unserviceable/current-view未收敛，不能无限evict/reload颠簸或永久静默漏页。活页压实是未来有实测需求才另开的算法，不偷偷塞进本轮。

## 5. 准确异步管线准备与首帧调度

### 5.1 复用现有生产owner

扩展`ComputePipelineCache`为与RenderCache一致的async prepare、in-flight去重、`requirePrepared`、设备epoch清理；描述符key与运行期同源，包含shader、entry point、constants、layout及实际render formats等。失败promise清除以允许显式retry，旧device的late resolve不得重新填cache；保留错误上下文，不吞异常。已准备pipeline必须就是生产消费的对象。

Renderer owners区分“不依赖scene的启用feature管线”与“依赖材质/布局的scene管线”。前者在renderer.initialize中并行受限准备，后者复用`AppearanceProgramRegistry`和`GpuNativeMaterialScene.prepareRasterPrograms`现有16路有界准备。没有第二个无界Promise.all编译洪峰；同一device的新增准备使用共享credit，默认上限不超过现有16，实际数作为诊断条件记录。SSSR现有async initialize直接纳入同一ready语义，不重新编译它。

实施盘点必须列出首帧真实需要的owner/variant及miss，不限定为静态名单：HZB、Visibility/Native raster、Surface/background、VSM、AO选定quality/denoise、LocalLightWork、Radiometry、Temporal选定路径、Bloom、Present以及启用的Environment/Sky/Aerial/SSSR。disabled feature、未选quality和debug variant按需准备，不能为了“首帧零miss”编译全仓库。

descriptor生成独立于当前frame绑定/history，准备只需要真实feature profile、格式、limits、material topology等不变量；不造假资源、不预执行lowering或假提交。把生成descriptor与获取pipeline分开以复用，不新增一份只供warmup的shader/常量组合。

### 5.2 首帧与运行期变化

```text
GPU initialize + enabled feature PSO prepare ───────────────┐
directory IO → capacity plan → pinned pages ────────────────┤
texture mandatory + coverage → material/native PSO ready ──┤
                                                         ↓
                 exact scene/profile ready → normal first frame
```

依赖未满足时不进入GPU帧事务、不推进history或frame identity，UI tick仍可响应。ready只代表真实pipeline准备完成、mandatory产品可发布，不声称隐藏所有driver开销。第一帧仍用真实scene/view进行lower/encode/finish/submit，禁止dummy graph、额外frame submit或空draw预热。

首帧生产路径对已纳入prepare的PSO cache miss要带owner/key明确报准备遗漏，不能同步`obtain`偷偷补救；非生产reference路径可保留自身合法创建方式。NativeVisibility已有preparation应改为准确消费`requirePrepared`，避免重复无用module/layout构造，但不把它错误报告为此前完全未准备。

feature/profile变化需要新variant时，先准备candidate，保留当前已提交profile；准备成功才在正常边界切换产品/图，失败保留旧profile并暴露错误，不静默关闭效果或降低质量。resize只有确实改变PSO描述符时才重编；cut/普通history reset不应触发PSO准备。设备丢失取消整代准备，恢复后重新gate。

现有Worker继续执行read/hash/LZ4和CPU准备；不为本轮创建GPU Worker。独立GPUDevice不能复用主device的pipeline/resource，迁移整个renderer到OffscreenCanvas是另一架构项目。增加Worker数量前必须证明Worker CPU是关键路径，不能让线程数掩盖GPU内存分配或driver编译。当前Cooked路径没有运行期BC重Cook，本轮不虚构删除这项成本。

## 6. Cost Card与预期边界

| 机制 | 删除 / 新增成本与上界 |
|---|---|
| 紧凑页 | 删除`N×256KiB - ΣA(p)`占用浪费；alignment每页<16B。GPU PageLocation仍16B、四SSBO不变；slot shift换byte offset，额外payload range检查计ALU。native材质samples、GPU解码和逻辑IO页大小不变 |
| allocator | CPU每次最多四bank bitmask/bin操作与有界node存储，无GPU atomics/barrier/dispatch，无frame逐页全扫描；退页只处理实际事件 |
| 初始容量 | 删除超出计划的bank/metadata整块分配；保留25%可调余量和replacement重叠。driver可能延迟commit，buffer字节不能当OS实际VRAM |
| 增长 | 冷路径复制bank高水位/metadata section，新增candidate bytes和新bind groups；最坏新旧同时存在，受同一peak budget控制。正常帧没有增长copy |
| async prepare | pipeline数量原则上不增加，删除首用同步创建fallback；增加promise/key/in-flight CPU状态及有界并发。无新增GPU dispatch/submit；不能保证消除driver第一次执行成本 |

紧凑分配0/50/100%敏感性：若所有Page前缀均256KiB，allocation收益0；若平均前缀128KiB，occupied约减半；若前缀趋近最小非零有效大小，浪费接近全部被移除。实际初始buffer还受headroom/四bank分布/预算与碎片约束，不能拿理想occupied节省当实测显存节省。该改动的主要break-even是allocator CPU成本与新增range检查相对于内存压力/容量收益；全大页场景不承诺GPU净提速。

管线准备必须比较从navigation开始的总wall-clock：若只是把首帧等待移到initialize，总时长未下降，就只能报告响应性/编译位置改变。并发过大导致driver/CPU争用时降低共享credit，以总启动和尾延迟选择，不以prepare promise更早开始作为收益。

## 7. 备选方案与风险

| 备选 | 裁决 |
|---|---|
| 重Cook成更小Page | 影响磁盘格式、层级/流送和完整性；不能单独解决固定物理槽。留以后IO粒度实测，不是当前先决条件 |
| 二次幂slab/buddy | 易实现但仍有内部浪费；已有成熟OffsetAllocator提供精确长度和合并，优先移植后者 |
| 硬件sparse/bindless | 核心WebGPU无本项目可依赖的对应能力，仍使用四bank合法绑定 |
| 一次预分配最大bank | 无增长复杂度，但保留当前主要浪费；不作为默认生产模式 |
| 每帧活页压实 | 放大copy/地址失效/VSM与缓存一致性成本，本轮明确不做 |
| Worker创建另一个GPUDevice编译 | pipeline不能跨device共享，无法解决当前主device准备 |

主要风险是allocator移植的u32边界、碎片、metadata增长时绝对地址缓存遗漏、共享pool多runtime切换和异步准备遗漏variant。执行以直接consumer闭包和独立oracle约束这些风险；不能用“多数场景可跑”代替abort/retry与最后consumer退休。

## 8. 验证与完成定义

工程量分为三单元，状态只读执行计划：GRS-1完成物理/metadata/ABI与全部consumer原子迁移；GRS-2完成准确async readiness；GRS-3集中真实GPU、场景与成本复核。中间只typecheck、allocator/ABI等小范围语义，不每patch全套browser/benchmark。

最终必须同时给出：独立区间oracle与来源向量；ABI generation/范围及GPU数值等价；Main/MASK/Surface/VSM生产接线；共享pool增长、metadata增长、release/replacement/abort/retry/device loss；Bistro/Dungeon相同功能质量下冷/暖启动和稳定视图，分清目录/mandatory/programs/首Useful/首Completed/收敛，列CPU/GPU/IO/in-flight峰值。原始失败保留并局部返工，不删除难场景或省略质量以获得数字。

源码/API来源：OffsetAllocator固定源码见§4.1；WebGPU规范固定至`gpuweb/gpuweb@25a5dc4537074c9b3844dd95891f5cfd193f4407`的`spec/index.bs`，pipeline creation章节明确同步API返回对象不代表后台编译已完成，async API在pipeline创建完成后resolve；首次setPipeline/finish/submit仍需实测。具体来源入口见porting。未实现前，本文件不声明新性能、数值资格或source adoption。
