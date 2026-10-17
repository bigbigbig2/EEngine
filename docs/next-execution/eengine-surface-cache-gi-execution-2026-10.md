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

**当前状态：SCGI-R1/R2/R3 已完成实现与局部验证，默认1080p实验屋接通；SCGI-10 尚未完成，不能认定整个模块完成或成本已经合格。** 原始失败基线为 `2f276576`（2026-10-18），文档批准提交为 `b69b346e`，R1/R2代码提交为`4d65b4f2`/`b92bc907`；实施与成本见§8.4/8.5/8.6。下一单元为 **SCGI-10**，本轮停在 R3 完成边界。旧实施记录见§7，保留当时结果与失败，不逐项重开未受影响的cache/滤波/事务机制，也不把旧通过当成新架构验证。skin/morph随共享动画延期，4GB不作复杂大场景承诺。当前示例和本轮最高验收尺寸为 **1920×1080、internalScale=1**；不新增1440p/4K要求，不靠缩场景或降方向数关单。

## 1. 完整范围、依赖与生产切换

| 单元 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| SCGI-1 | owner/publication/事务/能力与具体ABI | 源码基线和source map | 已完成，见§7 |
| SCGI-2 | GeometryProduct query section、coverage cut、residency、共享刚体实例publication | 1 | 当前静态/刚体范围实现及局部验收完成，见§7.9；生产集成归8/10 |
| SCGI-3 | cascaded sparse cache、ring/scroll/evict/defrag/rank | 1 | 已完成，见§7.5 |
| SCGI-4 | half-res anchors、共享identity、screen history seed | 2、3 | 当前静态/刚体范围实现及局部验收完成，见§7.10；真实world field/composition归7/8 |
| SCGI-5 | 完整RadeonRays算法适配、query、material/alpha/VT | 1、2 | 当前静态/刚体范围实现及局部验收完成，见§7.11；默认生产消费与整链资格仍归8/10 |
| SCGI-6 | 全光源估计、punctual重连接、multi-bounce | 3、4、5 | 当前范围实现与局部验收闭合；§7.12 |
| SCGI-7 | 统计、动态失效、A0/A1/A2过滤、L1 screen field | 6 | 当前范围实现与局部验收闭合；§7.13 |
| SCGI-8 | FrameProgram+Native全部route原子接线、旧owner退休 | 1–7 | 当前范围完成；见§7.14 |
| SCGI-9 | Screen Radiance Gather完整近场残差增强 | 8 | 当前范围实现与局部验收闭合；见§7.15，画质收益有限且未获整链资格 |
| SCGI-R1 | 共享求交arena、scene TLAS、完整query执行与全部直接consumer切换 | 已有2/5/8/9事实 | 已完成，实施、验证与成本限制见§8.4 |
| SCGI-R2 | estimator样本扁平批处理、紧凑shadow与确定性reduce | R1 | 已完成，实施、验证与批量成本限制见§8.5 |
| SCGI-R3 | Gather先需求后Native共享源、合格visibility复用与补缺 | R1、R2稳定边界 | 已完成，实施、局部验证及新增存储成本见§8.6 |
| SCGI-10 | 全场景、故障、资源峰值、成本与文档闭合 | R1、R2、R3 | 待实施 |

SCGI-2与3算法依赖可独立准备，但遵守本仓库不使用子agent、GPU验证串行的要求。单元内允许代码暂时不可运行；稳定边界不能有两套production GI。SCGI-1～7构建完整新闭包并用真实算法fixture验证，**SCGI-8之前不把部分实现打开为默认生产功能**。既有renderer保持当前行为；测试fixture不是生产fallback。

上述1～9为原始施工序列，生产切换已发生，不能把其中的“8之前”解释成重新建设旧owner。R1/R2/R3按实际工作量划分：R1涉及query核心及全部consumer，体量最大；R2集中estimator，体量中等；R3跨Gather/Native/FrameProgram/window，体量较大。每个都是一个完整producer→consumer原子切换单元，内部工作不是额外几十个门禁；不承诺未实测的工期。完成一个单元后停在下一边界，连续推进须有用户相应授权。

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
| descriptor inventory | 现行16 SSBO/4 groups Native组合；R1分query kind重列真实清单，R3补Native source range/access mode，sampler/texture/uniform独立核对 |

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

**补充fixture。** 同primitive index不同instance、set/slot重用、material value改变、Product物理搬迁分别测试；deform previous有效输入随共享动画模块验收，当前验证没有共享流时拒绝伪造history，不作为本单元前置。严格身份用于history重投影；空间upsample按几何/材质相容性，不能要求邻tap同primitive而让所有三角形边缘失效。world/residual共享guide必须同role，不能拿新guide解释旧系数。

### SCGI-5：完整WebGPU compute query与材质命中

**来源。** 固定RadeonRays build_hlbvh、radix/scan、update/restructure、BLAS/TLAS intersector与structures，保留MIT notice；Unity仅对照行为。source map按实际函数逐项填写，不能只记录项目名。

**内部依赖顺序。** bounds→Morton→radix/scan→EmitTopology→分层refit→treelet restructure→TLAS→traversal→coverage continuation→diffuse-hit projection。opaque里程碑仅用于调试，不作为关单范围。

**具体工作。**

- portable与subgroup两个物理kernel保持同算法结果；对重复Morton、退化轴、0/1元素、非幂长度有专门分支。
- WGSL跨workgroup采用dispatch边界；parent pointer-jumping→depth histogram/scan/scatter→level-list/refit，不能同轮原地读写ancestor。treelet重排后重建links/levels，再refit；异常深度用完整balanced-range rebuild，不能反复重建同一失败拓扑。
- 静态BLAS复用，动态leaf/refit/restructure/rebuild，TLAS instance transform/mask/目录；dirty/rebuild队列由GPU写。
- ray-box/triangle、t interval、barycentric、frontFace、negative scale；closest/any accepted query、完整traversal stack/spill/continuation。
- native coverage完整求值、reject后继续搜索，Program/physical banks复用Native体系，不造VM。原K轮wavefront+quantum收尾是历史实现，目标被R1的共享scene/coverage范围内联完整遍历取代，不截透明层数。
- parent/escape保完整TLAS/BLAS返回和best hit；访问上界计每instance重复BLAS，非法cycle为fault。共面/等t用原区间和稳定顺序，不用epsilon跳过候选。删除旧continuation与零count尾巴的具体工作归R1。
- hit diffuse/emissive projection保留custom graph、UV/vertex inputs、ray-cone C/X/Y footprint、显式梯度、颜色解码、VT低优先feedback及coverage resident闭包。真实camera graph输入不能被transport direction替代，view-dependent输出参与失效。
- status区分hit、miss、unknown、不可信inside、pending、fault；pending仅存在同command内部，结束必须accepted/miss或明确cohort-invalid，不跨帧保留未完成alpha。

**容量。** ray batch复用scratch，finite shared AS arenas整体满足binding上限，完整parent遍历无深度截断。全部相关arena/coverage范围结束才能判miss；overflow/cycle/无进展为fault。R1替换旧物理布局与尾调度，保留本单元query语义；bounded但失控不能当通过。

**事务。** 本提交scene snapshot immutable，所有alpha续跑在其中完成，不因下一帧动态revision变化取消本帧工作。整patch cohort完成才发布；unknown/fault保留旧信号、降低confidence。动态AS candidate不覆盖仍在读取的active数据；fence退休包含page/material/coverage leases。

**验证层级。**

1. CPU brute-force triangle oracle独立于BVH，验证closest t/primitive/barycentric和any visibility；包含三角形边/顶点、平行ray、zero direction、极大/极小坐标与自交。
2. GPU排序/拓扑/每node bounds与CPU reference；shuffle输入/重复keys；所有leaf可达且只出现一次；parent覆盖children，refit与full rebuild一致。
3. 同ray集跨portable/subgroup/不同合法workgroup尺寸；GPU层间结果不得靠驱动偶然可见。
4. MASK多层栅栏/叶片与custom alpha RGB依赖；最前reject后命中后方，多实例同primitive id；深alpha不截层并完整结束。
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

**后续物理重构。** 以上积分/身份/事务保持；旧per-sample query循环由R2完整替换，不再按其历史dispatch公式继续扩功能。新query产品与R1一致，不为保旧fixture另接旧owner。

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

**容量/事务。** A0/A2在304K/bank内，A1 48K单scratch；field+guide 112H/role，双history与目录帧槽分别计账。全目录/stripe按设计§10/15计划。settings改常量，表示/extent改变需replacement；filter abort不推进role。

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

**验证。** 真实生产链；Standard/Unlit/Clearcoat/custom、resident/VT、Main/VSM alpha；AO×GI×SSSR和Native/FSR3/旁路；scale 1/upscale、奇数尺寸、HDR/exposure；实际全目录/stripe/remap等价。最满16 SSBO/4 groups与sampled限额、受控binding容量/halo边缘、VSM跨页/PCF fallback/local overflow；无需4K输出制造容量用例。cached graph换代不读旧field；唯一submit/唯一HDR writer。历史4K测试保留§7记录，不成为本轮重复前置。

**成本卡。** 双history、最多3目录槽、stripe/halo/partition/copy、Native ALU/taps、VSM remap单列。0/50/100%覆盖报告增量，省full纹理不等于总体更快；旧资源实际无consumer才计REMOVE。

**关单条件。** 完整基础SCGI生产闭包实际运行、旧owner已退出、来源证据可提升到所选算法的Adapt；尚未做SCGI-9/10不能标整个模块完成。

### SCGI-9：近场Screen Radiance Gather完整增强

**选定方案。** Brixelizer GI screen-probe阶段作为MIT参考/局部移植，采用本地world query+cache预测残差；不引入其SDF renderer，不同时堆Horizon GI。

**图接线。** 同GI owner的pre-Surface阶段读previous residual/重投影，并按R3生成本帧probe geometry查询与source requests；Native共享本次源准备，Surface后`surface-cache-gi-gather`补缺并生成下一代residual。真实compound products/ranges读写进入Lowering，不通过finish callback隐藏编码或新增submit。

**具体工作。**

- 仅在启用时对预先请求的exact sourcePixel共享Native evaluated material，post补缺生成diffuse-only unexposed radiance与guide，排除specular/sky/aerial/bloom；不从最终HDR猜diffuse，不整H重复graph。
- screen tile probe spawn、disocclusion重置、方向样本、visibility确认、reproject、radiance fill、L1投影、edge-aware interpolation全部闭合。
- 对同方向/同PDF/相容epoch的screen source与world预测求residual；missing screen coverage为零修正，不是零世界GI。
- residual自有variance/history/motion reject；t+1先reproject至当前anchor再给Native，base/residual分开，world-only history不覆写，不能经newpatch seed回灌。
- source用direct+Le+exact world-only求Lo，排除residual/fallback。主Surface local/普通directional无shadow；R3只复用资格完整的太阳VSM，对requested source缺失visibility用同query/PDF补齐。
- world prediction逆cosine卷积得moments，再用设计§13半球Gram解析inverse求a，Lhat=a·Y；直接标准SH评价moments不满足恒定半球零残差。同方向/PDF/epoch/coverage/window配对、固定N，mask=0贡献零修正；条件数约13.928的噪声放大纳入variance/confidence验收。
- probe history保SH/guide/identity/variance，方向数组仅当帧scratch；half residual用signed scaled half、复用同代world guide，不拿零/负L0作分母。R3共享exact anchor/sourcePixel的camera graph/VT，保持各route合法。
- diffuse源RGBA32F、16H B基线，显式采样不要求float32-filterable；方向scratch使用32B/方向f32布局，无源最大值reduction，signed residual独立scale。检验大HDR/曝光突变不溢出且不混编码。
- settings/debug/capacity、enable/disable/resize/cut和错误生命周期齐备；query预算与基础SCGI区分。

**producer / product / consumer。** diffuse-only source+guide+world prediction→signed residual history→下一帧重投影publication→Native与world-only合成。没有独立SSGI owner，没有同帧返回world estimate的边。

**容量/事务。** bounded probe数×方向数；probe池/history/source bytes、transient arrays计入新增项；提交失败不推进residual role，scene/material/light epoch不相容拒绝旧修正。

**验证。** micro-geometry/接触色溢出对比高spp；关闭gather仍有worldGI；同支持法线恒定半球零残差，部分coverage不偏置；不同normal/support测试表示误差，不能滥用常量证明。local遮挡/specular排除/移动emissive/freeze能量/world seed无残差；全目录/stripe与Native/FSR3真实消费。δL/δE允许负值，合成前单独clamp判失败。

**成本卡。** 基线H级source生成被R3的query→去重请求→Native共享→缺失visibility取代，新增mapping/preparation显式入账；probe query、depth/radiance fetch、reprojection/SH与history分别记录，不藏在基础GI预算。实际收益须同工作量测量。

**关单条件。** 母稿Phase I真实完成并有独立开关/增益与失败边界；不能以存在一个future interface关单。

### SCGI-R1：共享求交场景与完整query执行重构

**为什么先做。** 当前简单实验屋也有39个query shards，每个query batch重复shard与最坏quantum调度；只先减少Gather射线会掩盖query底层税。先使所有现有消费者使用真实scene TLAS与直接求交payload，保留完整材质/coverage能力，不先改GI积分算法。依据设计§4/5/19.3，R1是R2/R3必要前置。

**完整修改范围。** `GeometryQueryDirectory`/residency publication与`render/gi/ScgiQueryBlas`、`ScgiQueryScene`、`ScgiQueryBatch`及build/material/hit-work相关owner，`scgi_query_geometry`/`scgi_bvh_build`；直接消费方包括estimator、Gather probe/source shadow与有关debug/cost。名称以实际文件为准，不新造一套Ray Renderer。先完成以下闭包，末尾一次切全部生产调用并删旧路径：

- 从已发布Product cut生成object-space f32 `p0/p1/p2 + source ref`最小payload（48B/triangle模型）；opaque测试不再逐候选二分cluster/解page/取index/解3个position。原UV/normal/material仍归Product，只在coverage或accepted shading读取。源reference保存完整Product/cluster/primitive/generation映射，不能与cut-local地址混淆。共享BLAS和payload，rigid transform只更新TLAS；移动物理页而内容未变只更新source directory/leases，内容/cut/topology变化发布新payload+BLAS。
- 多Product BLAS放共享AS/payload arena，GPU compact实例构建scene TLAS，leaf指向BLAS descriptor/root/offset；现有HLBVH/radix/refit/treelet先保留。有限arena只因真实buffer/binding limits产生，由GPU保守空间路由ray、完整合并closest，禁止每asset全batch重扫和持久ray×asset pair数组。coverage按真实Native Program/physical bin子树/ranges路由并inline完整coverage，原MASK/custom/VT全部保留，不每asset编码所有bin。
- 三种query产品一次落实：occlusion/status；geometry closest的t/bary/identity/position/flat normal/error；accepted material closest的完整Native材质/VT结果。geometry-only不跑diffuse，但不省略MASK/unsupported/缺页/numeric资格。遍历在invocation内完整结束，parent/escape基线或小栈+完整回退；不预编码quantum尾巴、不每shard清全容量continuation，不限制alpha层数。真实active count、工作组prefix预留、有效记录写域和少量header reset闭合；队列溢出fault整个admitted batch/cohort，不clamp漏ray。
- affine方向不二次归一化、negative/nonuniform scale、casting/receiving masks、equal-t稳定规则和全域unknown语义保持。payload/BLAS/TLAS/source leases在同command publication事务内切换；pre-submit abort保留active，提交后failure poison，last-consumer fence后退休。所有直接consumer迁到新产品，删除旧asset-shard遍历、wavefront/quantum/tail控制及无consumer绑定/scratch，相关旧表示测试迁移语义，不建立A/B bridge。

**成本与失败边界。** 动工先记录48T及source/coverage索引、AS arena碎片、build scratch和replacement峰值；列出每种query的真实storage/sampled/group inventory，尤其满16 SSBO/完整VT材质。REMOVE只认实际删掉的续跑/clear/空dispatch。cold build、静态复用、全动态、很多Program/arena、深alpha分开算；parent访问上界检测cycle/越界，但不把“可结束”等同浏览器安全。若长invocation真实失控，在本单元调整空间范围/有界队列组织，保持同snapshot完整查询，不以alpha截断或恢复全容量量子链收口。WebGPU indirect只控制预编码命令尺寸，不生成任意命令；不做跨workgroup busy-wait或本帧readback。

**必要验证与关单。** 单元末集中typecheck/相关shader compile，小型真实GPU对brute-force oracle覆盖closest/occlusion/geometry-only、深MASK/custom/VT、多个Product/共享mesh多instance、negative scale、equal-t、domain unknown；少量payload内容换代/搬页/abort-retry/退休用例。静态实验屋固定1080p现有质量参数，核对所有consumer能用新链、active/routed计数与CPU编码/dispatch/clear/copy，保留旧失败。长alpha、不同coverage bins和跨arena至少一组最小完整查询。只有旧生产调度零consumer、descriptor真实合法、无漏query和新增失控容量才关单；整套Renderer画质/故障矩阵留SCGI-10，不每patch跑大回归。

### SCGI-R2：estimator样本队列与批量transport

**为什么做、依赖和产出。** R1稳定后移除`ScgiEstimator.encode`中sample/directional循环重复整套QueryBatch的物理乘法，得到相同随机样本/积分意义的批量light transport；不重写cache/rank/A0/A1/A2。修改`ScgiEstimator`/layout与`scgi_estimator`和R1 query接口，必要的raw cohort消费同步调整。

**完整工作。** light-origin固定池、patch×hemi、patch×connection扁平化为有稳定sample语义的工作，GPU生成有效count，在有界窗口内批量closest→最终accepted material bins→仅实际非零贡献的shadow队列→确定性逐patch归约。RNG由patch generation/sample serial/path/light ID决定，与压紧次序无关；physical nohit、遮挡、黑反射率仍占固定N。保留pool原始nohit、reconnection面积PDF/Jacobian、normal/coat、Le不乘albedo、punctual/hemisphere类别分工、previous A0 multi-bounce和全部source身份检查。unknown/fault使整patch cohort不发布，不按完成子集重归一化；pre-submit abort不推进提交序号，已尝试但unknown按既定序列推进。不能用float atomic的顺序不确定性替代reduce。

**资源/切换。** batch capacity控制scratch窗口，不是样本预算；所有selected updates/样本完整覆盖且归约跨窗口正确，count=0和overflow显式处理。原path224B、pool192B、cohort96B是布局基线，按真实活跃阶段重算ADD/REMOVE/alias，不机械永久保留新旧两套。保留同publication lease和单submit；一次切换所有estimator query调用，删除旧逐sample调度，不能为了旧测试混接。

**必要验证与关单。** 集中编译加一组固定seed独立高spp/解析输入，核对样本集合、物理零分母、PDF/Jacobian、black-emissive、shadow、unknown整cohort与abort序号；同一输入改变batch/window容量和压紧次序，验证估计相容。记录`L+U(Hsample+Csample)+UHsampleD` admitted上界和实际各类ray/材质求值/dispatch；0/50/100%有效贡献列队列与reduce税。不要求把R1已验证的全部材质矩阵再跑一轮。所有样本完整执行、旧逐sample整scene调度删除后关单；时间收益只写真实同条件结果。

### SCGI-R3：Gather请求驱动Native源与visibility补缺

**为什么做、依赖和产出。** R1/R2稳定后，把整半屏source重算改为实际probe命中的唯一anchor请求，复用主Native已求值材质及有资格的visibility。涉及`ScgiGather`/source、`scgi_gather`/`scgi_gather_source`、Native shader生成与diffuse数学、lighting directory/window/FinalPixelAbi、VSM helper及FrameProgram/Bindings/Lowering，必须在一个单元完成所有full/stripe/remap生产route。

**完整工作。** 按设计§13落实pre-Native spawn/geometry-only closest→screen身份/plane验证→exact anchor.sourcePixel请求→GPU bitset去重与方向映射。Native只在被请求pixel共享本次material/camera/derivatives/VT求值，直接读对应world-only base anchor；transport diffuse/coat公式独立核对，排除specular/HDR/环境fallback/residual。point/spot/普通directional当前无shadow，不能当可复用阴影；VSM额外返回invocation-local资格，缺合法页/深度的返回1不合格。太阳只有同epoch/receiver/coverage/filter语义一致才复用，其余真实非零贡献compact shadow，在post-Native完成source。local light采样/PDF不被主Surface确定性全灯总和替换。unknown源无效，不当无遮挡；未请求source明确未产生。

**绑定和寿命必须落到实处。** 不增第五张storage texture或拒绝合法满绑定材质。优先复用既有lighting directory/window binding的request/source-preparation独立range，WGSL read_write、host bind layout/usage、输入输出不重叠、Lowering读写与唯一writer完整更新；在合法phase边界消费，不依赖“GPU将来会写完”的假设。若route需要独立source phase，只消费本次Native真实最小preparation，按请求执行，不重复全graph。实现时交付逐route实际descriptor/range清单；窗口覆盖前drain/copy已写source，跨pre/post保留方向映射/请求与必要material量，不能引用复用scratch。bitset/ID/mapping按设计§15.2计账，禁止为调序保存全帧96B hit。Surface仅出本次preparation，GI继续拥有source/history/残差。

**保持全部数学/原子切换。** post补缺后沿同方向/固定N/PDF、Gram预测、signed delta、distance window、variance/history/reproject/interpolate产生下一帧residual；不改16方向同工作量比较，不让残差进入world seed/multi-bounce。pre只读previous residual、post只写next，不形成当前帧环。全部source消费者/调试/compound facts一起切换，删除旧全H source projection和每灯H shadow组织，旧source表示测试迁移，历史失败保留。

**必要验证与关单。** 集中编译与少量真实GPU输入输出：多方向同一source去重、2×2不同材质exact sourcePixel、camera graph/VT、clearcoat/metal/emissive、仅requested源写域；local遮挡、太阳合法fine/coarse与缺页补ray、薄墙/门边VSM近似误差。保留独立source能量oracle，区分VSM近似与数学错误；full/stripe/remap及满4 storage textures/16 sampled/16 SSBO至少覆盖真实route，不以shader能编译冒充接通。固定world场测试signed residual/next-frame消费和world字节未被回灌，再做一组abort/retry/window复用。记录Q、unique source、reuse-qualified、missing shadow、actual material eval、dispatch/clear/copy/peak；0/50/100%请求与visibility复用给break-even。全部绑定合法、无未请求全域source税、原数学和coverage完整后关单；整场动态画质和组合故障归SCGI-10。

### SCGI-10：全场景/故障/容量集中验收与文档收口

前置为R1/R2/R3闭合，依§4矩阵集中运行；代码最后变更后集中编译/build、新鲜build:test，GPU作业串行。实验屋最高/默认1920×1080、internalScale=1，以§8固定灯/场景/16方向等参数作同条件比较；另测小型边界输入，奇数尺寸/受限binding容量不要求1440p/4K。world-only与gather组合分别记录冷暖、static/moving、收敛阶段及actual rays，截图检查最终画面、world/raw/residual/source/debug，结合真实计数判断漏工作/重复工作。模块画质/正确性/资源与粗粒度成本是本轮必需；正式全Renderer长窗口P50/P95、跨设备性能资格留最终集成，不能把实际无法运行或coverage缺失也延期，更不能编造目标ms。

记录真实adapter、driver/browser/backend、device features/limits、internal/output、scale、所有quality knobs、scene revision、triangles/instances/pages、K/U/rays、cold/warm、static/moving/dynamic状态。理论表全部用实际ResourceAccounting校验，差额解释padding、retained、driver未计入与查询新增共享驻留。

复核母稿逐项矩阵、source map每阶段/分支、旧引用零生产消费者、disabled无owner分配、没有CPU本帧readback/额外submit、没有隐藏material fallback。原失败保留；完成的owner事实再更新domains，稳定ABI确有跨owner consumer才沉淀contracts/specs，不提前造新治理层。

关单记录必须分开：功能覆盖、数值/画面、生命周期、容量、成本、adoption、未完成正式性能资格。只有全部必需项闭合才把SCGI大模块标完成，然后停在下一模块边界。

## 4. Debug与场景验收矩阵

### 4.1 必备视图与计数

视图：cascade/cell/orientation、patch occupancy/rank/generation/age/update、raw/A0/A1/A2 L1、world-only field/final E/confidence、query cut/covered-domain/hit/unknown/alpha/pending、material projection/VT LOD、signed screen residual、dirty域。debug只观察真实生产数据，不改生产quality。

R1～R3增加真实观测：admitted/active/routed/实际完成query数、node/triangle/coverage/material evaluations、arena/BLAS/TLAS数量；Q→screen-valid→unique requested source→Native material reuse→visibility-qualified/missing/fault→finalised source计数。debug分别显示未请求、请求待补、合法源、缺页/unknown，不能把未产生源伪装有效黑色。记录CPU编码、dispatch/compute pass、clear/copy调用及声明bytes、live/transient/retiring峰值；声明bytes不冒充物理DRAM流量。

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

### 7.10 SCGI-4当前产品复核、接线修复与关单（2026-10-17）

**范围与结论。** 对照设计§7、§19和本文件SCGI-4合同，复核当前schema2 / OGQ2 v3 GeometryProduct、GpuScene实例lineage、当前frame records、Native material publication、SCGI双bank/screen roles及全部已存在的anchor直接consumer。SCGI-2前置已按§7.9闭合；skin/morph继续随共享动画模块延期，不恢复此前“必须先建设动画系统”的关单前置。**SCGI-4静态/刚体范围实现及局部验收完成。** SCGI-5仍未关单，本轮未推进其算法，也未开启默认生产GI。

**发现并修复的实际缺口。**

1. 旧anchor入口只有裸buffer，不能校验frame instances、lineage和Native材质是否来自同一当前publication。新增`encodeSceneAnchors`直接借用`GpuScene.queryBindings(command)`、`FrameInstanceTransforms`及`NativeSceneQueryLease`；frame owner校验source/work一致、已在当前encoder完成生产，容量覆盖当前high-water。捕获scene buffer/content/mutation serial、Product metadata/banks/binding epoch及material current资格，提交前再检查；同buffer晚到patch、扩容、实例替换及material/Product publication改变都不可提交旧输入。复用原command abort/retry与调用方fence租约，不增加scene副本、readback、独立submit或query AS前置。
2. GPU旧入口只校验work generation与instance lineage，未校验work的geometry/material引用是否仍匹配当前instance。现在不相符时完整写invalid；virtual profile在geometry decode前验证Product generation/table slot及asset group区间，普通profile显式拒绝virtual输入。group地址不再允许下溢成巨大asset-local meshlet身份；无效记录保留invalid sourcePixel，不能写rank0需求或seed。
3. 原数值fixture的work指向普通geometry 0，但手工frame source写geometry 1，碰巧旧shader未检查。只将本SCGI隔离fixture的source修正到实际消费geometry 0，并增加错配拒绝断言；没有恢复旧ABI/owner或给production增加测试fallback。

**实际producer→consumer闭包。**

| 源事实 | 本轮核对的消费 |
|---|---|
| VisibilityKey/current meshlet work + 共享frame records + GpuScene lineage + Native material revision | 完整128B anchor及64B精确身份；current/previous刚体位置、负/非均匀缩放、flat normal、motion/depth |
| 当前anchor | 112B rank0 receiver request→`ScgiCache` claim/allocate→`seedSources`；提交序号控制winner和需求窗口，abort不推进 |
| 当前Product metadata/resident pages | 按真实raster winner解码；语义身份为Product generation、asset-local meshlet及local primitive，不存query cut局部primitive地址；directory v2 source remap属于query地址合同，不能混充anchor历史身份 |
| previous committed world-only field + 原role guide/scale | 新physical patch唯一writer验证完整identity、epoch、normal、depth与双向plane/world/tangent距离；初始化A0/A2及seed/post validity，真实query/cohort count仍0 |
| resize/cut/scene替换/abort | 原runtime交换和退休；resize拒旧screen seed且保留相容world，cut拒seed；同physical instance range复用改变完整lifetime |

SCGI-7尚未实现真实world-only field writer，SCGI-8尚未接FrameProgram；本轮history radiance仍为明确的隔离输入。这是单元依赖顺序，不冒称已经得到GI图像或完整生产接通。SCGI-7/8必须继续用真实writer补组合链验收；空间upsample/残差也不由本单元新增。

**必要验证。**

- `npm run build`通过，含TypeScript检查、Vite与库构建；新鲜`npm run build:test`通过。日志`scgi4-closure-build-01.log`、`scgi4-closure-test-build-final.log`。
- 精确单文件`scgi-anchor-publication.test.mjs`检查当前owner绑定、同buffer mutation、material/Product替换及错误frame source/work/encoder拒绝，最终build上4/4通过。日志`scgi4-closure-contract-final.log`。
- 新`scgi-anchor-publication`真实GPU oracle：1×1输入，实际MultiProduct runtime、GpuScene、FrameInstanceTransforms、NativeMaterialScene→anchor→allocator→seed；验证有效负/非均匀刚体、真实material revision、world-only A0/A2及scale、count0、同buffer晚到实例patch提交前abort、重新捕获retry、同physical range lifetime替换拒绝旧seed、晚到材质candidate拒绝提交、真实材质revision改变单独拒绝history。`scgi4-closure-publication-gpu-02.log`通过。
- `scgi-anchor`真实GPU oracle通过：相同primitive Native seed数学与独立camera投影、刚体current/previous、sky/1×1/1919×1079/细杆/屏边、完整错配invalid写域、Product generation/slot/group拒绝、两个真实Product与物理地址扰动身份不变、严格identity/normal/depth/plane/epoch拒绝、三段anchor/history与跨段seed、循环budget与abort/retry、resize世界保留。日志`scgi4-closure-anchor-gpu-01.log`。
- 两次GPU成功结果均为NVIDIA Turing硬件、Chrome 155.0.8059.82、16 storage bindings / 128MiB单binding，`gpuErrors`与`scopedGpuErrors`为空。最终源构建SHA256：`1bcec185ba1176df5d0390e97ea752f2c7822b3cb7620ffbaf1e2545a222a3a9`。1919×1079的约160.8ms为完整readback与CPU oracle wall time，不是GPU shader耗时。
- `node tools/docs-verify.mjs`通过，0 findings / 66 historical warnings；设计/执行、domain事实和source map均同步到当前代码，入口不复制单元状态。

**失败留痕。** `scgi4-closure-contract-01.log`为Node fixture导入时未先定义GPUShaderStage，改为先声明测试环境常量再动态导入；不涉及production。`scgi4-closure-publication-gpu-01.log`的轴向normal断言错误要求f32归一化cross精确等于-1，GPU无validation error；改用与原刚体独立oracle相同的1e-6 f32误差界，同时检查另外两轴为0附近，不改法线方向或production数学。失败记录保留，之后只重跑受影响oracle。

**增量成本与来源。** 本轮scene接线为Local/Original integration，复用已有GpuScene、Product/Native lease、frame transform与command提交合同，没有新增第三方算法移植声明。新增GPU常驻/临时buffer、texture、history、AS、dispatch与pipeline permutation均为0；CPU每次anchor编码/提交前各一次有界owner校验，最多4个bank引用；shader增加geometry/material相等与Product group区间拒绝，既有Product resolve前移，不加全屏pass或额外场景扫描。原128H anchor、224H双field与seed分片组合成本仍按§7.6成本卡，不以本轮正确性结果宣称性能提升。

**关单边界。** 未跑整仓Node、完整Renderer画面、跨GPU/浏览器、benchmark、evidence/claims或SCGI-10故障/峰值组合；与本轮无关的已知失败不改写为通过。默认GI仍off，4GB不承诺复杂大场景。本轮关单后停在SCGI-5剩余机制边界。

### 7.11 SCGI-5完整query机制与局部验收（2026-10-17）

**范围与结论。** 基于`16588bbf`后的工作区，延续已实现的Morton/radix/scan、HLBVH拓扑、分层refit、七frontier treelet、深树balanced救援、双层parent continuation及Native coverage/diffuse投影，补齐静态BLAS复用、GPU实例工作集/更新策略、GPU ray count、tail工作压缩和独立VT反馈。本节替代§7.7中SCGI-5尚未闭合的机制清单；不改写旧失败或旧阶段快照。**当前静态/刚体范围实现及局部验收完成。** skin/morph按用户授权随共享动画模块扩展。SCGI-6的irradiance estimator、SCGI-7的真实field writer与SCGI-8的默认生产切换没有提前实现，当前不宣称已有GI图像。

**producer→产品→直接consumer核对。**

| 当前owner与产品 | SCGI-5实际消费与完整性 |
|---|---|
| GeometryProduct query cut、原四payload banks及pin lease | BLAS bounds与query属性解码读取同一分段directory/source remap；不另存整套vertex/index。原页撤销、Product销毁后已持有的query快照继续读原页，最后consumer后退休 |
| 不可变Product descriptor与完整cut | `ScgiQueryBlas`按device、完整cluster序列/目录段布局和asset/shard范围复用已提交BLAS。准备中/abort候选不共享，失败提交隔离；cut键每lease构造一次；最后holder退出才销毁，不建idle GPU缓存 |
| GpuScene instance/lineage快照 | `GeometryQueryTransforms`只生成一份全scene affine/world bounds。每几何shard在完整source-slot窗口内classify→offsets→scatter，GPU发布compact count及原source slot refs；inactive/不相干asset/domain不进入该TLAS，离屏active实例保留 |
| previous submitted TLAS与当前compact bounds | topology复制到独立候选，旧scene登记copy consumer；GPU选择unchanged/refit/restructure/rebuild，active始终immutable。membership/count/旧fault或32次refit触发rebuild；normalized node-area比1.2/2.0控制treelet及下一候选重建请求，不是测试容差 |
| GPU dense-prefix ray count | `ScgiQueryRayCount`验证完整容量并产indirect；0条无traversal工作，超容量整batch fault，未使用suffix完整写unknown。不存在本帧count readback→CPU决策 |
| 全部AS shards与Native coverage bins | K轮candidate→bin work→coverage后，对pending作完整tail；K=0同样完整。每quantum重新compact unfinished rays并间接派发；TLAS/BLAS状态和best hit完整保存，结束检查未完成为fault，不能发布pending或epsilon跳过等t alpha |
| accepted hit、Native graph与材质publication | 继续原UV/vertex、ray-cone C/X/Y、颜色解码、真实camera/view输入、diffuse/emission与coverage闭包。closest与any-accepted-hit区分；单面背向diffuse为不可信inside，双面修正朝向；visibility不额外执行diffuse |
| 原TextureResidency/VT owner | 独立query feedback ring与primary demand并集，共用atlas/IO/普通上传command。7/8主视图+1/8查询份额可互借，coarse-first，同mip query grant按8帧epoch轮转；mapping token在submit推进、abort回滚，batch暴露token/viewDependent供6/7失效 |

**事务与退休。** scene只在全部BLAS/TLAS/coverage编码后可读，同command消费或submit后的immutable消费均登记。提交前重查GpuScene和Native material current资格，晚到patch或publication替换使旧candidate拒绝提交；topology历史复制不要求旧scene仍可服务新transport，但必须等copy fence退休。abort销毁候选而不改active，重试重新捕获；失败fence隔离共享页/材质/BLAS，不伪装已完成。batch自己的scratch在最终consumer成功前不可销毁，异步准备/loss中止释放已创建资源；每device pipeline/layout缓存使用现有descriptor cache。

内置VT feedback的每batch持有query demand，多个batch共享channel。最后一个batch退休撤销query-only需求、保留primary需求，并以退休帧拒绝迟到feedback恢复旧需求；ring由原VT owner保留到teardown供绑定复用。显式外部feedback归调用方。没有新增private submit、frame控制readback、逐实例CPU transform循环、第二scene或VM。

**实际Cost Card：理论分配与物理调度，不是性能承诺。**

- 源快照`176I+16I`，共享affine/bounds`128I+32I`，合计352B/source slot，按high-water保守分配。每TLAS窗口独立compact hierarchy约148B/容量slot，不能把原slot refs当作另一份变换或漏算跨geometry shard重复TLAS。window默认4096 slots，独立于BLAS primitive capacity，全部窗口参与。
- BLAS/TLAS的64B node+8B links+4B primitive reference约为`72(2P−1)+4P+64`再加range对齐；100万triangle约141.14MiB、400万约564.58MiB，只是AS容量。directory为`align16(36+116C+4T)`，包含实际source remap；完整三角fixture有限段需要208B，不能沿用无remap时160B假设。没有另物化16B/triangle地址表。
- scene另计共享BLAS/TLAS两份build scratch、两个builder共`4×512×uniformAlignment`参数、两组level indirect数组、64B/window实例参数、48B/geometry参数和coverage/material目录。`scene.byteLength`对该scene借用的共享BLAS也计完整驻留量，属于保守admission；实际全设备accounting只在共享BLAS首次创建登记。old/new/retiring、页pin延长的原geometry驻留和流送staging必须另计，不能从per-scene budget推断全机峰值。
- batch借用ray48B/result32B、调用方payload32B（query不读取payload）及diffuse output64B/ray；私有continuation64B/ray，coverage/pending/diffuse三个hit列表各约4B/ray加bin counters、scan scratch、indirect/参数；tail另`4B/ray+64B`，可选GPU count另64B。any-hit不建diffuse列表/执行diffuse，但当前API仍要求调用方output域。`ScgiQueryBatch.cost`精确汇总私有buffer大小、全部编码dispatch上界、tail quanta和真实descriptor inventory，不把外部资源藏进“零成本复用”。
- tail默认4096 node steps；上界`ceil((3Nt+Iwindow(3Nb+1)+1)/4096)`使用实际geometry primitive count和完整source窗口，包含同BLAS被多实例重复访问。每quantum有compact、publish、traversal三dispatch，尾部另finish；GPU count为零也仍有验证、必要scan/clear及CPU编码成本。最坏工作量随shard×coverage bin×TLAS窗口增长，不宣称已经解决大场景CPU编码/深alpha成本；当前分阶段prepare/encode及有界batch允许后续调度优化，不增加材质实例数量对应的pipeline permutation。
- VT独立channel按1,048,576页/65,536队列，三槽各GPU655,424B、readback262,208B、indirect12B，另disabled64B，共2,752,996B，约2.625MiB；每次feedback的64B临时header及原upload staging另计。没有新增atlas/texture payload副本；ring按需求首次创建，不是每batch创建。primary与query的CPU metadata和真实驻留页仍归原owner。
- tiny真实Product fixture：scene592,728B，137-ray batch私有15,828B、64B/ray continuation；K2为67条总dispatch上界、6 tail quanta，K0为34条、6 quanta。两Product/10shards fixture scene665,616B、batch16,768B、20 quanta/201总dispatch上界。VT单ray fixture私有2,960B、1 quantum/11dispatch。以上是对应fixture的完整分配/静态编码计数，不是1080p屏幕预算或吞吐率。
- 访问类型：build为bounds顺序读、radix/scan多轮读写及层间dispatch，treelet为局部组合搜索；traversal为node/geometry随机读，coverage按Program bin重复求值，tail有ray-sized扫描和append原子；diffuse依材质实际C/X/Y采样，VT再加稀疏feedback原子。shared transform/static BLAS移除重复派生/构建，但未测同条件before/after净收益，不作加速声明。

**集中小范围验证与来源。**

1. `npm run build:test`新鲜构建通过，最终`scgi5-test-build-09.log`；`npm run build`含TypeScript/Vite/declarations通过，`scgi5-build-final-02.log`。最终source SHA256为`3ddcef6ae0f8d49f2d5a95bbbd385219bc01bd3b5f1c0ec7685b5945c2f07c58`，output为`dda625a39990beed88f5a9081e2e649da1ed66323028081bb4a06927f4885b34`。
2. 定向Node合同`scgi.test`、`scgi-query-blas`、`scgi-query-scene-lifetime`、`scgi-query-scene-publication`及`virtual-texture-residency`最终30/30通过，`scgi5-contract-final-03.log`。包含精确ABI/容量、descriptor、提交/中止/失败隔离、最后holder、primary/query公平并集、mapping abort/retry和最后query释放后拒绝迟到feedback。
3. `scgi-query`真实GPU：portable/subgroup在0/1/2/7/129/513元素上的hierarchy一致，含refit/深树救援/极端值/fault；137条独立double precision brute-force rays，81层alpha reject、镜像/非均匀变换、双面/inside、closest/any、轴平行/自相交区间/极小方向/有限巨大出域/NaN；三TLAS窗口、共享affine/static BLAS、unchanged/refit/membership rebuild、abort/retry、GPU count 1/0/overflow/retry。最终日志`scgi5-query-gpu-final-02.log`。
4. `scgi-query-vt`真实Native graph+原VT：独立解析BC4 tail `32/255/π`→fine `224/255/π`，仅query反馈在两帧内推动mapping 1→2，primary wanted仍0，IO receipts全部释放。补充14个真实ordinary texture banks+原VT table/atlas，全部采样参与独立数值结果，在实际query shader同时创建、编译并执行16 storage、16 sampled、8 Native RGB sampler、5 uniform/4 groups；此8 sampler覆盖当前普通RGB六类+VT两类，不冒称任意Product/alpha sampler组合或所有设备。最满组合期望0.1048550213、实测约0.1048550233。最终日志`scgi5-query-vt-gpu-final-02.log`。
5. `scgi-query-continuation`仅运行原geometry oracle内query快照/实例部分，验证quantum=1续跑、81层alpha、等t跨instance稳定cursor、2/83轮wavefront、native custom graph、原Product撤销/销毁后的decoder lease及domain边界/奇异变换。`scgi5-query-continuation-gpu-03.log`通过。真实Renderer/GpuRenderWorld两Product→10shards/4diffuse bins/2coverage classes验证，包含escaped-domain unknown/retry、缺Product unknown、过期scene提交前拒绝、最后consumer退休、abort/retry，`scgi5-native-multi-product-gpu-02.log`通过。二者基于上一源hash`e7ef380b…c6b7b`；此后仅增VT最后batch需求释放及相应测试，变换/BLAS/traversal/Renderer产品接线未再变化，未重复无关GPU回归。
6. GPU通过记录为NVIDIA Turing硬件、Chrome155.0.8059.82、16 storage/128MiB单binding；`gpuErrors`与`scopedGpuErrors`为空。timestamp仅作小fixture成本观测：最终一次build约59.64ms、dirty update约32.22ms、初次query约15.65ms；初次build/update与pipeline/driver冷启动开销未独立分离。预热K0下137条深alpha约7.10ms、单条深alpha约8.96ms、单条opaque约1.02ms、count0约0.27ms，均为单次粗观测，不是分布benchmark；ray数少不等于低开销，dispatch固定税和81层Native coverage求值仍明显。不能据此外推全Renderer FPS、百万ray吞吐或4GB复杂场景资格，也不宣称当前实现已达到最终性能目标。

继续固定RadeonRays `c8890b96b1f976bedd2cd280cc170dff5d655e0a`，MIT/Bullet notice保留，具体文件/函数映射见[移植来源](../porting/next-renderer.md)。Morton/radix/scan/拓扑/refit/treelet/intersection职责为Adapt/Reference；WGSL dispatch同步、shared affine、精确cut缓存、GPU更新策略、compact工作、Native/VT/事务为本地实现或已有owner扩展。局部GPU通过不提升为完整Renderer production adoption，该资格仍待SCGI-8。

**失败留痕与修复分类。** 编号日志保留在`.local/validation/scgi5-*`：旧test build、新代码TypeScript空值、初始fixture未构造完整canonical Native graph、共享coarse parent引用断言、fake GPU遗漏usage常量、目录160B不能容纳source remap、slot0 fallback导致的实例计数预期错误均已按实际原因修复。continuation前两次为fixture未释放上一个实例handle、以及旧测试仍从共享affine mask读取domain筛选；现在释放实际handle，并检查compact primitive refs/count，不改变生产域筛选或放宽几何断言。最满descriptor初次fixture把普通number数组当Float32Array常量，size为NaN；改为正确typed array后重跑。早期真实shader/接线错误保留原日志，不吞GPU错误、不减少alpha层、不缩ray集、不添加测试专用production fallback。

**关单边界。** 本轮未跑整仓Node、整Renderer AAA画面、Bistro/Dungeon组合峰值、跨GPU/浏览器、正式P50/P95或source adoption/evidence门禁；它们按既定计划归8/10，不能据局部fixture宣布完成。SCGI-6/7必须真实消费query result/material/VT mapping/view资格并完成cohort，8必须将scene/cache/Native/FrameProgram原子接通，10再验完整工作集与性能。4GB低端设备按实际预算能力拒绝或选完整较小profile，不承诺复杂大场景。下一单元为SCGI-6，本轮不自动跨入。

文档同步检查`node tools/docs-verify.mjs`为0 findings / 66 historical warnings / 205 documents，原历史warning保留；`git diff --check`通过。本轮只更新设计中已落地的物理布局/owner细节、domain事实与本节实施结果，不新增重复status文件或修改workstream细单元状态。

### 7.12 SCGI-6：全光源估计、重连接与多跳输入闭合（2026-10-17）

**范围。** 基于master `930a2e29`实现本单元，未stash分流。`ScgiEstimator`直接消费既有GpuScene/GeometryProduct的immutable query scene、Native coverage/diffuse/emission、LightDatabase与PhysicalEnvironment；输出raw RGB L1、完整cohort状态、sample sequence与rank1需求。没有第二套Renderer/geometry/material truth，没有新frame submit或GPU读回控制。当前生产GI仍关闭；A0/A1/A2 writer、screen lookup和Native原子接线分别属于7/8，本节不提前宣称已有最终GI画面。

**对照设计逐项闭合。**

| 合同 | 当前实现与直接验证 |
|---|---|
| hemisphere、SH与固定分母 | uniform `1/(2π)`，标准0/x/y/z basis，π与2π/3卷积；物理零/no-hit不删槽、不改分母；全局常量由两相反半球求和验收，倾斜半球在任意方向对照`πL(1+n·ng)/2` |
| 光源分区 | hemisphere只计environment、Le、authored directional/physical sun、previous A0；点/spot只走light-origin池重连接，避免当前单跳重复；零base发射仍保持1:2:4，physical sun使用hitPosition透射LUT |
| 完整全灯 | 枚举point/spot occupancy，不使用LocalLightWork屏幕tile；uniform reference与power-CDF含正support；70盏灯包含零power全部发布，64槽容量整cohort拒绝；灯删除后旧owner在encode及提交前失效 |
| pool与重连接 | 固定192B槽保留no-hit，有限range支持域外为零；任意finite cutoff不是零；完整PDF/area Jacobian、距离/range/cone、shading/geometric cosine比；验证instance/primitive/generation/64B identity/t/error，相同primitive不同实例的28次遮挡目标拒绝 |
| world visibility | closest与any-hit沿同coverage/tail；离屏遮挡、MASK穿透、surface/shadow独立mask、CastsShadow=false保留transport；太阳lit→world blocker后结果为零 |
| multi-bounce | previous committed A0检查world/逐patch epochs、slot/identity/normal/双边plane/距离；rank0缺失发rank1 demand，missing计数交7降低confidence；候选A0注入1e20不能回灌；关闭continuation回零 |
| cohort与serial | raw64B的Nhemi/Nconnect/valid/fault完整写域，unknown/inside/fault整组不发布部分值；sequence low/high每尝试推进，失败不重复采样，abort不推进；real count/A0/A2留7唯一writer |
| 容量与生命周期 | finite batch、GPU count/indirect、同command顺序重用；10 SSBO估计器与query实际inventory分别准入；分配失败清理；deviceEpoch与light/material/environment resource版本验证；提交后失败隔离、不可伪回滚，fence退休/device loss保留 |

**数值与真实GPU。** 新增`tests/oracle/scgi-estimator-gpu.mjs`使用真实Product、GpuScene、Native PSO、ScgiCache/QueryBatch、GPULightCollection和PhysicalEnvironment owner。天空N512的解析接受界采用独立有界变量积分；punctual/spot采用300×300三角形面积积分，独立计算二阶矩及两阶段有放回采样方差`Var(g)[1/Npool+(1−1/Npool)/Nconnect]`，接受6 SE加1e−4积分/浮点余量，不使用随意百分比放宽。最终point约0.616058，对照0.558994、SE0.087273；spot约0.519306，对照0.532729、SE0.031068。SH截断与精确cosine的表示误差分开，不当作浮点容差。

独立方向积分得有限大墙L1 form factor=0.9841986001；RGB反射率(0.8,0.2,0.1)、直接边界(0.1,0.2,0.4)，18轮真实GPU continuation输出为(0.4656425,0.2494245,0.4439092)，解析固定点为(0.4702759,0.2490163,0.4436655)。oracle显式提供每轮previous-A0边界，验证估计器Jacobi传输/彩色反射率，而非伪造SCGI-7 filter；黑/白/彩色与吸收、开关分支分别覆盖。完整Cornell画面、动态材质/门变化的真实A0/A2收敛仍按7/8/10直接consumer验收，不能由本输入oracle代替。

最终新鲜build:test source SHA `28a785305bd1b9b92947c50b9ffc40a00e9329035ca422308e785e723bfc6041`，output SHA `18e8c63d57518de59f6856b6dbea18f92b1c4a65bde2fe3ed5242dbd4da41374`；GPU运行NVIDIA Turing/Chrome155硬件，16 storage/128MiB binding。`scgi-estimator`77个提交的`gpuErrors/scopedGpuErrors/pageErrors`为空。`scgi-query`原64B消费、完整81层alpha与affine更新路径也通过，确认64→可选96B扩展未替换旧消费者。最终同一source/output build的query兼容复核和估计器96B消费均通过。没有据此提升完整Renderer或跨设备资格。

**成本卡。** 内存公式、ray/dispatch上界见设计§8.4。实际sky fixture U1/L4/H512/C4/B4的private bytes=12,600，pool768B，理论最大ray520，encoded dispatch上界7,245，command参数266,496B。punctual U1/L2048/H64/C256/B256的private bytes=543,832，pool393,216B，最大ray2,368，encoded dispatch上界4,606，command参数171,520B；query batch私有bytes已包含，借用AS、world双bank、Native/VT/environment与owner退休峰值必须另外合计。容量示例L1024/B256/U2048/maxLights4096的arena516,352B，与output像素无乘法关系。

每光源表16B GPU顺序枚举/CDF、pool192B随机重连接、path224B/命中96B批量写读、每patch raw64B与cohort96B；每次64线程lane独占自己的path/cohort，灯压缩、诊断、bounce队列用u32 atomics，无float atomic/subgroup硬依赖、无跨workgroup spin。理想miss省directional/cache实际shader工作，正常opaque有完整hemisphere/reconnect，最坏多灯+alpha成本按完整query visits另计，不将new ray数等同intersection次数。现阶段每H/C仍有窗口dispatch与临时参数固定税，不宣称最终性能；首个512样本4-lane天空fixture的timestamp跨度约156.23ms，含命令间隙/冷启动，不是净shader或P50/P95。该结果说明当前高样本验证配置不能当实时profile，保留为后续融合/共享准备/合理生产预算的成本事实，不通过少算样本/截断alpha伪优化。

**验证与失败留痕。** 完整`npm --prefix OEngine run build`（含typecheck）和新鲜`build:test`通过，4个targeted合同文件23/23通过。GPU作业串行，不跑整仓/整Renderer回归；日志保留`.local/scgi6-reference/`，未把本地产物加入Git。早期fixture缺真实Graphics bindings、WGSL保留字/无限常量、assert shim无throws、staging48→16误拷贝、太阳horizon、rank1公平调度、倾斜normal旧patch复用、粗cell跨零坐标导致rank1不足、未启用timestamp feature等均保留原失败。修复fixture或真实shader原因，不吞错误、不加production fallback、不放宽原生产语义。有限ray miss语义与扩展几何finite检查是真实实现修正；power全灯/epoch/serial/abort均保留断言。

**来源与关单边界。** 重新研究固定Unity UCL源码仅作Reference；估计器本地独立推导实现，具体入口/差异见source map，不冒称Unity代码port或production adoption。当前静态/刚体opaque+MASK单元闭合；skin/morph按用户授权继续随共享动画后续实现。7必须直接消费`estimateComplete`与raw valid/fault/missing、写真实A0/statistics/epochs，再完成A1/A2与动态失效；8才启用生产。未运行完整Cornell/大场景画质、最终world→Native闭环、跨GPU、正式吞吐/帧时/4GB资格，均保持未验证。本轮停在SCGI-7边界。

文档同步检查：`node tools/docs-verify.mjs`为0 findings / 66 historical warnings / 205 documents；`--staged`为0 findings / 81 historical warnings / 205 documents，差异来自历史文档引用未跟踪本地产物，保留原warnings。`git diff --cached --check`通过。

### 7.13 SCGI-7：累计、动态失效与world-only field闭合（2026-10-17）

**范围与结论。** 对照设计§9–12/19完成ScgiFilter、ScgiInvalidation与WGSL，实际消费SCGI-6 raw/cohort、SCGI-3 map/update/dirty、SCGI-4 anchor/history。当前静态/刚体opaque+MASK实现及局部验收闭合。没有开启RendererCore/FrameProgram生产GI，停在SCGI-8边界；没有把buffer oracle声称为AAA画面资格。

| 合同 | 实现/直接消费 |
|---|---|
| A0 | estimate/cache完成前置，完整合法cohort才增加count；物理零正常更新，unknown保旧降confidence |
| moments/drift | RGB short mean+relative variance，scaled delta避免HDR平方溢出；启动1/count界、drift响应和count饱和 |
| A1 | immutable本帧A0→48K完整scratch，off复制；tangent jitter/双边plane/normal/身份/coarse过渡，不加count |
| A2 | 独立上一A2→post，不二次改moments/count；四组合/new/seed/stale/config/owner重建reset；随defrag移址 |
| dirty | 同GpuScene snapshot GPU比较old/new bounds/affine/identity/material epoch；32区域overflow全dirty；changed/geometry revision降低域外置信，age/dirty轮转刷新 |
| field | 中心/位置/独立cone方向jitter，center缺失可借rank0邻域；分段完整写含odd/background；guide/identity共同发布 |
| SH/HDR | 世界正交RGB L1 f32；GPU reduction选择power-of-two scale，逐颜色L1/L0归一half，flags带scale/confidence |
| history | 实际filter→field→真实scene/Product/material anchor→seed；seed置信×0.25/count0，首真实cohort替换seed |
| access | lookup原子归并实际消费slot，独立touch写candidate lastAccess，避免并发世界读写冲突 |
| 事务 | 全部GPU写走原command/candidate；配置和dirty facts role只在submitted推进，abort保旧，提交后失败隔离 |

**表示修正。** 原执行容量288K/96H改当前304K/112H。相对方差为无量纲Var(L0)/meanScale²，cache varianceThreshold同步语义，不存可能溢出的辐射平方。post word69为0 absent/1 seed/2真实post。world header22为geometry revision，58/59为GPU scale/filter serial，prepare不再覆盖58/59。flags bit0/1 valid/normalized、bits2…9 exponent+126、bits10…25 confidence。CPU scale=1仅metadata诊断，实际seed读field exponent；signed residual给SCGI-9独立编码，不建旧world ABI桥。

**生命周期/容量。** filter无私有persistent GPU buffer，借workset/anchor/field；异步PSO准备后encode，同device/plan/tx一次。invalidation私有双128B/source facts+1040B dirty，调用方持snapshot至最后fence，encode/finish前检查current；超capacity拒绝，8按high-water replacement，不能截断。新owner首帧保守dirty，旧ownerfence退休。abort不交换facts/推进配置；失败fence隔离到device teardown。runtime既有异步错误/device-loss/退休合同仍覆盖bank/field，完整组合矩阵归8/10。

**Cost Card（理论，不是benchmark）。** K=patch、U=updates、H=internal half像素、C=cascades、T=spatial taps、J=lookup taps、N=source capacity、S=field segments：

- ADD scratch 4K validity+(64+4K) control及独立range alignment。A1=48K、A0+A2=96K/bank、112H/role双history沿原allocation；无新增output-resolution资源。invalidation=256N+1040B，共享snapshot租约并存按原owner计真实bytes。
- filter为6+S dispatch、7固定PSO，各96B transient参数；invalidation1 dispatch/48B参数。quality/taps/hysteresis runtime，无组合PSO。
- integrate≤64U raw读取；qualify/post/touch按K扫描，尚非active-count indirect。A1完整48K写/post读；field112H写、anchor128H读。map探测保守上界C·[K(2T+1)·spatial+H(2J+3)]，不含cache/query/estimate。每有效field tap至多一次touch atomicMax，post每patch最多3次scale atomicMax。
- disabled零owner工作；enabled静态仍付bank copy/K扫描/H写域；expected按有效tap/coarse支持，worst全dirty仍受U分批预算约束，包含全部探测/N-source比较/overflow域失效。未为降dispatch删必要同步。
- 1080p/1440p/4K scale1单field=55.37/98.44/221.48MiB，双history=110.74/196.88/442.97MiB；scale0.667近似乘0.444889、odd按ceil。8的最多三份directory、128H anchor及query/VT/VSM/retiring另计，4GB无全效果承诺。
- Turing/Chrome155小fixture约0.1ms（K16/H12），只证明可执行，不外推真实分辨率吞吐。整场景资源峰值/粗成本归8/10。

**实际验证。** build（含tsc noEmit）及新鲜build:test通过；保留既有Basis/KTX externalize警告。三个相关CPU文件scgi-filter/scgi/scgi-estimator共18/18通过，含独立half量化/旋转/HDR与既有事务/替换/异步错误。

真实GPU scgi-filter通过四组合constant/count饱和/失败保旧/abort-retry/24帧关灯响应、zero variance/1e30 HDR/missing支持、双薄面/跨实例拒绝/相容邻居混合、SH方向、独立mean2/variance1、local dirty/cascade-scroll/post重启/radius reset/seed→real、实际cache defrag+A2身份/slot重用、NaN fault、center-miss邻域、geometry revision域外衰减。真实GpuScene变化验old/new union+guard、移除、abort-retry、40区域overflow；强制64KiB binding三段/1089half完整写及背景。

scgi-estimator验证真实query/Native/LightDatabase/PhysicalEnvironment→filter/A0；scgi-anchor-publication验证真实field→scene/frame/Product/material anchor→下一帧seed，以及late mutation/abort/retry/身份/材质revision拒绝。迁移scgi-anchor通过原运动/身份/分段seed；scgi-cache通过原allocator/scroll/defrag/公平更新，未恢复旧表示。

日志保留于.local/scgi7-reference：filter-final-05、estimator-final、anchor-publication-final、anchor-01、cache-final、contract-final。原失败保留：dirty fixture缺handle；estimator运行中源码改变被stale-build拒绝；normalized half旧绝对误差断言不成立，按独立CPU格式推导0.0025·L0界迁移。center-miss发现位置/方向随机维度相关导致漏采，改独立cone维度后通过，未跳断言。

**来源/边界。** 固定Unity revision/UCL与入口见source map，仅Reference，本地WGSL不复制/逐行翻译。完整Cornell/门打开/移动emissive画面、高spp图像、Native融合、目录stripe+halo、Renderer组合生命周期/峰值与正式P50/P95尚未运行，明确归8/10，不由buffer数值推断。下一单元SCGI-8，本轮停止。

### 7.14 SCGI-8：基础GI生产接线与旧owner退休（2026-10-17）

**结论与范围。** 在`64e4b7cb`基础上完成本单元静态/刚体opaque+MASK范围：公开Renderer→共享Product/query/material→cache/estimator/filter→field→全部Native route实际运行。默认`surfaceCacheGi.enabled=false`，启用后仅一套SCGI生产ownership；没有旧GI运行时选择器。SCGI-9近场增强与SCGI-10整链资格未完成，本节不关闭整个模块。skin/morph仍随共享动画模块建设。

**producer→产品→直接consumer复核。**

| 位置 | 本轮真实落点 |
|---|---|
| 配置/组合 | `SurfaceCacheGiSettings`校验容量/质量，balanced/quality与debug公开导出；`ScgiRenderer`组合既有真实owner，不另建scene/material数据库或Renderer。Bistro `?gi=1`/`?gi=quality`、UI直接控制生产设置 |
| FrameProgram | request/stage/compound fact/key与Bindings/Lowering原子接线；GI在Surface前，query、previous history、candidate world、scratch/anchors/rays/transport、field与Native directory全部晚绑定并声明宏访问；SSSR/Sky/Aerial/Temporal保留原依赖 |
| Native物理消费 | 同一112B field解压、四tap guide/精确同帧实例校验、解压后世界SH线性插值、真实shaded normal评价。`mix(Environment*AO, GI,c)`后材质occlusion仅一次；coat/metallic/unlit沿原响应，direct/specular/Le独立；lighting-change发布到既有Temporal response |
| 目录/容量 | `FinalPixelLightingRanges`16→96B；全量、stripe+halo、旧目录近满时独立Native窗口的完整local/VSM gather。每receiver保留fine+六coarse keyed descriptor，不截页/tap/灯；solar/noise单列offset。GPU一次window×bin partition，窗口依次copy/gather→全部bins→下窗，不逐stripe重扫全屏 |
| 共享Truth | query lease复用Product页/decoder、GpuScene实例及Native材质；已有geometry streaming服务query page请求；GPU工作集反馈串行进入后续cut，当前帧不读回决定dispatch。缺页以unknown certificate接纳，不能伪造环境miss；query publication serial单独驱动cut换代的filter epoch |
| 准备/更新 | GI借Renderer同一个open command异步准备；camera变化取消旧view，settings/resize/teardown先解开generator的abort路径。纯light/environment数值变化刷新estimator，不重建同资源PSO/query batch；物理资源/query变化才重建候选。该事实不代表所有动态query重建已经零PSO冷成本 |
| commit/abort/退休 | 未提交abort不推进active/history/query；GpuScene正式revision在其publication完成后捕获。提交后observer异常不可回滚，保留目录/estimator/invalidation至device loss隔离；成功fence也不误释放poison资源。disable、empty scene、replacement按最后consumer退休；recovery转移一次共享Product恢复源并重放GI设置 |
| 唯一所有权/删除 | 删除long_range_diffuse_provider、screen_space_diffuse_resolve、GPULightProbeVolume/Atlas/Record、Scene probe/accessor，以及无consumer的GeometryBlasPool/TLAS；删除仅旧probe使用的Delaunay/TetrahedralMesh。DynamicBvh→niMeshlets保留，retired guard同步；删除的惰性代码不虚报稳态显存收益 |

**集成中发现并修正的实际问题。** Surface settings缺少COPY_SRC导致gather读取非法；GpuScene提交observer次序导致刚提交snapshot立即误判stale；device loss后Product CPU恢复源被GPU abandoned状态错误阻断；query准备中取消需要先abort原command；目录/estimator/invalidation的observer-fault隔离不得因随后成功fence而解除；cut换代不能只使用GpuScene revision。另修正TextureResidency sampled admission误计7个provider为真实6个（Visibility+三IBL+VSM depth+AO），否则原来合法满16 sampled custom材质会被GI误拒。VSM noise生成器显式接受offset：Native用ranges，独立VSM用自身constants，算法不分叉。

**成本卡：理论分配模型，不是benchmark。** 以下为当前balanced默认R16/C3/K16384/U64/Q4096/B512/batch64、256B对齐/128MiB binding，half extent为internal的一半；不使用output extent分配昂贵field。包含双world、双field与私有scratch/batch/anchor，不含query AS、estimator/invalidation额外arena、shared geometry/VT、VSM、SSSR、Temporal、retiring和driver。

| internal extent | 双world MiB | 双field/history MiB | 单anchor MiB | 私有scratch/batch/anchor MiB | runtime合计 MiB | 单目录 MiB | 目录最多3槽 MiB | Native窗口数 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1920×1080 | 13.235 | 110.742 | 63.281 | 72.580 | 196.557 | 58.377 | 175.132 | 1 |
| 2560×1440 | 13.235 | 196.875 | 112.500 | 121.799 | 331.909 | 101.729 | 305.188 | 1 |
| 3840×2160 | 13.235 | 442.969 | 253.125 | 262.424 | 718.628 | 127.994 | 383.982 | 2，1200 full rows/窗 |

目录假设完整32×32屏幕tile×24 depth slices×8B lookup、98688×16B VSM descriptors、131072B solar与1050624B noise；真实容量以planner及协商limits为准。最多3槽是上界、不是强制同时分配；remap时还需原producer目录与Native窗口同时在场。窗口额外含halo，remap增量约`148·windowPixels +112·windowHalfPixels +fixed solar/noise +alignment`，148B为8B lookup与7×20B keyed descriptor。完整field copy的最低payload为55.371/98.438/221.484MiB每帧，含world copy的最低读+写总流量约123.977/210.110/456.204MiB每帧，尚未加halo、clear、anchors、query、filter、Native读取和remap。不能把少一张纹理写成总体提速。

Native最多四次112B逻辑field读、四次Visibility/work验证与guide/SH数学，实际缓存带宽未测。0/50/100%有效覆盖仍保留全域field/history/anchor分配与完整copy；只有真实patch/update/query间接工作随需求变化，不宣称空覆盖零成本。partition最多两dispatch/帧，Native编码随`Nwindow×Nbin`增长；remap每窗一次gather，field row copy随窗口/分片增长，没有每material instance dispatch或额外frame submit。极端大场景仍受完整query working-set admission约束，不强行截几何。

4K仅runtime+三目录槽已约1102.61MiB，其他owner和retiring另算。4GB不作大场景承诺，应显式降低internal scale/工作集、关闭可选效果；8GB/12GB也以完整组合实际峰值准入。`ScgiRenderer.cost.currentOwnedBytes`只计当前runtime/query/estimator/invalidation，明确不等于峰值或全Renderer显存。

**本轮验证。**

- 完整`npm --prefix OEngine run build`（typecheck/Vite/declarations）、新鲜`build:test`通过；Bistro typecheck通过。保留已有Basis/KTX的`node:module` externalize警告。
- focused CPU四文件`scgi-native/final-pixel-phase1/frame-program/scgi`：37/37通过；覆盖目录准入/完整分段copy、window×bin分配、GI设置与既有事务合同。
- `scgi-production`真实硬件通过，Windows Chrome155/NVIDIA Turing；fixture实际设备协商16 SSBO、16 sampled、4 groups、128MiB storage binding、256MiB buffer。公开Renderer上传真实cooked Product、Standard/Clearcoat/Unlit/custom、VT+MASK与PhysicalSky/VSM，65×49奇数尺寸得到775个有效正irradiance field样本。完整目录、7 stripe、2 remap窗口同field/camera的HDR逐值相等；强制fine失效并保留实际coarse页，在point/gather2x2/disk4三模式下full/remap仍逐值相等。
- 最满custom材质含8 resident banks+2 VT sampled，实际Product+VT+compact+SSSR route为16 storage/16 sampled/4 groups。AO×GI×SSSR、Native与FSR3 scale .73、scale1 bypass均运行；真实4K internal/128MiB产生两field分片并使用Native stripe。4K案例关闭SSSR以遵守它已有独立active-memory上限，完整组合在较小extent验证，不宣称4K全效果已通过。
- camera移动、light数值修改复用estimator、刚体变换和HDR emissive(10000/3000/1000)修改换代query、pre-submit abort/retry、enable/disable、debug、scene→empty→original→alternate、pending resize cancellation、post-submit通知抛错/poison资源保留、真实device loss/recovery均通过。40个局部灯、强制index/task容量1，readback确认完整DIRECT overflow模式。GPU/scoped/page errors为空；返回frames=5是recovery后新Renderer帧数，不是总测试帧数。
- 受影响VSM独立`vsm-filter`通过388配置/595968比较/64相位，验证reverse-Z、非恒定depth、slot gutters、point/gather/disk；`vsm-sampling-publication`通过fine/coarse/missing/stale/dirty/outside与f32跨页边界。局部`scgi-transaction`在最终构建上通过18种ABI、64条Native route、observer fault/async validation、分片与loss；最终生产oracle另验证实际宿主生命周期。

最终GPU源码SHA256 `f1b6a1abeb6e4f746645a436e2d02c6b90d2639d969cb56f8864dcb84dcb781a`，输出`541759a6d4178400b72695fe417887dc09dc29a0871880ffac82a98bbbf67292`。原始结果保留`.local/scgi8-production-exposure-final.json`、`scgi8-vsm-filter-final.json`、`scgi8-vsm-publication-final.json`；build/contract日志同前缀。它们是本地可追溯记录，不升级为正式evidence/claims。

**失败保留与未运行项。** 同前缀initial/second/window等失败未覆盖删除：包含上述真实生产错误、WGSL保留字，以及fixture的noise URL、mip链、half解码、冷启动confidence、非法bypass unequal extent、未协商受限device等准备问题；4K SSSR已有容量拒绝未放宽。修复后仅重跑受影响验证，不以最终通过改写原失败。可选texture物理route未实现，设计明确其不属基础正确性前置；packed目录覆盖满绑定设备。没有运行全仓回归、全场景长序列、跨浏览器/多GPU、Cornell/门打开/移动发光体高spp图像比较或正式P50/P95；这些整链画质/成本资格仍属SCGI-10，当前通过不等于AAA画质认证。后续phase不因本轮未做完整benchmark而阻塞，但不得隐藏实际4K带宽/内存税。

**来源与停止边界。** Source map已记录所选RadeonRays机制的生产Adapt与Local integration；Unity仍仅Reference，绝非整SDK直接接WebGPU。停在SCGI-9，不自动实施near-field source/probes/residual。

最终补充检查：同field/camera经remap的pre-exposure=2与0.25，相对原HDR的half精度缩放逐值一致；GI history不含曝光值。共享solar oracle适配当前96B ranges后4145 samples通过，原131072B half LUT publication字节不变、写域互不重叠，CPU最大差约5.96e-8。最终`scgi-transaction`使用同一fresh build通过，原始结果`.local/scgi8-transaction-final.json`/`scgi8-solar-final.json`。文档检查0 findings/66 historical warnings，`git diff --check`通过。未运行项仍按本节边界，不把局部曝光比对提升为整Renderer自动曝光/色调映射资格。

### 7.15 SCGI-9：独立近场残差、专用场景与实际检查

**实现边界。** `ScgiGather`是既有SCGI的可选owner，借用同一query scene、GeometryProduct解码、Native材质、实例身份与VT feedback。没有独立SSGI renderer、第二套几何或生产额外submit/readback。FrameProgram显式声明Surface后的gather和下一帧pre-Surface历史消费；Lowering记录previous probe/residual、current reprojected residual及next compound产品。GI默认和gather默认仍关闭；关闭gather退休私有资源，world GI保留。

**实际物理闭包。**

- half anchor的exact sourcePixel经过Visibility→meshlet work→instance/material bin，复用`ScgiQueryHitWork` count/prefix/scatter和indirect逐bin执行Native C/X/Y材质投影，不逐bin扫描全屏。与主Native共享geometry input函数，camera graph输入与VT语义保持一致。
- 源为未曝光Rec.709 RGBA32F：Le + diffuse BRDF × underlayer ×（带visibility/PDF的direct + occlusion × world-only irradiance）。全部directional/physical sun和抽样local均走同query shadow，金属没有specular混入；不会读取最终HDR、sky、aerial、旧residual或SSSR history。
- tile spawn/disocclusion、history lookup、hemioctahedral方向及显式solid-angle PDF、完整triangle query、精确lineage/asset/meshlet/primitive与plane验证、fill、signed SH project、variance/count/history和edge-aware interpolate全部执行。方向为batch复用f32 scratch；按固定N积分，missing coverage=零修正。world field零confidence不用于生成预测probe；负prediction不clamp。
- probe每role160B，双role；signed residual双role32B/H，与同代world field guide/identity配对。pre-Surface重投影读取previous residual+previous world guide，检查完整identity、depth/normal、双plane，写当前32B/H；Native经原lighting directory追加段消费，不增加绑定。lighting ranges由96B增到112B。合成保持`max(0,Eworld_raw+confidence*δE)`，不能单独clamp负残差。
- commit推进角色，abort保留角色；encode后abort/retry、冻结、光照/实例revision拒绝、disable/re-enable、奇数resize、FSR3低internal与device loss/recovery已实际运行。退休等待query与最后consumer fence；constructor部分分配失败清理，异步失败隔离到device epoch。world缓存与field在gather编码前后逐字节相同，不存在seed/multibounce残差回灌。

**独立验证与观察。** Windows Chrome155 / NVIDIA Turing硬件，16 SSBO、4 groups、128MiB binding、256MiB buffer；浏览器返回空device description，不能据此写具体显卡型号。以下为局部真实GPU结果，不是正式全Renderer benchmark。

1. `scgi-gather`公开Renderer专用房间：红绿墙、白盒接触、薄隔板、纯金属对照、独立移动发光片和point light。160×120主oracle、320×240交互截图；均上传真实cooked Product。最终小场景292有效probe、285有接收样本、4139有效重投影half residual、1602负SH系数；负数是signed correction的合法结果。
2. GPU实际Gram helper对18组旋转法线/常量/HDR（最高1e8）最大相对误差`8.624e-7`。独立262144样本角域积分对照实际project kernel：8192方向合并的L0约3.3226，对照3.3410；Z约5.0025，对照5.0152。保留1/4覆盖得到约0.83538/1.25345，没有accepted-count放大。另测normal/support倾斜的非零误差，不能套常量证明；真实interpolate kernel拒绝不相容normal、plane、identity，负HDR -1e8压缩解码约-99942400，符合half误差。
3. 4800个source texel用独立解析盒体visibility、point衰减和公开world field核对，含48个遮挡、4679个照亮、71个纯金属、27个发光片；最终最大绝对差`1.521e-7`。该参考明确借用world field，仅独立验证source公式/visibility，不冒充独立multi-bounce真值。
4. 32个接收probe、每个8192样本的解析盒体visibility + published diffuse source参考，配对近场L1目标：无修正RMSE `0.10402`，加置信度残差 `0.08236`，约20.8%下降。这是当前随机相位/有限点集的测量，不是全房间path tracing/SSIM，不外推为任意场景画质改善。窄亮源与不同support的L1模型误差仍存在。
5. 同一production Native frame全目录、15 stripe、80 remap窗口HDR逐字节相同。单独`scgi-gather-materials`复用SCGI-8真实材质场景的相关slice：Standard/Unlit/Clearcoat/custom、VT+MASK、PhysicalSun/VSM、AO×GI×SSSR、16 storage/16 sampled、Native/FSR3/bypass、full/stripe/remap和曝光缩放通过。它明确止于原4K/故障矩阵之前；本轮专用场景另覆盖abort/freeze/moving emitter/recovery，不为了重复SCGI-8跑整套4K全组合。

**专用调试与截图。** `node tools/scgi-lab.mjs`打开可交互房间；`--capture`保存在`.local/scgi9-captures/`，包括final、appearance-world-only、world-only irradiance、combined irradiance、signed residual（红正蓝负）、confidence和diffuse source。每张伴随JSON参数/计数/成本。截图序列诊断性固定同一world field/residual并关闭颜色AA，避免将world更新/Temporal变化当成gather增益；这些copy/readback仅存在测试宿主，生产没有依赖。当前320×240截图实际已逐张查看：局部修正偏弱，final/world-only肉眼差异小，基础world GI存在明显低采样斑块。PNG显示域MAE约0.370/255、最大差12/255；该数值只说明变化幅度，不代表质量得分。**不宣称AAA画质达标**；SCGI-10必须继续全场景画面/动态响应与成本检查。

**成本卡，ADD而非提速声明。** 新增`320Np +112H +32·Bdirection` owner基本存储，另有两份query scratch、batch ray80B、source hit96B、query hit96B、source state16B、bin prefix/indirect及参数；不重复算借用world/geometry。目录最多另96H；设计§15.2更新1080p/1440p/4K的理论附加小计112.84/200.52/451.00MiB（含最多三目录残差，尚未含query与retiring）。4K stripe以实际窗口替换full目录项，不能把所有表机械相加。

320×240 lab实际gather owner 2,866,816B + query private169,508B；history1,612,800B，当前重投影614,400B，方向scratch32768B；1200 probes×64=76800方向，source19200 texel，单local阴影上界19200。正常未冻结编码dispatch上界5059（含完整query tail与bin槽），**不是GPU ms**。低memory需独立关闭gather或降低internal/tile/profile；1080p tile8全probe64方向约207万query，当前软件triangle transport不承诺实时。带宽包括source写16H、interpolate写32H、reproject读previous guide112H+residual32H/写32H、Native最多4 tap×新增32B及目录copy读写；随机triangle/material/VT访问另外计。0/50/100%覆盖仍付全域source/guide与probe槽调度税，当前仅hit/material通过GPU indirect缩减，不能说空覆盖零成本。未来优化可融合准备、减少query尾调度、调节probe更新，但不得删除完整visibility、固定N或事务。

**构建、失败与停止点。** `build`包含typecheck/Vite/declarations通过，fresh `build:test`通过；四个focused contract文件28/28通过。最终原始GPU结果`.local/scgi9-gpu-final.log`，材料矩阵`.local/scgi9-materials-final.log`，截图`.local/scgi9-capture-06.log`与同目录PNG/JSON；两份GPU测试source SHA `e9efb6b7fd30b8286487d9a3414a80d7f39189a4e31fc1cb49ad71a1898ead85`（随后仅补batch dispatch上限的host admission，未改受测GPU算法）。保留01～18及早期build/capture失败：WGSL保留字/非法常量、admission误算真实segment、fixture light默认1m、mesh transform字段和截图wrapper丢参数；已按根因修复、仅重跑相关检查。没有删除原失败或放宽断言。没有跑全仓回归、跨GPU/浏览器、全场景path-traced图像、正式P50/P95和claims。上述未获资格不等于生产算法缺机制；当前局部功能验收闭合，停在SCGI-10，不自动跨单元。

## 8. 2026-10-18执行架构重构依据与实施边界

§7为原始实施快照，包含当时停止点、参数及曾运行的更高尺寸测试，不构成本轮重复要求。最新状态只读本文开头和§1；本轮设计批准不提升任何新代码adoption或性能资格。

### 8.1 源码与实验屋失败快照

源码基线`2f276576`。`ScgiRenderer`/query scene把当前实例拆成39个query shards；实验屋共39实例、1324三角形（37个box与2个UV sphere）、一个cooked Product。`scgi_query_geometry::query_triangle`对候选做cluster prefix查找、directory/page/meshlet/index/position解码；不是每个opaque候选都完整求值UV/normal/diffuse material。`shade_hit`恢复最终hit属性，并不再次遍历BVH。`ScgiEstimator.encode`按sample/directional重复query；`ScgiGather`先做全half源材质/灯光阶段，再做probe查询，尚无本轮request-first共享。

固定快照：1920×1080、internalScale1，main视角、sun preset、门/百叶打开、静止，physical sun=3、sky=0.15、point=0、emission=0；world R8/C3/K4096/U128、hemi8/connect2/lightPool32、batch128、multiBounce/spatial/post开启、spatial/lookup taps8；gather tile12/directions16/batch65536/distance3、freeze=false/debug=off。设备为Chrome155/NVIDIA Turing硬件、16 SSBO，浏览器未给精确GPU型号，不写成特定显卡。原始诊断来自本地实验屋捕获（非受版本管理的资格artifact）；这里保留关键数值和条件，后续必须新鲜测量，不能只靠不可用的本地文件证明。

| 观测 | 同次已采样GPU frame 8（host frame 9读取） |
|---|---:|
| command span | 316.952896ms |
| gather-source / gather-probes | 180.578336 / 50.132128ms |
| estimator | 49.584352ms |
| anchors-cache / filter / gather-reproject | 3.174176 / 2.992128 / 2.015232ms |
| Native / VSM / Temporal | 13.563904 / 9.027936 / 4.009984ms |
| CPU graph-execute | 30.48ms；不与GPU span直接相加 |
| encoded dispatch / compute pass | 13009 / 12968 |
| clearBuffer / copyBuffer | 5163 / 7000次 |
| clear / copy声明范围 | 3,630,104,540 / 76,372,380B；非实际DRAM流量 |

这是静态启动后的单次诊断样本，含timestamp观测开销，不是长窗口P50/P95、统一收敛状态benchmark或AAA画质资格。后续world-only采样GPU frame12为76.649664ms，off采样frame16为18.104128ms；frame/cache状态不同，不能直接作严格因果减法，host切换时还可能读到上一mode的timestamp，必须按sampled frame识别。原失败保留，不改写成性能通过。

### 8.2 工作量推导与选择理由

`H=518400`，`Np=14400`，`Q=230400`。旧source组织上界为两次H级灯光phase（即使local为0仍有其capacity/编码），再加Q：`Q+2H=1267200`；乘39shards为49,420,800 lane/shard理论域，**不是实测独立ray数或完整遍历次数**。当前Gather20次query（16shadow、4closest），tail静态89quanta、shadow/closest分别308/352 dispatch上界；仅continuation清零模型`20×39×65536×64=3120MiB`，compact上界116,654,080 lane invocations，均为源码推导，不冒充GPU硬件counter。

因此选择三项结构性重构，而非先调nodeQuantum、微调WGSL、缩scale或砍方向。R1打掉asset×batch×quantum税，代价为最小派生位置存储与新的arena/routing；R2消除per-sample整scene调度，代价为样本队列和跨窗口reduce；R3消除无人消费源的graph/visibility重复，代价为请求去重、Native接口与pre/post映射。保留cache/A0/A1/A2/rank、query cut、完整MASK/custom/VT、物理零固定N、世界only seed/multi-bounce和signed residual数学，不重新移植一个独立renderer。多Program/跨arena/深alpha仍有真实成本，不能宣称三个单元保证所有场景达到某FPS。

### 8.3 当前交付与后续顺序

文档批准时只更新设计/执行与source map；该时点未实施R1/R2/R3，未运行新的GPU/画面测试或性能benchmark。随后R1/R2/R3分别按§8.4/8.5/8.6落地。三个单元按§3构建各自完整闭包，单元末集中必要验证；SCGI-10再集中同条件画面、动态响应、整链故障/容量/成本。用户没有授权降实验屋分辨率/方向/几何质量；自适应方向、HZB近似、粗query proxy、wide BVH等按设计§20.4另行判断，不作为本轮效果缩水或无限增加施工步骤的理由。

### 8.4 SCGI-R1：共享求交场景与完整执行切换（2026-10-18）

**生产闭包。** `ScgiQueryGeometry`从已发布Product cut生成精确f32 `p0/p1/p2`与source引用；`ScgiQueryBlas`按原内容/cut键共享位置payload与BLAS；`ScgiQueryArena`将多个Product的加速节点和payload打包到有限storage binding，GPU从完整实例快照分类、prefix/scatter构建scene TLAS。一个实例在一个route只占一个TLAS leaf；它的多个BLAS chunk在该leaf内完整处理，移除了“全场实例数×最大资产chunk数”的容量乘法。opaque是每arena一个scene route；MASK按Native coverage Program及物理source segment分域，GPU筛出真正匹配的实例。CPU仍预编码有限Program×物理segment槽，空槽的query工作为零，不宣称WebGPU会动态生成命令。

`ScgiQueryRayCount`先验证GPU dense-prefix或使用固定capacity，再只初始化有效result与命中validity；count=0不碰inactive记录，overflow把整个capacity写fault，不clamp。域/缺页/unsupported/numeric资格在路由之前确定，所以没有相交TLAS的ray也不能被错误宣布为物理miss。`ScgiQueryRouteWork`复用一个4B/ray列表，工作组prefix批量预留，保守测试完整route TLAS root后发间接命令；该route遍历结束才复用列表。没有ray×asset或ray×arena常驻矩阵。

`scgi_query_scene`在单invocation内完成parent近远序TLAS→BLAS搜索，保留world t、negative/nonuniform affine、castsShadow/mask、完整Native MASK、域unknown与cycle/range fault；没有alpha层数或quantum尾链。equal-t按本次不可变scene的原始slot及完整cut traversal primitive ordinal排序，consumer的跨cut身份仍使用Product/generation/meshlet/local/source primitive，不能把ordinal当history identity。跨arena全部merge后才resolve；occlusion在合法accepted hit后结束。最终material hit只按实际Native bin求值，bin内部采用工作组排序/批量全局预留，容量为所有accepted rays之和，不乘材质数。

三个产品已同时接通：occlusion/status；96B geometry closest（位置、flat normal、origin error及精确source身份，不求diffuse）；原64/96B Native material closest。Gather probe改用geometry closest，保留MASK完整资格；estimator、source shadow与probe shadow使用同一scene/query owner。accepted输出的validity每次初始化，未被任何合法source/bin写出的命中变unknown，不能消费上一批的material bytes。

**ABI与资源。** 派生payload仍为48B/T，以三个`vec4u`保存位置的原f32位；+12保存`localPrimitive+1`（0=invalid），+28保存asset-local meshlet，+44保存source primitive；Product/generation/asset及source范围在96B descriptor。选择p0/p1/p2而非预先算边，再恢复顶点，是为保持与原decoder的f32顶点一致，不是有损降级。48T之外，当前仍保留原共享BLAS/payload和packed副本，两者全部入账；没有复制UV/normal/index/material。packed静态buffer有独立引用计数，已提交且内容/descriptor完全一致的刚体publication直接共享，不重复copy。TLAS为独立candidate，只有旧source已登记本command的资源使用时才复制旧topology并GPU决定unchanged/refit/rebuild；否则完整build。abort不改active，失败poison，最终consumer fence后释放。

budget包括builder两套512-slot uniform/storage参数、indirect、scratch、metadata、source/lineage、affine/bounds、原静态AS、packed arena和每route TLAS/settings；arena在分配前核对剩余预算，source/单buffer/dispatch容量也先检查。`ResourceAccounting`分别登记真实buffer，原BLAS与位置不再合成一个虚假buffer记录。`queryMaximumBytes`是单publication准入，不能当全Renderer峰值；active/new/retiring和共享资源的实际峰值仍需SCGI-10核验。

实际pipeline布局如下，uniform/group另按真实layout验证；`ScgiQueryTraversal.descriptors`和GPU满绑定用例为依据，删除了没有production consumer的旧固定query descriptor planner。

| query phase | storage buffer | 原Product banks / Native资源 |
|---|---:|---|
| opaque closest / occlusion + spatial work | 7 | 不绑定属性页和Native纹理 |
| geometry closest输出 | 7 | 从派生payload取位置/身份，不运行material |
| 完整MASK traversal + spatial work | 14，加程序真实资源 | 原directory+四bank、完整coverage常量/纹理/采样器 |
| Native accepted material | 15；VT为16 | 原directory+四bank、真实Program/常量/全部纹理；VT反馈不删 |
| route compaction / hit compaction | 4 / 5 | 分离indirect副本，避免同pass storage/indirect冲突 |

仅显式`diagnostics`查询分配route counters并启用node/triangle/coverage计数；默认生产不加每ray诊断atomics或无人消费的统计buffer。统计overflow有显式标志。诊断读回只观察已完成工作，不控制当前帧。

**Cost Card。**

- ADD：派生payload48T及当前packed副本；每descriptor96B与对齐；每arena一次scene build scratch/builder、每coverage/source route一次TLAS；每batch一个`32+4Q`空间列表、32B indirect、96B GPU count/indirect；material bin队列为`4Q+bin headers+scan`，不是`Q×Nbin`。debug另加32B/route。current BLAS仍沿用`primitiveCapacity`的padded layout；各route TLAS按完整source slot容量预留，GPU只发布实际leaf count，因此容量上界为`Nslot×Nroute`，不冒充按实际leaf精确分配。多Program/物理segment会增加这项保守储备，整体在创建前受publication预算约束；后续GPU forest packing可收紧储备，不需要改变上层query产品。碎片和packed副本不能藏掉；实验屋query publication实测声明分配约48.46MB，尚有进一步收紧存储的空间。
- REMOVE：生产`GeometryQueryInstances`的per-asset TLAS、`ScgiQueryTailWork`、wavefront/K轮/quantum参数、64B/ray continuation ABI/分配、per-shard全容量clear及其旧绑定。原batch112B/ray（48+32+32）代替176B/ray；65536容量的continuation本身移除4MiB，私有routing/material scratch另计，不能把它当净显存收益。
- 执行：设query物理routes为R、accepted Program/source stages为M，material bin scan有L层。非空material batch上界`2+3R+M+(3+2L)+1`次dispatch；occlusion为`2+3R+1`。2是count+有效写域初始化，3R是route compact/finalize/完整traversal；空indirect命令仍计CPU编码。geometry不含material bin scan。R由真实有限arena/Program/source banks决定，不由资产数直接相乘。
- 0/50/100%有效空间覆盖时，route prepare仍读取active rays与result边界；列表写与traversal随routed数变化。100%覆盖不靠空间路由净赚钱，仍支付它的prefix/列表税；本重构的主要结构收益是移除asset×batch×quantum重复遍历和clear。MASK每个真实候选仍有完整属性/graph成本，深alpha长invocation没有被宣称免费。hit-work排序有barrier/ALU税，cold build与多Program/arena也不承诺固定ms。

**必要验证。**

- 新鲜`build:test`编译通过；SCGI contract 13项通过，含ABI、capacity及既有事务/退休；`npm run typecheck:scgi --prefix examples`通过，不跑全仓回归。`docs-verify`为0 finding、66条既有historical warnings，`git diff --check`通过。
- `scgi-query`真实GPU：137条独立double-precision brute-force rays、81层被拒绝MASK、closest/occlusion/geometry-only、camera-dependent Native graph、负/非均匀变换、numeric/domain unknown、count=0不改inactive、overflow全batch fault、GPU unchanged/refit/membership rebuild、abort/retry、原静态BLAS及packed arena复用。两个Product、两个真实arena owner验证全局closest和等t实例；小fixture显式分成两个物理owner验证边界，未为触发硬件上限分配数百MiB。
- `scgi-query-cut`通过GPU域需求/延迟streaming、精确cut、远页不驻留、teleport unknown、旧cut页撤销后存活、failed replacement与abort/retry；空scene consumer迁移到新arena/count写域。
- `scgi-query-vt`通过实际query-only反馈、coarse→fine换代及完整Native图；满绑定为16 SSBO/16 sampled/8 samplers，独立期望0.1048550213，GPU 0.1048550233。未减少texture输入来凑layout。
- 删除旧quantum-only入口及其表示测试；保留page lease/BVH builder等未退休语义。Native multi-Product oracle的直接调用已迁到新API；本轮不重跑整个Native Renderer矩阵，当前主链由真实实验屋检查，完整矩阵归SCGI-10。

真实GPU与实验屋结果保留在`.local/scgi-r1-query-final.json`、`scgi-r1-query-05.json`、`scgi-r1-cut-01.json`、`scgi-r1-vt-02.json`和`scgi-r1-lab-final-1080.json/png`；本地结果不是正式claim/evidence。GPU/query最终编译source SHA256 `4231e3aadc1d9835de5ddf48901c0b857c81ba6079d61e946f4a83e94ab77b86`。VT/cut在同GPU算法版本上验证，最后只移除无消费者uniform/默认诊断分配及旧planner，并由最终query再次验证新host接线。早期`scgi-r1-query-04.json`为fresh-build检查拒绝的harness-error，未进入GPU；中间编译暴露的旧`queryShards`字段引用已改为`queryArenas`，没有为它恢复旧接口。

**1080p接线与剩余成本。** 实验屋使用§8.1相同默认几何、相机、sun/sky、R8/C3/K4096/U128、hemi8/connect2/pool32/batch128、Gather tile12/directions16/batch65536、1920×1080/internal1。保留原316.95ms失败记录；本轮最终采样与限制记录如下表。原画面、冷暖收敛和GPU采样模式会影响时间，不能据单帧给稳定倍速/P50/P95结论。图像已打开检查，画面仍有暗区与噪声，未获得AAA画质或充分收敛资格。

| 指标 | 原失败记录 | R1最终样本（host9读取GPU8） |
|---|---:|---:|
| scene query shards / arenas | 39 shards | 1 arena，仍保留39个源BLAS块 |
| encoded dispatch / compute pass | 13009 / 12968 | 641 / 600 |
| clearBuffer / 声明bytes | 5163 / 3,630,104,540 | 128 / 139,092,192 |
| copyBuffer / 声明bytes | 7000 / 76,372,380 | 1435 / 76,247,452 |
| CPU graph-execute | 30.48ms | 8.865ms |
| GPU command span | 316.952896ms | 73.583328ms |

首次接通另有74.525728ms、1473次copy、CPU graph7.875ms样本，保留在`scgi-r1-lab-1080.json`；最终清理移除了默认诊断buffer/copy及无consumer uniform，以上表最终样本为准。两次均为coarse frame-span采样，旧失败记录含更细阶段采样，GPU时间不能当严格同instrumentation倍速。clear/copy声明bytes不是DRAM流量；全域cache/history等未在R1消失。没有GPU/page error或device loss，没有修改主submit边界或降低分辨率/方向数。长窗口/多GPU/完整画质与组合故障仍归SCGI-10，R1不以“所有渲染成本已解决”关单。R2继续处理estimator逐sample整scene调用；R3继续处理全H源材质/灯光阶段。本轮没有提前实现两者。

### 8.5 SCGI-R2：批量样本transport与确定性归约（2026-10-18）

**生产切换。** 基线为R1提交`4d65b4f2`。`ScgiEstimator.encode`删除逐hemi/connection sample和逐directional整scene query循环，改为固定灯池窗口、扁平patch×hemi窗口、扁平patch×connection窗口。`window_count`读取GPU selected count，发布实际样本前缀和indirect；host只预编码容量窗口，不读回本帧count。`sample_index/sample_number`恢复patch和样本序号，RNG继续使用完整patch generation/identity与sample serial/epoch，压紧次序不参与随机种子。

灯表由light-page count→offset→稳定page/slot scatter形成，point在spot之前；保留原全部全局灯集合、5% uniform support、功率CDF及overflow/非法数值整publication失败。offset为有限页表的单invocation前缀，scatter每page独占输出区；增加两个dispatch与8B/page，避免原全局append顺序改变灯池proposal。超过容量时不允许多个overflow页覆盖同一区间。固定192B池不压紧no-hit，池seed继续由publication sampleSerial与lightingEpoch决定。无灯时query count为0，但全部池槽明确写physical no-hit。

每个path独占240B：原224B hit/result/identity/metadata，加16B radiance。hemisphere的Le、previous A0 continuation及environment先写独占radiance；shadow候选按path×directional编号，在有限B窗口中workgroup prefix、每组一次全局预约压紧query。shadow贡献独占16B/candidate，query槽到candidate映射4B；零贡献不进query，receivesShadow=false直接写候选贡献，未遮挡的合法query才写非零。非有限incident/贡献与unknown/fault继续使所属整patch cohort失败。query count超界仍由R1整batch fault，额外overflow标记使受影响window不发布。

`shadow_reduce`每path按directional顺序累加，`sample_reduce`每patch按sample顺序累加；两层都有明确dispatch依赖，不用float atomics或跨workgroup自旋。同patch跨窗口时cohort累加保留，窗口内不同patch不共写SH。原固定N、PDF/Jacobian、flat/shading normal比、coat、Le不乘albedo、casts/receives、endpoint完整identity/t/error验证、previous-only multi-bounce、unknown整cohort拒绝和serial/abort/fence/poison协议保留。SCGI-7 raw及统计消费者ABI未改变。control/cohort每encode清零；pool/path/shadow由实际生产者完整覆盖所消费域，不再清全estimator arena。没有独立submit、第二scene或旧调度桥。

**实际Cost Card与限制。** 设B为物理batch、U为updates、H/C为样本数、L为固定池、D为directional+physical sun、Ppage为point/spot页数。arena约`128+16·maximumLights+8Ppage+192L+260B+96U`，实际各range另对齐；260B包含path240、shadow16、map4。ray/result80B、Native hits96B、R1 query私有资源、12B indirect/64B defaults/8B black及command参数另计。相同B时新增36B/lane+8B/page，对照旧224B path；删除旧逐sample参数/调度和全arena clear，未新增U×spp永久数组。新增path读写、候选prefix的64×4B workgroup memory、barrier、shadow随机映射及reduce顺序访问明确付税。

令`P=ceil(L/B)`、`Wh=ceil(UH/B)`、`Wc=ceil(UC/B)`；host shadow窗口`S=floor(UH/B)·D+ceil((UH%B)·D/B)`。closest调用上界`P+Wh+Wc`，shadow调用上界S；local dispatch上界`7+3P+4Wh+4Wc+5S`，再加各query实际route/bin上界。GPU实际query prefix随selected及shadow非零资格变化；WebGPU仍编码空indirect命令，不将GPU零工作说成零CPU成本。0/50/100%有效shadow贡献均付候选检查/prefix/reduce，query与候选非零写随有效数变化；100%时压紧本身无省ray收益，主要靠跨sample合批摊薄固定税。小B下reduce/queue税可能比旧调度高，必须如实保留对照。

默认/balanced batch64→1024，quality128→2048；实验屋batch128→1024。它们只改变scratch窗口，U128/hemi8/connect2/pool32和Gather tile12/16方向/B65536均不变，输出/internal仍1920×1080/1。实验屋estimator private bytes：R1/B128为73112B，R2/B128为77976B，R2/B1024为479384B；扩批增量406272B（约0.387MiB）。query publication仍48460656B，原padded AS/packed副本没有在R2偷偷扣账。

**针对性验证。** 最终测试构建source SHA256 `62d900eff0f53b148f0ca998594547376435b4948010154113b392d762782c3d`；`scgi-estimator`+`scgi`两个contract文件17/17通过，示例typecheck通过。真实GPU最终结果`.local/scgi-r2-estimator-final-02.json`通过，覆盖原天空解析/面积积分、黑材质emission、点/聚光重连接/物理零、方向光/physical sun遮挡、深MASK、unknown整cohort、previous A0/候选污染隔离、完整灯集合与overflow、abort/retry/serial。没有重跑R1全材质/VT矩阵或全仓回归。

新增窗口独立性：512样本天空B4/7/1024逐位相同；3个真实selected patches、hemi19/connect5，B7/64跨patch边界raw逐位相同且每patch分母19/5完整；方向光B7/256/1024均110条有效shadow且raw逐位相同；两个方向光跨shadow窗口保全部能量、220条shadow、B7/1024相同。固定灯池/重连接用各自fresh runtime保持publication seed完全一致，B63/256/1024均54条重连接/54次accepted，raw逐位相同。这些是固定输入下结果，不外推所有设备f32逐位资格。

失败原件保留：`estimator-01`为WGSL保留字active，已改名；`03`为构建身份检查拒绝stale build，未进入GPU；`04`为fixture只重置patch serial而没重置灯池publication serial，改为fresh runtime输入；`05`为fixture错误调用无destroy的cache；`07`为fixture两请求落同cell、实际selected2，改为三个不同真实cell，不修改allocator或放宽3-patch断言。`02/06/08/final/final-02`成功记录均保留。首次公开场景capture遇Vite源码format热重载导致navigation，重跑前停止源码修改；没有吞GPU异常或添加production测试路径。

**1080p公开场景成本。** 每次独立启动，主相机/sun preset/9次提交，host9读GPU8；Chrome155/NVIDIA Turing，未暴露精确GPU型号。原R1与R2/B1024 coarse均两时间戳；另用显式`?timing=stage`记录阶段，`?batch=128`保留小窗口对照。阶段marker仅在显式采样时生效，不新增生产submit或per-ray诊断。以下均单次暖启动短序列，不是P50/P95或严格冻结相同cache的因果benchmark。

| 指标 | R1/B128 coarse | R2/B128 stage | R2/B1024 stage | R2/B1024 coarse |
|---|---:|---:|---:|---:|
| estimator encoded dispatch上界 | 225 | 270 | 65 | 65 |
| 整帧dispatch / compute pass | 641 / 600 | 686 / 645 | 481 / 440 | 481 / 440 |
| clearBuffer次 / 声明bytes | 128 / 139092192 | 129 / 139056736 | 106 / 139156352 | 106 / 139156352 |
| copyBuffer次 / 声明bytes | 1435 / 76247452 | 1497 / 76253416 | 1354 / 76243112 | 1354 / 76243112 |
| CPU graph-execute ms | 8.865 | 9.770 | 6.705 | 7.300 |
| GPU command span ms | 73.583328 | 75.631392 | 68.300960 | 68.285664 |
| estimator stage ms | 未测 | 7.151424 | 2.245056 | 未测 |
| Gather source stage ms | 未测 | 24.524800 | 24.059680 | 未测 |
| Gather probes阶段（含project/interpolate）ms | 未测 | 5.829728 | 5.775072 | 未测 |

B1024 stage另有VSM/shadow9.258944ms、Native13.105152ms、Temporal4.063232ms；SCGI filter区间5.230592ms还包含该宏阶段后续field/previous-residual准备，不能当单shader净成本。原始结果为`.local/scgi-r2-batch{128,1024}-stage-1080.json`及`scgi-r2-batch1024-coarse-1080.json/png`；默认截图已打开检查，仍有明显暗区与噪声，不能宣称最终画质合格。无GPU/page error或device loss，正常主frame submit=1。clear/copy是声明量非DRAM流量。R2小B确实增加dispatch，合批后才明显摊薄；R3未改造的全半屏source约24ms仍是最大SCGI阶段，不提前认定R3收益。当前完整帧约68ms仍不实时。

**关单与停止边界。** 全部旧逐sample生产调度已删除，consumer与生命周期闭合，固定N/样本/阴影能量和窗口独立性已由真实GPU验证；R2实现与必要局部验证关闭。R2已提交`b92bc907`，随后`c8711f19`合并远端同树文档提交，保留R1/R2内容。R3后续实施见§8.6；完整动态画质/故障/退休峰值/长窗口与跨设备仍归SCGI-10。

### 8.6 SCGI-R3：请求驱动Native源与visibility补缺（2026-10-18）

**实际切换。** 基于master `c8711f19`，删除`ScgiGather`的整H材质分类/source graph pipelines/独立source material work，不保留旧生产桥。pre在filter/world publication之后、Native之前执行previous residual重投影及spawn→geometry-only closest→screen验证/去重；post在Native之后补齐visibility、finalise source、fill→project→interpolate。probe方向、固定N/PDF、半球Gram、signed residual、距离window、previous-only world输入与t+1消费均不改变。默认实验屋仍1920×1080/internal1、tile12/16方向/Gather B65536，estimator B1024/U128/hemi8/connect2/pool32。

`scgi_gather::request`检查同帧lineage、Product group/meshlet/primitive、法线和双plane后保存方向mapping。GPU atomicOr bitset只给每half source一张ticket，RNG仍使用half source ID而非atomic ticket顺序。`ScgiGatherWork`集中定义offset/容量；lookup的8B是ticket与exact sourcePixel，两者均加1表示valid。world field可能尚未有效，不能借它的sourcePixel替代请求身份，否则会丢emission/direct。mapping为16Q、同帧lease保护的index/distance，不保存跨帧scratch或全Q×96B hits。容量C=min(H,Q)，work/texture/dispatch/counter上限在创建前协商，超界明确拒绝，不静默丢方向。

**Native/source能量。** 实际Native material invocation已拥有camera/derivatives/VT/shaded normal，exact请求像素写48B：diffuse×camera coat-underlayer/instance flags、Le+material-occlusion×diffuse×underlayer×exact world-only E/valid、mapped normal/sun visibility。未合入residual、specular、IBL fallback、HDR或exposure；world无效仅world项为零，emission/direct保留。Unlit共享实际base emission，不重编一份图。post把48B与immutable anchor拼到batch96B source scratch，再沿原灯池proposal/PDF做local与普通directional/physical sun贡献，不能复制主Surface全灯总和作为随机sample。unknown query使source无效；未请求区域source.w=0，debug紫色，与合法黑源不同。

VSM helper每invocation重置资格，只有实际fine/coarse查询通过且receiver reference depth在[0,1]才记录该太阳visibility；缺页/dirty/outside的neutral1不能复用。只有真实非零贡献且receivesShadow的缺失visibility进compact query；receivesShadow=false直接累加，合法太阳可复用。GPU source_count/shadow_count生成实际indirect，独立48B indirect buffer在phase间copy，避免writable storage与indirect同pass冲突。每phase一source最多一shadow lane，source_shadow唯一writer累加，跨phase有dispatch依赖，不用float atomics。

**逐route绑定与寿命。** 下列均为真实Native profile及production窗口，不新增第五张storage texture或额外source SSBO：

| route / profile | 输入与输出 / descriptor | 覆写前消费者 |
|---|---|---|
| full | group1 binding2既有lighting buffer改storage read_write；binding9 ranges128B。world112H、previous residual32H、request8H、preparation48H不相交 | 全部material bins结束后drain到GI紧凑48C |
| stripe | 同binding与200B/window half-pixel；每窗含完整halo及exact pixel请求，独占pixel写preparation | 本窗drain完成后再copy下一窗；halo不重复发布 |
| remap | 同binding与ranges；既有GPU local/VSM remap后，copy本窗world/residual/request，清preparation | 同command本窗drain，禁止保留目录引用 |
| 最满lit/custom+VT+compact+SSSR | 4 groups、16 SSBO、16 sampled；4 storage textures未增加 | 原Native/VT/SSSR消费者不变 |
| Unlit finalPixel | lighting组仅binding2 storage与binding9 uniform；混合场景照常发布请求源 | 无GI/light owner时绑定4B disabled directory+128B零ranges，计资源并随Surface fence释放 |

`FrameProgram`增加`gi-source-requests`和`gi-source-preparation`，Lowering显式GI写requests→Native读写preparation→Gather读，source不是HDR重建。Surface在窗口结束用本次`input.command`drain，不能抓住旧frame command。request/work是当帧scratch；残差/探针candidate只有postEncoded且成功提交才交换role；abort/retry/冻结/resize/disable/退休仍由原owner负责，不能partial commit source到world。没有新增生产submit或GPU→CPU→GPU决策。

**Cost Card。** work=`64+4ceil(H/32)+8H+52C+16Q+4B`，默认20141408B=19.2083MiB，另48B indirect。保留16H dense source供随机fill/debug；删旧source classification/material执行资源，实际Gather owner从83903104B变103781868B，增19878764B；query private524704B另计。目录从144B/H变200B/H，每full slot增29030400B=27.6855MiB；本次两live slots为213665024B，对照R2的155604192B增加58060832B。最多三slot额外约83.06MiB，不能只报bitset/mapping的4.456MiB下界。SCGI currentOwned从321561528B变341440292B；该值不含目录/借用资源/退休query，Renderer memory snapshot注册范围亦不完整，不用两表机械相加当驱动VRAM。

设S为unique请求、K为其真实非零需visibility贡献、v为已合格复用比例。每帧仍付work/source清零、Q geometry、request原子去重/随机mapping、Native request lookup、8B/window copy与48B/window clear、window drain扫描；实际48S写/读与post source工作随S变化，missing query随K(1-v)变化。0/50/100%请求分别为S=0/C÷2/C，post有效prefix随之变化，但CPU仍编码ceil(C/B)空indirect窗口；0/50/100% visibility复用分别需K/K÷2/0条补ray，不取消probe query与固定copy/clear。旧基线有H次第二遍graph与全H灯光准备，break-even是**被删graph/未请求灯光/合格visibility节省 > request+mapping+Native lookup+preparation+drain税**；S=C、v=0最坏仍保留完整材质/阴影，不保证所有场景提速。即使S=0也有新增存储/带宽固定税，不能说零请求零成本。Native不新增material graph求值，所有local/shadow仍依R1 exact query/coverage。dispatch上界显式含pre/post/source及query，另按实际window计drain；逻辑阶段不冒称物理零dispatch。copy/clear声明bytes不是DRAM流量。

**最终必要验证。** `npm run build:test --prefix OEngine`、`npm run typecheck --prefix OEngine`通过；`scgi-gather`/`scgi-native`/`frame-program`三个contract共22/22通过。GPU所用构建source SHA256 `6a97c649eb8c772a0836af56755ee3745eca79f7578f5b33e9c89536d1d08099`，output `0ab16f57103c94958bff8cb585bcf8554014d395761ae49de79fd25bc9519358`。最后review仅补全source clear全H dispatch的创建前limit检查，shader/默认场景工作不变；随后新鲜build:test与直接contract通过，最终编译source `d18ab8634a1bdad31e4d40b1857f18dbc4b0adf355dbae6735e32529b876c726`、output `4f1145512b19288e3c5c3485eb4b8b0c140686bc597ca96a44a210a540e60031`，不把先前GPU记录伪称此hash。GPU作业串行，未扫全仓或重跑无关4K矩阵。

- `scgi-gather-final-02.json`：2248 unique/5709 screen映射/2248实际写源；去重、未请求invalid与exact sourcePixel一致。39遮挡、2160可见、47金属、15发光源，独立box/light/world能量最大绝对误差8.503e−8；2186条missing query、无伪visibility复用。独立2×2不同材质GPU输入检查exact pixel2、coat0.5、occlusion0.25、sun0.375、invalid world保留emission及world/request字节不变。
- 相同最终Gather用例保留固定N/Gram/HDR/signed/project/interpolate数学；独立8192spp×32probe配对近场目标RMSE从world-only0.052015到Gather0.040950。它借真实published source做解析box visibility，**不是完整path tracing参考**。world bytes无回灌、freeze、abort/retry、lighting/moving-emitter失效、odd resize、disable/re-enable、device recovery与Native/FSR3检查通过；full/15stripe/80remap实际HDR字节一致。
- `scgi-r3-materials-final-04.json`：真实Standard/Unlit/clearcoat/custom camera graph、8 resident+2 VT、MASK、AO×GI×SSSR和满16/16 profile，Native/FSR3/bypass通过。为保证每材质都被测，fixture显式GPU输入请求所有825 valid anchors；这是测试输入，不是production fallback，自然请求另由上一用例覆盖。full/4stripe/2remap均825请求/825 preparation，未曝光prep在exposure×2/÷4和各route一致；实际fine/coarse及三filter mode有790 qualified/35 missing，790次实际复用；强制全缺页为0 qualified/790真实shadow/0复用。
- 材质场景加入0.035m薄隔板；封闭12m enclosure内97个内部receiver的精确box遮挡应为0，actual及coarse三模式的合格VSM最大/平均可见度误差均0。这里只证明该封闭输入，不能外推开放门边PCF与exact triangle等价；更完整动态门边/半影误差归SCGI-10。关闭GI后真正Unlit-only场景实际render通过，未依赖mixed lighting owner。

中间失败保留在`.local`：materials01暴露Unlit混入依赖LocalLightLookup的完整helper，改declarations-only；02的旧40KiB stripe fixture按真实200B/H改80KiB；04原小场景screen请求只命中外壳，新增显式全材质请求输入；06错用viewDirection domain，改为view；final新增Unlit用例误用不存在的base_color_factor，改真实diffuse_color；final-02被fresh-build拒绝（源码时序变更），无GPU通过声明。最终04通过。首次公开counter脚本import了另一Vite模块身份，捕获不到Renderer，改读取实际loaded engine模块URL；只改local诊断脚本。没有吞异常、放宽能量容差、减production覆盖或恢复旧owner。

引擎typecheck通过；额外尝试全examples typecheck失败在未改动旧demo的`debug/render_settings/indicate_view_change`等已退休API及已生成dist worker模块引用，未为R3恢复旧接口或修改无关demo。改用local临时tsconfig仅覆盖公开SCGI实验屋及其真实imports；该检查结果与全examples失败分别记录。`docs-verify`为0 findings/66 historical warnings，`git diff --check`通过。

**公开1080p与性能解释。** 相同sun/main camera、39 instances/1324 triangles、9次主submit、host9读GPU8；Chrome155/Turing，与R2相同参数。早期stage短样本整帧48.925600ms，对照R2/B1024 stage68.300960ms；source24.059680→1.377856ms，probe pre5.459968+post1.650624=7.110592ms（旧5.775072），Native13.105152→15.067136ms，estimator2.245056→2.553856ms。不能把source收益当总净收益。随后coarse49.308ms（R2 coarse68.285664），CPU graph5.785ms，375dispatch/334compute（R2为481/440），96clear/159014656声明bytes（旧106/139156352），1847copy/80384440声明bytes（旧1354/76243112）。copy次数和clear bytes确实增加，非全项优化。

最终双plane构建后的另一次stage样本189.606624ms，VSM45.721696/Native56.567904/Temporal16.252128ms等多个未同幅修改阶段均变慢，source3.420160ms、probe pre16.984160+post8.058496ms。记录在`.local/scgi-r3-stage-final-1080.json`，不能删除该慢样本或归因于未经证实的驱动/温度，也不能据短序列宣布稳定49ms。本轮不做长窗口性能资格；SCGI-10须稳定条件下冷暖/静动及分阶段复测。

同构建复采coarse180.690848ms、CPU graph5.980ms，375dispatch/334compute，16153请求/16153Native写、screen-valid18621/reuse11450/fault0，GPU/page errors为空，记录在`.local/scgi-r3-batch1024-coarse-1080.json/png`。早期49.308ms只作为历史短样本保留在本节，不能作为当前稳定表现；最近实测仍严重慢，R3机制闭合与整链性能合格必须分开。当前不新增第四重构单元或越权开始SCGI-10，也不靠降1080p/16方向掩盖它。

公开GPU当帧header：Q230400/H518400，screen-valid18898→unique16304→Native writes16304，fault0，nonzero qualified solar reuse11584/missing0；最终双planestage为19317→16548→16548，reuse11840/missing0。计数表明主要省去无人消费的源，不是把实际Q降低。计数通过**主帧完成后local-only诊断encoder**读64B，不参与production决策，额外诊断submit不计主frame；生产仍1submit，仅原timestamp readback（coarse16B/stage320B）。截图及source图已打开检查：最终画面仍明显偏暗、有噪声，source紫色是未请求/invalid。原316ms失败、R2约68ms与本轮全部短样本保留，不追认AAA画质或实时目标。

**来源与关闭边界。** 固定FidelityFX/Brixelizer参考不变；request-first exact Native共享、8B lookup/48B preparation、窗口drain与VSM资格是Local integration，非AMD整套port。R3所有生产route已原子切换并通过必要直接语义/生命周期检查，关闭本单元。用户随后授权提交，R3已在master提交`db3a67fe`，未启动SCGI-10。后者集中完成公开实验屋收敛与动态画质、开放门边VSM误差、组合故障/退休峰值和稳定成本检查；本节不替代最终资格。

**后续示例参数调整（用户授权，2026-10-18）。** 公开实验屋Sun/sky改与Bistro默认一致：2026日历day44/time13/latitude35/longitude0、太阳2.2×[1.474,1.8504,1.91198]、sky3、fixed exposure5、All lighting/aerial开启；复用Bistro sun-calendar计算。增加光照分量、日历/手动太阳、曝光诊断、Renderer与VSM调试面板及收起按钮。GI质量/采样和1080p/internal1不变，但光照与曝光条件已变，不能与本节旧条件数据直接比较。`typecheck:scgi`与`build:scgi`通过；真实1080p页面核对默认physical snapshot、收起/展开及depth debug切换通过，无page/GPU错误，截图已检查。该检查仅为demo接线，不是SCGI-10或GI收敛验收。
