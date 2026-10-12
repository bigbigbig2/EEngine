---
id: final-pixel-phase5-integration-2026-10-12
state: history
---

# V5 Phase 5：完整集成、退休与联合成本

用户明确授权进入 Phase 5，完成后停在 Phase 6 边界。实施基线 `acecfab2495a4b5c6d5420efc9f1d2083abe6bb0`；本次不修改 production shader 数学、不更换 AMD profile，不恢复 S3、Facts、native scatter 或第二 Native backend。本文记录实验事实，状态只读 Execution §8.1。

## DELETE / ADD 与寿命闭包

DELETE：成功 empty replacement 后无 consumer 的 Seed、Surface execution storage、local-light/lighting frame pools；成功 all-unlit replacement 后无 consumer 的 lighting frame pools；关闭 PhysicalEnvironment epoch 中无消费者的 VSM allocation/pass owners/shadow Geometry demand；验证链中仍使用生产 FSR 处理 1:1 的残留接线、两输出对照 Surface；被销毁 allocation 的 LocalLightWork frame/bind references。旧 Shadow/Facts/NativeTemporalPasses 已由前 Phase 删除，不为凑 Phase 新建 helper 或 shader pass。

ADD：可复用 owner 的 fence retirement 入口、Native V2/FSR 物理账本、失败分配 rollback、无环境时按需8B零辐射 IBL 绑定、完整组合与全 API audit。没有新增跨pass texture 产品、fullscreen pass、GPU history、copy、atomic、barrier 或 submit。

| 成本 | DELETE | ADD / 边界 |
|---|---|---|
| empty Seed 容量 | `52N`，1080p `107,827,200 B = 102.83 MiB` | 返回场景 cold allocation；pipeline 不重建，旧 allocation 未过 fence 时仍计入 overlap |
| empty Surface | 原 extent execution bins/storage、snapshot bindings；borrowed HDR 不由 Surface 销毁 | 返回场景按完整容量重建；保留极小 neutral bindings 与 shader pipelines |
| inactive lighting | 已分配 frame pool，容量来自真实 lookup/descriptor/light task demand | 未完成提交逐 allocation 标记 retired，最后 fence destroy；不清 VSM residency cache |
| 无 Physical Sun epoch | 全部 VSM atlas/tables/pass owners、receiver/allocate/caster/raster/shadow Geometry demand | 无环境时一个共享1×1 RGBA16F zero texel（8B）、一个sampler；零辐射使全部 IBL lobe 为0，authored/local lighting不变；0/50/100%仅按禁用epoch删除相应VSM成本，不按全天候正常帧声称收益 |
| Temporal accounting | 删除 owner 数字与物理 ledger 不一致的盲区 | create/retire/destroy 时的 CPU Map/ledger；不在 shader/dispatch 增加计数工作 |
| 0/50/100% idle | 0% 不回收活跃 scene 容量；50/100% 仅在成功无 consumer replacement 回收 | 不宣称 idle 释放提高正常 scene GPU 帧率；worst 是频繁空/非空切换的重新分配与旧/新 fence overlap |

empty submit 失败保留历史、角色、allocation；成功后才 retirement。Surface 先放下当前 scene snapshot/绑定，Seed 之后退休；已编码提交持有资源直到自己的最后 fence。重新返回场景的 Seed identity/camera 无旧 validity。lighting pool 的 prepared/encoded 状态不允许直接 idle release。三帧 admission 与原 pool capacity 保持；退休未完成项仍占物理容量，不隐藏旧/新 overlap。Native/FSR 所有 history 和 permanent 小资源均撤账到零；FSR allocate 初始化失败不发布指向已销毁 texture 的 histories。

无Sun删除的容量下界为high depth atlas `4096²×4=64MiB` 或bounded `2048²×4=16MiB`，另有对应tables/records；ADD只有无IBL时8B texel及sampler，不新增dispatch/atomics/barrier。ideal/expected在禁用epoch均无VSM需求，worst返回另一启用配置需要重新初始化owner；正常启用epoch收益0。原无Sun+authored IBL可生成无consumer VSM工作；原无Sun+无IBL则在lowering先报错，不能虚报该失败配置已经完成旧GPU帧或声称测得删除时间。新中立绑定修复的是后者的真实功能缺口。

## 合并后的物理图与 live state

Native 1:1：Geometry/Visibility → VSM receiver/allocate/caster/raster/content/descriptor → local-light work + Solar publication → Native 唯一 resolve（Seed + material/local/IBL + fused point-PCF Sun）→ Sky/Aerial → V2 Measure/Exposure/Shading Pyramid/Analyze/Resolve/RCAS → Radiometry/Present。GTAO/Bloom 按需求接入。true upscale 独占 FSR graph；bypass 没有颜色 writer。native debug classifier 仅在实际要求时出现，与 V2 共用一个 previous-identity import。

联合 DELETE：Shadow Resolve full-I dispatch、其第二 geometry/position/normal recovery、mask store/read/dependency；Facts full-I dispatch 与第三 geometry/instance/material recovery；native Prepare/scatter/clear/原 SPD/旧 T3 owner。PCF tap、VSM residency、source material/几何数学和 true-upscale scatter 没有删除。

联合 ADD 不能漏算：Native plane-ray position、Seed `36B/pixel` 输出（旧 Native+Facts `32B`）、previous-view transforms/identity、per-pixel descriptor lookup、Solar manual half bilinear、late Sun response live state；V2 foreground receiver 3×3 Seed search、`4B/pixel` receiver index、reference exposure/statistics/shading/lock/clamp/resolve。全域 store/clear 逻辑下限仍 `68.8125 vs 69 B/pixel`；persistent identity/color profile `78 vs 70 B/pixel`，**没有 history capacity savings**。本次 idle retirement 不改变 active 格式。

Source 审核：Seed 使用 ABI 已预先发布的 previous-from-current affine 三行，**没有每像素求逆矩阵**；不能以错误源码假设解释回归。Seed 不读 previous identity；写后临时 previous-view/clip 应结束。late Native 在 PCF 前结束 interpolation/material scope，携带 local/IBL 两个 RGB、receiver facts 与 DirectPhysicalResponse；coat、遮挡缩放后的 finite guard 和 `(local + Sun) + IBL` 保持。Product + compact + lit 完整 profile 仍四 bind groups、`15+Bm` storage buffers，最低 16 sampled / 16 storage buffers / 4 storage textures profile 闭合；无 continuation、packet 或额外 binding。Source scope 不证明 driver register/spill/occupancy，当前无硬件计数。

V2 Analyze/Resolve sampled footprint 11/10；Measure 的 16 KiB workgroup reduction、Shading Pyramid 672 B working set 没有因 integration 增长。Native live state、3×3 Seed traffic 与真实场景 Temporal confidence/resolve 均是可能成本来源，不能由桶归属推出已证明的硬件根因。

## 验证与保留失败

production build/typecheck/declarations、fresh build:test；64 项 targeted Node 全通过，零 skip。涵盖 source cutover guard、FrameProgram、Surface/Seed release/return、Native/FSR candidate/active/retiring ledger、history upload failure、abort/resize/cache/three-inflight、lighting pool fence。新增 LocalLightWork idle retirement 证明旧提交等待自身fence、返回场景分配不覆盖旧帧、迟到完成不销毁新帧、stale frame拒绝。

Product topology guard 原扫描把生成 Dungeon bundle 内 Renderer ordinary-scene recovery 方法当 authored Product consumer；改为只扫 authored consumer source，compiled public exports 仍独立检查，未恢复旧 public exports。原失败保留 `.local/phase5-node-final-v1.txt`；v3暴露旧FrameProgram测试允许无Sun而仍生成shadow Geometry，与实际无consumer结构相符；改为disabled profile无shadow产品、enabled profile明确reject。最终 `.local/phase5-node-final-v5.txt`，64/64。

GPU 全串行。最终 actual Renderer ordinary、Product、multiProduct、authored IBL、最低完整 Product resource profile，通过 native ↔ 非整数 upscale ↔ bypass、VSM/AO/Bloom on/off、unlit、MASK/normal/ORM/coat/local lights、motion/identity validity/shadow debug、空场景失败/成功/返回、cut/resize/abort/retry/three-inflight/defer/cache/device epoch。old epoch 与最终 teardown 的全显式 API bytes 为 **0**；audit 包括所有 owner、uploads、transient 与诊断 readbacks，排除 canvas/driver/OS allocation。ordinary 诊断 overlap peak `271,197,137B` 包含大批读回，不当作正常 Renderer 容量。

独立 Shadow quality、Sun response、pull semantics 通过；1920×1080 六 family ×256成功帧 ×8 ROI 的最终数学矩阵通过，共1536帧，`failures=[]`，门/输入/ROI未放宽。最后 lifecycle 小改动只删除被销毁 frame references，Shader 字节与数学没有变；最终 actual Renderer 重跑覆盖该 build。矩阵为 synthetic 动态 Temporal，真实 material/HDR 另由 actual Renderer/writer 核查；不替代完整 authored Dungeon 动态 ROI/人工显示资格。

原失败保留：`phase5-native-production-v1.json` / resource-profile-v1 宿主白名单；resource-profile-v2 的旧 native FSR 入口；v3 的 fixture previousIdentity 未接线。迁到实际 Native V2 后 v4 通过，旧 Phase3 oracle 的 T3 仅使用 pinned test reference。`phase5-final-lighting-dynamics-v1.json` 的两输出对照迁到四输出/private Seed 后 v2 通过；`phase5-final-native-surface-acceptance-v2.json` 的不同 jitter 相位 coverage 比较通过相位对齐重跑，原数值断言不删、不放宽。

补充真实feature需求验证 `.local/phase5-final-feature-demand-v6.json`：无Physical Sun+中立环境、无Sun+authored IBL、bounded PhysicalSun三个Renderer均通过domain往返、unlit/lit返回、调用方暂停/单步、finite且非零HDR和最终API release0。bounded通过GPUDevice能力上限投影2048测试真实production资源/图；所有真实WebGPU调用仍由实际device执行，canvas configure明确解包实际device，不伪造GPU结果。core默认limit会钳制更低request，故**不声称真实低能力adapter协商或该设备只能bounded**。

原新增验证失败按次保留：feature-demand-v1发现production无环境lit要求不存在IBL provider，已补按需8B零辐射provider；v2 fixture直接写private scale没有resize，改公开setResolutionScale；v3灯朝向与可见正面正交，增加明确照亮正面的directional/point receiver fixture；v4复用已销毁device的consumed adapter，改各epoch独立requestAdapter；v5 capability proxy跨WebIDL canvas边界不合法，configure解包实际device；v6通过。只有v1属于production集成缺口，其他为新增fixture/宿主错误；原断言未跳过。

最终条件需求修正后，重跑actual ordinary/Product/multiProduct/authored IBL/minimum resource profile，五项均通过，文件为 `.local/phase5-final-{native-surface-production,native-surface-product-production,native-surface-multi-product-production,native-authored-ibl-production,native-surface-resource-profile}-v2.json`。对应最终production source SHA256 `7f4abbbafd17688ce121267f2ebe47efc29008c74546843a6d62443ba9f9ab42`，test-build output SHA256 `0203805adc8b444efbb2c82f2ec60d33717ef7d4261182c132b0872b0a6e0d35`。早期完整quality矩阵与acceptance的数学未变，由raw中的各自build identity区分，不冒称同一exact build。

## 有限 Dungeon ABBA：未获净性能资格

Before 是新 detached `49fcaa300fafcbbe3db142df403baa3487f89956` 与 fresh Dungeon build；After 是本次 Phase5 working tree 与 fresh build。两侧相同 runner；baseline 除诊断 host 修正外 production source 不改。原 cooked assets、1080p/DPR1/scale1、high4096/6clips/4×4 point-PCF/radius.75、AA/RCAS、AO/Bloom OFF、geometry512MiB、settled near、cameraFactor.15/offset(-7,-2,-7) 不变。GPU 串行 A1/B1/B2/A2；每 run240帧/interval4，**60个完整 target GPU samples**。runner 面板 stable 子窗口不是 target 完整窗口，下面从 raw 重算。

| Run | whole P50 / P95 / P99 ms | receiver→last Native P50 ms | Native / all VSM / Temporal P50 ms |
|---|---|---:|---|
| A1 | 18.958 / 42.098 / 57.389 | 9.959 | 4.931 / 3.883 / 4.774 |
| B1 | 22.324 / 58.104 / 122.662 | 12.306 | 9.762 / 1.344 / 6.659 |
| B2 | 25.542 / 27.724 / 27.880 | 13.946 | 11.034 / 1.494 / 7.519 |
| A2 | 25.654 / 28.377 / 28.460 | 13.467 | 6.806 / 5.162 / 6.473 |

Temporal 含全部本域 pass 与 RCAS，Facts 单列 Before P50 `.680/.844ms`、After0；Shadow Resolve Before `2.596/3.446ms`、After0，PCF转入Native。互斥 pass 每frame先求和，envelope从真实 ticks求，再用 `(n−1)*p` 插值分位；不相加阶段 P95。After graph 的 native Prepare/scatter/classifier/old T3 为零。覆盖 `.90657–.90708`、invalid0、GPU错误0，无裁工作。

这不是稳定净收益：B1 比 A1 慢，B2 与 A2 接近；完整融合 envelope 与 Temporal scene cost 没有明确 break-even。A1/B1/B2/A2 full-window temperature 分别90–91/88–91/90–91/90–91°C、graphics1065–1305/930–1350/885–1350/795–1350MHz，SW thermal Active。热态与频率非同条件，不归一化成“收益”，也不借此把负观察追认为通过。Phase4 synthetic unit 正收益不外推此 Dungeon。

API simultaneous peak：Before `1,437,586,709B`，After `1,290,497,621B`，相差 `147,089,088B = 140.27MiB`；这只是此次固定窗口全部 API 容量的差，不能解释为 persistent history 格式缩减或 idle release 本身带来的正常场景节省。driver memory full-window Before2287–2307MiB、After2182–2203MiB，仅作观测，不代替全域4GB/OS dedicated/shared资格。NVML 与 CDP报告 GTX1650Ti4GB/driver581.42，requestAdapter 的精确 device/description 为空；Chrome154.0.8037.98，不推断锁频。

raw：`.local/phase5-cost-v2-{A1,B1,B2,A2}/` 的 `full/suite/source-fingerprint/build-fingerprint/maps/sensors`；汇总 `.local/phase5-cost-v2-summary.json`。原固定5186端口 EACCES 启动失败没有GPU样本，保留 `.local/phase5-cost-A1/`；runner改 OS 动态端口与 reject，不改变场景或GPU工作。

最终无Sun条件需求修正/中立provider晚于本次ABBA；原source/build fingerprint保留，不冒称最终提交exact build性能。默认启用PhysicalSun的benchmark图/shader数学未改；最终glue由最终build实际Renderer覆盖，Phase6仍需重新fresh benchmark。

## 出口限制

完整产品/consumer/retirement/correctness 集成已发生；联合成本已实际检查，**性能候选仍未资格**。不得将 Phase2/3/4 未通过成本在 Phase5 换名成通过，不宣称60FPS、不说后续集成本身必然兑现收益。

下一工作边界为 Phase6：正式长窗、至少3 ABBA块/每path每块1000完整samples、tail/thermal、全 authored 动态质量及4GB/OS驻留资格。若需改 shader candidate，返回对应 unit 完整验证再集中测；此短窗既不能否定冻结架构，也不能证明架构已合格。当前结果没有获准算法/质量缩水、front-end重构或恢复旧路径。
