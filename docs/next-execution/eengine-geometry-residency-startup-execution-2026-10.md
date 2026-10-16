---
id: eengine-geometry-residency-startup-execution-2026-10
state: current
verifies:
  files:
    - docs/next-design/eengine-geometry-residency-startup-2026-10.md
    - OEngine/src/gpu/GeometryProductSlotPool.ts
    - OEngine/src/gpu/GeometryProductGpuAbiV1.ts
    - OEngine/src/gpu/GeometryProductMultiRuntime.ts
    - OEngine/src/gpu/VirtualGeometryResidency.ts
    - OEngine/src/gpu/GPUDescriptorCaches.ts
    - OEngine/src/gpu/GpuNativeMaterialScene.ts
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/shaders/virtual_geometry_product.ts
    - OEngine/src/shaders/geometry_source_decode.ts
    - examples/demos/14-integrated/shared/cooked-scene.ts
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
---

# 几何紧凑驻留与首帧准备：执行计划

唯一目标依据为[设计](../next-design/eengine-geometry-residency-startup-2026-10.md)。基线`17252477`；2026-10-16本轮授权为设计，以下单元**均未实施**。不因计划建立就改生产代码或宣称完成。模块只设三个工程单元，GRS-1包含一次完整地址/容量切换，不能把其中临时断链提交成稳定的双ABI生产状态。

## 1. 顺序与状态

| 单元 | 状态 | 完成边界 |
|---|---|---|
| GRS-1 紧凑几何驻留闭包 | 待实施 | 完整OffsetAllocator移植、目录容量计划、ABI6、四bank与metadata增长、所有直接consumer与退休闭合；删除固定槽生产依赖 |
| GRS-2 准确异步准备与首帧门槛 | 待实施 | 真实feature/scene PSO async准备与生产requirePrepared同源；首次图/编码/提交分段诊断；保留正常帧事务和UI响应 |
| GRS-3 集中验证与文档核对 | 待实施 | 新鲜build与串行GPU、两场景同质量启动/收敛、容量/生命周期/成本复核；按实际事实更新domains与来源状态 |

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
