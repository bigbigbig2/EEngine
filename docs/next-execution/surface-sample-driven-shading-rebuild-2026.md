# Surface 分频着色：实现重构执行顺序

日期：2026-09-30。状态：执行设计，未开工。唯一目标设计为 [Surface 可见性驱动分频着色](../next-design/surface-sample-driven-shading-final-2026.md)，来源入口为 [Next renderer ledger](../porting/next-renderer.md)。

## 执行原则

先消除普通 PBR 的逐像素重求值瓶颈。接受修改 Product/Cooker、材质发布、GPU 工作组织、Temporal 与 Frame Program 接线，允许删除旧 Surface 结构；不先单独排 IBL、原子、绑定缓存等小优化。

按下面四个完整重构阶段推进，不拆成几十个文档/门禁任务。阶段内持续编码、按需调试；大模块原理与生产链贯通后集中 typecheck/build/必要 targeted tests。正式 browser matrix、P50/P95 与 claims 仍遵循根 AGENTS 的最终验收节奏。实际编译失败必须修复。

当前 workstream 仍为 `virtual-geometry-lod-correctness`。本文不擅自标记其完成或覆盖正在进行的修复；真正进入 Surface 实施时，将当前模块状态如实写入 currentSlice，然后按本文连续推进，不要求另外创建 claim 或逐批同步文档才能编码。

## 阶段一：建立能够服务真实 PBR 的数据与逐像素事实

**目标：** 为 sample-driven Surface 提供足够便宜的连续性与变化依据，解除 motion 对完整 PBR 的依赖。只建立实际消费者需要的数据，不先搭完整长期 shading cache。

**实现范围：**

- 在现有 Geometry Product/Cooker 链发布 sharing domain、属性接缝与局部 variation/risk；明确 source corners → 各 LOD 输出 primitive 的映射/拒绝条件。必要时做一次 Product/recipe 版本切换、Native/WASM 一致实现和 recook，不长期维护双生产格式。
- 在 `GpuMaterialStore`、`GpuShadingMaterialAbi`、`TextureResidency` 发布采样签名、variation 与真实驻留版本，覆盖 UV transform/sampler/色域/normal/ORM 等语义；缺失风险采用明确 full-rate 行为。
- 重构 `TemporalFactsPass` / `temporal_facts.ts`，从 depth + instance + current/previous camera 直接生成 rigid motion；修改 Frame Program dependency，删除 `surface.motion` 的强制输入和重复产物。保留 sky motion、identity/reactive/validity 和 existing consumer 语义。
- 实现最小 `SurfaceProbe`/CPU reference 及计数，为候选 cell 恢复实际需要的 UV/几何风险；metadata 与 probe 的复杂算法按来源账本标记本地设计。

**涉及代码：** `assets/geometry-product/*`、`gpu/GeometryProductGpuAbiV1.ts`、`tools/oengine-asset-core/src/geometry/GeometryCooker.cpp` 及 WebCook/WASM 入口；`gpu/GpuMaterialStore.ts`、`gpu/TextureResidency.ts`；`render/temporal/*`、`shaders/temporal_facts.ts`；`render/program/FrameProgram*.ts`。

**阶段结果：** 至少一个真实 ordinary textured PBR 资产能够由当前 GPU 数据决定候选 rate，且 moving-camera motion 已独立于重材质求值。不得仅发布没有 consumer 的 buffer，或以常量 Unlit 证明普通 PBR 已具备降频。该阶段不做性能改善声明。

## 阶段二：切换唯一 sample-driven Surface 主链

**目标：** 让普通 PBR 的重材质与至少一组有实际成本的照明执行次数少于可见像素数，并将旧主路径直接替换。

**实现范围：**

- 重写 `SurfaceMaterialPass` 的算法职责为有限 Surface coordinator + Work Builder/worker/Resolve。8×8 tile、2×2 cell 支持 `1×1/2×1/1×2/2×2`，区分 winner 与 sharing identity；跨 primitive 的候选消费阶段一数据。
- 纯 full-rate、纯 uniform-rate tile 用隐式/descriptor 执行；混合与昂贵稀疏工作压紧样本。保持 profile/family 数固定且小，正确建立 sample/mask、result 索引与二维 indirect；不能简单恢复全员像素队列。
- 实现 tile 级提交、全部必要池预留、GPU finalize、partial reservation invalidation 和无额外 queue 依赖的 full-rate fallback。全屏高频/单 Coated profile/最坏混合都必须输出完整。
- 拆解 `surface_material_kernel`，保留材质、光照和 radiometry 算法；sample/full consumer 复用同一数学，重着色后不再顺便复制 motion。先优先同率融合，按需要共享 context/setup。
- 完成 coarse sample results → Resolve → HDR → 既有 presentation 链；在新主链能覆盖现有材质的同一个连贯切换中，删除旧 frequency pass、dense 内七 lane producer 和旧容量/输出 ABI。

**切换规则：** 新代码可在独立 oracle/harness 中开发，但生产入口只有一次替换，没有 old/new runtime toggle。新 full-rate worker 是同一体系的必要分支，不是旧 dense renderer 的保留副本。未接通前不把新 pipeline 标记已采用，接通后不为回退保留旧 owner。

**阶段结果：** ordinary PBR 的 material/lighting sample counters 实际减量；全率/粗率/背景/非法 key/overflow 都有唯一写域；moving camera 可正常输出。只有 Work Builder 或队列演示不算完成。

## 阶段三：完成分信号质量与有效 GPU 执行

**目标：** 避免“少算了样本，但仍浪费 waves／中间带宽／重建失真”，让跨三角形与真实材质场景成为完整可用能力。

**实现范围：**

- 完成 candidate probe/variation 查询、跨 primitive continuity、方向性 rates、代表位置与 footprint 的一致算法。未知属性和接缝留全率，但不能把所有典型 PBR 永久拒绝并宣称主线成功。
- 对 material 与 lighting 不同 rate 的真实收益需求，增加有限 compact signals/layout；保持 high-frequency albedo、emissive、normal、shadow/AO 和 sharp specular 的语义，必要时仅这些信号全率。检查 nonlinear coat/DFG/energy/AO 耦合，不能整图随意乘 mask。
- 正常 full-rate 直接最终写出，coarse Resolve 读取独立不可变 sample results；实现受限的身份/深度/信号边界重建，不读取正在写的 HDR，不照抄原地 UAV race。
- 打包有效代表样本，处理 mixed tile tail；材质保持足够 texture locality，照明保持 cluster/light-list 完整性。实际成本决定有限 kernel 拆分/融合，而不是先固定巨型 shader 或大 GBuffer。
- Geometry setup 只对有复用的实际需求构造；必要内容随主线完成，不单独打造全局大缓存项目。future normal/roughness consumer 通过需求合同增加字段，不默认物化全部。

**阶段结果：** 连续表面内部边、细纹理/发光线、normal map、Coated/金属、光照边界与运动均有明确处理；信号降频策略可观测，普通 PBR 实际 GPU consumers 已接通。此阶段不是临时画质补丁后另开第二套算法。

## 阶段四：完成模块清理、验证与后续交接

**目标：** 新架构成为唯一可维护的生产实现，集中完成模块验证，明确剩余测量与最终验收项。

**实现范围：**

- 清理旧 import、资源角色、planner/shader/ABI 和只断言旧路径的 tests；更新真正变化的 owner/current facts/source mapping。确认不存在 retired owner、额外 frame submit、GPU→CPU→GPU 本帧控制。
- 汇总尺寸/capability/profile 的容量预算，处理 resize、camera cut、scene/texture/Product 换代、device loss 与 GPU 延后销毁；检查 normal/motion/roughness 的真实 consumers 和 FrameGraph 依赖。
- 集中 typecheck/build/必要 targeted tests：原有 `surface-product-closure`、`surface-reconstruction-projected`、`temporal-fabric`、材质/Product ABI，以及新增的有意义 sample coverage、overflow、variation、重建与 motion oracle。改 Product 时包含 Native/WASM 需要的检查。
- 修实际编译/数学/覆盖问题，记录实际跑过与未跑过的范围。开发 GPU counters 可延后异步读回观察；不要为每个中间 commit 启动正式 browser/perf/evidence 全矩阵。
- 模块完成后更新 currentSlice/nextModules。正式画质、场景/设备矩阵、固定条件 GPU P50/P95 和 claim promotion 放在整体 Next 适当验收阶段；不把模块构建通过等同最终性能通过。

**阶段结果：** 生产主链完整、旧路径已切断、构建和必要测试通过、诊断能解释每类工作；未完成的正式验收如实列出。性能结论必须包含新增分析/probe/queue/Resolve 的合计成本与整帧，而不只看重 shader 单 pass。

## 之后按剩余瓶颈选择，不绑定首个重构

1. 如果同一表面的材质/间接项跨帧重复仍主导，再选一类对象/纹理空间或屏幕空间缓存 profile；稳定表面位置、view/lighting 依赖、footprint、失效、缺页/eviction 与 miss 路径完整后再实施，不直接缓存最终 PBR 颜色。
2. 如果局部求值仍占主要时间，再做 IBL 过滤、等价纹理采样、setup 更深共享、绑定缓存等小优化。
3. HZB/recovery、SSSR/GI、透明/体积等按既有 provider 顺序接续；它们不是 Surface 减样本的隐藏前提，不通过重复 renderer 实现。

## 实现时的三个停止误判

- **“分类器/队列做完了”不是模块完成。** 必须有普通 PBR 的实际 worker 减量、重建和完整 consumer。
- **“所有风险都 full-rate”不是性能成功。** 它是正确性底线，但典型 workload 的粗率覆盖不足要继续定位 continuity/metadata/probe 或策略成本。
- **“GPU ms 已少一点”也不能跳过正确性。** 缺页、边界、motion、曝光、Coated 或 overflow 漏算不是优化。

以上四阶段的规模按完整主链组织，不设置逐行、逐 pass 审批或实施前完整 benchmark 门禁。前期 35–65 人日仅为熟悉项目的资深工程师对选定 rigid opaque PBR 范围的粗估，非排期承诺；Product/质量未决项可能明显改变投入，各阶段与后续方案不机械相加。

本轮仅生成文档，以上阶段均未实施；未运行代码构建、GPU/浏览器或性能测试。
