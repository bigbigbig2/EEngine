---
id: eengine-initialization-scheduling-execution-2026-10
state: current
verifies:
  files:
    - docs/next-design/eengine-initialization-scheduling-2026-10.md
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - docs/porting/next-renderer.md
    - OEngine/src/assets
    - OEngine/src/gpu/GeometryPageScheduler.ts
    - OEngine/src/gpu/GeometryPageStreamingRuntime.ts
    - OEngine/src/gpu/VirtualGeometryResidency.ts
    - OEngine/src/gpu/TextureResidency.ts
    - OEngine/src/render/ShadowGeometryWork.ts
    - OEngine/src/render/vsm
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - examples/demos/14-integrated/bistro-texture-compression
    - OEngine/tests/contract
    - OEngine/tests/oracle
---

# 初始化调度执行计划

唯一细设计为[初始化调度设计](../next-design/eengine-initialization-scheduling-2026-10.md)。源码起点`30292e0e`；设计轮于`f7a6c4cf`收口，2026-10-15用户随后授权**仅INIT-1**的production实施。INIT-2、INIT-3仍未授权，不能把Worker研究、诊断脚本或文档检查当作完成。

INIT-1开工前置（本轮实际第一步）：现有诊断机制已存在但无生产者——`addGpuListCounterPass`/`GpuListCounterAccumulator`零调用者，`VsmResources.diagnostics()`已给出dirty页/配对/atlas的计数偏移，而`BenchmarkCapabilityEvidence`有6条`PackedCsmShadowPass/*`声明指向已从production删除的旧pass。故先在INIT-1内把这些观测接成真实的VSM工作量计数并撤销失效claim，再决定发布批次预算。

## 1. 三个完整单元

| 单元 | 状态 | 闭合边界 |
|---|---|---|
| INIT-1 几何帧事务与VSM更新闭包 | 已完成（2026-10-15实施并集中验证） | 所有持续geometry位置发布改为同帧事务，变化影响含coarse替换，requested与dirty域分离、完整页预算与content-ready正确；不依赖加Worker才能避免反复重绘 |
| INIT-2 Worker批量资产准备 | 待实施 | 复用pool建立Cooked几何/texture任务，Range批量、验证receipt/transfer、输入与ready背压、可靠独立压力与生命周期；bootstrap与持续流送共用同机制 |
| INIT-3 并行首屏、渐进纹理与真实收敛 | 待实施 | 目录去重、并行必要PSO/资源、首屏critical集合、事务mip区间与预算、view epoch阶段和Bistro真实验证/文档复核；删除旧入口，停回Local Probes边界 |

不按文件、每个shader或每条测试拆阶段。用户授权实施后按顺序连续闭合本轮明确范围；阶段内允许暂时不编译，稳定边界唯一生产ownership。不创建A/B renderer、旧发布adapter或测试专用fallback。现有SSR/AO代码与质量合同保留。

### INIT-1：先删除GPU放大

- 观测接入：GpuFrameCounters 升级至 Schema 30（848B），新增 `vsmDirtyPagesDirty`（208）、`vsmDirtyPagesSelected`（209）、`vsmDirtyPagesInvalidated`（210）、`vsmDirtyPagesPending`（211）四个计数器，通过 `copyGpuCounter` 零 dispatch 直拷；清理 BenchmarkCapabilityEvidence 中 6 条失效 CSM claim；彻底移除 RendererCore 中未写入却作为调度器输入的死字段 `_streamingGpuFrameTimeMs`。
- 几何帧事务发布：激活 GeometryPageScheduler 沉睡的 `submitted` 状态；VirtualGeometryResidency 设立 `#stagedPages` 隐藏槽（`stagePage` 阶段仅写 Bank payload、不公开位置表）；`preparePublication` 经 ShadeGPUCommandContext `uploadRegions` 一次性打包编码 16B 位置表拷贝，并计算同帧候选版本与候选影响区；只有在包含拷贝的 Command 在 `onFinished` 提交成功时才推进持久 CPU 状态（`resident`、`contentRevision`），`onAborted` 干净回滚候选状态；退休解绑全队列阻塞，改用内部提交 Fence 批次异步回收。
- 驻留变化影响收紧：`GeometryRefineInfluenceV1` 按细 group 建立反向边聚合粗父几何 AABB 并设置溢出降级；VirtualGeometryResidency 在入驻/退休时生成候选影响区；`vsm_depth_bounds` 消费 binding 7 `influences`，纯驻留版本变动使用紧凑 AABB 投影收紧 damage，无法证明时安全回退整实例并计数；无变化帧保持 0 GPU 派发。
- 有界选择与双域：`vsm_allocate_pages` 中的 `publish_dirty` 升级为 64-lane 三级有界选择器（当前帧需求 > 历史 requested > 后台 dirty），消费 `identity.w` 传递的 `dirtyPageBudget`（默认 64 页，可配置 1..2048），未选差额写入 `overflowCounters[7]`（`vsmDirtyPagesPending`）；选中的槽位打上 `inFlight` 标志（bit 2），严守 `allocation.overflow == 0` 防止整帧冻结。
- 验证闭合：tsc 0 报错；`npm run build:test` 成功；109/109 核心契约与单元测试通过；4 个 GPU Oracles（`vsm-local-invalidation` 5187 assertions、`geometry-budgeted-residency` 72 帧完全收敛至 6、`vsm-caster-cost`、`geometry-shadow-view`）全部在物理 GPU 上通过。停在 INIT-2 边界。

### INIT-2：让准备跑满可用CPU/IO，结果不淹没GPU

- 将OEGPACK CRC/LZ4/布局和resident numeric验证归到CPU可复用kernel，复用`AssetWorkerPool`，建立version/session/task epoch、descriptor注册和worker重建协议；texture沿完整container+Product校验，内部receiver重建realm品牌。不能让普通`verified:true`冒充proof，不能取消hash。
- `GeometryPageScheduler`按priority选择后调用batch reader，coalesce相同Product邻近Range；编码/解码/结果全部credit预留，worker和HTTP并发独立；修正floor导致稳定单并发和伪throughput/GPU压力。保留公平、aging、generation完整身份与有界网络重试。
- bootstrap和持续流送统一batch preparation；ready→hidden stage→INIT-1 candidate，GPU work不由worker完成消息直接决定。trim prefix仅在验证完整页后内部消费，外部256KiB Product合同保留；若首版仍传完整页明确记成本，不伪称zero-copy prefix已完成。
- Worker crash/取消/epoch替换/descriptor重注册、detached buffer、late结果、scene release和device replay全闭合；1个worker是同路径capacity profile，不添加同步Cooked主线程后端。

### INIT-3：把首屏关键路径和“完成”定义接对

- manifest按期望Product identity合并读取和校验，alias正确保留sampler/UV和各材质绑定。geometry metadata/root、unique textures、必要结构PSO、环境准备并行；PSO拆真实结构与资源绑定，不用占位layout制造重复compile。
- `TextureResidency`建立区间promotion、物理分块copy和mip完整性、staging/fence预算及原子resident-minMip/Native采样发布。只上传新mip，不重传tail；首帧保完整coverage依赖，不再全材质无预算提升。full容器/replay内存与fullGPU分配明确不变，不偷塞partial Product或VT。
- 建立first-completed/纹理full/geometry target/VSM有效和view-settled epoch，替换空settled，capacity-limited不算完成；普通相机运动/cut、sun/scene变化重新refining。Bistro显示真实数据，GPU等待/CPU编码/IO/ready/publish/VSM分开统计。
- 删除旧逐页stream调用、completion直接发布、asset-version全实例流送damage、首帧无预算promote、伪压力与空settled的生产依赖；外部provider信任验证与已完成effects不退役。必要时同步其他直接Cooked consumer，不能只修demo特例。
- 集中验证后按设计逐段对：依赖→读取/worker→receipt→隐藏槽→帧发布→coarse handoff→damage→dirty页完整commit→Surface/MASK→mip/replay→收敛；只更新已发生的domain事实和粗模块结论。

## 2. 轻量必要验证

开发按需typecheck/小测试；单元末集中执行受影响contract、必要build和GPU。只添加少量语义case，不写逐行镜像测试、源码字符串检查或新重型evidence机制。GPU作业串行，不每patch跑整个Bistro。

| 范围 | 最小可解释覆盖 |
|---|---|
| 发布与生命周期CPU | 一个小Product，两次批次；hidden不出现在已提交resident状态、abort→retry、late generation拒绝；retire等待旧fence；共享页/多父coarse关系与两实例damage，不截断u32身份 |
| Worker/IO CPU+真实worker | 一次邻接Range合并与一个不应合并的优先级gap；几何CRC/结构/numeric损坏，texturehash损坏；transfer后detach与本地品牌，cancel/worker重建后descriptor注册、结果credit释放。复用既有pool/source tests，不建大随机矩阵 |
| VSM小GPU语义fixture | 页到达替换coarse且新group bounds更小；离屏caster；两个细页同batch union；一页budget跨帧保dirty；fine/coarse同时失效不采stale；pair显式溢出仍完整或明确失败；普通transform/MASK变化仍失效。与一次完整无budget结果在最终收敛后核对depth/visibility，不只看计数 |
| Texture/首屏 | 代表性opaque+完整coverage材质；粗到细区间只传一次，abort重试不提前暴露mip；首帧必要PSO未ready保loading，内容更新不重复PSO编译；两alias同payload不同sampler/UV保持。一次release/device恢复路径可复用相关fixture |
| 真实Bistro | 同原模型、视角、尺寸、最终quality，AO/SSSR保持原默认；正常完整启动到真实view-settled后短暖帧，加一次移动/恢复。记录首帧、交互回调间隔/提交帧间隔、需求收敛、IO span/worker busy、GPU VSM分位与资源峰值；UI可信度与画面要核对，不能只测partial roots |
| 必要编译 | 单元末受影响typecheck；production闭合一次engine build、新鲜build:test和相关contracts；demo只跑targeted Bistro typecheck。文档改动跑docs-verify。本轮设计不运行生产build/GPU |

Bistro至少保留一次原配置基线与一次新配置完整运行，条件相同、串行GPU；冷/热缓存标记，不以一个短窗口保证二分钟长尾消失。已有诊断可用于选择case，但错误`vsm_enabled`off窗口不能当证据。未提供GTX1650Ti测试设备就如实没有4GB真机证明；同设备做descriptor上界/峰值检查不冒充4GB性能。

本模块是优化，需要同条件观察启动/持续卡顿是否改善，但不建整Renderer ABBA/正式claim门槛。不得以放大并发后更快读完、但画面卡得更厉害宣称成功；不得以延迟无限发布换稳定FPS；总目标/质量必须最终收敛，容量不足有明确limited结论。最重单页超过软预算、fallback可见变化和CPU/GPU保留内存是必须记录的限制。

## 3. 设计轮检查与停止点

2026-10-15已核读实际Cooked加载、OEGPACK批读取/校验、Product品牌、worker池/取消、residency上传/地址发布、frame事务、shadow全域SSE0、receiver粗覆盖、VSM损坏/失效/光栅和texture完整Product/minMip消费。成熟参考及规范已固定在设计与porting短映射；没有新shader/Worker实现、没有修改production行为。

文档验证结果在完成后追加本节，不把文档通过写成算法或性能完成。下一步只有用户授权实施后才开始INIT-1；不自动跨到Local Probes、VT或页面物理ABI重构。

设计轮已执行：`node --test tools/tests/document-system.test.mjs` 7/7通过，`git diff --check`通过；`vibe context`对geometry streaming返回本轮唯一authority一对，`vibe doctor`无errors/warnings且registry一致。全库及changed `docs-verify`均仍有既有1个finding：Git忽略的`docs/status.generated.md`缺frontmatter，以及81条historical warnings；本轮没有新增finding，未修改生成状态文件来掩盖该结果。仅文档/导航改动，未运行production build、GPU或新性能测试；前述启动与对照数字保留原诊断条件，不当作新方案收益。
