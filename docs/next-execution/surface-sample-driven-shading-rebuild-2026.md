# Surface 分频着色：实现重构执行顺序

2026-10-01：本文转为旧实现历史执行记录；当前重构执行入口为 [缓存 Surface 与稀疏照明](surface-cached-shading-rebuild-2026.md)。旧阶段完成不证明新设计要求完成。

日期：2026-09-30。状态：阶段一至四已完成；正式整体验收待执行。唯一目标设计为 [Surface 可见性驱动分频着色](../next-design/surface-sample-driven-shading-final-2026.md)，来源入口为 [Next renderer ledger](../porting/next-renderer.md)。

## 执行原则

先消除普通 PBR 的逐像素重求值瓶颈。接受修改 Product/Cooker、材质发布、GPU 工作组织、Temporal 与 Frame Program 接线，允许删除旧 Surface 结构；不先单独排 IBL、原子、绑定缓存等小优化。

按下面四个完整重构阶段推进，不拆成几十个文档/门禁任务。阶段内持续编码、按需调试；大模块原理与生产链贯通后集中 typecheck/build/必要 targeted tests。正式 browser matrix、P50/P95 与 claims 仍遵循根 AGENTS 的最终验收节奏。实际编译失败必须修复。

当前 workstream 的 currentSlice 已完成 Surface 阶段四。既有 Virtual Geometry 画质/LOD 问题保持未验收；本次 Surface 重建不证明这些问题已经修复。正式画质、GPU 加速和整链性能仍按最终验收节奏处理。

## 阶段一：建立能够服务真实 PBR 的数据与逐像素事实

**目标：** 为 sample-driven Surface 提供足够便宜的连续性与变化依据，解除 motion 对完整 PBR 的依赖。只建立实际消费者需要的数据，不先搭完整长期 shading cache。

**实现范围：**

- 在现有 Geometry Product/Cooker 链发布 sharing domain、属性接缝与局部 variation/risk；明确 source corners → 各 LOD 输出 primitive 的映射/拒绝条件。必要时做一次 Product/recipe 版本切换、Native/WASM 一致实现和 recook，不长期维护双生产格式。
- 在 `GpuMaterialStore`、`GpuShadingMaterialAbi`、`TextureResidency` 发布采样签名、variation 与真实驻留版本，覆盖 UV transform/sampler/色域/normal/ORM 等语义；缺失风险采用明确 full-rate 行为。
- 重构 `TemporalFactsPass` / `temporal_facts.ts`，从 depth + instance + current/previous camera 直接生成 rigid motion；修改 Frame Program dependency，删除 `surface.motion` 的强制输入和重复产物。保留 sky motion、identity/reactive/validity 和 existing consumer 语义。
- 实现最小 `SurfaceProbe`/CPU reference 及计数，为候选 cell 恢复实际需要的 UV/几何风险；metadata 与 probe 的复杂算法按来源账本标记本地设计。

**涉及代码：** `assets/geometry-product/*`、`gpu/GeometryProductGpuAbiV1.ts`、`tools/oengine-asset-core/src/geometry/GeometryCooker.cpp` 及 WebCook/WASM 入口；`gpu/GpuMaterialStore.ts`、`gpu/TextureResidency.ts`；`render/temporal/*`、`shaders/temporal_facts.ts`；`render/program/FrameProgram*.ts`。

**阶段结果：** 至少一个真实 ordinary textured PBR 资产能够由当前 GPU 数据决定候选 rate，且 moving-camera motion 已独立于重材质求值。不得仅发布没有 consumer 的 buffer，或以常量 Unlit 证明普通 PBR 已具备降频。该阶段不做性能改善声明。

### 阶段一收口记录（2026-09-30）

本次仅完成阶段一，实施事实如下：

- GeometryCooker/SurfaceMetadata 在源完整属性角点与双向流形边上划分域；域 ID 在一个资产内不冲突。各 LOD 输出角点回查源域，缺失/歧义/跨域/退化/错误朝向/双面拒绝共享。Group bit 6 发布 32-byte primitive metadata，含 domain/risk、normal/color variation 与 UV0/UV1 span。完整 payload 按 256 KiB page 和 128 meshlets 切分；简化候选也检查新增 metadata 容量。
- recipe 切换为 static-pbr-page-local-f32-surface-v5；Native 和两种 WASM 共用同一实现，产物已重建并同步哈希，旧 recipe 产品须 recook。不新增第二条生产几何或 renderer 路径。
- ShadingMaterial ABI v7 的 64-byte role route 发布采样签名、decoded 全 mip 保守区间、residency slot/revision；签名覆盖现有 UV transform/sampler/role 等 packed 语义。TextureResidency 唯一拥有版本表，新增/复用/promotion 发布单调 revision，abort 不提交版本，销毁和记账接通。旧 route 与新 promotion revision 不符时 full-rate，直到新的材质 publication。
- SurfaceProbe 的 8×8/64 invocations 恢复当前 winner 的透视 UV、法线、顶点色与 metadata，9216-byte workgroup facts 经无条件 barrier 供四角判断；输出 1×1/2×1/1×2/2×2 候选及 16 个 GPU counters。CPU reference 对照受控 PBR cell；候选已被当前 frequency planner 读取，但预留位不改变 PBR 的全率重着色。计数区分 pixels/recoveries、cells/rates、pair 拒绝与跨 primitive 通过。
- 默认具名预算全零。RGBA8 可读来源使用保守区间，raw sRGB→RGBA8 resize 的量化误差纳入边界；压缩/不可读来源 unknown、normal-map 缺少切线变化证明、Coated/mask、非法身份、接缝、非均匀/镜像变换、代际或 residency 不符均保守 full-rate。受控 GPU oracle 的非恒定纹理预算不是最终画质阈值，不声称 bit-exact 或典型场景普遍可降频。
- Temporal Facts 从 depth/instance/current+previous camera 独立恢复 rigid motion；sky rotation 分支保留。Surface 不再发布 motion attachment/binding/product，Frame Program 不再要求 surface.motion。identity/reactive/validity 保留，并把实际 texture residency revision 纳入身份。

实际验证：typecheck/build 通过；131 项定向 Node checks 通过；Native Cooker build/ABI oracle、portable-single 与 pthread WASM 构建通过。Dawn D3D12 真实 GPU oracle 编译并运行生产 probe/Temporal shaders：非恒定 albedo Standard PBR 的 16 cells 产生 quad 候选并与 CPU reference 一致，有跨 primitive 通过计数；stale residency、高 variation/NaN、Coated、非法 key 全率；奇数尺寸边缘全率；相机和刚体运动、invalid motion、驻留身份变化读回符合预期。该 oracle 是受控生产 shader harness，不是正式浏览器宿主或完整场景验收。

阶段一收口时记录的两处陈旧合同断言（reconstructed-color 消费者和 Web Geometry Cooker ABI）属于当时工作树状态；阶段四已按当前 Frame Program 与 Product ABI 修正。未运行正式 browser matrix、画质/lifecycle 全矩阵、GPU P50/P95、evidence/claim promotion；此前 VG 画质问题保持未验收。

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

### 阶段二收口记录（2026-09-30）

- 唯一 coordinator 接通 Probe → tile Work Builder → GPU finalize → material/lighting workers → Resolve → 既有 HDR/Sky/Aerial/FSR3/Bloom/Radiometry/Present。删除旧 frequency shader/ABI、Dense 内七 lane producer、旧 lane 容量和运行开关；Frame Program 不再携带 exception lanes。
- 四个 resident-set profiles 共享同一 Standard/Unlit/Coated 数学；几何、texture/closure 与 lighting 已从 surface_material_kernel 拆分为独立模块。所有 worker 的 demand mask 为零，不恢复重复 motion 求值。纯同率/full tile 只发一个 descriptor；mixed tile 才建立 24-byte record（tile、代表 pixel、64-bit coverage mask、result、profile）和 profile index list。
- 160-byte 固定 tile 状态含 16 个 cell rate/result bases；record 与 result 池均按 tile 完整预约后提交。任一池不足使整个 tile fallback；partial reservations 不发布 descriptor/indices，workers/Resolve 检查最终状态。fallback 直接扫描固定 tile 状态，没有 repair queue。独立 finalize 生成合法二维 indirect，正常 full-rate 直接写 HDR，coarse 只写独立 rgba16float result pool，Resolve 不读取 HDR。背景、非法 key、奇数尾部和 overflow 都有互斥写域。
- 具名 directional-no-shadow 同率 profile 消费当前位置/视向/法线与 roughness 风险；有 punctual active light list、VSM 或物理天空/IBL 就保守全率，不借代表 pixel 的 cluster/light list 替其他像素漏光。ORM、normal-map 未证明风险、Coated 与未知数据保持全率；AO 非一致 cell 也全率。预算通过不可变 RendererConfig.surfaceShadingBudget 传入，默认全零；这不是新旧运行桥梁或最终画质阈值。
- 容量在创建前协商：fixed states/descriptors、record/index、coarse result extent、u32 上界及二维 dispatch。默认 record/result capacity 均为 ceil(P/2)，record capacity 进一步受 storage binding/buffer limit 截断；高频 homogeneous tile 不依赖这些池。最宽 AO worker 为 16 storage buffers、15 sampled textures、2 storage textures；lit probe workgroup facts 为 11264 bytes。

验证：typecheck/build、31 项 targeted Node checks 与 Dawn D3D12 的真实 GPU producer/consumer oracle 通过。GPU 使用 d3d_skip_shader_optimizations 诊断 toggle，仍实际执行 D3D12，不使用 null backend，不用于性能测量。非恒定 resident albedo 普通 PBR + 非零方向光的 material/lighting counters 为 full 64、quad 16、方向率 32；mixed 为 21（17 coarse + 4 full），数值与同数学 full 对照的最大误差小于 0.04。record/result/双池/partial reservation overflow 完整退回 full 并逐位匹配 full HDR；Coated、背景、非法 key、驻留变化、当前灯表风险、moving camera、独立 Temporal motion、奇数尾部与强制 dispatch X=1 的跨两 tile 二维 indirect 消费均有实际 GPU 覆盖。上述仅为受控生产 FrameGraph oracle，不是正式画质验收。

本阶段未改 Product/Cooker 或 WASM，不重复重建既有产物。正式 browser/场景/lifecycle/画质全矩阵、GPU P50/P95 与 evidence/claims 未运行；不宣称净加速。阶段二当时的 material-closure/capability/VSM/specialization 检查记录保留为历史；其中 ABI v6 断言已在阶段四同步到当前 v7。

## 阶段三：完成分信号质量与有效 GPU 执行

**目标：** 避免“少算了样本，但仍浪费 waves／中间带宽／重建失真”，让跨三角形与真实材质场景成为完整可用能力。

**实现范围：**

- 完成 candidate probe/variation 查询、跨 primitive continuity、方向性 rates、代表位置与 footprint 的一致算法。未知属性和接缝留全率，但不能把所有典型 PBR 永久拒绝并宣称主线成功。
- 对 material 与 lighting 不同 rate 的真实收益需求，增加有限 compact signals/layout；保持 high-frequency albedo、emissive、normal、shadow/AO 和 sharp specular 的语义，必要时仅这些信号全率。检查 nonlinear coat/DFG/energy/AO 耦合，不能整图随意乘 mask。
- 正常 full-rate 直接最终写出，coarse Resolve 读取独立不可变 sample results；实现受限的身份/深度/信号边界重建，不读取正在写的 HDR，不照抄原地 UAV race。
- 打包有效代表样本，处理 mixed tile tail；材质保持足够 texture locality，照明保持 cluster/light-list 完整性。实际成本决定有限 kernel 拆分/融合，而不是先固定巨型 shader 或大 GBuffer。
- Geometry setup 只对有复用的实际需求构造；必要内容随主线完成，不单独打造全局大缓存项目。future normal/roughness consumer 通过需求合同增加字段，不默认物化全部。

**阶段结果：** 连续表面内部边、细纹理/发光线、normal map、Coated/金属、光照边界与运动均有明确处理；信号降频策略可观测，普通 PBR 实际 GPU consumers 已接通。此阶段不是临时画质补丁后另开第二套算法。

### 阶段三收口记录（2026-09-30）

- `SurfaceSignalPlan` 建立单一 32-bit cell layout：lighting/material/emissive/normal 各占 2-bit 方向 rate；CPU pack/unpack/effective-rate 与 WGSL 使用同一事实源。有效覆盖取各信号交集，避免任一高频或未知信号被粗率复制；normal-map、ORM、Coated/未知 closure 仍按相应信号全率处理。
- Probe 输出现在发布 packed signal rates，仍沿用四角透视事实、sharing domain、generation/residency 和 variation/UV 拒绝条件；Work Builder 在 lighting/VSM/AO 风险出现时只清除 lighting signal，不建立第二条队列。worker/Resolve 消费 effective rate，并统计 material/lighting coarse work，未引入本帧 GPU→CPU→GPU 控制。
- Resolve 增加 visibility key、depth 和 result-capacity 边界检查；coarse 只读取不可变 sample results，full-rate 直接写 HDR，Resolve 不读取正在写入的 HDR。CPU `surfaceResolveReference` 对同 domain、深度/法线容差和 owner fallback 建立受限重建 oracle；代表位置和 footprint 仍由现有 sample mask/record 保持。
- 新增 `surface-signal-plan.test.mjs`，覆盖信号 layout、unsafe closure 全率和跨 domain/depth/normal 邻居拒绝；现有 Surface sample/投影梯度定向检查保持通过。该阶段没有新增独立 submit、全屏 GBuffer 或长期 shading cache。

实际验证：OEngine typecheck、build、build:test、Surface signal/sample/投影梯度定向测试通过；Dawn D3D12 生产 oracle 曾尝试启动，但宿主返回 `D3D12CreateDevice ... DXGI_ERROR_DRIVER_INTERNAL_ERROR`，未取得有效 GPU 结果。正式 browser 场景、完整 normal/emissive/Coated 画质矩阵与 GPU P50/P95 未运行，因此不宣称整帧性能或最终画质验收。

## 阶段四：完成模块清理、验证与后续交接

**目标：** 新架构成为唯一可维护的生产实现，集中完成模块验证，明确剩余测量与最终验收项。

**实现范围：**

- 清理旧 import、资源角色、planner/shader/ABI 和只断言旧路径的 tests；更新真正变化的 owner/current facts/source mapping。确认不存在 retired owner、额外 frame submit、GPU→CPU→GPU 本帧控制。
- 汇总尺寸/capability/profile 的容量预算，处理 resize、camera cut、scene/texture/Product 换代、device loss 与 GPU 延后销毁；检查 normal/motion/roughness 的真实 consumers 和 FrameGraph 依赖。
- 集中 typecheck/build/必要 targeted tests：原有 `surface-product-closure`、`surface-reconstruction-projected`、`temporal-fabric`、材质/Product ABI，以及新增的有意义 sample coverage、overflow、variation、重建与 motion oracle。改 Product 时包含 Native/WASM 需要的检查。
- 修实际编译/数学/覆盖问题，记录实际跑过与未跑过的范围。开发 GPU counters 可延后异步读回观察；不要为每个中间 commit 启动正式 browser/perf/evidence 全矩阵。
- 模块完成后更新 currentSlice/nextModules。正式画质、场景/设备矩阵、固定条件 GPU P50/P95 和 claim promotion 放在整体 Next 适当验收阶段；不把模块构建通过等同最终性能通过。

**阶段结果：** 生产主链完整、旧路径已切断、构建和必要测试通过、诊断能解释每类工作；未完成的正式验收如实列出。性能结论必须包含新增分析/probe/queue/Resolve 的合计成本与整帧，而不只看重 shader 单 pass。

### 阶段四收口记录（2026-09-30）

- 生产源码扫描确认 `SurfaceFrequencyResolvePass`、`ShadingWorkPass`、`SurfaceExecutionAbi`、`shading_frequency`、`surface_execution`、`activeExceptionLanes` 等 retired Surface owner/ABI 没有残留 import 或调用。当前唯一入口为 `SurfaceMaterialPass`，由 `SurfaceSampleAbi` 与 `SurfaceSignalPlan` 提供 CPU/WGSL layout，TemporalFacts 独立拥有 motion/identity。
- 修正了三处陈旧合同：FrameProgram `reconstructed-color` 的真实消费者为 Bloom/Radiometry；Shading Material ABI 为 v7；Web Geometry Cooker canonical/recipe ABI 为 v3。新增阶段四契约覆盖 retired-owner 清理、FrameProgram resize/consumer 边界和 sample capacity overflow。
- 复核生命周期边界：内部/输出尺寸进入 FrameProgram/Graph key；Surface pool 在创建前按 device limits 收敛；材质、纹理、几何 publication revision 由当前帧绑定；Temporal/HZB/FSR3 history 在 resize、camera cut、device epoch 变化时由各自 owner 处理；device loss 通过 Renderer shutdown/recovery 重建 device-local Surface pipelines，不把旧 GPU 资源带入新 epoch。Surface 不创建长期 Loader 资源、不读回本帧工作数，也不增加 submit。
- 集中验证通过：`npm run typecheck`、`npm run build:test`、`npm run build`；阶段四及相关 Surface/Temporal/Product/ABI 定向检查共 24 项通过，另有扩展的材质、几何 Product、Temporal 和 Surface checks 通过；`git diff --check` 通过。未运行正式 browser matrix、场景/设备画质矩阵、GPU P50/P95、evidence/claim promotion。

### 本地 Chrome 故障修复与开发验证（2026-10-01）

- 用户原 Chrome 154 / GTX 1650 Ti / D3D12 已确认硬件 WebGPU 与 timestamp-query。现场诊断显示三个 Surface 重 worker 顺序重复编译，每份约 25–30 秒，场景 submit 等待期间实例最终失效；不能把它描述为浏览器不支持，驱动/watchdog 内部失效机制尚未证明。修复把十个材质 role 的采样合并到有界循环，并让 implicit/compact/fallback 共用单一 shader/pipeline 与一次重求值调用；runtime dispatch 参数保留各工作类型、二维 indirect、覆盖和整 tile fallback 的语义。
- 修复两处真实 API 错误：参数上传的 CopyBufferToBuffer 在 compute pass 打开前编码；Resolve 真正读取并验证 depth，避免 auto layout 裁掉未使用 binding 后与 CPU bind group 不一致。Surface 编译接入带 label 的 ShaderModuleCache，并处理诊断 error-scope rejection。这些为本地 WebGPU 集成修正，没有第二条 renderer、独立 submit 或本帧 readback 控制。
- 修复后用户原 Chrome 的 showcase 持续完成 GPU 提交，默认/半内部尺寸/移动相机/真实 1023×767 canvas resize 均有非零 GPU timestamps，四组采样的 validation/uncaptured/device-loss/timestamp-failure counters 均为零。每组约十秒；GPU pass 合计 P50/P95 分别为 18.50/19.89、8.46/9.25、19.04/20.72、17.20/35.00 ms。Surface 子图包含 Probe/Builder/finalize/background/worker/Resolve，不含 Present；相应 P50/P95 为 8.83/9.53、2.42/3.04、8.40/9.27、8.58/17.93 ms。该场景使用严格预算和物理环境保守全率，没有 Surface sample counters，不能据此证明 adaptive 净加速；冷启动仍有几十秒编译，resize 有长尾。
- typecheck/build/build:test 与 32 项 Surface/资源 targeted Node checks 通过；另同步 FSR3 曝光资源和 camera projection 的陈旧 lifecycle fixture 后，6 项生命周期检查通过。现有生产 GPU oracle 经临时浏览器 host glue 在用户硬件 Chrome 执行，374 assertions 通过，覆盖 textured PBR full/quad/directional/mixed、各池与 partial overflow、Coated/背景/非法 key/驻留/灯表风险、7×5 尾部、二维 indirect、移动相机/刚体与独立 motion；增加 pass 内禁止上传的回归保护。浏览器运行没有关闭 shader optimization。Node Dawn 复跑仍受 D3D12CreateDevice/DXGI_ERROR_DRIVER_INTERNAL_ERROR 阻断，不宣称其通过。
- 诊断和采样记录位于本地 ignored `.local/validation/surface-showcase-20260930/summary.md`。临时 examples oracle 页面已移除；构建脚本保留在 ignored `.codex-temp/`。这次是用户明确要求的现场开发验证，正式跨设备/完整画质与 lifecycle 矩阵、固定条件性能对比、evidence/claim promotion 仍开放。

### 阶段三/四补齐与现场复核（2026-10-01）

以下记录取代此前收口记录中“effective-rate 交集取消独立收益”和“GPU Resolve 仅 owner 复制”的当前事实；旧记录保留其当时验证边界。

- Work Builder 按实际 material/emissive closure rate 组织有效样本。有限不同率 profile 采用材质粗率、照明全率；物理环境/VSM/灯表/变化 AO 只清照明，不因目标几何法线/depth 高率取消已证明材质复用。normal-map、ORM、Coated/未知 closure 继续全率。`surface_material_evaluation` 保留 canonical 数学，拆分照明没有材质纹理绑定，恢复目标 position、几何/属性法线，再完整执行 direct/AO/VSM/IBL/DFG/energy，色域转换与曝光只执行一次。
- 私有不可变 results 为八个 `rgba32uint` texels、128 bytes/sample，同率存 radiance，不同率存未曝光精确 closure。GPU Resolve 使用 owner/右/下/右下和真实代表位置/stride 权重，拒绝身份/domain/representation/layout/footprint/depth/normal/finite 不匹配，归一化存活权重并回退 owner；不读取 HDR，不过滤 full/split 最终结果。CPU oracle 与实际 GPU 合成输入相互对照。
- 16-slot workgroup TriangleSetup 分享三顶点 refs、model/world/clip，不分享目标 bary/gradient；精确 frame-local key、leader/barriers 和直接 miss/near-clip/degenerate 路径完整。现场发现旧模板替换未命中 canonical material 函数、setup 实际零消费，已改为显式模板参数，并增加 full/coarse material 的真实 setup-hit GPU 断言。finalized header/profile/result-reservation 的 116-byte workgroup cache 保留 mutable counters 的 atomic 语义。
- schema v25 的 36 个 Surface 字段来自真实 Probe/Builder/worker/Resolve，通过现有 profiler 延后 ring 读取；Showcase HUD/export 消费已完成数据。现场复核修正 GPU 时间栏读取最新未完成帧而持续显示“等待”的问题，改读最近完成的 GPU timestamp 快照。没有用旧 diagnostic 槽冒充实际计数，没有本帧 GPU→CPU→GPU 控制或额外 submit。
- 用户 Chrome 的实际 OOM 复现为 GPU 未完成时 42 套 fence-retained 瞬态帧、pool 约 6.8 GB，而不是缺少 WebGPU。FrameCoordinator 在创建新帧资源前限制两个未完成提交，队列完成/失败都释放槽，destroy 后迟到 fence 不恢复 owner。延迟 tick 不推进 graph/history/frame_count，Showcase FPS 统计真实编码帧；相关生命周期定向测试通过。此前编译/watchdog 故障与偶发 WebCook `Failed to fetch` 不据此宣称全部定因。
- 集中通过 OEngine typecheck/build:test/build、77 项 Surface/Geometry/FrameCoordinator targeted Node tests，以及 Showcase 单页 TypeScript 检查。用户原硬件 Chrome、正常驱动优化执行 800 GPU assertions：full/方向率/quad/mixed、整 tile/partial overflow、非法 key/驻留/Coated/灯表、运动/奇数尾部/二维 indirect/Temporal、material 16 / lighting 64、normal 全率不取消材质粗率、完整 IBL/DFG/energy 与变化 pixel AO 的常量 closure 逐位一致、受限 Resolve 和真实 setup 消费。未改 Cooker/Product，不重复 Native/WASM；examples 全量旧 tsconfig 的 retired API 失败不冒称通过；Node Dawn D3D12 启动仍失败，不能替代 Chrome 的通过结果。

开发性能复核使用独立 Git revision `d65a967` 作为基线，用户原 Chrome 154 / GTX 1650 Ti / D3D12 / driver 581.42，每版只保留一个 WebGPU 设备；canvas/内部尺寸均 1280×720，固定相同真实相机 transform/view/projection/frustum、SSE 4、曝光 8、太阳 30°/63°/1.5、AO/FSR3/Bloom/HZB/cone 开、VSM 关、物理环境开、jitter/自动旋转关。30 帧预热后每版取 300 个已完成且非零的 timestamp 帧，相机 signature 各自唯一且两版相同，几何工作计数相同，所有帧单次 submit，validation/uncaptured/device-loss/timestamp-failure 为零。首轮取景不同的数据保留但作废，不用于比较。

| 开发采样 | GPU pass 合计 P50 / P95（ms） | Surface 子图 P50 / P95（ms） |
| --- | --- | --- |
| 基线 `d65a967` | 19.45 / 45.80 | 12.30 / 21.86 |
| 本次工作区 | 19.21 / 94.32 | 11.99 / 62.29 |

Surface 包含 Probe/Builder/finalize/background/material/closure lighting/Resolve，不含 Present；GPU pass 合计不是包括 copies、队列等待的整帧墙钟。温度日志实际记录约 88–91°C、1350→300 MHz 动态降频，因此上述 P95 长尾不能用来宣称稳定性能改善，也不隐去长尾只报告 P50。默认 Dungeon 固定视图的 visible/PBR/material/lighting/full 均为 290838，coarse/fallback/overflow 均零，setup builds/hits/misses 为 50869/262911/27927。实际 setup 消费成立，但严格预算导致该场景材质减量仍未实现；没有放宽 Showcase 默认预算伪造收益。

另外在当前 Showcase 实际运行 1023×767 canvas resize、连续相机移动和新相机 cut，各保存 50 个完成的非零 GPU timestamp 帧，全部单次 submit、四类错误为零；完成 cut 并等待队列后 in-flight 为零，当前设备资源账面峰值 811359874 bytes，未再次出现多 GB fence-retained 帧积压。账面估算不等于驱动实际显存。截图纠正测试点击造成的 main 容器滚动后取景一致；受控 GPU oracle 的数值对照和这组截图均不能替代完整材质/场景画质矩阵。

记录和完整逐帧数据位于本地 ignored `.local/validation/surface-completion-20261001/`。这些是用户要求的现场开发验证，不提升 formal claims 或上游 adoption；完整跨设备、材质组合画质与稳定温控性能矩阵仍开放。跨帧 shading cache 按设计 §13 在稳定映射和重复成本证明后选定 profile，不把本次 frame-local setup 或 sample pool 称为历史着色缓存。

## 之后按剩余瓶颈选择，不绑定首个重构

1. 如果同一表面的材质/间接项跨帧重复仍主导，再选一类对象/纹理空间或屏幕空间缓存 profile；稳定表面位置、view/lighting 依赖、footprint、失效、缺页/eviction 与 miss 路径完整后再实施，不直接缓存最终 PBR 颜色。
2. 如果局部求值仍占主要时间，再做 IBL 过滤、等价纹理采样、setup 更深共享、绑定缓存等小优化。
3. HZB/recovery、SSSR/GI、透明/体积等按既有 provider 顺序接续；它们不是 Surface 减样本的隐藏前提，不通过重复 renderer 实现。

## 实现时的三个停止误判

- **“分类器/队列做完了”不是模块完成。** 必须有普通 PBR 的实际 worker 减量、重建和完整 consumer。
- **“所有风险都 full-rate”不是性能成功。** 它是正确性底线，但典型 workload 的粗率覆盖不足要继续定位 continuity/metadata/probe 或策略成本。
- **“GPU ms 已少一点”也不能跳过正确性。** 缺页、边界、motion、曝光、Coated 或 overflow 漏算不是优化。

以上四阶段的规模按完整主链组织，不设置逐行、逐 pass 审批或实施前完整 benchmark 门禁。前期 35–65 人日仅为熟悉项目的资深工程师对选定 rigid opaque PBR 范围的粗估，非排期承诺；Product/质量未决项可能明显改变投入，各阶段与后续方案不机械相加。

阶段一至四已实施。已运行与未运行范围见各阶段收口记录；不据本阶段宣称整帧性能改善或最终 Surface 模块的正式画质/性能验收。
