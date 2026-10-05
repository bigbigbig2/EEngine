---
id: next-execution/surface-work-v3-cost-bounded-final-refactor-phase5-implementation-2026-10
state: history
verifies:
  - OEngine/src
---
# Surface V3 Phase 5：mask 需求、实际 worker 与物理 packet

日期：2026-10-05（Asia/Hong_Kong）。起点 `0c8caf30`。范围为[执行计划 §8](surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md)和[设计 §14–15](../next-design/surface-work-v3-cost-bounded-final-refactor-design-2026-10.md)。本记录随阶段集中检查更新；正式性能/完整画质验收仍在 Phase 7。

**本次状态：Phase 5 实现核对与集中检查通过。** F08/F09、IOR/coat validity 消费缺口和 canonical→screen 包含性错误已修复并回归；以下结果属于本次最终生产源码，历史失败保留。随后执行必需 Phase 5.5 的前端物理表示/成本补齐，再进入 Phase 6；正式质量与性能尚未验收。

## 唯一生产切换

## 本次需求覆盖矩阵（2026-10-05 持续实施）

本次实际起点 HEAD=`0c8caf3046fee0f7022b89f3e47e39ef3cd833cd`，保留已有 dirty Phase 5；下面状态只描述本次核对，不继承历史通过。所有必需项通过后才标 Phase 5 完成。

| 需求/复审项 | producer→产品→全部直接consumer | 正常/边界/失败与独立预期 | 结构/成本检查 | 本次结果/未覆盖 |
|---|---|---|---|---|
| F08 唯一 Store writer | demand nomination/resolve→unique field/signal queues→Store admit/commit/ref publication | 完整 key 相同最多一个 writer；hash/CAS 未受理保持 transient；256请求/128重复碰撞key/64探测，正常成功、队列满、Store pin/full、Produced、generation耗尽 | unique 不删除 mandatory masks/closures；无全流恢复扫描 | 原 unresolved owner=request 分支隔离 GPU 复现失败；Field/Signal 各64 writer/128 unresolved/256 mandatory targets通过；独立弱CAS穷举协议参考通过 |
| F09 真实计时覆盖 | 当前 Surface pass encoder labels→GPUTimer segments→SurfacePhaseTiming→Showcase capture | 从真实 FieldLookupPass 编码收集全部4个lookup/support标签；coverage/active/memo/background/present 标签也计入；diagnostics排除；copy/clear单列 | Surface sum覆盖应计dispatch；timestamp unavailable不当0 | 生产encoder测试通过；最终 smoke 应计标签无遗漏，仅 diagnostic snapshot 有意排除 |
| missing closure/Geometry union | selected FieldRef/SignalRef→demand masks→GeometryRecord hot/cold→Appearance/Lighting | empty/hit/partial/all miss；normal-only与Denv-only独立mask；numeric-only无Geometry | 每位置唯一record；cold按union；mandatory fine容量独立于optional admission | demand GPU 与六帧当前生产链通过；真实 compiler closure 独立数值检查，hit/publication/absent 的 transient NaN poison 未被写入；CSE/profile回归通过 |
| 有效Lighting/Ddirect semantic | radiometry/parameter envelope→address/profile/key/proof→dirty Lighting packet→SignalStore→reconstruct | 非零sun/directional/punctual/IBL、normal/coat/provider原guard；transport/residual阈值与GPU参数更新；独立原PBR/compose参考 | normal transport可用；异常局部residual；kind/BRDF/transport计数 | 20 Lighting数值与4 provider用例通过；补 field7 IOR 与 field14 coat validity，residual依赖也含IOR；六帧语义转换通过 |
| Store发布/identity/lifetime | reserve→Produced→后dispatch Published→refs→Field/Signal/reconstruct；submission/fence owner | Published之前不可消费；generation/pin；abort/retry、namespace耗尽与旧fence | 单writer、完整不可变payload、当前epoch pin；普通帧不清Store | Field/Signal 发布前后、满额/pin/Retiring/generation/HDR GPU检查通过；namespace host协议通过；实际消费者链通过；广泛生命周期矩阵留Phase6/7 |
| 完整coarse/fine/HDR写域 | tree/source plans→demand→workers→Store→reconstruct/background | 普通合法coarse/cache成功、局部Unknown/满额fine、empty/tail/mixed；独立完整coverage与HDR/颜色/AO/pi | coarse/fine互斥、完整fine容量、单输出owner | 六帧及1080p smoke通过；warm帧有16 Field/64 Signal命中；完整输出552598 covered与1521002 background，无Surface overflow |
| canonical→screen 包含性 | admitted canonical proof→analytic quad containment→screen certificate→tree/Store | 三UV合法成功/quad跨cell、负cell、梯度越包络、W穿零、Unknown；预期由独立仿射/有理函数数学给出 | 仅实际persistent候选检查，每UV family一次；不在热consumer重新decode | 10 GPU用例通过；隔离原reader错误接受3 UV跨cell与梯度越域；不再读未生产address46/48，保留向外舍入和screen proof拒绝后路线 |
| 未完成smoke定位 | Showcase初始化/frame submit→timing/detailed capture→finished报告 | 原ready=false/frameCount=2报告保留；当前复现相同两帧backpressure后继续，原退出原因缺记录 | CPU/GPU span/pass sum/Surface全scope/有效workload | 最终原1080p workload完整结束、sourceDrift=false、coverage pass；不能倒推原runner退出原因。1次通用counter drop单列，独立detailed完整可用 |

F02/F03/F04/F06 物理表示与 F10 成本归必需 Phase 5.5；本矩阵没有以改名方式后移 Phase 5 正确性或诊断项。原GPU失败报告保存于`.local/validation/phase5-demand-f08/fixture-plan-stride-failure.json`：扩展fixture误用144word tile plan stride，已改为当前ABI常量142word；没有改变生产预期或放宽断言。

- missing-field / dirty-signal mask 是实际需求。Transient field/value 使用 `leaf * 15 + field`，signal 使用 `leaf * 6 + kind`；删除全部 fine transient request、destination 数组和以 request ID 作为结果地址的合同。Publication、Zero、完整 hit 与已选 source 沿用已有 template/ref。
- 只有实际 StableCache field 或具有完整持久 Field witness 的 signal 创建窄 admission request。cache 队列只预留 2R fields、R signals；nominate/resolve 仅决定 Store writer，完整 key 相等不移除任何 mandatory transient closure。队列满、bounded hash/CAS 失败、Store 满均保留各自完整 transient 结果，不扫描全请求恢复。
- 64-lane cooperative prefix 替代 demand/group compact 的 lane 0 全成员扫描；无 subgroup 能力要求。Field refs dispatch 完成后才读取 selected-source Signal witness，避免跨 workgroup 读写同 ref。实际 count 生成独立 GPU indirect buffer，copy 在 compute usage scope 之外。
- Geometry 只合并实际 missing closure 的 cold mask；dirty Lighting 请求唯一 hot record，不附加四种 C/X/Y cold 输入。无 cold 需求时不计算邻点。hot128B/cold528B 最坏物理容量保留，Appearance/Lighting 不重新解码 geometry。
- Appearance 仍使用实际 compiler DAG 的 missing closure union/CSE、resident sampler 和 Product，hit closure 不重跑。worker 的 numeric-only miss 不强制 GeometryRecord。
- Lighting 按 dirty kinds 读取实际字段；Denv-only 不读完整 PBR，transport-only 不求 specular/coat BRDF。direct specular/coat 需要旧 combined guard 时保留完整 BRDF输入及逐灯计算。真实 sun、directional、cluster、fallback active list、VSM、specular/coat/IBL 数学未删减。
- packet `.w` 是显式 semantic bit pattern；Ddirect transport 与 ColoredResidual 分开，Denv 仍是 irradiance。Store 的 f32 payload 不把 semantic 当曝光/slot generation。compose 对 transport 只乘 factor，对 Denv 乘 factor、occlusion、scalar AO 和 1/pi；direct 不乘 AO，不重复 pi。最后总和转换 Rec.709→Rec.2020、pre-exposure 各一次。

## Ddirect guard 的实际证明与消费

原 `re_direct_physical` 检查 diffuse + specular + coat 总 contribution 是否有限，不能仅删 key 中的 roughness/specular 字段。新链先做以下实际生产，再 lookup/rate：

1. `SurfaceRadiometryPass` 每帧一次 GPU current-provider envelope：包含当前全部 active light record、directional mask 与真实 solar transmittance LUT texels；没有 readback、可见性控制或私有 submit。普通 provider 放行，异常数值拒绝。
2. material constant publication 从当前 GPU parameter 数据和原 DAG 传播保守 finite envelope。normalized resident texture 的格式合同包含实际 fallback；half Product 包的 finite texel 合同、normal moment decode 的边界保留。不能把 author range、旧 CPU snapshot 或任意 dynamic/world 输入视为证明。
3. 输出 envelope 不超过 2^17，incident envelope 不超过约 2e12。原 `alpha>=.002` 给出 GGX D<1e5、V<=5e5；F0/Schlick 的保守上界给出每灯总贡献 <1e34，低于 f32 上限。该证明只移除数值 overflow 对被删除字段的影响，不改变 BRDF。
4. point-address producer 验证实际 center vertex color 处于其使用的 [-2,2] envelope，在 address word136 发布当前 semantic。异常位置保留 ColoredResidual；空间 DomainKey 拒绝没有 finite transport 证明的 Ddirect 合并。其他 field/signal 独立。
5. request key word70/71 分别带 semantic/actual dependency mask。正常 no-coat transport 不带 albedo、metallic、roughness、specularWeight/specularColor、coatNormal；coat attenuation 的 factor/view、几何/光源/provider 身份保留。profile token、proof、source、rate、publish、compose 同次切换。
6. transport per-light 保留 original half-vector/normal/incident 的退化有限值判定；provider 空间证明同时包络当前 light direction + view，区间包含 half-vector 奇异点时相关 direct 细化，不将点值 finite guard推广为域证明。不能证明数值 profile 使用同一 worker 的 ColoredResidual 原 guarded formula。普通材质不永久 residual。浮点积累顺序只按容差等价，不承诺逐位相同。

## Store 与身份

独立 transient producer 后，唯一 cache writer 有界 reserve→payload produce（Produced=3）→后续 dispatch commit（Published=2）→ref consumer。Reserved/Produced/Retiring 和本 epoch pin 项不可被驱逐；未 commit 不发布 ref。generation 不绕回，数值 dependency epoch 和 slot generation 不混用。

slot generation 每 epoch 最多改一次，由 pin 限制；Field dependency allocator 的 CPU submitted 上界与 submission epoch 在耗尽前触发 Field/Signal 协同完整 namespace restart。rare clear 位于同一 frame command、旧 GPU consumer 之后和新 lookup 之前；onFinished 才推进 CPU namespace，abort 保留待重建状态。in-flight ticket 带 namespace，旧 fence 不删除新 ticket。普通帧不清 Store 池。

## 成本与物理账

R=25,536，399 tiles/batch，最坏82 batches，mandatory field383,040/signal153,216 value slots不变。独立 admission 为51,072 fields/25,536 signals，hash131,072/65,536 slots。

Demand arena 从24,277,504B减少到3,757,312B。更正：当前R直接受完整656B record放入16MiB geometryHot配额约束，floor(16MiB/(656×64))=399tiles，不是geometry/setup的32MiB限制。物理 planner 包含 scratch retirement 和双输出预留，从508,657,088B变为467,616,704B。41,040,384B差额是预留账减少，不冒充实际 DRAM 带宽、帧时或已测收益。地址/证书/ref与预算映射由必需Phase5.5补齐；payload整块reset、稳定绑定/调度收口仍为Phase6。

diagnostic schema5 区分 cache request、probe、unique writer、committed admission、queue reject、实际 field/signal value 与 target closure count。snapshot 不再把 optional request/unique 当 mandatory 求值或 packet write 数；计时汇总纳入 radiometry envelope。probe/value统计只在 detailed 模式添加。

本次 F08/F09 修复不改变上述保留账与 5.5 责任。Smoke 的 Surface pass sum 已纳入实际 lookup/support 等标签；pass外 clear/copy 仍体现在 span/copy账，不能把pass sum称为全GPU span。

## 阶段检查

本次最终检查：typecheck/build/fresh build:test，18个targeted文件73项全部通过、无skip；37个demand/Store/canonical GPU用例；20个Lighting数值与4个provider用例；27-module六帧实际生产链；原1920×1080 Dungeon timing 3帧+独立detailed 1帧短smoke通过。

最终生产快照：HEAD=`0c8caf3046fee0f7022b89f3e47e39ef3cd833cd` + 本次dirty，889份源码/fixture组合SHA256=`f0dbe76cf435fd0ea9b441007064e9325db7c711b0ff8d19602538bb27c6e277`，保存在`.local/validation/phase5-canonical-source`。结果为`.local/validation/phase5-canonical-repair-4`、`phase5-production-canonical-repair`、`phase5-lighting-ior-validity`、`phase5-showcase-canonical-repair`；Lighting生产函数在后续canonical修复中没有变动。Smoke sourceDrift=false，errors/timestamp failures=0；通用counter drop=1，不能记全计数无丢样。

短diagnostic P50：CPU102.39ms、GPU pass sum441.548288ms、span488.644384ms、Surface430.462976ms。3帧不证明正式历史收益。最终detailed有效covered552598、background1521002；geometry552197、field values1545067、signal values1838619、overflow0。dense witness/proof/ref和reset成本仍交5.5/6，不能由计数正确推断物理表示已优化。

失败保留：原phase5-showcase-final报告缺finishedAt，不能转写为通过；原F08 GPU复现失败；fixture误用tile plan stride已按142word ABI修正；六帧fixture最初ORM/albedo合同错误分别核对独立纹理和sRGB decode后修正，未改生产输出/容差；首次canonical修复WGSL使用reserved `attribute`导致编译失败，局部改名后新鲜build:test及GPU回归通过。原报告保留，不吞异常。

原 stale publication 测试调用退休 `program()`；已改成实际 `encodeSurfaceFields` consumer，保留 PSO/resource set、abort/release/device-loss 检查，没有恢复旧生产 API。batch fixture 补充 texture mock 合同，生产不建立测试专用 fallback。

GPU任务串行运行，artifact 是 diagnostic、accepted=false。本机输出位于 `.local/validation/phase5-*`，不提交raw报告/生成WGSL/图片，不提升来源采用或claims。

## 未验收范围

Phase 6 reset/binding/完整lifecycle、Phase 7跨浏览器/全部 deformation/provider/材质组合、连续画质、同条件历史版本GPU P50/P95与正式来源/evidence/claim验收未实施。不依据短组件或smoke判断最终目标是否达成，也不承诺后续固定收益。
