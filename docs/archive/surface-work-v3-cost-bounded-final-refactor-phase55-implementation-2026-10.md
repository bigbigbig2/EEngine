---
id: next-execution/surface-work-v3-cost-bounded-final-refactor-phase55-implementation-2026-10
state: history
verifies:
  - OEngine/src
---
# Surface V3 Phase 5.5：前端物理表示与成本补齐

日期：2026-10-05。起点 Phase5提交 `d5783b95`。状态：实施中、未完成。依据最终设计§8/10/13/17.4、执行计划§8.2及复审准备§5；每个替换单元同时迁移producer与全部直接consumer，无兼容桥。

2026-10-05提交更新：本阶段已提交为`7d267d373e3c0d9fd37b0542095003c6eb6b57b1`。退出检查65项targeted、当前GPU组件/八帧32批poison、原1080p timing/detailed均通过；下方“待提交/实施中”描述提交前核对时点。提交前882份OEngine/validation/showcase文件组合指纹为`610cf43eedfe6b8bf65c95607684110ef9adfdf858b3789ff6532a48009646ba`，清单在`.local/validation/phase55-final-source`。Phase6已开始，最终性能/质量仍未验收。

| 条款/缺口 | producer→产品→全部consumer | 独立预期及正常/边界/失败 | 结构/成本检查 | 本次结果 |
|---|---|---|---|---|
| A lazy witness/F02 | Geometry candidate/必要UV point witness/worker union→address及cold→Field hash/equality/support、DomainKey/provider、Signal key、Geometry worker、Store | constant/hit/miss、稀疏dirty、多UV/纹理梯度/非线性CXY、Unknown及memo满；完整身份/精度保留 | N/K/W/G分开；常量不物化field witness，昂贵输入随真正需求增长；同R实际写入 | 24-word identity、18-word UV/12-word Signal witness、setup worker已接线；14语义×3点误差4.77e-7；最终8帧整链通过，空/常量候选和probe为零 |
| B typed result/F03 | shared proof admission→typed result+slot maps→tree/parent、Field support、canonical Store publish | C≤R/2、普通coarse/cache成功、预算满/局部Unknown、canonical完整支持域与parent重判 | 删除geometry/field/persistent三份dense结果；实际写入与typed受理一致；常量直接publication bounds | 52-word×C结果及typed maps替换三份dense池；parent/tree 8场景、7 family indirect queue、8帧 poison通过；proof exhaustion为C=64、rejected>0且mandatory work非零 |
| C formula ref/F04 | lookup/template/source/Store commit→formula transient或显式Store ref→demand、Appearance、Lighting、Signal key、reconstruct | publication/default/zero/fine/grid/mixed/store、pin/generation、失败完整覆盖 | 不初始化21份完整引用；必要Store identity/generation保留；mandatory value slots完整 | transient/publication/default/zero公式与Store slot/gen+mask已由全部直接consumer使用；32批 poison通过；repair Field/Signal lookup 22场景、Store full/reserved/pin/generation 通过 |
| D physical planner/F06 | 最终ABI/资源owner→真实限制项及allocation账→range/batch/frame resources/diagnostics | 小limit/NPOT/retirement/resize、最坏hot+cold、pow2 hash与双输出 | hot128/cold528独立；setup48MiB、address/proof32MiB等真实类别，不用旧profile移账；同R与新R分别报告 | 同R/newR账、独立allocation/limits及FrameResources fence检查通过；R44800/47批、retirementEnvelope为限；GPU createBuffer核对只建一份workspace/record/signal pool，scratch active=277536B、retired=0，已跑1080p成本smoke |
| E cost/F10 | publication finite/dependency decision→DomainKey/radiometry/Lighting→实际signal输出 | 普通transport、异常residual、coat/provider/动态seam、full BRDF+transport | 实际准入拒绝和重复数学/编码/内存；可预合并判断退出热比较，guard保留 | seam publication预合并；20数值+4 provider及真实普通/异常 provider 通过；full/shared/transport-only=7/1/9；8帧整链记录full direct、shared transport、transport-only、residual/transport叶计数 |

共同收口：新鲜typecheck/build/build:test、当前生成WGSL数值/覆盖/真实consumer链；constant/hit/miss/稀疏dirty/proof满/hash-cache满实际产量检查；原1080p timing与独立detailed短smoke。阶段内临时编译失败允许，退出时全部修复。未测、未完成或无consumer均不算通过；正式历史性能/画质仍属Phase7。

来源：重新核读固定CPS `63ad5c1adafbfcc2869a200f50a5ea11f28b4887::ComputeShaderTile.hlsl`、OSS `473a59bbcdd30e3366cc567d66a5a97353620d48::RenderTaskProcessing.compute`、Forge `cd5046893faba2dc7869243873bf01f02a6f0df9::VisibilityBufferShadingUtilities.h.fsl`完整入口和Apache-2.0许可，复核DAIS论文triangle reference/低频分离与插值说明。本次typed pool/slot与lazy physical lowering是本地Bounded Surface Frontend集成；上述donor没有本地三合同/proof/Store完整算法，不宣称完整移植或adoption。

## 当前物理账与验证边界

起点`d5783b956db7ed99dd32c34bf37120851906db0b`，当前为其上未提交工作；此页不标5.5完成。独立历史源码加载与当前ABI/planner比较产物在`.local/validation/phase55-physical-current/physical.json`；当前源码继续变化时该报告身份不会自动转授。

同R=25,536/399tiles：Workspace 38,926,960→18,611,616B；address 14,708,736→2,451,456B，新增独立必要witness预留3,064,320B；三份dense certificate 13,891,584B替换为2,655,744B typed results+2,042,880B maps；显式ref 6,435,072→4,290,048B，另mask204,288B。Geometry仍为单个物理buffer中的128B hot前缀与最坏528B append cold，不宣称两个buffer。容量变化不证明actual writes或帧时收益。

新planner：R44,800/700tiles/47batches；Workspace32,651,456B、setup/refs/memo/control40,598,016B、hot5,734,400B、cold23,654,400B、Field10,752,000B、Signal4,300,800B、Demand6,778,368B、proof indirect112B。总reserve536,663,872B含224MiB persistent上限、双24MiB output及完整scratch退休重叠。control/settings为保守预留，实际allocation和编码计量必须另核对，不能称每个预算字节都已分配。更低binding/profile与NPOT独立测试保留；生产Store当前要求单segment，planner分段结果不证明低binding完整生产能力。

本次新增检查：真实八帧链27模块；对每批cold witness/result/ref注入NaN毒值，32次注入完成，未使用区域保持毒值而HDR、独立closure、cache成功与完整写域通过；各family GPU队列无重复、actual tile范围合法，空/constant帧全零dispatch；第7帧真实proof pool达到64并拒绝可选证明，mandatory closure/Lighting保持非零。1080p timing+detailed smoke完整，timing Surface P50=269.948416ms、GPU pass sum=280.374016ms、frame span=305.376832ms、CPU=50.505ms；detailed Surface=275.41536ms，coverage=pass，errors/timestamp/sourceDrift/drop均为零。detailed中的diagnostic snapshot为有意排除项，单列31.956928ms，不计入Surface timing。

失败保留：typed-first的WGSL保留字、tree-first的四tile map满fixture仅填一tile、proof-family首轮barrier非uniform均已分类修复，原报告不覆盖。一次capacity新断言运行在并行build:test完成前，旧产物缺`demandAndRefs`；生产无修改，顺序fresh build:test→原用例通过。此为harness时点错误，不作生产根因或旧断言退休。

当前已跑31项targeted contract/oracle、34项reset/tree/timing contract；repair Field/Signal lookup、parent、record、Lighting与production GPU checks通过。最新`npm run build`、`npm run build:test`、`git diff --check`通过。最终阶段实现核对、统一fresh回归结果记录与提交仍在收口；未标完成。Phase6/7未开始，正式历史性能、跨浏览器、完整生命周期与连续质量仍未证明。

## Fixture退休映射

旧`repair-demand`、`production-cell/production-orm`、`repair-production`手工接线入口已删除；Git保留历史。144-word地址、三word物理ref、120-word旧Store、旧direct certificate dispatch不是当前ABI，不能通过恢复它们迁就fixture。

| 原语义断言 | 当前入口及独立依据 |
|---|---|
| empty/all-hit/missing-field/dirty-signal实际union与唯一writer | phase5-demand当前生产WGSL；细化37场景，包括全部mandatory mask及collision/probe/CAS/queue/full失败，未删语义断言 |
| Produce后commit才能ref、HDR70000/pin/full/generation | phase5-demand真实Store三dispatch，f32 payload独立等于70000，Produced/Published状态及未提交ref分别断言 |
| ordinary albedo/ORM/full fields/constant/default/zero/细化coarse/source | phase5-production当前classifier→workers→Stores→compose；独立linear-sRGB及ORM数值、非zero closure/provider、各field实际miss写入及hit/publication poison、tree/parent/math独立场景 |
| repeated cache skips自身Appearance、provider改变仍正确HDR | phase5-production8帧，暖缓存有非零hits、未missing字段保持NaN；environment identity更新实际Lighting且未改radiance，HDR逐像素等于前帧；repair-signal-lookup独立检查环境mask42/direct21 |
| E-only/checker/AO/colored residual/partial/empty/unlit | repair-step-one已迁移实际SurfaceReconstructionPass与背景producer；6场景384像素，独立Rec709→Rec2020及π/AO预期全部保留 |
| 固定旧证书全leaf扫描的context/query绝对数量 | 属退休执行模型，不是数值合同；由当前typed受理/实际结果bytes/queue/poison/allocation工作量断言替代，不以更小counter伪装减少 |

迁移失败原报告保留：tree fixture未填写word10预合并Ddirect seam；第一次迁移只更新environment，仍失败；按正常transport完整field seam并集补填后19原场景通过。parent reader提取范围错误纳入新queue producer、引用未声明settings；将提取终点移到queue声明前，8原parent场景通过，生产shader不变。compose第一轮按旧紧缩field slots填值；改formula寻址后保留checker断言；partial失败源于遗漏生产background，切换当前pass后原6场景通过。均未调整数值容差、scope或生产fallback。
