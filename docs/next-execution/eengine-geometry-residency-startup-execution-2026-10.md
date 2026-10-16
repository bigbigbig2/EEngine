---
id: eengine-geometry-residency-startup-execution-2026-10
state: current
verifies:
  files:
    - docs/next-design/eengine-geometry-residency-startup-2026-10.md
    - OEngine/src/gpu/GeometryProductBytePool.ts
    - OEngine/src/gpu/GeometryProductGpuAbiV1.ts
    - OEngine/src/gpu/GeometryProductMultiRuntime.ts
    - OEngine/src/gpu/VirtualGeometryResidency.ts
    - OEngine/src/gpu/PipelineCompilationQueue.ts
    - OEngine/src/gpu/PreparedPipeline.ts
    - OEngine/src/gpu/GPUDatabase.ts
    - OEngine/src/gpu/GPUDescriptorCaches.ts
    - OEngine/src/gpu/GpuNativeMaterialScene.ts
    - OEngine/src/gpu/GpuRenderWorld.ts
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/shaders/virtual_geometry_product.ts
    - OEngine/src/shaders/geometry_source_decode.ts
    - examples/demos/14-integrated/shared/cooked-scene.ts
    - validation/tools/run-geometry-startup.mjs
    - OEngine/tests/contract/geometry-compact-capacity.test.mjs
    - OEngine/tests/oracle/native-surface-production-gpu.mjs
    - OEngine/tests/oracle/product-attribute-decode-gpu.mjs
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
---

# 几何紧凑驻留与首帧准备：执行计划

> 后续方向更新（2026-10-17）：本文保留本模块已实现合同与原验证结果；正文中的“下一模块/Local Probes边界”仅指当时停止点。当前模块由workstream导航至[Surface Cache GI设计](../next-design/eengine-surface-cache-gi-2026-10.md)与[执行](../next-execution/eengine-surface-cache-gi-execution-2026-10.md)，不再据旧停止点启动传统GI路线。

唯一目标依据为[设计](../next-design/eengine-geometry-residency-startup-2026-10.md)。基线`17252477`；2026-10-16已按用户后续授权完成GRS-1/2/3及集中返工，实际结果与剩余资格见§8。模块只设三个工程单元，GRS-1包含一次完整地址/容量切换，不能把其中临时断链提交成稳定的双ABI生产状态。

## 1. 顺序与状态

| 单元 | 状态 | 完成边界 |
|---|---|---|
| GRS-1 紧凑几何驻留闭包 | 已实施并完成单元检查 | 完整OffsetAllocator移植、目录容量计划、ABI6、四bank与metadata增长、所有直接consumer与退休闭合；删除固定槽生产依赖 |
| GRS-2 准确异步准备与首帧门槛 | 已实施，单元检查见§7 | 真实feature/scene PSO async准备与生产requirePrepared同源；首次图/编码/提交分段诊断；保留正常帧事务和UI响应 |
| GRS-3 集中验证与文档核对 | 已完成，结果与边界见§8 | 新鲜build与串行GPU、两场景同质量启动/收敛、容量/生命周期/成本复核；按实际事实更新domains与来源状态 |

实施中只更新本文件的状态和实际结果。完成后停在模块边界，Local Probes仍需用户另行启动，不自动恢复F11资格。

## 2. GRS-1：紧凑驻留、容量与地址一次切换

开始前再读当时源码和近目录约束，以`vibe context`导航；不得把本计划的基线事实当成永不变化的源码。为ABI/allocator选择清晰命名，旧V1文件名可改，但不能留下slot适配器让两种物理地址并存。

实施范围按同一个闭包推进：

- 将固定MIT revision的SmallFloat、两级bins、split、双邻居coalesce和node freelist完整移植到TypedArray；保留来源license/映射。加入16B unit wrapper与明确的扩尾grow适配，记录node/CPU容量。外部碎片和node耗尽分别诊断，不引入线性free-list后备算法。
- 目录前缀规划与读取后验证共用数值定义；保留逻辑Page字节、完整hash、LZ4和页内offset。页lease覆盖预留、读取失败、上传、unpublished、active、revocation、retiring。IO credit仍计实际读取/解压，GPU allocation credit改计align16前缀。
- 初始bank由目录需求/headroom/真实budget计算；metadata由逐section计数/stride和replacement重叠规划。先CPU模拟pinned admission，能力检查在createBuffer前完成；demo去掉固定bank/metadata分配，但不修改最终几何/纹理质量。
- ABI5→6一次切完pack/validate/header/lookup、VG、frame geometry与cached source address、Visibility/MASK、Surface、VSM；保持bank低30bit地址界限和完整generation。删除resident-directory/slot命名旧生产字段和硬编码乘256KiB的物理统计。
- 四bank等大扩容保持活页offset；metadata扩section保持record index；候选copy、所有runtime binding epoch、bind groups与缓存地址同一帧切换，abort恢复、retry和device恢复闭合。device ledger包含新旧峰值，所有release等待实际last-consumer fence。没有预算则等待/明确失败，不能超配或私有submit。
- 保留当前延迟几何需求与VSM完整页调度。allocation失败依现有冷页淘汰/fence/retry，记录不可服务状态；不无限thrash，不逐出pinned，不漏掉VSM shadow caster才声称内存够用。

中间最小检查：typecheck及allocator/ABI的targeted Node。allocator用独立interval model验证不重叠、exact length、释放后完整恢复；覆盖donor SmallFloat边界、split/两侧合并、满池/node耗尽、随机固定seed trace、扩尾及u32边界。来源trace用固定donor向量；有可用native compiler时跑相同trace对照，平台无法运行须记录而非伪称通过。零长度拒绝为本地适配，不偷改donor数值预期。

GRS-1提交前做一次architecture review：四bank bindings无遗漏、地址缓存epoch一致、CPU与GPU范围检查同义、abort不暴露candidate、retirement不提前、budget不漏双峰。构建新闭包期间可暂时断链；稳定边界只留ABI6一套生产ownership。集中场景/GPU留GRS-3，不每patch跑整套。

## 3. GRS-2：准备准确的生产管线

先用实际首帧调用列出owner/descriptor首次miss；确认现有Appearance/native raster与SSSR已经异步准备的范围，不能重复归因。补齐ComputeCache async prepare/in-flight/epoch/requirePrepared，与RenderCache保持同源key；对共享credit、失败清理/显式retry、晚到旧device resolve做小范围测试。

对真实启用的HZB、VSM、AO、Surface、Temporal、Bloom/Present、Environment等逐owner拆出可复用descriptor生成，prepare与production消费同一对象。实际名单以代码盘点为准，不造通用EffectsManager/compiler，不遍历仓库编译所有variant。依赖scene的继续使用当前material/native ready；新增准备与已有准备共享有界并发，不增加第二个16路洪峰。

Renderer/scene readiness必须在进入帧事务前完成，未ready期间不推进history。feature变化先prepare candidate，成功后正常边界切换，失败暴露错误并保留当前profile；resize/cut只按实际描述符需求工作。生产首帧不允许同步cache miss fallback。device loss整代失效及恢复重新gate；清掉重复无用NativeVisibility模块构造。

加入低开销诊断：navigation/bootstrap、目录、mandatory几何/coverage/VT tail、PSO queue/active/completed/cache miss、scene/view prepare、首次graph lower、encode、finish、submit、GPU完成、firstUseful和当前视图settled。区分CPU wall time、GPU timestamp和queue completion；普通帧不遍历全部descriptor或累积无限event。不得用UI“ready”时间替代首个真实completed frame。

中间检查为typecheck、必要shader编译及准确descriptor/epoch/readiness小测试。不伪造scene bindings预跑FrameGraph、不dummy draw、不额外GPU submit、不迁移GPUDevice Worker；Worker只保留现有CPU准备。新增PSO与binding在prepare前进行真实limits检查。

## 4. GRS-3：集中验证、测量与返工

先完成GRS-1/2的architecture review，再集中：

1. `npm --prefix OEngine run typecheck`、`npm --prefix OEngine run build`、新鲜`npm --prefix OEngine run build:test`；运行受影响几何/驻留/publication/ABI/descriptor Node测试与必要既有语义测试。旧表示断言随ABI退休，数值/生命周期断言保留。全仓库无关测试不成为每个patch的门禁。
2. 串行真实GPU检查：新byte offset/payload边界、最后可用地址、非resident/stale generation；相同原始Page经CPU独立解码与新生产读取的position/normal/UV等对照。覆盖Main opaque/MASK、Surface与VSM caster；不能只跑测试专用shader后宣布接通。保持既有数值容差，图像差异先分类定位。
3. 生命周期少量确定性场景：多runtime共享pool、pinned admission失败、小初始容量增长、metadata单section溢出增长、node耗尽、碎片但总空闲足够、replacement、release/reload、abort/retry、dispose/device loss。通过可控小预算触发，不靠几十分钟压力跑；正常帧与增长帧均检查唯一writer和fence后再用。
4. **Bistro与Dungeon完整场景**，同1080p/质量/AO/SSSR/Temporal/VSM/VT设置，不缩最终场景。冷HTTP/应用缓存与暖HTTP/新device分别注明，driver cache不可控时如实标注。每条件至少3次诊断启动，报告每次及范围，不将3次称正式P95资格。记录首completed、UI长任务、真实view-settled与稳态短窗口，并保留原始日志。GPU作业串行。
5. 成本表分别列raw payload/allocated intervals/bank buffers/metadata/allocator CPU/active+unpublished+retiring峰值，读取与上传字节、几何/VT在途、VSM work与overflow、PSO prepare/miss和CPU/GPU时间。资源减少与速度改变分别陈述；没有提速或有回退必须解释，不能以显存减小冒称启动改善。

通过标准是正确产品、完整consumer、生命周期与容量边界可运行且成本有界；没有预设“必须快N秒”的伪阈值。若startup只是把等待挪位置、增长峰值导致压力、稳定帧新增明显热路径税，先按诊断归因返工，再重跑受影响检查；不能降质量或恢复固定槽掩盖。若容量不足导致真实目标场景无法收敛，模块未完成，不能当成正式性能资格延期。

最后逐节对设计核对遗漏；更新已实现domain事实、porting来源映射/真实adoption级别、粗执行模块结论。运行`node tools/docs-verify.mjs`、`node --test tools/tests/document-system.test.mjs`、`git diff --check`；旧失败保留身份，未跑的必需验证明确未完成。提交中文标题与实际范围/验证，不将未测2060结果推广为4GB支持。

## 5. 本轮设计交付记录

已检查上述源码的分配/地址/publication、metadata布局/relocation、Cooked目录时序及pipeline cache/初始化调用。已研究固定OffsetAllocator完整核心源码、测试和MIT license，以及固定WebGPU规范pipeline创建语义。选择精确区间与同源async准备；没有新增生产文件、资产格式、GPU提交或运行新性能实验。

本轮文档检查：`docs-verify`为0 findings / 81条既有history warnings；document-system 7/7通过；VirtualGeometryResidency的context只返回本模块唯一设计/执行一对，`git diff --check`通过。未运行engine build、browser或GPU，因为本轮只有文档/导航变化。实现与source adoption仍未开始。

## 6. GRS-1 实施与核对（2026-10-16）

设计先提交为`ff491dc7`。本单元一次切换为ABI6并删除GeometryProductSlotPool，无旧物理slot decoder/adapter。

- 完整移植固定OffsetAllocator SmallFloat、32×8 bins、split、双邻居coalesce和node freelist；TypedArray SoA、checked lease、16B单位与稳定扩尾为Local。原源/license/SHA及native trace保留在tests/oracle/reference/offset-allocator。默认65536 leases的四allocator元数据约18.5MiB，最大配置由80MiB CPU限额约束；正常分配最多查四bank，不逐页线性搜索。
- GeometryPagePayload统一目录容量与读取后payload数值定义；activation在IO前整体预留，IO失败/取消/销毁/迟到结果释放一次。页读取继续并发，只串行容量与metadata range准入。完整256KiB hash/LZ4/Worker和格式保持；GPU只分配/上传有效前缀。demo等已并行打开目录后规划四bank与逐section metadata，不再固定128MiB metadata。
- ABI6四word为bank+flags、byte offset、完整generation、payload bytes；header word12为实际bank bytes。CPU/WGSL检查保留位、对齐、容量减法边界和Group有效前缀。四bank仍是原生产binding数，最大1GiB/bank，页内offset和Cooked逻辑Page不变。
- bank候选由普通帧encoder复制旧bank到相同offset；metadata按section复制、record index不动。未暴露binding前可由CPU权威记录重建metadata；暴露后增长必须通过正常帧。candidate期间冻结上传/metadata修改，pending保留；多runtime listener在copy后发布header。Visibility/graph/Temporal Occlusion保存epoch，VSM随main workset重建，frame geometry重新生成绝对地址。abort恢复旧代、retry新epoch；release/dormant/dispose若冲突则abort未提交帧。
- 新旧bank/metadata都计入真实device峰值；失败fence不退休，永久增长预算不足明确失败且不每帧重复申请。eviction按实际阻塞前缀字节和页数限制，候选冻结不误触逐出；连续120次延迟pump无stage进展仍阻塞会使refinement报告unserviceable，不能伪称settled。pinned与VSM完整页调度不降级。

Architecture review核对了bank/header同帧切换、live binding与缓存epoch、generation与减法边界、abort/retry、预算双峰及最后consumer退休。独立小测试实际读回fake buffer复制内容，未用空copy替代生命周期检查。增长目前复制旧bank完整capacity（四bank合计），非高水位优化；只发生冷增长帧，无逐页GPU dispatch、独立submit或同步GPU控制。

实际验证：typecheck、build、新鲜build:test通过；allocator/ABI/capacity/residency/workload与scheduler/admission/frame-arena相关检查最终合并124/124通过。clang++编译固定donor对照12000步全部决策一致；另有独立12000步interval随机trace含grow。

串行硬件GPU：virtual-geometry-handoff 50用例、virtual-geometry-instance-culling 20帧通过；geometry-budgeted-residency 72帧主/影子需求、lease压力、公平上传、coarse覆盖与loss取消通过；native-surface-multi-product-production真实Renderer的MASK/Native HDR/Temporal/VSM/abort/recovery/release通过（VSM 134 valid pages、50 casters、overflow0）；product-attribute-decode 1024 vertices/20480 components、4bank/32 masks通过，最大误差5.96e-8。Chrome155，adapter报告NVIDIA/Turing；不由此推断精确VRAM或4GB资格。

bootstrap未知catalog若超初始窗口且尚无binding/普通帧，则明确要求先提供完整descriptor目录，不永久等待不存在的首帧。

原失败分类：Node固定slot容量/预算断言随ABI迁移；加载占用槽先等待容量导致挂起、table随section无谓放大、live binding比较漏epoch、未完成activation lease销毁窗口为实际实现问题，已修复并重跑相关检查。handoff首次GPU draw0来自夹具header仍写槽数及旧flags lane，迁到ABI6后50/50通过；未放宽数值容差或减少case。构建保留既有node:module browser externalization提示。

未运行：Bistro/Dungeon完整同条件冷暖启动、三次范围与稳态成本，四bank真实增长后的完整场景画面/成本矩阵，正式4GB/P50/P95/evidence资格；按计划集中到GRS-3。尚不能宣称启动提速秒数或完整模块关闭。本记录结束时GRS-2准确async PSO/首帧gate尚未开始；后续授权实施结果见§7。


## 7. GRS-2 实施与核对（2026-10-16）

开始时GRS-1已提交为`6b069fd1`，工作树干净，因此没有再制造空提交。按用户后续授权完成本单元，停在GRS-3边界；以下是实现与小型真实检查，不是完整场景性能验收。

### 7.1 准备与生产闭包

`PipelineCompilationQueue`按真实GPUDevice共享最多16个进行中job；Appearance、Native raster/cache、SSSR、Frame instance/vertices、Temporal Occlusion、LocalLightWork、VT feedback与固定pass共用这组credit。FIFO只保存实际请求的descriptor，未增加另一个16路编译池、Worker GPUDevice或额外submit。device loss立即拒绝等待与进行中promise；迟到driver结果不能回填cache或prepared owner。

ComputeCache新增async prepare/in-flight/epoch/requirePrepared，与RenderCache各自原normalization/key和native descriptor生成同源；clear撤销旧epoch且旧finally不删除替代job。成功生产只取已准备对象，miss明确抛错。各pass以`PreparedComputePipeline/PreparedRenderPipeline`保存同一个准确native descriptor，不维护warmup专用shader/常量。失败保留给调用者，显式retry才重新准备；未把异步耗时误计为pipeline API hostCallMs。

| 实际owner/profile | 准备及生产消费 |
|---|---|
| Geometry/Visibility | ordinary或Product只准备实际顶点profile；main无raster expansion；previous-HZB、Product late recheck按实际启用，shadow独立wavefront。Shadow bounds/tile pipeline按device/profile复用，workset替换不触发首用同步编译。独立oracle按真实PreparedWork选择wavefront/fused leaf/expansion，没有全variant预编译 |
| Native Material/Surface | 原Appearance/native异步准备继续保留；main raster先准备，实际lit Physical Sun/VSM启用后再准备shadow。NativeVisibility删除每次生产调用的无用module/layout构造；ExecutionBins/Partitions共享descriptor/layout生成，encode只requirePrepared。背景只在无bin时准备 |
| AO/Temporal/Present | AO只选实际quality、denoise终级/中间级，生产不准备被裁剪的pack；Native与FSR按实际policy准备，classification只在upscale/相关debug需求中准备。FSR luma pyramid按真实extent选择levels；Bloom、曝光启停及Present/debug选实际分支 |
| Environment/VSM/lighting | LUT/IBL/Sky/Aerial、VSM demand/allocate/caster/invalidation/atlas/sampling完整闭包；显式layout不依赖假binding。LUT auto-layout bindings在准备完成后首次真实record创建。灯光存在时准备GPUDatabase真实scatter-upload descriptor；生产LightDatabase上传requirePrepared |
| SSSR/调试/计数 | 复用原SSSR完整async算法owner并纳入共享credit；inactive/signal/diagnostic debug按本帧有效开关选择，不能由旧owner仍在退休推断需求；一般debug与可选counter使用相同生产descriptor |

Renderer初始化发起device/profile-only PSO准备，与Cooked目录及mandatory IO自然重叠。依赖真实scene/material topology的剩余准备由Renderer在history、streaming camera pressure、profiler及FrameCoordinator.beginFrame之前gate。pending/失败不编码、不推进frame identity/history、不发布candidate；最后成功profile/资源保持，desired设置保留，调用`retryPipelinePreparation(scene)`后重试。此处没有为了继续画帧而自动降级profile。

readiness key只比较固定数量的真实feature/extent及Native publication revision，不在稳定帧扫描/哈希全部descriptor。数值材质publication更换可能需要一次已缓存准备的异步确认tick，未重复驱动PSO编译；这不构成逐材质每帧编译。正常帧仍沿原提交、abort/retry、fence和device恢复路径。

### 7.2 诊断与成本

两Demo报告复用原目录、mandatory几何/coverage/VT tail、材质准备、firstUseful与SceneRefinement，再增加Renderer initialization快照及共同timeOrigin。旧`necessaryPipelinesReadyAtMs`只表示材质准备，保留兼容字段并明确增加`materialPipelinesReadyAtMs`；它不代表全部renderer PSO已就绪。`initializationEvidence(scene)`发布首scene/view prepare、graph lower、encode、finish、submit、实际GPU queue completion及firstCompleted，另含共享queued/active/completed/failed与cache async/sync miss、unprepared use。

queueMs/compileMs是所有job的累计wall观察，重叠期间可大于总启动时间；queue completion包含先前queue工作与通知延迟，均不是GPU timestamp。实际第一份completed frame由正常command.gpuDone成功观察，失败不报completed。SceneRefinement的first-completed/view-settled仍是原真实反馈闭包，不以PSO ready替代画面或流送收敛。

Cost Card：本单元新增GPU buffer/texture、bytes/pixel、ALU、samples、atomics/barriers、dispatch与submit均为0；保留完整已有shader算法。增加的是每准确descriptor一个host handle/promise、队列等待项、每runtime一个最新readiness记录及固定计数。共享活跃编译上界16；descriptor数量随真实独立程序/profile增长，不按材质instance复制。稳定帧增加固定fact key比较和已准备handle读取，不保存逐帧event历史。删除的是生产首用同步PSO fallback及重复NativeVisibility模块/layout创建，并减少未选几何/关闭shadow变体的driver编译；不声明shader module/layout本身完全异步，冷owner创建仍有这项CPU工作。未新增CPU可见性决策、GPU→CPU→GPU控制或dummy draw。实际总启动和长任务是否下降留GRS-3测量。

### 7.3 实际检查与原失败

集中typecheck、生产build与新鲜build:test通过；相关cache、队列、AO/环境、Temporal、FrameProgram、Surface publication与owner Node语义检查通过，确切最终数量见本节末。编译队列测试覆盖跨compute/render/material共享16路、准确descriptor复用、epoch撤销、失败retry、loss立即拒绝及迟到结果。独立Frame vertices检查未选profile不编译，未准备profile在分配前明确失败。

串行真实GPU检查：

- `native-surface-multi-product-production`通过。受检真实Renderer render期间拦截同步createComputePipeline/createRenderPipeline，结果0次；首帧共享queue排空，两个descriptor cache的syncMiss/unpreparedUse均0。实测该小fixture首图lower约15.3ms、scene/view约33.3ms、encode约60.9ms、finish记录0ms、submit约0.1ms，提交至queue completion约173.2ms；是单次诊断观察，不是Bistro/Dungeon或GPU timestamp。VSM 134 valid pages、50 casters、overflow0。注入AO medium编译失败，检查frame/history/Seed/committed AO与Native publication均保留、错误不自动消失，显式retry后恰好提交一帧；另保留MASK、HDR、native/upscale、abort/retry、recovery/release原检查。
- `sssr-production`通过：完整原算法的Native base/coat与unlit、能量、设置/debug、abort/resize、native/FSR、empty、Product MASK、1080p资源边界及受控loss恢复；没有放宽数值容差。
- `local-light-work`通过：独立灯光消费者先准备同源GPUDatabase scatter PSO，再执行原灯光调度/完整列表GPU对照。
- `geometry-budgeted-residency`通过：72帧主/影子需求、lease压力、公平上传、coarse覆盖与pending loss取消，使用显式异步准备后的真实Geometry/Shadow consumer。

硬件adapter报告NVIDIA/Turing，Chrome155；用户机器信息为RTX2060 8GB，adapter未暴露精确型号/VRAM，不把该结果推广为4GB资格。

原失败及修复：初轮Node有独立Seed/环境夹具仍依赖构造时同步编译，迁移为显式await并保留原语义断言；LUT替换检查还发现旧Sky缓存持有已退休LUT身份，现于成功commit撤下不匹配缓存并在覆盖fence后释放，abort保留旧角色。SSSR关闭且仍显示debug时误按退休owner存在与否准备分支，改为真实有效开关并进入readiness key，重跑通过。增加同步PSO拦截后原GPU失败为`Production render synchronously created`，调用链为Renderer→GPULightCollection.build→GPUDatabase.encodeElementUploads→ComputePipelineCache.obtain；补齐准确scatter准备与production requirePrepared后通过。未吞异常、恢复同步fallback、降低画质或删减难case。

未运行：Bistro/Dungeon各条件3次完整同质量冷/暖启动、长任务/收敛/稳态窗口、几何增长完整画面成本矩阵及正式P50/P95/4GB资格。它们由GRS-3承担；本单元不能宣称提速N秒、两场景已收敛或整个GRS模块完成。

最终单元检查：新鲜build:test后上述相关Node合并109/109通过，变更的25份MJS语法检查通过；typecheck和生产build通过（保留既有node:module browser externalization提示）。docs-verify为0 findings / 81条history warnings，document-system 7/7，git diff --check通过。完整场景与GRS-3状态保持未运行/待启动。

最后几何profile准入/loss发布复核后，新鲜build:test、队列与Frame vertices 9/9及真实Native production再次通过，syncMiss/unpreparedUse仍为0，失败保留与显式retry仍通过。该次小fixturelower约8.3ms、scene/view约22.2ms、encode约38.9ms、queue completion约140.4ms；与上次仅是两次诊断观察，不能当作更改前后性能比较。

## 8. GRS-3 集中复核与返工（2026-10-16）

从已提交的`6f9b7865`开始集中验证，没有另造GRS-2空提交。Architecture review再次核对唯一ABI6、全部四bank绑定、generation/有效前缀减法边界、metadata index与绝对地址epoch、候选冻结/abort/retry、共享预算双峰及最后consumer fence。没有保留固定槽适配器、私有submit或同帧GPU→CPU→GPU控制。

### 8.1 实测发现的准备重复与修复

原Native材质预准备固定从反射off开始，即使Renderer已启用SSSR。真实scene发布后才请求`sssr-base-coat`，导致整套Native输出重新准备。修复前六次Bistro的首completed为19.79–22.36s；其中bootstrap到首次scene准备仍有明显等待。该诊断样本保留在`.local/validation/grs-3/`，修复前Dungeon正确配置样本在`.local/validation/grs-3-dungeon/`，不能混入修复后数据。

现在Renderer按实际SSSR设置与lit材质需求，向`GpuNativeMaterialScene`初始snapshot直接传入准确reflection profile。虚拟材质提前准备与四个scene上传/append/replacement入口一致，运行期profile变化继续走原candidate事务。SSSR owner自身仍由真实已发布scene需求创建和退休；没有把后台材质准备变成effect lifetime owner。未增加GPU pass、逐像素工作、submit、shader算法或资源ABI。新增Node与真实SSSR Product检查确认初始就是目标profile，重复设置同profile不会产生candidate重编译。

### 8.2 独立语义、真实消费者与生命周期

- 相关Node最终合并157/157通过。新增pinned全目录在GPU allocation前失败、四bank外碎片但总空闲足够时拒绝连续分配、相邻释放后合并成功、metadata仅page section增长且其他capacity/旧record保持；保留allocator随机/native trace与原publication/abort/retry语义。旧Native场景夹具漏报WebGPU baseline的workgroup storage limit导致五个失败，补齐真实limit后原断言通过，未放宽检查。
- 原始完整256KiB Page经真实MultiRuntime/Residency验证、分配并上传176B有效前缀，独立CPU从同一原字节解码position/oct normal/half UV，与production WGSL属性读取比较：3顶点最大误差5.224e-8。原1024顶点/20480分量/四bank/32 masks检查保持，最大误差5.961e-8。真实residency需要协商16 storage buffers；首次仅请求默认8的宿主失败保留，修正宿主limits后通过。
- geometry-budgeted-residency通过40个地址边界（每profile四个合法及stale generation、nonresident、reserved bits、misalignment、past-end、u32 wrap六个非法）与原72帧Main/Shadow需求、lease压力、公平上传、coarse coverage和loss取消。
- 真实Native Renderer在bank增长中注入Surface abort，确认旧epoch/binding恢复后正常retry；随后第三Product触发metadata搬迁。Main opaque/MASK、Surface HDR与VSM均真实消费新绑定；固定jitter下bank/metadata增长的HDR最大差均为0，保留原0.002容差。增长帧强制真实shadow invalidation，VSM分别134有效页、60/50 caster、overflow0。初次要求稳定帧必须写caster的错误观察条件已保留，修正为增长帧真实需求，未取消caster断言。
- 增长fixture同时存在的新旧bank峰10,485,760B，metadata峰9,648B，合计10,489,648B；退休后active为6,297,216B。不是仅计新buffer的伪峰值。
- SSSR production与Streaming VT production通过，保留能量/MASK、AO/Native/FSR、abort/resize、受控loss与释放。VT原测试把准备tick当成24个完成帧，可能在首个真实Native反馈前退出；现按45秒wall deadline等待真实feedback、wanted/resident与收敛，后续断言不变。原失败`.codex-temp/grs3-vt-fixed.json`与通过重跑`grs3-vt-fixed-retry.json`均保留。

上述GPU原始结果在`.codex-temp/grs3-{native,geometry,sssr}-fixed.json`、`grs3-attribute-retry.json`；每份带test build source/output hash与oracle hash。本地artifact不提交。原失败不是通过结果，不升级为已修复的旧数值资格。

### 8.3 完整场景诊断与成本

独立宿主`validation/tools/run-geometry-startup.mjs`以真实examples Vite生产构建运行完整Bistro/Dungeon；1920×1080、internal scale1、AO、balanced SSSR、Native Temporal+jitter、VSM及VT，保留原完整场景/材质/覆盖，Bloom关闭。首次completed后按固定观察相机移动，等待真实view-settled，再记录普通CPU与GPU timestamp短窗、截图及release归零。相机实际姿态和全部quality设置存于raw report，截图不替代数值/生命周期检查。

Cold条件清HTTP及application缓存；warm保留HTTP、清application，均新Document/GPUDevice。独立Chrome155测试context，硬件由nvidia-smi确认**RTX2060 SUPER 8192MiB、driver610.88**。driver cache、OS文件缓存与温度不可控，不能称严格cold-driver实验或正式P95。记录每次温度、revision及引擎/demo/观察宿主源码SHA256。`networkEncodedBytes`只观察主页面CDP，不含Worker，不能当全部资产IO；真实读取/校验/上传成本取各owner/provider计数。

修复后的12次均通过。逐次原始JSON/截图与`summary.json`在`.local/validation/grs-3-final/`；下表依次为第1/2/3次，时间为navigation起的秒数，settled取近景首次真实确认时刻：

| 场景 / HTTP条件（均新device） | 首completed，s | 近景首次view-settled，s |
|---|---|---|
| Bistro cold | 15.951 / 11.811 / 15.619 | 31.644 / 22.416 / 32.868 |
| Bistro warm | 13.388 / 16.713 / 17.313 | 26.972 / 34.437 / 29.835 |
| Dungeon cold | 8.524 / 9.351 / 7.911 | 12.269 / 15.109 / 11.276 |
| Dungeon warm | 7.857 / 7.226 / 7.788 | 14.289 / 10.254 / 10.169 |

两场景每次均无page/GPU/browser错误，pinned完整、几何无evict/reload/thrash，最终geometry staged/retiring为0、VT missing为0、VSM valid且无pending/overflow，release后geometry与texture owner归零。Bistro初次缓存准备134个、Dungeon136个；两个descriptor cache的syncMiss/unpreparedUse全部0。截图人工检查了Bistro近景墙面/窗框细节与Dungeon完整场景主视图；不是完整SSR/Temporal主观质量资格。

首次settled不表示之后永久锁定：Bistro cold第2次的普通窗口仍为view-settled，GPU观察末尾为refining，geometryTarget/texturesFull/vsmValid仍true且无缺页；保留原状态。`SceneRefinement`需要两次推进的完整receipt确认，短暂反馈缺口会撤销settled，再以候选帧重新确认；本轮没有放宽该条件。原readback ring的overflow计数也包含无可用slot/重复reserve，并非GPU需求队列溢出；真实scheduler demandOverflow与malformed均0，不把这些计数混称漏页。

| 实际成本（Bistro / Dungeon） | 数值 / 边界 |
|---|---|
| 全目录最终resident raw payload及allocated intervals | 253,489,632B / 5,711,264B；本场景有效前缀已16B对齐，两值相等，不代表任意资产都零alignment slack |
| 四bank实际buffer | 316,862,080B / 7,139,136B |
| metadata / 几何合计及峰值 | 1,916,896 / 318,778,976B；802,848 / 7,941,984B。两个静态完整场景不触发bank增长；双代峰值另由§8.2真实增长fixture验证 |
| 共享allocator CPU | 每device19,403,028B，两场景相同，只计一次。Dungeon目录虽小，lease/node默认上界未跟着缩到同等比例 |
| 几何流送上传 / 在途峰 / verified缓冲峰 | 全部页累计上传同raw payload；非pinned scheduler另计248,111,888B / 4,833,504B。两场景inFlight峰16,777,216B，buffered峰Bistro46,137,344–50,331,648B、Dungeon35,913,728–48,496,640B |
| VT实际capacity / resident payload | 239,403,492B / 26,272,512–27,703,296B；106,693,092B / 34,463,232–35,271,936B。Bistro224个pinned tail，Dungeon25个 |
| VT物理copy / staging峰 | 35,030,016–36,937,728B / 6,894,080B；45,950,976–47,029,248B / 2,343,936B。物理行padding与logical upload分别记录，不混称 |
| VT provider读取 / payload hash | Bistro86,489,730–87,958,658B / 83,521,154–84,018,818B；Dungeon42,653,952–44,727,552B / 34,608,384–35,500,032B；metadata读取另列于provider，不用主页面CDP替代 |
| 常规纹理capacity / payload / copy | Bistro61,623,527 / 56,025,218 / 56,793,856B，staging峰56,793,856B；Dungeon shading走VT，该常规上传为0 |
| 已注册owner内存合计 | Bistro989,259,447B；Dungeon469,485,900–469,485,916B。含共享transient和效果owners，非driver实际VRAM，也不是完整进程峰值 |

相较先前固定槽记录，Bistrobank由1,610,612,736降至316,862,080B，metadata由134,217,728降至1,916,896B；这是实际资源表示减少，不是只改occupied统计。Dungeonbank由512MiB降至7,139,136B。历史运行不能作严格startup A/B；同轮修复前后的Bistro首completed范围由19.79–22.36s变为11.81–17.31s，只作为重复准备消除后的诊断观察。driver/温度未锁定，不宣称精确净提速或稳定帧FPS提高。

长任务仍存在：采集到的稳态观察前后buffered longtask，Bistro每次7–14个、单次最大357–813ms；Dungeon每次4–5个、最大152–196ms。首帧并未做到完全无UI停顿。普通CPU短窗各次中位数Bistro2.47–4.65ms、Dungeon2.10–2.62ms；full timestamp窗口GPU command-span各次中位数分别15.52–16.93ms、10.30–32.15ms，样本数46–64和33–40；Surface pass和为7.78–8.04ms、3.06–10.08ms。Dungeon波动明显，温度记录71–83℃且driver调度/频率未控，现有数据不足以归因为某个pass回退或改善；保留逐帧span/pass，禁止stage+pass重复相加。它们是必要粗粒度成本观察，不是整Renderer稳定P50/P95资格。

VT provider累计failedTasks计数Bistro4–13、Dungeon2–11，当前owner error为null且最终missing0；该catch同时累计取消/会话失效等异常，现有计数不分类，不能写成“全部IO零失败”。错误照常上抛到现有调度处理，未为本轮吞异常。为补齐包括Worker的总体IO/credit观察，另用同一生产源码加只读owner evidence运行`.local/validation/grs-3-io/`；结果另列，不替换上述12次。

补充四次均通过：Bistro cold/warm成功Worker receipt累计encoded bytes为298,928,559 / 301,560,841B，geometry批range数577 / 673；Dungeon为50,105,178 / 52,123,930B、80 / 65。它们包含对应目录/几何/VT任务的成功receipt，非所有取消任务的wire字节，也不包含绕过该Worker的主页面读取。四次peakActiveWorkers与IO semaphore峰均4；任务估算在途峰Bistro64,530,752 / 65,814,912B、Dungeon均54,273,026B。共享credit总峰分别107,354,560 / 100,145,864B与94,328,900 / 88,471,410B，ready峰不超过67,108,864B；结束active/queued/estimated-inflight/used-credit/waiting均0、workerFailures0。IO/busy的累计并行wall不得与navigation时间相加。补充Dungeon warm的tiled failedTasks30仍原样保留，当前error为null、missing0，不据此宣称零取消/零失败。

### 8.4 验证收口与边界

最终typecheck、生产build、新鲜build:test通过；受影响Node157/157、变更MJS语法检查通过。新鲜build后串行补查virtual-geometry-handoff 50用例、instance-culling 20帧、product-attribute-decode含完整原始Page均通过；结果在`.codex-temp/grs3-*-final.json`，前述Native/geometry/SSSR/VT结果与同一engine source hash对应。生产build保留既有node:module browser externalization提示，无构建失败。docs-verify为0 findings / 81条既有history warnings，document-system7/7、git diff --check通过。

原预检也保留：`.local/validation/grs-3-preflight-temporal-bypass/`使用了错误的bypass设置；最早Dungeon样本默认internal scale0.667被配置断言拒绝。这些不是1080p Native Temporal通过样本，不能放进上表。最终宿主显式scale1、Native Temporal与jitter，并断言实际renderState；未缩场景或改算法来消除失败。

逐节核对设计：§3所有权与单一帧闭包、§4完整allocator/ABI6/目录初始容量/事务增长/碎片退化、§5准确准备/失败retry/loss/首帧分段、§6实际成本均有实现或上述独立/真实生产检查。没有额外算法简化、A/B bridge或第二条加载路径。文档domains、source map与粗执行只更新已实现事实，authority仍保留本模块唯一一对。GRS在此闭合并停在下一模块边界；Local Reflection Probes仍待用户启动细设计。

未完成且不冒充本模块结论：GTX1650Ti 4GB、整Renderer同条件长窗口P50/P95/尾延迟与最终主观画质资格；启动longtask进一步消除、Dungeon GPU波动归因、默认allocator CPU容量进一步按目录缩放也未实施。保留已完成效果和全部正确性/容量检查，后续由实际需求决定专项或最终集成，不恢复旧架构掩盖成本。
