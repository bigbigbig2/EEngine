---
id: shading
kind: domain
owner: shading
---
# Shading

## 当前事实与执行入口

核对日期：2026-10-05。重构前代码已保存为 **14c170785505b316c273a8aed0257fe22056b0d3**。本页描述当前 Phase 4 源码事实；14c17078 的旧布局与诊断另列为历史基线。

- 总架构：[第三版原文](../next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)。
- 当前目标：[有界前端最终性能设计](../next-design/surface-work-v3-cost-bounded-final-refactor-design-2026-10.md)。
- 当前执行：[重构计划](../next-execution/surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md)与[进度/基线](../next-execution/surface-work-v3-cost-bounded-final-refactor-progress-2026-10.md)。
- 状态：Phase 0–4当前生产切换与阶段检查完成，Phase 2原判定不足已更正；当前待Phase 5。完整数值/画质/性能与来源采用仍未验收。

## 当前唯一生产链

~~~
Visibility / Depth / MeshletWork / Geometry source
  → SurfaceWorkRuntime
  → single coverage / ActiveTileList / actual batch ranges
  → guaranteed local setup / committed frame memo / facts / point addresses
  → bounded Field candidate + ExactPoint / admitted support validation
  → shared-budget Geometry / Field proofs
  → Field classify / source binding
  → Signal value lookup / Signal classify
  → actual field miss / dirty signal demand + eligible bounded dedup
  → unique GeometryRecord
  → missing Appearance closure / dirty Lighting
  → independent FieldStore / SignalStore publish and references
  → cheap reconstruct → HDR / reactive
  → Sky / Aerial / FSR3 / display
~~~

SurfaceCellClassifierPass 是当前前端composition入口，SurfaceDemandPass组织实际生产需求；SurfaceGeometryPass是唯一完整GeometryRecord producer；SurfaceLightingPass/SurfaceLightingWorkPass、SurfaceStorePublishPass、SurfaceReconstructionPass各有真实消费者。

退休的SurfaceMaterialPass/Probe、旧Appearance/SparseLighting协调器、旧Material/Geometry cache owner不是当前入口。不能根据2026-10-02历史描述恢复它们或四路dense history。

## 已实现事实

### Appearance / FieldStore

当前 SurfaceFieldLookupPass 以 8-word candidate hash 定位，匹配时完整比较 20-word 身份与必要 6-word UV C/X/Y（key 上限32words）。完整静态 interning、数值版本、纹理/content epoch、实例/表示/LOD/side/deformation、质量策略 token 均保留；不合该 profile 的 witness 走完整 DirectTransient。

Constant/Default 公式 ref、ExactPoint、ConstantDomain/BoundedDomain 与空间证书独立。detailed support 在获准队列中使用唯一 setup/原 interval 数学；PendingValidation 完成后每 leaf 单一 commit。点值命中不保证 quad 证书。support/Geometry/Field families 共用 R/2 slots；64 bound SSA nodes、4 queries、32 mip/level/payload visits、8 risk lights 上限，超限完整 Unknown。

Field identity 9 words，epoch word7 与 profile 地址 word8 分域。FieldStore 实际256B/entry，全部生产 reader/writer 已切换；错误版本、Reserved/域外或预算满不读取未发布值。Field/Signal hash 满不扫描全 request stream，未接纳者自己的 transient 工作仍完整。实际缺失闭包和原 sampler/Product 计算保留。

### Geometry / setup

SurfaceGeometry owner 以固定 64-key run/prefix 保证 local slots，逐 leaf 显式 SetupRef；uniform winner 直接分组，consumer 完整 decoder 与 primitive 前序扫描均已删除。frame memo 实际查询/publish/commit，满表仍完成 local 输出。

唯一 Geometry product 为128B hot header与按 union append的cold池，同一buffer、一个writer。14种输入C/X/Y完整保留，三个同源alias物理共用；最坏cold528B，总预留656B/target。Appearance读取cold offset/rank，Lighting读取hot输入；f32精度保留。

Product/LOD/source/seam、skin/morph/previous deformation的完整覆盖和验收仍是待核对范围，不将局部接线/fixture推广为全部功能完成。

### Lighting / SignalStore / reconstruct

独立信号为Ddirect、Denv、Sdirect、Senv、coat direct、coat environment；emissive和compose输入独立，不合并为所有lobe同率大包。

当前Ddirect仍是原生产BRDF已着色radiance；Denv是irradiance，颜色/1π在compose应用。原specular/coat/IBL与真实cluster、VSM、AO、环境provider保留。最终设计的Ddirect factorization尚未实施。

Signal identity按真实选中FieldRef构造；Published Store slot/generation与publication token区分。持久signal/value复用不等于空间共享许可，也不是TemporalFacts基础motion/identity的替代。

SurfaceReconstructionPass只消费refs/results/TemporalFacts及合成输入，不重新解码三角形或执行完整材质/PBR。epoch/generation、reserve/publish和提交完成退休属于对应Store/资源owner；完整lifecycle/质量矩阵仍待验收。

## 当前阶段验证与性能边界

详见[Phase 4实施记录](../next-execution/surface-work-v3-cost-bounded-final-refactor-phase4-implementation-2026-10.md)：52 targeted tests；固定树、parent、实际DomainKey/provider/Field→Signal source真实GPU检查；26 module生产链和两个Store实际消费；Showcase短smoke通过。累计generic counter drop=1，采样detailed的计数和Surface coverage产品完整；不把短诊断提升为正式收益/目标判定。

当前classifier仅16 quad、4 parent、1 root，每节点四child；parent合并完整范围并转换plane residual再判预算。DomainKey与并行prefix直接source map替换pair/member/代表线性搜索；相同node/coverage的direct provider风险有界共用，kind4 proof与全部family共用R/2预算。

当前R25536、399 tiles/batch、最大82batch，真实GPU active ranges裁空；retirement计入planner及owner配额。共同Workspace输出、mask/template worker、Ddirect factorization、payload reset、bindings与lifecycle仍由Phase5–6切换/收口。最终性能和完整质量尚未验收。

## 历史基线诊断与问题

run06为本机diagnostic，非正式accepted evidence：
GTX1650Ti、Chrome154、1080p Dungeon overview、AO/FSR3/Bloom开、VSM/jitter关、exposure4。30个GPU timing样本；独立detailed/movement完成。GPU pass sum P50约801.7ms，Surface约790.4ms，frame span约867.4ms。

- 两份classifier约299.8ms，certificate约155.5ms，Field/Signal lookup约183.7ms。
- 实际可见552598像素，非全屏2M可见；常量/空leaf分支不能当完整probe。
- capacity23296 targets，90batch；GeometryRecord720B。
- Workspace+Demand整块clear累计范围约4.73GiB/frame，非已测DRAM流量或pass内耗时。
- actual missing closure/dirty signal后半段已稀疏，不能据此宣称前端成本消失。
- setup fallback、certificate query、实际流量等缺计数，按新计划补齐。

详细身份/指标/局限见执行记录和设计§2。既有步骤1–4小链测试不能证明当前整帧目标完成；run06 accepted=false不能提升claims。

## 新重构待实现与owner边界

| 方向 | 尚待实现 |
|---|---|
| Publication | 画像/真实依赖已实施；随后继consumer合同更新 |
| Work/classifier | 固定树/pair-member切断及source map已实施；Phase5 consumer工作表示收口 |
| Query/proof | 分离/总预算及树consumer已实施；完整质量/准入校准待验收 |
| Geometry | 本轮切换已实施；完整deformation/生命周期组合验证 |
| Demand/store | 前置bounded失败覆盖已实施；Phase5 mask/template与worker完整切换 |
| Lighting | provider风险共享已实施；Ddirect因子分离及前端key/rate/proof同步待Phase5 |
| Runtime | 最坏mandatory容量、必要reset、稳定bindings、合法pass合并和retire账 |
| 验收 | 完整数值/coverage/lifecycle/连续质量/同条件历史版本比较 |

Geometry/visibility保留winner、source、连续域和当前选中产品；material/texture owner保留compiler、publication、residency与版本；shading拥有SurfaceWork/FieldStore/SignalStore及worker；frame-runtime统一图、提交和背压；temporal拥有唯一基础时域事实。Loader不创建长期GPUowner。

来源见[Next porting ledger](../porting/next-renderer.md)。原数学/固定来源可复用，但复杂新阶段实施前核读完整依赖，不能从旧组件结果直接提升新主链adoption。稳定ABI在真实实现收敛后再写specs/contracts。
