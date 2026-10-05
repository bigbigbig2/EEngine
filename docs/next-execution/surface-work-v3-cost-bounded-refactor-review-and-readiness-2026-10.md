---
id: next-execution/surface-work-v3-cost-bounded-refactor-review-and-readiness-2026-10
state: current
verifies:
  - OEngine/src
---
# Surface V3：阶段复审与继续实施准备

日期：2026-10-05（Asia/Hong_Kong）。本页记录用户认可的阶段调整、代码审查依据和动手前清单；不另建并行执行入口。架构合同以[最终设计](../next-design/surface-work-v3-cost-bounded-final-refactor-design-2026-10.md)为准，实施顺序以[执行计划](surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md)为准，完成状态以[进度记录](surface-work-v3-cost-bounded-final-refactor-progress-2026-10.md)为准。

## 1. 决策与身份

固定顺序：**Phase 5 先修正确性/诊断缺陷并完成实际需求合同 → Phase 5.5 补齐前端物理表示与成本约束 → Phase 6 调度/reset/lifetime → Phase 7 正式验收。** 各阶段集中检查通过后才推进。Phase 5.5 是此前设计要求的补齐，不是可选优化，也不抹去此前阶段判定不足。

审查起点 HEAD 为 `0c8caf3046fee0f7022b89f3e47e39ef3cd833cd`（Phase 4），另有未提交 Phase 5 生产代码、测试和实施记录。不能把 HEAD、dirty 工作树、历史 fixture 结果混成一个已通过版本。此次准备只修改文档，不完成代码修复、不重跑 renderer、不升级 adoption/claim。

选择理由：Phase 5 先稳定真实 missing/dirty、packet 和发布消费者，Phase 5.5 才能据此删掉不需要的前置生产；Phase 6 的 reset 范围、binding cache 和资源代际依赖最终布局，先做完 Phase 6 再拆布局会返工。5.5 切换 ABI 所必需的 reset/binding/lifetime 接线必须随同前移，不能留下断链。

不采用：等 Phase 6 之后统一补洞；在当前不稳定消费者上先重做全部布局；把所有 footprint 都变成 miss-only；通过减小身份/证明、永久全 fine、隐藏完整 decode 或丢弃溢出输出来省成本。

## 2. 审查发现与责任阶段

| ID | 当前源码事实及证据入口 | 结论与责任 |
|---|---|---|
| F01 | [Classifier](../../OEngine/src/render/surface/SurfaceCellClassifierPass.ts) 已消费 ActiveTile/indirect，但 CPU 仍编码全部 batch 并整块 clear Workspace | ActiveTile 接线真实；CPU 编码、payload clear、稳定绑定属 Phase 6，不称全部收益已传导 |
| F02 | [地址](../../OEngine/src/shaders/surface_cell_addresses.ts) 仍为 144 u32/leaf，lookup 前按 publication input union 物化原始 C/X/Y | 8-word candidate hash 和排队 support 已实现，但完整 lazy witness 未落实；Phase 2/3 前置要求由 5.5 补齐 |
| F03 | [Workspace](../../OEngine/src/gpu/GpuSurfaceCellPlanAbi.ts) 仍有 128B Geometry、208B Field、208B persistent certificate/target | proof admission 不等于结果存储 compact；与“不叠三份 dense cert”目标有差距，5.5 必须移除 |
| F04 | [Field lookup](../../OEngine/src/shaders/surface_field_lookup.ts) 枚举 15 fields；[Signal lookup](../../OEngine/src/shaders/surface_signal_lookup.ts) 枚举 6 kinds；refs 预留 252B/target | 枚举不等于每项完整 cache probe；constant/absent/noncacheable 有退出。5.5 迁移可公式化 ref 和不必要逐 leaf bounds；保留有真实身份需要的引用 |
| F05 | [Geometry](../../OEngine/src/render/surface/SurfaceGeometryPass.ts) 为 128B hot + 按 mask atomic append cold，预留最坏 528B cold | cold 实际写入已 compact，不是每次写 656B；完整 fine 容量继续保障，5.5 理顺物理池与预算映射 |
| F06 | [planner](../../OEngine/src/gpu/SurfaceOptimizationCapacity.ts) 把完整 656B 放入 geometryHotBytesPerTarget，应用 16MiB 配额 | 当前直接限制为 floor(16MiB/(656×64))=399 tiles；不是 setup 32MiB 限制。先更正归因，5.5 重算实际布局约束，不能只调大 R |
| F07 | Phase 4 为 colored Ddirect；dirty Phase 5 已把 transport/residual 标志写入 packet 并由 [reconstruct](../../OEngine/src/render/surface/SurfaceReconstructionPass.ts) 消费 | factorization 明确属于 Phase 5，不能判成 Phase 4 漏接；当前实现仍需 Phase 5 收口检查 |
| F08 | [demand resolve](../../OEngine/src/shaders/surface_demand.ts) 找不到 hash owner 时将自身加入 unique writers；[Store](../../OEngine/src/shaders/surface_store_publish.ts) 独立 reserve way | 静态可构造 hash 探测耗尽后同 key 多 writer，尚未新增 GPU 复现；Phase 5 修复并验证，不留至 5.5/6 |
| F09 | Field lookup 四个现行 pass 名不匹配 [SurfacePhaseTiming](../../OEngine/src/debug/SurfacePhaseTiming.ts)，测试仍手写旧名称 | Surface 子阶段汇总漏项；不推断总 GPU pass sum 同样漏计。Phase 5 修复真实名称覆盖与检查依据 |
| F10 | [radiometry](../../OEngine/src/render/surface/SurfaceRadiometryPass.ts) 全局 envelope；Ddirect domain 动态合并 seam；部分 direct dirty 组合同时执行 full BRDF 与 transport | 成本风险，不能冒充已复现数值 bug。Phase 5 固定正确性合同，5.5 计量准入影响/重复工作，缩小可证明无关依赖；保留原 finite guard |

上述路径是审查入口，行号随实施变化。F02/F03/F04 不能借 Phase 6“收口”字样无限后移；F05 的 worst-case 预留和合法 dense mandatory value slots 不能误当成未实现。Phase 1–4 历史通过记录只证明当时实际覆盖范围，撤回“前置缺口已经全部补齐”的总括结论。

## 3. 当前成本与证据边界

1080p、128MiB storage binding 的当前 planner 静态结果；数字描述本次 dirty 工作树，不是最终目标或实测带宽：

| 产品/量 | 当前值 |
|---|---:|
| R / tiles per batch / encoded batches | 25,536 / 399 / 82 |
| Workspace | 38,926,960B |
| 其中 addresses / 三组 certificates / Field+Signal refs | 14,708,736B / 13,891,584B / 6,435,072B |
| setup/refs/memo/control | 21,929,984B |
| Geometry hot + worst cold | 16,751,616B |
| Field values / Signal values | 6,128,640B / 2,451,456B |
| Phase 5 Demand arena（256 program 预算） | 3,757,312B；Phase 4 为 24,277,504B |
| planner reserve，含 scratch retirement 与双输出 | 467,616,704B；Phase 4 为 508,657,088B |
| Workspace + Demand 两项 82 次 clear 的命令范围之和 | 3,500,110,304B/frame |

最后一项不是全部 reset/copy，不是物理 DRAM 流量，不是 GPU 耗时。预算下降不证明 batch 或帧时下降。R=65,536 是目标 profile，不能通过删完整 fine 容量硬凑。保留 CPU encode、GPU span、pass sum、Surface subtotal、allocation、logical writes 和 clear range 的不同口径。

已有 `.local/validation/phase5-showcase-final/report.json` 只有初始化进度，最后 `ready=false/frameCount=2`；没有 finishedAt、timing/detailed 完整结果，初始 passed=false 不是完整运行后的失败判定。当时错误计数为零不能证明后续成功。当前没有可据此认定的死锁/退出根因，Phase 5 smoke 未通过收口。

历史小链（25×9、R=128）和容量测试可证明所覆盖的数值、写域和预算上限，不能证明复杂 1080p 成本；proof 数量测试不能代替证书物理布局审计；手写旧 pass 名不能代替实际计时覆盖。修正计时映射后不得覆盖原报告，历史 Surface subtotal 需标注当时分类覆盖限制。

## 4. Phase 5 动手顺序与交付

1. 保存本次起点 revision、tracked diff、untracked 生产文件指纹及 fixture 身份；保留已有未提交工作。文档准备不把这些工作自动标为通过，也不要求先为开工制造提交。
2. 修 F08：没有建立唯一 cache owner 的请求只保留合法 transient；不得把 unresolved 请求自行升级为 Store writer。若采用其他 bounded ownership 协议，必须完整证明同 key 单 writer，不增加全流恢复扫描/自旋。
3. 修 F09：从真实生产 pass 标签核对 timing 分类；列出有意排除的非 Surface/diagnostic/copy-clear 项。timestamp drop/unavailable 单独记录，不能按零耗时通过。
4. 保留原报告并定位 smoke 中断；记录源码身份、启动/编译/帧进度、进程退出或外部中止原因。确认链可运行后重跑短 smoke，不能把延长超时或只有零 API error 当作定位完成。
5. 完成 mask→Geometry union→missing closure→dirty kinds→Store commit→compose；ordinary transport 和异常 residual 的 key/proof/rate/semantic 同步，normal/coat/provider 原数学与有限值 guard 保留。
6. 集中 typecheck/build/fresh build:test、必要 targeted、真实 GPU 数值/覆盖/发布和短 smoke。F08 必须覆盖大量碰撞、同 key 重复、bounded probe/CAS 失败、队列满、Store 满及 pin，断言 admitted writers/key≤1，失败仍完整输出；F09 从真实生产名称检查应计 pass 无遗漏。

通过条件：上述必需项完成且在同一收口源码身份有效；没有未定位的显著回退或未完成 smoke。只把 F02/F03/F04/F06 及 F10 成本项作为明确交接给 5.5 的债务，不允许把正确性/诊断缺陷带过去。

## 5. Phase 5.5 切换单元与检查

主要 owner：SurfaceGeometryPass/地址 producer、Field lookup/support、certificate/tree/source、GpuSurfaceCellPlanAbi/ref accessors、SurfaceFrameResources/SurfaceOptimizationCapacity。每次替换 producer 和全部直接消费者，同时删除被替代 ABI；不建 old/new adapter。

| 切换单元 | 必须完成的设计约束 | 必须核对的消费者 |
|---|---|---|
| A：cheap address / lazy witness | 列明 candidate、point validation、spatial proof、worker 四类输入；只在真实需要时生产详细 witness，按完整 profile 受理，不把所有 footprint 推到 miss 后 | Field hash/equality/support、DomainKey/provider、Signal key、Geometry worker、Store support 发布 |
| B：受理证书的结果池 | 用有类型 proof slot 和显式映射消费实际结果；共享总账 C≤R/2；常量/默认 bounds 引用 publication；移除三份逐 target dense certificate | parent/tree 合并、Field hit/support、persistent Store、source selection |
| C：ref/template | Publication/Default/Zero 与 implicit transient 公式化；mixed/store 的必要 identity/generation 显式保留；mandatory fine values 可保留 dense slots | demand、Appearance、Lighting、Store ref 发布、reconstruct |
| D：物理预算 | hot/cold/setup/address/proof/ref 使用真实 allocation 与绑定限制；含 retirement/双输出；每个限制项可报告，选择最紧约束 | capacity planner、frame resources、batch/range 编码和诊断 |
| E：成本闭合 | 度量 Ddirect 普通/异常准入、provider 拒绝、动态 seam 与重复 BRDF/transport；能 publication 预合并的决策退出热比较 | profile publication、DomainKey、lighting risk 与实际 Lighting |

A/B/C 之间若有不可分割 ABI 依赖，作为一个切换单元实施，不能用阶段内小步骤名掩盖旧消费者。具体 stride/slot 编码在完整消费矩阵核定后冻结，不在准备文档发明未经预算验证的新 ABI。

统一计数：N 为 active covered leaves，K 为需要 candidate 的实际 field 项，W 为真正执行详细 witness 的请求/共享组，C 为全部 family 的实际受理 proof 数，G 为 missing field 与 dirty signal 的唯一 geometry 并集。分别统计 enabled checks、probes、witness evaluations/bytes、proof attempts/admitted/results/bytes、实际 closure/kind、hot/cold writes、cache writers、logical reset、CPU encoded batches/pass/BG。所有容量上限和增长关系都从实际 stride/owner 计算。

| 场景 | 必须满足的工作/存储条件（同时检查完整数值与写域） |
|---|---|
| 空帧、空/末 batch | actual witness/proof/worker 为零，无过期读取；仍存在的固定 CPU 编码/reset 成本显式报告，归 Phase 6 |
| constant/default-only field | 对应 cache probe、详细 field witness、独立 field proof 为零；publication bounds 不逐 leaf 复制；dirty Lighting 的合法工作单列 |
| 可精确命中的稳定值 | 命中 closure 不再执行；保留当前值合法性必须的 witness；value hit 不伪装 certificate hit |
| 少量 dirty field/signal | witness/cold/worker 根据该需求及独立 proof 需求增长，不扩张成全 material 输入；geometry 每个实际求值位置只生产一份 |
| 全 miss / 高频 / mixed / 微三角形 | mandatory fine 覆盖完整；Unknown 只局部细化，不能靠不再尝试普通合法 coarse/cache 来通过成本检查 |
| proof 预算耗尽 | C≤R/2，实际结果写入与受理 typed slots 对应；不存在 3×R 大证书数组作为常态输出或未计旁路；fine 无丢失 |
| hash/cache 满、同 key 碰撞 | 只影响 optional admission，writers/key≤1，transient 与 coverage 完整，无全流扫描恢复 |

核对分两步：同 R/相同输入下比较表示本身的实际产量与预留，再运行新 planner 的真实 R/batch 对照，避免把扩大 batch 与减少工作混成一项收益。预留上限、actual writes、clear range 分别报告；不能只缩计数器却保留等量隐藏生产。

阶段完成必须包含：typecheck/build/fresh build:test；独立语义/数值/overflow 检查；实际新 producer→consumer GPU 链；上述场景的结构与计数断言；受影响 Showcase 短 timing/detailed smoke。GPU 作业串行。声称减少的工作没有下降、重复生产仍在、或短诊断显著回退未解释，则 5.5 未完成，不推给 Phase 6/7。无固定 FPS/百分比门槛，正式 V1/V2 比较仍在 Phase 7。

## 6. 实施前来源、交接与记录

本次只依据已审查本地实现调整阶段和约束，不宣称重新核读外部完整来源，也不提升 adoption。复杂实现开始前，按 [porting 账本](../porting/next-renderer.md)重新定位相关固定源、许可证和完整入口：CPS/OSS 的工作组织、现有固定树/proof/interval 来源、Ddirect/coat 原 BRDF；读取必要论文/详细说明，记录来源阶段到新产物的映射。没有完整 donor 的物理集成方案明确标为本地方案，不能借拆成 ABI 小改免除整体算法审查。

Phase 5.5 交给 Phase 6：最终物理产品清单、producer/consumer/stride/capacity/validity/reset/overflow/lifetime、actual-count 写域、binding offset/generation 失效条件、仍存在的固定 CPU 编码成本。Phase 6 负责广泛 reset/调度/lifetime 收口，不再承接未完成的 witness/证书物理重构。

进度只能分别写“实现、验证、成本约束、正式性能”。历史通过项留在历史源码身份下；本次文档准备验证范围为链接、YAML、状态一致性、源码未变化与 diff 格式。没有重跑 typecheck/build/tests/GPU/browser/benchmark，原因是本次未改生产代码。

本次准备静态检查结果：13份修改/新增Markdown本地文件链接无缺失，workstream YAML解析通过，vibe context返回新阶段顺序，git diff --check通过。OEngine/validation共991份版本控制可见文件组合SHA256前后一致：`8721e41a8be7f07e3f12c5f5fc704d8a0ced4dbd4c2ba9699eac0bab7f9e680a`。这只证明本次文档操作未改变已有代码/测试/fixture，不证明该dirty实现正确或性能达标。

## 7. 测试规则补齐与开始编码前的覆盖准备

上次准备已列阶段/场景门槛，但没有系统写明测试可信度、失败分类和防止弱化断言的修复限制；`docs/VALIDATION.md`也仍残留旧的“开发中不测试”覆盖规则。本次纠正为[执行计划§1.4](surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md#14-测试可信度失败修复与阶段完成规则2026-10-05-补齐)，由AGENTS和VALIDATION同步引用，适用于后续全部Surface阶段（含5.5）。这是新增规则落实，不是既有测试已经修好或阶段已经通过。

开工先在Phase5实施记录建立需求覆盖矩阵，至少包括：F08唯一writer/完整transient失败路径、F09真实计时名称、有效非零Lighting/transport与异常residual、missing closure/Geometry union、Store发布前后/generation/pin、完整coarse/fine写域，以及smoke实际结束与有效workload。每项列实际producer/consumer、独立预期、失败用例和当前覆盖状态；缺测试先标未覆盖，不用已有测试总数顶替。

Phase5.5沿用§5场景矩阵，并给每个结构/成本目标配真实产量断言与独立参考。先证明受测分支执行，再核对结果；不能用全miss/fine、零灯或预填输出形成绿色伪闭环。阶段退出时再对照设计和当前diff核读实现，确认删除的旧产品、全部直接consumer和失败覆盖均符合合同。

统一失败处理为保存原始证据→复现/核对预期→生产/测试/宿主/环境分类→定位首个违约边界→局部修复→原用例及关联回归。未定位不推进；不删/skip必需断言，不放宽容差或缩小最终功能范围，不为mock缺API向production加fallback/owner/submit。旧ABI测试按退休合同迁移，仍有效的语义断言逐项保留；数值预期变化有独立依据，功能/质量/误差预算/阶段范围变更须用户认可。既有测试/生产修复仍待下一次代码实施，未在本次文档工作中运行。
