---
id: performance/vsm-receiver-word-aggregation-2026-10-11
state: current
verifies:
  files:
    - OEngine/src/shaders/vsm_receiver_demand.ts
    - OEngine/src/render/vsm/VsmReceiverDemandPass.ts
    - OEngine/src/render/vsm/VsmCapabilities.ts
    - OEngine/tests/oracle/vsm-receiver-aggregation-gpu.mjs
    - OEngine/tests/oracle/performance-diagnostic-gpu.mjs
    - OEngine/tests/oracle/vsm-v4-r2-gpu.mjs
    - OEngine/tests/contract/performance-diagnostic-shaders.test.mjs
    - validation/tools/vsm-receiver-statistics.mjs
    - validation/tools/vsm-receiver-statistics.test.mjs
    - tools/gpu-oracle/registry.mjs
---

# VSM receiver：精确 workgroup word 聚合

**采用这一项局部生产优化：receiver pass 六轮 After P50 为0.983–1.249ms，上一阶段三轮为1.927–2.277ms。没有证据宣称整帧稳定变快或达到60FPS。** 起始HEAD `eaa098958ffbd8e206ea7bcb458ef9cc3f0a6ea0`，原PCF保持不变，本轮只改变receiver请求发布方式。

Before使用[原总报告](2026-10-10-dungeon-warkarma-performance-report.md)及[上一阶段完整G](2026-10-11-dungeon-native-vsm-cost-unit.md)，未重复旧baseline。全部raw、失败、传感器、source/build fingerprint、oracle、截图和实施前Cost Card保存于 `.local/validation/vsm-word-aggregation-2026-10-11/`，不提交原始采样。所有GPU作业串行，无outlier删除。

## 实现与成本依据

【源码事实】`VsmReceiverDemandPass.addToGraph`仍然clear同一requested bitset，在原compute pass内先dispatch8×8 receiver，再dispatch完整coarse覆盖。新数据流为：原receiver predicate/depth/winner/instance验证→逆VP与clip投影→完整virtual page→组内word/mask聚合→原requested bitset→`VsmAllocatePagesPass` count/prefix/scatter/touch/allocate/publish dirty→caster/raster/content commit→Native采样。绑定、reset、resource容量、FrameGraph依赖及frame submit均未改变。

【源码事实/数学】64slot组内表存full u32 `page/32+1`和完整32bit mask，0为空。即使page取任意合法u32，word+1也不会溢出；没有截断page/clip/generation。线性探测最多64次weak-CAS attempt，空slot的spurious failure不前移。成功占位或遇到相同key后atomicOr组内mask；耗尽则立即向原global bitset发布该lane的原bit。全部lane无条件到同一barrier，再每slot由一个lane发布。碰撞、full table或spurious failure最多损失合并机会，不损失请求。每非空slot至少对应一个成功合并lane，因此slot发布数+fallback发布数不超过原有效lane数。

组内存由WGSL初始化为0，每次dispatch/workgroup独立，不存在history或跨帧清表。显式barrier一个；driver的隐式零初始化成本也必须计入实测，不能当免费。partial/empty组不在main提前return，退出谓词放在返回invalid sentinel的`receiver_page`中。`mark_coarse`没有改动；它不会执行receiver helper。现有VSM profile要求workgroup storage≥1024B，已覆盖生产512B与诊断784B，不新增可选subgroup能力要求。

【参考核对】[WickedEngine visibility_resolveCS.hlsl::main](https://github.com/turanszkij/WickedEngine/blob/df44c3db4c4927492bc9c791eac715d98d7ed091/WickedEngine/shaders/visibility_resolveCS.hlsl)，revision `df44c3db4c4927492bc9c791eac715d98d7ed091`，[MIT许可证](https://github.com/turanszkij/WickedEngine/blob/df44c3db4c4927492bc9c791eac715d98d7ed091/LICENSE.txt)：WaveActiveBitOr→组内InterlockedOr→barrier→每bin一次全局发布。已阅读真实源并保存。参考的是局部合并后发布的执行方式；上游wave、小bin全集和bindless假设不适合直接移植。本地hash为自主portable WGSL，也核对了既有`native_execution_bins.ts`的局部hash；不声称移植上游VSM实现。

实施前Cost Card：

| 项目 | 删除 / 新增与边界 |
|---|---|
| Global工作 | 原每有效pixel一次4B atomicOr RMW attempt，通常每64lane降为约1.116次word发布；未删除receiver读取、projection、page定位或coarse工作 |
| Bytes / 访问 | 1080p原4B operand累计8,294,400B，新统计约144,616–144,672B；这是逻辑操作数字，不是DRAM节约量。原全局竞争访问转为组内atomic竞争+少量global OR |
| 新增ALU/atomic | hash乘/掩码、key比较、probe循环；每有效lane至少一次local CAS+一次local OR，每组64key读取、每非空slot一次mask读取。最坏4096 CAS attempts/group |
| 同步 / working set | 512B组内key/mask表及零初始化、一个显式uniform barrier；无新buffer/texture/history/persistent资源。诊断另加272B组内存及两次barrier，计时关闭 |
| CPU / dispatch | 新增CPU分配、绑定、pipeline数量、pass、dispatch、submit均0；predicate改为helper以保证barrier一致性 |
| 最好 / 通常 / 最坏 | 全组同word，global64→1；本近景约64→1.116；64不同word/冲突链或CAS耗尽时global仍可达64且支付聚合税。空/稀疏组也支付组内存、64key读取及barrier |
| Break-even | 节省global RMW竞争必须超过local atomics/probe/初始化/barrier及register/occupancy代价；0收益或回退都可能。没有依据承诺50%整pass收益；100%不可能，因为原读取/投影未删。原receiver整pass1.9–2.3ms只给绝对上限 |

【实测事实】三帧独立instrumented统计如下。诊断private记录第四word由原`raw−uniquePages`改为实际global attempt数；shader、oracle、CPU summarizer全部同时迁移，重复数从raw/pages派生。关闭诊断时不存在计数atomic或诊断buffer。下表不用于timing。

| 指标 | #1 | #2 | #3 |
|---|---:|---:|---:|
| raw有效receiver | 2,073,600 | 2,073,600 | 2,073,600 |
| 实际receiver global atomicOr | 36,154 | 36,161 | 36,168 |
| sum workgroup unique words | 36,154 | 36,161 | 36,168 |
| global fine pages / words | 323 / 39 | 324 / 39 | 324 / 39 |
| 组内word重复率 | 98.2565% | 98.2561% | 98.2558% |
| 独立coarse fallback pages | 114 | 114 | 114 |

【合理推断】本近景实际global attempts与每组unique words完全相同，支持正常样本没有耗尽fallback额外发布；约36K是按组总数，不是全局39次。不能外推全运动/高entropy场景收益，也不能据此推断所有receiver成本都来自atomic。

## 同条件 After 与限制

固定原近景camera position `(0.303839,6.044173,-2.558241)`、target `(-4.412154,0.935180,-6.220996)`、FOV60，GTX1650Ti4GB、1920×1080/internal=output、DPR1/renderScale1，VSM high4096²/6clips/4×4/radius0.75、FSR/jitter/HZB/cone ON、GTAO/Bloom OFF、原材质和太阳。使用`performanceCapture=1` max-throughput。每轮预热至少60成功提交帧，窗口精确240帧、每4帧timestamp一次，完整GPU n=60。每次audit模型真实coverage≥80%，本轮约90.657–90.708%、invalid key0。

| 指标（ms，三轮） | 上一阶段G Before | After | After复测 |
|---|---|---|---|
| Receiver P50 | 1.927 / 2.007 / 2.277 | 1.149 / 0.983 / 1.171 | 1.249 / 1.170 / 1.237 |
| Receiver P95 | 2.911 / 2.777 / 2.853 | 2.822 / 3.772 / 1.835 | 2.529 / 1.200 / 1.883 |
| Native P50 | 10.345 / 10.897 / 11.974 | 10.966 / 10.977 / 12.713 | 11.589 / 12.943 / 13.818 |
| Temporal stage P50 | 6.097 / 6.483 / 7.095 | 10.803 / 11.004 / 7.022 | 6.159 / 7.141 / 7.513 |
| GPU command span P50 | 37.689 / 24.245 / 26.622 | 26.669 / 26.830 / 26.364 | 41.735 / 26.456 / 27.917 |
| GPU command span P95 | 91.576 / 52.084 / 28.000 | 58.836 / 61.649 / 44.804 | 46.613 / 27.422 / 34.041 |
| CPU同步render P50/P95 | 2.895/4.460；2.280/3.675；2.355/3.515 | 3.130/5.620；2.395/3.850；2.550/3.905 | 3.255/4.705；2.440/4.235；2.630/5.280 |
| graphics MHz P50（稀疏采样） | 810 / 705 / 945 | 300 / 1080 / 780 | 1050 / 900 / 900 |

【实测事实】首组三轮每帧receiver/Native时间比的P50：Before0.1894/0.1894/0.1901，After0.1042/0.0899/0.0894。这是同帧比值的分位数，不是两个P50相除，也不是频率归一化。六轮receiver中位时间均较低，支持保留该局部优化；P95并非所有轮改善。

所有轮thermal slowdown Active，温度约89–91°C，未锁频。API live约2348.37MiB（含审计驻留资源，普通主报告约2348.30MiB），Before/After一致，没有新增长期GPU容量。但Windows counter窗口专用/共享GPU内存从Before约2584/159MiB变为After约1647/1067MiB、复测约1664/1050MiB；Chrome工作集从约1665MiB变为2942–3142MiB，private commit仍约3.7GiB。**API容量、OS GPU residency和CPU工作集是不同指标。**

【待验证】不同热状态、显存驻留变化、驱动/OS调度可能影响未改动的Native/Temporal与整帧；未取得逐资源residency/page-fault证据，不能宣称已证明GPU分页，更不能把全帧回退都归因于它。Temporal前两轮约11ms，复测回到6.16–7.51ms；Native复测偏高仍保留。没有匹配热/驻留状态的精确整帧收益，不能给整体加速百分比、稳定60FPS或Presented FPS。

main/shadow ring丢槽Before完整窗口累计4/12/17/24，After36/218/255/265/274（含normal窗口），复测201/241/255/438；明显升高，未隐藏。GPU geometry demandOverflow/malformed和streaming lastError仍0/空；resident总1207/pinned381，eviction/reload/failed0。ring丢槽原因未闭合，不将其当作无害0值或证明scheduler变快。唯一生产修改在GPU receiver局部发布，未改变CPU readback、admission或feedback completeness；本轮没有扩大为CPU调度修复。

counter窗口shadedPixels2,073,600、MeshletWork605；Before与首组After请求header均total440/overflow0，dirty0，allocation failures0；coarse仍完整。截图目检材质、几何和阴影无明显变化，未宣称Dungeon图片逐像素bit-exact。CPU与GPU重叠，不相加；不同pass的P50不能求和；采样计时与instrumented统计分开，提交吞吐仍不是Presented FPS。

## 正确性、生命周期与完成边界

【实测事实】新GPU oracle直接运行生产聚合fragment，136个独立word域防止测试之间掩盖漏bit：同page、同word全部32bits、64distinct words、64个同hash槽/full table、invalid/empty、单有效lane、mixed、128随机组、partial tail。三个正常/单probe/零probe版本各重复3次，每次精确比较557,056个u32 word；缩短probe仅在oracle注入，验证partial和全部耗尽的原请求发布。另验证后续empty dispatch不会保留旧mask/bit。

诊断GPU oracle对独立CPU Set计数/bitset通过；R2真实receiver→scan→allocator，full fine/coarse coverage、rolling clip、同epoch回收、overflow、empty completion与pre-submit abort/retry通过；R3 caster容量、gutter、partition failure/empty completion、abort/retry通过；Native integration含VSM coverage及HDR/motion/FSR接线通过。

保留失败：上游LICENSE路径最初404后读取真实LICENSE.txt；R2测试stub缺color导致WGSL编译失败，按现有生产sampling debug helper补齐字段及constructor后通过，没有修改生产sampling或放宽assertion。最终新鲜build:test、typecheck、普通Dungeon build、31 targeted、最终聚合GPU oracle、诊断GPU oracle通过；docs verify/diff检查在提交前完成。

【源码复核】requested writer仍由唯一receiver owner clear/produce，OR为集合语义；完整page/word/mask保持不变。下游generation/clip/namespace、overflow、dirty/ready publication与retry/retire未改。组内scratch不参与资源resize/destroy，无额外device-loss恢复产品；现有VSM资源仍由原owner销毁/重建。没有新增CPU-visible控制闭环、submit、per-material scan、runtime A/B或持久cache/history。

未跑正式全Renderer画质/baseline suite、持续运动/太阳变化压力benchmark、受控GPU device-loss重建、锁频/冷却/显存驻留实验，未获得register/spill/occupancy/cache计数。最坏entropy正确性有GPU覆盖，但尚无广泛场景性能结论。**到此关闭receiver聚合单元并停止；不自行开始Native、VSM sampling、FSR或Memory重构。**
