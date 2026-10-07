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
    - OEngine/src/gpu/GpuAppearancePublication.ts
    - OEngine/src/gpu/AppearanceProgramRegistry.ts
    - OEngine/src/gpu/GraphicsContext.ts
    - OEngine/src/material/AppearanceGraphCompiler.ts
    - OEngine/src/material/ExactAppearanceDag.ts
    - OEngine/src/shaders/appearance_program.ts
    - OEngine/src/render/CoverageRasterBindings.ts
    - OEngine/src/render/MeshletBucketRaster.ts
    - OEngine/src/render/RasterWorkPartitions.ts
    - OEngine/src/render/passes/PackedVisibilityPass.ts
    - OEngine/src/render/FrameGeometryArena.ts
    - OEngine/src/render/passes/LightClusterPass.ts
    - OEngine/src/render/vsm/VsmAtlasRasterPass.ts
    - OEngine/src/render/surface/SurfaceWorkRuntime.ts
    - OEngine/src/render/surface/SurfaceFrameResources.ts
    - OEngine/src/gpu/GpuSurfaceWorkAbi.ts
    - OEngine/src/render/temporal/TemporalFactsPass.ts
    - OEngine/src/render/passes/fsr3/Fsr3UpscalerRuntime.ts
    - OEngine/src/framegraph/FrameGraph.ts
    - OEngine/src/framegraph/ShadeGPUCommandContext.ts
    - OEngine/tests
    - tools/docs-verify.mjs
    - tools/project-navigation.mjs
---

# EEngine V4 执行计划：完整构建、原子切换、立即删除

唯一架构依据为 [V4 母稿](../next-design/eengine-v4-native-shading-2026-10.md)，本文是唯一 **current renderer execution authority**。[workstream.currentSlice](../../project/workstreams/active/eengine-next-clean-rebuild.yaml)只导航当前大模块，详细阶段状态只在本文。旧 R3/R4 执行记录为 history，不继续 Surface C，也不把旧阶段映射成 V4 已完成。

2026-10-07 文档切换时重新 `git fetch origin`，HEAD 与 origin/master 均为 `0386bea5fc59a98cefd3f54d2be589ab9b2ed0eb`，审查开始时工作区干净。当时仅重构执行模型，没有新实现或 GPU 结果；这是切换时点快照。随后 S0 的实际交付与结果只见 §3.1，生产 Surface ownership 仍未切换。实施前须再次核对源码身份和工作区。

## 1. 实施模型与验证纪律

### 1.1 Agent 入口与停止边界

收到“继续当前 V4 workstream”后：

1. 读 workstream authority/currentSlice 与本文阶段表，找到第一个未完成阶段。其他资产专项 workstream 不构成第二套 renderer authority；不新增 status/progress/roadmap。
2. 重新 fetch、确认 HEAD/origin/master/工作区，用 `node tools/vibe.mjs context <path>` 导航；读本阶段 producer、产品、全部直接 consumers 及近目录约束。context 不是许可或验证门禁。
3. 固定存活语义、真实合法场景、source map、容量/失败行为和 Cost Card。完整算法开工前重新核读固定 donor 的完整相关阶段、license、关键分支并补本地映射；计划存在不代表移植完成。
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
| V4-S1 | Complete SurfaceV4 Construction（non-production） | **next / 未开始**；以 S0 支持的 fused baseline 开始完整非生产构建 |
| V4-S2 | Atomic Production Cutover + Immediate Destructive Purge | 未开始；等待 S1 完整功能闭包 |
| V4-S3 | SurfaceV4 Acceptance | 未开始；等待 S2 切换、删除及集中正确性验证 |

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

**实施记录：** 未开始；没有新增 native subsystem 或 production 接线。

### 3.3 V4-S2 — Atomic Production Cutover + Destructive Purge

这是 M1 唯一一次 production architecture switch，也是不可分拆的 cutover/retirement 单元。S1 完整闭包证明后，连续把 `FrameProgram→SurfaceWorkRuntime→fields/signals→Reconstruct→HDR` 改为 `FrameProgram→SurfaceV4→HDR+demanded Aux`，随即删除全部失去 consumer 的旧代码。中间允许编译失败/不可运行；不通过临时 adapter、selector 或双 owner 保绿。

| 当前实际边界（路径相对 OEngine/src） | 同一单元必须切换的责任 |
|---|---|
| `render/pipeline/RendererCore.ts` | `_surfaceWork` construction、canPrepareFrame/prepareFrame、invalidate、commit/abort、destroy/recovery、诊断/config/counter；新 owner 对接单帧提交/重试/退休 |
| `render/program/FrameProgram.ts/FrameProgramBindings.ts/FrameProgramLowering.ts` | products/需求/key/preflight、Lowering 中 FrameProgramOwners.surfaceWork、addPublicationToGraph/addToGraph、绑定/资源导入；radiance/reactive 与 Sky/Aerial/Temporal/FSR 全部直接输出 |
| `gpu/GpuRenderWorld.ts/GpuAppearancePublication.ts/AppearanceProgramRegistry.ts/GraphicsContext.ts` | native instance/program/material/route publication、Scene stage/prepareAppearance/commit/update/release、async ready/lease/preflight/device recovery、静态资产与资源账；不能无条件整类 KEEP/DELETE |
| `render/CoverageRasterBindings.ts/MeshletBucketRaster.ts/RasterWorkPartitions.ts`；`render/vsm/VsmAtlasRasterPass.ts` | compiled alpha programs、constants/routes/runtimeInputs/coverageDirectory、texture/Product views、finite raster partitions 及主 Visibility/VSM alpha 直接消费；材质更新与阴影 coverage 一致 |
| `render/temporal/TemporalFactsPass.ts`、`shaders/temporal_facts.ts`；FSR/Debug consumers | 替换 surfaceMetadataOffsets/materialLookup/valueVersions 读取；保 motion/change/identity/validity/曝光；FSR color/depth/motion/reactive/validity/current/prior exposure 实际接齐 |
| native lighting consumer 与现有 providers | 保 cluster/overflow、VSM table/atlas/constants/content version、IBL/AO/颜色域；只替换旧 packets/history 中间读取，不在本单元重写 provider 算法 |

切换后**在同一 S2 内立即 dependency review → destructive purge → compile → 集中验证**，不允许 TODO later removal。

| 删除候选 | 判断 / 保留边界 |
|---|---|
| SurfaceWorkRuntime、SurfaceFrameResources 旧职责、GpuSurfaceWorkAbi | 删除中央调度/旧 allocation、banks/field/signal heap、work/control 及 old history；必要物理计账/fence/math 分离至真实新 owner |
| appearance_exact_dag GPU runtime、Typed Tape GPU backend、Closure Cache ABI/runtime | 删除解释执行、nomination/unique writer/publish/cache/reuse 协议；ExactAppearanceDag 只保新 backend 实际需要的 CPU 分析/数学，不凭文件名整删 |
| surface_work coverage/coherence/appearance/lighting/reconstruct 等旧 wrappers | 删除旧 work packet/heap/rate/six-signal/history/reconstruct；保 Visibility coverage、VSM/IBL/BRDF/Geometry 的独立有效职责或纯 helper，不能删除真实 donor 算法 |
| 旧 diagnostics/settings、timing categories、exports/tests、contracts/specs | 清除旧 cache/reuse flags、field/signal 账和运行接口；存活语义迁移新测试/owner，历史记录保留 history，不让已退休 ABI 继续约束 current |

**不可达退出条件：** 搜索 imports/exports、owner construction、FrameGraph nodes、resource/pipeline allocation、settings/diagnostics、tests/contracts。旧 runtime 不再 constructed/prepared/encoded/allocated/committed/invalidated/retired，并删除无 consumer 实体；不只去掉 addToGraph 调用或留死文件。实际依赖可能增减，最后以 fresh source audit 为准。

**集中验证：** 最新源码 typecheck/build/build:test、targeted material/coverage/HDR/Temporal semantics、真实唯一 production GPU 链、update/stable/abort→retry/resize/recovery/fence；结构清除、完整合法多 route 域和资源账一并核对。真实 cutover 后才更新 domains 已实现事实及稳定合同。必需失败不交 S3 掩盖；S2 关闭时已经只有 SurfaceV4 production。

**实施记录：** 未开始；旧 Surface 仍是唯一 production owner，未删除。

### 3.4 V4-S3 — SurfaceV4 Acceptance

只在 S2 已切换、删除并集中验证后启动；此时结果才代表真实 production SurfaceV4。集中覆盖：普通/复杂 PBR、normal/ORM、coat、Unlit/custom、多 program/multi-route/multi-BindingSet；high/低 coverage、near/far、camera motion、alpha；4/8/many lights、有效 VSM/IBL；Temporal/FSR、resize/camera cut、parameter update/stable frame/publication atomicity/abort→retry/device loss/fence。

同条件记录实际 visible pixels、programs/bins/BindingSets/tile entropy、GPU outputs/质量/误差、bytes/bandwidth、VRAM/temporary/persistent/retired/resize peak、CPU encode/dispatch/pipeline、Geometry/material/lighting/management 分解、Surface total/command frame span/P50/P95。无法获得的 counter/时间明确 unavailable；旧历史速度不冒充新结果。

这里才做实现级性能调优：定位 binning tax、gather、texture locality、register/spill、pipeline count，不立即加 global cache/proof/history/VM。新复杂优化先 analytical Cost Card→isolated evidence→break-even，理想100%都不赚钱则拒绝，零收益管理税过高则不进入普通 hot path。不能为过 planning target 减灯/关 normal/VSM 或暗改 precision；必要质量/scale 改变须显式决定。

**退出条件：** 实现覆盖、独立 correctness、生命周期、旧链清除和真实成本均有结论；缺项/不完整 runner 如实未完成。结论解释模型与实际差异，并记录尚需数据决定的物理边界，不要求所有输入次线性。关闭 M1 后 STOP，重新设计 M2，不能自动继续后续模块。

**实施记录：** 未开始；没有 production SurfaceV4 验收或性能结果。

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
