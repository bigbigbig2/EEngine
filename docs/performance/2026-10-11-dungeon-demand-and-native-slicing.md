---
id: performance/dungeon-demand-and-native-slicing-2026-10-11
state: current
verifies:
  files:
    - OEngine/src/gpu/GeometryPageDemandAbiV1.ts
    - OEngine/src/gpu/GeometryPageScheduler.ts
    - OEngine/src/gpu/GeometryPageStreamingRuntime.ts
    - OEngine/src/gpu/GpuNativeMaterialScene.ts
    - OEngine/src/shaders/native_surface.ts
    - OEngine/src/shaders/vsm_receiver_demand.ts
    - OEngine/src/render/vsm/VsmReceiverDemandPass.ts
    - examples/demos/14-integrated/dungeon-warkarma-texture-compression/main.ts
    - examples/demos/14-integrated/dungeon-warkarma-texture-compression/vite.config.ts
    - validation/tools/run-dungeon-performance.mjs
    - validation/tools/dungeon-gpu-audit.mjs
    - validation/tools/vsm-receiver-statistics.mjs
---

# Dungeon：Demand 单次解码与 Native 成本切片

本轮完成一个生产优化单元，以及 Native/VSM 的诊断设施；没有修改生产 shading、PCF、FSR、Loader 或容量预算。Before 接受 [2026-10-10 报告](2026-10-10-dungeon-warkarma-performance-report.md)，没有重新跑 Before。起始 HEAD 为 `46c054855ce6fb330d6bce3efe7cc5e2e0d18b73`；数据采集于修改后的工作区，以每套 raw 的 source fingerprint、build hash、sourcemap 为实现证据。

全部原始数据、失败、截图、CPUprofile、传感器及分析保存在 [.local/validation/dungeon-canonical-demand-2026-10-11](<D:/code/EEngine - 副本/.local/validation/dungeon-canonical-demand-2026-10-11>)。`after-1/2/3` 是三个独立 Chrome 的生产 After；`native-A…G-cadence4` 是有效切片数据；`vsm-statistics-fixed` 是固定相机的统计数据。GPU 作业串行，没有删除异常值。

## 1. 生产 After 与 Before

【实测事实】GTX 1650 Ti、输出/内部均 1920×1080、renderScale=1，保持 VSM high、4×4 PCF、半径0.75、FSR、jitter、HZB、cone、原材质/曝光/太阳及近景相机。Dungeon 自身覆盖90.657–90.703%，invalid key=0；shadedPixels=2,073,600；实际 MeshletWork 队列605。旧报告计数窗口601、暂停队列601–605，本轮605落在原范围内；不能把不同 jitter 窗口的601与605声称逐帧完全相等。驻留1,207页、pinned381、retiring/eviction/reload/thrash/failed均为0。Before/After近景截图目检没有几何、阴影或材质行为变化；没有做 Dungeon 截图逐像素 bit-exact 验证。

| 指标 | Before（既有报告） | After（三个独立运行） |
|---|---|---|
| GPU command span P50 | 多轮约19–23ms；主基线20.973ms | 21.069/21.703/21.729/21.852/21.375ms |
| 对应 GPU P95 | 主基线41.38ms，明显热波动 | 34.98/44.95/50.40/36.25/23.79ms |
| Native winner P50 | 主基线9.454ms；可比重复轮9.157ms | 9.361/9.583/9.724/9.805/9.468ms |
| Temporal stage P50 | 代表轮5.671ms | 第一套5.785/5.934/5.928ms |
| 独立 shadow stage P50 | 代表轮2.50ms | 第一套2.560/2.611/2.605ms |
| VSM receiver demand P50 | 代表轮1.776ms | 1.788–1.850ms |
| 无timestamp CPU同步render P50 | 1.83–2.12ms | 2.415/2.065/2.010/2.320/2.230ms |
| API live allocation | 2348.30MiB | 2348.30MiB；counter诊断约2348.37MiB |
| API peak lower bound | 约2423MiB | 约2423.4MiB |
| Windows Chrome专用GPU内存 | 约2564MiB | 约2560–2585MiB |
| 引擎面板 allocated | 436.67MiB | 436.67MiB |

【合理推断】生产 GPU 工作未改，时间量级符合 Before；数据不能证明 GPU 加速，也不能将波动归因为本次 CPU 重构的 GPU 回退。89–91°C、thermal slowdown仍活跃，graphics clocks显著波动；Native诊断G中后两轮也升到10ms以上。没有锁频、修改散热或粗暴频率归一化。

CPU同步render不包括全部反馈/DOM/驱动成本。第一套无timestamp正常轮的TaskDuration为3.512s/7.240s、1.692s/6.162s、1.605s/6.151s；Before分别3.279s/7.168s、1.661s/5.160s、1.709s/6.140s；另外两套正常轮2.939s/7.222s、3.152s/7.184s。**没有稳定整帧CPU、TaskDuration或FPS改善的证据，未达60FPS GPU budget。** 提交吞吐不代表实际presented FPS，completion不是GPU执行时间；CPU与GPU不相加，跨pass/跨窗口分位数也不相加。

## 2. Geometry demand 的实际变化

【源码事实】旧链：`GeometryPageStreamingRuntime.consumeCompleted` → `scheduler.ingestDemandReadback` → header+逐entry DataView/unpack+冻结对象 → `ingestDemands` → 再validate → `Map<slot:generation:pageId,object>` → priority sort → persistent operations。随后 `recordResidencyFeedback` 对同一packet再次header+逐entry unpack/validate/对象构造，按原始顺序调用touchPage/recordDemand。

新链：`consumeCompleted` → `ingestDemandReadback` → **一次header/ABI解码和entry合法性检查** → reusable `GeometryPageDemandBatchV1` → scheduler使用`uniqueIndices`、residency使用原序numeric records。每entry四个u32，slot/generation/page全部独立保留；没有将身份打包进浮点number或截断。原始record的次数/顺序保留，residency没有错误地消费dedup结果。两个consumer同步完成后才复用scratch。

关键实现：[ABI/batch](../../OEngine/src/gpu/GeometryPageDemandAbiV1.ts)，[scheduler](../../OEngine/src/gpu/GeometryPageScheduler.ts)，[runtime](../../OEngine/src/gpu/GeometryPageStreamingRuntime.ts)。numeric identity sort → linear dedup → priority sort；同identity最高score胜出、同score首项胜出。最终原有score/slot/page排序和跨generation稳定插入顺序保留，不能擅自新增generation tie-break。只给新建/升优先级的长期scheduler operation物化对象。

删除：第二次ABI decode/validation、raw反馈对象阵列、逐entry DataView、dedup composite字符串/Map、dedup重复validate。**没有删除排序**：新增identity sort，原priority sort变为numeric indices；persistent operation的`generation:page` key、readback复制、readback/frame排序、touchPage、scheduler生命周期仍在。consumer各自的产品generation/slot/页界限检查是不同owner的检查，仍保留。Dungeon scheduler的`deduplicated=0`，收益并非大量重复demand被删；GPU已经有Product-local mask。

【实测事实】CPU sampling inclusive，单位ms/秒profile窗口；各项嵌套，不能相加。Before窗口6.279s，After7.288/7.346/6.379s：

| 调用链 | Before | After #1 / #2 / #3 |
|---|---:|---:|
| consumeCompleted | 91.58 | 52.67 / 54.27 / 52.53 |
| ingestDemandReadback | 42.82 | 21.70 / 20.59 / 21.34 |
| recordResidencyFeedback | 40.90 | 14.56 / 18.04 / 14.71 |
| 旧deduplicate / 新numeric deduplicate | 29.34 | 17.79 / 16.60 / 15.14 |
| 全局GC sampling | 10.02 | 6.70 / 6.94 / 7.13 |

consumeCompleted原始inclusive575.032ms → 383.862/398.662/335.083ms。**支持局部CPU链成本下降**；归一化值不是相同packet的加速百分比：窗口、实际反馈次数/entry数量未独立计数。没有allocation byte profiler；GC下降只是相关证据，不能全部归因于这一个改动。After JS used heap约182–219MiB；第一套full-1 Chrome总working set1796.8MiB、private commit3893.2MiB（包含多进程，非JS heap，非GPU显存）。

Cost Card：删除O(N)对象/字符串/Map及第二遍16N字节ABI读取；新增16N字节numeric复制和两组4N索引scratch，约24B/容量entry、几何增长后复用，仍有少量subarray/header对象以及TypedArray.sort内部scratch。GPU bytes/ALU/samples/atomics/barriers/pass/submit均不变。CPU为O(NlogN + UlogU)，不是宣称线性去重。最佳大量usage/重复反馈时避免物化；本场景无dedup仍获局部收益；最坏全unique大packet多一次sort，可能回退。break-even是删除解析/对象/hash的成本超过numeric复制+额外sort，不能由“Map慢”推导普遍收益。

最小验证：200个seeded packet与旧string-Map oracle对照raw/dedup/ordering；高位u32、未对齐视图、保留同priority顺序、scratch复用、非法/截断/overflow、stale、retry/abort；runtime原始usage/miss multiplicity与顺序、失效publication、错slot/gen/page；既有eviction/reload/迟到结果/device loss/map failure检查未删除。最终新鲜build:test上Geometry34项加ABI4项通过；另外从起始HEAD临时编译真实旧ABI/scheduler，仅放`.local/geometry-replay-reference`，旧scheduler与新packet路径的read/retry/abort/stale决策对照3项通过。生产没有双实现。

## 3. Native 切片：测到了什么

【源码事实】`GpuNativeMaterialScene`在publication准备阶段选择variant；`native_surface.ts`生成固定WGSL。只有`EENGINE_PERFORMANCE_DIAGNOSTICS=1`构建读取`nativeCostSlice=A…G`；普通构建唯一默认G，没有逐帧GPU切片分支，没有改变bins、dispatch或FrameGraph。runner检查实际编译shader的slice标记，并拒绝timing运行中出现VSM统计buffer。

每slice同相机、1080p、每轮固定240帧、GPU每4帧采1次、三轮各60个完整Native timestamp。聚合该帧所有同名winner shading pass，**不包含bins classify/init**。47个After/Native/两套统计capture的相机审计中，只有第一次VSM统计第三轮偏移；全部生产After、A–G切片及重采统计相机均一致。

| 累计variant | Native P50三轮（ms） | P95三轮（ms） |
|---|---|---|
| A：winner、geometry reconstruction/interpolation | 2.286 / 2.404 / 2.478 | 3.003 / 4.516 / 5.015 |
| B：A + required inputs/explicit derivatives | 2.718 / 2.914 / 3.150 | 3.662 / 6.308 / 3.533 |
| C：B + material samples/evaluation | 3.504 / 3.693 / 3.817 | 4.174 / 6.555 / 6.962 |
| D：material + mapped basis/BRDF，单位白光incident | 3.749 / 4.157 / 4.051 | 4.220 / 6.308 / 10.342 |
| E：D +真实IBL | 5.699 / 6.219 / 5.880 | 9.698 / 14.111 / 15.251 |
| F：完整material/BRDF/IBL/真实Sun，省去Sun VSM | 6.202 / 5.992 / 6.302 | 11.876 / 12.036 / 9.605 |
| G：完整生产Sun + VSM query/当前PCF | 9.460 / 10.948 / 10.627 | 18.247 / 13.413 / 45.594 |

**这些variant是差分定位数据，不可以简单逐项相加，也不是七段互不干扰的生产pass时间。** A–C不能真的只写固定值，否则compiler会DCE reconstruction；它们用dependent anchors消费所需corner/input/output，引入额外ALU和liveness。D去掉anchor，增加mapped basis、材料构造和共享BRDF；D/E使用单位白光，F换成真实Sun incident，不是“再加一次BRDF”。本Dungeon authored local lights=0；这些边界不等价于任意有local lights场景的完全隔离cost。

【合理推断】A/B/C说明几何和材质也有真实成本；E比D明显较重，但不能精确宣布IBL单独耗时某个差值。F−E第二轮是负值，应原样承认热状态、代码生成/liveness及incident替换影响。F→G三轮P50差3.258/4.956/4.325ms，定位到Sun中的VSM分支；包含projection/page lookup、fine/coarse fallback、bias、PCF及寄存器/编译变化，**不是纯16tap fetch费用，更不是优化一定能收回的毫秒数**。没有硬件occupancy/spill/L2/DRAM计数。

【源码事实】center/x/y分别使用weights、weights+dx、weights+dy。`native_geometry_input`源码含position/normal/tangent正交化；lighting center随后再取position/normal/tangent/basis。语义kind是常量，compiler可能inline、DCE、CSE；源码重复不能证明物理执行重复。手工保留中间值可能增加live registers/spill并降低occupancy。本轮只记录候选，没有实施此重构。

切片Cost Card：默认G不新增GPU产品/dispatch/访问；A–F只诊断改变shader主体和输出，会改变寄存器和后续Temporal输入，因此只比较Native自身timestamp，不拿整帧差值当组件成本。CPU仅publication/compile时选variant；预热后计时。诊断benefit是归因，没有生产性能收益claim。

复现诊断：PowerShell设置`$env:EENGINE_PERFORMANCE_DIAGNOSTICS='1'`后`npm --prefix examples run build:dungeon`；串行执行`node validation/tools/run-dungeon-performance.mjs --near --headed --native-slice A --gpu-sample-interval 4 --scenarios full-1,full-2,full-3,counters --frames 240 --out <新的目录>`，A逐个换B…G，随后`node validation/tools/analyze-dungeon-performance.mjs <目录>`。VSM仅统计则用`--native-slice G --vsm-demand-diagnostics --scenarios normal-1,normal-2,normal-3`，绝不混入timing数据。结束删除该环境变量并重建普通Dungeon。不要覆盖旧目录。

## 4. VSM 请求重复率

【源码事实】receiver predicate/projection由生产WGSL原文specialize，helper early-return位于barrier之前；原global atomicOr仍每有效receiver执行。每8×8 workgroup记录raw、unique page、unique bitset word及duplicate；所有group包括空/边界group完整写入。268B workgroup memory、2个uniform barriers、每group16B写入，1080p诊断输出518,416B；逐lane比较最多2016对/group，另有workgroup atomics。此诊断存在真实开销，**不能用它的GPU timing证明aggregation收益**。普通构建无buffer/binding/计数；性能采集关闭统计。

统计只在暂停后借用已有audit copy submit读回，不能控制本帧GPU work。CPU全局unique从requested bitset精确排除mip5 coarse平面（即使与fine共用同一个word）；generation、完整写域、容量和coarse区分均断言。真实GPU oracle用同页/全unique/多word/空group/非8整倍数/连续dispatch reset对独立CPU Set，已通过。

固定相机最终三轮数值见下表（只使用`vsm-statistics-fixed`；首次统计第三轮坐标偏移的raw完整保留，属于条件失败，不能当固定相机样本）。

| 固定相机统计（每帧） | #1 | #2 | #3 |
|---|---:|---:|---:|
| raw requests / global atomicOr attempts | 2,073,600 | 2,073,600 | 2,073,600 |
| 全局unique receiver page | 324 | 326 | 323 |
| 全局unique receiver bitset word | 39 | 39 | 39 |
| workgroup unique page总和 | 38,965 | 38,942 | 38,956 |
| workgroup unique word总和 | 36,168 | 36,153 | 36,154 |
| workgroup page重复率（按request加权） | 98.1209% | 98.1220% | 98.1213% |
| workgroup word重复率（按request加权） | 98.2558% | 98.2565% | 98.2565% |

每帧32,400个active workgroup，每group raw64；平均unique page约1.202、word约1.116，完整histogram与各group原始记录在raw；coarse fallback plane另外114页，不混入receiver unique。raw包含Dungeon和其他真实receiver，模型自身覆盖率另外按instance分类，不能用raw证明Dungeon覆盖。统计是三个暂停帧快照，不是逐帧全窗口分布，也不是运动场景证据。

【合理推断】大量重复global atomic attempt确实存在，支持workgroup aggregation假设；不等于receiver约1.8ms主要都在atomics。world reconstruction、projection/clip选择、geometry flags及访存仍保留。按word汇聚后的global attempt下限约36K，而不是全局39次；跨workgroup去重需要另一个机制。只有无instrumentation的同条件实现对照才能判定它是否赚钱，本轮不做aggregation。

## 5. 内存与加载：确认，未顺便重构

【源码事实】示例`main.ts`仍显式1536MiB几何配置，`cooked-scene.ts`协商HighEnd四个384MiB bank、128MiB metadata，共1664MiB。slot/page=256KiB、容量6144物理slot。1,207逻辑resident page占1,224物理slot=306MiB：`VirtualGeometryResidency.#pagePhysicalBytes/#writeResidentPage`会为resident attribute扩展保留extra slots，不能直接1207×256KiB当完整驻留。

【实测事实】累计上传28.97MiB；当前无evict/reload时可作为低payload密度的证据，**不是普遍可替代live payload的指标**。306MiB slot占用约19.92% bank容量，累计上传约9.47% occupied bytes。atlas64MiB、identity双缓冲63.28MiB、FSR history/瞬态池及纹理array均在独立API账本；引擎面板仍漏geometry等owner。这是预算/统计owner及固定page碎片问题，Canonical重构没有解决它。

后续独立任务先做平台预算+scene pinned/working-set需求协商，保留retirement/upload峰值余量与完整overflow行为，再考虑packing。旧报告512MiB实验证明该固定场景的容量余量，不证明任意复杂/运动场景都适用。此次不同时改默认预算或variable-page allocator。

【源码事实】`cooked-scene.loadCookedScene`逐Product await读取/打开纹理，再逐geometry pack加载；纹理读整包，几何`OegPackRangeSource`按metadata/page Range，bootstrap逐页读取/验证/上传。`TextureProduct.openTextureProduct` → `openRuntimeAssetPackageV2` → `RuntimeAssetPackage.openRuntimeAssetPackage` section SHA256 → `RuntimeAssetManifestV2` chunk SHA256 → `TextureProduct.validateTextureProduct` mip SHA256：同payload存在section/chunk/mip三层扫描及digest输入复制。**package content identity哈希的是section描述/digest等metadata，不是又完整扫描一次包payload。**

几何链：`OegPackV3.readPage` compressed CRC → LZ4到256KiB → decoded group/identity validation → whole-page SHA256；`OegPackProductRevisionSource.readPage`再slice复制；scheduler `produceOrRead`校验descriptor identity/whole-page hash，再slice留存，residency准备resident attributes并上传。compressed CRC、rolled-up page identity与whole-page hash语义不同，不能因“重复hash”直接删必要检查。管线prepare/resolve、上传与firstUseful队列完成仍在加载链；本轮没有独立新loading CPU profile，不能宣称加载改善。

`cooked-scene.ts`返回的`settled: async()=>{}`仍为空；main的`fullQuality/fullGeometrySettled`是加载/全mip流程flag，不是所有几何streaming demand settled。实际settlement应另查scheduler.pending/inFlight/verified、resident/retiring及publication状态，本轮没有改flag含义。

## 6. 下一完整单元与验证边界

**下一完整优化单元推荐：保持16个逻辑tap/权重的VSM PCF整数texel精确去重，限定在现有native Sun采样链。** 本轮不实施。它比先手工缓存center basis更有直接删除工作的依据，也不需要新产品/history/cache/submit；receiver aggregation有数据支持，但另开后续单元。

【源码事实/数学推导】`vsm_sample_page/vsm_atlas_texel`默认taps4、filterWidth=1.5，单轴offset为−0.5625/−0.1875/0.1875/0.5625；floor后通常仅2–3个不同整数texel，Cartesian为4–9个，而仍执行16次textureLoad。可按单轴单调坐标run-length计算重复次数，读取每个unique texel一次，visibility以原tap multiplicity加权/16。保持原floor运算次序、gutter clamp、reverse-Z的stored>0/比较、reference+bias、query及全部identity/fallback。半径0时甚至只需1个unique；半径3时可能16个，不能仅适配默认半径后悄悄改变其他设置。

候选Cost Card：默认可以删除7–12次**逻辑textureLoad**及重复坐标ALU；每load是4B深度返回，原64B/调用、unique16–36B/调用，不是DRAM传输字节预测，cache可能已经命中重复地址。新增两轴<=4坐标/计数、分组/权重ALU和live registers；samples的数学权重不变，无storage、atomics/barriers/dispatch/CPU分配/working-set产品增加。最佳重合坐标；通常默认足迹4–9unique；最差16unique，额外ALU/register tax可能更慢。break-even：省掉的load/地址计算成本大于分组+寄存器/occupancy损失。F→G约3.26–4.96ms差仅是整条VSM分支定位范围，PCF方案收益必须低于可删除工作的实际成本，不能许诺这些毫秒数。

建议实验（尚未运行/实现）：只替换PCF整数访问组织。先CPU/WGSL oracle遍历taps1–4、半径0–3、f32 rounding边界、atlas/gutter、正/负reference、clear0、fine/coarse/missing/stale/dirty、generation，原16tap作为测试oracle而非第二生产路径；逐像素visibility/HDR与生命周期语义等价。然后固定本报告相机/1080p/画质，在同一热状态范围交错重复完整G的Before/After，统计Native/Total P50/P95及全部原始尾部、相机/coverage/shadedPixels/meshlet/page工作、CPU及RAM/VRAM；关闭统计。若Native未稳定下降或尾部回退，不能以“textureLoad数量少了”宣称成功，回到编译/liveness和寄存器证据。

参考研究：Filament（Apache-2.0）revision `f840f1e6aa65ec915f6bc8a2c67869f5ad631e35` 的 [surface_shadowing.fs / ShadowSample_PCF_Low](https://github.com/google/filament/blob/f840f1e6aa65ec915f6bc8a2c67869f5ad631e35/shaders/src/surface_shadowing.fs#L31)真实用4个硬件comparison-filtered fetch重建3×3 Gaussian。其kernel/比较/过滤与EEngine当前16个point-load box不同，不能直接移植称为同画质；本建议是本地精确坐标/权重推导，**Reference only，未adopt代码**。WebGPU comparison sampler/gather不是任意point-load重复合并的自动等价替代。

实际验证：engine/Dungeon typecheck、engine build、诊断/普通Dungeon build、fresh build:test及上述57项针对性Node测试、旧scheduler replay3项、VSM reduction GPU oracle与现有Native production numeric/update/abort/retry/resize oracle通过；后者是普通Scene native correctness closure，不能当全部streamed VG验收。没有重新跑全Renderer画质/运动benchmark或证明60FPS，也没有寄存器/occupancy硬件采样。最后恢复普通构建，默认诊断关闭。

保留失败：早期replay测试导入TDZ、诊断define不合法、测试geometry semantic写错、tests与build:test并行导致临时模块缺失、首轮Native provenance hook放错、逐帧采样耗尽120个full capture导致coarse（非shader漏工作）、首次VSM统计第三轮相机偏移。原log/raw未覆盖。runner现断言完整Native窗口，并在落盘之后验证相机；performanceCapture断开交互输入而保留controls.update。普通构建既有codec externalization/chunk-size warning保留，不作为测试通过掩盖。没有承诺未运行的pixel-exact Dungeon检查。
