---
id: performance/final-pixel-phase2-cutover-2026-10-12
state: history
verifies:
  files:
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/src/render/surface/SurfaceV4.ts
    - OEngine/src/render/lighting/FinalPixelLightingPublication.ts
    - OEngine/src/shaders/native_surface.ts
    - OEngine/src/shaders/native_resolved_position.ts
    - OEngine/tests/oracle/final-pixel-shadow-quality-gpu.mjs
    - OEngine/tests/oracle/vsm-shadow-receiver-gpu.mjs
    - OEngine/tests/oracle/reference/s3
---

# V5 Phase2：Shadow融合切换与候选返工

Phase1审核结论为无需延期：`9f305c4128b0355614ececbe2be890582d6e8f2d`的非生产闭包、最低binding与生命周期仍有效。本次在用户授权下执行Phase2。生产唯一链已经切到VSM逻辑分离、Native Sun物理融合；receiver数值问题已返工。**整链成本尚未取得净收益资格，Phase2未关闭，Phase3未开始，稳定60FPS未完成。** 目标与状态分别只读[V5 Design](../next-design/eengine-v5-final-pixel-performance-2026-10.md)和[Execution §5](../next-execution/eengine-v5-final-pixel-performance-execution-2026-10.md#5-phase-2--shadow-physical-execution-cutover)。

## 源码与实际切换

基线为上述Phase1提交，分支master；原有`.vscode/`不纳入修改。测试用S3编译JS从该提交冻结在`OEngine/tests/oracle/reference/s3/`，包括Surface、material publication、lighting、geometry completion、resolve和mask decoder。Production不import reference、没有选择器或旧链fallback。引用关系仍可能依赖未变化的数学模块，后续模块退休时须迁移其oracle，不能将reference重新接回runtime。

当前scene链：GPU Scene→既有Geometry/Visibility/HZB→VSM receiver/allocate/shadow geometry/raster/commit/descriptor→固定Solar publication与local lookup→Native bins/一次staged geometry/point-PCF/attributes/material/local/IBL/Sun→NativeTemporalFacts→Sky/Aerial→当前source-style Prepare/SPD+T3 Temporal/RCAS→Radiometry/Present。Geometry frontend与receiver aggregation算法保持；Temporal Seed尚未接生产，旧Facts/Aux/versions/16B directory保留到Phase3。

DELETE：独立`VsmShadowResolvePass`和`vsm_shadow_resolve` production源码、full internal-resolution dispatch、第二receiver position/normal恢复、ShadowVisibility transient/mode/decoder/读写/依赖边；Sun continuation publication/pipeline、第二geometry/material执行、第二HDR及中转copy。旧receiver与PCF数值合同迁到test-only reference及新Native GPU oracle，未删除必须语义断言。

ADD：Native直接消费post-commit atlas/descriptor/constants、原PCF和bias；`FinalPixelLightingPublication`是独立三fence frame scratch owner，VSM/Solar/local各写自己区间，Native只读最终resource version。FrameGraph不把同buffer的各owner别名当独立资源；无VSM/local capacity copy、无新submit。prepare/abort/retry/resize、last-consumer completion、deviceepoch/destroy与memoryEvidence记账均显式闭合。无consumer的Seed未生产分配。

## 数值返工与品质边界

初始重心position候选在1080p页边界失败：position最大误差约`6.6757e-6`，flat visibility RMSE约`.08406`，冻结S3约`.02065`。page离散选择会放大很小的position误差；不能排除页边界或用position容差豁免shadow质量。centered/FMA候选仍有页误判，撤回；原homogeneous interpolation和有限一像素导数保留，没有重构Geometry frontend。

选用同一次resolved world triangle plane与jittered inverse-VP的齐次求交：由clip XY和plane约束求clip Z，再做一次投影除法。Sun、BRDF和非生产Seed共享唯一primary position，不读Depth/邻居，不第二次解析Visibility、instance或几何。精确奇异/非有限结果在原resolved triangle上使用原重心数学，无额外geometry loads。相机inverse-VP由GPU camera拷64B到现有settings，144→208B；显式camera依赖与COPY_SRC/完整624B ABI检查。

短scope候选把weights与dx/dy移到PCF之后，保持完整原插值/validity/LOD数学；没有把source变量数量冒称硬件register数。仅在精确visibility=0时跳过有限材质的零Sun atmosphere/BRDF贡献；完整PCF、tap支持域、其他lighting仍执行。

`final-pixel-shadow-quality`使用1920×1080、四例各256帧，0–63warmup、64–191运动Sun/投影、192–255停止；flat/sloped/perspective/mirrored，所有page边界纳入RMSE/peak/energy，独立解析plane与checker-depth golden，不调用production恢复作为golden。最新候选四例的visibility与boundary RMSE均0；position max约`2.3842e-7`，face normal max约`6.62e-6`。槽内constant depth只测receiver/page选择；nonconstant point multiplicity/gutter/clear/negative-reference由独立sampling oracle覆盖。

receiver补充独立f64线性系统golden，覆盖finite reverse perspective、infinite-far perspective、orthographic及各自奇异plane回退，每域128像素。最大position误差分别约`5.16e-7`、`4.64e-7`、`1.01e-5`，fallback最大`8.18e-7`，全部保留原`2e-4`门。真实Renderer另外覆盖实际相机与HDR消费者。

这些是receiver/Sun子矩阵和组件HDR/MASK/normal/coat/资源组合验证，**不冒称整Renderer完整动态linear-HDR质量矩阵**。A1/B1 Dungeon截图人工检查墙面、薄栏、箱桶、窗户和接触阴影未见明显差异；8bit静态截图不能代替动态HDR/拖尾/收敛门。

## Cost Card

令N=internal像素数、V=实际shaded pixels、D=descriptor count、L=local lookup count。三fence pool每allocation为`align(16D+131072,256)+8L+16` bytes；各logical owner只有直接写区间，Solar固定128KiB copy。1080p high配置D=6×(128²+8²)=98,688（coarse storage axis含rolling双倍窗口）、无local lights时L=1，每allocation1,710,104B，三allocation上限约4.89MiB。该Dungeon窗口实际两份共3,420,208B；不能将它等同三帧最大值。atlas、原Solar LUT与local light data仍有原owner。

| 项 | DELETE | ADD / 保留 |
|---|---|---|
| Full-rate工作 | 一次Shadow dispatch、receiver重建、2 WG barriers/288B shared、mask依赖边 | Native query/原PCF调用；sparse执行无新WG barrier/atomics；不是删除全部PCF耗时 |
| 像素产品 | packed mask N bytes写、Native逻辑4V bytes读、单产品1080p1.98MiB | 无新的per-pixel lighting packet/GBuffer |
| continuation支持域 | 原资源受限route的第二geometry/material、HDR16N逻辑读写与copy/额外HDR | 单shader覆盖同域；不能把没有continuation的scene也计这份收益 |
| binding | mask/mode、Solar texture/sampler slots | atlas/constants替槽、VSM raw sampler+1，目录共用原lookup storage；lit+Product+compact总15+Bm storage，6+M+P sampled；完整Seed仍4 outputs |
| Solar | 原硬件filtered读语义不删 | 128KiB/frame copy+buffer片段；至多四half texel逻辑32B/Sun像素、unpack/manual bilinear ALU，原LUT128KiB仍保留 |
| primary position | 无Depth load/第二geometry resolve | 一matrix-vector、两个plane dot、clip-Z/投影除法、64B camera copy/settings增长；奇异fallback另列稀疏ALU |
| lifetime | 旧mask/continuation owner | bounded三fence pool、范围uniform16B和≤240B padding、准确销毁/记账 |

`gain = T(receiver重建 + mask + boundary + actual continuation) - ΔT(Native查询/PCF live scope + Solar transport + primary position + pool边)`。PCF/descriptor publication/residency/atlas/raster共同项不作为删除收益。0/50/100%删除兑现为0/.5R/R，再扣同一新增税；ideal有正删除项，expected需短scope/cache复用，worst是shader工作集/访问税抵消全部R。没有硬件register/spill/occupancy计数，不能把测量差值归因于已证明的spill。

## 验证结果与原件

所有GPU作业串行，运行时冻结production源码、依赖及fresh build:test。原失败不覆盖；`.local/`保留raw，不提交大结果。Engine typecheck/build与fresh build:test通过；Vite只有原codec externalization及bundle size警告。最新fresh build:test sourceSHA `bcd7bd39ed440a4a1277455bb06471673d13cef5eb5e8de942b6d5f0194f056e`，outputSHA `3600194d4cb4ab15891d0d89cc7e4dcb4656f48d4367d70823aa8259d4e0a343`；各GPU原件另含自己的source/build/oracle fingerprint。

| 检查 | 实际结果 / raw入口 |
|---|---|
| 受影响Node单元 | 前版本67项通过：`final-pixel-phase2-zero-contracts.txt`；最新codegen受影响40项通过：`final-pixel-phase2-short-scope-contracts.txt` |
| 独立receiver及投影/回退 | `final-pixel-phase2-short-scope-receiver.json`通过 |
| 1080p×256frame×4 Shadow子矩阵 | `final-pixel-phase2-short-scope-final-pixel-shadow-quality.json`通过；各原candidate结果另保留 |
| ordinary/Product/MASK/coat/material resource profiles | `final-pixel-phase2-short-scope-native-surface-resource-profile.json`通过 |
| multiProduct、authored IBL实际production | `final-pixel-phase2-short-scope-native-surface-multi-product-production.json`、`native-authored-ibl-production.json`通过 |
| 最低16 storage/16 sampled/4 outputs完整非生产Seed闭包 | `final-pixel-phase2-short-scope-final-pixel-phase1-minimum.json`通过，180frames/原writer及事务域 |
| 真实Renderer更新/abort/retry/resize/deviceepoch | `final-pixel-phase2-short-scope-production.json`通过，含pool显存及destroy检查 |
| 原PCF/publication/local invalidation | `final-pixel-phase2-final-vsm-v4-r3.json`、`vsm-sampling-publication.json`、`vsm-local-invalidation.json`通过；该采样/管理源码之后未改 |

原失败包括FG别名版本环、fixture仍传旧8B lookup、初始重心页误判及各数值候选，分别保留`first/second/...`、`shadow-quality-*`原件。前两项修真实接线/fixture，后者换恢复candidate；未放宽断言、缩scene或加production fallback。错误CLI名记录为调用错误，不计GPU算法失败。全量Node的既有范围外失败及worker不退出沿用Phase1报告，未修复，也不称全套通过。

## 同条件成本复核

基线detached worktree `.local/v5-phase2-baseline`固定9f305；A为该源码S3+T3，B为主树融合候选，分别fresh built Dungeon。依赖junction共用、相同cooked资产，场景coverage/工作量保留，无checkout污染主树。

真实单卡NVML记录`NVIDIA GeForce GTX 1650 Ti`、4096MiB、UUID `GPU-c1709151-b22a-4a1c-2693-e614c0a291ea`、driver581.42；browser仅报告Nvidia/Turing，不能把其空device字段当设备名。1080p/DPR1/renderScale1、high atlas4096/6 clips、4×4 point-PCF/radius.75、相同AA/RCAS/质量、GTAO/Bloom OFF、geometry512MiB、settled near、cameraFactor.15与offset(-7,-2,-7)，GPU串行。

每run240frame、sampleinterval4，共60个完整GPU sample。runner的正式report剔自身warmup后会剩49–56samples；下面统一使用整个target window和`(n-1)*p`线性分位，不能混用两种窗口。interval1/2因profiler full记录容量上限未形成完整成本窗口的原A1保留，不改runner断言使它假通过。

命令：`node validation/tools/run-dungeon-performance.mjs --scenarios full --frames 240 --gpu-sample-interval 4 --geometryMiB 512 --geometry-settled --near --cameraFactor .15 --cameraOffset -7,-2,-7 --out <absolute-run-directory>`。

FinalPixel envelope是first `VSM/receiver demand` pass开始到last `SurfaceV4/native winner shading`结束，包含VSM管理/shadow geometry/raster、Solar copy/local/bins及边界间隙；PCF转移到Native后不只比较Native桶。pass求和仅辅助，whole span独立统计，不相加各桶P95。

第一组（two-endpoint ray）raw `final-pixel-phase2-abba-4-{A1,B1,B2,A2}`；summary `final-pixel-phase2-abba-first-summary.json`：

| run | whole P50/P95/P99 ms | FinalPixel envelope P50 ms |
|---|---|---:|
| A1 | 19.465 / 32.422 / 80.380 | 10.289 |
| B1 | 19.079 / 33.033 / 49.559 | 10.619 |
| B2 | 19.956 / 51.954 / 123.826 | 11.327 |
| A2 | 18.807 / 34.676 / 67.137 | 9.938 |

第二组（two-endpoint ray+exact-zero Sun）raw `final-pixel-phase2-zero-abba-{A1,B1,B2,A2}`；summary `final-pixel-phase2-zero-abba-summary.json`：

| run | whole P50/P95/P99 ms | FinalPixel envelope P50 ms | Native / all VSM P50 ms |
|---|---|---:|---|
| A1 | 19.734 / 56.121 / 84.675 | 10.286 | 5.090 / 4.069 |
| B1 | 20.743 / 49.213 / 125.255 | 11.559 | 9.028 / 1.324 |
| B2 | 19.870 / 46.050 / 92.647 | 11.006 | 8.643 / 1.269 |
| A2 | 18.627 / 37.051 / 109.707 | 9.982 | 4.790 / 3.973 |

温度88–91°C，SW thermal Active；第二组full-window clocks分别1035–1350、345–1350、300–1350、300–1170MHz。coverage约90.66–90.71%、invalid0、无GPU错误。不能将热态/频率差直接归因于fusion或做频率归一化声称收益。

第三组（齐次ray+短interpolation live scope+exact-zero Sun）raw `final-pixel-phase2-short-abba-{A1,B1,B2,A2}`；summary `final-pixel-phase2-short-abba-summary.json`：

| run | whole P50/P95/P99 ms | FinalPixel envelope P50 ms | Native / all VSM P50 ms |
|---|---|---:|---|
| A1 | 18.815 / 47.168 / 111.224 | 9.935 | 4.865 / 3.889 |
| B1 | 20.168 / 46.173 / 92.007 | 11.235 | 8.784 / 1.282 |
| B2 | 19.960 / 52.380 / 102.048 | 11.192 | 8.726 / 1.283 |
| A2 | 18.653 / 44.633 / 111.697 | 9.867 | 4.857 / 3.919 |

每run60完整sample、GPU错误0、invalid0；coverage90.664–90.708%，纹理/PCF/场景域未缩减。full-window温度分别88–90、87–91、89–91、89–90°C，graphics clock分别315–1125、540–1350、1080–1350、990–1350MHz；热状态不完全重叠。API simultaneous peak约A1/A2 1,437,586,709B、B1 1,433,701,845B、B2 1,433,734,613B；只是该窗口的API观测，不是驱动驻留或全feature域资格。

三组均**未证明DELETE>ADD净收益**。第三组既保留数值修正，也没有取得成本资格；应继续Phase2内candidate成本返工，不把它追认成成功。单一热态短窗口不满足Phase6至少1000完整GPU samples/至少3 ABBA blocks/P99置信区间门；局部candidate结果不能否定未完整实现Seed/Temporal V2的整个Final Pixel架构。当前源码live scope已缩短，下一候选必须先区分compiler工作集、Solar手动插值与VSM查询/执行重叠的实际成本；尚未取得硬件spill/occupancy证据，不能把其中任一项写为已证明根因，也不继续无依据helper→Dungeon循环。

## 剩余出口

Phase2结构删除和receiver数值返工已实际发生；成本仍需完成合格candidate，不能假写完成或因局部性能结果改总方向。未运行完整全Renderer动态HDR/quality矩阵、Phase6长窗口正式performance、硬件register/spill诊断和受所有切换/retirement影响的4GB simultaneous peak验收。普通短窗口NVML驻留约2.4GiB、API peak约1.3GiB只是该fixture观测，不证明全域4GB资格。保持唯一fusion production链，不恢复S3，不提前切Seed；下一步仍是Phase2内候选成本返工。
