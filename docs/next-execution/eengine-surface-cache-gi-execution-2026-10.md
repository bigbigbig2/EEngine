---
id: eengine-surface-cache-gi-execution-2026-10
state: current
verifies:
  files:
    - docs/next-design/eengine-surface-cache-gi-2026-10.md
    - docs/reviews/EEngine_Surface_Cache_GI_WebGPU_Mother_Design_2026-10-17.md
    - docs/porting/next-renderer.md
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - OEngine/src/render
    - OEngine/src/gpu
    - OEngine/src/assets/geometry-product
    - OEngine/src/framegraph
    - OEngine/src/material
    - OEngine/src/shaders
---

# EEngine Surface Cache GI：完整执行与验收计划

唯一详细设计为[SCGI设计](../next-design/eengine-surface-cache-gi-2026-10.md)。需求输入为[母稿](../reviews/EEngine_Surface_Cache_GI_WebGPU_Mother_Design_2026-10-17.md)；设计§17逐项映射母稿，设计§1列明勘误。本文件是细单元状态与实施结果唯一记录，workstream和粗执行不复制细状态。

**SCGI-1、SCGI-2与SCGI-3的实现及局部验收已闭合；SCGI-4、SCGI-5未闭合，生产GI未开启。** SCGI-2当前交付为静态/刚体、精确coverage、GPU世界域工作集及本地publication，结果与边界见§7.9；完整Renderer集成仍按既定节奏在SCGI-8/10集中完成。用户2026-10-17授权先补齐SCGI-2，再复核关闭SCGI-4，最后完成SCGI-5剩余机制与整体验收。用户确认暂不实现skin/morph；未证保真的raster coarse不当有效遮挡，4GB不作复杂大场景承诺。§7.6～7.8保留此前实施快照，不覆盖本节与§7.9的当前状态。本轮停在SCGI-2边界，不自动提升SCGI-4/5或开始SCGI-6。

## 1. 完整范围、依赖与生产切换

| 单元 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| SCGI-1 | owner/publication/事务/能力与具体ABI | 源码基线和source map | 已完成，见§7 |
| SCGI-2 | GeometryProduct query section、coverage cut、residency、共享刚体实例publication | 1 | 当前静态/刚体范围实现及局部验收完成，见§7.9；生产集成归8/10 |
| SCGI-3 | cascaded sparse cache、ring/scroll/evict/defrag/rank | 1 | 已完成，见§7.5 |
| SCGI-4 | half-res anchors、共享identity、screen history seed | 2、3 | 基础闭包已实施并验证；待在SCGI-2当前产品上复核关单，本轮不自动关闭 |
| SCGI-5 | 完整RadeonRays算法适配、query、material/alpha/VT | 1、2 | 实施中，未关单；先返工SCGI-2及SCGI-4，见§7.7 |
| SCGI-6 | 全光源估计、punctual重连接、multi-bounce | 3、4、5 | 待实施 |
| SCGI-7 | 统计、动态失效、A0/A1/A2过滤、L1 screen field | 6 | 待实施 |
| SCGI-8 | FrameProgram+Native全部route原子接线、旧owner退休 | 1–7 | 待实施 |
| SCGI-9 | Screen Radiance Gather完整近场残差增强 | 8 | 待实施 |
| SCGI-10 | 全场景、故障、资源峰值、成本与文档闭合 | 8、9 | 待实施 |

SCGI-2与3算法依赖可独立准备，但遵守本仓库不使用子agent、GPU验证串行的要求。单元内允许代码暂时不可运行；稳定边界不能有两套production GI。SCGI-1～7构建完整新闭包并用真实算法fixture验证，**SCGI-8之前不把部分实现打开为默认生产功能**。既有renderer保持当前行为；测试fixture不是生产fallback。

母稿Phase A的“架构Cutover”拆为SCGI-1定义接口和SCGI-8完整切换，避免空owner先上线。Phase B/C/D/E/F/G/H/I分别覆盖3/4/2+5/6/7/8/10/9；没有删除Phase I或把alpha/动态留到不明确的未来版本。

## 2. 每个单元通用完成合同

1. producer→产品→全部直接consumer、bindings、完整写域、invalid与容量均闭合；新增consumer不能偷偷另建world/material数据库。
2. 记录实际source revision、文件/函数、采用/改写/本地新增、关键分支和不同物理调度。没有移植的部分明确为Reference/Local，不能只写“参考RTX/Unity”。
3. 动工前更新本单元Cost Card的ADD/REMOVE、bytes、samples/ALU、随机/顺序访问、atomics/barriers、dispatch/PSO、stable/peak。没有优化要求净提速；做优化则给0/50/100%收益和break-even。
4. commit/abort的局部owner协议由少量独立用例验证；GPU读写相关部分按需验证最小真实command输入→输出。完整Renderer中的未提交失败、已提交通知异常、异步error、retry、disable、resize、replacement、loss、last-consumer fence组合，在SCGI-8接线后及SCGI-10集中验收；不在每个前置单元重复全套。已发现的owner错误就地修复，错误分类见§5。
5. 按用户2026-10-17再次确认，开发中以连续完成功能为主，按需typecheck/shader compile/极小targeted；不用宽泛文件名匹配运行整类回归，不为旧测试恢复旧ABI/owner或新增兼容桥。前置单元实现完成时做相关编译、少量必要语义/生命周期验证，GPU算法按需做最小独立oracle；完整生产宿主、全场景接线/画面/组合容量与粗成本集中到SCGI-8/10。未受影响验证不反复跑，无关失败记录分类；工具命令沿仓库package scripts，不发明尚不存在的脚本名。
6. 所有必需失败、未运行项保留原结果；不能降低alpha/材质/几何范围、跳断言、改容差或缩最终场景来关单。仅表示测试可随旧ABI退休，数值/identity/生命周期语义迁给新owner。

以上调整改变验证时点与范围，不取消算法机制：例如SCGI-2尚缺query cut/工作集机制属于实现未完成，应继续编码；完整生产画面和跨系统组合验收则归SCGI-8/10，不要求SCGI-2先交付整个GI。分开记录实现、局部验证和最终集成结果，不因未来集成用例未运行反复重开已完成的前置实现。

## 3. 各单元详细工作

### SCGI-1：具体owner、事务、publication与能力布局

**目的。** 先确定资源实际写入、发布和依赖边界，让后续cache/AS算法接到现有single submit，无第二renderer。这里不需要先造几十个空接口。

**修改位置。** `render/gi/`的settings/ABI/runtime/publication；FrameProgram/Bindings/Lowering与RendererCore只准备有限需求/组装合同，生产开启在8。检查`ShadeGPUCommandContext.finish`、FrameCoordinator、ResourceAccounting、descriptor/bind-group caches，原则上复用，不另建提交框架。

**具体工作。**

- 将设计§3、12变成精确CPU state/transition；active/candidate/frame-readable/retiring与deviceEpoch分离。commit函数幂等、无分配、不抛异常。
- 实现设计§19当前ABI：64B SurfaceIdentity、8B cell、304B patch/bank（含A0/A2）、112B request、112B half field/guide、128B primary anchor、64B raw cohort、64B node+8B links、128B query instance、48/32/32/64B ray/result/payload/continuation。SCGI-4修正了此前48B身份缺少独立local primitive的问题；offset/stride/alignment由CPU pack与WGSL load/store独立核对；continuation同时保TLAS/BLAS返回上下文，撤销旧256B patch/16B identity/32B continuation预算，layout变更同步设计§15/19。
- 双world state完整copy、GI private临时资源、immutable staticAS、dynamic candidateAS与resource leases分清；不能把所有资源机械双份，不能漏复制allocator/history。
- 建frame binding resolver，缓存图每帧取当前publication；compound semantic fact验证每个constituent格式/extent/完整写域。
- capability preflight覆盖全部Native route和SSSR组合。默认GI复用既有lighting-directory binding；定义全目录/stripe窗口容量route、subgroup/portable与finite AS shard。满绑定不能以额外一张texture解决。SCGI-1给出可执行的容量/descriptor planner，GI writer与Native读取在7/8接入，不提前造空生产stage。
- disabled无新资源/dispatch，retiring独立计账；空场景/Unlit-only无伪GI需求。可观测统计结构在此定，延迟readback不能参与生产工作控制。

**producer / product / consumer。** Scene publications+settings→GI frame transaction→query/cache/field encoders；field→Native consumer在8接入。事务header只表示已编码语义，不证明GPU完成。

**容量与失败。** 创建前拒绝不可表示capacity/size；资源分配失败不改active。submit前abort丢command；submit后错误保留fence并poison依赖generation；device loss不把拒绝fence当可跨epoch复用。

**验证。** 独立CPU状态oracle；真实GPU写入已知map/irradiance→abort验证active不变→retry结果；连续3帧in-flight覆盖次序；提交后callback异常、异步validation/loss故障注入；resize/disable的旧资源计数最终回落。ABI pack/unpack验证identity最大值与invalid，不用只有全零的fixture。

**必须具体交付的合同。**

| 合同 | 实现与独立预期 |
|---|---|
| allocation plan | extent/R/C/K/U/batch/shard与实际limits决定allocated bytes、binding bytes、aligned ranges；溢出先于createBuffer失败，预算不得只算SH |
| world role | prepare不换active；copy/reset只进command；pre-submit abort不改generation/sample序号；提交后commit只登记角色和lease |
| screen role | world-only双history与directory最多3槽分别记账；resize保world换screen；gather未启用不分配其资源 |
| identity与lease | address generation、semantic identity、numeric revision、device/view epoch分离；cached graph每帧解析当前资源 |
| error state | 提交后observer错误不rollback；validation/OOM/loss poison后继history；迟到callback不改新epoch |
| descriptor inventory | 现行16 SSBO/4 groups Native组合零新增binding；query tail的目标清单按设计§19建plan，sampler/texture/uniform独立核对 |

GPU事务fixture可以写固定值验证真资源/command行为，但不接为生产GI。后续query/cache尚不存在是本单元边界，不创建假的算法来凑consumer；应交付可运行的资源/事务骨架与生命周期验证，而非只有interface。

**成本卡。** 新增两bank及copy；metadata/frame constants、queue ordered复用、replacement峰值；不新增frame submit或同步GPU读取。检查graph/PSO key数与unique physical profiles相符。

**关单条件。** 资源事务、ABI和capability routes可执行验证；尚无生产GI画面如实记录，不把debug常量场当效果完成。

### SCGI-2：GeometryProduct Query Section与世界覆盖

**目的。** 用已有虚拟几何建立离屏可见性，避免全部复制mesh或仅trace相机可见集合。

**修改位置。** `assets/geometry-product/GeometryProductV1.ts`所在Product家族、cook/serialization/provider/validator；GpuRenderWorld/GpuScene、VirtualGeometryResidency/GeometryPageStreamingRuntime、Product byte pools；query scene view。

**具体工作。**

- 一次完整更新Product query section版本、recipe、page/group/triangle/UV/material remap、bounds/error与minimum coverage cut；offline与web-runtime producer均覆盖。
- 保留完整性与source ownership规则；新descriptor不能把旧page bytes当新ABI。读旧产品的路径为已定义recook或明确拒绝，不做渲染期隐式第二mesh缓存。
- GPU instance query view读取已发布set/slot/generation与变换，不每帧CPU per-object构建可见列表；scene structural upload沿现有批量owner。
- domain内完整coarse coverage+guard，fine query cut不依赖raster visibility；query LOD误差/alpha-critical/薄墙约束进入选择。unknown与miss不同编码。
- query leases延长page有效性；page搬迁、fine publish、AS rebuild、Product replacement原子交换；旧page/AS/mat refs最后fence后退。
- 实现刚体 transform view、负/非均匀缩放、共享 current/previous transform 与 Product replacement。用户本轮确认：skin/morph 随后续共享动画模块实现，不属于 SCGI-2 交付或关单前置；无共享位置流的非零 deformation revision 返回 unknown，不伪造有效动态几何/history。后续扩展合同见设计§4.3，不建 GI 私有 skinning。
- 64B身份所需的slot lifetime由既有GpuScene分配owner side table补齐；materialValueRevision用真实内容版本，不能把nativeMaterialRevision有限hash当稳定身份。page搬迁不改变stable primitive，topology替换则改变generation。
- origin rebase与真实moving assembly区别；camera teleport有query coarse预取/有效性，不能走到新区域直接把所有未驻留物体当不存在。

**producer / product / consumer。** Product cook+GpuRenderWorld→QueryScenePublication/page leases/covered-domain→SCGI-5 build/traversal与SCGI-4 anchors。loader只交付数据，无长期GPU owner。

**容量与失败。** coarse闭包不满足budget则该scene/profile拒绝启用或显式缩active GI domain；不截断实例。fine请求延迟服务、完整coarse继续；目录超limit用分段arena。缺coverage texture不发布ready scene。

**事务。** 新query directory与geometry/material revision同一frame事务；readPage迟到结果核对Product+device epoch。abort不释放active pages；submit后旧区间只在最后query fence释放。

**验证。** 离屏墙仍遮挡、只转camera不删query instance；跨page triangle/UV/material remap；coarse/fine切换无coverage洞；精化和evict同帧竞争；product重用slot、page搬迁、cancel/retry；rigid/非均匀/负缩放/current-vs-previous；未支持形变必须保持 unknown；薄墙、门、栅栏与coarse proxy高精参考对比。

**成本卡。** per-instance/query cluster/page metadata、额外proxy bytes、因query pin多驻留的共享payload、build/replacement峰值、流送带宽；共享内存和增量内存分别列。

**关单条件。** 全合法 Product 来源及当前静态/刚体动态路线都有明确 query 事实与完整覆盖，不允许用独立import mesh bypass证明新Product已接通。

**覆盖决定。** 每asset保存minimum query cut/coverage-critical类别；测试domain边缘、offscreen实例、同mesh大量实例与父子LOD不重叠。query proxy确需新增payload就列真实增量。刚体动态测试同时检查raster/VSM/query变换与旧资源退休，只有GI debug三角形移动不能证明完成。skin/morph 有效路径验收随共享动画模块进行，不阻塞本单元。

### SCGI-3：稀疏cache与GPU allocator

**具体工作。**

- camera-follow C cascades、A4×4 oct方向分桶、world→logical→toroidal storage与反向映射，支持非2次幂R。
- 两bank map、patch backreference/slot generation/rank/geometry/stats/A0/A2；claim与init/publish分dispatch，唯一writer；A1单scratch与raw cohort不机械复制到双bank。
- ring空/满、wrap、eviction、rank0优先与rank1公平、last-access；full pool时deferred request与fallback可观察。
- rank0超龄先demote到rank1、再超龄evict，启用bounce时保留此二段机制；access age不替代lighting update age。
- scroll slabs、jump cascade失效、过期unmap；有界defrag两阶段move/remap，不能移动正在被active reader引用的字节。
- GPU compact active/update lists、counts、indirect args；固定CPU命令上界内完成，counts不readback。
- bounce requests去重与上一代消费，rank1重新可见提升0；队列overflow不破坏已有map。

**producer / product / consumer。** camera+screen/bounce demands→candidate map/patch pool/update list→estimator/lookup。3可用数学debug输入验证，但fake irradiance绝不能进入生产。

**容量。** request capacity与patch capacity分开；request溢出使用计数/重试/公平采样，不假称所有需求已满足；existing pixels始终有defined fallback。counter wrap与slot ABA显式reset epoch。

**事务。** map、claim、allocator count/start/end、backreferences、统计和bounce requests一起candidate化；abort保持active完整一致，defrag结果不能部分publish。

**验证。** CPU reference地址/alloc模型与GPU结果对照；大量线程同cell竞争；rank promotion；环绕full/empty；相机跨1格/多格/整volume；非幂R24；反向法线/双薄面；defrag链/循环移动；32-bit边界；强制pool满与次帧恢复；abort后每个cell↔patch一致。

**成本卡。** 8Ncell/bank、实际patch stride、request/sort/move buffers；全扫描最坏与slab平均；map/patch随机访问与原子数；defrag budget、copy流量；0/50/100%需求重复时的claim成本。

**关单条件。** 有界容量、不泄漏、不越界、不本帧CPU控制；starvation窗口内存在真实更新，不仅计数器递增。

**调度细节。** access/update/birth age和dirty epoch分开。新rank0、旧rank0、rank1均有配额；U小于持续新增需求时不承诺固定deadline。defrag修cell backreference/slot generation/request引用，并一起搬A0/A2/stats。dirty overflow升级域失效；allocation overflow可defer新patch，但不能取消已计划样本后改分母。

### SCGI-4：Half-res Anchor与history seed

**修改位置。** GI anchor shader、primary geometry/temporal helper、Native Surface seed生成共用数学，当前Temporal owner不接管GI history。

**具体工作。**

- 2×2实际winner轮转、完整sky/invalid写域、ceil half dimensions、source pixel记录。
- VisibilityKey本帧解码到完整stable identity；primary position/flat normal/current/previous transform、jitter一致的motion/depth，非法或缺previous deformation拒绝history。
- 当前anchor→rank0 request；prev committed **world-only** field→newpatch seed，双向plane-distance、normal/depth/完整identity/epoch验证；screen residual和最终HDR永不作为seed。
- seed初始化A0/A2及统计valid，真实query count为0；A1当帧重建，不以seed伪装收敛。
- resize/scale只重置screen role；cut拒绝seed、world重叠保留；exposure不触发world清空。

**producer / product / consumer。** visibility/work/GeometryProduct/current-prev实例→anchor+rank0 demands→SCGI-3 allocator、SCGI-7 screen lookup；prev GI field→newpatch seed。

**容量/事务。** H anchors完整写域；invalid绝不读未初始化history；current/previous roles只提交成功后交换；Abort不推进sample phase/history roles。

**验证。** 与Native现有seed的相同primitive数值对照及独立投影oracle；奇数分辨率1×1/1919×1079，sky、细杆、屏边；camera平移/旋转/180°/teleport；rigid、deform previous缺失、实例slot重用；遮挡揭露不跨对象seed；screen resize而world irradiance不无故消失。

**成本卡。** H级几何重建、guide/identity读写、history sampling；source pixel与motion中间值优先invocation内存，必要material身份字段列bytes；不新增全屏normal GBuffer。

**关单条件。** GI在Surface前独立完成所需temporal事实，没有GI↔Surface环；history接受必须有正确性证据，不以画面“似乎稳定”替代。

**补充fixture。** 同primitive index不同instance、set/slot重用、material value改变、Product物理搬迁、deform previous有效/缺失分别测试。严格身份用于history重投影；空间upsample按几何/材质相容性，不能要求邻tap同primitive而让所有三角形边缘失效。world/residual共享guide必须同role，不能拿新guide解释旧系数。

### SCGI-5：完整WebGPU compute query与材质命中

**来源。** 固定RadeonRays build_hlbvh、radix/scan、update/restructure、BLAS/TLAS intersector与structures，保留MIT notice；Unity仅对照行为。source map按实际函数逐项填写，不能只记录项目名。

**内部依赖顺序。** bounds→Morton→radix/scan→EmitTopology→分层refit→treelet restructure→TLAS→traversal→coverage continuation→diffuse-hit projection。opaque里程碑仅用于调试，不作为关单范围。

**具体工作。**

- portable与subgroup两个物理kernel保持同算法结果；对重复Morton、退化轴、0/1元素、非幂长度有专门分支。
- WGSL跨workgroup采用dispatch边界；parent pointer-jumping→depth histogram/scan/scatter→level-list/refit，不能同轮原地读写ancestor。treelet重排后重建links/levels，再refit；异常深度用完整balanced-range rebuild，不能反复重建同一失败拓扑。
- 静态BLAS复用，动态leaf/refit/restructure/rebuild，TLAS instance transform/mask/目录；dirty/rebuild队列由GPU写。
- ray-box/triangle、t interval、barycentric、frontFace、negative scale；closest/any accepted query、完整traversal stack/spill/continuation。
- native coverage bin分类→shader execution→accept/reject→继续遍历；K轮快速wavefront后由同提交native coverage-bin+shard完整遍历收尾。Program/physical banks复用Native体系，不造VM；node quantum不是透明层数上限。
- 收尾state保存TLAS/BLAS入口/返回、instance与best hit，上界计每instance的BLAS重复访问；零count indirect仍计CPU编码成本。共面/等t候选使用原区间与稳定顺序，不能epsilon跳过未接受alpha面。
- hit diffuse/emissive projection保留custom graph、UV/vertex inputs、ray-cone C/X/Y footprint、显式梯度、颜色解码、VT低优先feedback及coverage resident闭包。真实camera graph输入不能被transport direction替代，view-dependent输出参与失效。
- status区分hit、miss、unknown、不可信inside、pending、fault；pending仅存在同command内部，结束必须accepted/miss或明确cohort-invalid，不跨帧保留未完成alpha。

**容量。** ray batch重用scratch、finite sharded node arenas；stack超界spill或parent continuation；batch/AS arena各自整体满足单binding上限。全部相关shard/bin完成才能判miss；counter溢出、cycle或无进展是fault。静态dispatch上界、coverage tail与最满custom材质均须测，有界但过大仍是本单元待解决成本。

**事务。** 本提交scene snapshot immutable，所有alpha续跑在其中完成，不因下一帧动态revision变化取消本帧工作。整patch cohort完成才发布；unknown/fault保留旧信号、降低confidence。动态AS candidate不覆盖仍在读取的active数据；fence退休包含page/material/coverage leases。

**验证层级。**

1. CPU brute-force triangle oracle独立于BVH，验证closest t/primitive/barycentric和any visibility；包含三角形边/顶点、平行ray、zero direction、极大/极小坐标与自交。
2. GPU排序/拓扑/每node bounds与CPU reference；shuffle输入/重复keys；所有leaf可达且只出现一次；parent覆盖children，refit与full rebuild一致。
3. 同ray集跨portable/subgroup/不同合法workgroup尺寸；GPU层间结果不得靠驱动偶然可见。
4. MASK多层栅栏/叶片与custom alpha RGB依赖；最前候选reject后命中后方；多实例同primitive id；深度超过单wavefront预算后完整结束。
5. 真实GpuRenderWorld/Product/VT输入，无独立测试mesh替代生产数据；page evict/move/revision/rigid transform发生时hit仍匹配。skin/morph 有效输入随共享动画模块扩展。
6. 同ray跨shard/coverage Program的最近accepted合并；透明面后不同bin的不透明面；全透明物理miss与domain unknown区别。持续移动的深alpha场景完成cohort，不发生跨帧重启饥饿。
7. 最满storage/sampled/sampler/groups route真实创建和编译；无第二完整vertex/index库。GPU fault不能被延迟统计伪装成valid。

**成本卡。** T nodes与refs、128B instance、sort/levels/restructure scratch、ray batch bytes、stack/spill、alpha bin队列、native sample次数；build/refit与trace分开GPU timestamp；静态/动态、opaque/alpha、cold/hot分别统计。性能慢先归因，不删语义。

**关单条件。** build/update/query/hit/material/coverage完整链在真实owner上验证；不是“ray打到三角形”的demo。source adoption仍需8的真实production消费后才能提升。

### SCGI-6：完整irradiance estimator与multi-bounce

**具体工作。**

- hemisphere/PDF、标准SH投影/cosine卷积；随机序列由patch identity/sample serial驱动，每次尝试包括物理零/unknown均推进，pre-submit abort不推进。重复失败方向不能卡住序列。
- environment miss/unknown分离；sun direct与environment太阳能量分区，world visibility包含alpha；emissive不乘albedo/π。
- 从LightDatabase发布当前全灯集合，light-origin samples→geometry/material hit→surface sample pool→patch reconnect，完整PDF/Jacobian/range/spot/visibility。
- 全灯均匀采样reference与有支持闭包的power sampling；禁用前N灯截断和屏幕tile误用；灯删除/变更使旧samples失效。
- multi-bounce只读上一committed bank的A0；rank0产生rank1 demand，cache缺失不伪造高置信；不读本帧A1/A2反复空间扩散。
- cohort预定Nhemi/Nconnect、sample IDs与snapshot；遮挡、合法零cosine、无hit light sample、零反射率占分母N并贡献0。unknown/inside-invalid/fault使整patch cohort不发布，不能按已完成子集归一化；分类统计保留。
- light pool固定槽包含no-hit，均匀抽槽不额外乘Nlight；非均匀q_j补1/(Nlight·q_j)。按设计§8.3实现solid-angle→area Jacobian，解析抵消grazing cosine，不用任意近距离clamp掩盖PDF错误。
- 算法固定linear Rec.709/unexposed，Native一次转Rec.2020+preExposure。太阳用hitPosition的大气透射/solar LUT；surface-transport与shadow mask分开，CastsShadow=false不删除可见表面。

**producer / product / consumer。** update list+query scene+material/light/environment+active cache→raw RGB L1/short statistics/bounce requests→SCGI-7 filtering。

**容量。** 新ray数与alpha traversal invocations/node visits分开计。light pool/reconnection/newbounce各有上界；同提交完整查询不因batch切分改变分母，整cohort失败不作零贡献成功。

**事务。** irradiance/stats/sample sequence/bounce queue写candidate；geometry/light revision混合禁止；sample池能复用的条件显式，不跨灯光删除继续使用旧slot。

**验证。** 恒定天空`E=πL`；黑反射/白漫反射/Cornell红绿墙；单太阳遮挡与开门；点/spot的range与cone；emission-only黑albedo仍发光；单跳/多跳开关、反射率变化收敛；普通hit+reconnect无双计；相同几何多实例重连接身份；空间外unknown不能漏天光。使用高样本CPU/offline reference确定统计容差和收敛窗口，不能以单帧随机误差判错误或放任长期能量偏差。

**成本卡。** 每类query数、shadow ratio、alpha rejects、cache lookup次数、更新率、light sample池bytes与dispatch；理想无hit/常规场景/最坏alpha+多灯分列。

**关单条件。** 所有光源类别、alpha、offscreen和multi-bounce均实际完成，不能用“以后接Local Shadows”推迟GI hit处的遮挡。

**独立数值预期。** 全球常量/半球常量分别检查；后者标准L1在任意n为`πL(1+n·ng)/2`，ng处πL，不存在讨论中误算的5πL/4。窄亮源对比精确cosine的差异属于表示偏差，不是浮点容差。重连接用独立面积积分验PDF/池抽样，不能只把GPU与逐字翻译的同错误公式比较。提交后失败与pre-submit retry分别验sample serial。

### SCGI-7：A0/A1/A2、动态失效与方向性field

**具体工作。**

- A0估计累计：完整raw cohort→short mean/variance→drift hysteresis→持久L1；只有完整cohort增加真实count，物理零照常更新，无有效cohort保旧降confidence。
- dirty geometry old/new bounds、material/emissive、light/environment epoch；bounded full-domain age refresh补局部dirty传播不足，dirty overflow升级失效域。
- A1空间阶段：immutable本帧A0→48K scratch，tangent-plane/normal/plane/cascade checks，全部live目标完整写；不增加MC count。
- A2独立temporal post-filter：A1（spatial开启）或A0+上一代A2→candidate A2，不再次更新moments/count。支持spatial/post四种组合；首次启用post、spatial/radius变更按设计reset/seed A2。
- world cache lookup保留中心、jitter位置/方向与rank0邻域机制；half-res field完整写域/validity/confidence/guide。
- 标准L1压缩/解压和f32 accumulation；zero/invalid/HDR策略；screen half存储误差不改变世界单位。

**producer / product / consumer。** raw estimate+active statistics+dirty→candidate filtered cache→field；field→Surface以及下一帧seed。exposure无权改变world cache数值。

**容量/事务。** A0/A2在288K/bank内，A1 48K单scratch；field+guide 96H/role，双history与目录帧槽分别计账。全目录/stripe按设计§10/15计划。settings改常量，表示/extent改变需replacement；filter abort不推进role。

**验证。** 0variance/黑场/高HDR/突然开关灯/移动emissive；门打开后远端响应；两薄墙/同向近邻面不串光；cascade边界与scroll稳定；seed不伪造sample count；SH旋转与normal-map方向性；所有texel含background和odd边界完整写；half round-trip误差由量化范围给出。

**成本卡。** temporal约K级顺序读写、spatial K×taps随机map、lookup H×samples、SH storage与guide；静态/全dirty最坏更新分别计。不能拿TAA后的画面掩盖raw GI噪声/延迟。

**关单条件。** 信号内滤波独立有效；raw/filtered/field均可调试，动态变化不永久遗留旧照明。

**补充验收。** 四种filter组合分别测constant、step response与seed→真实采样过渡；defrag/scroll/slot重用的A2身份相容。world压缩验证非负系数界；signed residual另用scaled half。空间/temporal不把邻居或seed计成新MC样本。局部dirty与全局lighting变化分别测远端响应；日夜变化不能每帧清空到永不收敛。

### SCGI-8：原子接入FrameProgram与Native，删除旧GI ownership

**具体工作。**

- RendererConfig/settings→FrameProgram request/stage/product→Bindings/Lowering→GI owner→Native全部routes接通。
- GI stage先于Surface；现有SSSR从GI照亮的surface-radiance继续；VSM/PhysicalSky/Aerial/NativeTemporal/FSR3原顺序依赖保持正确。
- Native从既有lighting directory的GI段解码half field→edge weights→真实shaded normal评价，零新增Native storage/sampled/group binding。FinalPixelAbi/ranges和全部producer/consumer原子更新，VSM/local/solar/noise写域不重叠。
- 超maxStorageBufferBindingSize时：私有history分片生成→stripe+halo window copy→该stripe全部Native bins→下一stripe。GPU一次partition形成stripe/bin ranges，禁止每stripe重扫全屏。旧目录无空间时GPU gather local/VSM完整引用描述符/局部索引，不裁灯/页/tap。
- 所有route同一解压/标准SH/guide数学；可选texture仅用于整材质有余量设备。满绑定不拒绝以前合法custom材质，不恢复宽GBuffer或material VM。
- `E=mix(Environment*AO, SCGI,c)`，材质occlusion/coat/metallic/unlit响应一致；direct/specular/emission不错误乘GI/AO。lighting-change response进入现有Temporal合同。
- 调试视图/settings/preset/demo/scene recovery接真实producer，不以专用test fallback渲染。
- 删除旧long-range/screen diffuse shader和仅旧GI使用的probe资源/accessor/export/tests；无consumer旧GeometryBlasPool/TLAS退休。保留`DynamicBvh→niMeshlets`与其他实际shared math消费者。
- 在同一个architecture unit完成全部production消费切换，立即删旧依赖，不留运行时旧新GI选择器。

**事务。** 启用/关闭、debug route、Native physical route变化、resize、scene switch/device recovery都挂单一command；同帧candidate被Surface读取不等于CPU已committed。提交后observer异常仍保留GPU资源。

**验证。** 真实生产链；Standard/Unlit/Clearcoat/custom、resident/VT、Main/VSM alpha；AO×GI×SSSR和Native/FSR3/旁路；scale 1/upscale、奇数尺寸、HDR/exposure；全目录/stripe/可选texture等价。强制最满16 SSBO/4 groups与sampled限额、4K internal/128MiB binding、halo边缘、VSM跨页/PCF fallback/local overflow。cached graph换代不读旧field；唯一submit/唯一HDR writer。

**成本卡。** 双history、最多3目录槽、stripe/halo/partition/copy、Native ALU/taps、VSM remap单列。0/50/100%覆盖报告增量，省full纹理不等于总体更快；旧资源实际无consumer才计REMOVE。

**关单条件。** 完整基础SCGI生产闭包实际运行、旧owner已退出、来源证据可提升到所选算法的Adapt；尚未做SCGI-9/10不能标整个模块完成。

### SCGI-9：近场Screen Radiance Gather完整增强

**选定方案。** Brixelizer GI screen-probe阶段作为MIT参考/局部移植，采用本地world query+cache预测残差；不引入其SDF renderer，不同时堆Horizon GI。

**图接线。** 同GI owner新增可选`surface-cache-gi-gather`宏stage，Surface之后生成下一代residual；pre-Surface stage只读previous role并产当前重投影段。private dispatch不全部提升为主stage，真实compound products/ranges与read/write进入Lowering，不通过finish callback隐藏编码或新增submit。

**具体工作。**

- Surface后仅在启用时生成低分辨率diffuse-only unexposed radiance与exact guide，排除specular/sky/aerial/bloom；不能从最终HDR猜diffuse。
- screen tile probe spawn、disocclusion重置、方向样本、visibility确认、reproject、radiance fill、L1投影、edge-aware interpolation全部闭合。
- 对同方向/同PDF/相容epoch的screen source与world预测求residual；missing screen coverage为零修正，不是零世界GI。
- residual自有variance/history/motion reject；t+1先reproject至当前anchor再给Native，base/residual分开，world-only history不覆写，不能经newpatch seed回灌。
- source用direct+Le+world-only求Lo，排除此前residual。当前主Surface local尚无完整阴影，half源须用同query visibility/采样PDF，不能把未遮挡local radiance反馈成GI。
- world prediction逆cosine卷积得moments，再用设计§13半球Gram解析inverse求a，Lhat=a·Y；直接标准SH评价moments不满足恒定半球零残差。同方向/PDF/epoch/coverage/window配对、固定N，mask=0贡献零修正；条件数约13.928的噪声放大纳入variance/confidence验收。
- probe history保SH/guide/identity/variance，方向数组仅当帧scratch；half residual用signed scaled half、复用同代world guide，不拿零/负L0作分母。half diffuse source另用Native projection/bin，camera graph/VT语义保持。
- diffuse源RGBA32F、16H B，显式采样不要求float32-filterable；方向scratch的half采用源最大值reduction所得scale，signed residual独立scale。检验大HDR/曝光突变不溢出且不混编码。
- settings/debug/capacity、enable/disable/resize/cut和错误生命周期齐备；query预算与基础SCGI区分。

**producer / product / consumer。** diffuse-only source+guide+world prediction→signed residual history→下一帧重投影publication→Native与world-only合成。没有独立SSGI owner，没有同帧返回world estimate的边。

**容量/事务。** bounded probe数×方向数；probe池/history/source bytes、transient arrays计入新增项；提交失败不推进residual role，scene/material/light epoch不相容拒绝旧修正。

**验证。** micro-geometry/接触色溢出对比高spp；关闭gather仍有worldGI；同支持法线恒定半球零残差，部分coverage不偏置；不同normal/support测试表示误差，不能滥用常量证明。local遮挡/specular排除/移动emissive/freeze能量/world seed无残差；全目录/stripe与Native/FSR3真实消费。δL/δE允许负值，合成前单独clamp判失败。

**成本卡。** H级source生成、screen probe directions/query、depth sample/radiance fetch、reprojection/SH与residual history；patch GI与screen work分别记录，不能藏在基础GI预算。

**关单条件。** 母稿Phase I真实完成并有独立开关/增益与失败边界；不能以存在一个future interface关单。

### SCGI-10：全场景/故障/容量集中验收与文档收口

依§4矩阵完整运行；代码最后变更后集中编译/build、新鲜build:test，GPU作业串行。模块画质/正确性/资源与粗粒度成本是本轮必需；正式全Renderer长窗口P50/P95、跨设备性能资格留最终集成，不能把本模块实际无法运行或query coverage缺失也延期。

记录真实adapter、driver/browser/backend、device features/limits、internal/output、scale、所有quality knobs、scene revision、triangles/instances/pages、K/U/rays、cold/warm、static/moving/dynamic状态。理论表全部用实际ResourceAccounting校验，差额解释padding、retained、driver未计入与查询新增共享驻留。

复核母稿逐项矩阵、source map每阶段/分支、旧引用零生产消费者、disabled无owner分配、没有CPU本帧readback/额外submit、没有隐藏material fallback。原失败保留；完成的owner事实再更新domains，稳定ABI确有跨owner consumer才沉淀contracts/specs，不提前造新治理层。

关单记录必须分开：功能覆盖、数值/画面、生命周期、容量、成本、adoption、未完成正式性能资格。只有全部必需项闭合才把SCGI大模块标完成，然后停在下一模块边界。

## 4. Debug与场景验收矩阵

### 4.1 必备视图与计数

视图：cascade/cell/orientation、patch occupancy/rank/generation/age/update、raw/A0/A1/A2 L1、world-only field/final E/confidence、query cut/covered-domain/hit/unknown/alpha/pending、material projection/VT LOD、signed screen residual、dirty域。debug只观察真实生产数据，不改生产quality。

GPU counters至少包含：requested/claimed/allocated/deferred/failed、evictions/defrag moves、rank0/rank1/promotion、dirty/age updates、bounce requests/overflow、各类query数量、node/triangle visits、stack spill、alpha rejects/continuation pending、VT coarse/feedback/drop、seed accept/reject分原因、drift reset、lookup miss/unknown、invalid radiance、AS rebuild/refit/quality触发、retired bytes。计数不能溢出后默默wrap成正常小值。

### 4.2 场景与通过依据

| 场景/操作 | 必需观测 | 失败不能怎样掩盖 |
|---|---|---|
| Cornell-like封闭房间 | 红绿bleeding、single/multi-bounce能量、黑/白材质、corner AO去重；与离线高spp参考比较 | 只截TAA后的画面；抬ambient掩盖缺光 |
| 双薄墙/同向平行面/栅栏 | leakage、orientation/plane拒绝、alpha完整continuation | 把墙变厚、把alpha改opaque |
| 点灯/spot/太阳独立及组合 | light-origin/reconnection PDF、range/cone、遮挡和double count | 只测sky+sun，略过小灯 |
| 发光黑材质/移动emissive | Le不乘albedo、更新/收敛、停止后的ghost | 限制HDR或把发光设常量 |
| Door opening/遮挡物离屏移动 | offscreen query、远处cache失效、响应延迟曲线 | 只在门重新进入camera后更新 |
| Rigid/large assembly；skin/morph 延后 | 现有 current geometry、query bounds、previous validity、origin rebase；未支持形变显式 unknown | 用静态 proxy 冒充有效形变、删除现有刚体 instance |
| Bistro完整场景 | 内外过渡、cascade/coverage/变换、coarse/fine、query构建与trace成本 | 修改最终场景缩小规模后冒称原验收 |
| Dungeon完整场景 | VG/VT/VSM/AO/SSSR/GI/Temporal同时工作集与峰值 | 声称4GB必过；实际设备只记录真实型号 |
| Large outdoor/day-night | environment/sun partition、far unknown、lighting epoch、cache aging | ray出域直接当天空、光变不失效 |
| Teleport/180°/快速平移/resize | scroll、seed拒绝、恢复曲线、screen/world不同reset | 每帧全清cache掩盖alias |
| VT压力/页搬迁/Product替换 | coverage不变、无streaming storm、query lease/refcount/fence | alpha缺页按透明处理、无限请求最高mip |
| pool满/dirty满/stack spill | 完整fallback/unknown/pending与恢复，不越界 | clamp count后声称工作完整 |
| source/gather切换 | energy一致、无specular feedback、残差无自激 | SCGI+SSGI全量相加 |

量化方法：建立固定camera/场景/light变更序列，记录raw GI和final输出；参考误差指标按测试对象分线性HDR能量、SH系数、hit误差、时间响应，不用一个全局截图阈值。容差/响应窗口在独立reference和格式误差核对后、跑production结果前冻结；不能看到失败后追调到通过。所有variance统计用同采样预算/随机策略，保存初始失败。

### 4.3 故障交叉矩阵

| 故障点 | 不变量 |
|---|---|
| prepare分配/PSO失败 | active资源/roles不变；candidate回收有据 |
| scroll/defrag/estimate/field encode中止 | 丢弃command后active map、allocator、stats、irradiance与history同时不变 |
| finish失败，未提交 | retry读同active、sample序号不增长 |
| queue提交后通知抛错 | 不rollback GPU，保留lease/fence/admission slot，隔离generation |
| 异步validation/OOM/queue completion rejection | 污染依赖链失效，不能把submit返回当成功；恢复明确 |
| device loss和迟到IO/compile/readback | 旧epoch不得写新资源，资源不跨epoch重用 |
| disable/resize/replacement while in-flight | 旧数据最后consumer前不destroy/host重写，最终计数归零 |
| page evict/compaction与query并发 | active AS引用的page不被释放或指向新内容 |

## 5. 失败分类、成本与最终记录格式

失败按[VALIDATION](../VALIDATION.md#validation-failure-contract)分类：实现语义错误、来源/数学误解、WebGPU平台差异、容量/工作集不足、生命周期错误、测试表示已退休、环境/设备失败。不同分类的修复范围不同，但均保留原失败。

- 数值错误：用独立oracle定位，不用提高hysteresis/降低light intensity掩盖。
- 平台差异：改物理调度/布局，找原始开源参考，不删算法阶段。新来源补revision/license/函数映射。
- 容量不足：先报告actual capacity与peak，选择合法profile或改数据组织；不能假称4GB任意场景必须通过，也不能偷偷缩本来声明的场景。
- 性能过慢：记录build、maintain、query、material/alpha、filter、lookup、Surface增量/gather各项；当前要求有界可运行，不用“功能优先”跳过watchdog/OOM/无法交互问题。
- 旧ABI测试失效：迁移存活语义；只有已无生产consumer的旧表示测试可删除。

每单元实施时在本文件追加简短结果：代码revision/范围、source映射变化、运行命令与结果、独立oracle/GPU/画面证据、原失败和分类、actual Cost Card、未运行项及原因、下一边界。无需另建status/progress/schema/YAML系统。

## 6. 本次设计轮记录（2026-10-17）

生产基线`3000de2ab7caee2f5a20d86ded367ff3ba2e32c5`。重读母稿全部章节并核对FrameProgram/Lowering/Bindings、RendererCore/command提交、Surface native环境能量、GpuScene/GpuRenderWorld、GeometryProduct/residency、VisibilityKey、native material/coverage/VT、LocalLightWork、SSSR/Temporal及旧GI/BVH引用。

取得固定revision的Unity SurfaceCache/URP相关源码与RadeonRays原始DX算法/host源码，核对许可证与关键函数；额外核对FidelityFX SDK v1.1.4 screen-probe阶段及GPUWeb/WGSL当前规范。发现并修正L1压缩描述、punctual重连接遗漏、WGSL refit同步、提交后不可rollback、旧DynamicBvh仍有cooker消费者等问题。这里的研究记录不等于整个外部项目逐行审计，也不提升代码adoption。

本轮只改设计/执行/路线/导航与来源说明；没有实现GPU算法、改变资产ABI、测试阈值或依赖。文档检查结果在本节最终记录；engine build、GPU、browser、benchmark均未运行，因为没有生产源码/资产变更，且未来算法尚未实施。

集中检查：`node tools/docs-verify.mjs`为0 findings、66 historical warnings；`node --test tools/tests/document-system.test.mjs`为7/7通过；`node tools/vibe.mjs doctor`无errors/warnings且registry字节一致；FrameProgram的context仅返回新的SCGI设计/执行一对；`git diff --check`通过。historical warnings仍保留，不据文档通过宣称算法、GPU或性能通过。工作区变更仅AGENTS规则、docs和workstream导航，没有生产代码改动，也未创建提交。

### 6.1 第二轮逐机制复核（2026-10-17）

按用户要求继续加深同一对文档，未启动SCGI-1实现。再次对照母稿、固定Unity的RecordFiltering/Estimation/Common/Compression、RadeonRays和当前Native bindings、FinalPixelLightingPublication、GpuScene/材料revision、SkinnedMesh与大气shader。补充PBRT-v4固定revision的wavefront/alpha源码参考。完整source map保留Reference/Planned Adapt/Local身份。

本轮主要修正：A2时域后滤波遗漏；固定cohort与物理零/unknown区分；同提交深alpha完整结束；共享变形真实producer；48B稳定身份/288B patch/64B双层continuation；满绑定lighting-directory及stripe窗口；world-only seed与signed residual隔离；半球Gram预测；显式post-Surface gather图阶段。内存按192H双history、最多288H目录帧槽、query links/scratch/retiring重算，不承诺4GB大场景。

数学复核保留一次纠错：中间分析曾将标准L1半球常量结果误算成5πL/4，并提出自定义正核；独立积分确认L0/L1各贡献πL/2，该判断错误，已删除自定义核并恢复标准donor卷积。它不是上游bug，也不是实际production失败。执行时仍验证窄亮源、法线偏转与高albedo多跳的真实表示误差。

本轮临时Node CPU积分用512个z中点×1024个方位点积分正半球，直接累积YYᵀ，再用独立高斯消元拟合常量：Gram最大绝对误差约4.77e−7；拟合a0=3.544907701918937（解析sqrt(4π)=3.544907701811032），其余系数绝对值≤9.28e−11；ng方向irradiance=3.1415926536021637。0/30/60/90/120/150/180度的精确clamped-cosine数值积分与π(1+cosθ)/2最大绝对差约1.73e−5；Gram解析条件数13.928203230275503。另按整数extent/stride重算1080p/1440p/4K表。上述是CPU数学与字节算术检查，不是WGSL、GPU、画质或性能验收。

本轮集中验证：`node tools/docs-verify.mjs`为0 findings、66 historical warnings、205 documents；`node --test tools/tests/document-system.test.mjs`为7/7通过；`node tools/vibe.mjs doctor`无errors/warnings，registry字节一致；`node tools/vibe.mjs context OEngine/src/render/program/FrameProgram.ts`仅返回SCGI authority一对。暂存前`git diff --check`通过，但它不包含untracked文件；暂存后检查发现母稿6处Markdown双空格换行触发行尾空白，已改成等效反斜杠换行，随后对实际暂存内容复核。母稿与Downloads原文在统一换行/这6处等效Markdown格式后正文一致，未改章节内容。临时审查脚本首次因PowerShell管道非ASCII正则编码失败，改用Unicode escape后完成，未修改检查器。

实际暂存检查：`git diff --cached --check`通过；`node tools/docs-verify.mjs --staged`为0 findings、81 historical warnings、205 documents。与工作区66条的差值15条均为旧archive/performance文档指向未纳入Git的`.local/validation`或诊断产物，已逐项核对；不是当前SCGI断链，不把这些本地产物加入本次提交，也不更改历史证据记录来消警告。

各SCGI代码单元继续为待实施。变更仅AGENTS、docs与workstream；没有生产源码/资产/阈值/依赖变化，因此不运行engine build、browser、GPU或benchmark，也不提升adoption。本轮按用户要求将文档作为一个连贯提交保存，提交ID由Git记录，不在本文制造自引用hash。

## 7. SCGI-1实施与复核（2026-10-17）

本单元基于`b6fbaff6`后的源码实施；提交revision由Git记录，不在本文制造自引用。范围为owner/真实buffer/事务/ABI/能力规划，**没有GI画面、没有query算法、没有提前开启生产stage**。SCGI-2及后续均保持待实施。

### 7.1 交付与设计逐项核对

| 合同 | 实际交付与边界 |
|---|---|
| CPU/WGSL ABI | `ScgiAbi.ts`：16种scalar-packed结构，identity48/cell8/patch288/request96/half96/raw64/node64/links8/instance128/ray48/result32/payload32/continuation64/header256等；完整CPU pack/unpack，signed L1 scaled half存储，未依赖shader-f16 |
| 完整world双bank | `ScgiRuntime.encode`在现有command内copy完整arena，包括map、free slots、allocator/header、patch geometry/stats/A0/A2、bounce requests；新bank clear后用staged copy初始化EMPTY map；A1/raw/requests/update list/query batch独立scratch，不复制到另一bank |
| active/candidate/frame-readable | prepare不换active；encode后publication仍须真实field writer声明complete才能通过compound fact；commit仅在`wasSubmitted`后更新角色，重复调用无效，无资源分配/外部回调/读回；frame-readable只说明编码依赖，不证明GPU完成 |
| identity/epoch | 48B语义身份不混地址generation/数值revision；scene epoch不相容拒绝world，view变化拒绝screen，resize保留world；旧device回调不能污染新epoch。u32 generation/sample序号达上界先拒绝，后续owner应换epoch，不能静默wrap |
| screen/目录 | 双history各自scale与有序96B record分片，resize仅替换screen；完整分片domain验证。directory最多3槽峰值单列、不由GI假造分配；全目录/stripe/work-tile窗口容量planner可执行，VSM/local GPU gather writer及Native读取按原计划在SCGI-8实现 |
| borrowed/static/dynamic AS | query/material/scene/environment只借lease，带deviceEpoch和最后consumer fence；区分static-as/dynamic-as类型。本单元不创建无consumer的AS或第二scene。真正page pin/AS build在SCGI-2/5实现 |
| 提交/失败 | `ShadeGPUCommandContext.observeSubmission`在普通通知前结算资源owner；保留原single submit。`ChangeSignal.send1Checked`执行全部listener后传播失败，用于onBeforeFinish/onFinished；普通Signal行为不变。提交前失败abort，提交后observer/fence acquisition错误保留submitted/lease并poison，异步GPU error/fence拒绝停止history，不回滚GPU字节 |
| 退休/恢复 | old/new allocation重叠计入peak；旧资源等最后consumer成功fence或device teardown后destroy，拒绝fence不会冒充完成。disable/异步configure取消、失败replacement、resize、loss均闭合；恢复创建新deviceEpoch owner，不原地清除poison伪装恢复 |
| bindings/capability | `ScgiPublication.ts`复用FrameGraphBindingLayout逐帧slot；compound检查field/guide/identity stride、extent、generation、颜色域、scale、全部分片完整写域。`ScgiCapacity.ts`校验完整arena、aligned ranges、finite cluster shards、实际Native descriptor generator及query 15-SSBO inventory；portable/subgroup为有限执行profile，尚无扫描算法adoption |
| disabled/empty/Unlit-only | configure在分配前排除需求；不建资源/派发。未往FrameProduct枚举加空GI fact，未改RendererCore默认功能，未编造空算法consumer。后续完整producer→Native原子切换仍在SCGI-8 |

来源为Local工程接线与ABI，不宣称Unity/RadeonRays完整移植；source map已追加。新增shading目录路由，workstream只改模块为implementing，不复制单元状态。

### 7.2 实际成本卡

本单元无生产启用，现行Renderer **ADD GPU resources/dispatch/submit = 0**。启用基础设施fixture或后续GI时，稳定分配精确由`planScgiAllocation`返回，所有arena整体满足binding limit，不仅各子range满足。

`Ncell=R³×16×C`；world每bank为256B header+8Ncell+288K+4K free slots+96B bounce requests及range对齐；scratch为48K A1+64U raw+96Q request+4U update list+64B counter/args及对齐；query batch为176B/ray+显式spill及对齐；screen双history为192H。没有AS、gather、light pool或residual占位分配，后续模块新增须独立计账。

以下是**理论分配模型，非GPU时间benchmark**：R24/C3/K65536/Q65536/B8192/U8192/rayBatch16384/spill0，binding128MiB、alignment256B。

| internal extent | 双world MiB | 私有scratch+batch MiB | 双screen MiB | GI owner合计 MiB | 外部全量目录GI段最多3份 MiB | 每role field段数 |
|---|---:|---:|---:|---:|---:|---:|
| 1920×1080 | 48.1255 | 12.2813 | 94.9219 | 155.3287 | 142.3828 | 1 |
| 2560×1440 | 48.1255 | 12.2813 | 168.7500 | 229.1568 | 253.1250 | 1 |
| 3840×2160 | 48.1255 | 12.2813 | 379.6875 | 440.0943 | 569.5313 | 2 |

4K全量目录不满足128MiB binding，必须走窗口；表中569.53MiB是全量段理论上界，不声称该device创建了非法目录。实际窗口峰值=3×planner.bytes；旧directory、renderer已有资源、AS build/query leases、replacement、upload staging和driver margin另计，绝不拿此表承诺4GB复杂场景。

每稳定帧world copy25,231,616B，读+写约48.1255MiB traffic（60Hz约2.82GiB/s，仅此copy）；scratch clear12.2813MiB，screen candidate clear96H，field writer/copy尚未接入。cold init另外upload完整8Ncell EMPTY map，属于初始化成本，非每帧host写world。bank/header upload经现有fence-held staging，不直接queue.writeBuffer覆盖pending bank。当前初始化无shader samples/ALU/atomics/barriers/新pipeline；steady copy/clear为顺序访问，后续算法随机访问另计。ideal=disabled零工作，expected=一bank copy+私有reset，worst=replacement旧新并存及冷初始化；这一正确性基线没有宣称净提速，不套用优化break-even。

### 7.3 验证、原失败与未运行范围

- CPU独立状态/字节oracle覆盖max u32/nonzero ABI、literal offsets、4K分片、arena整体limit、window/remap/finite shards、全部Native routes和满sampled材质、portable/subgroup、abort/retry、三帧未结fence、提交后多observer错误、allocation同步/异步OOM、resize/replacement abort、scene/view epoch、lease、disable、device loss、拒绝fence及提交后fence acquisition失败。
- Tier2真实GPU使用Chrome155.0.8059.82、NVIDIA Turing硬件adapter（API未给具体型号），16 storage buffers、128MiB binding；主device没有启用shader-f16/subgroups。16种typed WGSL读写第二record核对stride/offset，f32-only scaled half decode，64种真实Native route pipeline layouts加满sampled material，15-SSBO query tail；真实ShadeGPUCommandContext+staging写已知map/A0/A2/allocator/bounce/field，abort→retry、三帧连续提交、完整copy、cached graph当前publication、resize/replacement/disable退休、提交后observer错误与真实scoped GPU validation错误全部验证。另建真实device分配4K双history分片、检查末段初始化、destroy触发device loss与旧epoch隔离。
- GPU错误聚合为0；故意validation注入在内层scope捕获后传给owner；没有真的耗尽GPU显存制造OOM，OOM与fence rejection使用CPU受控故障注入，避免将设备耗尽影响其他进程。fixture已知值不是生产GI结果。
- 保留原失败：①首轮CPU暴露ChangeSignal吞listener异常，属实现接线错误，增加checked命令通知修复；②扩展GPU fixture错误要求异步configure后必有retired bytes，实际旧fence可能已完成，改成“未完成须保留、已完成可释放”，CPU受控fence仍严格断言保留；③尝试requestDevice要求8192B上限并不能把WebGPU默认128MiB能力降低，属平台协商理解错误，改用真实4K超过实际binding上限验证分片。两份GPU原失败保存在`.local/validation/scgi-1-gpu-*-fixture-failure.json`，不提交本地产物。
- 完整production GI画面、RadeonRays算法、VSM/local窗口gather数学、所有query material shader编译/性能、整Renderer P50/P95与正式browser画质留各后续单元；本单元未假称已通过。SCGI-1所需GPU基础设施验证已运行，不以后续正式验收替代它。

扩大提交接线回归时另发现旧`renderer-submission-count` fixture缺少当前Renderer的pipeline admission/startup字段，在到达原定texture promote故障前先报`publication.bins`/`firstSubmittedAtMs` undefined。归类为测试fixture与现行owner不相容；只补齐admission seam与startup，保留原`encode failure`和提交数断言，没有修改Renderer生产逻辑、跳断言或放宽容差。

最终集中验证：

- `npm run build --prefix OEngine`通过，包含`tsc --noEmit`、Vite和declaration build；保留既有codec `node:module` browser externalization提示，无编译错误。
- `npm run build:test --prefix OEngine`新鲜构建通过。`node --test`对`scgi`、`command-completion`、`submission-fence`、`framegraph-executor`、`gpu-frame-timing`、`view-frame-transaction`、`renderer-submission-count`七个targeted文件合计 **43/43通过**。
- `node tools/gpu-oracle.mjs scgi-transaction --json`最终通过，fresh source SHA256 `595a67804198480dea69d19bc763552536a0fa1c52851a81c3e0ecdc026fdda1`，GPU/page errors为0；本地原始结果`.local/validation/scgi-1-gpu.json`。64种Native descriptor profiles含physicalSun组合；4K分片真实分配/编码/末段初始化/device loss通过。主小fixture峰值45,120B不含独立4K设备，不能拿它冒充全效果峰值。
- 因修改了真实command通知语义，额外串行运行`node tools/gpu-oracle.mjs sssr-production --json`，当前Native/FrameProgram/完整SSSR生产profile、能量和生命周期回归通过，GPU/page errors为0；本地结果`.local/validation/scgi-1-sssr-regression.json`。这不是完整GI画质或整Renderer性能资格。
- `node tools/docs-verify.mjs`为0 findings、66 historical warnings；`node --test tools/tests/document-system.test.mjs`为7/7通过；`node tools/vibe.mjs doctor`无errors/warnings，registry字节一致。实际暂存17个相关文件，`git diff --cached --check`通过；`node tools/docs-verify.mjs --staged`为0 findings、81 historical warnings，额外15条仍为历史文档指向未提交的本地产物，与前轮一致。

完成SCGI-1，下一边界是SCGI-2，本轮不继续。

### 7.4 SCGI-2前置复核：异常通知完整结算（2026-10-17）

源码复核发现SCGI-1的必需依赖缺口：`observeSubmission.submitted`抛错时，后面的legacy `onFinished`未执行；`aborted`抛错时后面的rollback通知也可能未执行；获取提交fence失败时过早poison可能被稍后的publication覆盖。上述不能延期。修复为先执行全部submission/abort observer和legacy通知，再传播第一个错误；已提交失败在全部publication结算后统一poison。错误用显式cause容器保存，包含`throw undefined`；failure observer自身抛错也不阻断其他owner。未增加submit、buffer、pipeline或dispatch，ADD为CPU错误路径中的有界遍历。

新增三个独立command合同案例，GPU fixture补充真实已提交observer异常和未提交rollback异常，检查后续callback确实执行、active状态正确、重试可提交。集中验证：`npm run typecheck --prefix OEngine`、新鲜`npm run build:test --prefix OEngine`通过；七个原targeted文件本次实际发现25个测试，25/25通过（不是沿用旧43项数字）。`node tools/gpu-oracle.mjs scgi-transaction --json`通过，本地结果`.local/validation/scgi-1-followup-final-gpu.json`，GPU/page errors为空；资源403控制台信息保留，不当作GPU验证错误。尚未完成的SCGI-2不在本次前置修复中声明关单。

### 7.5 SCGI-3：稀疏cache与GPU allocator闭合（2026-10-17）

**前置判断。** SCGI-2仍未闭合，不能由已有Product cook或资产测试推断coverage/residency/共享动态变形已完成。本单元依赖表为SCGI-1，可以独立完成cache并延期SCGI-2；SCGI-4/5开始前必须补齐SCGI-2，不能用fixture几何替代生产query。SCGI-1的真实command事务/lease/retire继续作为资源owner，未建立第二提交框架。当前停在SCGI-4边界，未开始anchor、estimator、query或默认GI接线。

**实际代码闭包。** `render/gi/ScgiCache.ts`借用runtime初始化的candidate world、private scratch与batch，一次创建物理layout PSO；encode只上传常量/dirty bounds并记录同command GPU工作。`ScgiCacheLayout.ts`负责scratch容量/scan层级；`shaders/scgi_cache.ts`负责地址、claim、maintain、allocation、defrag、update selection、request生产/解析。`ScgiCapacity.ts`在资源创建前核对dispatch/arena能力，`ScgiAbi.ts`新增cacheState16B，`ScgiRuntime.ts`给scratch/batch增加INDIRECT usage。pipeline不随spp/age/variance/quality组合增长。支持4 cascades、R24 signed modulo、16 oct bins；scroll只移除离开对应cascade者，jump失效不重叠层，保留重叠patch世界位置。

GPU闭包为request producer→cell claim→维护/touch/两段age→free/winner prefix→唯一slot初始化与map发布→live ring→可选snapshot/apply defrag→请求资格检查→四类更新compact/quota/indirect→后续consumer。跨workgroup依赖分dispatch，不用atomic flag后轮询；portable scan为128线程、512B workgroup共享内存、block sums多层scan/add，未实现的subgroup路径不再报告启用。rank0 allocation优先；rank1可见升0；仅被调度rank0产生bounce需求，下一提交generation消费并按cell去重。overflow/无pool/不相容/域外分别记录，request解析invalid，不破坏existing map。access/update/birth、demotion/selection/dirty分离；allocator不伪造radiance/count/update age。

**表示修正。** patch288B的postValid/lastCohort/status保留给滤波/estimator，allocator的live/dirty/selection/demotion独立16B/bank。move record368B：16B源/目标/generation/保留+288B patch+48B A1+16B cacheState；先snapshot全部源，再写free destinations并修map/generation，源/目标不相交，部分budget与链式holes不产生swap环。request保存cell，经最新map解引用。active为4K索引的逻辑环，header start/end/count可wrap并区分full/empty，物理pool live由cacheState判定，不假设holes已完全压紧。frame重启需fresh world；slotGeneration到sentinel前置sticky GPU fault，后续update count置零/lookup拒绝直到新world epoch。

**来源。** 继续使用source map固定Unity `a7e4c051d256a781ab362c64316b125a1e104694`，复查`PatchUtil.hlsl`、`RingBuffer.hlsl`、`Scrolling.compute`、`Eviction.compute`、`Defrag.compute`、`PatchAllocation.compute`和`PatchAllocationRequest.hlsl`。保留cascade/方向、rank两段eviction、bounce下一代、搬迁和有限容量机制。Unity Companion License源码不复制、不逐行翻译；本地调度、独立ABI、两bank事务、hierarchical scan、逻辑ring+free-list、无cycle defrag、完整identity/plane检验为Local。当前不宣称完整Unity port/adoption，RadeonRays仍为SCGI-5 Planned Adapt。oct使用普通映射，不复制donor任意rotation矩阵，分类在本地producer/consumer保持一致。

**实际Cost Card。** 既有Renderer尚未接线，默认ADD GPU resources/dispatch/submit=0。原§7.2为SCGI-1历史实施快照；本轮新增双bank cacheState32K、claims4Ncell、request-cell4T（T=Q+B）、active4K、priority16K、move snapshot368K、八组flags/prefix每层8B/元素、1KiB dirty bounds和settings/control；batch另64B indirect，各range真实对齐。map/patch/A0/A2/bounce/cacheState随bank copy；A1/raw/claims/scan/moves单scratch，不机械双份。

以下为理论分配，非benchmark：R24/C3/K65536/Q65536/B8192/U8192/rayBatch16384/spill0，binding128MiB、alignment256B。

| internal | 双world MiB | scratch+batch MiB | 双screen MiB | owner合计 MiB |
|---|---:|---:|---:|---:|
| 1080p | 50.1255 | 43.5064 | 94.9219 | 188.5538 |
| 1440p | 50.1255 | 43.5064 | 168.7500 | 262.3819 |
| 4K | 50.1255 | 43.5064 | 379.6875 | 473.3194 |

每稳定帧copy26,280,192B，读写50.1255MiB/frame；scratch/batch clear43.5064MiB，screen clear另96H。外部目录、AS/query新增geometry、renderer已有资源、retiring/replacement、upload/driver另计，不承诺4GB资格。claim每有效请求一次atomicMin；0/50/100%重复仍为D次，减少的是唯一slot init约D/0.5D/1（全相同cell时），不是消掉claim税。winner/free/live/priority按容量scan，map/identity随机读及每patch最多32 dirty AABB测试另计；defrag按move预算snapshot/apply，budget0不编码。全cell clear为Ncell、维护K、请求T，未宣称已有稀疏slab调度。ALU主要为坐标/方向、identity/plane、prefix和quota；无纹理采样，原子竞争集中cell claim与move ticket，scan层间dispatch建立可见性。

R32/C4/K65536/Q8192/B8192/U4096、7×5 screen真实hardware fixture分配117,033,808B，单world37,748,992B、scratch+batch41,533,520B。1728个live patches：无defrag 52 dispatch，有64 move budget（实际0 move）69 dispatch；两次cache首pass到finish GPU timestamp约10.312416ms、8.052096ms，adapter NVIDIA/Turing。这只是两次粗粒度观测，不是稳定帧benchmark/P50/P95或速度提升，且不含外部copy/clear。含诊断readback和CPU oracle的wall约275/178.6ms不冒充shader时间。当前capacity scan成本明显，保留合并分类/多输出、复用scan scratch、按move预算缩scratch、slab/active调度入口；本轮不展开性能战争、不删必要阶段。ideal=disabled零工作，expected=bounded copy/clear+K/T scan，worst=全dirty/竞争/满池+move/replacement；新增功能不伪称优化收益。

**验证。** 新鲜`typecheck`、`build:test`、完整`build`通过；build保留现有Basis/KTX node:module浏览器externalize警告。五个targeted文件（SCGI、command completion、submission fence、submission count、FrameProgram）37/37通过。`scgi-cache`真实GPU oracle通过50个提交帧：独立CPU地址/方向/负模模型逐live比对、逐cell/slot/generation双向检查，覆盖400/16385同格竞争、三层scan/尾组、R24、双薄面/平行面拒绝、rank优先/升降/两段淘汰、full/empty/wrap、scroll/jump、满池恢复、部分defrag链/排除cycle、A0/A1/A2/metadata、U=1实际worklist可达、dirty overflow、origin/scale reset、frame/slot边界、abort/retry、真实GPU request overflow及rank0 consumer→bounce queue→下一代分配。实际radiance更新属SCGI-6，当前不是伪造lighting完成。

`scgi-transaction`同fresh build回归通过，包含新增cacheState typed WGSL stride、真实Native descriptors、三帧in-flight、observer异常、async validation、resize/disable/last-fence、真实4K分片与device loss。两GPU结果pageErrors/gpuErrors为空；资源403控制台信息保留。原始结果在`.local/validation/scgi-3-cache-final.json`、`scgi-3-transaction-final.json`、`scgi-3-targeted-final.txt`、`scgi-3-build-final.txt`；source SHA256 `216f61fca1744a01fc80fbf12efd8eb110dd455c991bf9ed7f1887d703c8342f`。

**失败留痕与未运行项。** 原始失败保留`scgi-3-cache-initial.json`及编号记录：WGSL保留字、binding visibility/indirect读写usage冲突为实现错误，已修正；新增fixture曾使用非法evictionAge=0、disable后未重建新plan的cache，为fixture错误，修复实际输入与物理实例后重跑。审查还发现cacheState缺range、move368B与分配352B不符、post字段被alias、不相容request错误解析等真实问题，本轮已修正并补GPU断言。未放宽容差/跳断言/缩最终场景。完整GI画面、场景和全Renderer P50/P95尚未运行：当前未到SCGI-5～10，不伪称AAA效果或完整GI。SCGI-3基础设施已闭合；文档检查和提交仍按本轮实际结果执行，停在SCGI-4边界，SCGI-2仍需先补齐。

提交前检查：`node tools/docs-verify.mjs`为0 findings/66 historical warnings；暂存区`--staged`为0 findings/81 historical warnings（历史文档对本地未提交产物的引用警告保留）；`git diff --cached --check`通过。新增/修改生产TS格式检查与cache源码style guard均通过。

### 7.6 SCGI-4 anchor/seed基础实施与未闭合前置（2026-10-17）

**状态与前置判断。** 本节记录已验证的基础实现，**SCGI-4未关单**。源码`GeometryProductV1.ts`仍为schema1、无query section/minimum query cut；`SkinnedMesh.ts`仍为标记类，没有动画批量palette/weights→共享current/previous变形位置/normal/tangent/bounds publication；query coverage/residency leases也未实现。这些SCGI-2缺项不能后移为最终性能验收，不能用普通三角fixture或拒绝动态history替代有效动态路径。本轮没有完成此前要求的SCGI-2返工，不能因此声称完成SCGI-4。SCGI-5/生产集成不启动；后续首先补SCGI-2，再回本单元补齐必需动态/共享publication验收。

**当前producer→consumer。** 新`ScgiAnchors.ts`/`scgi_anchor.ts`借用既有VisibilityKey/meshlet work、frame instances、普通resident attributes或Product metadata/四banks及Native material publication，使用原command完成`runtime.encode→encodeAnchors→cache.encode→encodeSeeds`。不新增queue submit、GPU→CPU→GPU控制、独立scene/material数据库或normal GBuffer。pipeline仅create时异步编译并核对compilationInfo；本地64线程kernel，不依赖subgroups/f16。FrameProgram默认生产接线仍按SCGI-8，不把本单元部分功能提前开启。

- 完整写`ceil(W/2)·ceil(H/2)` anchor；2×2从提交相位开始查找实际winner，sourcePixel用u32，sky/invalid全记录归零并置invalid源。frame instance generation必须等于work generation；场景lineage必须等于当前set generation。
- 当前anchor产生rank0需求，全局循环窗口`start=(sampleSerial·Q) mod H`控制请求上界，每个anchor仍完整写；不在先到的分片耗尽全部budget。窗口外有效需求计deferred；abort不推进2×2或窗口相位。稀疏有效像素会浪费窗口名额，这不是遗漏anchor或伪称所有cache miss已满足。
- GpuScene新增16B/physical instance side table，保存set id/set generation/local slot/slot lifetime；当前local slot只append、不单独复用，lifetime使用set generation。grow/copy/abort/commit/retire与instances成对；release清active实例，不需额外清lineage。material真实bindings/publication发生变化时递增valueRevision，避免texture变化但numeric常量相同仍误复用。
- identity由48B修正为64B，分别保存asset-local meshlet和local primitive，保留尾部零lane；无hash/截断。普通meshlet减geometry.meshlet_begin；Product从winner的global reference解析local asset，global group减当前asset groupBegin，再组合local meshlet。64B identity贯穿patch/request/history，patch304B、request112B、field112B，move384B并搬迁seed source，seedSources单scratch4K；不是并存旧新两套ABI。
- Native与GI复用primary world position与UV/clip/positive-depth数学，Native保留原compact temporal identity。GI严格身份独立于Native压缩表示。anchor保存128B/H单scratch；previous inverse VP/view在anchor编码时快照，seed没有第二个可漂移相机输入。没有真实previous deformation时拒绝seed；该保守拒绝只防错，不声明动态能力完整。
- 新rank0 patch唯一writer消费previous committed **world-only** field及该role原guide、scale。验证完整identity、previous/sourcePixel、normal、depth、双向绝对plane距离、world/tangent距离与device/scene/numeric/origin/voxel资格；奇数重投影地址`floor(uv·fullExtent)/2`。拒绝残差/final HDR反馈。初始化A0/A2、mean/seed/post validity，真实MC count/cohort保持0，A1待当帧滤波重建。多segment组合顺序dispatch，只有匹配anchor/history区间的slot写入。
- Cache bindgroup key补scratch身份，修正resize保world但scratch变更时复用旧binding的问题；overflow/defrag/abort仍由原cache/runtime owner处理。

**Cost Card（理论，非benchmark）。** 相对旧ABI：双world patch增加32K B、双bounce增加32·Nbounce B（Nbounce为bounce请求容量）、move增加16K、seedSources增加4K、receiver queue增加16Q、双field增加32H、anchor增加128H；GpuScene增加16·physicalInstanceCapacity。anchor约H次三角重建、每H至多4次visibility读，128H顺序写，几何/材质/lineage随机读；有效窗口内至多Q次CAS预留，每request28次atomicStore。无GPU全局轮询。seed是`K·NanchorSegments·NhistorySegments` invocations的有界实现，先读seedSource/live/rank筛选，再随机读anchor/guide及12系数，成功写A0/A2/stats；无seed atomics。每anchor分片1 dispatch；有有效history时每分片组合1 seed dispatch，4K/128MiB profile为2+4个dispatch，cache工作另算。临时uniform各368B/anchor segment和192B/seed组合，现有池对齐/retire，CPU bindgroup构建也随此有限组合增长。未来可用new-patch compact list/segment bin减少空invocations；尚未实现，不宣称已有收益。没有稳定frame pipeline创建。

沿用§7.5同profile重新由真实planner计算：R24/C3/K65536/Q65536/B8192/U8192/rayBatch16384/spill0，128MiB binding、256B alignment。旧§7.5表是提交当时快照，以下替代其作为当前分配依据。

| internal | 双world MiB | scratch+batch MiB（无anchor） | 单anchor MiB | 双field MiB | owner合计 MiB |
|---|---:|---:|---:|---:|---:|
| 1080p | 52.3755 | 45.7564 | 63.2813 | 110.7422 | 272.1553 |
| 1440p | 52.3755 | 45.7564 | 112.5000 | 196.8750 | 407.5069 |
| 4K | 52.3755 | 45.7564 | 253.1250 | 442.9688 | 794.2257 |

每帧world copy27,459,840B，读写52.3755MiB；scratch+batch clear45.7564MiB，candidate field clear另112H，anchor全写不重复clear。外部lighting directory、query/AS、VT/VSM/SSSR、原renderer、替换/retiring和driver margin另计，不承诺4GB资格。1080p anchor顺序写63.2813MiB，60Hz约3.708GiB/s理想流量；不等于实际带宽。128MiB绑定4K分两段；更低绑定的真实GPU测试强制三段证明寻址，不用截断像素满足容量。

**验证。** 完整`npm run build --prefix OEngine`（含typecheck/Vite/declaration）、新鲜`build:test`通过；保留Basis/KTX的node:module externalize警告。五个targeted文件scgi/runtime-geometry-instance-residency-v2/native-material-scene/native-surface-lighting/final-pixel-phase1共37/37通过。GPU作业串行，以下均通过，gpuErrors/scopedGpuErrors为空：

- `scgi-anchor`：独立平面/相机投影oracle；同primitive调用真实Native seed数学数值对照；平移/旋转/180°/teleport、cut、双向depth/normal/NaN拒绝；不同local instance、set/slot lifetime、material/primitive身份拒绝；scale=2的A0/A2、count0；abort/retry及编码后相机变更；world resize保留；1×1和1919×1079（518400 anchors）、sky、细杆、边界、Q3 deferred/完整轮转。真实双Product通过MultiRuntime加载完整page并消费decoder，physical-address perturbation不改变local身份；该扰动**不是**SCGI-2 page lease/搬迁事务的验收。强制64KiB binding三段、跨段seed有真实有效写。真实GpuScene upload/grow/abort/retry/同range replacement检查lineage。Visibility和prev world-only field是隔离输入，不证明query coverage或estimator完成。
- `scgi-cache`：50提交帧原oracle全部通过，包含新304/112/384 ABI、defrag、rank/overflow/ABA、真实GPU queue；R32/C4/K65536/Q8192/B8192/U4096、7×5 owner分配120,836,816B，单world38,928,640B，scratch+batch42,975,312B。52/69 dispatch两次GPU timestamp约8.343104/2.924544ms，只是粗观测，不是P50/P95、shader净收益或完整GI帧时。
- `scgi-transaction`：18类typed WGSL ABI、真实descriptors、in-flight/observer fault/async validation/resize/disable/fence/device loss回归。
- `final-pixel-seed-epoch`及`final-pixel-seed-quality`：后者保留原4组1080p各256帧动态比较与原断言，未缩场景/放宽阈值。冻结Facts参考只适配其借用的现行FSR pass异步prepare，未改冻结算法数学。

最终source SHA256为`9551a42cf338dc5821b9dfe9748e314e0a00d038e47c8dca50282db09c815e5d`。原始结果`.local/validation/scgi-4-anchor-final-rigid.json`（追加负/非均匀刚体scale的current/previous position、normal朝向、motion/depth独立oracle后通过）、`scgi-4-cache-final.json`、`scgi-4-transaction-final.json`、`scgi-4-native-seed-epoch-final.json`、`scgi-4-native-seed-quality-final.json`；1919×1079 anchor完整读回的wall约174.4ms包含readback/CPU oracle，不当GPU shader性能。来源状态仍Local/Reference，未production adopt。

**失败与未运行项。** 保留anchor-initial及02～14等原始结果：WGSL生成括号、float sourcePixel NaN表示、exact-zero motion断言分别修正为有效WGSL、u32 source和有独立投影依据的1e-7 f32比较；Product fixture错误使用global group0、mappedRange重叠为fixture错误，修正确实输入/映射调用后重跑。审查同时修正真实Product身份global group地址依赖。transaction旧device-loss fixture未请求新mixed geometry所需storage limits，quality旧wrapper未prepare异步PSO，均保留失败并只修fixture准备。SCGI-2完整共享deformation有效路径及raster/VSM/query位置一致性、coverage/lease原子迁移未验证也未实现；真实skin/morph动态场景全组合尚未形成本单元完整证据，故未关单。完整GI画面/estimator/filter、默认生产接线及最终Renderer画质/性能不在本轮宣布完成。

提交前文档检查：工作区`docs-verify`为0 findings/66 historical warnings，暂存区`--staged`为0 findings/81 historical warnings；保留历史引用警告。`git diff --cached --check`通过。

### 7.7 SCGI-2/5阶段实现保存与返工顺序（2026-10-17，均未关单）

**授权与边界。** 用户在核对未闭合现状后要求提交当前代码，再按SCGI-2→SCGI-4→SCGI-5顺序完成。此记录是可追溯的中间提交，不是完成声明。§7.6关于schema1、无query section/lease的描述保留为当时快照，现状由本节替代；共享skin/morph缺项仍成立。默认生产GI不在SCGI-8之前开启。

**实际实现。** GeometryProduct新增OGQ2 v2 query section，完整leaf cut引用原始page/meshlet与顶点索引bank；原生、portable及pthread cooker输出该section，Product schema2、binary v2、OEGPACK 3.1、Web cooker ABI5同步。query pin精确page和物理byte-bank，metadata快照单独持有；失败fence隔离租约。GpuScene query snapshot共享一份176B实例与16B lineage副本，同mutation command可读取扩容后的候选表/新增槽位，mutation serial阻止abort后的ABA；Native prepared material也限定同frame command。刚体transform patch不再误写deformation revision。

`ScgiBvhBuild`/`scgi_bvh_build`实现bounds/Morton、稳定4-bit radix八轮、hierarchical scan、Karras重复key拓扑、parent jumping/depth分类、异常深度balanced rescue、分层refit和七叶frontier subset-DP treelet SAH，重排后重建links/levels/refit。`ScgiQueryScene`从现有RenderWorld/Product/native material建立不可变候选；`ScgiQueryTraversal/Batch/HitWork`包含shard归并、native coverage bins、等t稳定cursor、K轮后同提交完整coverage tail、64B parent continuation和diffuse/emissive projection。query consumers显式登记，退休等待全部已编码consumer，包括尚未提交者；失败submission隔离整个共享闭包。不是独立renderer，没有新增submit或本帧readback工作控制。

**尚未完成，不能后移到最终性能验收。**

1. SCGI-2：共享skin/morph current/previous position、normal、tangent、bounds publication及raster/VSM/query/anchor一致消费；fine/coarse/guard coverage cut、query domain和streaming调度；完整动态page迁移验收。当前全leaf cut和全域unknown检测不冒充完整coverage机制。
2. SCGI-4：在上述真实动态publication上验证有效anchor/seed，不以拒绝动态history当完成。
3. SCGI-5：静态BLAS复用、GPU dirty/refit/restructure/rebuild策略；实例compaction/分段TLAS与共享变换；独立低优先VT feedback、公平admission、mapping generation；single/back-side和inside语义；GPU ray worklist/count、tail pending压缩及dispatch成本控制；完整descriptor路线与随机/极端brute-force oracle、build/refit/trace成本验收。原生query结构验证仍需对齐TS，不只有range检查。
4. 当前tail数学上界仍按容量编码多次dispatch，node quantum避免单dispatch无限工作，但没有解决CPU编码长尾；有界不代表成本验收通过。pipeline cache、batch独立计账和新增源码可读性仍需整理。

**阶段Cost Card（理论，非benchmark）。** node64B+links8B，header64B/shard；source snapshot为192B×high-water，当前query affine128B×high-water×shard，后者重复成本尚待消除。batch continuation64B/ray，work48B/result32B/payload32B另计；三个packed worklists各约4B/ray加32B/bin、分层scan及独立indirect。完整顶点/索引/纹理不复制，保留的原bank/page/texture工作集及retiring峰值仍计原owner；query metadata、AS、scratch另计。Scene maximumBytes包含本owner AS/scratch/实例/目录，不是整renderer预算。Morton/radix/level/treelet各有dispatch边界，parent traversal产生随机node/geometry访问；alpha按bin/shard重访与tail worst dispatch须单独测，不能只报新ray数。

**已验证范围。** 阶段日志`.local/validation/scgi-5-contract-regression-02.txt`为157/157；之后修复刚体deformation provenance的合同25/25，最后同command快照相关合同`scgi-5-candidate-snapshot-contract-01.txt`为23/23，fresh build:test通过。GPU局部记录包括`scgi-5-final-consumer-production-gpu-01.json`：真实RenderWorld两Product、10shards/4bins、alpha/query输出、abort/retry及未提交final consumer退休；`scgi-5-continuation-abi-query-gpu-01.json`和transaction同名记录覆盖quantum续跑与ABI回归。portable/subgroup、重复keys、深度rescue及refit已有局部GPU验证。各结果只证明其运行revision的覆盖范围，不等同最新全部改动的集中验收。之前合同cwd错误、旧租约断言、fixture DataView范围错误、WGSL/TS编译错误保留原失败记录，修复后重跑对应项，不放宽算法断言。

**未运行/未闭合。** 本次保存前不宣称最新全量build/完整GPU回归、skin/morph动态、完整VT/coverage、满绑定和最终成本通过；AAA GI画面尚不存在。阶段源码还不能作为SCGI-2/4/5稳定完成边界。后续必须先完成第1项，再第2项，最后第3/4项并集中验收；不能继续启动SCGI-6。

### 7.8 SCGI-2统一返工与本轮范围调整（2026-10-17，实施中）

**本轮授权。** 用户要求统一旧 stash、master 和当前修复，彻底完成 SCGI-2；随后明确暂不需要 skin/morph，因为其他生产模块也未实现。因此撤销 SCGI-2/4 对新建整套共享 skin/morph producer 的前置要求，设计§4.3与本计划§3已同步。§7.6/7.7关于它阻塞关单的文字是此前范围快照，由本节更新；非零 deformation revision 无共享流仍是 unknown，不能声称已支持动画。刚体/负缩放/非均匀缩放/实例身份及完整 coverage 要求保持。

**三方整合。** 主分支基线为 `d583a0b3`。旧 stash `1a5e87e7a80660a242e99925f728bdb0b6a29eaf`（基于 `71ccf273`）未直接 pop，逐项核对后整合到唯一 Product owner：

| 旧 stash 范围 | 当前处理 |
|---|---|
| `GeometryCooker.h/.cpp` source primitive/vertex correspondence | 恢复 cook 期间 source triangle/vertex remap；多材质 domain 分开 source 编号，leaf 与源三角形严格双射 |
| `GeometryProductQueryV2.ts` 与 `GeometryProductQuery.cpp` | 不恢复第二套 decoder/格式；由现有 `GeometryProductQuerySection.ts`、`DecodedGeometryProduct.cpp` 与原生 reader 统一实现 v3 |
| Product/OEGPACK/WASM serializer/provider、recipe/build wiring | 沿 master 已接通的家族更新；schema2、binary descriptor v2/header272、OEGPACK3.1保持一致；query section升至v3/header160，Web input ABI6、runtimeProfile query3与新recipe同步 |
| residency query pin | 与 master 的物理 page/bank lease 合并；完整 query metadata 分段持有，最后 consumer fence 后退休，失败 fence 隔离 |
| 旧 build/CMake/ABI 测试 | 核对当前已有接线，不重复加另一个 query library；native/portable/pthread 生产者重新构建验证 |

stash 暂留作历史恢复点，不是当前实现的依赖，也不表示仍把新实现只存于 stash；所有差异对照及本单元完整验收后再处理历史条目。

**当前新增闭包。** query 内容摘要覆盖所有 table/remap；provider metadata 在首次 await 前捕获，digest 在容量分配、entry 与 page IO 前校验。Streaming 使用 admission 已捕获的 descriptor 与原 source receiver/read priority/release；query 请求通过既有 scheduler、背压与普通 frame publication，abort/retry/dormancy 不私自提交。有限 domain 为所有 cascades+guard 的向外 f32 包围盒，GPU 对共享实例 bounds 作八角变换；完整有限 ray segment 越域返回 unknown，不裁剪后称天空。查询目录为32B header + 112B/cluster + 4B prefix/cluster + 4B terminal，16B对齐，按 negotiated binding limit完整分段，跨段保持全局 traversal primitive地址。目录只复制索引与格式，不复制 vertex/index/UV payload；group/meshlet校验和属性解码继续共用raster decoder。

**仍不得混淆的边界。** 当前最低保证 cut 是完整 exact leaf；未证明简化 coarse 几何能保薄墙/门洞/alpha，故不能把 raster coarse 当 query coverage。有限 domain 筛选实例，但当前 query lease 仍保留所传 Product 的完整 leaf 工作集；还不能宣称 GPU demand 驱动的误差选择 coarse/fine cut 或域内 page 级工作集收缩已完成。SCGI-2 是否关单仍以这些设计要求与真实验收为准；本轮取消 skin/morph 不自动取消这些要求。SCGI-4/5、默认生产 GI 及最终画质均不在本节提升状态。

**当前场景与历史资源分离。** `GeometryQueryInstanceSnapshot.assertCurrent` 核对同一 GpuScene 的 buffer/lineage、high-water、content revision 与 mutation serial；candidate 提交后记录正式 revision。`NativeSceneQueryLease.isCurrent` 核对同 frame command 的 prepared 或 committed publication。`ScgiQueryScene.observeUse` 在接纳新 consumer 和提交前分别检查，防止先 copy/query、随后同 command patch 实例仍提交旧遮挡事实。历史快照资源仍按 final fence 保留，不因新场景变化擅自释放；abort 导致的 admission serial 变化要求重新捕获，不靠相同 revision 掩盖 ABA。该检查不遍历 CPU 对象、不读取 GPU、不新增 submit/dispatch/binding。此项不等于已完成 SCGI-8 的全 Renderer GI activation 接线。

**本轮实际成本。** Product descriptor 增量为 source primitive remap 4B/已cook三角形、source vertex remap 4B/已cook meshlet顶点及32B digest/header扩展；包含 coarse 层，不能只按原始mesh计数。GPU query directory 为 `align16(36 + 116·Csegment)`，每段至少160B；每段 CPU asset ranges 当前为全部 asset 的四个数字及JS对象开销，最坏 `O(Nsegment·Nasset)`，尚未优化为稀疏索引。共享payload不复制，但 query pin 的真实 leaf page bytes 与旧bank/旧AS退休重叠仍计入原 owner。source snapshot 为192B×high-water；当前 affine view 为128B×high-water×AS shard，加64B参数/shard；coverage为48B + max(16,16×Product数)。coverage dispatch为ceil(high-water/128)，每有效实例最多线性查Product范围；每shard实例view也是完整high-water域，后续SCGI-5 compaction/共享transform尚未宣称完成。有限domain只减GPU有效实例，不冒称已减少page/AS分配。真实两Product fixture目录强制160B分段，10shards、4bins，query scene分配402,496B；这是小场景资源验证，非大场景预算或性能benchmark。

**已运行验证与保留失败。** query ABI/cook/provider/admission/streaming/directory/lease相关回归 `scgi2-unified-contract-16.log` 为265/265；额外 Nyx runtime cooker ABI6 targeted通过。native cooker、portable/pthread WASM已重建，native Web ABI oracle通过；共享resident decoder与有限域实例八角bounds/负及非均匀缩放GPU验证 `scgi2-unified-geometry-gpu-10.log`通过；`scgi-anchor`刚体/current-previous/abort targeted GPU通过。新增 current-scene 合同 `scgi2-current-scene-contract-02.log` 为16/16；真实 RenderWorld两Product `scgi2-current-scene-production-gpu-03.log`通过，包括新增同command晚到patch提交前拒绝、重新捕获和最后consumer退休。GPU原始记录中的注入abort与既有资源403均保留，未吞掉或当作算法输出。

全仓扩展Node run `scgi2-unified-full-tests-01.log` **没有通过**：发现Nyx runtime旧ABI5测试桩（已改6并targeted重跑通过）及与本轮未改shader对应的旧Nyx函数名来源审计失败；运行到无关BC压缩1024²/2048²参考分别约184s/710s后主动终止尚未完成的4096²用例。不能记为全套通过。current-scene合同首轮误将一次性signal listener在变更前消费，修正测试顺序后重跑；production GPU第二轮运行中改fixture触发harness源码一致性拒绝，固定源码后第三轮通过。所有原始失败保留。当前必需缺项仍是coarse/fine/guard工作集机制、完整场景原子切换与对应压力验收，不能借取消动画范围而关单。

提交前最终受影响回归 `scgi2-current-scene-regression-01.log` 为287/287，覆盖上述新增current-scene与Native material合同；typecheck、新鲜build:test、完整build通过，docs-verify为0 findings/66 historical warnings，diff whitespace检查通过。所有结果只覆盖所述实现，SCGI-2状态保持实施中。

### 7.9 SCGI-2 query cut、工作集与 publication 闭包（2026-10-17）

**本轮范围。** 按用户要求连续完成剩余实现，只运行相关编译、极小语义与必要真实 GPU 输入输出；不重复整仓 Node、Renderer 全场景、benchmark 或 evidence/claim gate。skin/morph 仍按§7.8延期。本节更新§7.8关于“始终 pin 所传 Product 全部 leaf、缺工作集及本地原子交换”的实现事实；不提前关闭 SCGI-4/5 或开启默认 GI。

**实际 producer→consumer。**

1. `GeometryQueryWorkingSet` 读取同一 immutable GpuScene snapshot，以 world domain + guard 在 GPU 生成每 asset 的 object-space 包络和误差预算。多实例取 union/最严格误差，病态逆矩阵保全 asset，负/非均匀缩放沿共享刚体数学处理。每窗最多4096 assets，32B/asset 输出及三槽 ring；完成帧必须严格晚于 producer frame，同一 frame 所有窗口齐备才形成 cut，不把部分反馈当完整世界。
2. `GeometryQueryCut` 在 Product DAG 做 refinement cohort 与 ancestor closure，去重同一 refine group 的多个父 meshlet，输出相交 cluster、唯一 page 集与 primitive count。cut 不依赖 raster visibility；inactive asset 和域外 cluster 不进入 query lease。全世界查询是显式完整 cut，并非为缺失需求构造另一套几何 fallback。
3. `GeometryPageStreamingRuntime.requestQueryCut` 只将这些页接入原 scheduler、IO、stage、普通 frame publication 与背压。query feedback 不覆盖 raster/shadow 的 feedback-complete/age 水位。`retainQueryGeometry` 取得所选页的完整 candidate/committed 物理 lease；缺一页就不发布部分 cut。
4. directory v2 按 `align16(36 + 116C + 4T)` 的真实大小分段，保留 source primitive remap；GPU `QueryTriangle` 保存 Product cluster/local primitive 和 source primitive，traversal result 另存本次 cut 的 address。页迁移、分段及其他 cluster 被剔除不改变源身份，traversal address 不冒充跨 cut history identity。
5. `GeometryQueryCoverage` 将 `(Product slot, generation, asset reference)` 排序，在 GPU 二分定位当前实例对应的48B asset coverage record，复算当前域需求并检查包络包含。遗漏、teleport 超出旧域、未支持形变/材质等仍是 unknown；同一 source/material 的晚到 mutation 继续在编码及提交前拒绝。count/assetCount 是运行时 header 数据，coverage 与 demand PSO 按 device 复用，不按实例数、asset 数、voxel 或 quality 组合生成。
6. `ScgiQueryScenePublication` 实现 active/candidate/retiring：完整 scene 只在其 build command 内提前可读，submit 一次交换，abort 保留 active；旧 cut 等全部登记 consumer 及 replacement fence，失败 fence 保留隔离与退休计数。全空 cut 显式写 ray miss/unknown，未覆盖的远射线不变成天空；不分配无 consumer 的 AS/build scratch，零实例 snapshot 至少满足一个真实 storage record 的绑定下限。

**当前 coarse 的诚实边界。** 当前 cook 的合法 flags 仍为5（exact leaf + critical）和6（approximate + critical），所以现有 Product 的所有未证 coarse 必须精化；扩大误差预算不能跳过薄墙、门洞或 alpha。现在交付的是具有完整源质量、域内选页和正确 publication 的 query cut，不是有损 coarse 生成算法或已有 raster coarse 的保真证明。没有为凑功能另存一套低质 mesh，也没有宣称所有内容均能缩成小 coarse。所选域的 exact 工作集装不下就拒绝该 profile；目标内容需要更小的专用代理时，必须由 cook 另行提供真实保真证明及真实增量成本，不能把未实现的代理写成已采用。设计§4.2的“无合格 coarse 则承担真实 residency 成本”适用于当前 Product，不能据此宣称 coarse 减量。

**事务与 origin。** cut 保存 object-space 覆盖，world domain 每次消费按当前 transform 重算。纯 origin rebase 同步变更 domain/transform 后可保持相同局部覆盖；真实 assembly 移动或 teleport 超出该覆盖则 unknown/重新准备。新 Product descriptor/generation 不能沿用旧 cut，page relocation 不能 retarget 旧物理 lease。SCGI-8 仍须将完整 query publication 与 raster/geometry/cache activation 接到统一 frame transaction；本轮本地 scene 交换不等于该生产集成已完成。

**Cost Card（理论，不是 benchmark）。** 设每 Product 有 A assets、C clusters、E refinement references、所选 T triangles、P pages：新增需求 output + 三槽 staging 为 `128A + 96ceil(A/4096)` GPU bytes，另持同一192B×high-water source snapshot，零实例下限192B。冷 cut 临时工作为 `O(C+E)` 加排序，CPU feedback 只保有限窗口/帧，不持久累计未完成历史。query metadata 为上述真实分段公式，coverage 为 `48 + max(48,48ΣA)`；原 bank/page pin 与 retiring 重叠按原 owner 的真实 allocation bytes 计，不把共用 payload 记作免费。

每次 demand 更新每 Product/window 有 reset 和 reduce 两个依赖 dispatch，reduce 读完整 captured high-water 域，最坏 `O(IΣceil(Aproduct/4096))`，不是已经 compact 的实际实例数；归并为每相关实例六个 bounds 原子、一次 flags OR、一次 error Min。coverage 为一个 dispatch、每相关实例 `O(log ΣA)` metadata 查找与角点逆变换。每 segment 的 CPU asset ranges 仍有原 `O(Nsegment·Nasset)` 成本；每 AS shard 的 affine snapshot/compaction、static BLAS reuse 和 build/trace 成本仍归 SCGI-5。以上均不宣称性能改善，不据 tiny fixture 推断4GB大场景能力。

**局部验证记录。** 最终 `scgi2-query-cut-contract-final.log` 为6/6，包含精确空间 cut、跨 cut source identity、critical 强制细化、空目录、submit/abort/失败 fence。`scgi2-query-cut-gpu-01.log` 保留首轮失败：GPU 算法步骤无 device/scoped error，fixture 使用了宿主未实现的 `assert.throws`；仅改为显式捕获并检查原异常，不放宽断言。第二轮 `scgi2-query-cut-gpu-02.log` 通过近域选页、远页未加载、严格延迟反馈、teleport unknown、失败 replacement 保旧 lease 和创建前预算拒绝。

最终 fresh build:test 为 `scgi2-query-cut-test-build-final.log`，真实 GPU 最终记录 `scgi2-query-cut-gpu-03.log` 通过：负/非均匀缩放、正常 scheduler IO→stage→candidate abort→retry、旧 cut 在页目录撤销及成功 fence 后仍保物理页、真实零实例snapshot及零shard miss/unknown。GPU device/scoped errors均为空；小fixture需求buffer+三槽+参数224B，目录160B、所选1页，不能外推大场景。`scgi2-query-cut-build-final.log` 的完整build通过。只运行上述3个明确测试文件、最小GPU oracle与相关编译，没有运行整仓回归或完整Renderer/画质/benchmark。

**关单结论。** SCGI-2当前授权静态/刚体范围的实现与局部验收闭合：先前的全Product永久leaf pin、本地cut交换缺失及域变化无法复核已补齐。没有承诺有损coarse生成、skin/morph、默认GI画面或整Renderer性能通过。后续若内容提供新coarse证明/代理，须按Product版本与来源规则扩展，不能把现有flags6直接去critical后用于生产。

**集成边界。** SCGI-8/10 负责全 Renderer activation、组合画面、全部故障/恢复与资源峰值/成本。SCGI-4/5 状态不随本节自动提升。旧全仓未完成 run 与无关 Nyx 审计失败仍按§7.8保存，不改写为本轮通过。
