---
id: performance/dungeon-scheduler-numeric-operations-2026-10-11
state: current
verifies:
  files:
    - OEngine/src/gpu/GeometryPageScheduler.ts
    - OEngine/src/gpu/GeometryPageDemandAbiV1.ts
    - OEngine/src/gpu/GeometryPageStreamingRuntime.ts
    - OEngine/src/gpu/GeometryDemandReadbackRing.ts
    - OEngine/src/gpu/VirtualGeometryResidency.ts
    - OEngine/tests/unit/geometry-scheduler-numeric-operations.test.mjs
    - OEngine/tests/unit/geometry-page-scheduler.test.mjs
    - OEngine/tests/unit/geometry-demand-canonical-replay.test.mjs
    - OEngine/tests/unit/geometry-page-streaming-runtime.test.mjs
---

# Dungeon：Geometry Demand 调度 CPU 热路径收口

起始 HEAD `bc38aa0b4607b0fc64685b1359922f050b3781c7`。接受 [10-10 报告](2026-10-10-dungeon-warkarma-performance-report.md)作为原始 Before，不重复 baseline；另用 [既有 canonical After](2026-10-11-dungeon-demand-and-native-slicing.md)区分已完成的优化与本次增量。所有原始数据、失败、临时旧实现 oracle、sourcemap 和截图保存在 `.local/validation/dungeon-scheduler-numeric-2026-10-11/`，不提交。

## Previous Task Gate 与当前事实

【源码事实】审查上一提交实际 diff，并重新读取 Dungeon main/frame-pacing/texture-quality、OrbitControls、FrameCoordinator、RendererCore 及直接消费者。interactive 只由 RAF 推进 interaction；capture 的 ready 仅重试 finalized state；defer 不推进 submitted clock，frame_count 只计实际提交。阻尼按时间消耗，host 不再重复 camera.update，pointer delta 不查 DOM layout。质量查询消费已发布冻结程序，runtime replacement/release 失效。pause/step/visibility/release、temporal transactions 没有发现新缺陷，未作“补齐交互”提交。

【实测事实】上一任务的 25 targeted checks 重新通过。真实隐藏标签恢复、Presented FPS、输入到光子延迟仍未测；脉冲阻尼时间一致性不冒充连续输入/autoRotate 轨迹一致性。上一 headed smoke 是已有证据，本次没有重复交互 smoke。

【源码事实】本次 prompt 的双 decode、逐 record 冻结对象、dedup composite string 假设已由 `1ddfb637` 修复。当前 main/shadow packet 都单次 header/record decode + structural validation，复用四 u32 AoS batch；numeric identity sort/linear merge/priority sort仍在。Scheduler 用 uniqueIndices；residency 用 raw order，不能合并：`VirtualGeometryResidency.touchPage` 每次增加 visibleFrequency，`recordDemand` 更新频率/衰减，重复同帧调用并非严格幂等。本次不删 usage，也不把“少一次 decode”重复记作新增收益。

## 本次数据流、工作删除与成本卡

生产链：`hierarchy_emit_page_demand_v1` → main `PackedVisibilityPass.encodeHierarchy` / shadow `ShadowGeometryWork.encode` → 同一 frame command 的 demand copy → commit/abort readback ring → `RendererCore` 提交后 `consumeAfterCompletion` → 串行 poll → `consumeCompleted` → `ingestDemandReadback` → canonical batch → Scheduler / raw residency feedback → completeness-gated eviction → readPage/hash → upload → fence retirement。

本次 Before：canonical batch → generation/slot/page 检查 → `${generation}:${pageId}` operation Map；`pump` 展开全部 operations/filter/稳定 sort 取第一；上传展开全部 operations/filter/初始 sort/逐次 sort；evidence 展开/filter 计 pending。

本次 After：canonical batch → 同样检查 → registered generation 的 `Map<number pageId, Operation>`；全局 `Set<Operation>` 保存跨 Product 插入顺序 → pump 顺序扫描选最优 → 上传仅收集 ready snapshot 并逐次稳定 sort → evidence 循环计 pending。generation Map 不缩位，slot仍验证，page不是全局 identity。取消/注销只遍历该 Product 的 map，删除两个索引；退休删除该 page；晚到 IO 仍检查 product object identity/AbortSignal，不能覆盖新注册 operation。

【源码事实】删除 operation 字符串构造/字符串 hash、pump 的全量临时数组/filter/sort、上传的全量展开/filter及冗余初始 sort、pending 的数组/filter。没有删除 canonical 两次 numeric sort、recordDemand/touch、readback 两层复制、上传逐次稳定排序、IO 完整性检查或 GPU work。主/影反馈 frame、overflow/completeness、incomplete-shadow 保护、延迟 eviction fence、publication/source ownership、retry/abort/device loss原 owner 都保留。

成本卡：新增每 Product 一张 numeric map、全局 Set 引用索引，删除旧字符串键及 Operation.key。持久内存净差未知，JS Map/Set/reference/string实际 bytes取决于 V8，不编造大小。顺序扫描 O(N) operation，读选择从 O(N)+O(Q log Q)降为 O(N)，每读后重新选优以保留 readsServed 公平。新建/升级 operation 仍物化 demand；canonical scratch仍约24B/entry，不新增 GPU bytes/ALU/samples/atomics/barriers/pass/dispatch/submit。空 upload仍有一个空数组；活跃上传仍为逐次 sort/shift，本次不承诺修完所有分配。

最好：大量 resident operations、Q=0时避免全量复制和排序分配。通常：固定近景仍扫描所有 operations，但不分配 N 项数组；numeric查询少短命字符串。最差：N很小、频繁建删 Product 时额外 Map/Set维护可能抵消收益；大量 upload排序成本仍存在。0/50/100% resident 情况都删除全量展开；待读项分别可能接近N、N/2、0，只有原本需要排序的Q产生算法差异。break-even 为省掉复制/排序/string成本大于额外持久索引维护。没有 GPU收益，不能用整个91.58ms/s旧热点作本次收益上限；本次可删部分远小于整链，实际数据如下。

## 验证与真实 After

【实测事实】engine/Dungeon typecheck、engine/Dungeon build、新鲜 build:test通过，41 targeted tests通过。将 HEAD Scheduler 临时转译到 `.local`，同一组packet/生命周期/调度测试分别跑旧实现与新实现：旧实现13 tests也通过。覆盖完整u32 identity、priority/tie/order、stale/wrong slot/invalid page、malformed/truncated/reserved/overflow、retry/abort/late IO、verified/retiring/resident cancellation、unregister/reload、main/shadow completeness、dropped shadow保护、destroy/device loss；生产没有 dual implementation。

发现并修正旧 corruption 测试引用未定义的 `integrity`，原测试可能以 ReferenceError失败而非真正验证hash；现在要求明确 integrity hash mismatch。首次新测试40/41通过，失败为upload tie预期错误；旧实现产生完全相同的失败。动态 uploadsServed排序改变剩余相等项的相对顺序，修正预期后两者通过，未放宽断言。原失败保留。

一个 headed Chrome154 session串行跑 normal-1/2/3、full、counters各240提交帧，以及一个1ms sampling CPU profile；保持1080p内部/输出、renderScale1、VSM high4096²/6clips/4×4PCF半径0.75、FSR3/jitter/HZB/cone ON，GTAO/Bloom OFF，固定标准近景位置/target。raw与analysis完整保留，不剔除异常值。

【实测事实】Dungeon自身覆盖90.673–90.708%，invalid0；shadedPixels=2,073,600，meshletWorksProduced=605。resident总1,207/pinned381，pending/verified/inFlight/retiring/eviction/reload/thrash/failed/stale/malformed/demandOverflow均0，lastError为空；scheduler resident826不包括381 bootstrap页，不能误当总驻留。readback ring overflow非零：counters快照main/shadow各388，是丢快照计数，不能被demandOverflow=0掩盖。原有不完整反馈保护仍由tests检查。release texture owner及geometry实际teardown账本归零，report旧快照不用于泄漏判断。近景截图与此前After目检没有明显变化；未做逐像素画质验收。

## CPU与GPU结果：没有整链加速结论

以下为sampling inclusive ms/秒profile窗口，嵌套不可加总。旧Before6.279s，canonical三轮7.288/7.346/6.379s，本次7.399s/5,935 samples。不是函数计时或精确每packet成本；不同窗口不能将差值当本次净收益。

| 调用链 | 10-10 Before | 既有canonical After三轮 | 本次After |
|---|---:|---:|---:|
| consumeCompleted | 91.58 | 52.67 / 54.27 / 52.53 | 61.75 |
| ingestDemandReadback | 42.82 | 21.70 / 20.59 / 21.34 | 20.90 |
| ingestDemandBatch | — | 1.12 / 2.00 / 2.14 | 1.21 |
| decodeRecords | — | 19.80 / 17.97 / 18.25 | 19.05 |
| dedup | 29.34 | 17.79 / 16.60 / 15.14 | 17.53 |
| recordResidencyFeedback | 40.90 | 14.56 / 18.04 / 14.71 | 22.70 |
| pump | 3.71 | 2.22 / 4.32 / 4.27 | 2.04 |
| drainUploadBudget | 1.06 | 1.20 / 1.49 / 0.70 | 0.31 |
| GC | 10.02 | 6.70 / 6.94 / 7.13 | 4.75 |

本次pump总采样15.064ms、upload2.267ms、GC35.169ms；consume456.908ms，其中raw residency167.931ms。map callback self141.631ms、ring mapping closure104.268ms，readback/usage仍有成本，本次没改它们。局部采样与删除临时数组方向一致，但一次profile及旧host差异不能证明稳定局部加速；更不能把GC下降完全归于Scheduler。没有allocation sampling/heap snapshot，未直接测分配字节或持久索引净RAM。

精确240提交帧分析窗口的render-only CPU P50/P95为2.685/4.030、2.195/3.635、2.655/4.355ms，旧报告P50约1.83–2.12/P95约3.04–3.53ms。TaskDuration/墙钟为2.964s/7.058s、1.268s/7.068s、1.883s/7.104s；CDP heap used窗口差+96,916/−7,422,260/−23,660,020B不是allocation bytes。**本次没有稳定整体CPU或consumeCompleted改善，整链比既有canonical After更慢。** 不能把此前单次decode的改善记到此提交，也不靠删异常尾部宣称成功。

GPU full精确窗口60 samples，command span P50/P95=22.496/47.816ms，Native winner10.328/22.820ms，temporal stage6.109ms、独立shadow2.701ms、receiver1.913ms（P50不相加；native已含VSM采样）。量级较旧Native9ms偏高，检查本次source vs起始HEAD只有Scheduler语义变化，没有shader、GPU资源、submit或工作量变化。full窗口89–90°C、thermal限制100%，graphics采样300–1170MHz，Native最大71.832ms；保留全部尾部。相机/覆盖/工作检查通过；【合理推断】热/频率波动是可信混杂，不能精确归因全部变化，不能宣称CPU重构带来GPU加速或确定GPU回退。稳定60FPS GPU budget仍未达成。

## 收口与边界

Architecture review已检查producer→canonical→两个consumer→eviction→IO→upload→retirement：每包单次必要解码、raw反馈次数不丢、两个numeric索引删除一致、跨Product tie/fairness和late-result隔离保留，未新增提交或本帧GPU→CPU→GPU控制。没有修改Native/VSM/FSR、geometry格式/allocator、Loader或画质。

未运行完整旧baseline、全Renderer suite、真实强制overflow/eviction/device loss压力场景、allocation sampling或精确画面对照；相关CPU生命周期由targeted checks覆盖，本次GPU只验证固定近景的接线与工作量。局部重构正确性闭合，性能收益仍须避免夸大；本单元提交后停止，不自动进入下一模块。
