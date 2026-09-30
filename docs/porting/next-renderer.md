# EEngine Next：开源迁移来源与采用边界

初始调查日期：2026-09-25；Module A/B 追加核对：2026-09-27。当前采用边界对应 [ADR-0020](../adr/0020-clean-cut-renderer.md) 和 [单路径重建路线](../next-execution/eengine-next-architecture-layer-plan-2026.md)。这是影响当前选型的来源账本，不是已移植清单；表中的模块是目标 owner，不表示迁移顺序。

本轮通过 GitHub 固定 revision 的目录、许可证原文和下列标明的实现文件进行核查；未构建这些上游工程，未跑其 benchmark，也未证明移植后的 WebGPU 性能。**固定 commit 是复现调查的版本，不是自动引入依赖或升级现有来源的指令。** 本地已有 port 继续以 [geometry](./geometry.md)、[visibility](./visibility.md)、[shading](./shading.md)、[platform](./platform.md) 的既有 revision 为准。

下表的“优先/候选/参考”只表示实施推荐；实际采用状态以各来源条目的本地映射和验证为准，不能从固定 revision 或编译通过推断已完成移植。

复杂算法与渲染效果实施前必须先搜完整 GitHub 源码及可核验论文/详细技术文章，优先跨语言忠实移植固定版本。每项 ledger 需写清源 entry point、完整阶段与关键条件、本地对应入口、WebGPU 必须差异、fallback、oracle/GPU 验证；找不到完整 donor 时记录检索范围与缺口，选择具名本地方案，不得以缩减算法冒充迁移完成。简单确定性工具、ABI 编解码、绑定、队列及资源生命周期接线不强制外部调研，但属本地集成，须与来源算法分别标识；不能将一个复杂效果拆分后按简单任务豁免。

## 2026-09-29：Virtual Geometry 正确性修复

- **固定来源**：Nyx `bc7e5b1e51f6b3b8af4771db81ffaa714fcbe64b`，MIT；本地只读 checkout 与原账本的七个源文件 hash 对齐。参考 `DAGCull.slang::ProcessNodeBatch/ProcessMeshletBatch`、`CullCommon.slang::TestForLod`、`VBufferMesh.slang::GetClipPosition/BuildVertexOutput`。
- **Meshlet handoff 映射**：`hierarchy_lod.ts` 共享 view ABI/SSE 数学；hierarchy 选择 fine 的 `error > threshold` 与 `virtual_geometry_work.ts` 保留 coarse 的 `error <= threshold` 互补。只有真实 refine target resident 才切换；缺页发 demand 并保留 coarse meshlet，删除 spatial BVH ancestor replacement。`refineGroupId` 按 Product group base 重定位，不误用 asset group base。
- **有界执行适配**：64 lanes 分两轮处理至多 128 meshlets，逐 meshlet gate 后统一 compaction/reservation。修正原先仅写 0–63 却发布 128 个 work 的错误。保留 overflow/invalid 的 fail-closed indirect 发布规则。无本帧 GPU→CPU→GPU visible control、无额外 production submit。
- **HZB 边界**：本地 `hzb_footprint.ts` 遍历实际 mip 的完整有界 texel footprint，异常大范围 fail open；`hzb_reduce.ts` 在 RG16F 存储前向外舍入 min/max，含 subnormal 处理。原 ceil-mip 四角方案在 footprint 至多 2×2 时本可保守，不能把“四角”本身当作已证实根因。**Virtual Geometry 的 previous-HZB early rejection 暂停**，直到接通 Nyx two-pass disocclusion recovery；current-HZB recheck 保留，不宣称完整 two-pass 移植。
- **位置与 cooker**：恢复 Nyx 的 Float32 xyz，统一 Native/WASM producer、Visibility raster、Surface 和 VSM 位置消费者；VSM 不启用。VertexFormat byte 10 为 `positionEncoding=1`，旧 U16 Product/pack 必须 recook，无双解码路径。recipe identity 升至 `nyx-hierarchy-v3.1` / `static-pbr-page-local-f32-v4`。简化因 minimumLodReduction 提前停止时，将丢弃替代物对应的 terminal group parentError 恢复为 FLT_MAX，避免远处无替代物却被 SSE 剔除。
- **追加根因：Instance bounds 坐标空间**：`VirtualGeometrySceneSourceV1` 原先发布 fitted world-space sphere/AABB，`GpuScene` 原样入表，`r3_fused_root_cull` 又应用 object-to-world，造成包围体重复缩放/平移，而 hierarchy 与 raster 顶点只变换一次。改为发布 Product 的 object-space bounds，fit 仅写入实例矩阵；WebCook、Offline 与 runtime Scene 共同使用该 mapper。此项属于本地 ABI 接线修复，与 Nyx `CullCommon.slang`/`VBufferMesh.slang` 的局部 bounds/position 经 world matrix 一次变换对齐，不改变相机、SSE 或几何质量。
- **追加 LOD 回归修正**：工作区曾把 coarse handoff 从 `<= SSE` 改为 `> SSE`，与 hierarchy 的 fine gate 同向；已恢复互补关系。目录中的非法 refine ID 继续计 invalid 并 fail closed，不能当作普通缺页。Nyx 的 two-sided PSO 仍在 `VBufferMesh` 内按 material sidedness / mirrored transform 做 primitive culling，不能只凭 PSO 推断无背面剔除。
- **2026-09-29 接缝拦截方案已否决；2026-09-30 当前为 v3.3 实验**：v3.2 对含受保护接缝的组拒绝 sloppy，保留过多细级，不满足性能优先要求，已从实现移除。当前 `nyx-hierarchy-v3.3` 在固定 Nyx meshoptimizer 0.25 上实验保留 source triangle corners 属性、替换聚类位置并重新去重，不是 v1.3 移植。六个 Dungeon primitive 恢复多级减面且反向角点检查通过，但同近景桶体仍异常；不能宣称 UV/拓扑/切线或稳定 GPU 性能通过。此前 Native、两套 WASM、18 项 targeted tests、typecheck/build 通过只证明已测试范围。旧修复完成措辞作废，候选设计见 `docs/next-design/virtual-geometry-attribute-simplification-2026.md`。
- **本轮追加验证**：先用旧 mapper 复现 CPU 近距离误剔除，再在 RTX 2060 SUPER 上执行生产 `HierarchicalWorkGenerator` root + traversal kernels；20 个近远距离/旋转/俯视位置中，旧 world-space bounds 负对照误剔除 8 个，修正后 20 个全部保留，覆盖 FLT_MAX terminal error。40 组 handoff、16,384 个 RG16F 边界、1,296 个 footprint GPU 查询再次通过。OEngine typecheck/build/build:test 与 20 项局部 Node 测试通过。仅验证受控 GPU kernel 与 CPU 接线，Showcase 整帧视觉结果待用户手动确认。
- **实际验证**：RTX 2060 SUPER、D3D12 driver 32.0.15.9186，Dawn Node 0.6.1；production candidate owner 跑通 40 组 GPU readback（1/63/64/65/128 × leaf/missing/near/far/equal/mixed/overflow/invalid），16,384 个 RG16F 深度边界与 1,296 个 NPOT/clear-hole footprint 查询通过，8 个涉及的 production WGSL modules 编译通过。Native cooker ABI oracle 覆盖公共顶点逐 bit 相等与 terminal LOD；Native/WASM 同 GLB 对照通过。工具只安装于 `.tmp/gpu-check`，不加入 production 依赖。
- **构建与局部回归**：OEngine typecheck/build、examples build:examples、单线程及 pthread WASM 构建、Native cooker 构建通过；56 项 contract/oracle/scheduler 测试通过，另有 Native/WASM 同 GLB 对照与 validation overflow-source 检查通过。examples 构建仍有已有的 large.glb 缺失及大 chunk 警告。
- **未完成验证及成本**：前轮 Chrome 插件缺少 `scripts/browser-client.mjs`；本轮按用户要求不启动浏览器，Showcase 近距离/旋转截图与整帧视觉验收由用户手动完成。Dawn GPU oracle 不替代浏览器整链画面验证。位置从 6 B 增加到 12 B/vertex，最终 stride 按 4 B 对齐；关闭 previous-HZB 可能增加 work。本轮不作性能提升或完整 Nyx runtime parity 声明。

## 2026-09-30 Surface 最终设计：Signal-Rate Surface（阶段四已完成，正式验收待执行）

最终设计见 [Surface 可见性驱动分频着色](../next-design/surface-sample-driven-shading-final-2026.md)，实现顺序见 [四阶段重构](../next-execution/surface-sample-driven-shading-rebuild-2026.md)。这两份文件替代前期候选排序，确定先减少 ordinary PBR 的重样本，再按残余瓶颈做局部优化。阶段四已完成旧 owner/陈旧合同清理、生命周期复核和模块级集中验证；**最终设计不等于采用完成**，R02/R03/R20/R23 的上游采用状态与正式画质/性能 claims 不因本地接线自动改变。

### 来源检索范围与核对记录

先查固定 GitHub 版本的完整实现文件，再对照论文/第一方详细说明。前期已查 The Forge、Wicked Engine、Intel DeferredCoarsePixelShading、WeakKnight DACS、WeakKnight OSS，以及 DACS/FastAtlas 作者资料；后续核对 NVIDIA Decoupled Sampling、JCGT Visibility Buffer、Lighthugger README 与 DOOM GPC 2025 原始幻灯片。没有发现一个完整 donor 可以直接提供本地完整 profile；Ilum 未固定并审计具体版本，不列入可移植来源。

本轮重新取得 The Forge utilities、Wicked 两个 shaders、Intel `ComputeShaderTile.hlsl` 的固定 revision 源文件和许可证信息，核对实际 primitive/material 判据与消费；The Forge/Wicked/OSS 仓库许可及 Intel 源文件头分别明确 Apache-2.0/MIT/Apache-2.0/Apache-2.0。Intel 根路径 `LICENSE` 返回 404，许可依据采用固定 shader 自带完整 Apache-2.0 声明，后续若移植其其他文件要继续核对各文件许可，不假定已查遍全仓。

源码留存 `.tmp/surface-shading-oss-study/pinned-sources/` 仅作本地调查方便；正式依据是下表固定 SHA/URL 与源符号，不依赖 `.tmp` 进入版本控制。本轮没有运行外部工程或 GPU benchmark。

### 选定来源到本地阶段的映射

| 固定来源 / 许可 / 源入口 | 源输入 → 阶段 → 输出与关键分支 | 对应最终本地阶段 | 移植边界 / 验证需求 |
| --- | --- | --- | --- |
| [The Forge utilities](https://github.com/ConfettiFX/The-Forge/blob/cd5046893faba2dc7869243873bf01f02a6f0df9/Common_3/Renderer/VisibilityBuffer2/Shaders/FSL/VisibilityBufferShadingUtilities.h.fsl)，`cd5046893faba2dc7869243873bf01f02a6f0df9`，Apache-2.0；`CalcFullBary/Interpolate2DWithDeriv` | clip 三顶点 + NDC/pixel scale → reciprocal W、透视权重、一像素投影差分 → 插值 UV 与梯度 | `surface_material_kernel` 拆分后的 Geometry/Material sample worker；必要 setup 共享 | 继续原 R02 数学来源，不宣称新完整 port；本地退化/近裁剪/非法 generation 分支保留；CPU/WGSL 对照 perspective、UV transform、coarse footprint |
| [Wicked resolve](https://github.com/turanszkij/WickedEngine/blob/df44c3db4c4927492bc9c791eac715d98d7ed091/WickedEngine/shaders/visibility_resolveCS.hlsl)、[shade](https://github.com/turanszkij/WickedEngine/blob/df44c3db4c4927492bc9c791eac715d98d7ed091/WickedEngine/shaders/visibility_shadeCS.hlsl)，`df44c3db4c4927492bc9c791eac715d98d7ed091`，MIT；两文件 `main` | primitive tile 的 uniform/divergent 分支 → shaderType mask、tile bin/indirect → masked per-pixel Surface load/TiledLighting/output；背景/失败 load 退出 | Work Builder 的 profile/tile masks、bounded indirect、full-rate worker 的写域参考 | 原消费者仍每像素求值，不作为 sparse shading donor；bindless/Wave/quad 改为已协商 WebGPU 路线；新 rate 与溢出合同本地设计。此 pin 与 R23 原 pin 分立 |
| [Intel CPS](https://github.com/GameTechDev/DeferredCoarsePixelShading/blob/63ad5c1adafbfcc2869a200f50a5ea11f28b4887/ComputeShaderTile.hlsl)，`63ad5c1adafbfcc2869a200f50a5ea11f28b4887`，源文件 Apache-2.0；`ComputeSurfaceDataFromGBufferAllSamplesCPS/RequiresPerPixelShading/ComputeShaderTileCS` | 已有四份 GBuffer surface → position derivative/depth/normal 判断、tile light list → coarse splat 或 full；`DEFER_PER_PIXEL` 控制补做，零灯也完整写回 | Lighting signal 的 coarse/full、光源集合与覆盖 oracle 参考 | 不照搬原角度/深度常量；不把 GBuffer 读取算成免费，也不称它是 pre-material classifier；R20 不提升 |
| [DOOM GPC 2025 PDF](https://static.graphicsprogrammingconference.com/public/2025/talks/variable-rate-compute-shaders-in-doom-the-dark-ages/Fuller-Hammer-variable-rate-compute-shaders-in-doom-the-dark-ages.pdf)，71 页；SHA256 `e5fe7cf223006bf95089eb2890c878a47aecccd612eb9e5398c1fe43273d0fad`；无完整可复制源码许可 | 11–15 页 SRI+coverage → primaries/duplicates；23–25 页 tiled remap/compact commands；27–38 页位置/去块/噪声；42/51–58 页低分辨率/内部边界；62 页 normal consumer | rate/代表位置、sample packets、重建、continuity 与按 signal 精度的技术参考 | surfaceID 为 future potential；不复制第35页同UAV原地 race；不能把其融合 shader 未完成尝试当已验证最优；未运行原 shader，不宣称 port |
| [Decoupled Sampling](https://research.nvidia.com/publication/decoupled-sampling-graphics-pipelines)，Ragan-Kelley 等，2011，作者论文页 | visibility 到 shading 的 many-to-one 映射、memoization、可变/自适应率 | `SurfaceSamplePlan` 的采样/覆盖解耦概念 | 论文架构/仿真结果，不是可直接集成的现代 WebGPU 源码；本地阈值/variation 不是论文已给的完整 profile |
| [Visibility Buffer](https://jcgt.org/published/0002/02/04/paper.pdf)，Burns/Hunt，JCGT 2013 | 紧凑 triangle/instance 标识 → 延后恢复 barycentric/vertex data → shading | 保留当前 Visibility 底座与按需字段原则 | 原论文不自动提供自适应压缩；本轮核对 abstract/开头方法边界，不宣称通读/重跑全文 |
| [OSS 工程](https://github.com/WeakKnight/real-time-seamless-object-space-shading/tree/473a59bbcdd30e3366cc567d66a5a97353620d48)，`473a59bbcdd30e3366cc567d66a5a97353620d48`，Apache-2.0；`ObjectSpaceShadingPipeline.cs/RenderTaskProcessing.compute` | virtualized halfedge/chart 与 shadel demand → allocation/tasks/indirect → surface storage | 主线之后的 selected object-/texture-space cache 候选 | 仅部分 host/task 文件、README/许可已审；完整 filtering/eviction/history/GI/LOD 与 Unity/RT 适配未审，不加入首版采用范围 |

### 具名本地算法：不是简单接线，也不是完整上游 port

阶段二实施映射（2026-09-30）：重新核对上述固定 Wicked main 的 uniform/divergent tile bins 与 masked shader consumer、Intel CPS 的 RequiresPerPixelShading/DEFER_PER_PIXEL/零灯完整覆盖，以及 VRCS 23–38 页 compact/remap/coverage/race 边界。未找到包含本地 pre-material variation、WebGPU 多池整 tile commit 和 immutable Resolve 的完整 donor；采用具名本地 **Committed Tile Samples** 与 **Owner-Sample Resolve**，不是将 R20/R23 升级为完整 port。

| 来源阶段/关键不变量 | 阶段二本地产物/消费者 | 保留或明确调整的边界 |
| --- | --- | --- |
| Wicked uniform/divergent tile 与固定 bins/indirect | SurfaceSampleAbi、surface_sample_work 的 build/finalize；SurfaceMaterialPass FrameGraph coordinator | 四个 resident-set profiles；纯同率 tile 用 descriptor，mixed 才 compact；不使用 bindless/wave/quad 或每材质全屏常态扫描 |
| Intel CPS coarse/full 判定、当前光源集合和 DEFER_PER_PIXEL 覆盖 | surface_probe 当前 position/view/roughness；Builder 当前 active light list/VSM/environment/AO 风险；固定 tile fallback | 初始同率只放行具名方向光无阴影 profile；punctual/VSM/物理天空未知项全率，不复制代表 pixel 的 cluster list；不照搬 GBuffer 或原阈值 |
| Forge CalcFullBary/Interpolate2DWithDeriv；既有 Filament Standard/Coated/lighting | surface_geometry、surface_material_evaluation、surface_lighting；surface_sample_worker full/implicit/compact | 按代表 winner 的解析一像素导数调用原数学，未增加 mip bias、廉价 BRDF 或 motion demand；Coated 完整保留但全率 |
| VRCS compact remap 与覆盖，避免同 UAV 原地读取竞态 | 24-byte sample records/64-bit masks、160-byte 固定 tile state、独立 rgba16float sample results；surface_sample_work.resolve | top-left owner sample 有界复制到已认证 cell；HDR 只写不读，full/coarse/fallback 互斥；进一步的独立 closure result split 仍不冒称完整 VRCS port |
| 无完整 donor 的 multi-pool commit | record/result 同 tile 预约 → 最终状态 → 独立 finalize → worker/Resolve | partial reservation 只浪费槽、不部分提交；错误 tile 从固定状态定位，不使用可溢出 repair queue；无跨组自旋/本帧 readback/独立 submit |

CPU coverage/reservation/二维 indirect/lighting-risk oracle、原透视梯度 oracle 与生产 FrameGraph 的 Dawn D3D12 material+lighting→results→Resolve→HDR 已执行。默认预算严格，受控真实纹理 PBR/非零方向光减少重样本；结果不提升正式采用/画质/性能 claims。诊断驱动关闭 shader 优化以缩短编译，不据此测量性能。

阶段三实施映射（2026-09-30）：阶段二的 owner-sample 生产链保留唯一写域，新增本地 **Signal-Rate Cell Layout**。一个 cell record 的四个 2-bit 字段分别表示 lighting/material/emissive/normal 的方向率；CPU `SurfaceSignalPlan.ts` 与 WGSL `SURFACE_SIGNAL_WGSL` 共享 pack/unpack/effective-rate 事实源。Probe 将已通过 continuity、generation、residency、UV footprint 和 variation 检查的候选发布为 packed rates；normal-map、ORM、Coated/未知 closure 的相关字段回退 full。Builder 在 lighting/VSM/AO 风险时只清除 lighting 字段，实际 coverage 取各信号交集，tail 仍由固定 cell 状态定位。worker 读取相同 packed record 并记录 material/lighting coarse counters，Resolve 读取 immutable sample results 并验证 VisibilityKey、depth 资源和 result capacity，不读取正在写入的 HDR。`surfaceResolveReference` 覆盖同 sharing domain、深度/法线容差与 owner fallback 的 CPU 规则。

该阶段采用的分信号布局、边界重建和 tail 处理是 EEngine 本地算法；没有把 Wicked/Intel/DOOM 的局部阶段冒称完整移植，也没有引入全屏 GBuffer、同 UAV 原地滤波、额外 submit 或本帧 readback。CPU signal/Resolve oracle、typecheck、build、build:test 与 Surface 定向检查通过；Dawn D3D12 生产 oracle 尝试时宿主返回 `DXGI_ERROR_DRIVER_INTERNAL_ERROR`，未取得有效 GPU 结果。browser 的完整 signal 组合、画质矩阵和 P50/P95 尚未运行，故不提升正式性能或画质状态。阶段四需继续清理旧合同/owner 并集中做模块收口验证。

阶段一实施映射（2026-09-30）：Continuity Publication 采用本地 **Source-Corner Edge Domains**，源完整属性角点焊接、双向流形边连通、各 LOD 实际角点回查、歧义/更新角点/退化/UV 翻转拒绝，发布到 page 内 primitive metadata；Native 与 WASM 共用 GeometryCooker.cpp。SurfaceProbe 采用本地 **Bounded Four-Corner Probe**：8×8 workgroup 的 64 invocations 各恢复一个 winner，使用 9216-byte workgroup facts 与无条件 barrier，16 个对齐 cell 各读取四角的透视 UV/法线/顶点色，读取同 publication 的各 role 采样签名、全 mip 保守 decoded 区间与实际 residency revision，输出候选方向率及拒绝计数。阶段一候选不是重着色 rate，PBR 保持全率消费，阶段二才切换 sample workers。默认具名预算全零；非恒定纹理 PBR 的 GPU oracle 使用显式受控预算，不将这些测试值冒充收敛后的画质阈值。压缩纹理/不可读来源 variation unknown、normal-map 尚无切线变化证明、Coated/mask/非法身份/版本不符均 full-rate。检索范围是本节冻结的 Forge/Wicked/Intel 完整源码、Decoupled Sampling 论文及 VRCS 原始技术资料；未发现可直接移植的 source-corner metadata 或 pre-material texture variation 全链 donor，以上明确为本地算法，不提升上游采用状态。

以下需按复杂算法实施，而不能通过拆成 helper 规避来源/数学/消费核查：

- **Continuity Publication**：源属性接缝与输出 LOD 属性 → 可共享 domain/risk；跨 primitive/UV/tangent/非均匀缩放/代际规则 → Work Builder/probe。
- **Material Variation / SurfaceProbe**：实际采样路由与驻留 footprint → 必要几何 probe + 有限 variation 查询 → signal rate；未知/越界/不支持过滤模式全率。无现成全链 donor，明确本地设计；CPU/WGSL oracle 检查保守区间与误差预算。
- **Tile Sample Scheduling**：visibility/rate/profile → 隐式 tile 或 compact packets → 多池 tile 级提交/finalize → worker/Resolve；partial reservation 不部分提交，fallback 不依赖第二个可溢出 queue。
- **Signal Resolve**：不可变 sample results + 当前身份/深度/footprint → 有界重建/高频组合 → HDR；无邻居时用 owner sample、互斥写域、颜色/pre-exposure 一次转换、全率不二次滤波。

motion 权威重接、Frame Program resource edges、ABI 编解码和生命周期接线属于本地集成；它们支持上述算法，不因此将整体算法归为“简单工具”。

### 不选为当前 donor 的来源

DACS 独立工程 `da514fe9f6b1a2c5a732b0b9f2e20c25227960e3` 的 license 未明确，不复制；其 wave32/多轮简化光照不作为完整 PBR。DACS 作者 2020 后续说明关于驱动改变导致旧软件实现失去净收益，是评价调度合计成本的提醒，不是反对所有分频着色。FastAtlas 未审完整 supplement/consumer/许可，仍研究参考。Lighthugger README 描述全屏 compute lighting resolve，只能作为 Visibility 组织参考，未审计固定 shader/完整 license，不列入可复制 donor。

### 规范与当前能力依据

核对日期 2026-09-30：[WGSL 2026-09-21 CRD](https://www.w3.org/TR/2026/CRD-WGSL-20260921/)，重点 §14.5 memory model、§17.11 synchronization、§17.12 subgroups 以及纹理采样；[WebGPU living specification](https://gpuweb.github.io/gpuweb/) 用于 device limits/features 与 indirect/resource usage 实现时核对。规范条目不是浏览器支持矩阵，core 路线不依赖固定 subgroup 宽度或 native bindless；optional feature 在资源创建前协商。

正式采用仍要求所选 profile 的源/本地阶段映射、必要 CPU/WGSL oracle 和新生产 GPU 真实消费证据；开发按完整模块运行 typecheck/build/targeted checks，正式平台/画质/性能矩阵遵循根开发节奏，不引入逐批晋级门槛。

## 2026-09-30 Surface 极致性能调查补充（历史调查，未实施）

设计分析见 [Surface 着色性能](../next-design/surface-shading-performance-design-2026.md)，本地代码基线 `f4c2127a`。这次只修改设计/来源记录，不提升 R02/R03/R20/R23 的采用状态，不切换 currentSlice。旧账本关于 ShadingWork/classify/scatter 的阶段历史不作为当前事实；当前生产是 Dense + 七 lane exception，coarse 只覆盖受限静态 Unlit。

**检索与核对顺序**：先检查完整 GitHub 源文件/目录/许可证，再核对 DACS/对象空间着色/FastAtlas 作者资料及 Microsoft 的 DOOM VRCS 第一方说明。The Forge 的 pin 与 R02 相同；Wicked 此次新调查 pin 与 R23 原 pin 分立。未运行任何上游工程。

| 固定来源 / 许可 / 入口 | 源输入 → 阶段 → 输出 | 对应本地候选与必须保留的条件 | 采用边界 |
| --- | --- | --- | --- |
| The Forge `cd5046893faba2dc7869243873bf01f02a6f0df9` / Apache-2.0 / `VisibilityBuffer2/Shaders/FSL/VisibilityBufferShadingUtilities.h.fsl::CalcFullBary, Interpolate2DWithDeriv` | clip vertices + pixel → 透视权重/一像素投影差分 → UV/梯度 | `surface_material_kernel` 的几何 context/setup 复用仍保留 perspective、近裁剪/退化、UV transform 和 LOD 语义；只共享不变输入 | R02 原边界不变；setup 复用为本地设计，不是新的 Forge 整套 port |
| Wicked Engine `df44c3db4c4927492bc9c791eac715d98d7ed091` / MIT (`LICENSE.txt`) / `WickedEngine/shaders/visibility_resolveCS.hlsl, visibility_shadeCS.hlsl` | primitive tile → uniform/divergent 读取、bin mask、原子 append/indirect → 每 tile/pixel Surface 与 light | 候选 tile/profile/family work 对照；保持 shader type/mask 一致与唯一写域；源 bindless/Wave/quad 不直接带入 WebGPU | 本次读两个完整 shader，未审整套 native host；reference only，不覆盖 R23 原 pin |
| Intel CPS `63ad5c1adafbfcc2869a200f50a5ea11f28b4887` / Apache-2.0 / `ComputeShaderTile.hlsl` | 四份 GBuffer surface → depth/normal 判据与 tile light list → 首 sample lighting、其余 full 或 splat；可选 DEFER_PER_PIXEL 队列补算 | 对应 signal-rate lighting 的完整闭环参考；需保留 threshold 单位、所有 full/coarse/无光分支与完整覆盖；本地 high-frequency albedo/AO、motion 和 VG identity 约束另行定义 | R20 仍未采用；不能把其 GBuffer 后判据叫作 pre-material 降频 |
| WeakKnight DACS `da514fe9f6b1a2c5a732b0b9f2e20c25227960e3` / 固定树未发现明确 license / `AdaptiveLightingPass.slang::pass0–pass4, shouldShade, DistributeWork`；`EntryPoint.py`；`Shading.slang` | GBuffer → 稀疏 seed → 四轮邻域方差/插值或重算 → full image；wave 内连续任务重分配 | 供研究执行利用率。此实现与原 DACS 论文的执行组织有差异，不混称作者源码；固定 wave32、RGB 方差 5e-4（以源函数为准）、gamma sqrt 和简化照明均不是本地标准 | 未明确授权前不复制；不选为完整 PBR donor；本轮未做 GPU/边界 oracle |
| WeakKnight OSS `473a59bbcdd30e3366cc567d66a5a97353620d48` / Apache-2.0 (`License`) / `ObjectSpaceShading/Assets/Scripts/ObjectSpaceShadingPipeline.cs`；`Assets/Shaders/Resources/RenderTaskProcessing.compute::RenderTaskPrepare, RenderTaskIndirectDispatch`（均相对工程目录） | 对象 chart/remap/occupancy → shadel 需求/分配 → task/indirect → shading storage/屏幕消费的工程组织 | 长期 view-independent cache 候选；必须继续核读 IDMap、ShadelMemoryProcessing、GI、seam filtering、eviction/history。保持 atlas 映射、失效与完整消费；VG LOD chart 转换是本地未决问题 | 作者工程可获取；本次仅核对部分主链文件与 README/许可，不宣称完整可移植 profile；Unity/RT 依赖不得直搬 |

相关固定链接：

- [The Forge](https://github.com/ConfettiFX/The-Forge/blob/cd5046893faba2dc7869243873bf01f02a6f0df9/Common_3/Renderer/VisibilityBuffer2/Shaders/FSL/VisibilityBufferShadingUtilities.h.fsl)；[Wicked](https://github.com/turanszkij/WickedEngine/tree/df44c3db4c4927492bc9c791eac715d98d7ed091/WickedEngine/shaders)。
- [Intel CPS](https://github.com/GameTechDev/DeferredCoarsePixelShading/blob/63ad5c1adafbfcc2869a200f50a5ea11f28b4887/ComputeShaderTile.hlsl)；[DACS 独立工程](https://github.com/WeakKnight/DeferredAdaptiveComputeShading/tree/da514fe9f6b1a2c5a732b0b9f2e20c25227960e3)；[OSS 作者工程](https://github.com/WeakKnight/real-time-seamless-object-space-shading/tree/473a59bbcdd30e3366cc567d66a5a97353620d48)。
- [DACS 作者方法说明](https://graphics.geometrian.com/research/dacs.html)，HPG 2018；[Microsoft DOOM VRCS 第一方文章](https://developer.microsoft.com/en-us/games/articles/2026/04/variable-rate-compute-shaders-doom-the-dark-ages/)，2026-04-09；[FastAtlas 作者页](https://www.cs.ubc.ca/labs/imager/tr/2025/fastatlas/)，EG 2025。后三者不提供本次已审计的完整 EEngine donor；VRCS 只确认减少 unique compute pixels/整 wave 提前结束的生产方向，不照搬报道收益。

**具名本地方案与缺口**：建议 *EEngine Signal-Rate Surface*，包括 full-rate coverage/motion/identity、保持语义的 VG context/UV/采样复用、bounded tile/profile/family/rate work、分信号 coarse/full 消费和重建。没有核实一个完整 donor 同时覆盖 EEngine 的前置 VisibilityKey 判据、VG Product、有限纹理 profile、PBR/coat/IBL、运动、GPU overflow 和 WebGPU 绑定。不要把这个组合登记为完整 CPS、DACS、VRCS 或 OSS 移植。

**2026-09-30 激进重构排序追加核对**：用户要求主瓶颈优先后，将材质/光照分频及跨 primitive 表面连续性（本地 F+）提为首要目标；不再先做 A/B 小优化。补读 GPC 2025 原始演讲 [Variable-Rate Compute Shaders in DOOM: The Dark Ages](https://static.graphicsprogrammingconference.com/public/2025/talks/variable-rate-compute-shaders-in-doom-the-dark-ages/Fuller-Hammer-variable-rate-compute-shaders-in-doom-the-dark-ages.pdf)，71 页，SHA256 `e5fe7cf223006bf95089eb2890c878a47aecccd612eb9e5398c1fe43273d0fad`。仅技术参考，未找到可据此直接复制的完整许可源码；本轮读取提取文本和阶段说明，不声称运行或完整移植。前述“未核读演讲”的调查范围更新为以下具体范围：

| 演讲阶段/页码 | 本地 F+ 对应 | 分支、不变量和缺口 |
| --- | --- | --- |
| SRI 与 primary/duplicate，11–15 页 | 当前帧风险分析 → 少量采样率/代表位置映射 | 1×1/2×1/1×2/2×2；屏幕覆盖保持精确，历史 luma 不能证明当前新细节安全；新分类规则属本地设计 |
| tiled remap、pixel commands，23–25 页 | 材质代表样本压紧；照明保留 tile/cluster 局部性 | 不能在 wave 内散落少量活跃 lane 后仍跑完整重 shader；无需强制所有阶段同一全局队列。源融合尝试出现 VGPR/长程序困难，本地不预承诺融合必胜 |
| 代表位置/去块/噪声，27–38 页 | identity/depth/信号边界约束的重建 | 必须处理半像素偏移与低率噪声。第 35 页源描述存在同 UAV 原地读写 race，本地明确不复制，采用无竞争读写；这项算法改变不是忠实 port |
| 三角形边缘与低分辨率，42、51–52 页 | 记录边界拒绝率，评估真实可降频覆盖 | foliage、小三角形、低内部分辨率可能降低收益；不引用其原平台耗时作为本地预测 |
| surfaceID 提议，55–58 页 | Product/Cooker 连续性元数据，区分 winner identity 与 shading sharing identity | 属演讲未来方向而非已出货功能；UV/材料/normal/tangent/LOD 等边界由本地定义。同材质或单一 ID 不足以决定整个 PBR 可共享 |
| normal 与反射消费者，62 页 | 材质/光照可采用不同采样率，按需求全率输出关键字段 | full-rate normal 有实际重建/纹理成本，必须计入总时间；不得用隐含全率 PBR 掩盖主线未省工作 |

以上仍为候选设计，不改采用状态、currentSlice 或生产源码。设计文件已明确旧“先 A/B”排序被 F+ 主线替代。

**性能证据反例**：[DACS 作者 HPG 2020 后续说明](https://graphics.geometrian.com/research/dacs_in_hw.html) 记载 GPU driver 改变曾使原样 2018 软件实现失去净性能收益。这里只把它作为不可照搬原调度/收益的证据，不推出所有现代软件自适应 shading 无效。

**WebGPU 不变量**：GPU 生成实际 work 与 indirect，固定少量合法 dispatch，禁止同帧 readback 控制；不依赖未协商 subgroup size、bindless 或跨组自旋；所有 workgroupBarrier 保持 uniform control flow。容量创建前协商；失败 lane 取消不完整 work 并由同帧 full-rate 分支完整覆盖，粗率/全率和不同 profile 写域互斥。

**验证与采用**：此次只做来源/源码分析。后续选定完整 profile 后保留源关键分支、补独立 WGSL/CPU oracle 与真实主链 GPU producer→consumer，之后才提升 adoption。coarse coverage/画质/时域稳定与分类+队列+求值+重建总成本必须同时评价。没有运行 typecheck/build、browser 或 benchmark；依据仓库节奏不为纯设计修改启动这些检查。

## 1. 推荐总表

| 用途 / owner | 优先来源 | 应迁移的范围 | 仍由本地完成的部分 |
| --- | --- | --- | --- |
| Renderer Core / frame-runtime | 现有 FrameGraph；Filament 参考 | 参考图生命周期与裁剪，不替换本地整套图 | 产品语义、有限物理计划、跨 Provider 成本选择 |
| Renderer Core / visibility | GPUPrefixSums | 完整 Reduce-Then-Scan WGSL 算法 | 队列协议、容量、间接执行和生命周期 |
| Scene & Virtual Resources / virtual-assets | 现有 Nyx、meshoptimizer ledger | 继续现有忠实迁移 | 不因 Next 重写正确的 geometry 基础 |
| Visibility & Surface / shading | The Forge VisibilityBuffer2 | 插值、解析梯度及依赖数学 | EEngine identity、资源布局、显式纹理梯度 |
| Surface / Material / Lighting v2 / shading、materials-textures | Filament R03 Standard/Coated/IBL；Khronos Sample Renderer R22 glTF 扩展语义；The Forge R02 属性重建；Wicked R23 为 tile 调度参考；MaterialX R04 可选 authoring 参考 | 固定 Standard/clearcoat 的参数、直接/间接光、环境预过滤；透视插值/梯度与 glTF specular/IOR/coat 语义 | 有界 binding/kernel family、Dense/exception queue 和溢出覆盖、物理天空生产与生命周期；R23 不冒称整套 port |
| Light Transport / shading | XeGTAO | 深度预处理、求值、边缘感知降噪 | 产品空间适配、输出/Temporal 接口 |
| Light Transport / shading、visibility | FidelityFX SDK v1.1.4 SSSR + Denoiser | 分类、工作列表、追踪、验证、完整信号重建 | WebGPU wave/绑定适配和镜面能量组合 |
| Light Transport / shading、virtual-assets、visibility | Timberdoodle（需原型） | 页面需求、分配、失效、缓存、采样 | 无 mesh shader 的硬件 indirect 页执行 |
| Light Transport / shading、virtual-assets | Atlas DDGI（候选）；Speedball（补充） | probe 更新/遮挡/状态/查询；评估软件 ray producer | 动态需求、VG 代理、非 bindless 资源与预算 |
| Light Transport / Screen GI | **UnitySSGIURP 优先算法候选**；Wicked Engine compute 链作执行对照 | 对照完整追踪、fallback、时域、降噪、上采样；实施前固定一个完整 profile | 改写 fullscreen/URP 依赖、GPU ray work、与 World Field/Sky 的能量边界及求值预算 |
| Environment & Media / shading | Takram atmosphere WebGPU | LUT、太阳/天光、shadow-aware aerial transport | 去 Three/TSL 宿主、单位与环境权威 owner |
| Environment & Media / shading | Adria VolumetricFog（候选） | 注入、历史、积分与合成 | bounded binding、介质输入和大气区间合成 |
| Temporal & Presentation / frame-runtime、shading | FidelityFX SDK v1.1.4 FSR3 Upscaler R12；Wicked Engine histogram R24；Filament Bloom/ColorGrading/GT7 R25 | 固定 FSR3 全阶段、两段 histogram/适应、选定 Bloom/grade/tone 阶段 | WebGPU 后端、共享事实/事务、Rec.2020 与 GPU P/E、SDR/HDR canvas 适配；R24/R25 的选定范围已接入，正式画质与性能声明待整链验收 |
| Visibility & Surface / 频率分类 | Intel DeferredCoarsePixelShading（R20）为完整 2×2 coarse/fallback 候选；FidelityFX VRS 仅供另一种分类数学对照 | `RequiresPerPixelShading`、coarse/full 消费与全样本写回须按数据依赖对照 | 当前 VisibilityKey 前置决策、三层频带和 4×4 策略不是上游实现，不得冠以其完成移植 |
| VT / materials-textures | **Wicked Engine 地形 VT + LibVT 通用 VT 双来源候选** | 前者取 GPU 请求/分配/驻留，后者对照页表/过滤/离线切页完整性；先保留 Texture Residency | 两者均不能整套直搬；通用资产布局、WebGPU 有界绑定、异步反馈/上传闭环需原型 |
| Adaptive Compute Shading / shading | R20 有可核实的 2×2 coarse/fallback 完整源码，但没有吻合本地前置 VisibilityKey 决策和三层频率合同的整套 donor | 若选 R20 必须保留其所有决策、执行、写回条件，并明确扩展部分 | 产品身份、材质/光照风险、4×4、WebGPU 有界队列和重建验证 |

## 2. 公共基础与材质来源

### R01 · GPUPrefixSums：优先采用已有 WGSL scan

- **Upstream / Revision**：[b0nes164/GPUPrefixSums](https://github.com/b0nes164/GPUPrefixSums/tree/98d93a4e9ed2f3c8353119515bf9be90a2e137ad)，`98d93a4e9ed2f3c8353119515bf9be90a2e137ad`。
- **Source**：[rts.wgsl](https://github.com/b0nes164/GPUPrefixSums/blob/98d93a4e9ed2f3c8353119515bf9be90a2e137ad/GPUPrefixSumsWebGPUapis/SharedShaders/rts.wgsl)；同目录 `csdl.wgsl`、`csdldf.wgsl`、`csdldf_struct.wgsl` 仅为备选。已读 README、LICENSE 和 RTS 实现。
- **License**：本体 MIT；仓库 LICENSE 另含第三方 BSD notices。所读 `rts.wgsl` 标注 SPDX MIT；实际复制子集保留对应 notice。
- **Local owner / Adoption**：visibility 的工作基础算子；not adopted，首选完整 Reduce-Then-Scan 路线。
- **Retained invariants**：归约、扫描和最终分发阶段完整；分区边界、非整组长度、全零/稀疏计数正确；由 GPU 输出 offset/count 供 GPU 消费。
- **WebGPU differences**：接入本地 queue 生命周期、容量和 dispatch。RTS 选型是选择一个完整上游算法，不是删减 decoupled-lookback；后者需要单独证明设备上的前进保证与内存模型，不依赖跨 workgroup 自旋“碰巧成功”。
- **Fallback / lifecycle**：能力适配保留相同 scan 结果语义；不能借 fallback 将本帧有效工作读回 CPU。队列失败/溢出采用显式界限政策。
- **Local validation**：小型 CPU reference 比较 prefix/total，包括边界长度和容量极限；一个真实 Meshlet/Shading/Ray consumer 检查间接消费。尚未执行该 port 的验证。

### R02 · The Forge：Visibility 后的属性重建

- **Upstream / Revision**：[ConfettiFX/The-Forge](https://github.com/ConfettiFX/The-Forge/tree/cd5046893faba2dc7869243873bf01f02a6f0df9)，`cd5046893faba2dc7869243873bf01f02a6f0df9`。
- **Source**：[VisibilityBufferShadingUtilities.h.fsl](https://github.com/ConfettiFX/The-Forge/blob/cd5046893faba2dc7869243873bf01f02a6f0df9/Common_3/Renderer/VisibilityBuffer2/Shaders/FSL/VisibilityBufferShadingUtilities.h.fsl)（已读）；同子系统 `TriangleFiltering.h.fsl`、`VisibilityBuffer2.cpp` 为关联入口。
- **License**：根 LICENSE Apache-2.0，已读；依赖和第三方资产单独核对。
- **Local owner / Adoption**：shading/visibility；not adopted（本轮新调查，不重置旧 visibility ledger）。
- **Retained invariants**：透视正确属性插值、解析梯度与纹理采样 LOD 关系；退化与裁剪场景不能因换语言而省略必要处理。
- **WebGPU differences**：FSL → WGSL；绑定和 visibility identity 使用 EEngine 合同，不能照搬 native descriptor/indirect。Visibility Buffer 2.0 是数学与组织参考，不搬整套 renderer。
- **Fallback / lifecycle**：已有 Surface/visibility 作为迁移对照；必要 unsupported material 仍经统一主管线的合法 provider 处理，不能静默错误着色。
- **Local validation**：透视平面、高 UV 梯度、退化/近裁剪案例，与参考插值/梯度对照；复用现有 sparse-shading validation。未运行上游工程。
- **Phase 2 extraction and new consumer**：旧 `sparse_shading_resolve.ts` 的 `geometryWgsl`（普通/VG 顶点解码、透视权重和梯度）、`textureWgsl`（bank、UV/采样器与显式梯度）、`materialEvaluationWgsl`（材质、法线、AO 和运动）及 `lightingWgsl`（现有 direct/IBL 数学）提取到 `surface_material_kernel.ts`，新 `surface_material_program.ts` 将其组合为按材质类间接执行的 Surface 程序；旧程序生成器、SurfaceFeature、Sparse Resolve/candidate/revision owner 已删除；提取数学由新 Surface 程序直接消费。共享场景记录另行提取到 `GpuShadingPublication.ts`，旧发布 store 与 pipeline descriptor 已删除。程序特化的 16 类依赖表已从旧 oracle 提到 `GpuSurfaceProgramSpecialization.ts`。`SurfaceProducts.ts` 声明逻辑 Product 与语义资源闭包，`SurfaceKernelBindingPlan.ts` 将其降低为独立的新 WebGPU 物理布局。**来源对照**：固定源 `CalcFullBary` 的透视权重对应本地 `sparse_barycentric`；其 `m_ddx/m_ddy` 为相邻一像素的投影差分，原本地实现是无穷小商法则导数，二者在强透视下不同；新 owner 改用 `(w+wx)/(sum+ix)-w/sum` 与 y 对应式，并保留退化面积、近零齐次 w 与投影分母守卫。`Interpolate2DWithDeriv` 对应本地 UV 顶点值与上述权重/差分的点积；UV transform 的梯度只旋转/缩放、不加 offset，供 `textureSampleGrad`；无效梯度沿本地显式 LOD fallback。普通/VG 顶点解码、材质 bank、Filament-derived direct/IBL 不来自该 The Forge 文件，分别保持 EEngine/Filament 来源，不冒称 The Forge 移植。`SurfaceReconstructionOracle` 已对照相邻像素差分。新 Renderer 的 ShadingWork 经 GPU 分类、压紧和每类间接 dispatch 执行新材质消费者；Virtual Geometry Product V3 的 q16 位置、oct 法线、半精度 UV、切线和顶点色由该 consumer 直接读取，不再从普通稀疏堆取材质属性。独立 browser diagnostic 已实画四象限纹理 VG PBR、非零方向光和 device-loss 恢复；直接光记录按 lit class 需求上传，不启动无消费者的 IBL 预滤。纹理 footprint/梯度、非零光照已有诊断数值对照，混合材质和身份故障已有 GPU 对照；混合符号 w 的近裁剪另有独立投影重建/PBR 数值采样与共同覆盖像素稳定性对照，非共面多三角形的顶点色/法线及 UV 高梯度已有诊断对照；法线贴图切线空间与更多材质组合仍未覆盖；R02 保持 `not adopted`，该诊断不晋级正式画质声明。

R02 的当前边界：[Surface Kernel Binding V1](../specs/surface-kernel-binding-v1.md) 对最宽特化的 16 个 read-only storage buffer 与设备限额作核算；绑定和 ShadingWork 队列是 EEngine 本地集成，不是 The Forge 或 Filament 算法移植。完整 WGSL consumer 已接主图，纹理梯度与非零受光已有独立数值参考的浏览器诊断；近裁剪场景验证混合符号 w、独立投影/PBR 数值采样，以及改变 near plane 后的共同覆盖与裁掉像素；非共面多三角形顶点属性和高梯度已有诊断数值画面对照，法线贴图与更广泛材质组合仍缺，因此 R02 保持 `not adopted`。

复杂几何追加对照：验证宿主的 Product V3 包含两个非共面三角形、逐顶点 oct 法线/颜色、半精度 UV，并对实例施加非均匀缩放。CPU `projectedSurfaceBarycentricReference` 给出每个 primitive 的透视权重及一像素 UV 差分，`evaluateGpuShadingProgramReference` 给出 Filament-derived direct PBR 期望值；两组三角形分别有 71/59 个内部像素在 4/255 内一致，最小物理纹理 footprint 约为 847 texel，确认此场景应采末级 mip。该对照暴露原新 Surface 用模型线性部分直接变换法线的错误；本地以余子式/行列式实现逆转置法线变换，奇异矩阵退回几何法线，切线重新正交化。法线变换是本地几何数学修正，不归为 The Forge 算法移植。浏览器运行仍为 dirty-tree diagnostic，未运行上游工程，也不升级 R02 采纳状态或画质 claim。

### R03 · Filament：沿用 PBR，参考图与照明组织

**Module B 本地集成状态（2026-09-30）**：`SurfaceMaterialPass` 已切换为 Probe → tile Work Builder → GPU finalize → 有限 full/coarse worker → immutable result Resolve 的唯一生产主链；阶段三补充 packed signal-rate layout、有效覆盖和 key/depth/result 边界。Surface 不再发布 motion，TemporalFacts 独立生成 motion/identity；旧 frequency planner、Dense/seven exception lanes、旧 ABI 与旧 Resolve owner 已从生产源码切断。该实现是 EEngine 本地 WebGPU 调度/重建方案，不是 Intel CPS 或 Filament 整体 renderer 的完整 port。集中 typecheck/build、Surface 契约和 ABI checks 已通过；正式浏览器 GPU 消费核对、完整材质画质矩阵和整帧性能仍未运行。因此 R03、R20、R22、R23 均维持 `not adopted` / reference-only，不晋级来源状态。

- **Upstream / Revision**：[google/filament](https://github.com/google/filament/tree/41f996de8fcc2d6b60b73159aa1bc44a05a40700)，调查 pin `41f996de8fcc2d6b60b73159aa1bc44a05a40700`。现有 PBR 使用 [shading ledger](./shading.md) 的既有 pin，**不自动升级**。
- **Source**：[FrameGraph.cpp](https://github.com/google/filament/blob/41f996de8fcc2d6b60b73159aa1bc44a05a40700/filament/src/fg/FrameGraph.cpp)；Module B 固定入口为 [`surface_brdf.fs`](https://github.com/google/filament/blob/41f996de8fcc2d6b60b73159aa1bc44a05a40700/shaders/src/surface_brdf.fs)、[`surface_shading_lit.fs`](https://github.com/google/filament/blob/41f996de8fcc2d6b60b73159aa1bc44a05a40700/shaders/src/surface_shading_lit.fs)、[`surface_shading_model_standard.fs`](https://github.com/google/filament/blob/41f996de8fcc2d6b60b73159aa1bc44a05a40700/shaders/src/surface_shading_model_standard.fs)、[`surface_light_directional.fs`](https://github.com/google/filament/blob/41f996de8fcc2d6b60b73159aa1bc44a05a40700/shaders/src/surface_light_directional.fs)、[`surface_light_punctual.fs`](https://github.com/google/filament/blob/41f996de8fcc2d6b60b73159aa1bc44a05a40700/shaders/src/surface_light_punctual.fs)、[`surface_light_indirect.fs`](https://github.com/google/filament/blob/41f996de8fcc2d6b60b73159aa1bc44a05a40700/shaders/src/surface_light_indirect.fs)、[`CubemapIBL.cpp`](https://github.com/google/filament/blob/41f996de8fcc2d6b60b73159aa1bc44a05a40700/libs/ibl/src/CubemapIBL.cpp)；`libs/filamat/src/shaders/ShaderGenerator.cpp` 和 `filament/src/Froxelizer.cpp` 仅作材质变体/cluster 组织对照。上述具体文件已通过固定 URL 读取，未遍历或运行完整上游工程。
- **License**：根 LICENSE Apache-2.0，已读。
- **Local owner / Adoption**：frame-runtime/shading；新 pin not adopted，既有 port 状态不变。
- **Retained invariants**：图的资源依赖/生命周期和现有 BRDF/能量语义；不要把改组织结构变成重写材质数学。
- **WebGPU differences**：复用本地 FrameGraph 和 compiler；Filament 并不直接提供本设计的 semantic product compiler。Froxelizer 是光源分簇，不是完整 Froxel fog integrator。
- **Fallback / lifecycle**：稳定程序缓存与 revision-local 绑定分离；device loss/resize 按本地 owner 管理。
- **Local validation**：图裁剪/feature-off 与现有材质参考检查；只迁移实际选择的数学/功能，不追求 API 同构。

**Module B 选中的算法 profile**：Standard metallic-roughness + specular/IOR + clearcoat 的参数、直接光、环境间接光，以及预过滤环境 radiance/DFG；不包含 Filament 的整套 Renderer、SSR、SSAO、refraction、cloth、subsurface 或其 native 资源管理。选中 profile 是实现计划，**not adopted**，不自动继承旧 `docs/porting/shading.md` 的数学 authority/验证状态。输入为 canonical 材质/纹理采样、Surface 几何、cluster light、PhysicalSun、环境辐亮度；输出为分项 direct diffuse/specular、indirect diffuse/specular 与 clearcoat 第二 lobe。`Filament.md` 的 [PBR 技术说明](https://google.github.io/filament/Filament.md.html)用于核对物理含义，不替代下表源码。

| 固定源函数/阶段 | 本地拟实现阶段/真实产物 | 必须保留的条件与 WebGPU 差异 |
| --- | --- | --- |
| `surface_brdf.fs` 的 `D_GGX`、`V_SmithGGXCorrelated`、`F_Schlick`、clearcoat D/V | Standard/Coated WGSL closure 函数 | 粗糙度域、NoV/NoL/NoH、F0/F90 与退化守卫；WGSL 数值改写需 CPU/WGSL oracle，不复制 GLSL 宏组合 |
| `surface_shading_lit.fs::getCommonPixelParams/getClearCoatPixelParams` | Material canonical params → GPU PixelParams | dielectric/metal/specular/IOR、coat roughness/normal 与基础层 F0 改写；glTF 属性通道同时对照 R22 |
| `surface_shading_model_standard.fs::clearCoatLobe/surfaceShading`、`surface_light_directional.fs::getDirectionalLight/evaluateDirectionalLight`、`surface_light_punctual.fs::getLight/evaluatePunctualLights` | Standard/Coated direct-light consumer | local/directional incident、距离/角衰减、base/coat lobe、coat attenuation；本地 GPU cluster 和未来 VSM visibility 不来自 Filament 物理布局。B 的 shadow/SSAO-disabled profile 以 direct visibility=1，Filament directional shadow/micro-shadow 分支不宣称已 port |
| `surface_light_indirect.fs::prefilteredDFG/diffuseIrradiance/evaluateClearCoatIBL` | Env diffuse 与唯一 Env specular fallback consumer | roughness→LOD、DFG/Fresnel/energy、coat 直接与 IBL 均存在；AO-disabled 输入 visibility=1，源文件的 SSR/AO/refraction 分支不冒称本模块已移植，未来 provider 按独立模块接入 |
| `CubemapIBL.cpp::roughnessFilter/DFG` | PhysicalSky/Environment radiance → prefilter mips/DFG | GGX 重要性采样/pdf、mip/filter/归一化；源为 CPU cubemap 实现，本地 GPU compute、sky generation/双缓冲/单提交是适配，动态天空性能尚未验证 |

**Fallback / lifecycle**：环境预过滤缺失时明确标注环境镜面未就绪，不以常数高光冒充完整 IBL；上一个完整 sky generation 可在新预过滤完成前继续使用，不能混用半成品。材质/贴图/sky generation 与 GPU 资源按当前提交完成边界退役。**升级条件**：源分支逐项核对、Standard/Coated 的 WGSL/CPU 数值 oracle、glTF 参数一致性、环境 prefilter producer→生产 Surface GPU consumer 全部成立后，才按实际覆盖范围晋级；typecheck/build/targeted tests 在 Module B 连通后集中运行。

### R21 · Granite / Filament FrameGraph：模块 A 的架构对照，非算法移植

- **检索范围与日期**：2026-09-27 核查 Granite 的完整 render graph 实现与许可证、R03 已固定的 Filament FrameGraph 源，以及 GDC 2017 [FrameGraph: Extensible Rendering Architecture in Frostbite](https://www.gdcvault.com/play/1024612/FrameGraph-Extensible-Rendering-Architecture-in) 的公开技术讲解。比较的是资源依赖、编译、裁剪、物理资源与执行边界；没有找到可直接承担 EEngine `Visibility Fact → Surface Field Demand → Temporal/Presentation` 语义规划的完整 donor。这个结论仅覆盖上述来源，不声称穷尽所有仓库。
- **Upstream / Revision / License**：[Themaister/Granite](https://github.com/Themaister/Granite/tree/1b2d1801d2910fb09ebcded2f0bb3a3a781103b5) 固定 `1b2d1801d2910fb09ebcded2f0bb3a3a781103b5`，根 `LICENSE` 为 MIT（已读）；Filament 沿用 R03 的 `41f996de8fcc2d6b60b73159aa1bc44a05a40700`、根 Apache-2.0。GDC 讲解是架构资料，非可复制源码或许可证来源。
- **具体源入口**：Granite [`renderer/render_graph.cpp`](https://github.com/Themaister/Granite/blob/1b2d1801d2910fb09ebcded2f0bb3a3a781103b5/renderer/render_graph.cpp) / `render_graph.hpp` 的 `RenderGraph::add_pass`、`traverse_dependencies`、`bake`、`build_aliases`、`build_physical_resources`、`enqueue_render_passes`；Filament R03 [`filament/src/fg/FrameGraph.cpp`](https://github.com/google/filament/blob/41f996de8fcc2d6b60b73159aa1bc44a05a40700/filament/src/fg/FrameGraph.cpp) 的 `FrameGraph::addPassInternal`、`compile`、`execute`、`import`，并对照同目录 `ResourceNode.cpp`、`PassNode.cpp`。本轮读取了 Granite 源文件的上述入口与许可证、Filament 的 `FrameGraph.cpp` 入口和许可证；未构建或运行上游工程。
- **源职责 → 本地对应**：Granite/Filament 的 pass 注册和资源读写声明 → 已存在的 `FrameGraph.add` / `import_resource`；依赖遍历、裁剪与执行排序 → 已存在的 `FrameGraph.compile`；物理资源生命周期和导入 → `FrameGraphResourceManager` 与 `FrameGraphBindingLayout`。这些只是架构对照，**没有复制上游函数或把它们登记为本地 port**。两者均不提供模块 A 所需的语义产品需求闭包、Topology Identity/Physical Resource Identity 切分和 WebGPU 单提交生命周期；具名本地方案为 **EEngine Semantic Frame Program**，负责这层薄编排并 lower 到现有 FrameGraph。
- **保留与拒绝**：保留显式资源边、无消费者节点裁剪、可复用图编译、imported/persistent/transient 分离；拒绝直接搬 Granite 的 Vulkan barrier、跨队列同步、物理 render pass 和 native descriptor 结构，也不把 Filament FrameGraph 称作 semantic product compiler。GPU 动态工作数仍由本地 Visibility/ShadingWork 产生、GPU 消费，不能通过本帧读回变更拓扑。
- **Adoption / 验证**：`reference only, not adopted`；模块 A 是本地架构集成，不存在可晋级的“Granite/Filament 完整算法移植”。本地检查点为 topology key 稳定性、late binding 正确性、producer→consumer 边、单 submit、feature-off 裁剪，以及模块收口 typecheck/build/必要 targeted tests。浏览器、性能和 formal evidence 留到整体 Next 验收。

### R22 · Khronos glTF Sample Renderer：Module B 材质扩展语义

- **检索范围与日期**：2026-09-27 核查 Khronos glTF Sample Renderer 的材质参数 shader、PBR 主函数与根许可证；比较当前 `gltfMaterials.ts` 的 specular→metallic-roughness 近似及 IOR/transmission 处理。这里只选材质语义与选定 closure 分支，不迁入其 fragment-per-material 宏变体 Renderer。
- **Upstream / Revision / License**：[KhronosGroup/glTF-Sample-Renderer](https://github.com/KhronosGroup/glTF-Sample-Renderer/tree/cc27919cacbb235d2f58a0c0203387efce9375f8f7)，`cc27919cacbb235d2f58a0c0203387efce9375f8f7`；根 [`LICENSE.md`](https://github.com/KhronosGroup/glTF-Sample-Renderer/blob/cc27919cacbb235d2f58a0c0203387efce9375f8f7/LICENSE.md) 为 Apache-2.0，已读。`THIRDPARTY.md` 与所选 shader 的进一步派生 notice 在复制具体表达性代码前逐项复核。
- **具体入口**：[`source/Renderer/shaders/material_info.glsl`](https://github.com/KhronosGroup/glTF-Sample-Renderer/blob/cc27919cacbb235d2f58a0c0203387efce9375f8f7/source/Renderer/shaders/material_info.glsl) 的 `getBaseColor/getSpecularInfo/getClearCoatInfo/getIorInfo` 及各纹理 role；[`source/Renderer/shaders/pbr.frag`](https://github.com/KhronosGroup/glTF-Sample-Renderer/blob/cc27919cacbb235d2f58a0c0203387efce9375f8f7/source/Renderer/shaders/pbr.frag) 的 `MATERIAL_IOR/SPECULAR/CLEARCOAT`、直接光/IBL 分支；`source/gltf/material.js` 为参数装配关联入口。已读固定 shader，未运行上游工程。
- **Source → local**：glTF factor/texture/UV/sampler/通道/default → `gltfMaterials.ts` 规范化 canonical facts；dielectric F0/specular weight/IOR 与 clearcoat factor/roughness/normal → Material v2 参数 record/Coated closure；`pbr.frag` 的基础层与 coat 光照组合 → 本地 Filament profile 的语义交叉核对。输入为 authored glTF 材质和纹理，输出为无信息损失的 canonical material；WebGPU 的 TextureHandle、bounded bank、GPU queue 和 compute shader 是 EEngine lowering。
- **关键分支/缺口**：保留默认值、色彩空间、各 texture channel 与 coat/base 能量关系；不得继续将 KHR specular 只压成 MR 后宣称扩展完整支持。`transmission/diffuseTransmission/volume`、anisotropy、iridescence、sheen 等源文件中存在，但不属于 B 完整 opaque closure profile，必须明确未支持或路由后续具名 composition/closure 模块；不能把透明模式开关当成完整 transmission port。
- **Owner / Adoption / fallback / validation**：materials-textures/shading，**not adopted**。不支持的 authored 特性在发布前显式拒绝或按产品明确的独立 provider 路由；不静默丢字段。B 收口时用 selected extension 参数/default/纹理通道 oracle、WGSL/CPU Standard/Coated 比较及生产 GPU 消费确认，再只晋级选中范围；正式跨浏览器画质比较留最终集成。

### R23 · Wicked Engine：Module B GPU tile 分流参考与本地队列缺口

- **检索范围与日期**：2026-09-27 核查当前固定源码的 analyze→resolve/bin→shade shader 及许可。它展示完整 native visibility tile 着色的关键 shader 阶段，但其 bindless HLSL/host 执行链、WebGPU 队列容量/溢出并未在本次逐项证明可直接移植；本条定位为**架构/阶段参考**，不登记整套算法 port。
- **Upstream / Revision / License**：[turanszkij/WickedEngine](https://github.com/turanszkij/WickedEngine/tree/0c97cfcdc2a146e12e31ef9464a7aece71706264)，`0c97cfcdc2a146e12e31ef9464a7aece71706264`；根 [`LICENSE.txt`](https://github.com/turanszkij/WickedEngine/blob/0c97cfcdc2a146e12e31ef9464a7aece71706264/LICENSE.txt) 为 MIT，已读。与既有 R16 的 SSGI/VT pin 分立，不自动升级 R16。
- **具体入口**：[`visibility_analyzeCS.hlsl`](https://github.com/turanszkij/WickedEngine/blob/0c97cfcdc2a146e12e31ef9464a7aece71706264/WickedEngine/shaders/visibility_analyzeCS.hlsl)、[`visibility_resolveCS.hlsl`](https://github.com/turanszkij/WickedEngine/blob/0c97cfcdc2a146e12e31ef9464a7aece71706264/WickedEngine/shaders/visibility_resolveCS.hlsl)、[`visibility_shadeCS.hlsl`](https://github.com/turanszkij/WickedEngine/blob/0c97cfcdc2a146e12e31ef9464a7aece71706264/WickedEngine/shaders/visibility_shadeCS.hlsl)；`lightCullingCS.hlsl` 仅对照 local light workload，本地 `LightClusterPass` 已是生产 owner。
- **Source → local**：analyze 的 uniform primitive/divergent tile 与计数 → 本地 Dense 命中/异常 tile 统计候选；resolve 的 bin mask/原子 append/indirect 与深度层次 → 本地有限 profile×family queue 和 GPU indirect 的调度参考；shade 的 tile 读取、material/Surface、tiled light → Binned Surface consumer 的数据流参考。输入为 visibility/primitive identity，输出为 tile list、indirect counts、radiance；本地以现有 VisibilityKey/Material publication/FrameGraph 降低，不复制其 native resource index。
- **关键分支/不变量/缺口**：保留 uniform 与 divergent 的判别、跨 wave/group 的计数和 bin 与真实 shader type 对应；源使用 `WaveActiveAllTrue/WaveActiveBitOr/QuadReadAcross*`、`TEXTURE_SLOT_NONUNIFORM` 和 bindless texture table。WebGPU 的 subgroup 能力和尺寸需协商，通用 bindless 不是生产前提。**没有找到该固定源直接提供 EEngine 所需“hot resident profile Dense 求值同时产 exception、bounded queue 溢出时取消半队列并全屏条件 fallback”的完整 donor**。具名本地方案为 *EEngine Dense/Exception Surface Work v2*，必须如实标本地调度，不冒充 Wicked 完整 port。
- **Owner / Adoption / fallback / validation**：shading/frame-runtime，**reference only, not adopted**。容量溢出以 GPU 抑制该 lane binned indirect、启用同 lane 全屏条件 fallback；不借当前帧 CPU readback。B 收口核对 lane 写域、容量/indirect 边界、WGSL/CPU 分类 oracle 和生产 GPU consumer；比较 dense/exception 与现有全员队列局部成本，正式 P50/P95 留最终集成。

### R04 · MaterialX：可选的离线图与 WGSL lowering 参考

- **Upstream / Revision**：[AcademySoftwareFoundation/MaterialX](https://github.com/AcademySoftwareFoundation/MaterialX/tree/2d516f56752abbb8bc5d6d438bfb7970d1b6f8f7)，`2d516f56752abbb8bc5d6d438bfb7970d1b6f8f7`。
- **Source**：[ShaderGraph.cpp](https://github.com/AcademySoftwareFoundation/MaterialX/blob/2d516f56752abbb8bc5d6d438bfb7970d1b6f8f7/source/MaterialXGenShader/ShaderGraph.cpp)、`source/MaterialXGenGlsl/WgslShaderGenerator.cpp`（均已读）。包含拓扑排序、未使用节点处理与 WGSL 生成入口。
- **License**：Apache-2.0，根 LICENSE 已读。
- **Local owner / Adoption**：shading/materials-textures；not adopted，可选，不要求引入完整用户材质语言。
- **Retained invariants**：选中节点图的类型/依赖/输出语义，不将复杂节点悄悄换成常数或简化 BRDF。
- **WebGPU differences**：其 WGSL generator 不等于本引擎 compute material、显式导数与绑定闭包已完成；本轮没有证明它提供目标所需的采样等价去重。先整理已有有限材质编译路径，按实际收益决定采用范围。
- **Fallback / lifecycle**：不支持的 node 显式拒绝或采用已声明 provider；shader cache key 需包含真实图/绑定/能力差异。
- **Local validation**：若采用，用少量代表材质与源生成结果比较输出/依赖；无需为本轮先建设 MaterialX 编辑器。

## 3. 屏幕空间光传输

### R05 · XeGTAO：首选 AO 来源

- **Upstream / Revision**：[GameTechDev/XeGTAO](https://github.com/GameTechDev/XeGTAO/tree/a5b1686c7ea37788eeb3576b5be47f7c03db532c)，`a5b1686c7ea37788eeb3576b5be47f7c03db532c`；项目已 archived，不能假设上游继续维护。
- **Source / host entry**：[XeGTAO.hlsli](https://github.com/GameTechDev/XeGTAO/blob/a5b1686c7ea37788eeb3576b5be47f7c03db532c/Source/Rendering/Shaders/XeGTAO.hlsli)、[`XeGTAO.h`](https://github.com/GameTechDev/XeGTAO/blob/a5b1686c7ea37788eeb3576b5be47f7c03db532c/Source/Rendering/Shaders/XeGTAO.h)、[`vaGTAO.hlsl`](https://github.com/GameTechDev/XeGTAO/blob/a5b1686c7ea37788eeb3576b5be47f7c03db532c/Source/Rendering/Shaders/vaGTAO.hlsl)、[`vaGTAO.cpp`](https://github.com/GameTechDev/XeGTAO/blob/a5b1686c7ea37788eeb3576b5be47f7c03db532c/Source/Rendering/Effects/vaGTAO.cpp) 和该 revision 的 README。已核对三个核心 compute 阶段、可选 depth-normal 生成、格式与 host 顺序；尚未运行上游工程。
- **License**：固定仓库根 `LICENSE` 为 MIT，已读；移植时保留 copyright/license 文本与所复制片段的 notice。
- **论文/详细说明**：[Jimenez 等 GTAO 论文](https://www.activision.com/cdn/research/Practical_Real_Time_Strategies_for_Accurate_Indirect_Occlusion_NEW%20VERSION_COLOR.pdf)核对间接遮蔽积分；上游 README 解释 tuned heuristic、thin occluder、weighted depth MIP、Hilbert/R2、空间降噪和 bent normal；[SAO depth-mip 论文](https://research.nvidia.com/sites/default/files/pubs/2012-06_Scalable-Ambient-Obscurance/McGuire12SAO.pdf)只作深度层次背景。具体移植数值以此固定 XeGTAO 源码为准。
- **Local owner / Adoption**：shading 的 `render/ao/XeGtaoPreparationAbi.ts`、`XeGtaoPreparationPass.ts`、`XeGtaoNoise.ts`、`XeGtaoMainPass.ts`、`XeGtaoDenoisePass.ts`、`shaders/xegtao_preparation.ts`、`shaders/xegtao_main.ts`、`shaders/xegtao_denoise.ts`；许可证副本见 `OEngine/src/render/ao/LICENSE-XeGTAO.txt`。C0–C8 的选定 High scalar 工程链已接入：有 lit consumer 时请求 AO，空场景/无 consumer 时 off，Dense/Binned/overflow 共用当前帧 packed buffer；旧 GTAO/SSGI shader、公开配置和虚假 AO debug 已从运行代码移除。**not adopted**：当前机器未取得 WebGPU adapter，真实 GPU 数值与 producer→consumer 核对仍缺失；directional/bent 未实现。
- **C0–C3 已落实的映射**：`GTAOUpdateConstants`/`ScreenSpaceToViewSpaceDepth` → `packXeGtaoPreparation` 与共享 WGSL uniform；EEngine reverse-Z 的 `projection[10]/[14]` 和 jittered `projection[8]/[9]` 显式换算。`CSGenerateNormals`/`ComputeViewspaceNormal` → `generate_normals`（8×8、四邻斜率边缘选择、R11G11B10 UNORM→`r32uint`）。`PrefilterDepths16x16`/`DepthMIPFilter` → `prefilter`（8×8 线程覆盖 16×16）与 `reduce_mip`（同一 max-depth/falloff 权重）。五级 `r32float` 使用独立瞬态工作纹理；四个 storage 输出的设备用首轮 0–3 加后续 4，只有两个输出的设备用首轮 0–1 加逐级过滤 2–4，均在同一 FrameGraph 命令流中。奇数尺寸的工作纹理保留完整 16×16 tile 的 clamped 填充区，后续级别不提前裁掉组内边缘值；有效像素仍由原 viewport 决定。这是 WebGPU 调度/布局改写。四个 WGSL 入口已通过本仓库 Naga 校验器，局部 CPU oracle 已核对 reverse-Z/法线/奇数尺寸两种拆分；真实 GPU 执行仍未核对，不能据此宣称完整 port。
- **C4 已落实的映射**：`XeGTAO.h::HilbertIndex`/`vaGTAO.hlsl::SpatioTemporalNoise` → 设备期 64×64 `r32uint` LUT 与 WGSL R2/`288×NoiseIndex`（无可靠时间累计默认 0）；`LoadNormal` → 私有 R11G11B10 解码；`XeGTAO_MainPass` → 独立五级点取样、FP32 深度偏置、source horizon 双侧积分、falloff/薄遮挡条件、角度近似和 visibility floor；`XeGTAO_PackEdges`/`XeGTAO_OutputWorkingTerm` → 独立 `r8unorm` packed edge 与 8-bit scalar working term，写入前按源 `+0.5` 量化，C5 用 `round(load×255)` 还原字节。High=3×双向3步，Medium=2×双向2步；尚无 bent/directional。当前选中 FP32 working depth + 独立法线，未启用 FP16 偏置/就地法线；默认 tuned 值和合法动态 override 不额外生成 PSO。五级独立纹理、source point-clamp mip footprint 与两张 `r8unorm` working surfaces 是 WebGPU 物理布局改写。C8 发现并修正奇数 viewport 原先用 ceil mip extent 取样的偏差：只让 padded tile scratch 参与 reduction，Main 按上游纹理的 floor-halved 真实 mip 尺寸定位点取样。两档 WGSL 的先前版本已通过 Naga；局部 CPU oracle 覆盖 Hilbert/R2、平面、接触墙角、薄遮挡、边缘与编码；真实 GPU 数值核对待可用 adapter，采用状态不变。

| 固定源函数/阶段 | 拟本地产物/阶段 | 输入→输出、关键不变量及条件 |
| --- | --- | --- |
| `XeGTAO.h::GTAOUpdateConstants`、`XeGTAO_ScreenSpaceToViewSpaceDepth` | reverse-Z Xe 常量和投影 oracle | reverse-Z raw depth + projection + internal size + world radius → view-depth/NDCToView 常量；finite/infinite far、单位、背景/Y 方向核对 |
| `XeGTAO_ComputeViewspaceNormal`、`vaGTAO.hlsl::CSGenerateNormals` | AO 私有 view-space normal | raw depth 四邻/edge → 几何尺度 normal；外部 screen normal 是源可选输入，depth-normal 默认可独立 pass；不要求 Surface materialized normal |
| `XeGTAO_PrefilterDepths16x16`、`XeGTAO_DepthMIPFilter` | 五级 weighted view-depth mip | raw depth → mip0–4；最远深度参考、半径/falloff 权重、16×16/8×8 workgroup；不能用 EEngine min/max HZB 冒充 |
| `SpatioTemporalNoise`、`XeGTAO_MainPass` | horizon MainPass → raw AO/edges | view depth + normal + Hilbert/R2 + source tuned constants → 双侧 horizon 积分、mip LOD、near-field/thin occluder、2-bit/edge；High 3×双向 3 steps，Medium 2×双向 2 steps；没有可靠时间累计时 NoiseIndex=0 |
| `XE_GTAO_COMPUTE_BENT_NORMALS`、`XeGTAO_EncodeVisibilityBentNormal` | directional quality profile | 同一积分的 bent direction + scalar visibility → packed directional term；不开启时只宣称 scalar profile，不能把 BSDF normal 当源 bent 输出 |
| `XeGTAO_Denoise`、`XeGTAO_Output`、`vaGTAO.cpp::Compute` | `shaders/xegtao_denoise.ts`、`render/ao/XeGtaoDenoisePass.ts` → packed `indirect-visibility` | raw AO/edges → point clamp 的中心/四邻/四对角、对称边缘和 leak、`DenoiseBlurBeta`（非末遍 beta/5）、独立 ping-pong、末遍 1.5 scale → GPU 连续四像素/u32 打包；剩余字节为 255；`max(1,DenoisePasses)`，默认 1 |
| 同帧 AO 间接消费（本地组合政策） | `FrameProgramLowering.ts` → `SurfaceMaterialPass.ts` → `surface_material_kernel.ts` | lit consumer 触发 High scalar；Dense/Binned/overflow 共用 read-only AO storage；`min(materialAO, Xe scalar)` 仅作用于 sky diffuse、Filament cone/cap env specular 与 coat base/lobe；direct/Sun/emissive 不乘 AO；off 无绑定 |

- **Retained defaults and branches**：固定源 `XeGTAO.h` tuned 默认值 radius multiplier `1.457`、falloff `0.615`、distribution power `2`、thin occluder compensation `0`、final value power `2.2`、MIP offset `3.30`、working term scale `1.5`。`XE_GTAO_FP32_DEPTHS`/FP16 偏置、独立法线/`GENERATE_NORMALS_INPLACE`、scalar/bent、denoise pass count 与 temporal noise 条件要按选中 profile 明示。上游 README 的 4K/1080p 毫秒数及 bent 增量只是原生 GPU 测量，不是 WebGPU/EEngine 预算。
- **WebGPU differences**：HLSL→WGSL，reverse-Z 常量、point-clamp gather/LOD、纹理格式和有限 binding 按设备核对；原生单 dispatch 五 storage mip 若不能合法绑定，按可用 storage texture 数分批用相同 filter 产后续 mip，并核对中间量化。最宽 Surface 已有 16 sampled/15 storage，最终 AO 可打包进第 16 个 read-only storage buffer；这是 EEngine 物理编码，不改 Xe 积分。既不预设 float32-filterable、subgroup、bindless，也不引入当前帧 CPU 回读或第二 submit。
- **能量/降级/lifecycle**：XeGTAO 本身输出 near-field indirect visibility，glTF 材质 AO 与之合成是明确标为本地的 policy；VSM direct、未来 GI/SSSR 已遮蔽 radiance 不重复计能。关闭 AO/无 lit consumer/空场景时 Graph 裁剪工作链并使用中性 visibility。Resize/device loss 重建同帧 scratch 与 device-local LUT/pipeline；未能合法保留完整选中 profile 时明确具名缺口/方案，不把近似算法登记为 XeGTAO adopted。
- **C8 模块检查（2026-09-27）**：typecheck、正式 build、test 构建、15 个 Frame Program/Surface/frequency targeted tests、reverse-Z/法线/weighted mip 与 split schedule、High/Medium horizon 和 donor gather/denoise/跨行 pack 的局部 CPU oracle 已通过；最宽绑定核为 16 sampled/16 storage。原有 Surface contract test 的五字段假设更新为七字段及 AO 中性缺省。旧 Naga WASI 不支持 Surface 所需 `unrestricted_pointer_parameters`，headless 浏览器未取得 WebGPU adapter，故没有真实 GPU 数值和画质结论。
- **来源状态提升条件**：固定源函数/阶段逐项核对、WGSL/CPU oracle（投影、法线、mip、horizon、denoise/packing）与新主链真实 GPU producer→Surface 间接 consumer 证据全部齐备，才对**实际完成的 profile**改变 `not adopted`；typecheck/build 或旧 GTAO 记录本身不能晋级。正式 browser matrix、画质和 P50/P95 留整链阶段。

### R06 · FidelityFX SSSR + Reflections Denoiser：首选反射链

- **Upstream / Revision**：[GPUOpen-LibrariesAndSDKs/FidelityFX-SDK v1.1.4](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK/tree/c6efa6bf7f2027b3ec94f28578bb5965eabb9e55)，`c6efa6bf7f2027b3ec94f28578bb5965eabb9e55`。
- **Source**：[SSSR GPU 目录](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK/tree/c6efa6bf7f2027b3ec94f28578bb5965eabb9e55/sdk/include/FidelityFX/gpu/sssr)：`ffx_sssr_classify_tiles.h`、`ffx_sssr_intersect.h`、depth downsample、prepare blue noise/indirect args、common/callbacks；[Denoiser 目录](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK/tree/c6efa6bf7f2027b3ec94f28578bb5965eabb9e55/sdk/include/FidelityFX/gpu/denoiser) 中 `ffx_denoiser_reflections_{reproject,prefilter,resolve_temporal,common,config}.h`。
- **Host 入口**：`sdk/src/components/sssr/ffx_sssr.cpp`、`samples/sssr/sssrrendermodule.cpp`。实施时连同常量、noise 资源、callbacks 和 host 排序对照，不能只抓两段 shader。
- **检查深度 / License**：已读所选 classify/intersect、反射降噪文件及 `sdk/LICENSE.txt`；该固定版本所选源 MIT。未构建上游样例。
- **Local owner / Adoption**：shading/visibility；not adopted，优先迁移。
- **Retained invariants**：基于 roughness/variance 的分类、samples-per-quad/copy flags、ray 与 denoiser tile 两类需求、noise 序列、层次遍历、hit validation、重投影/预滤波/时域 resolve。不得退化成全屏 ray march + 简单 mix 历史后称为 SSSR 移植完成。
- **WebGPU differences**：wave lane/quad 分组和 subgroup 大小显式适配；ray reservation/count 与 indirect 仍由 GPU 闭环。保持深度/法线/roughness/运动输入约定和 specular baseline replacement，资源绑定换成有界 WebGPU bindings。
- **Fallback / lifecycle**：屏幕外/无效 hit 回到环境或 probe；history 随曝光、尺寸、身份和相机切换失效；空 ray list 不执行昂贵 trace。
- **Local validation**：高/低粗糙度、屏幕边界、薄遮挡、揭露/运动下的分类和 hit/temporal 对照；看 ray count、denoiser count 与总成本，不仅 trace 耗时。
- **备用来源**：[旧独立 FidelityFX-SSSR](https://github.com/GPUOpen-Effects/FidelityFX-SSSR/tree/34dcacd1feefcfab2855b82e76c7d711f2020a75)，`34dcacd1feefcfab2855b82e76c7d711f2020a75`，MIT，已读 license/classify/intersect；不作为默认与 SDK 混合拼接。

## 4. Virtual Shadow 与世界 GI

### R07 · Timberdoodle：VSM 页面算法候选，执行后端必须重做

- **Upstream / Revision**：[Ipotrick/Timberdoodle](https://github.com/Ipotrick/Timberdoodle/tree/1987cf3b8ddda42585d2470bb5806efbc96c6cae)，`1987cf3b8ddda42585d2470bb5806efbc96c6cae`。
- **Source**：[virtual_shadow_maps](https://github.com/Ipotrick/Timberdoodle/tree/1987cf3b8ddda42585d2470bb5806efbc96c6cae/src/rendering/virtual_shadow_maps)：`mark_required_pages.hlsl`、`allocate_pages.hlsl`、`invalidate_pages.hlsl`、`free_wrapped_pages.hlsl`、`force_always_resident_pages.hlsl`、`find_free_pages.glsl`、`clear_pages.hlsl`、`clear_dirty_bit.glsl`、`gen_dirty_bit_hiz.hlsl`、`vsm_state.hpp`、`vsm.inl`；采样入口 `src/shader_lib/vsm_sampling.hlsl`。
- **已读关键链**：`vsm.inl`、需求标记/分配、`cull_and_draw_directional_pages.hlsl`。后者实际使用 amplification shader、`DispatchMesh`/mesh shader 与 Daxa 指针风格资源访问。不是拿到 WGSL 翻译即可运行。
- **License**：Apache-2.0，根 LICENSE 已读。
- **Local owner / Adoption**：shading/visibility/virtual-assets；not adopted，需先证明页执行模型。
- **Retained invariants**：完整的 receiver demand → residency/allocation → dirty/invalidation → rendering → sampling 闭环；缓存重用和移动 clipmap/页失效；缺页处理必须与采样保持一致。不能只移植 page table 却宣称 VSM 完成。
- **WebGPU differences**：选中的页面管理算法保持语义；几何发射后端替换为现有 GPU hierarchy + 有界 hardware indirect raster。页批次、viewport/atlas 映射和绑定成本需实测；不用 CPU 获取当前活跃页数后逐页扫描 caster。
- **Fallback / lifecycle**：旧 CSM 仅供离线对照，不进入 Next production fallback；VSM 未完成时允许暂时无影。物理页更新、sun/geometry 变化与 history 的失效范围需连通，缺页采样有明确行为。
- **Local validation**：移动相机/光源、屏幕外 caster、页溢出/回收；同时看 dirty-page 数、caster work 和实际命令开销。本轮未证明可在目标设备上高效执行。

### R08 · Atlas：DDGI 与软件 BVH 主候选

- **Upstream / Revision**：[tippesi/Atlas-Engine](https://github.com/tippesi/Atlas-Engine/tree/76e4916e55706c0f6eac971d17d65bd8feacf70e)，`76e4916e55706c0f6eac971d17d65bd8feacf70e`。
- **Source**：[DDGI shaders](https://github.com/tippesi/Atlas-Engine/tree/76e4916e55706c0f6eac971d17d65bd8feacf70e/data/shader/ddgi)：`rayGen.csh`、`rayHit.csh`、`probeUpdate.csh`、`probeState.csh`、`copyEdge.csh`、`ddgi.hsh`；host `src/engine/renderer/DDGIRenderer.cpp` 的 `TraceAndUpdateProbes`；`data/shader/raytracer/bvh.hsh` 的软件 `HitClosest` 路径。
- **检查深度**：已读上述 host、probe update/state/query 和 BVH；BVH 源确有 `#ifndef AE_HARDWARE_RAYTRACING` 软件分支，不是只有硬件 ray query 的包装。
- **License**：根 `LICENSE.md` MIT，已读。DDGI 源引用论文并注明 WickedEngine inspiration；正式复制前追溯具体派生函数/第三方 notice，根许可证不是全部来源已经核清的证明。
- **Local owner / Adoption**：shading/virtual-assets；not adopted，优先做世界场切片调查。
- **Retained invariants**：radiance 与 distance 样本、hysteresis、距离统计与 Chebyshev 遮挡权重、backface/状态、边缘复制、级联/空间查询的相互关系；若选择 relocation/classification profile，必须逐项对照其完整实现，不以名词替代源码。
- **WebGPU differences**：GLSL → WGSL；非一致纹理访问和 native 绑定不能直接搬。用户已选择首版动态几何与动态光源：必须对照动态结构 refit/rebuild、实例增删/变形、光源变化与 Probe 失效的完整链。ray producer 可以基于声明过的世界代理，不要求追踪所有 VG 微三角形，但代理生产/误差/动态更新是显式设计取舍，不能悄悄用 sky color 或静态烘焙填所有 probe 冒充动态 DDGI。
- **Fallback / lifecycle**：无有效 field 或低置信度时回到声明的 Sky/烘焙边界；相机移动、几何更新与 probe 状态按范围失效；GPU 时间预算限制更新速度。
- **Local validation**：角落漏光、墙后遮挡、移动光源、场边界与历史收敛；首先证明样本确实来自合法 producer，再评估规模和吞吐。

### R09 · Speedball：WebGPU DDGI 补充来源

- **Upstream / Revision**：[cl0nazepamm/speedball](https://github.com/cl0nazepamm/speedball/tree/a997aee5b0791be61b49719377e811c41720df59)，`a997aee5b0791be61b49719377e811c41720df59`。不是演示站的 `norio/speedball-gi`。
- **Source**：[js/gi_probes.js](https://github.com/cl0nazepamm/speedball/blob/a997aee5b0791be61b49719377e811c41720df59/js/gi_probes.js)、`js/spectral_traverse.js`、`js/gi_budget.js`、`js/gi_oct.js`。已读 README/LICENSE 和大文件中 probe update、classification、variance/query、BVH 生命周期相关段落；**未逐行审计整份约 292k 字符实现**。
- **License**：根 MIT 已读；Three/three-mesh-bvh 等依赖按对应许可证追踪。
- **Local owner / Adoption**：shading/virtual-assets；not adopted，WebGPU 可行性补充，不替换 Atlas 调查或本地 Scene。
- **Retained invariants**：选中 probe 更新、距离可见性、backface 分类、预算与历史必须成链。文件开头 phase 注释和实现不完全同步：正文已有 `classifyKernel` 等逻辑，不能凭旧注释断言它缺 classification。
- **WebGPU differences**：支持 Three WebGPU/TSL 及另一后端不意味着可零成本移植到 EEngine。源码含依赖主线程/idle 的同步 BVH rebuild 路径，需要与 GPU-ready 资产/Worker 流程适配；先确认真正 GI traversal 的完整调用链，不能误用 `caustic_bvh.js` 当 GI 主 producer。
- **Fallback / lifecycle**：迁移候选必须保持更新预算与重建期间 field 有效性；禁止把闲时 rebuild 的暂停/卡顿悄悄带入场景 publication。首版动态 GI 已确认，仅能等待场景静止再更新的路径不足以满足该要求；保留其算法参考，执行与更新后端必须另行验证。
- **Local validation**：补完整 producer→probe update→shading consumer 映射后再做同一 GI 场景对照。本轮仅证明存在相关源实现，不宣称成熟度或大场景性能。

## 5. 物理环境与介质

### R10 · Takram：Physical Environment 的主要来源

- **Upstream / Revision**：[takram-design-engineering/three-geospatial](https://github.com/takram-design-engineering/three-geospatial/tree/b012ad06d858fc035d88aacfd73f092f93c994e4)，`b012ad06d858fc035d88aacfd73f092f93c994e4`。用户展示链接是效果入口，真正主要代码在该仓库 atmosphere package。
- **Source**：[packages/atmosphere/src/webgpu](https://github.com/takram-design-engineering/three-geospatial/tree/b012ad06d858fc035d88aacfd73f092f93c994e4/packages/atmosphere/src/webgpu)：`AtmosphereLUTTexturesWebGPU.ts`、`AtmosphereLightNode.ts`、`multiscattering.ts`、`runtime.ts`、`AerialPerspectiveNode.ts`、`precompute.ts`、`common.ts`；`packages/atmosphere/WEBGPU.md`。
- **检查深度**：本轮读 WebGPU 说明、multiscattering 实现与 package LICENSE，核对关联入口。说明明确为 Bruneton 4D LUT 配合 Hillaire 高阶多重散射 LUT，以及避免精度问题的散射积分路径；实施时仍需完成各入口逐项映射。
- **License**：package LICENSE 包含 MIT 主体、Bruneton BSD 条件和 Hillaire notices。不能只写“整个算法 MIT”；复制所选代码时保留派生来源及相应条款。
- **Local owner / Adoption**：Environment & Media（路由 shading）；选定的无影 Non-Geospatial production profile 已接入 Sun、Sky、aerial 与单一 Renderer 路径。`tools/atmosphere-port/` 固定原始源码、SHA-256 和离线 TSL 依赖；四个 LUT 阶段生成于 `OEngine/src/shaders/atmosphere/lut.ts`，运行时由 `AtmosphereLutResources.ts` 拥有。场景原点映射至地表 6360 km，局部 Y 向上；Sun/Sky/aerial 共用环境参数和版本。正式 GPU 画质与 adoption 留到最终验收。
- **Non-Geospatial 强制范围**：以固定版本 `storybook-webgpu/src/atmosphere/NonGeospatial-Story.tsx` 为局部场景光照接入依据，原文件已归档到 `tools/atmosphere-port/upstream/`。不得在 EEngine 或迁移工具直接依赖 `@takram/*` npm 包；只移植核对后的源码和资源，Three 仅作离线 TSL 编译器。该示例实际接入 AtmosphereLight，并未接入 SkyNode/aerial；Phase 3 的 Sky/aerial 仍需独立闭环。逐入口映射与重现命令见 `tools/atmosphere-port/README.md`。
- **Retained invariants**：预计算/运行时参数一致，太阳透射、直射/间接散射和 aerial transport 在同一单位与空间下组合；所选 shadow-aware transport 不能省成单纯距离雾。光照与天空消费同一个环境状态。
- **WebGPU differences**：TSL → WGSL 或本地生成器；不引入 Three/R3F runtime。去地理接口不等于删除行星尺度、观察高度和大气几何模型；由 EEngine 约定世界长度与局部原点映射。
- **Fallback / lifecycle**：固定 Earth LUT 不因太阳或天空参数更新而重算；LUT profile 版本变更时整组替换，并在最后一次 frame 使用完成后退役旧组。Phase 3 使用显式零 shadow length，非零输入在 VSM 生产者接入前拒绝；不将未实现的阴影散射分支冒充完成。
- **Local validation**：固定太阳高度和观察高度下对照透射、天光与 aerial perspective；检查太阳方向/曝光/长度转换，而不只比较天空截图。

### R11 · Adria：Froxel 局部介质候选

- **Upstream / Revision**：[mateeeeeee/Adria](https://github.com/mateeeeeee/Adria/tree/8b8b365e1307030481085dc3504ca8973ef79af2)，`8b8b365e1307030481085dc3504ca8973ef79af2`。
- **Source**：[VolumetricFog.hlsl](https://github.com/mateeeeeee/Adria/blob/8b8b365e1307030481085dc3504ca8973ef79af2/Assets/Shaders/Lighting/VolumetricFog.hlsl)，`LightInjectionCS`、`ScatteringIntegrationCS`；host `Source/Rendering/FogVolumesPass.cpp`。已读两份实现，包含 Texture3D history、注入/积分/合成生命周期。
- **License**：根 MIT 已读，选取代码时仍保留文件/依赖 notice。
- **Local owner / Adoption**：shading；not adopted，局部介质迁移候选。
- **Retained invariants**：密度/散射输入、光注入、时域重投影与路径积分的前后依赖；不能把体积介质简化成后处理颜色 lerp 仍保留原算法名称。
- **WebGPU differences**：HLSL 和 `ResourceDescriptorHeap` 换成明确有界 bindings；Froxel history 接 Temporal & Presentation，Local Volume/Particles 数据接本地场景。将输入扩成统一消光/散射系数属于明确扩展，不能宣称已完整复刻 Frostbite。
- **Fallback / lifecycle**：无介质返回零散射/单位透射；resize、相机与光源变化参与 history 失效。与大气分配路径区间，透明合成按实际深度处理。
- **Local validation**：均匀介质可解析积分对照、局部体积边界、运动历史和阴影中的光散射；验证关闭后的零成本产品裁剪。

## 6. Temporal 与频率分类

### R12 · FSR3 Upscaler：默认非神经重建候选

- **Upstream / Revision**：与 R06 相同的 [FidelityFX SDK v1.1.4](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK/tree/c6efa6bf7f2027b3ec94f28578bb5965eabb9e55)，`c6efa6bf7f2027b3ec94f28578bb5965eabb9e55`。
- **Source**：[fsr3upscaler GPU 目录](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK/tree/c6efa6bf7f2027b3ec94f28578bb5965eabb9e55/sdk/include/FidelityFX/gpu/fsr3upscaler)，`ffx_fsr3upscaler_{prepare_inputs,prepare_reactivity,luma_pyramid,shading_change,shading_change_pyramid,accumulate,reproject,upsample,luma_instability,rcas}.h` 及其 common/callback 依赖；host `sdk/src/components/fsr3upscaler/ffx_fsr3upscaler.cpp`。
- **检查深度 / License**：固定 SDK v1.1.4 源子集、MIT `sdk/LICENSE.txt`、host 时序与资源 ABI 于 `tools/fsr3-port`。本地 `OEngine/src/render/passes/fsr3/` 实现所选 Upscaler 的 Prepare Inputs、Luma/Shading SPD、Shading Change、Prepare Reactivity、Luma Instability、Accumulate/Reproject/Upsample 与 RCAS，统一 FrameGraph 内执行。
- **Local owner / Adoption**：frame-runtime/shading；production implementation integrated。源码完整性、typecheck/build 和针对性测试完成；GPU 运行、视觉质量和正式 adoption 留到 Next Renderer 总体验收，不从编译结果推断。
- **Retained invariants**：所选版本的 motion/depth/exposure/jitter 约定、输入准备、reactivity/shading-change、重投影/累积/重建与稳定性处理。保留合法 profile 内全部必要阶段；可选 sharpening 等范围预先写清。不能替换成历史 mix + sharpen 仍称 FSR3。
- **WebGPU differences**：HLSL/GLSL callbacks 和 wave 操作改成 WGSL；资源/格式 limits 协商；Temporal Fabric 提供公共状态而不强行替换算法内部历史语义。这里选的是 **Upscaler，不包含 Frame Generation**。
- **Fallback / lifecycle**：当前生产路径只运行 FSR3；旧 analytic baseline 不再作为并行运行时后端。相机切换/明显 cut、分辨率与曝光变化使用 Temporal Fabric 有效性和 FSR3 自有 history 重置。FSR 不是 sparse/coarse shading 自动正确的保证，Visibility & Surface 必须提供合法输入与置信度。
- **Local validation**：静态细节、运动细边、遮挡揭露、透明/高亮、曝光和动态分辨率；用固定源输入/输出作对照，连同完整重建成本评估。

### R24 · Wicked Engine：Module D GPU histogram 自动曝光

- **检索与选择（2026-09-27）**：核对 Wicked 的完整 GPU histogram 主链、Godot `servers/rendering/renderer_rd/effects/luminance.cpp` / `shaders/effects/luminance_reduce.glsl`、Falcor `Source/RenderPasses/ToneMapper/*`，并用 [Alex Tardif histogram 文章](https://www.alextardif.com/HistogramLuminance.html)核对分箱、黑像素和时间适应。Godot/Falcor 的平均亮度或最高 mip log 平均易受极端构图影响，不选作 D 的完整 donor；文章是解释资料，不替代代码。以上仅是已核范围，不声称穷尽来源。
- **Upstream / Revision / License**：[turanszkij/WickedEngine](https://github.com/turanszkij/WickedEngine/tree/0c97cfcdc2a146e12e31ef9464a7aece71706264)，`0c97cfcdc2a146e12e31ef9464a7aece71706264`，根 `LICENSE.txt` 为 MIT（已读）。与 R23 共享同一 pin，但采用状态独立。已读以下固定源码入口；未构建/运行上游工程。
- **具体入口**：[`WickedEngine/shaders/luminancePass1CS.hlsl`](https://github.com/turanszkij/WickedEngine/blob/0c97cfcdc2a146e12e31ef9464a7aece71706264/WickedEngine/shaders/luminancePass1CS.hlsl) `main`；[`luminancePass2CS.hlsl`](https://github.com/turanszkij/WickedEngine/blob/0c97cfcdc2a146e12e31ef9464a7aece71706264/WickedEngine/shaders/luminancePass2CS.hlsl) `main`；[`WickedEngine/wiRenderer.cpp`](https://github.com/turanszkij/WickedEngine/blob/0c97cfcdc2a146e12e31ef9464a7aece71706264/WickedEngine/wiRenderer.cpp) `CreateLuminanceResources`、`ComputeLuminance`，以及常量/offset 定义的 `ShaderInterop_Postprocess.h`。本地入口：`GpuRadiometryPass.ts` 的 histogram/adapt WGSL、`RadiometryContract.ts` 的 GPU 状态、`FrameProgramLowering.ts` 的生产边、`SurfacePresentPass.ts` 的显示消费。

| 固定源阶段/决策 | Module D 本地拟产物 | 保留条件与明确差异 |
| --- | --- | --- |
| `CreateLuminanceResources/ComputeLuminance` | `GpuRadiometryPass.ts` 双槽 adapted-exposure、Frame Program radiometry stage | 半分辨率采样、Pass1→Pass2→下帧资源生命周期；GPU work 同一 frame submit，无 CPU 曝光读回 |
| `luminancePass1CS::main` | `GpuRadiometryPass.ts` scene-linear HDR/`P_t` → 分组 histogram → 全局 bins | 低亮 bin 0、log2 区间截取、bin index `[1,N-1]`、组共享计数与全局 atomic 累计；WebGPU workgroup size/storage 限额调整 |
| `luminancePass2CS::main` | `GpuRadiometryPass.ts` bins + 上帧 adapted luminance → `E_t`；`GpuRadiometryOracle.ts` CPU 对照 | weighted bin-index reduction、排除 bin 0 的像素数、反 log、真实 delta-time 指数适应、key/adapted luminance、末尾清全部 bins；空图/NaN 正值守卫为本地 WebGPU 合同 |
| source Rec.709 `dot(color, 0.2127/0.7152/0.0722)` | linear Rec.2020 的 scene luminance meter | 源系数**不能**直接用于目标 Rec.2020 RGB；改为目标工作空间亮度系数或显式转换回源基底，是具名色彩空间适配。不能一面改系数一面称字节级原样移植 |

- **边界、fallback、adoption**：Wicked 返回 exposure 是 `eyeAdaptationKey/max(adaptedLuminance,epsilon)`；EEngine 将其作为 GPU `E_t`，并以已提交 `P_t` 预曝光，不照搬 Wicked 的 host 渲染架构。中心加权/percentile/高亮保护未选入本次范围。选定两段 histogram/适应为 `traceable local port`：固定源分支已核对，CPU oracle 和独立 Chrome GPU 数值比对已通过，生产 FrameGraph 的 radiometry→Present 消费已在最小示例与 Dungeon 运行。正式曝光画质/性能矩阵后置。

### R25 · Filament：Module D Bloom、ColorGrading 与 GT7 显示映射

- **Upstream / Revision / License**：沿用 R03 [google/filament](https://github.com/google/filament/tree/41f996de8fcc2d6b60b73159aa1bc44a05a40700) 固定 `41f996de8fcc2d6b60b73159aa1bc44a05a40700`，根 `LICENSE` Apache-2.0（已读）；本条的算法采用状态不继承 R03 PBR。已读所列具体源文件，未构建或运行上游工程。Godot fixed `6210a2fd88ed3f512b3093d0be74e2541f463b84`（MIT）tonemap shader 声明简化 AgX 近似，不作为完整 AgX 来源；Falcor fixed `759aad033ff610fb0d82c74f7e0a508d0096d5f2`（BSD）tone pass 仅作对照。
- **具体入口**：[`filament/src/PostProcessManager.cpp::bloom`](https://github.com/google/filament/blob/41f996de8fcc2d6b60b73159aa1bc44a05a40700/filament/src/PostProcessManager.cpp) 与 [`filament/src/materials/bloom/`](https://github.com/google/filament/tree/41f996de8fcc2d6b60b73159aa1bc44a05a40700/filament/src/materials/bloom) 的 `bloomDownsample.mat`、`bloomDownsample2x.mat`、`bloomDownsample9.mat`、`bloomUpsample.mat`；[`filament/src/details/ColorGrading.cpp`](https://github.com/google/filament/blob/41f996de8fcc2d6b60b73159aa1bc44a05a40700/filament/src/details/ColorGrading.cpp) `hdrColorAt`/LUT 生成；[`filament/src/materials/colorGrading/colorGrading.fs`](https://github.com/google/filament/blob/41f996de8fcc2d6b60b73159aa1bc44a05a40700/filament/src/materials/colorGrading/colorGrading.fs) LUT sampling；[`filament/src/ToneMapper.cpp::GT7ToneMapper`](https://github.com/google/filament/blob/41f996de8fcc2d6b60b73159aa1bc44a05a40700/filament/src/ToneMapper.cpp)。源注释引用 SIGGRAPH 2025 *Driving Toward Reality: Physically Based Tone Mapping and Perceptual Fidelity in Gran Turismo 7*；论文全文本轮未独立取得，不记为已读论文。

| 固定源阶段/分支 | Module D 本地拟产物 | 保留的条件、输入输出及差异 |
| --- | --- | --- |
| `PostProcessManager::bloom` + 2×/9×/常规 downsample、upsample materials | `BloomPass.ts` output HDR → Bloom mip 链 → HDR 合成 | 选 High core、threshold on、flare/dirt off；保留奇偶尺寸 9/13 tap、kernel 权重、边界采样、层级合成；WebGPU physical pass 和纹理 usage 适配，关闭的可选效果不宣称已 port |
| `ColorGrading.cpp::hdrColorAt` 的 LogC、white balance、ASC CDL、contrast、vibrance、saturation、GT7 tone、gamut/OETF 与 LUT 生成 | `DisplayColorGrading.ts` 静态 SDR grade+tone+display LUT；`SurfacePresentPass.ts` 采样 | 源顺序保留；动态曝光在 LUT 采样前应用，不每帧重建 LUT。未选中的调整参数和自定义 LUT 不冒称已 port |
| `ToneMapper.cpp::GT7ToneMapper` | `DisplayColorGrading.ts` Rec.2020 工作 HDR → GT7 tone 数学 → SDR 与 extended HDR LUT | `Rec2020_to_ICtCp`、toe/shoulder、chroma scale、blend、SDR correction 与亮度上限；HDR 目标峰值为本地 1000-nit profile |
| `colorGrading.fs` LUT sampling 与 `ColorGrading.cpp::hdrColorAt` | `SurfacePresentPass.ts` SDR/HDR LUT consumer、opt-in HDR 宽范围输出适配 | 源 `hdrColorAt` 在 OETF 前 `saturate(v)` 到 `[0,1]`；它**不能原样用于 extended HDR**。HDR 采用 `DisplayColorGrading.ts` 具名本地 `rgba16float` LUT 和 linear Display-P3 输出，不声称 Filament 当前 SDR LUT 原样提供 HDR |

- **WebGPU / lifecycle / adoption**：静态 LUT 在 device 期建立，静态 grade 变化时更新；Bloom 是暂存 mip 链；SDR baseline 写 preferred canvas 格式；HDR opt-in 探测 `rgba16float`、`toneMapping: extended` 与 colorSpace，失败回退 SDR。选定 Bloom/grade/GT7 阶段已按固定源映射实现，并在 Chrome 的生产 Bloom→Present 链截图运行，CPU LogC/GT7/SDR-HDR LUT oracle 已通过；**当前仍为 provisional local integration**，待补更完整的源数值对照和 GPU 读回再提升为 `traceable local port`。HDR 分支未经 HDR 显示器验证，画质与显示性能声明留最终系统验收。

### R13 · FSR2：备选，不与 FSR3 内部阶段拼装

- **Upstream / Revision**：[GPUOpen-Effects/FidelityFX-FSR2](https://github.com/GPUOpen-Effects/FidelityFX-FSR2/tree/1680d1edd5c034f88ebbbb793d8b88f8842cf804)，`1680d1edd5c034f88ebbbb793d8b88f8842cf804`（2.2 来源）。
- **Source**：`src/ffx-fsr2-api/shaders/ffx_fsr2_{reconstruct_dilated_velocity_and_previous_depth,depth_clip,lock,accumulate,reproject,upsample,compute_luminance_pyramid,rcas}.h`。
- **License / 检查深度**：已读 LICENSE.txt，MIT 文本；GitHub 检测显示 NOASSERTION 不等于无许可。目录核对，不声称本轮读完所有 shader。
- **Local owner / Adoption**：frame-runtime/shading；not adopted，备选。若改选，完整采用该版本时序、锁与历史语义；不把 FSR2 的 lock 阶段机械套进 FSR3。
- **WebGPU / lifecycle / validation**：与 R12 相同的能力协商与重建输入要求；切换为独立 backend，做该版本自己的对照，不能继承另一版本的证据。

### R14 · FidelityFX VRS：仅作为频率分类来源

- **Upstream / Revision**：FidelityFX SDK v1.1.4，`c6efa6bf7f2027b3ec94f28578bb5965eabb9e55`。
- **Source**：[ffx_variable_shading.h](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK/blob/c6efa6bf7f2027b3ec94f28578bb5965eabb9e55/sdk/include/FidelityFX/gpu/vrs/ffx_variable_shading.h)，已读；所选 SDK MIT 条款同 R06。
- **Local owner / Adoption**：shading；not adopted，有限算法参考。
- **Retained invariants**：如移植其对比度/运动分类，保留对应输入、阈值含义和输出区域语义；不等于所有材质可由 roughness 降频。
- **WebGPU differences**：上游输出 hardware VRS image，WebGPU 默认没有对应 shading-rate attachment。可采用分类数学，之后的 compute-work 生成与质量重建必须明确为本地新集成，不能标记为“完整 VRS 已迁移”。
- **Fallback / lifecycle**：full-rate 可作为合法计划；history 无效或高频边界不能只复制低频结果。
- **Local validation**：同时比较分类开销、总工作量与重建误差。该 donor 没有解决本引擎 adaptive compute shading 的完整正确性问题。

### R20 · Intel DeferredCoarsePixelShading：2×2 coarse/full 闭环候选，未采用

- **Upstream / Revision**：[GameTechDev/DeferredCoarsePixelShading](https://github.com/GameTechDev/DeferredCoarsePixelShading/tree/63ad5c1adafbfcc2869a200f50a5ea11f28b4887)，`63ad5c1adafbfcc2869a200f50a5ea11f28b4887`；仓库 `licence.txt` 为 Apache-2.0，`ComputeShaderTile.hlsl` 文件头保留 Intel 2017 版权/许可文字。本地仅在 ignored `.local/references/` 核读，不把下载文件当设计权威。
- **Source / entry points**：[ComputeShaderTile.hlsl](https://github.com/GameTechDev/DeferredCoarsePixelShading/blob/63ad5c1adafbfcc2869a200f50a5ea11f28b4887/ComputeShaderTile.hlsl) 的 `ComputeSurfaceDataFromGBufferAllSamplesCPS`、`RequiresPerPixelShading`、`ComputeShaderTileCS`；`GBuffer.hlsl` 的 GBuffer surface 构造；`App.cpp` 的 host 调度。已读 shader 主链和 README，未运行 DX11 样例，也未逐项审完 host 状态生命周期。
- **源决策与阶段**：每个 2×2 block **先**取四个 GBuffer surface，再以首样本的 view-space 深度导数乘 `CPS_RATE * sqrt(2)` 比较其余深度差、以各通道法线差阈值 `sqrt(1/2) * π/180` 判定 full-rate；tile min/max 深度与 frustum 建局部光表；首样本总是着色，有风险时余下三样本各自着色（或组共享列表延迟补做），否则将首结果 splat 到其余样本；无光/无效样本有显式清零分支。不能只移植 `RequiresPerPixelShading` 而宣称完整 CPS。
- **本地映射 / 缺口**：上游的 GBuffer-first CPS 判据与 tile light-list 分支没有被冒称为 WebGPU port。当前本地采用具名的 **EEngine Signal-Rate Surface**：`SurfaceProbe` 在材质求值前发布 continuity/variation/risk，`SurfaceSampleAbi`/`SurfaceSignalPlan` 打包方向 signal rate，`SurfaceMaterialPass` 的 Work Builder/finalize/worker/Resolve 消费同一布局；full/coarse、mixed tail、overflow 和 key/depth/result 边界均在同一 FrameGraph 主链内。该路径保留 R20 所需的代表样本/覆盖不变量，但 producer、绑定和重建属于 EEngine 本地集成；R20 仍 **not adopted**。
- **WebGPU 差异 / fallback**：上游是 DX11 flat MSAA UAV + group-shared 光表和 16-bit 坐标打包；本地只有 WebGPU 核心可用，VisibilityKey、GPU compact/indirect、LightCluster 与 radiance texture 需分别建立有界 ABI、overflow 与消费者。不能把 2×2 输出复制到不同 identity、alpha/遮挡揭露或高频区域；历史复用仍禁用至 Phase 3。
- **待验证**：Surface signal/sample/投影梯度、容量 overflow、材质/Product ABI、Temporal 与 source-cleanup checks 已通过；Dawn D3D12 生产 oracle 受宿主 `DXGI_ERROR_DRIVER_INTERNAL_ERROR` 阻断。正式 browser、完整 normal/emissive/Coated 画质矩阵及分类+队列+着色+重建总 GPU 成本仍缺，因此不升级 R20 采纳或 adaptive performance claim。

### EEngine 本地条件 · 发布证明的单 texel unlit 纹理

- **检索范围与 donor 缺口**：R20 的分类发生在四份已重建 GBuffer 之后，不能在昂贵材质求值之前证明纹理常量；R14 读取上一帧亮度和 motion，输出硬件 VRS image，不提供 WebGPU compute shading 的同帧材质发布证明。两份固定 revision 的完整源入口如上，均未实现本条件。因此它是 **EEngine 本地精确条件**，不是 R20/R14 的完整或部分算法移植，也未以同名效果冒充。
- **本地入口、决策与依赖**：当前 Surface 入口为 `SurfaceMaterialPass`、`surface_sample_work.ts`、`surface_sample_worker.ts` 和 `SurfaceSignalPlan.ts`；材质/纹理 publication 通过 ABI v7、residency revision 和 variation 区间进入 Probe。常量/未知/高频信号按明确预算分别 coarse 或 full，不能以单 texel 证明普通 PBR 的普遍收益。
- **fallback / 差异 / 验证**：缺 publication、normal/ORM/emissive/Coated 风险、shadow/AO/sky/IBL 或边界不满足预算时保持同架构 full-rate；tile pool 不足时整 tile fallback。正式画质、跨设备全帧性能和动态纹理源变更矩阵仍开放。

## 7. 补充核查：可替换原空白选型的源码

### R15 · UnitySSGIURP：Screen GI 完整信号链优先候选

- **Upstream / Revision**：[jiaozi158/UnitySSGIURP](https://github.com/jiaozi158/UnitySSGIURP/tree/8450297537b658218be1abbc973e9240a2aab71c)，`8450297537b658218be1abbc973e9240a2aab71c`；根 `LICENSE.md` 为 MIT。
- **Source**：[ScreenSpaceGlobalIllumination.shader](https://github.com/jiaozi158/UnitySSGIURP/blob/8450297537b658218be1abbc973e9240a2aab71c/Shaders/ScreenSpaceGlobalIllumination.shader)、`Shaders/SSGI.hlsl`、`Shaders/SSGIDenoise.hlsl`、[ScreenSpaceGlobalIlluminationURP.cs](https://github.com/jiaozi158/UnitySSGIURP/blob/8450297537b658218be1abbc973e9240a2aab71c/Runtime/ScreenSpaceGlobalIlluminationURP.cs)。已核实 host 的 history/fallback 调度和 shader 声明的 direct-light copy、trace、temporal reprojection、spatial denoise、stabilization、history depth、GI combine/upscale 阶段；未逐函数审计所有质量分支。
- **Local owner / Adoption**：shading/temporal；**not adopted**。替换此前“完全无 Screen GI donor”的判断，作为实施前首个完整算法 profile 候选；不是已经选定的生产移植。
- **必须保留**：直接光与间接光拆分、防止重复计能；screen hit/miss 与 Sky/Probe fallback；运动/深度历史有效性、拒绝、降噪、上采样。URP 的 ambient/APV 输入语义须与本地 World Field/Sky 显式对照，不能只搬 raymarch 函数。
- **WebGPU 差异 / 风险**：原实现是 Unity URP fullscreen blit + GBuffer + camera history，不是 GPU ray queue，也不自动满足 EEngine 的 workload reduction。候选迁移应把昂贵 trace 变成分类后 GPU consumer，比较分类/压缩/dispatch 成本；保留信号处理语义，不能宣称上游已有该 queue。历史所有权接本地 Temporal，透明/缺屏幕数据需具名 fallback。
- **验证映射**：固定场景比较静态/运动、遮挡揭露、屏外 hit、强 emissive、Sky/Probe 边界与能量；先证明完整阶段对照，再决定队列化是否有净收益。上游工程未运行。

### R16 · Wicked Engine：compute SSGI 与地形 VT 闭环

- **Upstream / Revision**：[turanszkij/WickedEngine](https://github.com/turanszkij/WickedEngine/tree/2ff1d9e7b36091d6edf9f823af77e6bc9af20e3b)，`2ff1d9e7b36091d6edf9f823af77e6bc9af20e3b`；根 `LICENSE.txt` 为 MIT。
- **SSGI source**：[wiRenderer.cpp](https://github.com/turanszkij/WickedEngine/blob/2ff1d9e7b36091d6edf9f823af77e6bc9af20e3b/WickedEngine/wiRenderer.cpp) 的 `Postprocess_SSGI`、`shaders/ssgi_deinterleaveCS.hlsl`、`ssgiCS.hlsl`、`ssgi_upsampleCS.hlsl`。已核实 depth/color/normal atlas、deinterleave、compute GI 和 upsample 的调用链；本次未证明它含有与 R15 等价的独立时域链，因此作为 compute 组织对照，不混称 R15 的完整替代。
- **VT source**：[wiTerrain.cpp](https://github.com/turanszkij/WickedEngine/blob/2ff1d9e7b36091d6edf9f823af77e6bc9af20e3b/WickedEngine/wiTerrain.cpp) 的 `UpdateVirtualTexturesCPU`、`virtualTextureTileRequestsCS.hlsl`、`virtualTextureTileAllocateCS.hlsl`、`virtualTextureResidencyUpdateCS.hlsl`、`terrainVirtualTextureUpdateCS.hlsl`。已核实 GPU 反馈/请求/分配、异步 readback、CPU 页决策、atlas 页生成、驻留映射及消费；当前源码定义 `NOSPARSE`，可研究不依赖硬件 sparse 的 atlas 路线。
- **Local owner / Adoption**：shading、materials-textures/virtual-assets；**not adopted**。VT 是**地形专用**实现，不自动满足通用材质/资产 VT。
- **WebGPU 差异 / 风险**：SSGI deinterleave 的多 UAV 输出与 WebGPU 有界 storage texture 布局冲突，需重新分段/打包并计入带宽；VT shader 使用 native bindless descriptor index，须改为有界资源表。CPU readback 仅用于异步页调度，不能变成本帧 shading 的同步依赖；页命中、缺页、mip 祖先与 eviction 时序须保留。
- **验证映射**：SSGI 与 R15 只比较可对齐的 trace/重建阶段；VT 比较页请求、延迟上传、淘汰、缺页 fallback、跨 mip 过滤、地形外资产适用性和 4 GiB 预算。未运行上游工程。

### R17 · LibVT：通用 VT 页表/过滤的第二来源

- **Upstream / Revision**：[core-code/LibVT](https://github.com/core-code/LibVT/tree/464397d9e2c655f72ad59cd1166b14e29e1bad3a)，`464397d9e2c655f72ad59cd1166b14e29e1bad3a`。根 `LICENSE` 原文声明 LibVT 本体 MIT，`Dependencies/*` 各有独立许可；复制子集前按文件核对。
- **Source**：[LibVT_PageTable.cpp](https://github.com/core-code/LibVT/blob/464397d9e2c655f72ad59cd1166b14e29e1bad3a/LibVT/LibVT_PageTable.cpp)、`LibVT_Cache.cpp`、`LibVT_Readback.cpp`、`LibVT_PageLoadingThread.cpp`、[renderVT.frag](https://github.com/core-code/LibVT/blob/464397d9e2c655f72ad59cd1166b14e29e1bad3a/LibVT/renderVT.frag)、`readback.frag`、`LibVT-Scripts/generateVirtualTextureTiles.py`。README 说明页检测、异步 stream、fallback 页表、双/三线性与各向异性过滤；已读 README、根许可和采样 shader，尚未逐函数审计所有 C++/依赖。
- **Local owner / Adoption**：materials-textures；**not adopted**。比 R16 更适合作为通用 VT 语义和离线切页参考，但实现停留在旧 OpenGL/GLSL/PBO 架构；**不推荐整套替换**现代 WebGPU residency runtime。
- **WebGPU 差异 / 验证**：页表坐标、tile border、显式梯度/LOD 和跨 mip fallback 可移植；GL readback/PBO、纹理格式和 CPU cache 所有权必须重建。把 R16 的 GPU demand 与 LibVT 的通用采样契约组合是**新设计**，不是任何单一上游已实现的完整 port；需测高频 UV、三线性边界、缺页与热缓存抖动。

### R18 · Bevy meshlet：强对照，但不替换 WebGPU 主链

- **Upstream / Revision**：[bevyengine/bevy](https://github.com/bevyengine/bevy/tree/dd66a3959725df860bb7c7217a6769d3deb661ef)，`dd66a3959725df860bb7c7217a6769d3deb661ef`；仓库标记 Apache-2.0，具体复制仍核对文件 notice。
- **Source**：[meshlet/mod.rs](https://github.com/bevyengine/bevy/blob/dd66a3959725df860bb7c7217a6769d3deb661ef/crates/bevy_pbr/src/meshlet/mod.rs) 明确宣称高密几何 GPU-driven、预处理、meshlet culling 和单 draw；同目录 `cull_instances.wesl`、`cull_bvh.wesl`、`cull_clusters.wesl`、`visibility_buffer_hardware_raster.wesl`、`visibility_buffer_software_raster.wesl`、`visibility_buffer_resolve.wesl` 是后续源码入口。
- **Local owner / Adoption**：virtual-assets/visibility；**reference only, not adopted**。当前 `MeshletPlugin` 明确要求 `WgpuFeatures::TEXTURE_INT64_ATOMIC`，且仅支持 Vulkan/Metal；不能因使用 WESL/wgpu 就宣称浏览器 WebGPU 可移植。用它比较层次剔除和 visibility 组织，不能替换已工作的 Nyx/VG/VisibilityKey 链。未逐 shader 审计或运行样例。

### R19 · voidin：WGSL work/visibility 轻量对照

- **Upstream / Revision**：[pannapudi/voidin](https://github.com/pannapudi/voidin/tree/36e84bb4e6c1bf4619df076cd2acdbeba1e63306)，`36e84bb4e6c1bf4619df076cd2acdbeba1e63306`；根 `LICENSE` MIT。
- **Source**：[emit_draws.wgsl](https://github.com/pannapudi/voidin/blob/36e84bb4e6c1bf4619df076cd2acdbeba1e63306/shaders/emit_draws.wgsl)、`visibility.wgsl`、`shading.wgsl`、`utils/bvh.wgsl`。可对照 WGSL 生成 indirect draws、visibility 消费和软件 BVH 查询；尚未核实其所有 host-side feature/limit 与浏览器运行路径。
- **Local owner / Adoption**：visibility/shading；**reference only, not adopted**。`shading.wgsl` 使用 `binding_array<texture_2d<f32>>`；该资源模型不能直接当作 EEngine 标准浏览器 WebGPU 的自由 bindless。这个项目也不证明本地 Work Runtime、VT 或完整 GI 已有现成替代。

本轮对既有优先来源的替换判定：

| 原选型 | 新候选 | 判定与理由 |
| --- | --- | --- |
| “Screen GI 无 donor” | R15 + R16 | **改判**：R15 已有完整信号链候选；R16 的 compute 组织另作对照。具体 WebGPU profile 尚须实施前定案。 |
| “VT 无合格整套 donor” | R16 + R17 | **改判**：已有互补源码可设计完整通用 VT，但没有单一可直搬的 WebGPU 生产实现。先做页反馈/采样闭环原型。 |
| 现有 Nyx/VG + The Forge visibility | R18 + R19 | **不替换**：Bevy 要求非目标原子能力；voidin 的 texture binding 假设尚未证明目标浏览器可用。只吸收可核实的算法差异。 |
| FidelityFX SSSR、FSR3 Upscaler、XeGTAO | 本轮检索到的 Screen GI/VT/meshlet 仓库 | **不替换**：这些候选没有提供同功能、更完整且更接近 WebGPU 的整套算法证据；保持已固定来源。 |
| Adaptive Compute Shading 本地设计 | R20、FidelityFX VRS | **改判但不冒名替换**：R20 有完整 2×2 coarse/full/覆盖实现，然而其先读四份 GBuffer，缺本地前置决策、材质/光照频带及 4×4；VRS image 也不能当 WebGPU compute shading。 |

## 8. 不默认采用的来源与技术

| 来源 | 本轮核查结果 | 本项目处理 |
| --- | --- | --- |
| FidelityFX SDK 最新 v2.3.0，`60f4ea81909200d8542eca14dccb2628b763a9a3` | `Kits/FidelityFX/docs/license.md` 已读，存在默认 binary redistribution 条款与文件级例外；部分 FSR3 header 为 MIT | 不把整个最新 SDK 标成 MIT；本轮采用固定 v1.1.4 的已核查源子集 |
| [RTXGI-DDGI](https://github.com/NVIDIAGameWorks/RTXGI-DDGI/tree/f33e496ca31b3f0eec1c4e2cbaa8bb620e337fa6)，`f33e496ca31b3f0eec1c4e2cbaa8bb620e337fa6` | 根 `License.txt` 为 NVIDIA RTX SDK LICENSE；已读 `ProbeBlendingCS.hlsl`、`ProbeRelocationCS.hlsl`、`Irradiance.hlsl` | 保留算法对照/条件候选，不作为已批准的 MIT donor；默认先评估 Atlas，不能将 license 风险藏在 migration 里 |
| [NRD](https://github.com/NVIDIA-RTX/NRD/tree/7033ffbc48dbd74713194555abc13da8d7de4bcb)，`7033ffbc48dbd74713194555abc13da8d7de4bcb` | 根 LICENSE.txt 为 NVIDIA RTX SDK LICENSE；目录有 REBLUR/RELAX，不等于完成全文算法核查 | 信号语义参考，当前反射优先 MIT FidelityFX Denoiser；未来按实际文件/条款再选 |
| [Unity Graphics](https://github.com/Unity-Technologies/Graphics/tree/a7e4c051d256a781ab362c64316b125a1e104694)，`a7e4c051d256a781ab362c64316b125a1e104694` | 根 Unity Companion License 已读；有 HDRP fog/VBuffer 源 | 不作为本外部引擎的默认代码移植来源；局部介质选 Adria 候选 |
| Unreal Nanite / GPU-Driven Materials / VSM | 技术资料与受 Epic 条款约束的引擎来源，不是普通宽松许可 donor | 借鉴管线思想；不宣称找到可直接移植的开放 Nanite 实现 |
| Frostbite、Decima/Nubis | 有有价值的论文/演讲，未在本轮找到可直接采用的完整公开生产源码 | 用于空间、光传输和缓存设计比较；不虚构开源仓库，不阻塞云后置 |
| ReSTIR DI/GI、NRC、DLSS SR/RR、FSR4 类神经后端 | 其研究/SDK 输入和执行依赖不等于当前 WebGPU 能力 | 留信号/后端接口；当前不把硬件 RT、专有推理或零复制 WebNN 当成立条件 |
| [FidelityFX CACAO](https://github.com/GPUOpen-Effects/FidelityFX-CACAO/tree/0ddca95e6714727a252ead345591ca8f2598f261)，`0ddca95e6714727a252ead345591ca8f2598f261` | 根 `license.txt` MIT 已读；`ffx-cacao/src/ffx_cacao.hlsl` 与 `ffx_cacao_impl.cpp` 已核对 depth/normal、adaptive importance、deinterleaved blur 和 apply/upsample 阶段 | 是完整 AO 替代候选，不引入第二套生产后端，不把 CACAO 阶段拼入 XeGTAO 后宣称完整移植；改选时须重做完整 source→local mapping |

许可记录用于工程选源，不等于法律意见；关键是准确保留上游文本、版权/NOTICE 和派生来源，不把根仓库标签当作所有文件的授权证明。无需等待所有备选许可调查结束才开始已核实的宽松许可迁移。

## 9. 实施时必须补齐的最小映射

每个选定切片在本账本或其所属领域 ledger 中补一张表即可，不新增一套审批系统：

| 源阶段 / entry | 条件、输入输出、必要不变量 | 本地生产 owner / entry | 差异 / fallback / 未覆盖项 | 对照入口 |
| --- | --- | --- | --- | --- |
| 具体固定 revision 的函数或 shader | 写实际语义，不写“沿用某某思想” | 真实生产文件，不能仅指 demo | 平台转换、选定 profile、明确行为差异 | 现有或新增的聚焦 case/oracle |

**不得偷懒简化算法**意味着：迁移选中 profile 的完整算法链，保留关键接受/拒绝分支、数据依赖、历史更新与失效、缺页/越界/溢出行为；不能删掉难移植的阶段后改称“等价优化”。不要求搬走上游所有模式、编辑器、资产或整套引擎；排除范围必须在实施前写清，不能完成后才补理由。

语言、布局、bindings、dispatch 和缓存 owner 可以改变，只要语义保留且差异可对照。遇到 WebGPU 无法保持的核心语义，明确记录缺口并确认算法/profile 调整；未确认、未对照的部分保持未完成。源算法本身不适合目标时可以换一个完整算法，但必须具名改变采用决定，不能在同一个名称下悄悄换成简化近似。

本轮没有复制任何候选进入 production，也没有引入新的 runtime dependency。下一批按 [workstream](../../project/workstreams/active/eengine-next-clean-rebuild.yaml) 直接切断旧 composition，建立最小 GPU Scene → Visibility → Present 主链；之后在新 owner 上逐项完整移植。旧 A 批次合同不再是开工前门禁。

## 10. 文章/论文：用于判定语义与边界，不冒充移植源码

| 原始资料 | 对 EEngine 的具体用途 | 与开源实现的关系 |
| --- | --- | --- |
| [Mayer, *Virtual Texturing*（TU Wien, 2010）](https://www.cg.tuwien.ac.at/research/publications/2010/Mayer-2010-VT/) | 页表、缓存、mip/filter 与反馈链的语义对照；尤其核查 page border 和 miss fallback | R17 README 明确链接该论文；论文不替代 R16/R17 的源码许可与 WebGPU 原型 |
| [McGuire 与 Mara, *Efficient GPU Screen-Space Ray Tracing*（JCGT, 2014）](https://jcgt.org/published/0003/04/04/) | SSR/Screen GI 的层次深度遍历、步进/命中和屏幕缺失条件；区分 ray work 减量和每 ray 成本 | R06/R15/R16 的 trace 对照；不能据此宣称 SSSR 或 SSGI port 完成 |
| [Karis 等, *Nanite: A Deep Dive*（SIGGRAPH Advances, 2021）](https://advances.realtimerendering.com/s2021/Karis_Nanite_SIGGRAPH_Advances_2021_final.pdf) | VG 层次、可见性和流送的性能边界；审视 EEngine 自己的 hardware-first raster 选择 | 技术演讲，不是宽松许可源码；不替换现有 Nyx 来源映射 |
| [Hillaire, *A Scalable and Production Ready Sky and Atmosphere Rendering Technique*（EGSR, 2020）](https://sebh.github.io/publications/egsr2020.pdf) | 多重散射 LUT、太阳/天空能量与 aerial perspective 的物理接口 | 与 R10 Takram WebGPU 实现交叉核对，不能把论文中的全部配置等同于该仓库已有功能 |
| [GPUOpen, *FidelityFX SSSR* 技术页](https://gpuopen.com/fidelityfx-sssr/) | 对照分类、追踪、降噪的官方功能边界及适用条件 | R06 的固定源码 revision 仍是实际迁移基准 |
| [Bitterli 等, *Spatiotemporal Reservoir Resampling for Real-Time Ray Tracing with Dynamic Direct Lighting*（2020）](https://research.nvidia.com/publication/2020-07_spatiotemporal-reservoir-resampling-real-time-ray-tracing-dynamic-direct) | 判断未来 ReSTIR DI 需要的候选生成、重用、可见性与历史语义 | 研究路线储备；当前浏览器 WebGPU 无成熟硬件 RT 管线，不把论文列为 Phase 4 默认 donor |

本次检索后的取舍是：**Screen GI 优先评估 R15 的完整信号链，R16 仅补 compute 执行对照；VT 以 R16 的 GPU 需求链和 R17 的通用采样/资产链共同指导原型。** 两处都还没有可不改写地整套移入 WebGPU 的单一项目。R18/R19 说明“wgpu/WGSL”标签不等于目标设备能力已经成立。Adaptive Compute Shading 仍缺一个经源码核实的完整、WebGPU 可移植 donor；保持本地架构问题，不用 VRS 分类算法冒充解答。
R12 的固定源码、60 个文件 digest、十阶段映射、资源/常量 ABI 和 host 时序由 `node tools/fsr3-port/validate.mjs` 检查。对应 WGSL 阶段已进入唯一 Renderer FrameGraph；低频 Surface 先物化颜色与 motion，移动相机使用 full-rate Surface。这里记录的是 production integration，GPU 运行、视觉质量和正式 adoption 仍留给 Next Renderer 最终验收。
### R07 Supplement: WebGPU comparison and backend boundary (2026-09-27)

- `pasquelin/Render-Tech-Lab` revision `f7557b7d4af6846a5378525820211a213eb64a74` (MIT) was checked for GPU-driven, Hi-Z, compaction and virtualized integration. It does not contain a complete VSM page-demand/allocation/atlas/sampling producer, so it is a bounded WebGPU work reference only.
- `huming971336/VirtualShadowMaps` revision `9dbdbcce022c033405e1ebaf189e25a1e58c99fb` and `HTMA2024/VirtualShadowMap_VSM` revision `cb00535dbc1beddb1087954cce22978d70d5ffa7` were checked as Unity implementations. They are useful for indirection texture, tile pool, LRU, PCF/PCSS and async-loading terminology, but the current audit did not establish a production donor with a complete portable license and WebGPU backend; keep them reference-only.
- `MatejSakmary/VSM_masters_thesis` revision `863693ab6ef6338819d2b370c4a9a705add9ae1e` was checked for the thesis PDF and VSM analysis material. A redistributable software license was not established; treat it as research/reference material only.
- VSM paper references used for decision context: Giegl/Wimmer, [Fitted Virtual Shadow Maps](https://doi.org/10.1145/1268517.1268545); Giegl/Wimmer, [Queried Virtual Shadow Maps](https://doi.org/10.1145/1230100.1230112); Olsson et al., [More Efficient Virtual Shadow Maps for Many Lights](https://doi.org/10.1109/TVCG.2015.2418772). These are research references, not redistributable code donors.
- `turanszkij/WickedEngine` revision `4323a33c94d021d45404adaf863e9b01673ab365` (MIT) was checked for shadow, ray-shadow and denoiser stages. No Timberdoodle-equivalent page-management loop was found, so it cannot replace R07.
- `NVIDIAGameWorks/Falcor` revision `759aad033ff610fb0d82c74f7e0a508d0096d5f2` was checked for shadow-related passes and resource organization. Its license and component scope must not be assumed to be a single redistributable donor; retain it as architecture reference.
- The local WebGPU caster backend is fixed page batches plus GPU caster records. Timberdoodle amplification/mesh shaders, `DispatchMesh`, and Daxa pointer-style access are not direct WGSL ports. Software shadow raster is only a named capability profile, not the default path.
- E6 local mapping is now explicit: VSM allocation `VsmPageWork` -> `VsmCasterRecordPass` GPU expansion -> `VsmAtlasRasterPass` fixed indirect depth batches -> GPU dirty-page commit. Ordinary meshlet decode follows the published Geometry/Meshlet ABI; Product records follow `VIRTUAL_GEOMETRY_PRODUCT_WGSL`; alpha-mask discard consumes the published material visibility payload and cutoff. The bounded source is the frame MeshletWork queue, so off-camera geometry not present in that queue remains deferred until the later caster coverage expansion; overflow preserves dirty pages and never performs CPU readback.
- E7 local mapping is now explicit: VSM clipmap constants -> `vsm_sampling.ts` virtual UV/mip lookup -> generation/dirty validation -> atlas border texel loads with bounded PCF -> one directional visibility factor in Surface Standard/Coated direct lighting. Missing, stale or dirty pages fail open to neutral visibility; point/spot VSM remains out of this profile. `ShadowVisibilityFrame` carries the page-table/atlas/constants resource IDs so FrameGraph preserves allocation/raster -> Surface ordering. The historical packed CSM shader has been deleted from production source; no CSM/VSM comparison bridge remains.
- Detailed mapping is in [`docs/next-design/vsm.md`](../next-design/vsm.md) and [`docs/next-execution/vsm.md`](../next-execution/vsm.md). R07 remains `not adopted` until source mapping, WGSL/CPU oracles, and real GPU producer-to-consumer evidence all exist.
### R07 E8 local lifecycle integration

E8 adds no new complex upstream algorithm or runtime dependency. The local mapping is:

| Lifecycle fact | Local producer | GPU consumer / invariant |
| --- | --- | --- |
| device epoch | `RendererCore.recoverAfterDeviceLoss` and `VsmGeneration` | replacement `VsmResources`, passes and bindings are created for the new epoch |
| camera cut / scene / sun / caster publication | `VsmGeneration.begin` | non-zero generation and bounded full invalidation in `VsmInvalidationPass`; stale pages fail generation validation |
| page quantum / resize | `VsmGeneration.begin` and `buildVsmDirectionalFrameConstants` | new clipmap demand and footprint without CPU page iteration or forced atlas destruction |
| diagnostics | `VsmResources.diagnostics` | GPU buffer locations only; no `mapAsync` result controls current-frame work |

This is marked local integration. The E7 Timberdoodle mapping and its `not adopted` status remain unchanged until E9 or renderer-wide acceptance supplies the deferred CPU/WGSL/GPU evidence.

### R07 E9 module checks (2026-09-28)

The local page-table ABI now allocates 32 bytes per entry across disjoint mip planes. `VsmCasterRecordPass` uses the entry's mip for page overlap; `VsmAtlasRasterPass` clears GPU-selected dirty slots before raster and keeps dirty pages uncommitted on caster overflow. CPU oracles cover indexing, profile limits, allocation reuse/eviction/overflow and device epoch; Chrome WebGPU compiled the seven VSM modules, validated ordinary/Product/clear render pipelines, read back a dirty slot cleared to zero while its clean neighbor stayed at one, and observed sampling visibility 1/1/0/1 for missing/dirty/occluded-clean/stale pages. These checks do not establish complete off-camera caster coverage or a full production GPU producer-to-consumer capture. The Surface sampling fallback and overflow-mask diagnostic slots are reserved rather than measured. R07 remains **not adopted**; source mapping, WGSL/CPU checks and real production GPU evidence must all be present before promotion.
