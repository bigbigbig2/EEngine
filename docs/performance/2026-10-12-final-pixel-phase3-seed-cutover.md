---
id: final-pixel-phase3-seed-cutover-2026-10-12
state: history
---

# V5 Phase3：Native Temporal Seed生产切换

本轮起始HEAD `c71c6d3110c3a09a5a5d1eb983cb7c57ff6f4aec`；已有Phase2结构、数值、接线与生命周期闭包不需再返工。Phase2未资格融合成本仍按既有authority在Phase5/6联合收口，不因局部候选无收益推迟独立重复工作删除。用户授权完成下一个完整Phase及必要返工；未使用子agent，原`.vscode/`保留、不提交。

## 实际切换与返工

生产唯一链：Geometry/Visibility → VSM与LocalLight publications → Native一次primary Surface恢复/原Sun，同时写Seed/response/current identity → lightweight classification → Sky/Aerial → 当前native T3或true-upscale FSR → Radiometry/Present。T3算法、Prepare/scatter/SPD及source histories尚未退休，不能称Native Temporal V2完成。

DELETE：`NativeTemporalFactsPass.ts`、`NativeSurfaceAux.ts`、`native_surface_aux.ts`；Facts重复Visibility/Depth/work/Scene instance/version/camera读取与depth→world→previous clip；opaque staging/clear；separate versions buffer及最后production consumer、unused Facts metadata/payload/previous-camera图输入。Facts本来没有读取asset metadata/vertex payload、没有恢复三角形；不把compiler已消去的读取计收益。

ADD：Renderer唯一`finalPixel:true` profile，Native写rgba32float Seed、rgba8unorm response、rgba32uint identity；Temporal-owned identity pair与camera/jitter成功提交事务；classifier只读Seed/response/current及previous identity；当前FSR/native T3/debug直读Seed.xy/mask。Native directory32B、signature/valueRevision words4/5，raster directory保持16B。GPUCameraState提供与实际GPU packed camera一致的当前inverse镜像。没有第二renderer、fallback或额外frame submit。

返工：cached graph必须late bind本帧Seed/read-write identity角色，不能捕获建图时prepared frame；abort/retry保留上次成功提交相机，Scene与Product publication原事务不变。Seed资源计入ResourceAccounting，resize/domain/epoch/fence/release闭合。AA off目前仍执行classification以保证既有scene-frame identity publication事务，最后域税在Phase5审查；不能把它当按需执行已完成。

## Cost Card

N=1920×1080，α为实际shaded比例。全部为format logical bytes，不是DRAM实测。

| 项目 | DELETE / ADD |
|---|---|
| 同时产品 | 旧identity pair32 + motion8 + opaque4 + mask4 =48B/pixel；新identity pair32 + Seed16 + response4 + classifier mask4 =56B。净+8B/pixel=15.82MiB |
| owner容量 | Seed owner52B/pixel=102.83MiB；classifier mask另7.91MiB；resize/policy旧+新+retiring peak另计，不用steady值替代峰值 |
| 全域stores/clear | 旧Facts28N、opaque store4αN与clear4N；新Native完整三产品36N、classifier4N。净新增`(8−4α)N`，α=1为7.91MiB/frame；不能声称删除28B输出 |
| publication | Native目录16→32B/slot，删除versions8B/slot，净+8B/slot；raster16B/slot不变 |
| 读取/ALU | 删Facts额外winner/depth/work/instance/version与depth inverse-projection/view恢复；ADD Native previous-affine/view/clip、view depth、identity hash和三个stores。previous identity/邻域比较移到classifier而非删除；不将176B完整instance record当实际DRAM访问量 |
| dispatch / synchronization | 原Facts full-I dispatch被classifier full-I dispatch替代，数量没有减少；不加scatter/atomic/shared/barrier/submit，当前FSR原scatter保留到Phase4 |
| private / binding | Native从HDR+opaque双输出改为HDR+Seed/response/identity四输出；额外272B camera-view uniform与private motion/depth/hash活跃状态。编译/最低limits通过不等于寄存器/occupancy/spill成本为零 |
| ideal / expected / worst | ideal重复恢复/随机读取删除覆盖新Native工作；expected依赖Native已有事实复用、短scope与顺序store；worst新增stores/ALU/live-state税超过删掉的Facts读取。用0/.5/1×可删除成本减同一新增税检查兑现；break-even必须whole与Native→classification envelope都成立 |

下述有限观察没有证明DELETE>ADD实测成立。不得宣称Performance Improved；联合B+Seed+V2架构尚未完整实现，不能据此宣布架构被证伪。明确保留Native新增成本，Phase5/6必须联合处理，不能以“之后验收”忽略观察回归。

## 验证与原失败

Engine typecheck/build、fresh build:test与两侧Dungeon build通过；Vite原codec externalization/large chunk警告保留。受影响Node为31/31，不宣称全量Node通过。集中九项GPU矩阵使用的test build source SHA `c923ddfbad6af26bea6d3c13e6de7d1afa266d6dff66b77ff88df781ff3e5669`，output SHA `5dc0fd374d8c2a92acf8e63ef840037d7f62eae06cd55a3a43e05d5f0da757ac`。末尾只清理过时profile注释与FrameProduct invalid说明（invalid motion可保留已知view depths，sky使用独立sentinel）；之后再次fresh build:test/typecheck、31项Node及真实Renderer production检查通过，见`.local/phase3-release-production.json`，没有改shader算法或重复跑性能窗口。

GPU作业串行，运行时冻结production、oracle、`.test-dist`。以下九项均passed、无uncaptured/scoped GPU错误；raw为`.local/phase3-closed-<selector>.json`：`final-pixel-phase1-minimum`、`final-pixel-seed-epoch`、`native-execution-bins`、`native-surface-integration`、`native-surface-resource-profile`、`native-surface-production`、`native-surface-multi-product-production`、`native-surface-device-epoch`、`final-pixel-seed-quality`。覆盖最低16/16/4与最大完整material/Product profile、全写域、predicted previous/current view depth、rigid/deformed-invalid、MASK、HDR/normal/coat、cached roles、cut/policy/abort/defer/三inflight与两个受控device epochs；受控destroy不冒称任意真实driver loss。

此前独立`native-temporal-v2`的16序列8×8积分golden也passed（`.local/phase3-temporal-golden-current.json`），但其输入未改为新Seed generation；它只证明未修改T3数学的回归，不冒称覆盖新事实生产者或本轮全部1080p质量。

原失败不覆盖：integration leftover `aux is not defined`、production引用已退休`_temporalFacts`，均是oracle迁移错误；publication旧56B断言按32B Native+16B raster的真实64B改写，没有删除语义断言。早期质量fixture更新相机却复用旧cached clip vertices，Depth与Native camera不一致；改为真实FrameGeometryVertices producer每帧更新clip，未修改Geometry frontend生产算法。canonical位置/clip association两个生产算术候选无效，全部撤销。记录见`.local/phase3-quality-first/diagnostic/second/third/fourth/canonical/associated/ frontend-*`原件；解析reference初始auto-layout保留无consumer camera绑定的失败也保留在`phase3-quality-analytic-matrix.json`，修复真实layout。

### Phase3输入/累积子质量（非整Renderer质量验收）

实际Native→Seed→classification→当前T3，与冻结c71 Facts及同一T3、各自独立histories比较。四case各256成功提交帧，1920×1080，dt=1/60，64warmup、64–191运动/变化、192–255停止；.25px/frame慢pan、8px/frame快pan/frame128反向、dolly、material publication/exposure replacement。三个T3图消费同一真实Native HDR和真实raster depth，仅motion/facts producer不同。

第三图使用独立平面z=.5、固定朝向相机的解析reprojection，按projection jitter、camera translation与两帧距离比产生motion，不读raster depth/Native position。它是本单元motion及f32误差放大oracle，**不是8×8积分AA golden**。required gate保持原motion<.1px、exact current identity、R/B分类及独立previous identity字节/硬替换语义；G只允许UV距数学viewport边界≤一个f32 ULP的rounding不确定性，interior mismatch必败。每frame normalized HDR error相对解析motion参考不得比旧Facts多2^-10；每case peak-error envelope同样不退化。最终完整golden/薄线/拖尾/ROI/settling与Dungeon人工动态质量仍按原Phase4–6合同完成，未宣布本轮替代它们。

新增oracle最初把Before/After逐像素HDR输出差值峰值≤一个比较单位当质量gate，保存了`phase3-quality-complete-matrix.json`、`phase3-quality-analytic-layout-fixed.json`和规定速度下`phase3-final-final-pixel-seed-quality.json`失败。这个parity门不能判“新比旧差”：快反向frame135新相对解析motion RMSE .000099826、旧.002064205，输出差值.002062214却会拒绝改进。修正oracle以独立error为质量依据；未放宽文档2^-10质量底线，全部原parity失败继续作为`diagnosticParityFailures`和raw差值保存。不将任一人工新增parity门的失败追认为pass。

| case | 最大motion差/px | Before/After输出差值最大normalized RMSE（诊断） | 解析motion参考peak envelope，Native / Facts |
|---|---:|---:|---:|
| jitter-slow-pan | .000228882 | .000493426 | .038330078 / .038330078 |
| fast-reverse-stop | .000228882 | .002062214 | .023681641 / .023681641 |
| dolly-depth | .000286102 | .000743623 | .123779297 / .123779297 |
| replacement-exposure | .000228882 | .000342038 | .038208008 / .048339844 |

current identity mismatch=0，soft reactive与hard replacement mismatch=0，independent change-byte/validity/finite checks通过。此子矩阵为Phase3必需出口，不是60FPS、AAA整图quality或FSR来源adoption资格。

## 有限Dungeon ABBA：未得净性能资格

Before是detached c71 worktree及新鲜Dungeon build；After是本轮生产Seed切换。固定full/1080p/scale1/512MiB/near/cameraFactor=.15/offset=-7,-2,-7/geometry-settled，原high VSM、AA/sharpen、AO/Bloom OFF不变。每轮240frame、GPU sample interval4，60个完整whole-command samples。GPU串行，仅一块A1/B1/B2/A2，P99为短窗观察，不是Phase6≥1000samples资格。

| run | whole P50 / P95 / P99 ms | Native P50 | Facts或classifier P50 | Native→classification envelope P50 |
|---|---|---:|---:|---:|
| A1 | 21.400 / 38.907 / 44.186 | 9.402 | .718 | 10.117 |
| B1 | 24.510 / 28.276 / 57.417 | 10.819 | .659 | 11.503 |
| B2 | 23.634 / 49.584 / 90.457 | 10.513 | .653 | 11.195 |
| A2 | 21.693 / 75.364 / 133.271 | 9.678 | .733 | 10.433 |

不能相加各bucket分位或把P95跨轮平均当whole P95。After Native和whole P50观察较慢，Facts→classifier仅少约.07ms；没有break-even证据。温度88–91°C、graphics300–1350MHz、有明显降频/tail；不删除长帧，不频率归一化成收益，也不因热状态把观察回归改写为通过。覆盖model约90.69–90.71%、invalid=0，完整工作未被裁掉；各轮driver memoryUsed 2871–2933MiB不能解释为新逻辑产品减容量。

raw目录`.local/phase3-cost-{A1,B1,B2,A2}/`含full/suite/source fingerprint/sensors/build；分位按每frame whole span和同frame envelope先计算再排序，复算`.local/phase3-summarize.py`，汇总`.local/phase3-cost-summary.json`。不混用Phase2的S3 Before，不宣称16.67ms或稳定60FPS。Phase3结构/必要数值/接线/生命周期/输入子质量出口关闭；净性能资格未通过，Native live-state/输出税必须在Phase5/6联合收口，停止Phase4边界。

`full.json` SHA256：A1 `f6d66e5ef7a2a98fc3206272413bbee6785eee8a08b0a068c37f82b16f133c31`；B1 `23595262d474ebbf101ecedef07f60a8015226e677f3a8ad62224533d4d6e289`；B2 `9006d05f86aeb5d2ab9bda5eec01464f4a96cc5d67cd0c71e187fdff81ff3182`；A2 `08dafae43138219d957e232b558a8d40ccf725800cd68f027e96fa917035a797`。
