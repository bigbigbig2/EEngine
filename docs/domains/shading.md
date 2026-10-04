---
id: shading
kind: domain
owner: shading
---
# Shading

## 当前事实与执行入口

核对日期：2026-10-04。重构前代码已保存为 **14c170785505b316c273a8aed0257fe22056b0d3**。本页描述该代码事实，不把待实施设计当作已实现。

- 总架构：[第三版原文](../next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)。
- 当前目标：[有界前端最终性能设计](../next-design/surface-work-v3-cost-bounded-final-refactor-design-2026-10.md)。
- 当前执行：[重构计划](../next-execution/surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md)与[进度/基线](../next-execution/surface-work-v3-cost-bounded-final-refactor-progress-2026-10.md)。
- 状态：Phase 0、Phase 1生产切换与阶段检查完成；当前待Phase 2。完整数值/画质/性能与来源采用仍未验收。

## 当前唯一生产链

~~~
Visibility / Depth / MeshletWork / Geometry source
  → SurfaceWorkRuntime
  → per-batch Geometry setup / facts / canonical addresses
  → Field value + certificate lookup
  → unresolved Geometry / Field certificates
  → Field classify / source binding
  → Signal value lookup / Signal classify
  → actual field miss / dirty signal demand + full-key dedup
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

当前前置查询是SurfaceFieldLookupPass与surface_field_request/lookup；20-word identity和68-word点见证由getter按实际依赖生成，完整比较而非hash命中。ValueHit与CertificateHit分开：值命中提供FieldRef；支持域证书可填入leaf bounds；未知仍走本批需求。

完整DAG/参数/纹理版本等由publication/field identity owner提供。Constant/Default/Transient/Store使用独立引用；GpuAppearancePublication复用实际compiler/resident sampler/Product闭包，只执行实际缺失字段需求。normal缺失不应使命中字段重新求值。

当前dense逐leaf查询、canonical/屏幕证书和宽见证成本仍高；本次新设计的廉价候选、受理proof、选择性缓存尚未实施。

### Geometry / setup

SurfaceCellGeometrySetup提供有界batch primitive setup；满表/容量不足仍可能由消费者内invocation-local直接解码。当前planner在run06配置下setup仅2655槽位，实际fallback量缺完整导出，不能宣称已证明主导耗时。

唯一SurfaceGeometryRecord当前为45×vec4=720B，包含14类center/X/Y等完整输入。Appearance/Lighting读取记录。新hot/cold、guaranteed local setup+memo和消费者隐藏decode删除尚未实施。

Product/LOD/source/seam、skin/morph/previous deformation的完整覆盖和验收仍是待核对范围，不将局部接线/fixture推广为全部功能完成。

### Lighting / SignalStore / reconstruct

独立信号为Ddirect、Denv、Sdirect、Senv、coat direct、coat environment；emissive和compose输入独立，不合并为所有lobe同率大包。

当前Ddirect仍是原生产BRDF已着色radiance；Denv是irradiance，颜色/1π在compose应用。原specular/coat/IBL与真实cluster、VSM、AO、环境provider保留。最终设计的Ddirect factorization尚未实施。

Signal identity按真实选中FieldRef构造；Published Store slot/generation与publication token区分。持久signal/value复用不等于空间共享许可，也不是TemporalFacts基础motion/identity的替代。

SurfaceReconstructionPass只消费refs/results/TemporalFacts及合成输入，不重新解码三角形或执行完整材质/PBR。epoch/generation、reserve/publish和提交完成退休属于对应Store/资源owner；完整lifecycle/质量矩阵仍待验收。

## 已有诊断与已知性能问题

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
| Publication | dependency/cost/proof profiles、精确DomainRecipe、真实依赖缩减 |
| Work/classifier | active tiles、implicit/uniform/mixed、固定空间树、删除pair/member搜索 |
| Query/proof | CandidateKey/ValueWitness/SharingCertificate分离；受理预算与复合误差 |
| Geometry | 唯一hot/cold记录、local保证/memo、删除consumer直接decode |
| Demand/store | 选择性dedup/admission、满表transient完整覆盖、mask/template需求 |
| Lighting | Ddirect因子分离及前端key/rate/proof同步，独立provider风险 |
| Runtime | 最坏mandatory容量、必要reset、稳定bindings、合法pass合并和retire账 |
| 验收 | 完整数值/coverage/lifecycle/连续质量/同条件历史版本比较 |

Geometry/visibility保留winner、source、连续域和当前选中产品；material/texture owner保留compiler、publication、residency与版本；shading拥有SurfaceWork/FieldStore/SignalStore及worker；frame-runtime统一图、提交和背压；temporal拥有唯一基础时域事实。Loader不创建长期GPUowner。

来源见[Next porting ledger](../porting/next-renderer.md)。原数学/固定来源可复用，但复杂新阶段实施前核读完整依赖，不能从旧组件结果直接提升新主链adoption。稳定ABI在真实实现收敛后再写specs/contracts。
