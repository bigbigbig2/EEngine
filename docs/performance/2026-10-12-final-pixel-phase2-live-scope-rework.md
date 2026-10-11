---
id: final-pixel-phase2-live-scope-rework-2026-10-12
state: history
---

# V5 Phase2 live-scope返工与执行gate审查

2026-10-12用户授权审查当前Phase、必要返工或延期。本轮起始HEAD `8db2c82bf59d24bffd97a0499617b68e3895df91`，工作树只有未跟踪`.vscode/`，未使用子agent。Phase1无需返工；Phase2生产fusion已切，receiver数值修复已通过，但此前有限ABBA均未得净性能资格。本报告只记录本次候选与验证，不改变B/V2架构。

## 1. 完整候选与数学合同

Native唯一链改为：一次resolved triangle/position → Seed（非生产完整profile）→ interpolation/attributes/material → Local/IBL与Sun BRDF factors → 原VSM query/point-PCF → 原Sun irradiance乘visibility → radiance/coat/combined finite guard → `(local + Sun) + IBL` → exposure/Rec2020/HDR。各诊断specialization仍明确裁掉相应工作；G仍等于default source。

`lighting_brdf.ts`把原`re_direct_physical`拆成`prepare_direct_physical`与`apply_direct_physical`，原入口调用这两个共享数学函数；Local/diagnostic不复制另一BRDF。准备结果只在invocation中存在，含diffuse/specular、NoL、base attenuation、coat NoL/BRDF/分支。`native_surface_lighting.ts`在PCF之后按原顺序缩放irradiance并apply；geometry/material/CXY数组不跨这段源码scope。未改变Geometry frontend、visibility/bin工作、material导数/normal、provider、PCF支持域、FrameGraph/publication或Temporal算法；没有新pass、buffer、product或production选择器。

拒绝`unshadowedSunRGB * visibility`：原combined finite guard可能拒掉unshadowed overflow，partial visibility却可以使贡献有限。因子拆分保留visibility→radiance/coat→guard与原加法分组，完整支持域没有收窄。

## 2. Cost Card

本候选只改变Phase2已有fusion的执行顺序；原删除Shadow full-screen pass、receiver恢复、mask store/read、Sun continuation与第二HDR等资产仍在。不能把这些共同删除项重复算成late相对early的新增收益。

| 项目 | DELETE / ADD与边界 |
|---|---|
| private状态 | DELETE early-PCF后续需要保活的完整resolved coefficients/vertices/position；ADD late的6 scalar RGB与Sun response 10 f32+1 bool，再携带receiver position/plane/flags。GeometryResolved源字段32 scalar，late相关源carry约25 scalar（另有pixel/raster等共同项）；这不是硬件register计数，不能由词法scope声称不存在spill |
| response成本 | 11个32bit逻辑scalar约44B/invocation，无storage ABI、buffer写读、texture/history或新owner；不能把它误写为44B/pixel带宽 |
| ALU / samples | 原winner、material、Local/IBL、point-PCF、irradiance与BRDF数学不变，只移动；fully shadowed时提前算Sun BRDF是新增ALU，原exact-zero分支仍省irradiance/apply，不能省PCF/tap |
| traffic / working set | 新增/删除跨pass bytes均0；descriptor/Solar/local container与atlas/provider容量、原读取次数不变。private working set重叠改变，实际occupancy/spill未取得硬件证据 |
| atomics / barriers / dispatch / binding | 均不变，无新atomic/shared/barrier/pass/submit；production普通双输出和非生产Seed四输出均维持原完整资源合同 |
| ideal / expected / worst | ideal compiler结束大geometry/CXY/material scope可减少重叠；expected换成较小数学response但需实测；worst response/receiver仍保活或全阴影额外BRDF超过收益 |
| 0/50/100%兑现 | 若原scope重叠可省成本为S，新增response及全阴影ALU税为A，则净删除为`0*S-A`、`.5*S-A`、`S-A`；source不能给S/A编造ms。break-even必须`S>A`并同时改善whole/envelope，源码字段少不代替测量 |

下述ABBA没有证明break-even。故当前只是正确、闭合的fusion实现candidate，**未获Performance Improved资格**。不能将它称为架构被证伪，也不能用测试通过推导收益。

## 3. 验证、原失败与限制

Engine typecheck/build、fresh build:test、两侧fresh Dungeon build通过，Vite仅原codec externalization/bundle-size警告。最终test build sourceSHA `75fcaa33f96340ac2791964c018f48f09ea224fdd9699294d2695abd09b791d7`，outputSHA `549c513f6fdbf40e0d4beb028bf271b60149a5a9e0808a8dbdbceadaf4288467`。GPU串行，作业期间冻结production、oracle与`.test-dist`，原件不覆盖。

| 检查 | 结果 / `.local/`原件 |
|---|---|
| 受影响Node | 40/40，`final-pixel-phase2-late-contracts.txt` |
| 冻结旧BRDF独立GPU对照 | `final-pixel-phase2-late-final-pixel-sun-response.json`及加强分项检查的`final-pixel-phase2-late-sun-lobes.json`，2880组方向/roughness/coat/HDR/visibility；Sun总量、diffuse/specular各分项均exact，192个unshadowed overflow→shadowed finite负对照通道，24个原reference总量非有限通道分类保持 |
| ordinary/Product/MASK/coat/resource profile | `final-pixel-phase2-late-native-surface-resource-profile.json`通过 |
| multiProduct production | `final-pixel-phase2-late-native-surface-multi-product-production.json`通过 |
| authored IBL production | `final-pixel-phase2-late-native-authored-ibl-production.json`通过 |
| 最低16 storage/16 sampled/4 outputs Seed闭包 | `final-pixel-phase2-late-final-pixel-phase1-minimum.json`通过，原writer/consumer/事务域完整 |
| 真实Renderer与pool/abort/retry/resize/device epoch | `final-pixel-phase2-late-native-surface-production.json`通过 |
| 1920×1080，4case×256frame Shadow子矩阵 | `final-pixel-phase2-late-final-pixel-shadow-quality.json`通过；全部页边界保留，可见度和boundary RMSE均0 |

冻结BRDF来自起始HEAD `lighting_brdf.ts`，只放`tests/oracle/reference/s3/lighting_brdf.mjs`。新oracle独立命名冻结函数并使用原数学，不import生产prepare/apply来生成reference。它还计算错误的unshadowed-RGB方案作为负对照，不能把同一实现两次调用当独立golden。

首次新oracle错误地要求极端HDR的所有原输出都有限，在case43得到`Infinity vs Infinity`；原失败`final-pixel-phase2-late-sun-response.json`保留。根因是fixture强加了旧公式也不满足的断言：combined finite guard之后分项相加自身仍可overflow。修正为比较原reference数值及非有限分类，仍exact、无新增容差、不缩输入；首次修正通过原件为`final-pixel-phase2-late-sun-response-rerun.json`。GPU极端f32 overflow对照只说明当前设备行为，不声明跨设备undefined/nonfinite行为保证。

原receiver/PCF/publication/invalidation源码未改，已有验证继承[前报告](2026-10-12-final-pixel-phase2-cutover.md)。未运行全Renderer完整动态HDR矩阵、正式长窗口3 ABBA blocks、hardware register/spill或全feature 4GB simultaneous peak；不宣称总体质量/60FPS验收。旧全量Node范围外失败/未退出worker未修，本轮只称上述40项通过。

## 4. 完整有限ABBA

A为detached `9f305c4128b0355614ececbe2be890582d6e8f2d` S3基线，B为本次返工候选。两侧fresh Dungeon build，原cooked assets/scene不变。GTX1650Ti4GB、driver581.42、Chrome154；1920×1080/DPR1/scale1、4096 atlas/6clips/4×4 point-PCF/radius.75、原AA/RCAS、GTAO/Bloom OFF、geometry512MiB、settled near、cameraFactor.15/offset(-7,-2,-7)。每run240frame、interval4、60完整GPU样本；统一完整target window、`(n-1)*p`分位。whole/envelope逐frame求值，Native/allVSM sum仅辅助，不加各阶段P95。

命令：`node validation/tools/run-dungeon-performance.mjs --scenarios full --frames 240 --gpu-sample-interval 4 --geometryMiB 512 --geometry-settled --near --cameraFactor .15 --cameraOffset -7,-2,-7 --out <absolute-run-directory>`。raw `final-pixel-phase2-late-abba-{A1,B1,B2,A2}`，包含source/build fingerprints、逐frame timing与suite sensor；摘要`final-pixel-phase2-late-abba-summary.json`。driver/device UUID沿用前报告的真实NVML记录，browser空device名不冒充精确adapter名。

| Run | whole P50 / P95 / P99 ms | first receiver→last Native envelope P50 / P95 / P99 ms | Native / allVSM P50 ms |
|---|---|---|---|
| A1 | 17.685 / 33.749 / 48.703 | 9.363 / 18.207 / 27.138 | 4.594 / 3.653 |
| B1 | 19.152 / 42.424 / 97.886 | 10.594 / 24.628 / 56.115 | 8.261 / 1.235 |
| B2 | 19.833 / 49.371 / 121.514 | 10.923 / 28.145 / 68.645 | 8.475 / 1.272 |
| A2 | 19.075 / 45.091 / 99.031 | 10.053 / 25.324 / 53.443 | 4.966 / 3.934 |

四run GPU错误0、invalid0，coverage约90.679/90.708/90.694/90.694%。温度区间依次87–91、89–90、89–91、88–91°C；graphics clocks375–1350、300–1350、915–1215、300–1350MHz，各轮热降频/频率状态不完全重叠。不能频率归一化或以新旧不同轮差值声称late相对early更快；原early失败继续保留。B whole/envelope不优于A，尾帧也不满足预算；本微窗口不足正式架构证伪或性能验收。

## 5. 审查后的边界

Phase1不返工；本轮完成Phase2候选live-scope/有限性返工及完整unit必要验证。审查发现原执行gate把未获净性能资格的局部候选设为Phase3前置，会使所有后续Seed/Facts/Temporal大结构删除停在小shader循环。依用户本次允许返工/延期及原“候选失败不阻止完整重构”的要求，执行authority改为：结构/接线/数值/unit质量/生命周期闭包是cutover依赖；成本检查必须现在做且失败真实保留；**继续成本调优放Phase5完整Sun+Seed+V2 Temporal图，正式净性能/预算资格放Phase6**。不是将成本检查或必需正确性后移，更不是将回归标绿。

唯一B/V2架构、所有quality域和预算不变，最终闭包后不赚钱仍按原full-architecture falsification处理。未来不得用本次“结构闭包完成”宣称性能改善。下一unit为Phase3原子Native Seed cutover/退休Facts与旧Aux，本次未开始，停在该边界。
