# Surface V3 有界前端最终重构执行计划

日期：2026-10-04（Asia/Hong_Kong）。状态：Phase 0静态清单、Phase 1 publication/工作表示与 Phase 2 Geometry owner/bounded setup 及阶段检查已完成，当前待 Phase 3。

目标：[最终性能重构设计](../next-design/surface-work-v3-cost-bounded-final-refactor-design-2026-10.md)。总架构/画质边界仍以[第三版原文](../next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)为准。当前切片：[workstream](../../project/workstreams/active/eengine-next-clean-rebuild.yaml)；状态与基线：[执行记录](surface-work-v3-cost-bounded-final-refactor-progress-2026-10.md)。

本文替代优化 V1 和五步修复计划的当前执行入口。按用户2026-10-04最新要求，采用**每阶段实现、每阶段集中检查、通过后再进入下一阶段**；不要求每个patch或每阶段一次提交。历史结果保留，但不能代替新阶段检查。本文不另选算法，不承诺固定FPS。

## 1. 已固定起点与检查边界

重构前代码提交：**14c170785505b316c273a8aed0257fe22056b0d3**。

它保存已有 GPUTimer 分页、证书生成/selector 合并、pipeline cache key 修正、Showcase 采样工具和相关测试；不是本次有界前端重构成果。run06 原身份仍为 daaed9c7303a90e1658265e77e5cda02d63921b4 + 当时 dirty，不篡改历史报告的 revision。

准备阶段重新核对 613 份 run06 源码指纹，全部一致。报告记录 timing 30 帧、独立 detailed/movement、20 张截图完成，errors=[]、sourceDrift=false、accepted=false。此为已有诊断，不能视为正式验收或本次重跑。

规则：

1. 按Phase 0–6顺序实施，**每阶段完成相应检查并通过后才进入下一阶段**。阶段内部可以短暂编译失败、无图或消费者未接通；阶段结束时必须修复真实编译错误，完成本阶段真实producer→consumer验证，不把可发现的问题留到Phase7。
2. Phase0核对基线、消费/容量清单和文档；Phase1–6每阶段集中运行typecheck、build、必要targeted tests，以及涉及WGSL/GPU产物时的编译与真实GPU组件/接线检查。可按调试需要运行检查，不要求每个patch重跑全部测试。
3. 阶段“完成”同时要求代码完成和对应检查通过。单步不设固定性能提升百分比，但意外数量级变慢、容量失控、错误结果必须定位处理；不能以最终才验收为由带过。Phase7保留整链回归、跨浏览器/场景、连续画质和同条件性能正式验收。
4. 不恢复旧 Surface owner、adapter、旧全率链、占位效果或第二 submit。
5. 只保留仍被最终架构消费的数学、资源 owner 和产品；删除无消费者依赖，旧 ABI 测试按新语义更新。
6. 算法实施前按来源账本核读完整固定源与依赖；未验证不提升 adoption。
7. 进度记录区分“准备完成、代码完成、验证完成”；文档链接更新不代表任何代码完成。

### 1.1 每阶段必需检查

| 阶段 | 检查范围与通过条件 |
|---|---|
| Phase0 | 基线revision/指纹与报告口径一致；consumer矩阵、容量公式和overflow可核对；链接/YAML/导航正确。重新运行旧基线检查时单独记录已有失败，不冒充新实现通过 |
| Phase1 | typecheck/build；DAG依赖/profile/intern/版本测试；生成WGSL编译；production publication→profile/coverage/template消费者的小链，覆盖constant/empty/mixed与完整mask |
| Phase2 | typecheck/build；排序/run/prefix/容量测试；CPU/WGSL插值/差分对照；真实setup→record→consumer，覆盖memo满、不同primitive、UV/side/退化及hot/cold |
| Phase3 | typecheck/build；完整key/support/误差预算/版本测试；production FieldStore查询/证明/发布消费，覆盖point≠domain、hit/miss、满表、Unknown/预算耗尽 |
| Phase4 | typecheck/build；固定树独立参考/coverage/source映射；真实Field source→Signal identity/plan；parent误差、seam/mixed/provider拒绝和局部fine |
| Phase5 | typecheck/build；missing closure/packet/compose数值；实际Geometry→Appearance→Lighting→Store→reconstruct小场景出图，包含常量、全hit/miss、满表、Ddirect/coat/AO/π和HDR |
| Phase6 | typecheck/build及受影响回归；真实WebGPU usage/binding/indirect；poison payload/zero-work/reset/retire；Showcase短整链smoke、resize/cut/资源变更及短timing/detailed成本诊断 |
| Phase7 | 在阶段检查基础上重跑整合回归、完整质量/生命周期/跨浏览器矩阵与同条件历史版本性能比较 |

从已有test/fixture选择真实语义用例；缺少覆盖时补独立参考和production消费者检查，不用源码正则、mock输出或过期.test-dist证明GPU正确。编译产物测试先生成本阶段新鲜build:test。

阶段1–5如已具备完整可运行Showcase链，增加受影响场景短smoke与粗粒度耗时检查；尚未具备最终画面时，必须有本阶段真实生产shader/资源小链证据，不能以“还不能出图”免除GPU检查。短诊断不是正式收益或完整质量证明。

### 1.2 跨阶段依赖与失败处理

本阶段改变ABI而consumer原排在后续时，把编译和语义验证所必需的真实接线前移，同步调整阶段边界。不留跨阶段编译失败，也不加adapter、临时旧链、占位值或空consumer让检查假通过。

新producer与直接consumer作为同一切换单元；唯一生产路径，不同时运行旧/新方案。阶段内部允许断链，阶段结束完成该切换单元检查。

检查失败先在本阶段修复并重跑受影响项。确实受外部工具/环境阻塞时报告阶段未通过和原因，不擅自跳过进入下一阶段；仅用户明确调整范围/豁免时变更要求。来源采用/正式claims不作为逐阶段额外门槛。

### 1.3 检查命令与记录口径

现有可用入口为 npm --prefix OEngine run typecheck、npm --prefix OEngine run build、npm --prefix OEngine run build:test，以及 node --test 后接本阶段真实测试文件。build脚本已包含typecheck，可先单跑typecheck定位，再以完整build收口；不能只运行build:test就声称production build通过。

也可使用 node tools/vibe.mjs verify --module --test 后接实际targeted test路径。浏览器/GPU小链沿用validation宿主；根据本阶段生产入口补充或改写fixture，不为检查保留旧ABI，也不把读取归档WGSL的repair-compile当作新生产链验证。

每次阶段检查记录实际命令、exit status、源码revision/dirty身份、GPU/browser/fixture及结果范围。只写“通过测试”而无范围不足以标记阶段完成。已有历史通过记录不转授新ABI；失败后重跑受影响检查，涉及跨owner合同变化时补关联回归。

## 2. 不可改变的实施决策

| 决策 | 执行约束 |
|---|---|
| 固定树分类 | 8×8 内 16 quad+4 parent+1 root；不恢复 lane×previous/member arbitrary search |
| 三合同 | CandidateKey、ValueWitness、SharingCertificate 独立状态/失效；value hit不自动许可共享 |
| 查询次序 | Field候选→必要验证/受理证明→Field source binding→Signal查询/计划 |
| 缓存选择 | Constant零lookup；stable使用正式完整协议；廉价/不适用closure同链DirectTransient |
| 去重边界 | 不默认全局wide-key去重；table满退transient，不扫描完整请求流 |
| 证明成本 | 操作/查询/visit/总受理数均有上限；超预算Unknown，不截断后接受 |
| Geometry | 一个owner生产setup/address/witness/唯一hot+cold record；consumer不解码三顶点 |
| 工作表示 | implicit/uniform/mixed；fine位置可公式推导，不产生64条像素task |
| Overflow | fine描述与mandatory最坏池预留；完整reservation后发布mode，coarse/fine互斥 |
| Ddirect | 正常Lambert分离factor，真实依赖同步收窄；异常guard语义按设计保留 |
| GPU调度 | actual counts/indirect；无本帧CPU控制回读；单frame submit |
| 性能判断 | 总成本/画质/容量共同验收，不能以hit/record/pass数量替代时间收益 |

初始数字来自设计中的**预算 profile**：R目标65536、proof count≤R/2、512MiB；key/证书操作上限参见设计§8/10。实际layout/limits要求更小容量时必须降R或拒绝优化，不能删能力、缩短完整身份、丢结果或超账。

## 3. Phase 0：冻结身份，完成静态消费与容量清单

**Phase 0已完成**：身份、GPU产品/消费者、14类Geometry输入、15field/6signal依赖、reset/overflow/lifetime、实际容量公式与最终预算可行例、固定来源及文档静态检查。详见[Phase 0清单](surface-work-v3-cost-bounded-final-refactor-phase0-inventory-2026-10.md)。

任务：

- 列 Surface 每个GPU产品的producer、consumer、stride、capacity、alignment、初始化、usage、overflow、retire。
- 从 Appearance compiler/Lighting 的真实访问列14类输入的center/X/Y需求、hot候选、cold分组和全需求最坏值。
- 列每种field/signal的真实依赖、publication常量、cache类别、proof输入/成本、色域/π/finite语义。
- 核查现有 continuity、UV2、LOD、普通资产/Product、形变缺口；缺口局部Unknown，不捏造跨域身份。
- 按设计预算验证真实layout和每binding/workgroup限制；不通过乘一个“目标stride”掩盖额外arena。
- 核读固定源；登记现有数学复用和本地算法边界。

交付：实现所需的消费矩阵、分配公式和删除定位，可保存在本执行记录的阶段条目中，不提前生成稳定specs/contracts。来源仍维护 docs/porting/next-renderer.md。

后继：Phase 1、Phase 2（均已完成）。此阶段只读/静态推算，不采新benchmark。

## 4. Phase 1：Publication 与 Surface 工作产品

主要入口：AppearanceFieldIdentity、compiler/publication、GeometrySurfacePublication、GpuSurfaceCellPlanAbi、SurfaceWorkRuntime。

任务：

- 发布 FieldExecutionProfile、DependencyGroup、SignalExecutionProfile、DomainRecipe、ProofProfile及完整intern token。
- 用原DAG推依赖/成本；不通过WGSL字符串猜语义，不把hash当完整相等。
- 建单次coverage/ActiveTileList、绝对tile索引、enabled masks及GPU active range。
- 定义ImplicitFine/Uniform/Mixed mode、source/ref、proof状态和发布边界。
- 给全部tile保留fine描述；多数constant/zero/implicit引用公式化。
- 按真实切换单元迁移dense Workspace/request产品与直接consumer；必要后继接线前移，删除被替代入口，不接回旧链，不为编译增加兼容桥。

完成条件：唯一新产品可表达所有合法输入/overflow和最终写域，source身份与物理slot分离，CPU不读取本帧work count调度。

交接：Phase 2获得实际输入union与容量合同；Phase 3获得精确依赖token和cache路由。

## 5. Phase 2：Geometry owner 与 bounded setup

主要入口：SurfaceCellGeometrySetup、GpuSurfaceCellGeometryAbi、SurfaceGeometryPass、GpuSurfaceGeometryRecordAbi、SurfaceFrameResources、SurfaceOptimizationCapacity。

任务：

- uniform winner直接分组；mixed采用固定64-key排序/run leader与prefix，空lane和相等key确定处理。
- local slots最坏R，memo单独有界；memo miss/full不影响正确输出。
- 单一setup producer→显式SetupRef；删除所有consumer里的直接完整decode fallback。
- 实现CheapCandidateAddress与lazy ValueWitness；详细support进入受理队列，不重新塞进逐leaf lookup。
- 实现唯一GeometryRecord hot/cold与输入mask union；保留真实finite-difference/形变/UV能力。
- 以实际allocation计算limits、retirement overlap和输出容量；先协商再创建。

完成条件：满屏不同primitive仍有完整local容量，memo不准入不会解码到每field/pass；Appearance/Lighting只能消费record，hot压缩不丢语义。

交接：Phase 3可按profile得到合法完整witness，Phase 5可从实际target并集生产一份record。

## 6. Phase 3：Field候选、验证与受理proof

主要入口：SurfaceFieldLookupPass、surface_field_request/lookup、surface_cell_addresses/certificates、GpuSurfaceFieldStore及TextureVariation/interval compiler。

任务：

- Constant/Default发布直接ref；DirectTransient产生本批需求；StableCache bounded候选查询。
- 区分ExactPublication/ExactPoint/ConstantDomain/BoundedDomain/Unknown。
- 必要support为PendingValidation，获准完成后才能接受；预算耗尽按miss/child/fine处理。
- 每模板发布完整operation/query/visit上限，所有family共享proof容量账。
- 普通稳定UV闭包具备完整canonical/support/anchor实现，不能全部排为transient。
- 保留interval关键分支、舍入余量、wrap/filter/gradient/seam/LOD；复用等价RGBA查询。
- 合并cache与空间误差预算；不分别各花一次完整容差。
- Store准入bounded owner；hash满不扫全流、不自旋，transient仍完整求值。

完成条件：query的完整身份、数值有效性、空间证书和失败覆盖闭合；不存在“所有footprint miss-only”循环依赖或valueHit代certificate。

## 7. Phase 4：固定Field/Signal树与来源绑定

主要入口：surface_cell_classify、surface_cell_production_facts、surface_cell_lighting_risk、surface_signal_request/lookup。

任务：

- publication预合并seam依赖；leaf构造完整DomainKey；constant/zero退出分类。
- 2×2→4×4→8×8固定4-child合并，parent重判支持域/误差/平面，不枚举任意member组合。
- source从真实coverage选择，直接映射source→group/slot；删除lane0线性搜索代表。
- Field source先固定，Signal identity再构造；transient ref不当持久cache身份。
- provider风险在候选间有界共用；不同cluster默认拒绝direct共享，完整lighting灯列表不缩水。
- valueHit与rate proof分开；所有逐点值有效时允许template fine引用，无需为coarse继续证明。
- independent normal/ORM/specular/coat exception不连带无关field/signal。

完成条件：旧pair/member扫描从生产入口删除；proof上限可推算，所有Unknown均有局部完整执行结果。

## 8. Phase 5：实际需求、worker、Store与reconstruct

主要入口：SurfaceDemandPass、GpuSurfaceDemandAbi、surface_demand、GpuAppearancePublication、SurfaceLightingWorkPass、SurfaceStorePublishPass、SurfaceReconstructionPass。

任务：

- implicit/mask组织主需求，只受理StableCache请求走独立dedup/admission。
- missing field与dirty signal代表形成唯一Geometry需求并集，合并cold mask。
- Appearance只执行缺失closure，CSE保留，hit字段不重跑。
- Lighting保留完整算法，按dirty kinds/实际provider输出。
- Ddirect factorization同步修改key/proof/rate/publish/compose，异常finite guard按设计明确semantic。
- reserve→produce→后续commit→consume；generation、pin、namespace、abort安全。
- reconstruct只有限引用选择/合成，π/AO/色域/pre-exposure各一次。
- fine mandatory容量与coarse/fine互斥写域真实接通，不能用占位输出过渡。

完成条件：从Visibility到HDR/reactive为唯一完整新链，全部合法失败分支有真实消费者；既有旧链/旧ABI不在生产import graph。

## 9. Phase 6：reset、编码与生命周期收口

主要入口：SurfaceFrameResources、SurfaceOptimizationCapacity、SurfaceCellPipelineLayout、ShadeGPUCommandContext、GPUTimer及对应owner。

任务：

- 落实设计§16的reset/overwrite/validity表，删除payload整块clear；必要OR mask/table/reset保留。
- zero-work indirect显式写零，actualCount以外不可读，scratch复用在最后consumer后。
- stable BG/PSO缓存；resource/layout/generation/offset变化准确失效。
- 合法连续dispatch合并，copy/clear/query/staging在pass外，独立indirect buffer满足usage scope。
- uniform ring或有序staging，不使用同submit多次覆盖uniform的错误模式。
- 真实预算含retired overlap；resize不足headroom时合并请求/安全延后，不超分配。
- camera cut、LOD/content/provider变更、abort、device recovery与时域owner接通。
- 添加集中验收所需诊断入口；timing禁用细粒度counter写入。

完成条件：所有目标代码和真实接线完成，typecheck/build及本阶段GPU/生命周期/短整链检查通过，旧协调器/arena/fixture残留已清理。记录实际结果后进入Phase7，不将阶段通过写成完整质量/性能验收通过。

## 10. Phase 7：集中验证与返工

严格顺序：

1. 重跑typecheck/build/必要targeted整合回归；阶段检查发现的问题应已修复，新增集成错误在新链处理。
2. CPU/WGSL数值、coverage/互斥写域、full-hit/full-miss、queue/store/memo/proof满、poison payload、namespace/retire。
3. 真实production GPU producer→consumer；普通材质/Product/形变和实际provider。
4. 多浏览器能力、resize/cut/abort/device loss；完整连续画质矩阵。
5. timing/detailed/quality分开采；相同GPU/资产/相机/效果/输出/热状态/预热/样本，报告P50/P95。
6. 独立checkout比较89f0a94、15f12f7b、e7296be9、重构前14c17078及最终revision；历史版本只在共同能力子集严格比较，最终完整功能另列。
7. 按实测热点与计数返工，再只重跑受影响验证，最后正式证据/claims限已验证范围。

历史run06仅diagnostic。新正式runner不能默认复用其编译额外观测、未知热状态或本机路径假设；先明确production timing条件。repair-compile依赖本地归档WGSL，不是独立可移植测试。

失败处理：

| 失败 | 动作 |
|---|---|
| 身份、数值、覆盖、竞态 | 修对应producer/发布边界，不放松校验恢复旧链 |
| proof普遍Unknown | 补publication/variation/支持域，不把全fine当完成 |
| lookup/dedup成本高 | 审计受理类别和完整witness成本，不删除必要身份 |
| cold gather/memo收益差 | 调整同owner布局/准入，local正确保证保留 |
| 同质量仍落后可比V1/V2 | 目标未达成，按总成本计数返工 |
| 无同条件基线或差异小于噪声 | 报未证明，不能以原始倍数宣称完成 |

## 11. 执行记录、提交与文档维护

- 活跃workstream只维护currentSlice/goal/nextModules/architectureRules/deferredValidation的现状；详细历史留执行记录。
- 每阶段检查完成后集中同步状态，分别记录代码/检查结果，不要求逐patch修改文档，不造稳定ABI规格。
- 提交中文标题/正文，写动机、范围、实际验证与未运行原因；每个提交一个连贯意图，不提交临时浏览器数据/生成产物作为正式证据。
- 不重写历史提交、不覆盖原run06报告；历史设计/计划页显式标为非当前入口。
- 新协议稳定后才写specs/contracts；来源映射随实际算法修改补齐。

记录模板：

~~~
日期 / 阶段 / 代码revision
实现：真实新增/删除与consumer接线
未完成：具体后继任务，不将目标记成事实
静态账：实际stride/capacity/overflow/reset/retire
验证：本次真实运行项；未运行项及原因
性能：只有同条件实测才写收益；未测写未测
~~~

## 12. 当前下一步

准备文档与基线已就位。Phase 0清单及核对已完成，下一步进入 **Phase 1的publication/工作表示与真实consumer切换**；随后每阶段完成实现与对应检查再推进。正式同条件benchmark在Phase7，阶段短诊断尽早发现数量级错误，不以旧链/占位实现维持检查通过。
