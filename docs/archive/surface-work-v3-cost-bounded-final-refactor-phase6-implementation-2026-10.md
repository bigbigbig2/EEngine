---
id: next-execution/surface-work-v3-cost-bounded-final-refactor-phase6-implementation-2026-10
state: history
verifies:
  - OEngine/src
---
# Surface V3 Phase 6：调度、reset与生命周期

日期：2026-10-05。起点`7d267d373e3c0d9fd37b0542095003c6eb6b57b1`，Phase5.5已提交。状态：实现与集中检查完成，待中文提交；Phase7正式验收未开始。依据设计§16/17.3/19及执行计划§9，保持单生产路径/submit，无当前帧CPU工作控制。

| 要求 | producer/产品/consumer | 必需检查与独立预期 | 当前结果 |
|---|---|---|---|
| payload无需clear | Workspace/Demand controls及maps→typed/witness/ref/worker | current GPU poison、实际clear ranges；normal/empty/末批/proof满/cache满仍完整数值覆盖 | 八帧32批当前生产GPU通过；实际clear范围544768B/八帧，不将命令字节当DRAM或帧时 |
| overwrite/atomic mask/indirect | coverage/range/facts/lookup/demand→counts及validity→全部consumer | actualCount外不可读，零工作args全零X、mask不累积、每次消费前完整发布 | 八帧空/常量/稀疏/mixed/proof满、完整HDR alpha/finite/数值/派发参数断言通过 |
| BG/PSO稳定缓存 | Surface/Appearance/Present owners→layout/resource/range tuple→实际dispatch | 相同元组复用；buffer/view/layout/offset/size改变失效；CPU对象创建实测 | 原生纹理view和wrapper generation分开；2720请求/118创建；实际setup四buffer各1次；PSO既有profile cache保留 |
| 合法调度合并 | background + reconstruct→互斥HDR/reactive写域 | 不依赖另一个dispatch结果；同storage用途、独立indirect；计时合并区间覆盖两个dispatch | 6个独立compose及八帧完整写域通过；Store/Geometry/lookup的真实发布依赖保留边界 |
| ordered uniforms | encoder staging→稳定uniform→批间consumer | 同submit多batch读取各自uniform数值；不使用out-of-band重复queue.writeBuffer | settings分别由Surface scratch/pass、Appearance publication、Present持有；八帧多批current GPU及内容更新通过 |
| lifetime/retirement | SurfaceFrameResources/Stores/Renderer/TemporalFacts | resize合并/延后、实际fence、abort/publication/namespace、camera cut、device loss重建 | 当前真实Renderer 10项通过，namespace/recovery像素max diff=1；scratch峰251430304B < 240MiB；多Product/完整时域画质矩阵仍Phase7 |
| 集中检查 | fresh build/test→GPU/lifecycle→1080p smoke | 无未定位失败、不拼不同源码结果；timing细counter关闭 | 87 targeted/typecheck/build、最终GPU/lifecycle及非profile smoke通过；无drop/sourceDrift；不是Phase7正式收益 |

Phase5.5 producer布局不在此重做。完整画质/跨浏览器/正式同条件历史收益在Phase7，Phase6不能用后续验收代替自身必需生命周期检查。

## 当前实施

Workspace只清512B control、typed result maps/known masks、Field/Signal Store masks和7个proof queue counters；payload、requests、fact、address、witness、ref、map、dispatch参数由真实producer覆盖。Demand只清control/program/hash和三个atomic target masks。八帧32批poison在`.local/validation/phase6-selective-reset`通过，后续BG/uniform修改需重新跑关联GPU。

复用既有`GpuBindGroupResourceCache`，SurfaceFrameResources按pipeline/group/binding shape/实际resource/range缓存native groups；resize retirement清缓存。classifier/setup/lookup/Geometry/Demand/Lighting/coverage/radiometry/Store已接入。Demand/Geometry/Lighting/coverage/Store settings改由有序encoder copies更新稳定小buffer，无out-of-band同submit覆盖。BG对资源/layout/group/offset/size失效的focused test通过，真实GPU计数在测。

resize创建帧command前检查新profile+未完成scratch是否可装预算；不够则暂缓该tick，最新extent自动替代旧请求。真实fence完成后active安全同步退休；steady-state不await。focused resize/retirement/late-bound资源测试通过，Renderer真实生命周期仍待GPU检查。一次mock缺`capacity:null`造成test失败，按真实类初值补齐fixture后原case通过；一次test与build:test并行读旧artifact已记录，后续统一顺序fresh build→test。

Store三dispatch合并曾写入后在GPU执行前撤回：保留Produced→Published→ref独立pass边界，只保留stable设置/BG复用。最终合并background/reconstruct，计时计入reconstruct首batch，compute pass数2383→2382、dispatch数2394不变，不能把少1个pass当GPU收益。其他连续dispatch有真实发布依赖、copy/clear或不同有序settings，未强合并。GPU任务串行。

## 当前真实布局与消费核对

| 产品 | producer/reset | 全部直接consumer/有效条件 |
|---|---|---|
| Workspace controls | 每batch清512B | classifier/lookup/proof/tree/demand/Store/reconstruct按实际count/coverage |
| typed maps/known masks | `geometryProofs..primitives`只清有效索引及known | proof producer→Field support/tree/source/Store；Unknown不读旧payload |
| Field/Signal Store masks | `fieldStoreMasks..demands`清atomic mask | lookup/Store发布→demand/Lighting/reconstruct；批间不得OR遗留 |
| proof tile counts | 7×4B清零，GPU完整写dispatch参数 | 各family独立indirect；空family X=0，无payload初始化 |
| address/witness/results/refs/remaps | 实际producer覆盖合法项，payload不清 | proof/tree/request/worker/Store/compose保持count/tag/mask合同，32次NaN poison |
| Demand control/program/hash | `0..field_requests`清状态 | request nomination/resolve/compact/program ordering，不因旧payload构造owner |
| Geometry/material/lighting atomic masks | 3R×4B清零 | compact/唯一record/Appearance/Lighting只消费本次mask |
| setup arena/count/settings/indirect/memo | Surface scratch实体owner；GPU reset count/dictionary，实际setup写 | facts/address/witness/record；GPU提交fence+resize预算覆盖同一物理buffer |
| coverage/active range | frame清16B counter，GPU完整覆盖tile masks/range/args | setup/classifier/reconstruct背景与Surface互斥写域 |
| FieldStore/SignalStore/dependency | 常规帧不清池；有序协调namespace restart | lookup→worker→admit→commit→ref，abort不推进namespace，提交完成后退休 |
| HDR/reactive | 背景coverage反集、Surface coverage集合各写一次 | Temporal/FSR3/Present；仍来自真实新链，无旧renderer桥 |

绑定键保留pipeline/group/layout与实际buffer/view/sampler、binding编号、offset/size；GPUTextureContext自身处理底层texture generation。尺寸退休清scratch缓存，Appearance cache属于publication，销毁时撤销。layout的合法空group按layout缓存，不绕过资源合同。

## 当前验证与失败记录

生产快照指纹：`.local/validation/phase6-owned-setup-source`，885文件组合SHA256 `7c858df5509873af28ee5c3063c3a9b6814a64cd6c5a22278c3f914826a1d454`（后续仅fixture/文档变动，最终收口重新保存）。HEAD仍7d267d37+dirty，不称clean正式evidence。

- `.local/validation/phase6-production-owned-setup`：27当前module、8帧、32poison batch，普通cache/coarse与局部失败、provider identity更新、unsafe/正常guard、proof预算耗尽、输出数值/覆盖、实际绑定/allocation通过。
- `.local/validation/phase6-compose-merged`：E-only、ORM/AO、colored direct、partial、empty、unlit六个生产compose检查通过；本轮后续只变绑定和资源owner，最新整链再验证全部write domain。
- `.local/validation/phase6-lighting-current`：20 Lighting数值+4实际provider通过，full7/shared1/transport-only9，保留原BRDF/finite guard；后续绑定迁移由当前完整Renderer验证。
- `.local/validation/phase6-lifecycle-namespace-final`：实际cooked Product+PointLight+physical IBL，steady reuse、NPOT/back-and-forth/rapid resize、camera cut、编码abort/retry、Field/Signal namespace、fresh device recovery，共10项；GPU errors=[]、全部trace资源销毁。
- `npm run build:test`后81 targeted、`npm run build`（含typecheck，492modules）、diff检查通过。并非mock代替GPU数学；focused tests只覆盖宿主资源/namespace/ABI不变量。
- `.local/validation/phase6-showcase-owned-setup`：原Dungeon 1080p，timing3/detailed1完整、coverage pass、sourceDrift=false、errors/timestamp=0。CPU/GPU pass sum/span/Surface P50=101.855/283.271904/290.63568/271.302496ms；detailed Surface274.900928ms。全程counter dropped=1单列；不能宣称全部counter无丢样。CPU graph-execute三帧103.125/99.135/53.495ms，正在CPU profile定位，阶段未收口。无正式同条件收益结论。

失败均保留原report：`phase6-lifecycle-first`缺lit所需IBL，fixture启用真实physical provider；`phase6-lifecycle-provider`在fence后拷swapchain已被Chrome回收，fixture改为帧finish前编码诊断copy；`phase6-lifecycle-readback`恢复差244，在固定曝光/关闭jitter的同条件fixture重跑差1，原自动曝光/不同帧相位比较不能证明恢复不等价。生产没有测试fallback。Appearance contract的合法空group失败按其真实layout修缓存，原断言保留并重跑通过。

退休`validation/tools/run-surface-cache-oracle.mjs`：无调用者，引用已删除SurfaceCacheIdentityPass/SurfaceMaterialCachePass且旧Lighting owner不可运行。原camera/transform/LOD身份映射当前Geometry语义/14kind GPU；field/参数/纹理失效映射Field lookup+dependency/publication；AO/light/environment/coat与无效packet映射20 Lighting+4 provider、Signal lookup和8帧真实链。旧手填work/cache packet不作为当前主链证明，无兼容wrapper。

## CPU热点局部修复与最终复测

保留`.local/validation/phase6-cpu-profile-current`：30帧CPU P50/P95=56.040/95.800ms，profile self热点包括FrameGraph执行、`GpuFramePhase`/`SurfacePhaseTiming`反复locale lowercase与分类、BG tuple trie遍历。不是只加超时或把CPU高值认成环境。

本地确定性胶水修复：BG cache保留完整resource/range身份，增加相邻tuple直接比较，捕获mutable binding的offset/size快照并保留原trie回查；分类按原完整label缓存，上限4096后清表，未知/null分类保留。没有裁剪身份、改数值/质量或漏计pass。新增mutable range/旧tuple/clear回归；旧profiler测试的10phase列表失效按现行16phase迁移，原旧label与sum断言全部保留，新增六个现行label的独立sum断言；原失败保存于`phase6-cache-fast-source/profiler-original-failure.log`。

`.local/validation/phase6-cpu-profile-fast`同配置30帧capture完整，CPU P50/P95=33.935/45.740ms、GPU pass sum P50/P95=278.945856/286.538592ms、Surface P50/P95=267.839552/274.643296ms；profile相关分类/trie热点消退。两次包含CPU profiler扰动、独立run热状态，不能作为Phase7历史正式收益。最终新鲜build/typecheck及87项targeted通过；最终GPU `.local/validation/phase6-production-cache-fast-final`（8帧32poison/27modules）和`.local/validation/phase6-final-lifecycle`（10项，namespace/recovery差1，scratch峰251430304B，errors=[]）通过。最后非profile timing/detailed仍在采集，不拼接优化前smoke。

最终非profile重跑：`.local/validation/phase6-final-showcase-no-drift`，timing3/detailed1完整；coverage pass、errors/API/timestamp/drop=0、sourceDrift=false，每测量帧唯一Renderer submit。timing CPU/GPU pass sum/span/Surface P50=32.160/269.392512/276.222976/258.584928ms；detailed Surface270.899904ms，diagnostic snapshot32.344896ms单列。之前`phase6-final-showcase`只有全仓diff drift失败，runtime指纹变动=[]（采集时更新文档），原报告保留并原用例重跑，不改runner断言。最后生产源码不再变；实现、正确性/真实接线、成本/结构矩阵核对通过。历史上方“待测/在测”均为实施记录，不覆盖此最终收口。
