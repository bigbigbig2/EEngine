# Surface V3 Phase 4：固定 Field/Signal 树与实际来源绑定

日期：2026-10-05（Asia/Hong_Kong）。起点 `a4770f00ef869ec7b0fd6cfa895f05751bf365b2` 加本轮工作树；实现对应本轮中文提交。范围：[执行计划 §7](surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md)、[设计 §9–12](../next-design/surface-work-v3-cost-bounded-final-refactor-design-2026-10.md)。Phase 4 实现及集中检查通过；Phase 5–7 未开始。阶段完成不代表最终性能或完整画质验收。

## 实际切换与删除

- classifier 改为 16 quad + 4 parent + 1 root。每个内部节点只合并四个 child；混合 DomainKey 或父级判定失败保留已有 child，没有前序 lane 分组、域子集枚举、任意成员配对或 shrinking search。
- 完整动态 DomainKey 由 `surface_cell_domain.ts` 统一比较：实例/几何与 generation、material、deformation、合法连续域、side，以及 closure 所需 UV/color/normal/tangent 域。沿用已发布的跨 meshlet/LOD 连续性；UV2 缺少 chart 对应时，只限制相关 closure 的本地表示/primitive，不能以 blanket meshlet 相等代替完整合同。
- publication 已有 dependency/seam 合并产品继续作为权威输入。相同完整 dependency-group token、相同覆盖及不变 lane facts 可复用已做过的域相等判断；Signal 使用完整 execution token，避免把 direct/environment 的同域 token 混为相同 provider 条件。token 不代替首次动态 tuple 比较。
- Geometry/world/normal/tangent/view 支持域与字段 bounds 按四 child 保守合并。child residual 先转换到真实 parent anchor plane，再合并并按 parent 的 pixel-scale/质量预算重新判断；不是仅 AND child safe。
- 当前 plane 的 bounds scratch 在每次字段 reduction 后重用。保留原 interval 的 outward rounding、normal cone、roughness、coat 和方向约束，完整范围不被截断为点值。
- accepted source 是覆盖内最先出现的真实 winner。每 lane 从 root/parent/quad 直接确定 owner；并行 rank/prefix 给出 representative→slot，六位 map 每个 word 有唯一 writer。删除 lane 0 的代表列表线性搜索、串行逐 member map 写入。
- Empty、Publication/Default、Zero 与完整逐点 hit 的模板不进入空间树/证明。已有逐点值可以直接 fine 引用，value hit 不会自动变成共享许可；部分 Unknown 只影响其必要 field/signal。
- 保持 Field classifier/source→Signal lookup→Signal classifier 的生产次序。Signal getter 读取实际选中的 FieldRef；Store slot/generation、publication witness 与 transient 分域。依赖 transient Field 的 signal 保持 dirty，并跳过持久 key/dedup 准入，完整本批计算仍有真实 destination。
- 删除不再被生产引用的 `cell_certificate_members`、`cell_candidate_field` 全成员聚合和不同 cluster 的完整灯列表比较。直接光只接受相同准确 cluster；超前端风险预算不缩减 heavy Lighting 的真实光源列表。

## Provider 与总预算

相同 node/完整 coverage 的 world box/provider 风险由 direct lobes 复用，相关 lobe 自身的 normal、roughness、coat 与 view 判定仍独立。最多访问 8 个 punctual lights，保留原 attenuation/cone/receiver 与 directional/physical-sun shadow 拒绝规则。

provider 采用 typed proof kind 4，与 support/Geometry/canonical/screen 共用 R/2 容量。workgroup 先排名，一次有界 CAS 预留，按 root→parent→quad 的收益顺序受理；容量不足、竞争失败或未知风险均保留完整 child/fine。

调试中实际发现单 lane 八次 CAS 让 21 个可接纳候选仅获得 8 个 slot，队列有空位却出现大量 fine。已修复为 cooperative reservation；独立 GPU 用例验证同域 direct lobes 合计 21 个 provider proof，而非每 lobe 再申请；仅余两个 slot 时受理完整 root/parent，满额时不越界。没有延长 spin 或接受半份 proof。

## 物理与执行账

64-lane portable workgroup；`GpuSurfaceCellTreeAbi.ts` 按 WGSL stride 记账：lane facts 32B、Geometry facts 112B、node metadata 32B、signal Geometry summary 144B、当前 field bound 48B。最坏声明/对齐预留 **15,616B**，创建 layout 前核对 `maxComputeWorkgroupStorageSize`，且实际 WGSL 在默认 16KiB device 上编译/运行通过。

没有在 workgroup 存 64 份 512B setup 或全部 21 plane 的大型证书，也未新增 Surface storage arena。R=25,536、399 tiles/batch、最坏82 batches与此前508,657,088B物理账保持原口径；GPU actual ranges仍裁空。

每启用 plane 至多21节点、每节点四 child；metadata/domain 比较不依赖任意 member 集合大小。同组 domain 相等可复用，但 field/signal质量约束独立；不把实际 dependency groups 数量写成1。原 shared leaf/canonical proof producer 的调用粒度和后半段 demand worker仍由 Phase 5–6继续收口。

## 本轮真实检查

全部使用新鲜 `.test-dist`，以下运行 exit 0：

- `npm --prefix OEngine run typecheck`、`build`、`build:test`。
- 13 个 targeted 文件、52 项 semantic/contract/oracle tests。新增固定矩形独立 CPU 参考、checkerboard拒绝、parent范围/平面、准确cluster、point-hit fine、覆盖内 source 与创建前共享内存协商；后续修改重跑受影响项并最终重跑完整 targeted 集。
- `phase4-tree`：17 个 GPU 用例，实际生产 tree、DomainKey、完整 light-risk predicate→生产 source reader。含UV0/UV2、side/未知表示、合法跨meshlet连续性、parent/局部Unknown、point≠domain、Publication、部分覆盖、map满、8/9灯、shadow无receiver证书、proof满及两槽优先root。全部启用plane的source均来自真实覆盖；C≤32（R=64）。
- `repair-certificate`：8 个独立数值输入用例，生产四child合并；安全child但parent超字段预算、变更parent平面、normal cone、低roughness、局部Unknown与部分覆盖通过。该 fixture 隔离 provider；provider正确性由上一项的实际 predicate 检查承担。
- `repair-field-lookup`：10 个实际 GPU FieldStore/Pending/版本/point-domain/满proof/ConstantDomain/BoundedDomain关联回归通过。
- `repair-signal-lookup`：12 个实际 GPU selected Field source→complete Signal key→Store reserve/commit→lookup 用例。迁移到9-word identity/profile ABI，移除 fixture 错误的全publication mask；不同字段选中不同覆盖来源，roughness producer generation只影响真实依赖signal，transient来源保持dirty。
- `phase4-production`：26 个真实 modules编译；GPU dependency/publication→coverage→setup→Field lookup/proof→Field tree/source→Signal lookup/tree→demand→Geometry→实际Appearance/Lighting→两个Store发布→HDR。sparse/empty/moved/warm四帧分别覆盖137/0/72/137像素，完整HDR写域；最终warm为16个Field hits、35个Signal hits，所有families总C≤64（R=128）。Phase 1 metadata assertions保留。
- Showcase：Chrome154 / GTX1650Ti / 1080p overview，AO/FSR3/Bloom开，VSM/jitter关；3 timing + 1 detailed短smoke，capture complete、issues=[]、sourceDrift=false、采样帧Surface coverage=pass，无GPU/API/device-loss错误。累计generic GPU counter drop=1，已在timing报告中出现；detailed采样帧的GPU counters available=true/dropped=false、Surface diagnostics available且无coverage violations。不能写成所有历史计数均零。

首次Showcase运行因本地5173示例服务未启动而连接拒绝，启动服务后重跑通过。阶段内CAS受理与WGSL拼接错误均已修复，并重跑受影响GPU检查；没有放松检查。

本机artifact目录：`.local/validation/surface-phase4-tree-readable`、`surface-phase4-parent-final`、`surface-phase4-field-regression`、`surface-phase4-signal-source-first`、`surface-phase4-production-final`、`surface-phase4-showcase-final`。raw报告/生成WGSL/图片不入库，不提升evidence或claims。

Showcase保存当次dirty清单、source diff与fingerprints；阶段文档/导航在检查后同步，未修改已检查的生产源码。

## 复现命令

仓库根目录；GPU fixture串行运行：

~~~powershell
npm --prefix OEngine run typecheck
npm --prefix OEngine run build
npm --prefix OEngine run build:test
$phase4Tests = @(
  'surface-cell-plan', 'surface-frame-resources', 'surface-geometry-phase2',
  'surface-batch-consumption', 'surface-field-store', 'surface-execution-profile',
  'surface-optimization-capacity', 'surface-field-publication',
  'surface-field-dependency-profile', 'surface-bound-specialization',
  'geometry-surface-publication', 'surface-fixed-tree-phase4'
) | ForEach-Object { "OEngine/tests/contract/$_.test.mjs" }
node --test @phase4Tests OEngine/tests/oracle/appearance-field-identity.test.mjs
foreach ($fixture in @('phase4-tree','repair-certificate','repair-field-lookup','repair-signal-lookup','phase4-production')) {
  node validation/labs/surface-optimization-v1/run-production-cell-browser.mjs $fixture ".local/validation/surface-phase4-recheck-$fixture" 60
  if ($LASTEXITCODE -ne 0) { throw "GPU fixture failed: $fixture" }
}
# Showcase runner要求examples服务已在5173运行；另一终端启动：
# node OEngine/node_modules/vite/bin/vite.js --config examples/vite.config.ts --host 127.0.0.1 --port 5173 --strictPort
node validation/labs/surface-optimization-v1/run-phase1-showcase-smoke.mjs .local/validation/surface-phase4-showcase-recheck
~~~

## 验收边界与下一阶段

短诊断只用于阶段连通、错误/覆盖和数量级异常检查，不能依据几帧判断最终收益、最终目标或优于V1/V2。最终性能**尚未验收**，正式同条件比较仍在Phase7。

尚未运行完整跨浏览器、resize/cut/device-loss、所有skin/morph/材质/provider组合、连续质量和历史版本正式比较；按计划保留Phase7。当前截图中的既有黑斑仍不能解释为画质验收通过。原完整Lighting/provider数学没有在本轮缩减；未完成provider/质量范围不借阶段smoke提升adoption。

下一阶段为Phase5实际worker/source/packet/发布/reconstruct合同切换；Ddirect factorization、全部payload reset/binding/lifecycle收口仍属后继。Phase5尚未实施。
