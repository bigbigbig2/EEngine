---
id: performance/dungeon-native-vsm-cost-unit-2026-10-11
state: current
verifies:
  files:
    - OEngine/src/shaders/native_surface.ts
    - OEngine/src/shaders/native_material.ts
    - OEngine/src/shaders/native_surface_lighting.ts
    - OEngine/src/shaders/vsm_sampling.ts
    - OEngine/src/shaders/vsm_receiver_demand.ts
    - OEngine/src/render/vsm/VsmReceiverDemandPass.ts
    - OEngine/src/render/passes/fsr3/Fsr3UpscalerRuntime.ts
    - OEngine/tests/contract/performance-diagnostic-shaders.test.mjs
    - OEngine/tests/oracle/vsm-v4-r3-gpu.mjs
    - validation/tools/run-dungeon-performance.mjs
    - validation/tools/dungeon-gpu-audit.mjs
---

# Dungeon Native/VSM：第三阶段成本定位与被拒绝的 PCF 实验

**本轮以诊断结论完成，不提交没有净收益证据的 GPU 优化。** 起始 HEAD `9afd6ad787ab7e8be983574b964803b881b173ba`。接受 [既有报告](2026-10-10-dungeon-warkarma-performance-report.md) 为总 Before，没有重跑完整 baseline suite。新增中心输入 B0 编译期切片，沿用 A–G、VSM 统计和既有 FSR timestamps。试验过唯一候选 PCF 整数 texel 精确去重：数值正确，但 Native timing 回退，已撤回生产改动。

全部 raw、失败、截图、传感器、build/source fingerprint、分析、被拒绝候选源码及 oracle 存于 [.local/validation/dungeon-native-vsm-stage3-2026-10-11](<D:/code/EEngine - 副本/.local/validation/dungeon-native-vsm-stage3-2026-10-11>)，不提交原始采样。GPU 作业串行，未删 outlier。最终普通 Dungeon 已重新构建；`vsm_sampling.ts` 与起始 HEAD 相同。

## Gate 与测量条件

【源码事实】检查 `9afd6ad7`、`bc38aa0b` 和此前 canonical 改动的真实 diff/消费者：main/shadow 都在 `GeometryPageStreamingRuntime.consumeCompleted` 中一次 `ingestDemandReadback` 解码，返回 numeric batch 给 scheduler/residency。四个独立 u32 保留完整 slot/generation/page/priority_flags。scheduler 用 unique indices，residency 保留 raw 次数和顺序；`touchPage` 会累加 visibleFrequency，不能假定幂等。Product-local numeric operation Map/global insertion-order Set 保留取消、退休、迟到 IO 的删除/身份检查。不存在 production dual path，未发现需要 closure commit 的 Geometry 缺陷。

【实测事实】新鲜 build:test 上 Gate 的 demand ABI/replay/scheduler/runtime/identity **41 项通过**。核对上一任务 raw CPU profile：7.398754s、consumeCompleted inclusive456.908ms（61.755ms/秒）、ingest154.668ms（20.905ms/秒）、residency167.931ms（22.697ms/秒），与上一提交说明一致；不能宣称总体 CPU 加速，相比更早 canonical 的 consume52.53–54.27ms/秒并未改善。本轮最终另有49项 Orbit/pacing、Native/publication/temporal、VSM targeted checks 通过，未改交互路径。

【实测事实】本轮固定近景 camera position `(0.303839,6.044173,-2.558241)`、target `(-4.412154,0.935180,-6.220996)`、FOV60；GTX1650Ti4GB、1920×1080、DPR1、renderScale1、VSM high/4×4/radius0.75、FSR/jitter/HZB/cone ON、GTAO/Bloom OFF、默认材质/太阳。runner 使用 `performanceCapture=1` 的 max-throughput 路径，非 interactive RAF 口径。Dungeon 自身覆盖约90.657–90.708%，每个 capture 独立检查模型 instance 像素和 camera；invalid key=0。counter窗口 shadedPixels2,073,600、MeshletWork605；resident1,207、pinned381、eviction/reload/failed0、streaming error空。

main/shadow readback ring 的丢槽计数并非0：完整G四个窗口累计4/12/17/24，候选 After 五个窗口4/7/13/17/22。GPU demandOverflow、malformed 均为0。它们是不同计数，原有 main/shadow completeness、延迟 eviction 防护未改；不能用 demandOverflow=0 掩盖 ring 丢槽。

每个 slice 三轮各精确240提交帧，每4帧采GPU一次，各60个完整非 truncated Native timestamp。提前预热至少60提交帧；相同 bins/material分布、winner过滤和dispatch域，Native时间聚合同帧全部同名pass，排除bins初始化/classify。89–91°C为主、全轮 thermal slowdown Active；采样频率稀疏且graphics clocks大幅波动（完整G300–1170MHz）。未锁频、未用频率粗暴归一化。

提交FPS不等于Presented FPS；completion不等于GPU执行时间。CPU同步render不含全部异步CPU成本；CPU/GPU重叠，跨pass分位数不相加。切片输出改变Temporal输入和全局热负载，只用Native自身时间定位，不能把其整帧差值归因给Native。

## Native、VSM 与 FSR 成本图

【实测事实】下表是**累计变体时间，差分定位数据，不可逐项相加**。

| Native累计variant | P50三轮 ms | P95三轮 ms |
|---|---|---|
| A：winner/reconstruction/interpolation anchor | 2.224 / 2.319 / 2.474 | 2.738 / 5.181 / 3.430 |
| B0：A + required center material inputs | 2.397 / 2.401 / 2.556 | 3.351 / 3.978 / 5.063 |
| B：A + center/x/y inputs、explicit footprints | 2.812 / 3.159 / 3.044 | 4.983 / 5.042 / 7.544 |
| C：B + material samples/evaluation anchor | 3.508 / 3.932 / 4.232 | 6.883 / 9.682 / 14.523 |
| D：mapped basis/BRDF/local、单位白光 incident | 3.995 / 4.355 / 4.528 | 10.383 / 26.986 / 9.599 |
| E：D + IBL | 5.989 / 6.795 / 7.129 | 13.144 / 10.294 / 13.026 |
| F：真实Sun irradiance，省去Sun VSM | 6.222 / 6.582 / 6.805 | 12.558 / 17.038 / 30.064 |
| G：完整生产Sun/VSM lookup/bias/PCF | 10.345 / 10.897 / 11.974 | 28.801 / 24.756 / 12.951 |

【源码事实】`GpuNativeMaterialScene.snapshot` → `nativeSurfacePublicationDescriptors/nativeSurfaceWgsl` 在publication编译时选择切片，`SurfaceV4.encode`仍以同一ExecutionBin队列dispatch。默认唯一G，无常规逐帧切片分支或诊断atomic；非G遇到resource-limited additiveSun显式拒绝，不能假装测了另一种profile。B0只消费中心输入，B额外保持dx/dy活跃；A–C的dependent anchors避免DCE，但新增ALU/liveness，不是独立生产stage。D/E用单位incident，F替换成真实Sun而非再加一次BRDF；Dungeon authored local lights=0，不能外推有大量local lights的场景。

【源码事实】`surface_geometry_completion` 从winner/raster triangle产品恢复所需corners；`winner_interpolate`用有限一像素差分；`native_material.lowerNativeMaterial`仅将坐标祖先传播到C/X/Y，其他图运算通常只算center。lighting随后取center position/normal/tangent/basis，存在源码层面潜在重复。常量kind/inlining/CSE/DCE可能已消除；没有driver寄存器/occupancy数据，不能证明应手工缓存center。

【合理推断】B0相对A较小，B相对B0更重；E相对D更重，支持IBL也是重要税。但F−E第二/三轮为负，原样保留，不解释成Sun负成本。F→G P50差4.123/4.315/5.169ms仍定位整条VSM分支，包括projection、fine/coarse lookup、identity/fallback、bias、PCF和编译/liveness变化；**不是PCF单独计时或可获得收益**。本轮没有可靠的lookup与PCF独占分割值。

【实测事实】VSM instrumented三帧统计（不取这些帧做timing）：

| 指标 | #1 | #2 | #3 |
|---|---:|---:|---:|
| raw receiver requests / global atomicOr attempts | 2,073,600 | 2,073,600 | 2,073,600 |
| global unique fine receiver pages | 324 | 324 | 323 |
| global unique fine receiver bitset words | 39 | 39 | 39 |
| sum workgroup unique pages | 38,943 | 38,943 | 38,927 |
| sum workgroup unique words | 36,151 | 36,151 | 36,156 |
| workgroup page duplicate ratio | 98.1220% | 98.1220% | 98.1227% |
| workgroup word duplicate ratio | 98.2566% | 98.2566% | 98.2564% |

32,400 active8×8 groups，每组raw64，平均unique page≈1.202、word≈1.116；coarse完整fallback平面另外114页。raw含其他真实receiver，模型覆盖另外审计。global unique从bitset精确排除mip5，即使共用word也不混入；不是全部请求都由receiver像素产生。直链 `receiver demand` → requested bitset → GPU scan/allocate → dirty/caster/raster → sampling未改。

【源码事实】诊断沿生产predicate/projection specialize，原atomicOr仍保留；268B workgroup memory、两次uniform barrier、最多2016对相邻lane比较、每group16B输出，1080p buffer518,416B。只用于暂停帧统计，计时组确认无诊断buffer。三个快照不是运动分布。统计GPU oracle对全重复/全unique/多word/空及边界group/reset独立CPU Set通过。

【合理推断】98%以上组内重复支持workgroup word aggregation值得下一单元验证。约36K是按组汇聚后的global attempt量级，不是全局39次。不能证明receiver约1.9–2.3ms主要全在atomics；重建/projection/访存仍有成本，新workgroup同步/hash也可能吃掉收益。本轮未实施aggregation。

【实测事实】完整G现有FSR timestamps，内部=输出=1080p：

| pass/stage | P50三轮 ms | 工作域（源码） |
|---|---|---|
| Temporal stage整体 | 6.097 / 6.483 / 7.095 | 同帧stage，含Native Facts |
| Native Temporal Facts resolve | 0.660 / 0.684 / 0.755 | internal-full，完整identity/history |
| Prepare Inputs | 0.581 / 0.627 / 0.681 | internal-full |
| Prepare Reactivity（含locks写） | 0.907 / 0.987 / 1.071 | internal dispatch，output-full locks |
| Shading SPD（同帧各层合计） | 0.727 / 0.756 / 0.838 | internal pyramid |
| Luma SPD（同帧各层合计） | 0.170 / 0.180 / 0.196 | internal pyramid |
| Shading Change | 0.051 / 0.053 / 0.058 | internal派生域 |
| Luma Instability | 0.373 / 0.437 / 0.473 | internal-full |
| Accumulate | 2.232 / 2.355 / 2.576 | output-full |
| RCAS | 0.242 / 0.257 / 0.278 | output-full |
| GPU pre-exposure ratio | 0.008 / 0.008 / 0.009 | 一个dispatch |

不能加这些P50重建stage。Clear New Locks为attachment clear，timestamp为0不能证明无工作。`Fsr3UpscalerRuntime.addToGraph`已有完整chain；color history双缓冲为output-full、luma/history/accumulation为internal-full。1:1没有移除时域抗锯齿功能，Accumulate/RCAS成本不会随着未来内部降分辨率等比降低。本轮不改FSR。

## 唯一候选、Cost Card 与拒绝理由

初选顺序：①PCF整数texel精确去重（Native VSM分支较大、局部且无新产品）；②receiver word aggregation（重复证据强、需要同步/聚合成本验证）。没有选择center basis缓存，也没有扩大到IBL/FSR重构。

【源码事实/数学推导】默认4×4、width1.5，轴offset为−.5625/−.1875/.1875/.5625，floor/clamp后通常每轴2–3整数坐标，4–9二维unique texel。候选以轴单调坐标run-length分组，对每unique texel只比较一次，按x/y tap multiplicity乘积加权/16，仍是原box filter。保留原offset运算次序、atlas helper、gutter clamp、reverse-Z zero、reference+bias、完整lookup/fallback；不改质量或tap数量。

实施前Cost Card保存在raw目录：默认删除7–12逻辑textureLoad及12次重复二维地址/取整，4B返回值64B→16–36B；这是逻辑返回字节，不是DRAM节省预测，重复地址可能已命中cache。新增四个vec4坐标/权重（源码64B invocation-private，不等于物理register数）、两个u32计数、分组比较/权重更新/动态索引和乘法。新增buffer/texture/history/CPU allocation/atomic/barrier/pass/dispatch/submit均0。最好radius0或clamp后16→1；通常4–9；最坏16unique，分组/register/spill/occupancy税可能回退。break-even是删除的指令/地址ALU超过新分组与occupancy税；0收益也完全可能。50%或100%删除整条VSM分支不在本方案能力内；绝对理论上限不超过完整Native pass，实际收益不能从F→G差推导。

参考核对：[Filament](https://github.com/google/filament/blob/f840f1e6aa65ec915f6bc8a2c67869f5ad631e35/shaders/src/surface_shadowing.fs#L35)，revision `f840f1e6aa65ec915f6bc8a2c67869f5ad631e35`，Apache-2.0，`ShadowSample_PCF_Low`用四次硬件比较滤波和Gaussian权重；与本项目点采样box核不同，未移植或声称adopt。候选为自主局部数学分组，portable WGSL，不需要subgroups/comparison sampler。

【实测事实】唯一候选在真实GPU **12,600 case、f32逐值bit-exact**对照冻结旧16tap reference，通过tap1–4、radius0–3、floor ties/邻近f32、pageSize1/8/16、border0/4、slot/gutter/clamp、zero/reverse-Z、负reference及bias；其中6,424阴影case、2,798部分可见case。通过生产Native、Product、集成HDR/motion/FSR/阴影覆盖及VSM R3生命周期oracle。候选前后固定近景截图目检无明显几何、材质或阴影异常，未做Dungeon截图逐像素bit-exact验收。这个数值成功不证明更快。

| GPU指标 | 当前完整G（三轮，候选前） | 候选After（三轮） |
|---|---|---|
| Native P50 ms | 10.345 / 10.897 / 11.974 | 12.664 / 12.903 / 14.625 |
| Native P95 ms | 28.801 / 24.756 / 12.951 | 30.536 / 31.302 / 15.152 |
| command span P50 ms | 37.689 / 24.245 / 26.622 | 25.395 / 25.903 / 30.026 |
| command span P95 ms | 91.576 / 52.084 / 28.000 | 87.034 / 83.282 / 31.078 |
| Temporal P50 ms | 6.097 / 6.483 / 7.095 | 6.200 / 6.639 / 7.706 |
| receiver P50 ms | 1.927 / 2.007 / 2.277 | 1.903 / 2.018 / 2.396 |
| graphics MHz P50（稀疏遥测） | 810 / 705 / 945 | 1065 / 1065 / 855 |
| CPU同步render P50/P95 ms | 2.895/4.460；2.280/3.675；2.355/3.515 | 2.445/3.600；2.340/3.580；2.260/3.390 |

候选After先有一个无timestamp正常窗口，不能与G的首轮预热阶段当逐帧配对实验。均有89–91°C/thermal100%，不能计算精确回退比例。旧总Before代表GPU20.973/Native9.454ms，本轮完整G的频率/command gaps更差，不能包装成代码回退。两个版本API live约2348.30MiB、peak下界约2423.4MiB，驻留/画质/工作量一致；GPU pass时间与command span显著不同，不能混用。

【合理推断】候选三轮Native均较重，前两轮Temporal/receiver接近且遥测频率较高，没有净收益依据；动态vector索引/分组/liveness可能抵消少读texel的收益。没有硬件register/spill/texture-cache计数，**不能断言已证明spill是原因**。拒绝该实现、恢复生产原PCF；不因数量更少强行保留，也不在本轮换第二候选。

## 最终修改、验证与下一单元

最终代码只保留 `native_surface.ts` 的B0、诊断runner/audit的B0识别、切片合同检查；常规G shader和VSM/FSR生产算法保持起始实现。另补齐既有 `vsm-v4-r3-gpu` 的测试incident stub `color` 字段：HEAD shader debug helper已访问color，原stub只有direction，属于测试ABI过期，未放宽任何assertion。

保留失败：首个B0被audit旧单字母正则误识别，修正后新目录重采；实验oracle使用WGSL保留字filter，改名后通过；R3原fixture编译失败，补齐字段后通过；一次尝试未注册oracle selector失败，改跑真实包含VSM coverage的integration入口。所有失败raw均保留。候选oracle/registry条目和生产实现撤回，不留下旧/新生产双路径；源码和oracle作为实验artifact保留。

最终新鲜build:test、普通Dungeon build、typecheck、49项targeted、恢复原PCF后的R3真实GPU检查通过；此前本轮41项Geometry Gate、8切片真实GPU编译/测量、独立receiver统计GPU oracle、候选12,600-case oracle、Native production/Product/integration均实际运行。docs verify和diff检查在提交前完成。未跑全Renderer baseline suite、正式全画质验收、持续运动场景统计、锁频/冷却实验或硬件occupancy/spill counters；不宣称稳定60FPS或Presented FPS。

**下一完整单元建议：receiver bitset word 的workgroup精确聚合。** 先研究成熟GPU局部聚合实现，保证全部64lane统一到barrier、partial/empty group、完整identity/page/word、coarse请求和overflow/lifecycle；再比较无instrumentation实现。当前pass约1.9–2.3ms只是整pass量级上限，不能承诺消掉它。重复率只是选择实验的依据，不是实现会更快的证明。本轮到此停止，不自动进入aggregation、Native或FSR优化。
