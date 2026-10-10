---
id: eengine-v4-minimal-gpu-work-2026-10
state: current
verifies:
  files:
    - OEngine/src/gpu/GpuNativeMaterialPublication.ts
    - OEngine/src/gpu/GpuNativeMaterialScene.ts
    - OEngine/src/gpu/NativeMaterialBindings.ts
    - OEngine/src/gpu/NativeMaterialPhysicalBanks.ts
    - OEngine/src/gpu/GpuFrameGeometryArenaAbi.ts
    - OEngine/src/gpu/GpuWinnerInterpolationAbi.ts
    - OEngine/src/render/FrameGeometryVertices.ts
    - OEngine/src/render/surface/NativeVisibilityPass.ts
    - OEngine/src/render/surface/NativeExecutionBins.ts
    - OEngine/src/render/surface/SurfaceV4.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/src/render/program/FrameProgramBindings.ts
    - OEngine/src/render/CurrentHzbLateRecheck.ts
    - OEngine/src/render/TemporalOcclusionWork.ts
    - OEngine/src/shaders/temporal_occlusion_work.ts
    - OEngine/src/render/FrameCoordinator.ts
    - OEngine/src/render/lighting/LocalLightWorkGenerator.ts
    - OEngine/src/gpu/GpuLocalLightWorkAbi.ts
    - OEngine/src/framegraph/ShadeGPUCommandContext.ts
    - OEngine/src/material/NativeMaterialMutation.ts
    - OEngine/src/material/AppearanceRuntimeInputs.ts
    - OEngine/src/gpu/TextureResidency.ts
    - OEngine/src/render/passes/fsr3/Fsr3ShadingChangePyramidPass.ts
    - OEngine/src/shaders/native_visibility.ts
    - OEngine/src/shaders/surface_geometry_completion.ts
    - OEngine/src/render/pipeline/RendererCore.ts
    - validation/labs/bistro-cost-map/capture.mjs
    - validation/tools/run-bistro-cost-map.mjs
---

# V4：Minimal GPU Work 收敛

本轮依据用户授权按 A→F 连续完成；当前源码和实际 GPU 消费高于历史结论。全局约束仍为 Native Shading 母稿。模块实施结果只记录在[执行计划](../next-execution/eengine-v4-minimal-gpu-work-execution-2026-10.md)。本设计描述选择和目标，不证明尚未完成的代码、画质或性能。

目标流程：Virtualized Scene → GPU hierarchy/HZB → minimal raster cache/work → minimal Visibility → tile shading work → winner reconstruction/native material/lighting → FSR3 → display。保持一个生产路径、一个 frame submit、GPU-only 当前帧调度、完整容量和 exact R8 MASK；不启动 VT、page table、texture feedback、Surface VM、全局 shading cache。

## B：Raster classes 与 Minimal Raster Cache

Publication 分别拥有 Surface directory/constants 与 raster directory/coverage constants，原子发布、abort/retry、fence retirement 和 device loss 共用既有 owner。Opaque class zero 无材质 evaluator、texture 或 shading varying。MASK 由既有 Appearance Graph selector 提取 alpha 根依赖，再独立 lowering/binding；每个材料有自己的 coverage constant base。主 Visibility/VSM 使用相同 coverage 程序和 R8 plane/cutoff，VSM caster namespace 不引用 main-view cache。

Geometry owner 只生成每候选顶点 16B clip、每三角形 4B corner addressing 与每 work 24B directory。目录中新增 8B resident attribute/source locator，避免 cache 命中后为每 pixel 再次解析 Product asset/group/page/meshlet。cache miss 使用同精度 source decode，不能丢 work。Surface winner 才从 immutable resident geometry 读取 graph 所需 attributes。不改 resident object-space 96B 属性 ABI；删除的是每帧 world-space 88B 重复表示及 binding。Frame arena V7/24B directory 同步切换 main raster、Surface、partition 和 late-HZB 复制/绑定，不保留旧布局。

### Geometry Cost Card

令 V=候选顶点、T=候选三角形、P=winner pixels，源已由 residency 解码，顶点 normal/UV 等不是每帧重新解压 BC。

| 方案 | 每帧 payload write | preparation source/ALU | raster reuse | winner 成本 |
|---|---|---|---|---|
| A Full Frame Attribute Cache | 104V+4T，另加 directory | 全属性读取、clip/world/normal/tangent 变换 | clip/attributes 共享 | 已变换 attributes，省 source setup |
| B Minimal Raster Cache | 16V+4T，另加 directory | position/clip，删除全部 shading attribute store | 同样共享 clip/corners | source metadata、所需属性与 object→world 变换 |
| C Direct decode in raster | 不生成 cache payload | 每 raster corner source setup/position/clip | triangle-list pulling 不保证跨三角形 vertex reuse | 同 B |

选择 B。静态 Bistro V=704224、T=492201，3T/V≈2.10；C 把 clip/source work 扩大到至少 triangle corners，尚不支持其成本更低。B 删除 61,971,712B/frame 属性写入，额外删去 producer 全属性读取/变换；arena 1M vertex 上限删除 88MiB resident allocation。均为逻辑 byte count，不等于实测 DRAM traffic。

收益边界：0% candidate shading reuse 时 A 属性工作全浪费；50%/100% 下，B 的 source setup/变换随 P 增长，A 随 V 增长。B 不是无条件更快：break-even 要比较删除的 producer bytes/ALU 与额外 winner metadata/ALU。实际 B 验证已看到 Surface 回归，须由下一单元削减 winner 重复 setup。两者都保留 3 preparation dispatch、一次 source workgroup barrier、vertex/triangle reservation atomics；不声称删除 pass。B 无 texture samples，工作集从完整 attributes 收敛为 clips/corners；source访问仍按真实 resident layout，不能将其虚称压缩读取。

### Visibility Cost Card

原 R=Surface execution bins，新 R=1+coverage code/resource classes。PSO 为 2R，indirect draws 为 8R；partition indices 为 4W，状态/indirect/uniform 随 R 缩小。OPAQUE 删除 texture bindings、所有 shading varyings、material inputs 和 fragment frame construction；MASK samples 按实际 alpha DAG，exact alpha sampling 保持原策略。四个 partition dispatch/two O(W) classifications 仍存在，未冒称全部删除。0/50/100% opaque 比例下 shader work 收益随该比例变化；纯 MASK 的收益取决于 alpha DAG 是否显著小于 Surface graph，不宣称必然收益。

## C：Tile work 与局部 triangle reuse

目标替换每 winner 一条 u32 queue 和两次完整 winner_bin gather。一个 8×8 classifier 解析 winner，一条记录代表 tile+execution class+64-bit coverage mask。空 tile 无记录，uniform tile 一条，mixed tile 按实际 classes 发记录；不默认写 pixel queue。

便携 workgroup aggregation 不使用 Wave/Quad/bindless：固定 128-slot local hash 聚合最多 64 个不同 keys，负载至多 50%；完整 probe bound、mask atomics 和容量由 tile/bin 数学上限保证。uniform tile 跳过 hash 插入。采用固定 per-bin tile banks，删除 prefix scan 与 scatter；classify 直接发布最终记录，finalize 只写 bin 的 indirect 参数。单 execution class 隐式全屏 tiles，不分配 management queue。

共享 triangle reconstruction 仅作为已测而拒绝的候选：只能 workgroup-local、当前 tile 的 uniform primitive，不能变成跨帧 cache。初次 C 实测 static uniform primitive 为 11585/32400；完整共享 GeometryCompletion 后 Surface P50 反而升到18.874ms，移除该结构与消费端 barrier。非线性 Material evaluator 的 C/X/Y 数值与 texture gradient 语义保持。classifier 暂留 primitive ratio 作为本轮诊断，不宣称现有 Surface 使用该 flag。

Cost Card：每条最终记录 12B（tile/primitive-uniform flag、maskLow、maskHigh），每 bin 32B indirect metadata。完整容量为 12×Tiles×B+32B，scratch 为 4×(B+4)；不按上一帧 readback 收缩当前 capacity。1080p、B=11 时队列为 4,277,152B，对比旧 8,294,752B；B 超过约 21 时该容量比旧 pixel queue 更大，必须在资源创建前按完整上限拒绝不支持的配置，不能截断。没有 raw/sorted 双份表示，也没有 tile scatter。选择固定 banks 是为了删除全屏 scatter 和 prefix，而非保留四段排序。

classify 对每像素只作一次 Visibility/Work/Instance/Material gather，统一 tile 一个 global append，混合 tile 每实际 bin 一个 append；local hash 最多 128 次探测，weak CAS 的伪失败原位重试，不消耗 probe。工作组共享容量按 2064B 协商，无 texture sample；额外 hash atomic 初始化、barrier 和低熵 append 税必须由实测判定。管理 dispatch 从四次降为两次。正常低 entropy 的实际 queue write 为 12×records，而非 4×P；Surface 每记录一个 64-lane workgroup，混合掩码的 inactive lanes 是明确成本。

拒绝方案 Cost Card：uniform primitive 只在 64 像素均为同一 key 时成立。一条 lane 恢复三角形后共享 GeometryCompletion：0% primitive reuse 仍有两次 uniform-load/barrier 税；50% 时恢复次数理论减少49.2%；100% 时理论减少98.4%。共享结构读取、寄存器/occupancy 和串行 lane 成本不被该 ALU 计数覆盖，实测并不支持在本场景获利，不保留该 hot path。

source locator 的替代成本：每 admitted meshlet 新增 8B 目录读写，静态11982 work为95,856B/frame；完整119356 work capacity多954,848B arena。删除 cache-hit winner 的 asset/group/page/meshlet 多级验证、resident directory 读取；实际 source attributes、object-to-world/normal 变换、winner interpolation 保留。0% cache hit 无收益且有目录税，50%/100% 时避免的 metadata work 随 hit winner pixels 增长；不按此比率声称帧时间收益。direct source miss 语义不变，Product admission/fence/instance+frame-directory generation 保证同帧地址有效。

生产 background 不创建独立黑色 HDR 纹理：直接 render attachment clear HDR/Reactive，再只写 winner。已提供的 pre-exposed HDR image 通过 GPU copy 初始化，保持原数值语义；不扫描 Visibility。删除一份 8×P transient black image、一个 FrameGraph background pass 和一个 empty-winner 全屏 compute dispatch。可选图像初始化有 8×P read/write，不能冒称免费；Bistro 使用 optimized clear。

Reference（未声明移植/adoption）：WickedEngine `df44c3db4c4927492bc9c791eac715d98d7ed091`，MIT，`WickedEngine/shaders/visibility_analyzeCS.hlsl::main`、`visibility_resolveCS.hlsl::main`、`visibility_shadeCS.hlsl::main`。已读实际源码：uniform/divergent primitive tile、per-shader tile lists、Wave bitmask 与 fixed shader-count banks。采用问题分解与 tile bank 参考；EEngine 的有限 PSO/Texture Residency、portable hash/mask、完整容量与 conditional local reconstruction 是本地实现，不能照搬 Wave/固定小 shader count。来源 revision/license 沿既有 porting 记录核对，不宣称代码移植。

## D：Native physical bank profile

同一 scene publication 对实际使用的 whole-texture segment 取完整有限并集，优先一个共享 profile。材质常量中的 TextureRef 经 CPU 冷 publication 转换为 profile bank/layer；GPU 的有限 switch 选择物理 array。Shader key 不含材质的物理 tuple。超出完整 provider + Product + material sampled-texture limits 时，按完整并集分组，不截断、不创建额外 continuation。Coverage 单独按 alpha DAG 规划 profile；R8、独立 layer、AF1、cutoff、mip clamp 与 Visibility/VSM 保持同一语义。

Cost Card：无新增 GPU texture/buffer、dispatch、barrier、feedback、page table；每个 texture query 增加有限 bank selector ALU/分支，并可能增加 shader 体积与资源工作集。RGB-only route 仍为 28B；有 alpha 输出时使用独立 alpha TextureRef 的两个精确 u16 与 layer，共 40B/query，比旧覆盖路径多 8B。Sample 数不因 bank profile 增加；exact R8 alpha-only 不采样 RGB。冷规划 CPU 按 segment/view 精确身份比较，stable CPU 尚待 F 的事件版本闭合。

0% tuple fragmentation 时，无 bin 合并收益，selector 是固定税；50%/100% 时可能删除重复 pipeline/dispatch、tile bank capacity 和跨-bin tile 分裂，但收益取决于实际 bin 数与 entropy，不按百分比声称帧时间改善。Bistro 当前 6 physical banks 可在 lit Surface 的 9 个剩余 sampled slots 内完整绑定。必须用同机 A/B 检查动态选择的税是否被 bin 减少抵消；不能仅以编译、限制检查或测试通过作性能结论。

Surface 仅保留其实际消费的 graph 输出：不执行 alpha；unlit 仅消费 baseColor。Coverage 保留独立完整 alpha dependency graph、参数、instance inputs、value revision 与 abort/retry 原子性。资源 layout 中的 profile 地址与未来 Residency owner 可独立替换，不改变 tile-work ABI；本轮不实现 VT。

## E/F：Occlusion、mutation 与 submission owner

E 的当前候选：当前帧 hierarchy/LOD cut 仍由既有 GPU owner 生成，meshlet 级 previous-HZB 只标记暂缓，不能永久拒绝。使用同一 MeshletWork queue 和原 slot identity，避免多份 24B work queue 与 winner namespace remap；4B/deferred slot 的有限索引仅供同帧 recovery。Frame Geometry 和初次 Raster 跳过暂缓 slot。当前真实深度生成 HZB 后，暂缓 slot 以 current transform/current camera recheck；恢复者原位标记并仅构建其 clip/corners，第二次 raster 只绘制恢复者。最终 HZB 根据最终深度生成；不同视角、动态 occluder、变化的 LOD cut 只影响预测，不能造成永久漏工作。

该候选 Cost Card：新增 4×完整 meshlet capacity+32B deferred indices/control，无复制完整 attribute/work representation；每帧 early bounds/HZB 测试、deferred recovery、第二个 raster partition 和最终 HZB build 为明确固定税。现有 hierarchy、Product work selection 保留，不声称减少 tested hierarchy nodes。初次 clip writes 与 raster triangles 随实际 early accepted meshlets，recovery 为实际新增者；0%拒绝时没有 geometry 收益却有管理税，50%/100%必须实测删除的 clip/source/raster work 能否抵消额外 bounds tests、texture loads、dispatch 与第二次 HZB。若同机没有收益，不以功能正确或 work counts 下降声称 production 性能关闭。

当前实现用 `TemporalOcclusionWork` 管原 slot 的 Deferred/Recovered flags。额外 settings80B 与 indirect32B；raster owner 的 recovery settings32B。deferred RW storage 与 dispatch indirect 分离，不能在同一 compute scope 把同一 buffer 同时作为 RW storage/INDIRECT。Product 源队列仍包含完整当前 cut，header written 数量不冒充 active meshlet 数量。真正减少的是 clip/corner preparation 和进入 raster 的三角形。当前 HZB 用 outward-rounded RG16 min depth、屏幕范围扩展一个 source pixel、reverse-Z 最近深度与严格容差比较；invalid/near clip 失败开放。

正常 Orbit 不作 camera cut；显式 invalidate、camera object switch、resize/device epoch 仍失效 history。普通非 Product geometry 没有同帧 recovery consumer，故禁止 previous-HZB permanent rejection，保守处理；这条路径的 motion occlusion 优化未实现。不能以本轮 Product Bistro 证据宣称所有 Geometry owner 的 moving HZB 已完成。

Reference Source Map：Nyx `bc7e5b1e51f6b3b8af4771db81ffaa714fcbe64b`，MIT，`MiniEngine/Model/Shaders/InstanceCull.slang`、`DAGCull.slang`、`CullCommon.slang` 与 `MiniEngine/Model/Renderer.cpp` 的 previous/current 两阶段 occlusion。已逐文件核对本地源码与 pinned remote（CRLF 归一化后 SHA 相同），证据 `.local/research/nyx-convergence-source-check.json`。采纳“预测可错、当前深度恢复必须补齐”的机制；EEngine 只遍历当前 Product cut 一次，用有界原 slot 索引恢复，不移植其 wave、mesh shader、bindless 或 native command 框架。不声明代码移植/adoption。

D：whole-texture Residency 的 scene/frame physical bank profile，使 execution class 尽量按 shader code；TextureRef 选择 bank/segment/layer。资源 limit 在创建前协商，texture formats/dimensions/sample policies 保持正确；未来 VT 替换 Residency，不更换 Surface Work owner。本轮不实现 VT。

E：正常 camera motion 与 cut 分离，previous HZB 只能 conservative early reject；必须有同帧 current HZB 的 GPU recovery 补回 early-rejected work。只保留旧 HZB 而不补 recovery 不正确。动态 occluder 保守处理。static/slow/fast 同场景验证 tested/accepted/rejected、meshlet/vertices/raster/GPU 成本。

F：保持 FSR3 数学，先测每 pass。分离 frame admission、completion、retirement、history 与 transient ring，做 bounded 2/3 slots A/B。Stable CPU 材料/场景/streaming 用真实 revision/event O(1) admission，不以跳过更新代替；debug/evidence on-demand。删除 empty-winner background compute，背景和 aux clear 属于实际 background/attachment owner，保证完整写域和 resize/abort/history 初始化。

CPU Cost Card：首次 admission 安装 material scalar/nested color 的 mutation observer、RuntimeInputs change signal 与 Residency publication signal，冷变更才做完整快照/profile planning。stable `canPrepareFrame()` 为一次 dirty/selected-readiness 判断，不构造 material arrays 或逐值比较。streaming pump 读取 O(1) blockedUploads/lastPoll，debug FrameGraph dump/summarize 移至显式 evidence 调用；Surface 同步 prepare 不复制 descriptor。新增 observer/listener 的 CPU working set 随 authored materials/fields，新增 setter 一次 Object.is/通知税；0%变化删除全部 stable 扫描，50%/100%持续变化仍需冷 snapshot 加通知，不能声称此时 O(1)。构造失败、destroy 和 nested replacement 必须注销订阅。AppearanceRuntimeInputs.get 返回防御副本；修改通过 set/copy 才由 owner 发布，不能保留可无事件写入的 Float32Array alias。

Scheduling Cost Card：3 个有界 CPU frame context slot 与命名 latency(2)/throughput(3) admission policy，无新增 GPU buffer/texture/submit。每次 submit 立即捕获唯一 queue fence；资源退休与 history publication 观察该帧 fence，而非稍后注册、可能覆盖后续帧的 fence。已提交后异常仍保留 slot；abort 只释放未提交 slot。增加第三槽最多增加一个在途帧及其 fence-retained transient working set/排队 latency，不改变 shader 总 work。0% admission stalls 时无 throughput 收益；50%/100%受阻时需同浏览器实际 submitted FPS、RAF deferral 与 completion latency 判断，不能以 2→3 数字声称 GPU 更快。默认 latency，测量之后才选择。

F 的 Shading SPD execution 候选 Cost Card：源码一个 lane 串行执行四次完整 source_value（motion、十次 luma sample、两组 sort、minimum-difference loop）。改为256 lanes/16×16 source pixels，保持每组8×8 mip0输出及原 `(v0+v1+v2+v3)*0.25` 加法顺序；新增4KiB workgroup storage、一次 barrier、四倍 lanes，dispatch/workgroup 数与 texture samples/ALU 总量不变，无新增 full-screen pass 或 global intermediate。理想条件减少单 lane live ranges 与串行依赖，最坏情况 occupancy/barrier 税反而更慢；0/50/100%材质可见比例均不影响该固定算法税。必须先对 frozen pre-change GPU source 在 NPOT、motion、jitter、exposure 下逐值比较，再用同机 Bistro 验证，失败则删除候选。FidelityFX SDK1.1.4 `c6efa6bf7f2027b3ec94f28578bb5965eabb9e55` MIT，已读 `ffx_fsr3upscaler_shading_change_pyramid.h::SpdLoadSourceImage/ComputeMinimumDifference/SpdReduce4`；保留公式与后续逐 mip 精度/quantization，此项只是本地 WebGPU lane mapping。

Surface IBL 的局部 Cost Card：`coatFactor=0` 时原代码仍执行两级 octahedral bilinear coat radiance 共8次 textureLoad，然后乘0。按与 direct BRDF 相同的 `coatFactor>0` demand 分支，仅对真实 clearcoat winner执行该采样；无新增表示/pass/resource，新增一次比较/分支。0/50/100%零 coat winner分别省0/4/8 loads每 lit winner（分支发散的实际硬件收益低于理想值），同时删除零贡献 reflection/oct encoding/weights ALU；有coat的公式和采样顺序保持原样。只适用于已验证有限值的 material/environment publication；不降低材质功能或默认效果。

Native lighting demand Cost Card：冷 Snapshot 从实际 native routes 计算一个 `hasLit` boolean；Renderer/FrameProgramBindings 都读取同一 candidate/prepared/active owner，稳定读取 O(1)。删除从旧 Scene `binRefCounts` 推断代码需求的分叉；动态 `is_unlit` 变更跨 abort/retry 保持 publication 原子性。无新增 GPU bytes、ALU、samples、pass 或 dispatch；全部 unlit 时删除无消费者的 LocalLight/AO/VSM demand，已有 lit 场景的 GPU 工作不变。真实资源/代码变更仍冷规划，不以此声明全部 FrameProgram binding 校验已 O(1)。

## 验证

Native AA 研究边界：已读取 pinned SDK1.1.4 `ffx_fsr3upscaler.cpp::ffxFsr3UpscalerGetUpscaleRatioFromQualityMode/GetRenderResolutionFromQualityMode`，NATIVEAA 仅返回1.0 ratio；不是可直接替换当前核心公式、删除完整准备/历史 pass 的廉价 algorithm profile。本轮保留 FSR3 owner，未实现独立精简 Native AA graph 或 Quality/Balanced 降 scale 验收；不得将此类未来工作或降分辨率混入本轮架构收益。

Surface geometry 的当前事实：`geometry_complete_resolved` 每 winner 构造一次 triangle corners/coefficients；`winner_interpolate` 从 homogeneous plane 直接求当前与相邻1像素的投影权重，保留有限差分语义，不改成 quotient-rule infinitesimal derivative。shader 按 graph dependency 恢复属性；材质非线性表达式仍需 C/X/Y 以求 texture footprint。当前 Bistro continuation=0；完整 limits 压力 oracle 有 continuation 覆盖，但未建立大型跨 pass shading cache，也未声明任意超 limit profile 都免重复 geometry/material execution。

LocalLightWork 原有最多3份完整 allocation、18MiB peak budget，却在 encode 又用 submitted>=2 抛错；3-slot 实测触发该矛盾并使 demo RAF 停止。删除重复 encode gate，用命名 LOCAL_LIGHT_FRAME_CAPACITY 统一 prepare pool/cost budget；资源仍由真实 fence 释放，第四份完整 allocation 拒绝，未增原有内存上限或 GPU dispatch。对应 CPU contract 需验证3份都可 encode、第四份拒绝、abort 只释放对应 allocation；不是把 history ring 改为3。

开发用 typecheck/build、少量独立 semantic/lifecycle GPU oracle。每大单元闭合后 full cooked Bistro 一次，GPU 串行；保存原失败并分类。主验收同 1920×1080、scale=1、SSE=4、材质/几何/效果/相机。GPU profile 记录 adapter/browser、GPU sensors、页面错误、source fingerprints；先等待固定相机 residency 收敛。前期未收敛快数字不作 Before。
