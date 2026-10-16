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

**当前已实施SCGI-1资源/事务/ABI基础设施，生产GI仍未开启。** 本轮授权仅完成SCGI-1；后续动工按完整目标推进，不把阶段产物宣布为完整GI。每个单元结束记录实际验证；大模块结束停在下一模块边界，不自动继续Local Specular Cache/ReSTIR等。

## 1. 完整范围、依赖与生产切换

| 单元 | 内容 | 依赖 | 状态 |
|---|---|---|---|
| SCGI-1 | owner/publication/事务/能力与具体ABI | 源码基线和source map | 已完成，见§7 |
| SCGI-2 | GeometryProduct query section、coverage cut、residency、共享变形publication | 1 | 待实施 |
| SCGI-3 | cascaded sparse cache、ring/scroll/evict/defrag/rank | 1 | 待实施 |
| SCGI-4 | half-res anchors、共享identity、screen history seed | 2、3 | 待实施 |
| SCGI-5 | 完整RadeonRays算法适配、query、material/alpha/VT | 1、2 | 待实施 |
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
4. commit/abort不是孤立单测：必须用真实command/owner绑定验证未提交失败、已提交通知异常、异步error、retry、disable、resize、replacement、loss、last-consumer fence；错误分类见§5。
5. 开发中按需typecheck/shader compile/targeted，不每patch全量GPU。单元闭合后集中typecheck/build、新鲜build:test、必要独立oracle、真实GPU接线/画面/容量/粗成本。工具命令沿仓库package scripts，不发明尚不存在的脚本名。
6. 所有必需失败、未运行项保留原结果；不能降低alpha/材质/几何范围、跳断言、改容差或缩最终场景来关单。仅表示测试可随旧ABI退休，数值/identity/生命周期语义迁给新owner。

## 3. 各单元详细工作

### SCGI-1：具体owner、事务、publication与能力布局

**目的。** 先确定资源实际写入、发布和依赖边界，让后续cache/AS算法接到现有single submit，无第二renderer。这里不需要先造几十个空接口。

**修改位置。** `render/gi/`的settings/ABI/runtime/publication；FrameProgram/Bindings/Lowering与RendererCore只准备有限需求/组装合同，生产开启在8。检查`ShadeGPUCommandContext.finish`、FrameCoordinator、ResourceAccounting、descriptor/bind-group caches，原则上复用，不另建提交框架。

**具体工作。**

- 将设计§3、12变成精确CPU state/transition；active/candidate/frame-readable/retiring与deviceEpoch分离。commit函数幂等、无分配、不抛异常。
- 实现设计§19选定ABI：48B SurfaceIdentity、8B cell、288B patch/bank（含A0/A2）、96B request、96B half field/guide、64B raw cohort、64B node+8B links、128B query instance、48/32/32/64B ray/result/payload/continuation。offset/stride/alignment由CPU pack与WGSL load/store独立核对；continuation同时保TLAS/BLAS返回上下文，撤销旧256B patch/16B identity/32B continuation预算，layout变更同步设计§15/19。
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
- 实现刚体transform view、负/非均匀缩放；当前SkinnedMesh是标记类，不能只接revision。Product包含joint/weight/morph数据，动画owner批量发布palette/weights，geometry owner GPU生成current/previous positions、normal/tangent、cluster bounds；raster、VSM、query消费同一publication，不能建GI私有skinning。
- 48B身份缺少的slot lifetime由既有GpuScene分配owner side table补齐；materialValueRevision用真实内容版本，不能把nativeMaterialRevision有限hash当稳定身份。page搬迁不改变stable primitive，topology替换则改变generation。
- origin rebase与真实moving assembly区别；camera teleport有query coarse预取/有效性，不能走到新区域直接把所有未驻留物体当不存在。

**producer / product / consumer。** Product cook+GpuRenderWorld→QueryScenePublication/page leases/covered-domain→SCGI-5 build/traversal与SCGI-4 anchors。loader只交付数据，无长期GPU owner。

**容量与失败。** coarse闭包不满足budget则该scene/profile拒绝启用或显式缩active GI domain；不截断实例。fine请求延迟服务、完整coarse继续；目录超limit用分段arena。缺coverage texture不发布ready scene。

**事务。** 新query directory与geometry/material revision同一frame事务；readPage迟到结果核对Product+device epoch。abort不释放active pages；submit后旧区间只在最后query fence释放。

**验证。** 离屏墙仍遮挡、只转camera不删query instance；跨page triangle/UV/material remap；coarse/fine切换无coverage洞；精化和evict同帧竞争；product重用slot、page搬迁、cancel/retry；rigid/非均匀/负缩放/变形/current-vs-previous；薄墙、门、栅栏与coarse proxy高精参考对比。

**成本卡。** per-instance/query cluster/page metadata、额外proxy bytes、因query pin多驻留的共享payload、build/replacement峰值、流送带宽；共享内存和增量内存分别列。

**关单条件。** 全合法Product来源/动态路线都有明确query事实与完整覆盖，不允许用独立import mesh bypass证明新Product已接通。

**覆盖决定。** 每asset保存minimum query cut/coverage-critical类别；测试domain边缘、offscreen实例、同mesh大量实例与父子LOD不重叠。query proxy确需新增payload就列真实增量。动态测试同时检查raster/VSM/query位置与旧资源退休，只有GI debug三角形移动不能证明完成。

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
5. 真实GpuRenderWorld/Product/VT输入，无独立测试mesh替代生产数据；page evict/move/revision/transform/skin发生时hit仍匹配。
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
| Rigid/skin/morph/large assembly | current geometry、query bounds、previous validity、origin rebase | 静态proxy未声明、删除动态instance |
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
