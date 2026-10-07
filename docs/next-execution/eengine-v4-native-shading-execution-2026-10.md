---
id: eengine-v4-native-shading-execution-2026-10
state: current
verifies:
  files:
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - docs/next-design/eengine-v4-native-shading-2026-10.md
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/render/program/FrameProgram.ts
    - OEngine/src/render/program/FrameProgramBindings.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/src/gpu/GpuRenderWorld.ts
    - OEngine/src/gpu/GpuNativeMaterialScene.ts
    - OEngine/src/gpu/AppearanceProgramRegistry.ts
    - OEngine/src/gpu/GraphicsContext.ts
    - OEngine/src/material/AppearanceGraphCompiler.ts
    - OEngine/src/shaders/native_material.ts
    - OEngine/src/gpu/GpuNativeMaterialPublication.ts
    - OEngine/src/gpu/NativeMaterialBindings.ts
    - OEngine/src/gpu/NativeMaterialProducts.ts
    - OEngine/src/render/surface/SurfaceV4.ts
    - OEngine/src/render/surface/NativeExecutionBins.ts
    - OEngine/src/render/surface/NativeRasterWorkPartitions.ts
    - OEngine/src/render/surface/NativeVisibilityPass.ts
    - OEngine/src/render/surface/NativeSurfaceAux.ts
    - OEngine/src/render/temporal/NativeTemporalFactsPass.ts
    - OEngine/src/shaders/native_surface.ts
    - OEngine/src/shaders/native_material_products.ts
    - OEngine/src/render/MeshletBucketRaster.ts
    - OEngine/src/render/passes/PackedVisibilityPass.ts
    - OEngine/src/render/FrameGeometryArena.ts
    - OEngine/src/render/passes/LightClusterPass.ts
    - OEngine/src/render/vsm/VsmAtlasRasterPass.ts
    - OEngine/src/render/passes/fsr3/Fsr3UpscalerRuntime.ts
    - OEngine/src/framegraph/FrameGraph.ts
    - OEngine/src/framegraph/ShadeGPUCommandContext.ts
    - OEngine/tests
    - tools/docs-verify.mjs
    - tools/project-navigation.mjs
---

# EEngine V4 执行计划：完整构建、原子切换、立即删除

唯一架构依据为 [V4 母稿](../next-design/eengine-v4-native-shading-2026-10.md)，本文是唯一 **current renderer execution authority**。[workstream.currentSlice](../../project/workstreams/active/eengine-next-clean-rebuild.yaml)只导航当前大模块，详细阶段状态只在本文。旧 R3/R4 执行记录为 history，不继续 Surface C，也不把旧阶段映射成 V4 已完成。

2026-10-07 文档切换时重新 `git fetch origin`，HEAD 与 origin/master 均为 `0386bea5fc59a98cefd3f54d2be589ab9b2ed0eb`，审查开始时工作区干净。当时仅重构执行模型，没有新实现或 GPU 结果；这是切换时点快照。S0/S1 的非生产交付见 §3.1/§3.2，S2 实际生产切换见 §3.3.1。实施前须再次核对源码身份和工作区。

## 1. 实施模型与验证纪律

### 1.1 Agent 入口与停止边界

收到“继续当前 V4 workstream”后：

1. 读 workstream authority/currentSlice 与本文阶段表，找到第一个未完成阶段。其他资产专项 workstream 不构成第二套 renderer authority；不新增 status/progress/roadmap。
2. 重新 fetch、确认 HEAD/origin/master/工作区，用 `node tools/vibe.mjs context <path>` 导航；读本阶段 producer、产品、全部直接 consumers 及近目录约束。context 不是许可或验证门禁。
3. 固定存活语义、真实合法场景、容量/失败行为和 Cost Card。按 §1.5 判断复杂度：简单工程代码直接实现，复杂模块优先研究成熟开源 hot path，再决定本地方案；实际引用或移植时核读相关完整阶段、license、关键分支并记录本地映射。计划或参考存在不代表移植完成。
4. 连续完成本阶段责任，再 architecture review、集中验证、分类定位失败、根因修复及受影响回归。缺少必需项就保持未完成，不能由测试颜色决定架构。
5. 在本阶段实施记录写 source/build 身份、实际交付、验证结果/限制、未运行项和开放问题。关闭后停在下一阶段边界；仅大模块/入口变化同步 currentSlice。
6. **M1 完成即 STOP。** 根据此时真实代码重新设计 M2 Geometry/VG alignment，经用户选择才启动；不得自动跨到 VT、GI 或 ReSTIR。

**分阶段开发，不分阶段迁移 production。** S0 是小型实验，S1 在非生产环境构建完整 subsystem；两阶段中 RendererCore 和 FrameProgram 的生产 Surface 完整保持旧路径。S2 是唯一 production architecture switch，切换与删除属于同一个不可拆开的单元。阶段内部允许临时编译失败、无图或仅有隔离 harness；稳定边界必须是 100% 旧 Surface 或 100% SurfaceV4。

### 1.2 分阶段验证节奏

| 阶段 | 开发和集中验证 | 边界 |
|---|---|---|
| S0 | 只运行决定 native 物理可行性的 probe/oracle/calibration | 不建通用 benchmark framework，不触碰 production ownership |
| S1 | 连续构建；按需 typecheck、shader compile、targeted CPU/GPU oracle；完整 functional closure 后集中构建与集成验证 | work packages 不是生产迁移阶段，不每 helper 跑全性能矩阵 |
| S2 | 连续完成 ownership cutover 和 purge，之后集中 typecheck、build/新鲜 build:test、targeted semantics、真实 production GPU 链和 lifecycle | 不为中途绿色加 bridge；S3 不能代替 S2 必需正确性 |
| S3 | 旧 Surface 删除后做完整 Surface 场景/画质/生命周期/成本/CPU encode/GPU P50/P95 验收 | 实现级性能调优从这里开始，重要新机制仍需 Cost Card |
| 全 renderer 最终集成 | 后续 providers 闭合后的跨浏览器/设备/效果、长时质量、整帧预算、正式 evidence/claims | 本轮文档或局部结果不提前晋级整体验收 |

GPU 作业串行；不拼不同源码快照的通过结果。性能慢先解释必要工作、随机 gather、纹理 locality、register/spill、limits 和图边界；必要工作超预算时明确调整算法、lighting budget、quality 或 render scale，不隐藏 shortcut。普通 6–9ms、复杂 9–15ms、多灯 11–18ms 只是 planning targets，不是硬编码测试门禁。

<a id="validation-failure-contract"></a>

### 1.3 测试可信度与失败修复

保存原始失败输入/输出/source/build 身份，先区分 implementation bug、architecture bug、retired ABI test、fixture、lifecycle、numerical、environment/tooling。核对最小复现和独立预期，修根因并复跑原例及相关回归；无法解释就保持未通过，不把偶然复跑绿色追认为修复。

S0/S1 调用实际新生成 WGSL 和隔离链，S2/S3 调用唯一 production 入口。证明目标分支、非零有效 Lighting/VSM/IBL、真实 HDR/Aux 消费；mock、源码 regex、预填正确结果或归档 shader 不证明算法。结构搜索用于证明旧依赖清除，不能代替 GPU correctness。覆盖 tails/overflow/容量完整域；每 visible pixel 唯一 opaque HDR writer，background 单独完整写域。

退休时删/迁移 Tape opcode、six-signal、cache generation/nomination、旧 field/recipe 等表示测试。material numeric、C/X/Y/LOD、normal、coverage、HDR/preExposure、motion、publication atomicity、update/abort/retry、device loss、unique writer 与 fence 退休语义必须迁移新 owner。禁止 skip 必需断言、吞异常、放宽容差、漏像素、缩最终场景、测试专用 production fallback。预期改变要有数学/来源/新合同，实际质量或功能范围改变按用户授权处理。

最终源码变动后刷新受影响 build/checks；timeout、不完整 runner、不可用 timestamp、skip/未运行单列。实现覆盖、correctness、成本分别记录；新 owner 已知缺陷不得后移。

### 1.4 防止架构漂移

禁止测试失败就加兼容 path/fallback/adapter；性能慢就立即加 global cache/proof/reuse/history；dispatch 多就造 megakernel/VM；跨 pass consumer 出现就扩 Universal SurfaceRecord；新算法 history 交 Surface 统一管理；闭包未完成就持续 benchmark 并按数字改架构。

也禁止以保持 production 随时可运行为理由拆分 ownership 迁移、混合新旧 ABI，或留下“以后删旧 Surface”。Git history 保存旧实现，不保留 runtime selector、OldSurfaceAdapter、LegacySurfaceBridge、CompatSurface、SurfaceV4ToSignals、SignalsToSurfaceV4、FallbackVM、OldReconstructAdapter、LegacyPublicationWrapper。

<a id="source-reference-policy"></a>

### 1.5 复杂模块的开源参考与轻量 Source Map

**开源实现是优先参考项，不是强制依赖，也不要求所有代码移植。** 简单、局部、低风险的 glue code、数据转换、小 helper、简单资源绑定、已有 EEngine 的直接扩展及没有复杂 GPU 算法风险的普通工程代码直接实现，不额外寻找 donor。

复杂、高风险、性能敏感或易踩硬件执行坑的模块，先检查本地可复用基础，优先搜索成熟开源实现，再决定方案。适用范围包括 native material compiler、Visibility Shading、Program/Material Binning、GPU work generation、VG/VT/VSM/VRS、复杂 Lighting、SSR/SSGI/GI/ReSTIR、Temporal/Upscaling、Atmosphere/Volumetric 和复杂 streaming/residency；不能通过拆小任务回避整体研究。

有合适参考时，阅读真实源码 hot path 和相关完整阶段，核对数据流、GPU work、资源布局、关键分支、不变量、平台假设、性能边界与失败经验，再对照 EEngine/WebGPU 决定移植、改写或放弃。不照搬 C++ 框架、D3D12/Vulkan 封装或不适用的 bindless/ExecuteIndirect/wave 假设；平台适配不能无依据省略算法必要步骤。没有合适参考，或平台差异要求自主设计时，简述检索范围、缺口或平台理由及本地方案即可，不因缺 donor 阻塞开发。

复杂模块开工前可在**既有阶段实施记录或来源账本**留以下短记录，不建新文件、workstream、审批或重型文档流程；实际引用或移植的 Reference 才记录固定 revision、license、具体文件/函数及本地映射。

```text
Local:     EEngine 已有可复用基础
Reference: 实际研究的开源实现；无合适参考时简述原因
Adopt:     可吸收的算法核心、物理执行、工作组织或布局
Adapt:     针对 WebGPU/EEngine 的必要修改与平台边界
Original:  确需自主设计的部分及依据
```

开源只是设计参考，不自动证明本地性能、正确性或 adoption。最终 hot path 仍须本项目 Cost Card 和真实 GPU 验证；来源采用声明仍须来源核对、独立 oracle 与真实新 production 消费证据。简单问题直接解决，复杂问题优先借鉴成熟实现，确无合适参考或平台差异要求时自主设计。

## 2. 粗粒度后续模块（不是自动执行路线）

| 模块 | 目标 / 依赖 | producer→产品→consumer 与排序理由 |
|---|---|---|
| M1 Surface V4 | 完整 native subsystem→原子切换并删除→验收 | Visibility/publication/providers→HDR/Aux→既有 Temporal/effects；先消除核心执行税 |
| M2 Geometry / VG alignment | 依 M1 实际 winner/requirements | Scene/VG→resident/prepared geometry、MeshletWork→Visibility/Surface/VSM；gather 需求清楚后调整 LOD/SSE/HZB/streaming |
| M3 Virtual Resources / VT | 依 native sample 接口与真实 streaming | 资源 owner→page table/atlas/feedback→native sampler；不在 M1 假定 bindless/完整 VT |
| M4 Lighting / VSM | 依 native consumer、caster/geometry/资源边界 | cluster/VSM/IBL→providers→HDR；先保已有消费，再设计极端规模与质量 |
| M5 GI / Reflection / ReSTIR | 依 geometry、lighting、真实 demanded Aux | effect owner→indirect/reflection/reservoir/composition→HDR；输入/能量边界清楚后选择算法 |
| M6 Temporal / Upscaling / Presentation | 依真实 radiometry/motion/reactive/effect history | HDR/facts/exposure→Temporal/FSR/DRS/未来 AI→Post/Present；M1 已保证当前消费者 |
| M7 Transparency / Media / final integration | 依 opaque、lighting、Temporal | transparent/media→HDR/reactive/motion→presentation；完整交互后全 renderer 验收 |

只展开 M1；M2–M7 依届时源码再设计，排序可调整。不宣称现有 VG、VSM 或 FSR 尚未实现，不在本轮设计其内部算法。

## 3. M1 Surface V4 当前阶段

| 阶段 | 责任 | 状态 / 实施记录 |
|---|---|---|
| V4-S0 | Native Viability Gate | **closed / VIABLE（隔离物理模型）**；结果与限制见 §3.1 |
| V4-S1 | Complete SurfaceV4 Construction（non-production） | **closed / 非生产功能闭包已验证**；实际范围、成本及限制见 §3.2.1 |
| V4-S2 | Atomic Production Cutover + Immediate Destructive Purge | **closed / 唯一 native production 与旧链删除已闭合**；实际接线、GPU 正确性、资源账及既有测试失败见 §3.3.1，不代表完整验收 |
| V4-S3 | SurfaceV4 Acceptance | **closed / M1 Surface 验收完成，STOP**；生产正确性、场景/成本与已知限制见 §3.4.1；不是全 Renderer/AAA/60fps 或全 Node suite 通过声明 |

```text
S0 native viability（production 外实验）
  ↓ pass；不成立则先修正必要工作/物理模型
S1 完整 SurfaceV4 construction（非生产）
  ↓ 完整功能闭包、集中验证
S2 唯一原子 production cutover + 立即 destructive purge
  ↓ 旧依赖删除、唯一生产架构、集中验证
S3 完整 SurfaceV4 acceptance
  ↓
STOP；依据真实代码再设计 M2
```

原 S4.0→S4.1→S4.2 one-route production→S4.3 multi-route→S4.4 Aux→S4.5 retirement 顺序已被本四阶段模型替代，不再作为未来迁移路线。阶段状态只在上表及实施记录；S1 packages 不另设状态系统。

### 3.1 V4-S0 — Native Viability Gate

目的只回答 native useful work 的真实物理成本。小型隔离实验使用真实 Visibility/MeshletWork、instance/source/frame geometry、TextureResidency、cluster、VSM 与 IBL，执行 geometry reconstruction→native material→lighting→pre-exposed HDR；比较 fused 与明确 compact record split。不能借旧 heap、Tape、cache、six signals、history、Reconstruct，也不能加 binning/reuse/VRS 掩盖必要工作。

只校准解释该路径所需的 bandwidth、random gather、texture、ALU 和 dispatch/pass 固定成本，不建大型平台。简化输入必须显式标 SIMPLIFIED INPUT 并说明偏差；推断 spill/occupancy 标 INFERENCE，不用峰值或缩水 workload 充当 production 性能。

**退出条件：** 独立数值/有效 provider 和输入链成立，geometry/material/lighting/VSM/IBL 增量及 fused/split 有一致 Cost Card 和真实计时，差异可解释、管理税低、high coverage 必要工作在合理可优化量级。结论为 VIABLE、VIABLE WITH ARCHITECTURE ADJUSTMENT 或 NOT YET VIABLE；不能用 `<X ms` 强行通过。未成立先查必要工作，不进入 S1。S0 probe 是实验设施，不是第二 renderer；本次不展开其实现设计。

### 3.1.1 S0 实施记录（2026-10-07）

**结论：VIABLE，范围仅为下列明确的 native useful-work fixture。S0 关闭，S1 next，未实施 S1。** 该结果证明简单 native 执行的物理成本成立，不证明完整 production 性能、任意 graph backend、复杂场景或 AAA 全开预算。后续沿 fused baseline 构建；不把 compact split 作为默认跨 pass 产品，不创建第二 renderer。

重新 fetch 后 HEAD=origin/master=`0386bea5fc59a98cefd3f54d2be589ab9b2ed0eb`。实施开始时已有上轮 authority/执行模型的五份未提交文档改动，予以保留。结果对应本轮未提交源码；build:test source SHA256=`e5e1873a94e15aca81f2dd9bf8f559fbf532ffd16d02ae3b53e86b94dddcd0c1`、output SHA256=`e916927e7f85b234de6268b93b7dd838ab9f5083dfbc021c0dee983e33ae8abc`，完整 probe 入口 SHA256=`222af56fe48cfb75af9b309a5ac810187e05982984e4e0fe4a74675d47934e07`。实际 fused GML8VI WGSL SHA256=`226668cbda4779b43c0ec2f6d365fb8455fc747545e730874ebb0f307fcdb83d`，各 variant 的 source digest 都保存在报告。上述是测量身份，不是已提交 revision 或正式性能 evidence。

交付限于 [native shader generator](../../OEngine/tests/oracle/native-surface-shader.mjs)、[isolated runner/oracle](../../OEngine/tests/oracle/native-surface-gpu.mjs) 及现有 registry 的两个入口。共享 `surfaceGeometryCompletionWgsl` 只增加可关闭 diagnostic atomic 的参数；四种生产默认组合生成的 WGSL 与 HEAD **逐字节相同**。RendererCore、FrameProgram、publication owner、旧 Surface 生命周期均未改接；没有旧 VM、cache、signal/history/field heap、binning、queue、proof 或 Reconstruct 依赖。

### 3.1.2 Workload 与 SIMPLIFIED INPUT

- Windows 报告 GTX 1650 Ti 4GB、driver `32.0.15.8142`；Chrome `154.0.8037.98` headless，WebGPU adapter 为 nvidia/turing、非 fallback。使用 timestamp-query，本次协商 16 storage bindings（既有 Geometry producer 要求至少 15，native shading 使用 8 个）。不以显卡峰值推导时间。
- 1920×1080，2,073,600 screen pixels，32,400 个 8×8 workgroups / meshlet work slots，64,800 triangles。硬件 raster 写 r32uint Visibility + Depth，readback 实数为 **1,969,920 visible pixels（95%）** 和 **1,036,800（50%）**。24-bit slot + 8-bit primitive、外部 generation 保持原 ABI。
- 真实 FrameGeometryArena/FrameGeometryVertices producer；probe 读 actual MeshletWork、frame instance、arena directory、三顶点 clip/world position/normal/tangent/UV，再做原齐次 barycentric/gradient、textureSampleGrad、normal mapping。额外强制走 actual resident payload / instance matrices fallback，与 prepared 输出逐像素相同。Geometry preparation 与 raster 不在 Surface useful-work 计时内。
- Standard 的 baseColor/metallic/roughness/AO/normal/emissive/coat 与当前线性材质 profile 数学对应；5 个 texture queries，显式 gradient。Unlit 只有 base query。本轮是手写 native graph 对应数学，各 native specialization 通过真实 WGSL/pipeline 编译；不是 arbitrary graph compiler，完整 custom graph backend 留 S1。
- 4/8 **point lights 外加 1 directional**；消费真实 LightDatabase/cluster ABI 与 production Lambert/Smith-GGX/Schlick/coat helper。view depth 从 recovered position 推导；near=0.1/far=100 的 logarithmic slice 参数按当前 LightClusterPass.packSettings 生成，不使用常量 depth 或退化参数。VSM directional 查询消费 256 resident pages、真实 checkerboard depth atlas、2×2 PCF，存在可见与遮挡；point/spot shadow 按当前 helper。IBL diffuse/specular/DFG/coat 非零，消费 production octahedral helpers。Rec709→Rec2020、preExposure=1.25、rgba16float HDR。
- **SIMPLIFIED INPUT：** orthographic tessellated fixture、单实例 identity transform、一个 compatible material array；不是生产 Scene/VG culling/alpha producer。材质纹理为程序生成 512²×5、10 mips，没有通过 TextureResidency/routes/事务构建；cluster lists / VSM residency 为 ABI fixture，不测 producer，所有点灯覆盖所有 cluster；environment texels 为非零常量且高度 cache-local。它低估复杂纹理/实例/streaming entropy、透视/非均匀变换、资源路由与生命周期成本；32,400 slots、每像素 8+1 灯又高于一些简单场景必要量。不能外推为 production 场景。

### 3.1.3 Native useful-work 分解

每 coverage 先提交 24 次完整 workload 预热，各 variant 再丢弃 3 次、取 9 次；末尾另取 5 次 G/GM/GML8/GML8V/GML8VI 控制。P95 是 **9 次样本的最大值**，不是长时尾延迟。硬件 cache/locality 不等于 Surface cache/history。复用 GPUFrameTimingRing，同时记录 pass 与 command span；有 2 个 timing marker passes，不当 shading dispatch。

| Native variant | 95% P50 / 样本 P95 ms | 50% P50 / 样本 P95 ms | 95% 相邻增量 ms |
|---|---:|---:|---:|
| G | 0.997 / 1.001 | 0.803 / 0.811 | Geometry diagnostic baseline |
| GM | 1.102 / 1.534 | 0.939 / 0.945 | Material +0.105 |
| GML4 | 2.466 / 2.599 | 2.284 / 2.727 | 4 points + directional +1.364 |
| GML8 | 3.201 / 3.829 | 3.185 / 3.447 | 4→8 points +0.735；对 GM +2.099 |
| GML8V | 4.066 / 4.997 | 3.953 / 4.197 | VSM net +0.866 |
| GML8VI | 6.310 / 6.917 | 6.086 / 6.351 | IBL +2.243 |
| Unlit | 0.546 / 0.709 | 0.541 / 0.545 | 单 base query 的低成本参考 |
| Compact44 | 8.024 / 8.243 | 6.982 / 7.450 | 相对 fused +1.714 / +0.897 |

G/GM 用 output sink 保留 position/normal/tangent/UV/gradient，避免 GM 的 Geometry 被 DCE 减少后声称负 Material 成本。以上为**不同 compiled kernels 的诊断差分**，包含 live ranges/DCE/调度变化，不是可加的硬件 counter。末尾 95% G=0.740、GM=1.102，配对差为 0.362（表中首次差为 0.105）；GML8=3.245、V=4.143、VI=6.421。完整 workload 首尾较稳定；小 kernel 首尾仍漂移，所以 Material 差分只能报约 0.10–0.36ms，不能宣称更精确。clock/执行状态变化是 INFERENCE；无 clock/register counter，根因归因仍未知。VSM 增量是 net：被 shadow 拒绝的 directional 会跳过其 BRDF，不是纯 query 成本。

resident fallback 完整 native 在 95% 为 **6.485 / 7.053ms**、50% 为 **6.304 / 6.599ms**；整幅 HDR 最大差 0。两种 coverage 都是细列式 mask，每个 wave/workgroup 仍有活跃 lane，所以 50% pixels 不等于一半执行批数。DRS/完全空 tile 的缩放规律未测。

### 3.1.4 Fused / Compact 与 Cost Card

Compact 为 **44B**：32B response（half base/metal/rough/AO/emissive/coat，UNORM16 oct base+coat normal）+ 原 fp32 position 12B，array stride=44，不用旧 Surface products。fp16 oct normal 曾超预算；改 UNORM16 后，原 32B 路线从 Depth 重建的位置在 VSM 页边界产生不同查询，因此保留原位置。没有放宽断言或声称 32B 已正确；S1 若重选 compact 须重新证明精度/位置语义。

| 95% Cost Card | Fused GML8VI | Compact44 |
|---|---:|---:|
| screen / visible pixels | 2,073,600 / 1,969,920 | 同左 |
| 估计逻辑 read / visible pixel | 1,536B | 1,584B |
| write / screen pixel + visible 额外 | 8B + 0 | 8B + 44B |
| 必要 framebuffer / record 顺序流量 | 24.883MB/frame | 206.531MB/frame |
| 逻辑 random storage（未扣硬件 cache/DCE） | 2,340.265MB/frame | 同左 |
| 逻辑 texture tap budget | 677.652MB/frame | 同左 |
| 合计逻辑字节，**不是 DRAM counters** | 3,042.801MB/frame | 3,224.448MB/frame |
| samples / visible pixel | material 5 queries；VSM 4 taps；IBL 21 texel loads | 同左 |
| 粗估 scalar FLOP / visible pixel | 2,220 | 同左，另有未精确计入的 pack/unpack |
| special-op 估计 | 22 normalization、18 BRDF sqrt、9 coat pow、2 log2；非实测指令 | 同左，另有 oct pack/unpack |
| shading dispatch / pipeline activation | 1 / 1 | 2 / 2 |
| explicit atomic / barrier | 0 / 0 | 0 / 0 |
| Surface scratch / persistent history | 0 / 0 | 91,238,400B（87.012MiB）/ 0 |

MB 为十进制，MiB 为二进制。实例 stride 按逻辑上限估计，prepared 路径可 scalarize flags；同三角形、实例、灯光、page table 与 texture taps 高度重复，不能把全部逻辑字节除 DRAM 带宽当下限。Geometry unique-input footprint 粗估 12.442MB；没有 DRAM transaction counter。

probe peak 创建两条实验的全部资源：buffers=202,300,848B（含 compact、HDR/winner readback、64MiB calibration buffers），textures=59,757,900B，arena=25,661,696B，Geometry producer=128B，timers=1,536B；合计约 **274.39MiB**，不含 driver pipeline/query objects 和隐藏 alignment。去掉 compact、readback/calibration 后，fused fixture 粗计约 **100MiB**；不是完整 renderer VRAM，不含大型 scene residency/效果历史。没有持久 shading history。

Compact 多 **181.647MB/frame** 必要顺序往返；按实测 RW 169.49GB/s，streaming 税下限估计 **1.072ms**，额外 pass/dispatch 约 0.0036ms。实际慢 **1.714ms**；约 0.64ms 残余含 pack/unpack、失去融合/调度等，具体 counter 归因未知。break-even 要省掉超过实际约 1.71ms 的计算/occupancy 成本，本次未赚到，不采用默认 compact。不能证明绝无 spill；**INFERENCE：** 本 profile 未显示足以抵消存储税的 split occupancy 优势。

### 3.1.5 Calibration / Model vs Reality

| 小型校准 | P50 ms / effective throughput | 口径 |
|---|---|---|
| Sequential RW | 0.396 / 169.49GB/s | 32MiB read + 32MiB write |
| Sequential read | 0.303 / 138.38GB/s | 32MiB read + 8MiB sink，非纯 read |
| Sequential write | 0.193 / 173.46GB/s | 32MiB write |
| Random gather | 2.367 / 28.36GB/s | 32MiB LCG gather + 32MiB sink，非 Geometry 专用带宽 |
| Texture local / random | 0.545 / 22.264；61.58 / 1.51Gqueries/s | 每 lane 16 bilinear level-0 queries，含循环/坐标/sink；非 trilinear 或 IBL textureLoad |
| ALU 32 varying BRDF | 2.497；约 2,658 estimated GFLOP/s | 66,355,200 evaluations，约 100 scalar ops/eval 含动态输入递推、2 sqrt/divisions；非峰值 counter |
| Dispatch/pass | 0.00362ms | 可观测 sink update 的固定 GPU 开销；非 CPU pipeline switch 成本 |

各 calibration sink 在计时外有独立 CPU 检查。第一版固定角度 BRDF 被 compiler 常量折叠，约 18TF 的无效 throughput 已拒绝使用；改为 lane+previous-result 相关角度/roughness。初轮 G 数 ms / GM 更低还混入不匹配 DCE 与执行状态；保存原始数据、增加匹配 sink/完整预热/末尾控制，没有减 lights、关特性或调宽容差。

GML8VI 必要 streaming bandwidth 下限估计 **0.147ms**；按实测 dependent BRDF 和 2,220 estimated FLOP/pixel，compute-profile floor estimate **约 1.65ms**。两者不是总时间预测或可加 counter。误设 random logical bytes 全部 uncached 会得到 **约 82ms**，与 6.31ms 冲突——错误的是 cache/struct-load 假设。5 个 material queries 的 locality stress 范围约 **0.160–6.535ms**，也不能套给 21 IBL loads；不能用一个全局有效带宽代表混合 kernel。

乐观下界 max(streaming, BRDF profile)≈1.65ms；采用约 0.74–1.0ms Geometry、0.10–0.36ms Material、2.1ms 8+1 direct、0.87–0.90ms VSM、2.24–2.28ms IBL 的**测量后分解**，expected 约 6–7ms，样本悲观约 8–9ms（含本轮调度波动）。这不是独立预测或所有场景上界。必要工作的差分可解释，IBL 是主要增量；实际 cache miss/register/spill/latency 的 counter 归因未知，不用管理系统掩盖它。S1 保持 source/live-range/真实规模可审计，S3 才做完整生产调优。

### 3.1.6 验证、限制与下一边界

通过：两个新增模块 `node --check`；`npm run typecheck --prefix OEngine`；最终 `npm run build:test --prefix OEngine`；真实 GPU numeric（含 resident fallback）；完整 viability matrix（两 coverage、fused/compact、fallback、校准、末尾控制）。5 个独立 CPU HDR samples/variant 最大误差 <0.00079；整幅 fused/compact 8,294,400 channels/coverage 最大差 0.0029296875，预算保持 0.004 absolute + 0.4% relative；没有 skip、放宽容差或非有限值放行。harness GPU/API/page errors 为 0。文档校验 0 finding（62 个已有 history warnings），doctor 通过，documentation/context tests 9/9 通过，git diff --check 通过。

原始运行报告在忽略的 `.local/v4-s0/`：`initial.json`、`compile-fix.json`、`numeric-unorm.json`、`numeric-position.json`、`full-first.json`、`full-span.json`、`full-controlled.json`、`numeric-final.json`、`final.json`、`final-routed.json`、`numeric-routed.json`。它们是本机诊断，不新增 authority/正式 evidence。重跑入口为 `node tools/gpu-oracle.mjs native-surface-numeric --json` 与 `node tools/gpu-oracle.mjs native-surface-viability --json`，后者先依赖新鲜 build:test；GPU 作业串行。

未运行：生产 Surface GPU 回归、engine 打包 build、browser matrix/其它设备、真实 complex scene/TextureResidency/alpha、non-uniform scale/negative determinant/透视、完整 arbitrary graph/事务/abort-retry/device loss、DRS/FSR、长期 VRAM/P50/P95。共享 helper 的默认 WGSL 已与 HEAD 精确比对；后续生产等价闭包与合法 corner cases 仍是 S1/S2/S3 必需责任，不能因这里关闭 S0 而删减。

**下一阶段仅 V4-S1 完整非生产 Surface construction，以 fused native 为物理基线。** 完整 compiler/publication、多 Program/BindingSet/routes、Aux 与 lifecycle 闭合前，Renderer/FrameProgram 保持 100% 旧 production。此次停在 S0→S1 边界，不开始 S1，不修改旧 B2 defects。

### 3.2 V4-S1 — SurfaceV4 Complete Construction

在不进入 production Surface 的前提下完成整个 subsystem。S1 期间 RendererCore、FrameProgramLowering 仍完整使用旧 Surface，旧公开 publication 生产合同保持不变。新 native publication 在隔离环境拥有真实新产品及事务；共享基础设施不等于包装旧 Tape/cache/field 数据。允许源码共存，不允许第二 production renderer 或半接 production。

以下五个 packages 只表示开发依赖顺序，不是独立切换阶段、workstream 或 authority：

| Package | 必须闭合的责任 / 输出 |
|---|---|
| Compiler / Publication | Graph→typed IR/CSE/DCE/dependency/frequency/derivatives→native WGSL→async pipeline/registry→MaterialInstance publication；Standard PBR、Unlit、Clearcoat 和真正 custom graph；显式 C/X/Y/SampleGrad、texture/Product 语义；update、atomic publication、abort/retry、lease、device epoch |
| Native Surface Core | one Program、compatible BindingSet、多实例的内部 vertical slice；真实 winner reconstruction、position/normal/UV/tangent/gradient、cluster/VSM/IBL→HDR；background、alpha winner、preExposure；选择 S0 支持的 fused/有限 compact 物理执行方式 |
| Execution Bins | 完成 dense one-route bypass + CompactPixelBins multi-route（或 Cost Card/证据支持的替代）；多个 programs/material instances/BindingSets/routes，GPU count/offset/index/indirect、完整 capacity/tails/overflow/唯一 writer，CPU 命令随 bins 而非实例数增长 |
| Aux / Temporal Contract | 从真实 TemporalFacts/FSR/Debug/effect consumers 倒推有限 Base/Temporal/Reflection-GI profile、motion/reactive/validity 与必要响应；显式精度预算/需求；无 consumer 不声明、不分配，不为未来恢复 GBuffer |
| Lifecycle / Integration | 资源 ownership、preflight/prepare/commit/abort/retry/invalidate、resize/recovery/fence、物理计账及隔离集成 harness；新 producer→HDR/Aux→真实所需 direct consumer 接口完整闭合 |

one-route 只验证新 subsystem 内部第一个 vertical slice，**不接管生产**；multi-route/multi-binding-set 与最低 Temporal outputs 必须在同一 S1 中完成。禁止通过准入收缩把当前合法多 route 场景变成“不支持”再切换。

**允许共享基础设施：** GPU Scene、RenderWorld 合理的 instance/material/resource 产品、Visibility+Depth/GpuVisibilityKey、MeshletWork/FrameGeometryArena/source buffers、TextureResidency/静态材质资产、cluster/VSM/IBL/environment/BRDF、FrameGraph/CommandContext/timing/accounting、GraphCompiler 分析和 Registry 合理的 async/lease/preflight/device-loss 生命周期。提取纯数学/helper 时不能保留旧 runtime 产品依赖。

**禁止新 subsystem 依赖：** SurfaceWorkRuntime、SurfaceFrameResources 旧 banks、GpuSurfaceWorkAbi heap、GPU Tape/appearance_exact_dag interpreter、Closure Cache/nomination/publish、coherence、six RGB store、generic signal history/Reconstruct、old fields/work packets/proof/store/reference。禁止新 Material→旧 Signal Store、新 Surface→旧 Reconstruct、新 Geometry→Closure Cache、新 Aux→SurfaceWorkRuntime 或 Old Surface→partial V4。

**完整功能闭包：** isolated integration 使用真实 Visibility winner→ExecutionBin→Geometry→Native Material→cluster/VSM/IBL→HDR→最低 motion/reactive/Aux。覆盖多 program、多实例、多 BindingSets/texture routes、normal/ORM、coat、Unlit、custom graph、当前 winner 所需 alpha、主/阴影 alpha 一致、preExposure/background 与 Temporal/FSR 的真实输入。验证 non-uniform scale/朝向/导数等存活语义，不用预填 closure/lighting 或空 consumer 代替。资源协商与隔离生命周期独立清楚，不能要求 production 同时持有两套 Surface 工作集。

**退出条件：** 全部 packages 的实际 producer/product/consumer、资源和失败语义闭合，进行一次集中 typecheck/build、native 数值/采样、隔离 GPU integration/lifecycle 与结构/Cost Card 核对。S0 关键结论不能在集成中被未解释成本推翻；这不是每 helper benchmark，也不是完整 production 性能验收。列出 S2 完整 ownership/deletion 清单后才能关闭；只写完 compiler 或一个 PBR shader 不算完成。

<a id="v4-s1-construction-record"></a>

### 3.2.1 S1 实施记录（2026-10-07～08，非生产闭包关闭）

**S1 closed；以下为 S1 提交时的非生产快照，后续生产结果见 §3.3.1。** Graph→native publication→GPU raster winner/bins→Geometry/Material/Lighting→HDR/Aux→native Temporal→真实 FSR 已在隔离集成中闭合。该提交中 RendererCore、FrameProgram、GpuRenderWorld 没有接入新 Surface owners，生产仍完整使用旧 Surface；没有 adapter、双生产路径或 fallback VM。下列结果不是 S3 acceptance，也不是来源 production adoption。

起点及当前 HEAD 为 `355349c09219fd388c09aaafdc311d90ab6d102b`；重新 fetch 后 origin/master 为 `0386bea5fc59a98cefd3f54d2be589ab9b2ed0eb`。结果对应这一起点上的未提交源码。最终 fresh build:test 身份：source SHA256=`e51ed74dc68998fed8cd78b259ef15cf333fdc8af18baf89672a813d7e0b8ea9`，output SHA256=`6afd0b240634b93ee503adaa6de38f26a76a2eed94e9e52980bb6688773229a8`；七项最终 GPU 报告均使用同一身份。适配器报告 NVIDIA Turing、Chrome 154，没有确切 device 型号，不能认定已确认 GTX 1650 Ti。

#### 实际 producer / product / direct consumer

| Package | 实际交付（路径相对 OEngine/src） | 产品与直接消费 / 边界 |
|---|---|---|
| Compiler / Publication | `shaders/native_material.ts`、`appearance_operations.ts`；`gpu/GpuNativeMaterialPublication.ts`、`NativeMaterialBindings.ts`、`NativeMaterialProducts.ts` | 现有 scalar IR/CSE/DCE/dependency/frequency→straight-line WGSL、完整坐标祖先 C/X/Y、native samplers→Registry leases；immutable constants +16B/slot directory +8B/slot versions→shade/alpha/Temporal。Standard、coat、Unlit、非线性及 texture-driven UV custom；没有 GPU opcode 解释。ready/commit/abort/retry、全部 PSO 原子发布与 fence/device epoch 闭合 |
| Native Surface Core | `render/surface/SurfaceV4.ts`；`shaders/native_surface.ts`、`native_surface_lighting.ts` | 原 r32 winner/context、MeshletWork、真实 FrameGeometryArena/vertex source→局部 reconstruction/CXY/material/cluster/VSM/IBL/AO/physical sun→pre-exposed working-color HDR；background 完整写域。normal/ORM、base/coat validity、非均匀与负 determinant、prepared/resident fallback；中间值默认 private/register |
| Execution Bins / winner | `NativeExecutionBins.ts`、`NativeRasterWorkPartitions.ts`、`NativeVisibilityPass.ts` 及对应 shaders | dense 0/1 route 无管理资源/dispatch；multi-route count→sharded histogram→hierarchical small prefix→scatter→native indirect shade。regular/VSM 实际 queue ABI→GPU count/prefix/scatter→bucket drawIndirect→native alpha/winner；无本帧 work readback 调度 |
| Aux / Temporal | `NativeSurfaceAux.ts`、`render/temporal/NativeTemporalFactsPass.ts`、`shaders/native_surface_aux.ts` | Base 无 Aux；Temporal 仅 demanded reactive `rgba8unorm` 4B/P。native versions + authoritative sceneInstances/winner→motion `rg32float` 8B/P、mask `rgba8unorm` 4B/P、双 `rgba32uint` identity 32B/P→真实 FSR；identity/history 属于 Temporal，Reflection/GI 没有 consumer 时拒绝启用 |
| Lifecycle / Integration | 新 owners 的 prepare/ready/commit/abort/invalidate/retire/device-loss；`native-surface-integration-gpu.mjs` 等隔离 harness | async CPU 描述符快照、buffer identity 含 offset/size；encoded abort→retry、resize candidate 不覆盖 committed 状态、失败 fence 清理、device epochs/资源计账。共享 FSR owner 补 resize/abort checkpoint 和 fence 退休，motion binding 用 unfilterable-float；XeGTAO 暴露既有 scalar AO。GPU exposure 每帧 copy 4B 到设置，不用 CPU 曝光代替 |

`bindingSet` 表示完整物理材质资源兼容身份（包含 Product），不是 TextureResidency 的 owner-local set ID。S2 必须在实际 scene publication 中接入此合同。当前保留编译期频率信息，便宜值仍 native inline；**未实现 GPU uniform store/update-frequency 物化优化**，不能声称已得到其收益。参数更新建立新的 immutable candidate，stable frame 复用 committed publication；实例/纹理层不制造结构 ProgramKey。

#### 资源能力边界与有限执行调整

实际九个材质 texture banks，加上 Visibility/VSM/IBL/AO/physical sun 与 cooked Product，完整 fused profile 可达到17 sampled textures，超过 default16。没有删除合法材质或 provider 来通过编译：

- `NativeMaterialProducts` 将 cooked half 原 payload 四个 half/rgba16 texel 原样打包为一个 texture array，保留每字段原尺寸、全部 mips/domain/footprint LOD；软件 clamp/bilinear/trilinear，非重新烘焙、重采样或 opcode interpreter。256MiB raw /258MiB physical-upload 预算在分配前检查，mip 起点8B对齐；使用现有 CommandContext 上传/提交/中止/退休，没有 private submit。普通 profile 可继续使用原硬件 Product 采样。
- 完整 footprint 仍超 sampled limit 且含 physical sun 时，publication 包含两个必须一起 ready 的有限 PSO：primary 计算 Geometry/Material + cluster/VSM/IBL/AO→initialHDR/Aux；continuation 重算本 bin 的 Geometry/Material，仅加 shadowed physical sun，读 initialHDR、写 finalHDR。primary 后 copy initialHDR→finalHDR 保证背景/其他 routes 完整写域；continuation 不重写 Aux。同一 encoder/submit，没有通用 MaterialRecord/deferred selector。
- 首个 `rgba16float` read-write storage 尝试被真实 GPU 拒绝，原失败保留；最终是独立 sampled HDR 读 + write-only HDR 写，不假定 tier1 支持该格式 read-write。

这是资源 limit 所需的正确性方案，不是性能优化 claim。默认仍 fused；没有复活 signal store、cache/history 或 Universal SurfaceRecord。

#### Cost Card（逻辑账，不是 DRAM/register counters）

| 机制 | bytes / 工作 / 管理 | 理想、expected、worst / break-even |
|---|---|---|
| Native graph | Standard/coat 两 queries，Unlit 一，texture-driven custom 四（上游三点+下游一点）；逐 query transform 常量24B/实例，directory16B/slot、versions8B/slot、实例 constants 实际大小。组件两实例 publication：328/336/144/224B，算术88B；native evaluate 无全屏 scratch、atomic/barrier/内部 dispatch | 0/50/100% reuse 都执行同一 useful work，没有 reuse 机制。CXY 上游追加 queries 是数学语义所需；无旧生产内存删除量或 uniform extraction 收益 claim |
| CompactPixelBins | queue `4P+32B`，32 sharded histogram≈`128B` bytes及 prefix scratch；这里 B 是 bin 数。两次 winner/mapping gather、index 一写一读；tile-local aggregation，每 tile/distinct-bin 两次 global reservations。count 两个/scatter 三个 workgroup barriers，prefix 每 block17 barriers；B≤256 四管理 dispatch，hierarchical513-bin fixture六次 | dense 路径管理为0。uniform tile一次预留64 pixels；最坏64 distinct bins/tile 时最多64 comparisons/lane及逐 pixel reservation。不是 cache hit率；break-even 是被避免的重复扫描/divergence收益是否超过组织/locality税，尚未宣称相对等价 native 分派提速 |
| 1080p八 bins 下限 | queue=8,294,656B，scratch=1,076B（其他 bindings/settings另计）。只计两遍 winner 8P + index write/read 8V=32.348MB/frame，未计 mapping/atomics/scan；按 S0 RW169.49GB/s 约0.191ms floor | 实测 bins 四阶段 median 和约0.580ms；差额含 mapping、reservation/barriers、scan/dispatch和访问方式，具体 transaction counter unavailable。logical read不等于 uncached DRAM |
| Packed cooked Product | 原 half payload +每 mip<8B对齐+尾 page padding；默认 physical/upload 不超过258MiB。每 channel 至多8个显式 trilinear corner loads，多个通道可重复取同 packed texel；额外索引/插值 ALU，不增加全屏产品 | 绑定数由字段数降为1；20 fields 实测 payload2800B/physical4096B。不是更快保证；0/50/100%复用均不减 per-pixel 工作，binding-limit correctness 用途，不适用 hit break-even |
| Sun continuation | 只在该能力 profile 额外8P HDR；copy额外16P traffic；affected fraction f 再增16fV HDR read/write、f×Geometry/Material重算及太阳工作，追加每相关 bin native dispatch；无 MaterialRecord scratch、atomics/barriers | f=0/.5/1 时额外流量为16P/16P+8V/16P+16V；1080p95%约33.18/48.94/64.70MB，按规划90GB/s约0.37/0.54/0.72ms floor，另计重算/dispatch。profile存在但无affected pixels仍付copy税；未实测其1080p净成本，不当 speed optimization。112B fp32 record 会增约232MB全屏 scratch、约464MB往返及 storage bindings，因此选择有限重算/HDR版本 |
| HDR / demanded Aux / Temporal | 默认完整HDR写8P，reactive写4P；motion8P+mask4P为真实 FSR产品，Temporal双identity持久32P。默认无Material/six-signal scratch或Surface shading history | 不把所有产品都当每pass全读写。history明确在Temporal/FSR计账；motion f32保留0.1 render-pixel目标，不为4B预算强行降精度。Reflections/GI无consumer→0资源 |

S0 mixed BRDF profile floor≈1.65ms、普通 necessary-work分解 expected6–7ms仅是参考；S1多 Program/资源路由、custom/coat/Unlit混合的 native median7.29ms处于同量级，不能从这个总时间反推 Geometry/Material/Lighting各自精确增量，也不能把S0的2,220 FLOP全部像素套作S1新指令计数。register/spill/DRAM counters 未提供，fused压力只可作 **INFERENCE**；没有新增 cache/proof 来解释未知。

#### 集中正确性、生命周期与真实 GPU 验证

通过：`npm run typecheck --prefix OEngine`、fresh `npm run build:test --prefix OEngine`、最终完整 `npm run build --prefix OEngine`；native contracts +FSR lifetime +既有 graph/normal-filter oracles +XeGTAO scalar contract **76/76**（无 skip）。结构搜索确认新 owners 不 import 旧 Surface runtime/heap/GPU Tape/cache，RendererCore/FrameProgram/GpuRenderWorld 没有新 Surface wiring；共享 Geometry/BRDF/VSM helpers 只复用源解码/数学。

收尾文档验证：`node tools/docs-verify.mjs` 0 findings（62 historical warnings保留）；`node --test tools/tests/document-system.test.mjs` 7/7；`node tools/vibe.mjs doctor`、SurfaceV4 context/router与`git diff --check`通过。workstream继续只导航Surface V4，未复制阶段状态；未修改domains为V4已生产。

七项最终真实 GPU 报告均 passed、无 scoped/uncaptured GPU errors：

| 入口（`node tools/gpu-oracle.mjs <name> --json`，新鲜 build:test 后串行运行） | 实际结果与限制 |
|---|---|
| `native-material` | 五类 graph×32 invocations、两实例/两 texture sets；独立 authored VECTOR WGSL reference 不经过 scalar compiler/CSE/emitter。Standard/coat/Unlit/算术 max0，custom max1.78814e-7，预算1e-4+abs(ref)×1e-4未变；算术独立CPU max≈2.98e-7。缺 gradient 的 oracle-only 负控制被检测。真实 TextureResidency minMip tail6→promotion0、abort保tail；普通/static Product GPU采样max1.19209e-7；20不同尺寸packed fields独立CPU max4.65661e-10 |
| `native-execution-bins` | tails、空bins、513-bin hierarchical prefix、forced2D dispatch、malformed/stale winners、回放/容量/完整 membership/唯一 writer；dense bypass无管理资源/dispatch。不是完整程序规模性能矩阵 |
| `native-surface-integration` | 真正 native GPU coverage winner、8instances/4Programs/8bins/2BindingSets→cluster8 point+directional/VSM/IBL/normal-ORM/coat/custom/Unlit→HDR/native Temporal→真实 FSR；11frames含stable/reset、resident fallback、encoded abort→retry、参数gain .7→.4、负/非均匀scale、GPU exposure1.25→2.5、resize abort/commit。每帧独立PBR样本36–48，maxHDRerror0.000489198；原max(.001,abs(ref)×.002)预算未变 |
| `native-surface-perspective` | 非零透视winner/CXY、physical sun、GPU exposure/update，独立PBR样本18–72/frame，maxHDRerror0.000843182；motion真实变换检查；非所有近裁剪/极值场景验收 |
| `native-surface-resource-profile` | 实际绑定全部九个Residency bank views +packed cooked roughness被shade/HDR读取 +完整 Product Geometry resource layout +两个sun continuation routes；每帧独立PBR样本36–48，max0.000489198。实际材质queries取一个bank，不称九bank混合采样吞吐；winner仍resident，不称真实streamed VG decode acceptance |
| `native-surface-device-epoch` | 两个独立 GPU devices，受控device.destroy后全部新owner/FSR-owned bytes 1,648,189→0、旧epoch PSO拒绝、显式重建；不是自动driver-fault恢复验收 |
| `native-surface-cost` | 下面1080p成本实验；不是 production/S3 benchmark |

默认及resource-profile还使用真实 VSM caster/page/atlas ABI：独立alpha/depth16,384 comparisons、positive covered14,336、depth误差0；stale queue/page、overflow及replay negative diagnostics通过。fixture motion最大投影误差0，非零transform motion已检查；不能外推所有运动场景。Unlit原0.0004预算在1.25 exposure归一域保持，2.5 exposure时绝对HDR half误差随曝光加倍，不声称原绝对误差不变。全域finite、writer/背景/Unlit/FSR输出检查未缩减。

**保留的失败与根因分类：** WGSL reserved `diagnostic`（改名）；Temporal误把frame-instance stride当scene stride（分离authoritative sceneInstances）；background half rounding fixture预期错误；透视/PBR reference选到texture/VSM边界（按真实UV/page interior选择CPU样本）；后者的初版条件曾让小分辨率PBR样本为0（已修正并硬断言每帧`pbrSamples>0`，包含参数update）；normal Product validity误读名称（按compiler的`normalTSValidity/coatNormalTSValidity`并加contract）；不合法rgba16float read-write storage（上文物理方案调整）；stale build被harness拒绝（fresh build后重跑）。原报告保留在`.local/v4-s1/`，不追认为首轮通过。

**未完全解释的诊断：** CPU ideal filtering与hardware SampleGrad最大差0.1336045265仍保留，不改为passed；独立per-mip marker诊断的gradient LOD最大偏差0.08009、SampleLevel有效LOD最大偏差0.001866。GPU authored graph reference验证同硬件采样下的compiler/CXY等价，独立CPU HDR oracle选择真实UV内部恒定区，二者不能冒称所有texture/LOD边界CPU精确等价。S2/S3须继续保留独立reference及失败控制，不能删诊断以提高状态。

#### 1080p隔离成本及资源账

P=2,073,600，V=**1,969,920（95%）**，32,400 tiles；8instances、4Programs、8bins、2BindingSets，8 point+1 directional、非零VSM、IBL、normal/ORM、coat/custom/Unlit及完整Temporal/FSR。Geometry是tessellated quad，cluster lists、VSM residency与environment内容为明确provider fixtures，不包含scene生产/streaming成本。共12frames，discard前3，保留9计时样本；前2帧全域数值检查，随后只移除inspection/readback/CPU pixel scan，全部GPU实际渲染工作相同。

| GPU timestamp scope | P50 ms | P95 ms |
|---|---:|---:|
| raster begin / count / prefix / scatter（分别） | .00614 / .03891 / .02458 / .05485 | .01830 / .20285 / .04461 / .23168 |
| native indirect winner raster | 1.33661 | 4.35853 |
| bins count / scan / finalize / scatter（分别） | .25267 / .01024 / .01024 / .30691 | 1.47878 / .03075 / .02912 / 1.04419 |
| native opaque + background | **7.29283** | **31.12435** |
| native Temporal resolve | .63354 | 6.13171 |
| FSR exposure ratio / PrepareInputs | .00464 / .46694 | .01152 / 3.98794 |
| FSR LumaSPD / ShadingSPD / ShadingChange | .11158 / .29274 / .03510 | 1.42230 / 2.01082 / .23962 |
| FSR Reactivity / Instability / Accumulate / RCAS | .66864 / .26720 / 1.39616 / .17046 | 2.47120 / 1.65398 / 4.58371 / 1.06669 |
| command frame span | **13.75027** | **62.95754** |

bins四阶段median之和0.58006ms，加native约7.87ms只是**不同scope的median之和，不是联合Surface P50**；CPU encodeP50≈1.1ms、prepare≈.4ms。报告里的unclassified/temporal/post聚合scope与内部passes重叠，不能重复相加。九个frame-span原样为62.958/57.296/57.646/53.760/13.644/13.416/13.668/13.679/13.750ms，前四个样本多个stage同时慢很多；尾部原因**未知**，没有clock/register/spill counters，不靠继续选最优样本关闭性能问题。早期native约8.9ms/bins约.76ms/span约16.96ms记录也保留；本次可关闭非生产功能构建，不宣称稳定production P95/60Hz或性能改善。

| 实际physical资源类别 | bytes | 口径 |
|---|---:|---|
| SurfaceV4 owned | 24,885,172 | 默认单HDR、bins与设置；本1080p profile没有sun continuation第二HDR |
| demanded Aux | 8,294,400 | reactive |
| Temporal persistent | 66,355,232 | 双identity与小设置；motion/mask在FrameGraph pool |
| raster partitions | 148,096 | 独立GPU draw work组织 |
| FSR persistent | 78,797,009 | 自有history/常量，未加在Surface中 |
| FrameGraph texture / buffer pool | 104,504,472 / 8,294,404 | 时点allocated/cached物理池；不是只按active相加 |
| experiment readback | 265,420,800 | **实验单列，非生产budget** |

以上未包含全部scene/geometry/material-texture/provider/driver资源，不把合计说成renderer总VRAM；S3必须做全机物理去重、峰值/retired/resize账。S1已计各owner live/retiring资源，销毁后归零；没有generic Surface shading history。

**未运行/下一责任：** Renderer production cutover/旧链purge、真实scene streamed Product/VG、driver-fault自动恢复、跨browser/全Renderer画质与同条件长序列P50/P95/VRAM峰值、正式evidence/claims均未运行，分别属S2/S3及最终集成。B2-NUM-001/002仍unfixed/unresolved；native update/atomic publication/abort-retry/HDR语义已迁入上述隔离测试，但旧producer未删除。S2切换前重新核查下表所有production direct consumers；不因S1关闭而跳过真实Scene/Coverage/VSM/Temporal/FSR接线验证。

### 3.3 V4-S2 — Atomic Production Cutover + Destructive Purge

这是 M1 唯一一次 production architecture switch，也是不可分拆的 cutover/retirement 单元。S1 完整闭包证明后，连续把 `FrameProgram→SurfaceWorkRuntime→fields/signals→Reconstruct→HDR` 改为 `FrameProgram→SurfaceV4→HDR+demanded Aux`，随即删除全部失去 consumer 的旧代码。中间允许编译失败/不可运行；不通过临时 adapter、selector 或双 owner 保绿。

| S2 切换前审查边界（路径相对 OEngine/src） | 同一单元必须切换的责任 |
|---|---|
| `render/pipeline/RendererCore.ts` | `_surfaceWork` construction、canPrepareFrame/prepareFrame、invalidate、commit/abort、destroy/recovery、诊断/config/counter；新 owner 对接单帧提交/重试/退休 |
| `render/program/FrameProgram.ts/FrameProgramBindings.ts/FrameProgramLowering.ts` | products/需求/key/preflight、Lowering 中 FrameProgramOwners.surfaceWork、addPublicationToGraph/addToGraph、绑定/资源导入；radiance/reactive 与 Sky/Aerial/Temporal/FSR 全部直接输出 |
| `gpu/GpuRenderWorld.ts/GpuAppearancePublication.ts/AppearanceProgramRegistry.ts/GraphicsContext.ts` | native instance/program/material/route publication、Scene stage/prepareAppearance/commit/update/release、async ready/lease/preflight/device recovery、静态资产与资源账；不能无条件整类 KEEP/DELETE |
| `render/CoverageRasterBindings.ts/MeshletBucketRaster.ts/RasterWorkPartitions.ts`；`render/vsm/VsmAtlasRasterPass.ts` | compiled alpha programs、constants/routes/runtimeInputs/coverageDirectory、texture/Product views、finite raster partitions 及主 Visibility/VSM alpha 直接消费；材质更新与阴影 coverage 一致 |
| `render/temporal/TemporalFactsPass.ts`、`shaders/temporal_facts.ts`；FSR/Debug consumers | 替换 surfaceMetadataOffsets/materialLookup/valueVersions 读取；保 motion/change/identity/validity/曝光；FSR color/depth/motion/reactive/validity/current/prior exposure 实际接齐 |
| native lighting consumer 与现有 providers | 保 cluster/overflow、VSM table/atlas/constants/content version、IBL/AO/颜色域；只替换旧 packets/history 中间读取，不在本单元重写 provider 算法 |

S1现已构建的目标 owners 为 `GpuNativeMaterialPublication/NativeMaterialBindings/NativeMaterialProducts`、`SurfaceV4/NativeExecutionBins`、`NativeRasterWorkPartitions/NativeVisibilityPass`、`NativeSurfaceAux/NativeTemporalFactsPass`。S2用它们替换上表真实职责，不创建包裹旧publication/Surface的wrapper。重点补齐：

- RenderWorld的实际Scene stage/update/release与全局material slot→native directory/versions、完整物理BindingSet（含Product）原子发布；TextureResidency minMip/revision与主/VSM alpha一致推进；packed Product与所有PSO/pending/retired资源进入同一物理账及fence。
- Renderer/FrameProgram的真实Geometry queues、prepared/resident/Product source views、cluster/VSM/IBL/AO/physical environment/preExposure绑定及最低Aux需求；单一Surface拥有HDR，provider continuation只在能力profile内形成明确HDR版本，不恢复six signals。
- regular及VSM draw partitions、caster/page generation/容量/invalid diagnostics换成native alpha直接消费者；旧CoverageRasterBindings的Tape依赖不能留作兼容输入。
- Temporal读取权威sceneInstances与native material versions；motion `rg32float`通过既有FSR unfilterable binding、reactive/mask/曝光连接全部FSR/debug consumers；history/reset/abort/resize/fence归具体owner。S1受控设备销毁不替代这里实际Renderer recovery接线。

上述是 S1 关闭时的待实施 ownership 映射；实际 S2 交付与验证见下方实施记录。新 owner 的隔离 oracle 不是 production fallback。

切换后**在同一 S2 内立即 dependency review → destructive purge → compile → 集中验证**，不允许 TODO later removal。

| 删除候选 | 判断 / 保留边界 |
|---|---|
| SurfaceWorkRuntime、SurfaceFrameResources 旧职责、GpuSurfaceWorkAbi | 删除中央调度/旧 allocation、banks/field/signal heap、work/control 及 old history；必要物理计账/fence/math 分离至真实新 owner |
| appearance_exact_dag GPU runtime、Typed Tape GPU backend、Closure Cache ABI/runtime | 删除解释执行、nomination/unique writer/publish/cache/reuse 协议；ExactAppearanceDag 只保新 backend 实际需要的 CPU 分析/数学，不凭文件名整删 |
| surface_work coverage/coherence/appearance/lighting/reconstruct 等旧 wrappers | 删除旧 work packet/heap/rate/six-signal/history/reconstruct；保 Visibility coverage、VSM/IBL/BRDF/Geometry 的独立有效职责或纯 helper，不能删除真实 donor 算法 |
| 旧 diagnostics/settings、timing categories、exports/tests、contracts/specs | 清除旧 cache/reuse flags、field/signal 账和运行接口；存活语义迁移新测试/owner，历史记录保留 history，不让已退休 ABI 继续约束 current |

**不可达退出条件：** 搜索 imports/exports、owner construction、FrameGraph nodes、resource/pipeline allocation、settings/diagnostics、tests/contracts。旧 runtime 不再 constructed/prepared/encoded/allocated/committed/invalidated/retired，并删除无 consumer 实体；不只去掉 addToGraph 调用或留死文件。实际依赖可能增减，最后以 fresh source audit 为准。

**集中验证：** 最新源码 typecheck/build/build:test、targeted material/coverage/HDR/Temporal semantics、真实唯一 production GPU 链、update/stable/abort→retry/resize/recovery/fence；结构清除、完整合法多 route 域和资源账一并核对。真实 cutover 后才更新 domains 已实现事实及稳定合同。必需失败不交 S3 掩盖；S2 关闭时已经只有 SurfaceV4 production。

<a id="v4-s2-cutover-record"></a>

### 3.3.1 S2 实施记录（2026-10-08，原子切换与删除关闭）

**S2关闭时：下一阶段仅 V4-S3，当时未启动；后续S3结果见 §3.4.1。** 唯一 opaque production 现为 `FrameProgram→SurfaceV4→HDR+demanded Aux`；Renderer 不构建、准备、编码、提交或退休旧 Surface。cutover 与 destructive purge 属于同一提交单元，没有 selector、adapter、旧 ABI 桥或 fallback VM。此结论是 ownership/正确性闭包，不是性能改善、完整画质或 M1 完成声明。

起点为已提交 S1 `43e6d2f9435da9472d4f880d08ca176dae9bed45`，本轮 fetch 后 `origin/master=0386bea5fc59a98cefd3f54d2be589ab9b2ed0eb`。下列结果对应此起点上的 S2 工作树；最终 fresh build:test 身份为 source SHA256=`b24880cb7a3f405122e18a2bd1dbc3ae799a2effa726706cf0109ca01db139d3`、output SHA256=`62484c597ba0e34142a2dcd356dfaf8dc81d23adae6e4bc5c3ff714e2f74fddf`。真实生产 resident/Product 报告均匹配这两个 hash；没有拼接不同 engine source 的通过结果。Chrome 154、NVIDIA Turing，设备型号不可得，不能宣称已测 GTX 1650 Ti。

#### 实际 ownership / producer / direct consumer 切换

| 实际 owner（路径相对 OEngine/src） | 已闭合产品、直接消费与生命周期 |
|---|---|
| `render/pipeline/RendererCore.ts` | 唯一 `_surface: SurfaceV4`；readiness/prepare、单 frame submit、commit/abort/retry、invalidate/resize、destroy/recovery/fence、diagnostics 与资源计账切换；不构造旧 runtime |
| `render/program/FrameProgram.ts/FrameProgramBindings.ts/FrameProgramLowering.ts` | owners/products/Graph imports 直接接 native；实际 Packed Visibility+Depth、FrameGeometryArena/source 与 Geometry Product banks、cluster/VSM/IBL/AO/physical sun/preExposure→HDR→Sky/Aerial/FSR/Post/Present。需要 sun continuation 的 profile 使用独立 HDR 读/写版本，未恢复通用 deferred/signal store |
| `gpu/GpuRenderWorld.ts/GpuNativeMaterialScene.ts/GpuNativeMaterialPublication.ts` | Scene stage/update/release→immutable native programs、全局 material directory、实例参数与 dynamic inputs、完整物理 BindingSets（含 Product）→Surface/alpha/Temporal；所有 required PSO ready 后才允许整 tick。成功事务推进 active，abort 保 candidate 重试，替换按 lastCompletion 退休；结构 identity 包含 Unlit，不以资源 hash 判等 |
| `render/MeshletBucketRaster.ts`、`render/surface/NativeVisibilityPass.ts/NativeRasterWorkPartitions.ts`、`render/vsm/VsmAtlasRasterPass.ts` | 同一 native alpha/constants/texture routes→regular 与 VSM partitions、Visibility winner 和 shadow caster；保 alpha-tested winner 语义。Visibility 仍 r32uint（24-bit workSlot+8-bit primitive、外部 generation/partition），删除无 consumer 的 ShadingBinId MRT |
| `render/temporal/NativeTemporalFactsPass.ts`、FSR/Debug direct consumers | 从权威 sceneInstances 与 native material versions 读取 motion/change/identity；reactive `rgba8unorm`、motion `rg32float`、Temporal mask/identity/history 与 exposure→真实 FSR。history 属于 Temporal/FSR，Surface 不拥有统一历史；旧 diagnostics UI/capture 改接实际 FrameProfiler native timings/counters |
| ResourceAccounting / GraphicsContext / 各 native owner | publication 已由 RenderWorld 计账，native raw scratch 只计一次；bins/partitions 随 extent/Visibility retirement 同步标记 fence，native Product/中性 AO/VSM lazy resources 均归实际 owner。device recovery 后新 epoch 重新构建，不借用旧 PSO |

保留 GraphCompiler 的合法图语义、scalar IR/CSE/DCE/dependencies/CPU oracle、TextureResidency、AppearanceProgramRegistry 的 async leases、Geometry/Visibility、BRDF/providers、FrameGraph/CommandContext。Compiled graph 的 WeakMap 降低 CPU lowering 重复，不是 GPU closure cache。snapshot 的每帧 callback/source 比较与真实 CPU encode 成本仍需 S3 测量，没有宣称完成 CPU hot-path 调优。

#### 已删除与语义迁移

实际删除 SurfaceWorkRuntime、SurfaceFrameResources/Types、旧 LightingBindings/Radiometry/Diagnostics、GpuSurfaceWorkAbi 和 field/signal/proof/reference/domain/profile ABIs、GpuAppearancePublication、CoverageRasterBindings/RasterWorkPartitions、旧 TemporalFactsPass、GPU Tape/appearance_program/appearance_exact_dag、Closure Cache/key/nomination/publish、全 surface_work wrappers/coherence/rate/Reconstruct、six-signal/history、无 consumer 的旧 tonemap/counter/capability/export/config。ExactAppearanceDag、ClosurePlan/ExecutionProfile/FixedSurfaceFormulas 无存活 consumer，整实体删除；Registry、CPU graph compiler 和 asset/cook infrastructure 保留。Geometry continuity 的存活编码迁至 `assets/GeometryContinuityAbi.ts`，不保旧 SurfacePrimitiveAbi 名称。

依赖 review 覆盖 source imports/exports、owner construction、Graph nodes、GPU allocations/pipelines、settings/counters/diagnostics、examples、tests 与 validation executable scripts。旧 runtime 专用测试及 proof/store/signal labs、旧容量/带宽/曝光脚本、旧 Tape/publication 三个 Appearance scripts、旧 shader-rewrite/prewarm 设施删除；纯资产/normal 数学诊断保留。Showcase BenchmarkCapture/UI 改接真实 native timing/counters，无旧诊断壳。counter 旧槽保留 holes，未挪动有效指标索引。历史设计、原数值与旧结果只供追溯，不冒称当前可执行。

| 退休表示 / 存活语义 | 新验证责任 |
|---|---|
| Tape opcodes/layout、六 signal store、Closure Cache generation/nomination、旧 field/work heap | 表示测试随 owner 删除，不复活协议保绿 |
| graph/material numeric、C/X/Y/SampleGrad/normal/Product | `native-material`、perspective/resource-profile/integration 与既有 CPU graph/asset oracle；独立 authored reference 保留 |
| alpha/coverage 与 VSM caster | native visibility/raster partition GPU 测试、isolated strict VSM alpha/depth 检查和真实 Renderer VSM page/caster 非零断言 |
| HDR/preExposure、unique writer/background、motion/FSR | native Surface/Temporal integration、真实 resident 与 Scene→WASM Product production oracle；真实 motion 与 alpha 拒绝/恢复 |
| 参数/custom dynamic update、stable、atomic publication、abort→retry、resize/device loss/fence | native publication targeted tests及真实 Renderer production 双输入 oracle；受控 device.destroy 后调用实际 recovery，不宣称自动 driver-fault 接受 |

B2-NUM-001/002 保持 **legacy-retiring-path-known-defect，unfixed/unresolved**；其旧 producer 在本单元删除，错误随 owner 退休，不称修复。update/stable/publication atomicity/abort→retry/HDR 存活语义按上表由 native owners 验证。

#### 原始失败、根因与修复边界

- **基础资源 / lifecycle bug：** VsmResources 同 buffer 重复 getMappedRange 形成重叠，改一次 mapping；VSM caster/demand producer 返回写前 Graph resource 版本造成依赖 cycle，改返回写后版本；MeshletWork 主/Product queue 的既有 generation copy 与 VSM 诊断 readback 需要 COPY_SRC，补真实 usage。未改变 VSM/Geometry 算法。
- **实现 bug：** bin count 初始化引入 TextureBindingSetPolicy 循环依赖，改从本地 bit ABI 计算；native publication 双分支清理 async task，避免 `.finally` 派生 rejection 无消费者；Unlit 结构编辑进入 publication identity。
- **fixture / tooling：** 原 production VSM 报告 pages=7/casters=0，输入未声明 CastsShadow。显式 authored shadow flags 后原生产 caster=18，未修改 renderer 伪造 caster。旧 mock 缺真实 release/destroy、旧 owner guard tied-to-ABI 迁移；Showcase Node 直读 TS 的 `.js` import 解析失败由忽略目录内临时 source resolver 处理，未加 production fallback。原失败全部保留。

#### 集中验证及实际生产 GPU 结果

| 验证 | 实际结果 / 口径 |
|---|---|
| engine `npm run build`、fresh `npm run build:test` | 通过；build 包含 TypeScript、Vite 和 declarations，test build 的身份见上文 |
| 受影响 ownership/packed-render-world/shared-geometry tests | 定向复跑 45/45；完整 matrix 包含 native targeted 语义 |
| engine 全 Node matrix | **534 项：506 passed、28 failed、0 skipped/cancelled**，全套未通过；见下方 baseline 分类，未忽略或改容差 |
| 串行 GPU 组件回归 | `native-material`、`native-execution-bins`、`native-surface-integration`、`native-surface-resource-profile`、`native-surface-perspective`、`native-surface-numeric`、`framegraph-lifecycle` 通过。前五验证真实 native 编译/资源/数值，numeric 是 S0 数学回归；没有重跑 viability/calibration 或 S3 timing matrix |
| `native-surface-production` | 真 cooked resident Packed Scene→实际 Renderer device/FrameProgram→native HDR/Temporal/FSR；5材质、4Programs/4bins/2BindingSets、16×16 全5mip authored alpha/normal/ORM、coat/custom dynamic/Unlit、8点灯+sun。update、encoded abort 不推进 active、retry/stable、alpha cutoff .5拒绝/.2恢复、resize、camera motion、受控 loss→真实 recovery epoch2，全域 finite/独立 Unlit HDR 检查通过 |
| `native-surface-product-production` | 普通 Scene→真实 WASM cook→Geometry Product admission→同一 production Renderer，执行同样语义和 recovery 检查；不是预填 Geometry/closure 或第二 renderer |
| 独立 HDR / VSM | 两 production 输入的 Unlit Rec709→Rec2020 HDR 最大误差 `0.00033362477511755806`，原 .002 预算不变；PBR 精确数值由独立 integration/perspective oracle承担，production 输入不冒称逐像素 PBR reference。VSM allocated/content-valid pages=7/7、casters=18、overflow=0 |
| 真实 visible pixels | resident 初始9,888、alpha拒绝8,188、resize12,843、camera motion12,904、recovery13,021；这是小型正确性场景，不是1080p high coverage workload |
| 资源账 | recovery 后登记 native raw scratch：resident **807,340B**、Product **808,124B**；owner 登记、scratch 不重计、fenced teardown 清零断言通过。此数不含 Graph HDR/Temporal/TextureResidency/VSM，也不等于 driver VRAM residency，不外推1080p |
| examples / 文档工具 | Showcase benchmark 6/6、performance metrics 6/6、surface-performance targeted TS 检查通过；tools tests 11/11、documentation subset 7/7、validation工具测试12/12、docs verify 0 findings（66 historical warnings）、doctor/context、diff whitespace 检查通过。旧 V3 未采样 profile 明确退为 historical，review 后同步生成 registry；生成文件不构成架构或采用依据 |

**28 个既有失败未修复：** 在隔离 S1 HEAD worktree 复跑完全对应测试名，第一组48项/23 passed/25 failed，cook 组13项/10 passed/3 failed。涉及 Geometry Product admission/locations/multi-runtime/residency layouts 与旧 fixtures、streaming mock 缺 uploadCost、zero-coat canonical 期待、Runtime Package metadata；另有 OEGPACK golden identity/activation 与 Original Nyx MeshletBuilder differential group-count。它们在切换前已失败，未作为 S2 新回归处理，也未通过删除、skip 或放宽期望转绿。非本 Surface ownership 切换的已存在 Geometry/cook/fixture 缺口保留给对应 owner，**不等于全套绿，也不等于 M2 验收**；本单元必需 native/实际生产语义已独立通过。

原始日志与每次失败/修复后报告在忽略的 `.local/v4-s2/`，包括 `tests-final-second.txt`、baseline两组报告、`production-accounting-first/second.json`、`product-production-first.json`、七项组件 GPU 报告与 build/tooling 日志；是本机诊断，不新增 authority/evidence/claims。重跑真实生产入口：`node tools/gpu-oracle.mjs native-surface-production --json` / `native-surface-product-production --json`，依赖 fresh build:test，GPU 作业串行。最终报告 pageErrors/failedRequests 为0，Renderer GPU error收集为空；console仍有403资源诊断与VSM unreachable warning，不能称整个浏览器console无诊断。

**未运行 / 限制：** S3 high coverage普通/复杂/多灯全场景、CPU encode/GPU P50/P95、峰值/长期 VRAM、完整图像质量、跨浏览器/其他GPU、真实大规模 streamed VG、自动driver-fault恢复、正式 evidence/claims 未运行。S1 CPU ideal filtering 与 hardware SampleGrad 最大偏差的诊断仍未完全解释，不升级为通过。Nyx vbuffer 的三个映射标为 `pending-native-adoption`：来源 hash/token 核对继续强制，本轮生产接线不是完整 Nyx 独立逐函数采用证明。未来性能判断继续以 Cost Card 和 S3 测量为据，不从删行数或小场景正确性推导提速。

**停止边界：** S2 原子切换+立即删除+必需正确性验证闭合；S3=next/未开始。workstream 仍只导航 Surface V4，不启动 S3、不改下一大模块为 active。

### 3.4 V4-S3 — SurfaceV4 Acceptance

只在 S2 已切换、删除并集中验证后启动；此时结果才代表真实 production SurfaceV4。集中覆盖：普通/复杂 PBR、normal/ORM、coat、Unlit/custom、多 program/multi-route/multi-BindingSet；high/低 coverage、near/far、camera motion、alpha；4/8/many lights、有效 VSM/IBL；Temporal/FSR、resize/camera cut、parameter update/stable frame/publication atomicity/abort→retry/device loss/fence。

同条件记录实际 visible pixels、programs/bins/BindingSets/tile entropy、GPU outputs/质量/误差、bytes/bandwidth、VRAM/temporary/persistent/retired/resize peak、CPU encode/dispatch/pipeline、Geometry/material/lighting/management 分解、Surface total/command frame span/P50/P95。无法获得的 counter/时间明确 unavailable；旧历史速度不冒充新结果。

这里才做实现级性能调优：定位 binning tax、gather、texture locality、register/spill、pipeline count，不立即加 global cache/proof/history/VM。新复杂优化先 analytical Cost Card→isolated evidence→break-even，理想100%都不赚钱则拒绝，零收益管理税过高则不进入普通 hot path。不能为过 planning target 减灯/关 normal/VSM 或暗改 precision；必要质量/scale 改变须显式决定。

**退出条件：** 实现覆盖、独立 correctness、生命周期、旧链清除和真实成本均有结论；缺项/不完整 runner 如实未完成。结论解释模型与实际差异，并记录尚需数据决定的物理边界，不要求所有输入次线性。关闭 M1 后 STOP，重新设计 M2，不能自动继续后续模块。

#### 3.4.1 S3 实施结果与停止边界

本轮重新 fetch：HEAD=`d88aece22d3d7938db2286bb1102afdeb11f154f`，origin/master=`43e6d2f9435da9472d4f880d08ca176dae9bed45`，开始时工作区干净。S2 已在本地提交；重新检查 Renderer/FrameProgram 的唯一 SurfaceV4 ownership、native publication、Visibility/VSM alpha、HDR/Aux→Temporal/FSR、commit/abort/recovery 与旧链不可达，没有再次迁移 production 或恢复兼容层。本轮只增加集中验收和修正实际计时/诊断归属。

GPU 报告使用 fresh `build:test`：source SHA256=`95acada96c0214bb0f2060527316147f3a9b0164bc80c80c845b51e557a48656`，output SHA256=`27cd83d7f124df7ccdbb9efa7127ce488b6e8d2a172a2c06b2a456de4fa560ce`。下方生成场景表来自 `acceptance-providers-retry.json`，oracle SHA256=`ad75be7cc291d8549586229fb7102331b820fd61f54d18598e5225884ea1fb7f`；最终源码复验另见下文。它们是 HEAD 加本轮改动的测量身份，不是退休实现的对比 evidence。Chrome `154.0.8037.98`，Windows，NVIDIA GTX 1650 Ti **4096MiB**、driver `581.42`；GPU 作业串行。生成场景 oracle 为 headless，Showcase 为 headed，不跨这两种条件宣称提速。

**实际交付：** [production acceptance oracle](../../OEngine/tests/oracle/native-surface-acceptance-gpu.mjs) 仅使用实际 Renderer/Scene/Packed upload，复用现有 GPU timing/readback 与独立 CPU BRDF reference；没有替代 Surface shader、预填 closure/Lighting 或第二 renderer。现有 production oracle 补充 camera-cut/reset→settled 的真实 native identity 接线检查。FrameGraph 把 `SurfaceV4/*` 标为独立 `native-surface` timing region，Showcase 只消费该 region 或实际 native pass ticks，避免把末端 Present 的旧 `surface` region 当成 Surface。Showcase 诊断读实际 RenderWorld 的实例、Program、Bin、BindingSet 与资源账，初始化完成前安全返回缺项。新增内容是本地验收 glue；未新增复杂 GPU 算法或开源 adoption 声明。

##### 生产正确性与 workload

- 1080p、8×8 个真实 cooked box 实例，非均匀 scale=`(1.5,.825,.1)`，真实 winner/meshlet/instance/frame geometry/native graph/cluster/physical sun/VSM/IBL→pre-exposed HDR。P=`2,073,600`，V=`1,957,668`（**94.409%**），8×8 tiles=`32,400`。全部 64 instance 有 winner；完整 HDR 域 finite，每 visible pixel 获得正 radiance。
- 64 material instances 不等于 64 Programs。ordinary：1 Program/1 Bin/1 BindingSet，normal/ORM；complex：真实 custom graph，8 次 UV sin warp、normal sample 参与后续 color query 坐标、ORM、emissive、coat=.4/roughness=.3；多 route 组实际发布 8/32 Programs 和同数 bins、1 BindingSet。其 sin 深度随 Program 不同，**不是只改变 Program 数的等工作量性能对比**。Unlit 为单 Program、零点灯参考。
- 256×256、完整 9 mip authored normal/ORM/color 由 TextureResidency 发布。4/8/32 点灯数量分别检查实际 GPU light publication；distance=100、radius=.1、intensity=1，不把非零列表当作零 Lighting。ordinary 各组 64 个样本与独立 CPU 点灯 HDR delta 对照，最大绝对误差分别 `.000116144/.000109336/.000230904`，原先定义的 `.002 + .003×abs(reference)` 预算不变。Unlit 独立 working-color HDR、custom gain update 也通过；complex/coat 的完整数学另由集中 native-material/perspective/resource-profile oracle 验证，生成场景不冒称 custom 全像素 CPU 图像 reference。
- 首次 dirty-content frame 实际 VSM allocated/valid pages=`9/9`、casters=`180`、overflow=`0`；实际绑定的 diffuse/specular/DFG 采样 peak=`.323974609375/.2154541015625/1`，均 finite/nonzero。稳定 VSM 复用有效内容时 caster 写入可为零，不要求每帧重新 raster 来证明 provider 有效。provider readback 的额外 diagnostic submit 在计时之外；每个计时 production frame 恰好一个 submit。
- 真实 resident 与普通 Scene→WASM Product 两入口复跑 parameter update、publication atomicity、encoded abort→retry/stable、alpha reject/restore、normal/ORM/coat/custom/Unlit、多 BindingSets、camera motion、explicit cut→identity reset/settled、resize、受控 device.destroy→真实 recovery epoch2、fenced native ledger teardown。两入口均通过；不等于自动 driver-fault 恢复或完整大场景 VG 验收。

##### 1080p 实测成本

每组预热30帧，之后才启用120帧完整 timestamps；读回发生于计时外检查帧。以下 **同帧 pass 总和先求和再求 P50/P95**；native span 单独包含其间 copy/clear/marker，不重复加到 pass 总和。CPU 为 `renderer.render()` host elapsed，不含 host fence wait；dispatch 是整 production frame，非仅 Surface。

| 生成场景（全部 V=1,957,668） | lights / Programs / bins | Surface P50 / P95 ms | bins P50 ms | frame span P50 ms | CPU render P50 ms | frame dispatch |
|---|---|---:|---:|---:|---:|---:|
| ordinary normal/ORM | 4 / 1 / 1 | 5.552 / 6.829 | 0（dense bypass） | 45.970 | 5.4 | 87 |
| ordinary normal/ORM | 8 / 1 / 1 | 7.113 / 8.552 | 0 | 50.218 | 5.1 | 87 |
| ordinary normal/ORM | 32 / 1 / 1 | 14.201 / 14.957 | 0 | 57.177 | 5.0 | 87 |
| custom + coat | 8 / 1 / 1 | 8.529 / 9.324 | 0 | 54.050 | 6.9 | 87 |
| custom + coat | 32 / 1 / 1 | 16.601 / 16.976 | 0 | 60.276 | 6.8 | 87 |
| multi-route custom + coat | 8 / 8 / 8 | 10.130 / 10.531 | .840 | 54.634 | 7.2 | 98 |
| multi-route custom + coat | 32 / 8 / 8 | 17.749 / 18.702 | .844 | 63.805 | 10.2 | 98 |
| multi-route custom + coat | 8 / 32 / 32 | 12.026 / 12.370 | .889 | 58.714 | 11.8 | 122 |
| multi-route custom + coat | 32 / 32 / 32 | 19.892 / 20.564 | .889 | 64.887 | 11.2 | 122 |
| Unlit | 0 / 1 / 1 | .645 / .872 | 0 | 8.282 | 2.4 | 69 |

普通4→8灯 Surface 净增约1.56ms，8→32净增约7.09ms；complex 同灯数的必要图/coat成本与寄存器行为增加总时间。它们是实际 workload 差分，不是硬件 instruction counter，也不保证可加或跨轮次稳定。融合 shader 内的 Geometry/Material/Lighting **不能用 production timestamps 独立拆出**；可用的 G/GM/light/VSM/IBL 诊断差分仍是 §3.1 的独立 kernels，不冒充本表内部耗时。

**整帧瓶颈与 Surface 分开：** ordinary4 的 `LightCluster/yh` P50/P95=`29.908/38.412ms`，32-Program/8灯约=`35.197/40.620ms`。当前 owner 对 `60×34×24=48,960` clusters 做 frustum/light tests，每 invocation 有动态索引的 private `array<u32,256>`，并使用全局 CAS reservation。**INFERENCE：** private array/occupancy/spill 与全局竞争可能贡献高成本；无 backend counters，尚不能把30ms精确归给其中一种。这是已存在 Lighting provider 的性能缺口，不用 Surface cache/history/VM 隐藏，不在 M1 顺手重设计 M4。Surface 验收成立，**这些场景的 native1080p/60 全帧目标未达到**。

真实 authored `dungeon_warkarma.glb`（fixture SHA256=`cac0fc8c16d107e7ac4e69efde89c2cb6ef4bc66c34456a4dd0923218e5aafb1`），Scene→WASM Product/streaming→同一 production renderer：798 instances、25 material instances、**2 Programs/2 bins/2 BindingSets**，sun/VSM/IBL、XeGTAO/FSR/bloom/aerial开启，scale=1。该场景无显式点灯，不替代上表。两批交替 low/high，每组60帧预热、120完整 GPU frames；运行报告 complete，无多 submit。

| authored 场景 | actual V / coverage | Surface pass P50 / P95 ms | native span P50 / P95 ms | frame span P50 / P95 ms |
|---|---|---:|---:|---:|
| batch0 low | 681,012 /32.842% | 3.080 /3.473 | 3.080 /3.473 | 16.777 /17.302 |
| batch0 high | 1,667,147 /80.399% | 5.898 /8.192 | 5.898 /8.258 | 21.103 /27.460 |
| batch1 high | 同上 | 5.833 /10.551 | 5.833 /10.617 | 21.037 /35.127 |
| batch1 low | 681,012 /32.842% | 3.211 /4.850 | 3.277 /4.850 | 17.760 /25.100 |
| orbit-return high | 79.451–80.399% | 5.439 /7.668 | 见 raw capture | 23.986 /29.688 |

authored high 的 bins P50约`.852ms`、native useful shader约`4.981ms`；low 的 bins约`.721–.786ms`、native约`2.359–2.490ms`。低 coverage 管理比例更高，不把 fixed screen classification 当 O(V)；当前 dense 仍按真实 one-route绕过 bins。CPU render中位约`2.8–3.1ms`。运动 capture最大 Surface=`48.431ms`、frame span=`152.961ms`，原异常帧保留，不裁掉换好看 P95。传感器整轮温度72–91°C，148次采样中46次有至少一种 throttle flag active，P0 graphics clock765–1830MHz；这些不是固定clock、thermal-free基准，具体异常帧归因仍未知。timestamp量化约`.065536ms`，小 pass 量化零不等于无成本。

##### Cost Card / 模型对照

本轮没有新的 cache/reuse/VRS/selector；full-rate fused hot path、dense与compact bins均保持。Material/Geometry局部值留 private/register，未加全屏 MaterialRecord。下表是**源码逻辑访问/规划估算，不是 DRAM transactions 或 shader profiler counter**：

| 项目 | 当前 native 口径 / 1080p 高coverage成本 |
|---|---|
| 顺序流量 | background clear约8P；background/shade winner约8P；最终HDR+reactive完整写12P；empty background读8(P−V)，合计约**58.99MB/frame**。不含 sky/后效额外写入，明确不重算到下面texture流量 |
| 随机 storage | winner/Work/instance/directory/GeometryArena/coefficients/attributes/cluster/list/light-record gather；约`.6–1.2KiB + 48–64B×lights`每visible pixel的源码级读取包络。shared corner/frame metadata与light记录强复用；不能乘V后当全部uncached DRAM |
| texture | ordinary两个 material queries，custom有nested-coordinate邻域需求（约3–5 queries）；IBL代码21个textureLoad（diffuse4/specular8/DFG1/coat8），AO一个load；physical sun一个filtered LUT query和有效VSM query/taps。实际tap/cache/resident shader优化未提供计数 |
| compute | Geometry/Material/IBL/sun约数百至上千scalar ops，再加每point BRDF/attenuation约100–200ops；ordinary8粗计1,200–2,500 ops/V，32灯约4,000–7,000。normalization/sqrt/divisions独立记special ops；custom8的C/X/Y UV warp至多约48 scalar sin，32深度至多192。非实际动态FLOP/寄存器计数 |
| dense management | 0 queue、0 bins dispatch、无Surface全局atomic/barrier；background dispatch+1 native route在同compute pass，GPU exposure/generation小copy |
| multi-route management | 4管理dispatch；queue=`4P+32B`（8 bins=`8,294,656B`），32 sharded histogram/prefix scratch；count/scatter两遍winner/route与index一写一读，额外约`8P+8V=32.25MB/frame`，mapping/atomics另计。每tile/distinct-bin局部聚合后的global reservations、count2/scatter3 workgroup barriers；不是每pixel cache/proof |
| ownership / scratch | dense native raw约`.258MiB`；8 bins约`8.20MiB`、32 bins约`8.31MiB`（含Visibility/raster组织）；borrowed Graph HDR16.59MB/reactive8.29MB另计，不双算；无Surface persistent shading history |
| thresholds | 当前只验证coherent生成网格与authored scene；逐tile熵/硬件transaction/regs/spill counters unavailable。shader dispatch/pipeline数随实际bins增长；8→32 profile材质计算本身也变，不能纯归为dispatch税 |

引用 S0 measured RW=`169.49GB/s`，上述native顺序流量约`.348ms` floor；bins额外traffic约`.190ms` floor，实际`.84–.89ms`，差额含mapping/reservation/barrier/scan/locality，细分counter未知。S0 dependent BRDF profile约2,658 estimated GFLOP/s：ordinary8 compute-profile floor约`.88–1.84ms`，32灯约`2.95–5.16ms`。S0只是此前校准，clock/workload不同，不是本轮固定吞吐保证；floors取最大而非机械相加。把所有逻辑随机读取套28.36GB/s会严重高估，正如S0的错误82ms模型，拒绝用这个错误估算宣称未知开销。

planning 普通8灯6–9ms与本轮7.11/8.55ms相容；custom/coat8为8.53ms、8/32 Programs为10.13/12.03ms，32灯达到14.20–19.89ms，不能宣称一切场景6ms。不同kernel/条件的texture latency、Geometry gather、live range/occupancy和clock造成剩余差额，**精确寄存器/spill与transactions归因未知**。没有据此增加优化层；未来compact deferred阈值仍需同数学/同资源profile的测量，S0Compact44结果不自动替代生产split比较。

bins的可证伪边界仍是：被避免的额外扫描/divergence必须大于约`.84–.89ms`和locality损失；本轮是实际管理税验收，未构造等价many-fullscreen dispatch对照，**不宣称binning净提速**。0%有用组织收益则净损失管理税，50/100%时分别至少需要约1.7/0.9ms可节省工作（忽略noise/locality变化）；100%理想收益仍不足则拒绝该优化，不能用命中率美化。当前多route是合法不同Program/BindingSet执行的必要组织，dense不付这笔税；替代组织留有数据需求时评估。

##### VRAM / working set

`memoryEvidence()`是**部分 registered/allocator账，不是完整renderer VRAM**。authored当前约`1,010,375,520–1,018,670,620B`（约`.941–.949GiB`），其中FrameGeometryArena约128MiB、materials/texture capacity约319MiB、allocator textures约348MiB；native raw scratch随in-flight fence约8.22–16.13MiB。其遗漏不能当免费：API创建/销毁trace包含VG4个128MiB banks与64MiB metadata、VSM、native Temporal、FSR、environment等raw owners。

在截图完成时的API trace存活descriptor-byte总和=`1,868,391,337B`（**1.740GiB /1,781.84MiB**），创建/销毁序列峰值=`1,955,844,229B`（**1.822GiB /1,865.24MiB**）；texture逐mip/layer/sample/format计量、buffer按size，所有实际format均识别。它不含driver shader/query/alignment/隐式cache，也不能把destroy调用等同GPU fence完成。存活texture/buffer约束已实际计账，不能将`.94GiB`部分账冒称全预算。

其中VSM约`74,266,332B`（含4096² depth32 atlas）、native Temporal identity pair=`66,355,200B`（63.28MiB）、FSR-labelled resources约`78,797,009B`、environment约`17,339,888B`。VG banks+metadata=576MiB，GeometryArena128MiB；这些属于真实foundation/effect owner，**不是Surface scratch**，未来容量/streaming方案需要重新预算。nvidia-smi全GPU使用430–2647MiB（含桌面/Chrome/driver，非本进程专属）仍在4GB内，不是任意大场景有2GB余量的保证。

视觉720p→810p→720p resize样本的部分账约748→949→947MiB，回缩后shared allocator保留可回收capacity；native scratch最终回到约3.57MiB，真实resident/Product oracle fenced teardown均清空native ledger。1280/1920 resize acceptance不增加已完成native scratch。没有长期resize循环/allocator eviction实测，不能从少量resize宣称整renderer无泄漏。

##### 集中验证、原失败与限制

| 验证 | 本轮实际结果 |
|---|---|
| engine build / fresh build:test、examples surface-performance TS | 通过；build包含typecheck、Vite和declarations；实际GPU报告携带上文build身份 |
| engine全Node suite（在OEngine cwd） | **535项：507 passed、28 failed、0 skipped/cancelled**；28个失败名称全部对应S2已有、S1 baseline复现的缺口。新增FrameGraph真实stage归属回归通过；全套仍未通过，不修/删/skip这些失败来转绿 |
| targeted Surface/publication/bins/Aux/Temporal/FSR/FrameGraph | 47/47先通过；随后新增Graph回归所在文件9/9，全matrix覆盖该新增测试；Showcase+performance metrics13/13 |
| 串行GPU集中复验 | `native-surface-acceptance`、`native-surface-production`、`native-surface-product-production`、`native-material`、`native-surface-perspective`、`native-surface-resource-profile`、`framegraph-lifecycle`均通过；对应实际producer/product/consumer，不用regex替代 |
| authored timing / camera motion | 两批static low/high共480完整GPU frames、orbit-return120完整frames，截图/资源trace/传感器/raw时间保存；真实结果见上表，无多submit |
| visual VSM/FSR production | 9张static/moving/settled/Meshlet/near/resize/return/sun edit/restore截图，runner通过且逐张视觉检查；场景、贴图、debug切换、亮度修改与恢复可见，无明显缺失/爆色。不是独立photometric golden、ghosting定量或AAA画质证明 |
| 文档 / 导航 | docs verify 0 findings（66 historical warnings），documentation tests7/7、doctor/registry/context及diff whitespace通过；currentSlice只标M1完成边界，不复制性能状态 |

原失败均保留在忽略目录`.local/v4-s3/`：`acceptance-first.json`（fixture在setMode/预热前配置full capture，配额被耗掉；改为测量起点配置，不弱化断言）；`acceptance-final.json`（稳定/resize帧错误要求caster当帧非零；改为首次dirty-content帧检查180个真实caster，仍验证有效页面）；`acceptance-providers.json`因用户新消息中断未完成，重跑为`acceptance-providers-retry.json`通过。`visual/report.json`保留新增诊断在Renderer初始化前访问graphics的tooling错误，修正确认后`visual-final/report.json`通过。全Node第一次从仓库根调用，Phase-A工具按cwd解析`.test-dist`产生错误并挂住，停止该作业；正确OEngine cwd复跑完整535项，**不把中断运行当完成**。

`showcase-static/`保留修复前原始结果及错误Present-span派生值，不用于native span结论；`showcase-static-final/`、`showcase-motion/`带完整source fingerprints。它们的Showcase源码仅早于最终“初始化前返回缺项”诊断guard修复，计时shader/已初始化运行行为未改变；最终visual用修复后源码。GPUoracle均使用相同新鲜engine产物。本机raw artifact不是新authority，也未提升正式evidence/claims。

最后复核修正了oracle报表的样本字段：complex组64个样本只是HDR检查，不得标成64个独立CPU numeric samples；现在分别返回`inspectedSamples=64`与`independentSamples=0`，ordinary/Unlit仍为64个独立样本。修正后完整复跑所有生成场景，`acceptance-closed.json`通过，最终oracle SHA256=`c66fe4a206c2bd34169b61b6edd78ca2a3aa9eb1ac1221c46fc427c7d6c9da5d`。该轮普通8灯Surface P50/P95=`6.333/6.561ms`、32-Program/32灯=`19.738/20.224ms`；只修改report metadata、未改GPU工作，所以较前轮更快的数值不构成优化收益，前轮表及尾延迟仍保留。

**保留限制：** 28个Geometry/cook/fixture/canonical baseline失败仍未修复；S1 hardware SampleGrad与CPU理想filter偏差（本轮standard诊断最大`.1336045265`）仍未完全解释，authored GPU graph/梯度negative control通过不等于CPU理想采样一致。复杂custom/coat逐像素production CPU图像golden、逐tile entropy、register/spill/DRAM计数、其他GPU/浏览器、长时VRAM/设备fault、大规模VG与完整AAA/最终整renderer验收未运行。Nyx pending-native-adoption与B2-NUM-001/002历史unfixed/unresolved不升级。当前Lighting provider约30ms瓶颈、32 Program CPU encode与热降频尾延迟有明确记录，不宣称极致性能目标已全部实现。

**结论与停止：** M1完成：唯一native Surface生产路径覆盖本模块合法语义，S2旧owner清除、独立correctness/lifecycle与真实场景/资源/性能均有结论；保留默认fused与dense/CompactPixelBins，无新增全局管理系统。验收结论限于SurfaceV4模块与本轮场景，性能范围和未知项如上。**STOP：不自动启动M2**；下一步必须依据此时真实Geometry/VG代码和现有性能/容量缺口重新设计M2，而不是自动执行旧roadmap。

## 4. 旧缺陷的退休与存活语义

| 问题 | 保留的历史事实 | V4 测试责任 |
|---|---|---|
| B2-NUM-001 | General 参数 update/abort/retry 后 roughness 实际0.2757329643 vs 0.2333125621；后续复跑通过不关闭原失败 | **legacy-retiring-path-known-defect，unfixed/unresolved**；S1 native publication 参数/dirty/abort→retry/atomicity 与 stable material oracle，S2/S3 真实 production 验证 |
| B2-NUM-002 | 固定资源 update/参数 retry 稳定 HDR(0,0)ch0 实际0.99951171875 vs 1.4979037235540191，无 API error，根因未定位 | **legacy-retiring-path-known-defect，unfixed/unresolved**；S1 publication/HDR/preExposure，S2/S3 stable frame/HDR numeric/Temporal 语义 |

原失败/输入指纹保留在 [R4 §2.2](./eengine-extreme-performance-rebuild-execution-2026-10.md#22-未关闭正确性问题与用户例外)和 [R3 归档](../archive/eengine-extreme-performance-rebuild-r3-execution-2026-10-07.md)。不修即将删除的旧实现，不作为 V4 legacy-repair blocker，也不标 fixed/passed/resolved。只有 S2 实际删除致错旧 producer 及 production consumers 后，才记“旧 owner 已退休，原实现缺陷不适用于新链”；这不等于定位或修复历史错误。

parameter update、stable frame、publication atomicity、abort→retry、HDR numeric correctness 必须迁移 V4 新 owner 并验证。若源头属于仍存活的 shared foundation，归其真实 owner 修复，不能以“legacy”免除新链缺陷。

## 5. Source mapping与测试迁移

| 阶段 / package | 当前输入与新直接消费 | KEEP / REWRITE / DELETE |
|---|---|---|
| S0 | Visibility/Arena/source + cluster/VSM/IBL→isolated native HDR | KEEP winner/provider/math/timer；局部实验设施不进入 Renderer，不消费旧 heap/signals |
| S1 Compiler/Publication | GraphCompiler/ExactDag analysis/appearance_program + Scene/material routes→native registry/instance→isolated shader 与 coverage consumers | KEEP IR/CSE/DCE/deps、Registry lease/preflight、TextureResidency；REWRITE native CXY/backend/publication；新产品不依赖旧 GPU Tape/cache |
| S1 Native Core/Bins | MeshletWork/frame geometry/instance→winner reconstruction→native shade→HDR；routes→bins/indices/indirect | KEEP Geometry 源/VSM/BRDF/IBL；REWRITE native consumers 和瞬态组织；one-route 与 multi-route 都在非生产闭合 |
| S1 Aux/Lifecycle | demanded products/new publication→TemporalFacts/FSR/Debug 接口→隔离 integration | KEEP effect 自有 history、motion/exposure/math/FrameGraph；REWRITE finite Aux、事务和物理资源账；无 consumer 不分配 |
| S2 | Renderer/FrameProgram/RenderWorld + coverage/VSM alpha/Temporal/FSR 全部 owner 和直接读者 | REWRITE 唯一 production ownership/publication/读接口；同单元 DELETE 旧 runtime/heap/Tape/cache/coherence/signals/history/reconstruct/proof/store/reference 与无 consumer contracts/tests |
| S3 | 唯一 SurfaceV4 production→真实 HDR/Aux/Temporal/effects 输出 | KEEP 独立 reference；复审全部合法域、failure/质量/成本，按数据调整实现；不恢复旧 owner |

`appearance-graph.test.mjs`、`appearance-normal-filter.test.mjs`、`appearance-product-sampling-gpu.mjs` 映射 S1 native 数值/采样；`appearance-publication.test.mjs` 映射 S1 事务和 S2/S3 production；`surface-coverage-value-gpu.mjs`、`surface-geometry-boundary-gpu.mjs` 映射 S1 isolated 与 S2/S3 winner/numeric；`surface-temporal-value-gpu.mjs`、`fsr3-frame-lifetime.test.mjs`、`temporal-fabric.test.mjs` 的存活语义在切换前准备、切换时真实验证。旧 Tape/exact GPU、signal/field-store、closure cache/Store protocol 表示断言随 S2 producer 删除；其中 CXY、numeric、writer、abort 语义迁移，不能整套丢弃。现有测试仅是核查入口，预期须有独立依据。

## 6. Cost Card与数据决策

每个重要新增机制在实施前附一张简卡到对应单元实施记录/设计决策，source与测量后更新，不另建状态系统：

| Cost Card项 | 必填内容 |
|---|---|
| Workload/语义 | scene/graph/profile、P/V/T、lights、programs/ExecutionBins/BindingSets、entropy/residency、相同quality/reference |
| bytes | 新增/删除read/write bytes/pixel及总bytes；random/sequential分开；过滤texture流量已包含就不重复加 |
| compute | 新增/删除ALU/special ops、texture queries/taps、uniform/perpixel频率、实际删除work与仍必需exclusivework |
| management | global/shared atomics及contention/CASretry、barriers、scan/clear/copy、dispatch/pass/pipeline/CPU encode changes |
| memory | temporary/persistent working set、live/retired/upload/resize peak、每binding/sharedlimits和overflow完整行为 |
| model | effective吞吐来源/校准身份、compute/bandwidth/random/texturefloors、重叠假设、optimistic/expected/pessimistic；无数据明确假设 |
| break-even | ideal100%/50%/0%收益的成本/节省、噪声区间、适用/拒绝条件、失败后完整native correctness |
| measured verdict | closedunit的真实GPU/CPU全成本/quality，unknownscope解释、unavailable项，retain/rewrite/reject原因 |

frequency extraction也要计update/persistent uniform/边界读取成本，不能认为“编译期”就自动零executiontax。cache/VRS/ProgramPage/额外compaction/materialization未来即使提出，100%理想收益都不能明显赚钱则不实现，0%收益有高管理税则不得常规hotpath。可选机制关闭后必须仍有正确完整native，不能再把“OFF”做成巨量旧direct fallback。

开放决策只保留需要真实数据者：fused寄存器/跨pass收益对应compact deferred分界；nativeProgram×BindingSet/coverage pipeline的实际规模与capacity；shards/workgroup/multi-route locality以及将来compactpixel vs tile-route的必要性；winner32-bit外部context是否足够，改变契约才评估8B；Temporal identity/Aux格式精度与实际consumer。初版dense/CompactPixelBins已选定，tile-route不是同时开发的第二策略。后续AAA算法仅接口，不在M1决定reservoir格式、GI/SSR完整pipeline或AI模型。

## 7. 文档执行模型切换时的检查范围

文档执行模型切换时仅运行`node tools/docs-verify.mjs`、文档/导航工具targetedtests、`node tools/vibe.mjs doctor`、真实context/router解析及`git diff --check`。它们验证frontmatter、依赖、当前入口、YAML/链接和差异，不证明V4已实现或GPU performance；当时未运行engine typecheck/build、browser、GPU calibration、renderer oracle或benchmark，也未修改生产TS/WGSL。随后 S0 的代码与 GPU 验证单独记于 §3.1；入口不复制阶段结果。
