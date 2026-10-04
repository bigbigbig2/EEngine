# SurfaceWork Runtime V3 直接重构执行计划

> 2026-10-04 状态：初版V3阶段历史，非当前实施入口。请按[有界前端执行计划](surface-work-v3-cost-bounded-final-refactor-execution-2026-10.md)和[进度记录](surface-work-v3-cost-bounded-final-refactor-progress-2026-10.md)推进。本文原Phase完成状态不转授新阶段；当前每阶段检查范围按新计划§1执行，不直接照搬旧用例/提交要求。

> 2026-10-03 后续计划：新增[第一版优化执行文档](surface-work-v3-optimization-v1-execution-2026-10.md)，对应[优化设计](../next-design/surface-work-v3-optimization-v1-design-2026-10.md)。后续重构按该细化计划替换初版物理方案；本页保留原阶段记录。用户已要求逐 Phase 完整实施、检查并每阶段一次提交，新计划进度以该执行文档为准。

更新：2026-10-02。状态：Phase 0–6 的生产主链和生命周期接线已完成；Phase 7 的统一编译、数值、浏览器、画质和四版本性能验收尚未开始。

唯一目标依据是用户指定的 [EEngine 第三版最终重构设计](../next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)。该文件按原文纳入，本文只把其 §4–§11 转成工程执行顺序，不另设快路径优先、旧 Signal-Rate 回退或新的性能百分比门槛。整体保留边界见 [整体架构](../next-design/eengine-next-overall-architecture-final-2026.md)，当前切片见 [workstream](../../project/workstreams/active/eengine-next-clean-rebuild.yaml)。

## 1. 当前事实与三个必改点

源码核对基线为当前工作树（历史切断基线仍为 `e7296be9`）。旧 SurfaceMaterialPass/Probe/sample producer 已从生产链删除；当前 FrameProgramLowering 实际连接的是 Visibility/TemporalFacts → SurfaceWorkRuntime（classify、publication lookup、GPU-only geometry miss queue/indirect resolve、GeometryRecord、publication miss evaluation、cluster/VSM/AO/IBL 输入、signal-mask packet、signal/identity/age history reconstruct）→ Sky/Aerial/FSR3/显示。运行时全局 environment/light/VSM revision reject 已接入；完整 footprint 语义、按 signal 选择性失效和 Phase 7 验收仍未完成。

当前源码已切断全有效像素 Appearance demand、独立 geometry inputs 和旧 SparseLighting prepare_surface；SurfaceWork 已注册 tile/sample lookup、implicit/uniform/mixed classify、bounded sample/exception、GPU-only geometry miss queue/indirect resolve、唯一 GeometryRecord、命中 geometry cache、真实 publication miss evaluation、signal-mask 独立 packet/counter、生产 clustered/VSM/AO/IBL provider 和 signal/identity/age history reconstruct 的生产边。sampler/UV/filtered footprint key、按 signal 的 revision invalidation 和性能闭环仍未完成，不能据此宣称最终算法或性能已经完成。

最终完成条件（不是当前源码事实）必须同时满足：

1. 全像素 Appearance task → SurfaceWork sample/cache lookup → MaterialMissQueue。
2. Appearance geometry inputs + SparseLighting prepare_surface → 唯一 SurfaceGeometryRecord producer。
3. 重 reconstruct → packet/history 选择、signal 合成、AO/energy/pre-exposure 和输出。

当前结构接线已完成的部分不会提升上述算法完成度。既有源码缺口仍包括 skin/morph 与 previous deformation、Product 跨 LOD/source/seam 对应、屏外 VSM caster、nonlocal/provider 输入和完整透明 composition；不得删除缺口记录后宣称完成。

## 2. 最终生产合同

```text
GPU Scene / Geometry Product / Material Publication
  → VisibilityKey / Depth / MeshletWork
  → PixelFacts + SurfaceAddress
  → SurfaceWorkBuilder: implicit / uniform / mixed / bounded exceptions
  → 一次 SurfaceGeometryRecord 发布
  → Appearance lookup → 仅 miss compact/evaluate/publish
  → diffuse / specular / coat / IBL signal work + temporal reuse
  → 廉价全分辨率 reconstruct
  → HDR / Sky / Aerial / FSR3 / Radiometry / Bloom / Present
```

原文的阶段顺序描述所有权和依赖，不许可把 cache lookup 再放回全像素 geometry/material heavy worker 之后。实现需明确 lookup 所需的廉价地址/footprint 与重几何输入的边界，满足原文 §4.4、§10.1、§11 的命中项绕过要求；不能用第二套 geometry producer 解决依赖。

- Winner identity、Sharing identity、Cache identity 分开；frame-local VisibilityKey 不作跨帧 cache key。
- 纯 full-rate tile 不写 64 条 pixel task，uniform tile 不写完整 pixel-to-sample 映射，mixed tile 只写必要 mask/sample。
- GeometryRecord 是唯一 Surface 几何事实。Appearance 和 Lighting 不再各自恢复三顶点、重心、UV、法线和切线。
- constant/static product、stable local cache、dynamic/view/nonlocal 三类分开；第三类进入本帧 work 或信号 history。
- Hash 只索引，完整 key 比较才证明 cache identity。
- Material、diffuse、specular/IBL、coat 的 rate 与 exception 独立；normal/ORM/镜面风险不能强制整个材质和全部 signal 全率。
- Direct 共享必须兼容 tile/cluster/normal/shadow 条件，不跨 cluster 借 light list；边界进入最终 bounded full-rate exception。
- DFG 只对需要的 specular packet 求值；diffuse irradiance 按 tile/normal group 复用，prefiltered environment 按 roughness/reflection direction 组织；环境变化只失效相关 signal。
- AO 保持独立 producer，不清空无关材质缓存。
- TemporalFactsPass 是唯一 motion/identity/validity/reactive 基础 owner；Surface 不发布第二套 motion。
- reconstruct 不解码 Geometry Product，不运行完整 Appearance graph，不读取 normal/ORM 重做完整环境 BRDF。
- FrameGraph 显式看到 work、GeometryRecord、cache request/publish、packets、primary radiance、history/reactive 和 HDR 的真实资源边。
- 保留唯一 Renderer、唯一 frame submit；不加本帧 GPU→CPU→GPU work control，不保留旧/新运行桥梁。

## 3. Phase 0–7：一个连续实施整体

Phase 是依赖顺序，不是逐阶段审批、编译或测试门禁。按根 AGENTS 的 Surface 覆盖规则先切断被替代的执行模型，允许中间未编译、缺图或缺消费者；Phase 1–6 不运行 typecheck/build/targeted tests/GPU oracle/browser/benchmark/verify。复杂算法实施前仍完成固定来源核读；来源采用、实现完成、验收通过分别记录。

### Phase 0：固定基线和比较口径（已完成）

保留原文三组 revision：9/25 `89f0a94`、中间版 `15f12f7b`、第三版 `e7296be9`；完成后的最终版另固定 revision。以 GTX 1650 Ti、1080p 复杂场景为首要目标，固定内部/输出尺寸、camera path、环境、AO/VSM/FSR3/Bloom、adapter、浏览器、warm-up、温度/时钟/降频状态及 P50/P95 口径。

此时整理基线身份和采集配置；权威配置见 [`surface-work-v3-phase0-baseline.yaml`](../../validation/profiles/surface-work-v3-phase0-baseline.yaml)，记录见 [`Phase 0 基线`](../performance/2026-10-02-surface-work-runtime-v3-phase0-baseline.md)。正式四版本采样在 Phase 7 集中进行，使用独立 checkout/validation 宿主，不在生产工程恢复旧 Renderer。旧交互式数字和跨设备结果不能代替同条件比较。Phase 0 没有运行 GPU/browser 采样，也没有产生性能 claim。

### Phase 1：删除旧 Surface 执行模型（已完成）

核对旧 Pass/Probe/sample queue/generic worker/full-screen closure 已删除的事实；删除仍实际存在且被新链替代的 Appearance pixel-task machinery、独立几何 producer 和旧消费接线。同步处理 FrameProgram/Lowering、SurfaceProducts、ABI/counters 和仅服务被删除实现的 fixture。

保留最终需要的数学、资源 owner 和 GPU 产品；不建立 adapter、空 provider、旧 consumer 或兼容测试桥。已删除旧 Surface pass、独立 geometry input shader 与旧 FrameProgram owner 接线，并停止 publication 创建旧 frame task/result/geometry work buffer；Phase 1 未运行编译、测试或 GPU/browser 验证。

### Phase 2：统一 SurfaceWork 与 GeometryRecord（实现完成，验收待做）

实现 SurfaceWorkHeader、TileDescriptor、SampleRecord、ExceptionRecord、CounterBlock 的固定前缀和分区；为 implicit/uniform/mixed work 明确覆盖、写域、容量与二维 indirect。

已加入 `GpuSurfaceWorkAbi.ts`、`SurfaceWorkRuntime.ts` 和 `SurfaceGeometryPass.ts`，classify 现在以 64-lane workgroup 扫描每个 8×8 tile，发布 implicit/uniform/mixed 分类、bounded sample/exception、GPU sample counter、indirect args 和 per-pixel sample map；GeometryRecord 读取动态 sample count、MeshletWork、FrameGeometry、FrameAttributes、FrameInstances、asset heap、vertex payload 和 camera，发布真实位置/法线/切线/UV/导数/身份/signature。Product/形变对应仍有缺口，数值、容量、浏览器和性能验收尚未运行；Phase 2 实现完成，验收待 Phase 7。

### Phase 3：Appearance 改为 miss-only demand（publication kernel 与 geometry hit bypass 已接通，验收待完成）

扩展现有 AppearanceGraphCompiler 输出 constant/static/stable-local/geometry/view/nonlocal、signal rate、full-rate requirement、texture variation 和可融合属性；不建立第二套材质系统。

`SurfaceMaterialCachePass` 在 GeometryRecord 之前执行 publication identity lookup，GPU 为每个 program 维护 bounded miss counter/indirect args；publication identity 现在区分纯 material/static 程序与依赖 geometry、纹理 footprint、dynamic/view/nonlocal 的程序，后者显式禁止稳定 cache 命中；稳定程序的 identity 纳入 sampler、wrap/filter、decode、UV transform、fallback、range 和纹理 revision。lookup 同时读取已发布材质 header，按 closure/texture feature 发布 diffuse/specular/coat/IBL signal mask，并把 normal/ORM/specular 或不稳定程序标记为局部 full-rate exception。`GpuAppearancePublication.encodeSurfaceMissEvaluation` 复用已发布的 `AppearanceResidentKernel`、constants、routes、runtime inputs、resident texture/product bindings，按 miss program 求值并写回六层 fields 与稳定 cache。缓存 key 现在保留 hash、publication identity、版本、geometry/meshlet/instance/primitive 全字段比较；`SurfaceGeometryPass` 命中直接发布 GeometryRecord，miss 压入 bounded queue 后由独立 indirect resolve 执行 winner 插值和属性解码。仍缺非稳定程序的完整 filtered footprint identity、材质 view/nonlocal 语义、Product/形变与正式验收。

### Phase 4：分 signal lighting packets（生产接线完成，统一验收待做）

DiffuseLightingWork、SpecularLightingWork、CoatLightingWork 使用 GeometryRecord、material field address、cluster/light identity、shadow/environment revision 和 history reference。Direct、diffuse、specular、coat、IBL 分别可观测，不以单一 Surface rate 代替。

`SurfaceLightingWorkPass` 现在消费 `LightClusterFrame`、`ShadowVisibilityFrame`、XeGTAO packed visibility 和 authored/physical IBL 资源，直接复用 `lighting_direct.ts` 的 clustered directional/point/spot BRDF、clearcoat 和 VSM 分支，并通过 `APPEARANCE_SURFACE_READ_WGSL` 按逻辑字段读取材质。Kernel 先读取 sample signal mask，只执行被请求的 direct/IBL lobe，Diffuse、specular、coat、IBL 保持独立写域；lighting counter 覆盖 packet、direct/IBL evaluation、AO/VSM/full-rate/overflow/bytes/dispatch 诊断，AO 只进入环境 diffuse/coat signal；旧 `prepare_surface` 已删除。完整 view/footprint identity、按 signal 的 revision invalidation 和最终 GPU/画质验收仍待 Phase 7。

### Phase 5：廉价 reconstruct（生产接线完成，统一验收待做）

`SurfaceReconstructionPass` 只读取四类 packet、TemporalFacts mask/identity、pre-exposure 和四路双缓冲 signal history，按全分辨率映射合成 HDR/reactive；GeometryRecord 已从 reconstruct 绑定移除，逐像素 identity 比较、8 帧 age 上限、camera cut reject、运行时 environment/light/VSM revision mask 与 GPU completion 后交换由 SurfaceWork 生命周期管理。environment 变化失效全部 signal，light/shadow 只失效 direct 相关 signal，未变化的 signal 独立复用历史。它不重新解码 Geometry Product 或执行材质 graph。能量守恒对照和连续画质仍待 Phase 7。

### Phase 6：全链与生命周期（生产接线完成，统一验收待做）

SurfaceWorkRuntime 已纳入 RendererCore 的 prepare/commit/abort/destroy；reconstruct 读取 TemporalFacts reactive mask 与 identity，signal/identity/age history 在 GPU completion 后交换，resize 进入 retire 队列，仍沿用 FrameCoordinator 的单一 submit 与最多两个 in-flight 背压。Environment/VSM/AO 的 FrameGraph 依赖已显式注册，environment/light/VSM 全局 revision reject 已接入；按 signal 选择性失效、camera cut/device recovery 和故障矩阵仍待 Phase 7。

资源分类沿用原文 §7：publication、frame persistent、frame transient、output/history 各有 owner/accounting/retire point。创建前协商 buffer、workgroup、dispatch、binding、texture/storage limits；pipeline/bind group/sampler 在 publication/profile 阶段缓存，不按材质实例或纹理组合建立独立 PSO。

Overflow 不发布不完整 work，记录 diagnostic/counter，由当前 tile/signal 的最终 bounded full-rate 分支完整覆盖；不交给旧 queue，不通过第二次 CPU 控制 submit 修补。

### Phase 7：集中验证与残留清理（尚未开始）

Phase 7 必须在当前 Surface 主链和文档缺口全部收口后统一运行 `typecheck`、`build`、`build:test`、shader audit、CPU/WGSL oracle、浏览器生命周期、连续画质和四版本性能矩阵。此前 revision 的局部编译或中止记录不作为当前提交的验证证据；在本轮 Phase 7 开始前不得宣称通过。

后续 SSSR、GI、VT、Transparency/Media 保持独立模块；不能用它们未完成推迟本次 Surface 专项验收，也不能将其完整效果宣称为 Surface 已实现成果。

## 4. Owner 与文件调整

| 边界 | 保留资产 | 最终职责/入口 |
| --- | --- | --- |
| frame-runtime | RendererCore、FrameCoordinator、FrameProgram、FrameGraph | composition、真实资源边、唯一 submit、事务与恢复 |
| visibility / geometry | PackedVisibility、FrameGeometryArena/Vertices、WinnerPrimitiveInterpolation、VG residency | winner/depth/shared geometry 数学；不拥有材质 cache/history |
| shading | 当前 Appearance/SparseLighting 的正确数学与产品 | SurfaceWorkRuntime、SurfaceGeometryPass、SurfaceMaterialCachePass、SurfaceLightingWorkPass、SurfaceReconstructionPass |
| materials-textures | compiler、GpuMaterialStore、TextureResidency、AppearanceProgramRegistry、AppearanceStaticResidency | 编译分类、稳定字段/版本、物理 residency、publication 与安全退役 |
| temporal | TemporalFacts、TemporalFabric、FSR3 owners | 唯一基础 facts；signal owner 保留专用拒绝/重建 |

建议文件名完整沿用原文 §5.3：`GpuSurfaceWorkAbi.ts`、`SurfaceHistoryAbi.ts` 和 `surface_work_classify.ts`、`surface_work_compact.ts`、`surface_geometry_resolve.ts`、`surface_material_cache.ts`、`surface_lighting_packets.ts`、`surface_reconstruct.ts`。这些目前是计划入口，不表示文件已创建或 ABI 已冻结；稳定后再写精确 specs/contracts。

## 5. 集中验收范围

原文 §8.1 的 24 个 counters 全部纳入：visible pixels；implicit/uniform/mixed tiles；GeometryRecord/overflow；material hit/miss/evaluation；diffuse/specular/coat/IBL packets；full-rate exceptions；history hit/reject；IBL/direct evaluation；AO/VSM reject；work overflow；bytes written；dispatch count。计数不能代替总 GPU 成本。

场景按原文 §8.2：远景/近景、静止/平移/旋转、低频与高频 normal/ORM、多材质 tile、强 IBL、Direct+VSM、AO on/off、Product LOD/page miss、空场景/单 Product、device recovery。四版本固定同条件，同时报告 Surface 所有阶段成本、整帧 GPU P50/P95、必要 CPU 成本、内存和连续画质；不承诺固定 FPS 或百分比。

AAA 不变量完整沿用原文 §9：透视/near clip/退化、非均匀缩放、镜像/双面/tangent sign、UV/transform/wrap/filter/LOD/gradient、颜色与 normal/ORM 解码、roughness/coat/energy、cluster/VSM/environment、pre-exposure/jitter/motion/reactive、identity/disocclusion/alpha coverage。透明与多层覆盖归独立 composition domain。

### 完成定义：原文 §11 的 16 项

- [x] 旧 SurfaceMaterialPass 和中间版 sample producer 删除并复核。
- [x] production import graph 不再引用旧 Surface owner。
- [ ] VisibilityKey 仅由 Visibility/SurfaceWork 入口解析。
- [x] GeometryRecord 成为唯一 Surface geometry producer。
- [x] Geometry miss 使用 GPU bounded queue 和 indirect resolve 独立压缩。
- [ ] Geometry hit 使用完整 view/footprint identity。
- [x] cache lookup 位于 material miss compact 之前。
- [x] cache hit 不进入 geometry/material heavy worker。
- [x] direct、diffuse、specular、coat、IBL 有独立 signal work。
- [x] normal/ORM/镜面 full-rate 是局部例外。
- [x] SparseLighting 不重复恢复 geometry。
- [x] reconstruct 不重新执行完整 PBR。
- [x] TemporalFacts 是唯一 motion/identity 基础 producer。
- [x] FrameGraph 能看到真实 SurfaceWork 边界。
- [x] 所有 queue/indirect dispatch 有 bounded overflow 语义。
- [x] counters 能区分 hit/miss、signal evaluation、exception、IBL 和 overflow；packet plane 写入在生产 kernel 未提供独立计数时明确标记 unknown。
- [ ] 四版本同条件比较完成。
- [ ] 近景/高频/运动/AO/VSM/IBL/Product LOD 画质和性能验收完成。

清单中的未完成项仍保持未勾选；文档对齐不等于 runtime 完成。原文 §8.3 的工作量、命中、IBL、局部例外及质量成功标准全部保留，不沿用旧计划的固定 50%/30% 门槛。
