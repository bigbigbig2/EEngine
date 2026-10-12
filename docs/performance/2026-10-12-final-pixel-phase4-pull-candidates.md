---
id: final-pixel-phase4-pull-candidates-2026-10-12
state: history
---

# V5 Phase4：隔离 previous-depth pull 候选与返工记录

起始生产HEAD `015548a7d5707975701a844c3b06df3ba8a28303`。本记录是候选事实，不是新设计/执行authority。Phase3已完成的结构、语义与提交闭包未发现新返工或延期依据；Phase2/3已有成本回归仍保留，依执行计划在Phase5/6联合收口。没有使用子agent。

**当前生产已切换Native V2，完整单元验证结果见文末；Phase状态只读执行authority。** C59、domain及自主估计器候选均为历史检查点，不能作为当前实现状态。原失败全部保留；当前范围以文末接线与最终验证记录为准，阶段状态只读执行authority。

## C59候选物理图与Cost Card（历史）

只有oracle引用 `NativeTemporalV2`/`native_temporal_v2`，没有production import或selector。同一frame encoder运行Analyze→Resolve→既有RCAS。Analyze写analysis、raw current depth及1×1 `1/P`锐化曝光；Resolve写当前color/state角色；RCAS读写后color版本。C33已把独立1×1曝光dispatch合入Analyze，质量输出与C32相同；不是性能实测。

候选DELETE：Prepare的9depth搜索、最多4atomicMax scatter、reconstructed buffer/clear与scatter→read边，live luma/shading SPDs/source histories/旧T3；图无Visibility/Instances/Geometry或Depth→World恢复。这些工作**尚未从生产删除**。

候选ADD：4point previous-depth pull、完整四字段identity nearest比较、Seed邻域receiver选择与边界/坡度判定、局部多尺度luma/difference、RGBA16 analysis读写、RG32 moments与confidence、depth history、fractional 16point history过滤。Analyze为8×8组，两块16×16 f32 halo共2KiB，一个统一barrier；边缘lane完成halo后退出。storage texture峰值3，sampled texture峰值8，无float32-filterable/subgroups要求。

| 容量 / traffic | 当前隔离候选成本 |
|---|---|
| V2 persistent | color RGBA16 pair16 + depth R32 pair8 + state RG32 pair16 =40B/pixel；1080p79.10MiB |
| identity | Seed owner完整RGBA32Uint pair32B另计；合计72B/pixel，142.38MiB，未截断身份 |
| fixed | frame32B + RCAS constants16B + exposure4B =52B |
| transients | Seed16/response4、Analyze8、common sharpen8B/pixel，按真实owner计；不把RCAS计删除 |
| store/clear下限 | authority旧69→目标64B/pixel，共同项抵消；仅10,368,000B/frame确定下限，未等同DRAM收益 |
| reads / ALU | 4tap receiver在Analyze/Resolve各选一次，读已有Seed，不计免费；多尺度统计、manual RG32 interpolation、16point fractional history、指数/三角函数及private live-state都是ADD |
| integer history | C57改以pixel坐标进入颜色history filter，避免normalized往返误差；独立数值通过，不声称真实Native每个静止pixel均进入整数分支或已有收益 |
| retirement peak | active+resize candidate+last-consumer fence前retiring；FG transient/inflight另计，不能只报40N steady bytes |

ideal包含Prepare搜索/scatter RMW/clear、live SPD与旧阶段边删除；expected依赖cache/halo与短live scopes；worst为新增统计/history过滤/register税超过删除收益。0/50/100%删除兑现均减同一ADD，不凭pass数声明DELETE>ADD实测成立。没有运行Dungeon或subphase性能benchmark；完整质量、producer/consumer和事务闭合后才集中一次有限Phase ABBA。

## 已定位的语义与候选检查点

receiver选择q后，depth/identity验证与坡度/邻域必须围绕q；color history仍投影输出footprint p。nearer prior depth是旧遮挡者，不能以部分coverage保留背景历史；raw current depth history全域写原始p的Seed.w。

moments先求四point各自时间variance，再插值mean/variance并返回mean²+variance，避免把空间HDR边缘误当时间variance。零variance HDR边与已知variance的独立GPU检查通过。moments属于输出AA footprint的时间分布，不能直接当固定raw jitter网格平移。

三点二次像素积分由E[t]=jitter、E[t²]=jitter²+1/12推导；独立GPU64phase验证常量、线性与二次反导数。C38消除了small light-ramp硬门，但整体质量仍失败。

| 检查点 | 变更 / 判断 | 硬门失败条目 |
|---|---|---:|
| C43 | geometric radial支持、置信度相关稳定tone混合，未资格 | 11 |
| C44 | 9tap receiver/radiance radial/更强tone；新增motion与遮挡回归，撤回 | 16 |
| C45 | stationary gain与非线性bootstrap；HDR回归，撤回 | 18 |
| C46 | explicit half pack/unpack，输出同C43；没有证据支持store转换是能量偏差根因，撤回 | 11 |
| C47 | 平滑motion更快接受当前样本，dolly energy门通过，整体未资格 | 10 |
| C48 | tent bootstrap，新增reset回归，撤回 | 11 |
| C49 | transport削弱variance保护/双向thin，运动大范围回归，撤回 | 29 |
| C50 / C51 | 旧depth支持率作颜色coverage / 限制法向motion；切向与角落变暗，撤回 | 9 / 9 |
| C52 | motion/intermittency全量Reinhard混合，运动回归，撤回 | 19 |
| C53 / C54 | raw-grid moments平移 / 仅transport；静止或motion-stop回归，撤回 | 105 / 15 |
| C55 | 增大moving geometric-edge history，遮挡/energy回归，撤回 | 12 |
| C56 | silhouette正权面积支持，多帧遮挡回归，撤回 | 18 |
| C57 | C47加pixel-domain history，保留为当前隔离候选，仍未资格 | 10 |
| C58 | transported mean/current point限制历史，新增motion失败，撤回 | 13 |
| C59 | 保留C57数学，整理源码与独立history probe后的fresh收口 | 10 |

C50/C51证明双线性旧depth支持率不能直接当单位像素面积coverage；新增4point depth、edge 9tap Seed与颜色working state已撤回。C53/C54未证明原坐标是bug，其网格平移候选也已撤回。不能按失败数量选择生产算法，更不能用单项改善覆盖其余失败。

| C59仍失败范围 | Native / Before（门保持旧+2^-10底线） |
|---|---|
| fast reverse frame29 | HDR RMSE .219897 / .126723 |
| foreground energy | .005589 / .002495；另frame18/19/25/26/27失败 |
| external large jitter / wire energy | .703408 / .684132 |
| 1080p HDR startup frame1 | far-edge .143339 / .138615；interior .140807 / .136178 |

原件在 `.local/phase4-pull-cNN-integral.json`，最终为 `.local/phase4-pull-c59-final.json`（UTF-16），解析在 `phase4-cNN-integral-quality.json` / `phase4-c59-final-quality.json`，source快照在 `native_temporal_v2-cNN.ts`。早期C33/C38/C39、C41 packing语义probe及撤回source也保留。test-only Resolve trace只写diagnostic buffer，不覆盖输出或改变门，不拿trace时间当性能。

## 质量fixture与资格边界

HEAD runtime/NativeTemporalPasses/shader冻结到 `tests/oracle/reference/phase4/`；shared FSR helpers/constants/RCAS来自未修改test build，未来改变共享代码必须冻结对应Before依赖。两图独立histories，共享独立8×8积分golden。

最初1080p jittered窄HDR场景误用单点golden，原失败全部保留、不追认通过。纠正为同场景/输入/reference/1920×1080/4frames的8×8积分，separable加速与直接64point quadrature核对≤2^-40。增加uniform1080p8192、jitter/P变化数值检查。平均、ROI、逐frame、原2^-10底线及uniform<.003均未放宽。

17个small/短序列case不是1080p×256完整动态矩阵；small fast2.1px、constant-depth dolly、synthetic Seed/identity不能替代8px motion、真实dolly z、Native writer、sky/deformed-invalid或完整owner replacement。诊断新增signed energy和worst pixels，未增加/替换/删除任何质量门。

## 收口验证

最终typecheck、fresh build:test、7/7 Node通过，覆盖unencoded commit、resize abort、jitter/role、explicit late binder、cached stale extent拒绝、three-inflight/fence、device loss、构造上传失败回滚与能力预检。早期device-loss test把FG-owned transient误算history，已按owner集合修正，保留原失败；没有宣称所有allocation throw都已验证。

`final-pixel-temporal-pull-semantics`最终 `.local/phase4-pull-semantics-c59.json` passed：真实state_at、64phase pixel integral、1080p远角history整数exact与fractional CPU sinc参考、同一compiled graph五提交/前三个不等待、expected previous-view z与raw current z区别、nearer occluder拒绝、abort保role、last fence后allocatedBytes=0。GPU scoped/uncaptured errors为空。首次compile前误用未建立producer字段的fixture失败 `c36.json` 保留，修后c36b/C38通过；这些不证明Renderer/Seed同事务已闭合。

fresh build source SHA256 `d49b63b60489d7b186128ef2384844a2766b350c719823fb5f027f470c76e95f`，output SHA256 `a8f74486bdcebf412313b278d74212c9a6dc3b0edbdd57da354067beca843d12`。同build C59质量selector为**failed（10条）**，不是GPU validation/编译/device故障。adapter只报告nvidia/turing/hardware，不能冒称GTX1650Ti性能证据。docs-verify与diff/格式检查通过，无性能或production adoption claim。

## 未关闭的Phase4出口

1. 修复small全部质量硬门，保持门与架构；不能移交Phase5。
2. 真实Native Surface→Seed→V2 producer/全部consumer与共同提交；当前Seed commit仍依赖classifier，不能直接删pass或跳其证明。
3. 完整1080p×256动态矩阵、golden+HEAD reference、冻结ROI/peak/energy/拖尾/settling。
4. 必需非生产门通过后原子cutover：native不分配FSR histories，true upscale保必要图；policy/AA-off/debug/bypass/cut/resize/abort/epoch/三inflight/fence闭合，同步删除旧native链，无bridge/fallback。
5. architecture review、完整Phase集中验证与一次有限成本ABBA；更新实际生产事实后停Phase5边界。

## 来源

Reference：AMD SDK MIT `c6efa6bf7f2027b3ec94f28578bb5965eabb9e55`完整PrepareInputs/Reproject/Accumulate及当前T3；Wicked MIT `7f776d02094571dd2c8166c7e5879d5e93d2b642`完整temporalaaCS.hlsl仅参考halo/pull。Adapt：AMD Gaussian/Lanczos数学，保留MIT notice。Local：Seed expected previous-view z pull、identity/coverage、moment插值、多尺度response、解析pixel integral、pixel-domain history接线及候选事务。不宣称完整移植、production adoption或净性能收益。

## 统一信号域返工：当前代码边界

起始HEAD `814cdbafabf3b1320ad35e5b43a34bdb1e4cc340`，生产入口未改变。C60–C73期间落入了局部补偿规则循环，用户指出后停止该方法。C66的6条失败不证明其中的前景搬运合法，也不证明模型闭合。C69面积恢复13条、C70非线性bootstrap19条、C71背景覆盖修正11条、C72局部径向6条、C73局部tone10条失败全部保留；不按失败条数挑生产算法。

**确定的返工**：删除2×2最近receiver选择；Analyze与Resolve使用自己的关联Seed，不以邻居motion/validity替代主像素。Scene/geometry不新增读取。Seed现在可以由完整Native Resolve消费证明完成提交；V2 Analyze/Resolve必须属于同一开放command且各执行一次，精确核对实际Seed/response/current与previous identity纹理、extent/role/jitter/reset。成功submit一起推进color/depth/state/identity/camera；提前commit、缺consumer、foreign command、stale role与abort不推进。

**模型边界**：current reconstruction、Analyze current luma/difference、Resolve local color statistics与写入moments的观测统一到输出像素域；几何验证仍在原始抖动点域，raw current-depth全域写保持。输出历史坐标不再夹带当前点采样的fractional jitter。删除前景颜色搬运、depth support→颜色面积猜测、历史抬亮和临时tone。时间方差只扩展同域统计裁剪支持，不直接替换或抬高历史RGB；geometry/reactive/shading rejection限制支持。**这种数据合同一致性不证明滤波/拒绝模型已经达到生产质量。**

| 完整模型候选 | 数学 / GPU语义 | small质量结果 |
| --- | --- | --- |
| domain-v1 | shared二次当前重建；Analyze/Resolve同域，但未使用时间方差支持裁剪 | 253条失败；缺采样相位抹除细线，不能采纳 |
| domain-v2 | 同域时空不确定性裁剪、跨尺度noise/shading判定 | 163条失败；平均HDR改善不能覆盖ROI/逐frame/局部光照/轮廓失败，不能采纳 |
| domain-v3（历史隔离代码） | 同域AMD径向支持+本地截断质心校正，局部/宽域统计；只证明常量/仿射保持，不再声称二次面积积分 | 233条失败；局部gain/拒绝模型仍未闭合，不能采纳生产 |

原件 `.local/phase4-pull-domain-v{1,2,3}.json`（UTF-16）与解析 `phase4-domain-v{1,2,3}-quality.json`，早期source快照与全部失败保留。没有放宽2^-10/ROI/逐frame/energy门，没有场景、尺寸、帧号特判。没有Dungeon/subphase benchmark。**下一工作是完整采样误差/变化检测/历史置信度模型闭包，不能再叠加单case补偿，也不能推进Phase5。**

### domain-v3模型Cost Card（历史）

产品/dispatch/持久格式不增加：Analyze→Resolve→RCAS，40B/pixel V2 history+32B/pixel Seed identity，analysis8B、raw depth4B与color/state写同前。没有Surface重建、scatter/clear/atomic/SPD；这些删除目前仍仅在候选图，生产未删。

ADD：Analyze18×18 RGBA f32 raw halo5184B+两块16×16 f32统计2048B，共7232B；Resolve12×12 RGBA f32 raw2304B+10×10 reconstructed1600B，共3904B；各两次统一barrier，partial lane在barrier后退出，能力在分配前核对。对完整8×8组，current HDR texture loads为Analyze324/64+Resolve144/64=`7.3125/pixel`，旧候选4+9=`13/pixel`；logical减少5.6875×8B/pixel约89.98MiB/1080p，**不是外存实测收益**。不增加跨pass reconstructed RGB产品；避免其单consumer写读与量化，但增加重复廉价HDR重建ALU和shared占用。

完整组重建数为Analyze256/64+Resolve100/64=`5.5625/pixel`，每次9个shared RGB taps，合计50.0625 shared taps/pixel；径向权重/质心/gradient校正、RGB统计、sigma投影和多尺度协方差都是ADD。partial tile最坏padding税、7232B对occupancy的影响未测。原fractional16-point history共同项不计删除；邻居foreground的额外history fetch已删除。ideal删除Prepare/search/scatter/SPDs/旧history边且cur-color cache/shared复用良好；expected仍依赖完整shader working set；worst重复重建/统计ALU与shared占用超过删除收益。0/50/100%旧工作兑现均需减同一ADD，未取得DELETE>ADD实测资格，不能据read数量宣称净收益。

### 已通过验证的范围

14项Node通过：原V2/Seed checks与共同事务、cached roles、abort、3inflight/fence、拒绝非法提交。真实Native writer→Seed→Analyze→Resolve→RCAS在domain-v1的10个既有ordinary/Product/compact/unlit/MASK/coat/sky fixtures通过有限写域、HDR原reference与最终alpha=1，`.local/phase4-native-writer-domain-v1.json`；输出有限值不是质量比较。该fixture的upscale帧仍保留V2资源，**不是Renderer policy/按域退休证据**。

当前domain-v3实际entry GPU语义 `.local/phase4-pull-semantics-domain-v4.json` passed：23×13 partial、五组普通/大jitter与P=.25/1/4的实际Analyze/Resolve仿射积分/同域moment观测；同域方差支持、zero-variance/rejection清除支持及关闭时间支持的负对照；原HDR moment插值、1080p远角16-point history、自己的Seed/motion、预计previous-view z/raw depth/遮挡、cached graph六提交/abort/三inflight/retirement。早期64phase二次helper证明只属于已退休的候选数学，不冒充当前径向核的二次积分证明。

仍欠：通过的完整质量模型、1080p×256动态矩阵、Renderer native/upscale/AA-off/debug/bypass共同policy与按域history退休、原子production cutover、完整Phase成本窗口。不能声明Phase4返工完成、架构已被证伪或进入Phase5。

## 观测、估计与噪声责任返工

用户再次指出局部补丁循环后，从完整数据合同重新审查。domain-v1/v2/v3的数学一致性检查不证明它们达到质量目标；“raw point moments本身非法”也不是已经证明的根因。raw观测可以作为潜在pixel-area估计的带噪输入，必须区分观测方差与估计方差。以下是本轮确定的源码/数值问题，而不是按case追加的补偿条件：

| 责任 | 问题与修改 | 独立证据 / 限制 |
| --- | --- | --- |
| illumination | 原来拟合current与积累color，再把gain乘回同一color，滞后会进入反馈；改为两帧实际观测拟合，confidence只影响历史mass，不衰减物理gain | 故意令previous color=.25、previous observation=.5、current=1，实际Analyze必须输出2x而非4x；另验1x/.5x |
| confidence | 加入.74/16 radiance mass却每帧增加1/3 confidence；改为同一有效mass控制RGB混合与下一帧confidence | 8个相等权重、不同值的静止观测，actual Resolve输出算术平均与对应mass；只隔离积累责任，不证明全TAA质量 |
| state | 原mean/second moment把变化与采样分布混合，HDR还存在消去；改为last observation与centered innovation variance，仍RG32Float8B | `f32(8192²+1)==f32(8192²)`；真实GPU新state保留L=8192/variance=1，零方差空间边与已知within-pixel方差不混合 |
| reconstruction | current/output观测和raw空间分布各有责任，不再为所有统计强制重建整个tile | 同一actual Analyze/Resolve entry，以独立反导数验证常量/仿射与局部可分离二次积分，5个普通/大jitter与P=.25/1/4；不证明轮廓面积 |
| ownership | 保留已证明的own Seed/motion与共同submit，真实writer不借classifier完成native V2提交证明 | default classifier及新native-resolve消费者分别真实GPU检查；尚不是Renderer policy cutover |

当前非生产图仍只有Analyze→Resolve→RCAS。state语义是本轮effect-private合同修订，不新增pass、history格式/字节、Surface产品或Geometry读取；没有生产selector、兼容层、scatter/SPD恢复。Design与Execution同步记录责任与实际未完成出口。

### 完整模型试验结果（全部保持原质量门）

| 候选 | 完整修改 / 结果 | small硬门失败 |
|---|---|---:|
| innovation-v1 | 删除积累color gain反馈，使用paired innovation统计；径向观测仍有估计偏差与错误maturity | 234 |
| estimator-v1 | 有适用域的积分观测、同域统计、真实observation mass | 119 |
| observation-v1 | raw空间分布与color估计分责、撤掉reconstructed tile；把变化混进历史noise仍导致光照迟滞 | 152 |
| ordered-v1 | last observation/centered variance、相邻观测gain；对gain值乘confidence仍引入幅度偏差 | 140 |
| ordered-final（历史隔离代码，已删除） | gain与confidence分责；同一质量矩阵 | **126，质量资格拒绝** |

原件 `.local/phase4-pull-{innovation-v1,estimator-v1,observation-v1,ordered-v1,ordered-final}.json`（UTF-16），解析同名`.quality.json`；source快照在`.local/native_temporal_v2-{domain-v3,innovation-v1,estimator-v1,observation-v1}.ts`及最终Git修改。失败数减少不构成采纳条件，当前不能切生产。没有放宽2^-10/ROI/逐frame/energy门、尺寸/帧号/场景特判或Dungeon局部benchmark。

| 当前remaining counterexample | Native / Before | 分类 |
| --- | --- | --- |
| static wire display RMSE | .297120 / .193130；frame16等亦失败 | 局部积分适用域之外的薄线采样/估计支持，不能用全图HDR平均掩盖 |
| fast reverse frame29 | .209166 / .126723 | 高位移的history/reconstruction支持；own motion和16-point数值正确不保证动态质量 |
| local light patch total HDR | .096349 / .071915；patch ROI .241715 / .163147 | 多尺度变化模型在mixed footprint边界仍不够，不能再以gain/抬亮特判救边界 |
| foreground total HDR | .082887 / .075784 | 遮挡与颜色footprint估计，不把旧depth支持率当颜色面积 |

uniform、全局light-step/ramp、exposure、reset等有通过项，全局light HDR .010703 / .107490；整体仍失败。126条包括ROI/逐frame/energy，不能把一个通过的数值责任称为完整质量模型通过。当前候选质量拒绝不等于Analyze/Resolve/pull主架构被否定。

### 当前Cost Card与验证

DELETE：Resolve原10×10 reconstructed tile1600B及第二barrier；raw halo由12×12缩为10×10，少704B；不再为了统计做100次重建；Analyze删除previous color/P的实际读取与filtering sampler。ADD：Analyze从previous RG32Float last-observation/variance作manual bilinear pull、两帧shape/跨尺度统计、Resolve illumination/noise更新与mass；这些不是免费ALU。raw HDR邻域统计与current reconstruction各有独立责任，不新增只有一个consumer的跨pass RGB产品。

Analyze仍7232B shared/2barriers，Resolve现在**1600B/1barrier**。完整WG current HDR loads为`324/64+100/64=6.625/pixel`，相对旧候选13少51 logical B/pixel，1080p约100.85MiB；不是DRAM或GPU时间收益。重建数`256/64+1=5/pixel`，45 shared taps/pixel，另加Resolve9tap raw统计，合计54；noise插值、协方差、sqrt/exp/log、fractional history及occupancy完整列ADD。Analyze峰值7 sampled textures/3storage textures；Resolve5/2。history总量仍40+32=72B/pixel，未省持久显存。0/50/100%旧工作删除兑现都扣同一ADD，未测DELETE>ADD实测资格。

最后fresh build:test源SHA256 `56deffd743b6cfe130d3e92e5f56bc7cd019b9aa9b4b82fe2f32a58bbe30d069`，输出SHA256 `02e08e547a45804a2c2edcd40b915322f0a91ac66a4004bbc375ed2f963912a9`。typecheck、14/14 Node、WGSL文本保持验证通过；同build串行GPU：`phase4-pull-semantics-ordered-final.json`、`phase4-native-writer-ordered-final.json`、`phase4-seed-classification-ordered-final.json` passed，`phase4-pull-ordered-final.json` failed（126条质量门）。adapter报告nvidia/turing/hardware，不作GTX1650Ti性能资格。

保留中间失败：`phase4-pull-semantics-estimator-v1.json`为oracle自动layout漏删unused binding，v1b修正后过；`phase4-pull-semantics-ordered-v1.json`为module-not-loaded宿主失败，v1b实际执行暴露FrameGraph binder先取undeclared previous color，修正先排除真实unused binding后v1c过。都不是质量通过/架构不可能证据，没有吞异常。actual writer保原HDR reference/有限值/alpha/角色检查，其upscale帧仍不退休V2，故不作整Renderer按域退休证明。

**该历史轮完成的是数据责任、事务与数学检查返工，未完成Phase4。** 自主估计器方向随后按用户要求退休，以完整成熟参考profile替代，见下节；上述数值与失败不追认为修复。

## 参考profile迁移与质量比较校准（2026-10-12）

源码基准HEAD `e26b922b83e244437f7676e13723fb1eece51d6c`。隔离候选改用AMD SDK 1.1.4 `c6efa6bf7f2027b3ec94f28578bb5965eabb9e55`的完整重建/历史响应profile，MIT与函数映射见porting记录；删除renderer的自主`native_temporal_v2.ts`，新增`native_temporal_amd.ts`。Donut完整候选因质量拒绝，仅保留test-only参考。当前隔离物理图为Seed→Measure→Exposure→Analyze→Resolve→RCAS，生产仍旧T3。这是候选移植与物理适配，未达到production adoption。

AMD候选保留径向Lanczos/Gaussian统计、fractional16-point history、thin locks、四帧luma instability、源confidence/elliptic clipping/tone-domain blend与曝光适配。Analyze的previous-depth pull仍有本地对称depth/slope判定，尚未完成AMD `ComputeDisocclusions`语义适配；不能声明其完整来源adoption。曝光reset已定位并修正；格式边界和UV算术次序的对照还需要当前build复验，不能把减少失败数当来源/质量通过。

成本修订：V2 history46B/pixel，加完整Seed identity pair32B，共78B/pixel（旧70B），固定资源196B；transient analysis4B、half-depth约.5B/pixel及64tile日志。store下限约63.5对旧69B/pixel，未计共同HDR/RCAS/SPD/RMW，不是实测DRAM收益。Measure/Exposure各16KiB shared，Analyze10880B；Analyze每output16个source difference、每个10次luma取样与sort是显著ADD。旧native scatter/clear/SPD等DELETE尚未在生产兑现，无净性能资格。

保留GPU结果：`phase4-pull-semantics-amd-v12.json`在原.003容差下通过8场景2392pixel/19136lane及共同事务等检查，仅证明当时build；v13改变instability半精度边界失败，已撤回；v14 probe错误假定pack必与store不同，后改独立CPU nearest负对照，修正尚待复跑。`phase4-pull-amd-v14.json`/`.quality.json`仍为**55条原质量门失败**。后续源UV次序修改尚未在该结果中验证；不得写成当前shader已通过。

用户随后问质量检查是否过严并授权适度放宽。原所有normalized RMSE均用固定`reference+2^-10`，缺乏将不同算法的小指标差异视为可接受的空间；该floor也不等于所有格式误差的严格传播上界。统一改为：序列/ROI HDR及display RMSE允许`max(2^-10,1%×reference)`增量，逐frame ROI RMSE允许`max(2^-10,3%×reference)`；energy/phase、独立拖尾/峰值/settling和numeric/identity/motion/lifecycle不放宽。1%/3%是用户授权的工程取舍，不是感知证明；场景/ROI/golden/warmup不变，保留旧严格诊断与实际policy。

对已保存v14数据的离线重评（`.local/phase4-quality-policy-v1.json`）：55→**19条仍失败**，其中foreground15、fast reverse2、external-jitter Siemens2。它不是新GPU执行，也不追认原55条为通过。

| v14真实观测 | Native / Before | 含义 |
| --- | --- | --- |
| static thin全图HDR RMSE | .328598 / .328419 | +.0545%，允许统一小差异 |
| fast reverse全图HDR RMSE | .338434 / .337321 | +.3300%，但逐帧仍有失败 |
| light step/ramp全图HDR RMSE | .107944 / .107490 | +.4230%，不必追逐数值相同 |
| foreground ROI HDR RMSE | .096610 / .078529 | +23.0%，实质退化，不能调门掩盖 |
| foreground frame22 ROI RMSE | .225964 / .123999 | +82.2%，必须查遮挡与history资格 |

本次只校准测试比较和同步authority，未改production shader/runtime、未重跑GPU或Dungeon。下一步仍是同一AMD profile内完成previous-depth disocclusion适配与整链验证，随后补完整动态矩阵、真实writer、policy/生命周期、原子cutover和成本；Phase4仍未完成，不推进Phase5。

## AMD深度分离移植与轮廓motion输入定位

后续用户授权继续完成Phase4。`depth_history_confidence`移植AMD `ComputeDisocclusions`的四点加权、`Ksep=1.37e-5`/半viewport长度与单侧分离规则，删除原对称depth/slope/min-depth混合规则。actual previous-depth pull不使用source scatter的小motion snapping；sky独立处理。保自己的Seed读取，未切生产。jitter消除统一像素域再转UV，避免独立Resolve fixture中静止motion出现微小非零并进入不同历史分支。

原失败保留：`phase4-pull-semantics-amd-depth-v1.json`是完整Resolve differential失败，pixel0绿色.02504对.03235；源UV取消次序导致微小motion、历史分支不同。修正后`phase4-pull-semantics-amd-depth-v2.json` passed：原.003容差，8场景19136lane最大relative .0019193858；R16实测16样本，与独立CPU toward-zero一致，10项不同于CPU nearest，但同shader probe的pack与store未不同，不推断pack在所有shader上下文恒为某舍入方式。

`phase4-pull-semantics-amd-depth-v3.json` passed：实际Analyze writer新增分离公式半置信度刺激（参考`z=1/(1−2*Ksep*halfViewport)`，前depth1，包含RGBA8量化），7个cached共同提交、自己的motion/预计previous-view z/raw depth、abort/3inflight/fence仍通过。`phase4-native-writer-amd-depth-v2.json` passed：真实Native→候选完整AMD图；不冒称Renderer按域policy/cutover或动态质量验收。typecheck及14/14 Node通过，fresh build:test源SHA256 `3632e286487c3c38cb1e21a0ea76a38a06d220ae2baf9d75398141de2a032165`、output SHA256 `5e11494c3367e79755358194e0b50c840e825939b5eaeb7e38b220187b0aad8d`；完整identity与每次oracle哈希保留于raw。

`phase4-pull-amd-depth-v2.json`真实GPU小矩阵仍**19条新质量门失败**（旧严格55）：fast reverse2、foreground15、external-jitter Siemens2。foreground全图HDR RMSE .096498对.075784，前景ROI .106233对.078529；单侧规则移植没有解决整链质量，不能宣称通过或完整architecture falsification。

最严重frame17/pixel(27,9)的trace：current reconstruction相同约.250681；旧路径motion.x=−.0234375（−1.5pixel），新路径motion.x=0；旧输出.934082、新.118652，golden1.057436。旧source的nearest前景motion覆盖边缘的颜色AA footprint，新图使用中心背景的motion，颜色历史来自不同表面。它是参考profile输入合同差异，不是PCF/Geometry重建或全局曝光错误。AMD、Wicked、Unity的相关真实源码与许可证边界见porting记录；单侧depth移植不自动修复颜色footprint关联，Siemens/fast剩余数值问题也尚未解决。

已向用户提出具体合同修订请求，尚待答复：**Seed保持每pixel自己的motion/depth/identity；Temporal颜色历史消费可在已有3×3 Seed中按AMD选择前景receiver。** 拟新增9个Seed读取/比较、可能的短private live-state，不新增full-screen Prepare产品/dispatch，不恢复scatter/clear或Geometry恢复。这会撤销当前禁止邻居motion消费及必删9depth search的部分承诺，因此当前未擅自实施、未改目标authority，也没有第二production path。选定后需同时完成Analyze/Resolve的receiver关联与独立资格、全部消费者/事务及重算Cost Card，不是仅替换一个textureLoad。

## 已批准receiver合同与完整producer调整（2026-10-12）

用户明确批准“允许按参考修订颜色历史合同”。Measure在既有3×3 Seed上按AMD顺序选nearest receiver，写R32Uint索引供Shading Pyramid、Analyze、Resolve；原Seed/identity/raw depth仍逐pixel保存自身事实，不恢复Geometry、独立Prepare、scatter/clear。颜色输出域决定history是否在屏幕内；raw depth UV按参考clamp，不能用大jitter的raw域越界拒绝有效输出域。previous raw depth的四点中，背景safe tap不能抵消前景occlusion：取必要nearest贡献者的Ksep confidence，而非把source scatter的any-safe规则直接用于raw history。它是显式physical/data-domain adaptation，不宣称AMD depth bit parity。

原失败保留：receiver-v1语义probe误将新增helper一起截取，缺少output_motion，属test extraction；修正后receiver-v2语义通过。receiver-v2质量仍27条失败，具体foreground frame18/pixel(13,9)旧输出.12183、新1.05469、golden.12314，新coverage=1错误保留前景历史；external jitter raw域错误拒绝则使confidence反复停在1/3。修正后 `.local/phase4-pull-semantics-amd-receiver-v3.json` 与 `.local/phase4-pull-amd-receiver-v3.json` passed，17序列/既定1%/3%门，foreground HDR RMSE .07581对.07578。场景/golden/ROI/阈值未为候选修改。

首个整链1080p成本 `.local/phase4-native-v2-cost-receiver-v1.json`：fractional motion reference/native P50 10.754/41.916ms，stationary 9.407/21.412ms。该local-halo候选明确拒绝，不否定Seed+pull/reference架构。Analyze每输出16次source_difference排序与luma读取是根因。完整producer调整为Shading Pyramid：每source pixel一次signed difference，8×8合作归约2/4/8，写3个RG16Float尺度给Analyze。保参考算法和量化边界，不混搭donor。新增一个dispatch、1.3125B/pixel尺度store/容量（1080p2.60MiB），删除15/16差异重复计算及Analyze 10880B shared；新pyramid672B shared。Measure/Exposure仍各16KiB。store下限68.8125对旧69B/pixel，不称大规模history节省；history仍78对旧70B/pixel。

`.local/phase4-semantics-pyramid-v3.json`：完整Resolve differential/实际Analyze/raw depth/前景颜色receiver/7 cached submit/abort/3inflight/fence通过。前两版失败分别是新增shader helper遗漏及旧pass-list断言未迁移，原件保留；未改数值容差。`.local/phase4-quality-pyramid-v1.json`17序列passed。`.local/phase4-native-v2-cost-pyramid-v1.json`同一ABBA：fractional reference/native P50 10.884/10.231ms，stationary9.508/8.888ms；每path12样本，16帧warmup，完整链envelope含pass间隙。只是合成局部cost，有break-even但不是Dungeon整帧、正式尾部或60FPS资格。

生产cutover：FrameProgram根据实际两轴选择native/upscale/bypass，Native由新owner运行，FSR只接受真实upscale；删除旧NativeTemporalPasses与native_temporal production shader。Seed和Native全histories同command成功submit推进；inactive domain只在replacement提交后按last-use fence退休。bypass不造color writer，identity仍真实写；重新开启时invalid color role与Seed对齐。Temporal registry新增prepare checkpoint，abort恢复上一成功revision/roles/validity，不能保留失败policy/resize的状态。37项targeted Node通过。

`.local/phase4-renderer-cutover-v2.json`真实Renderer通过：native↔upscale↔bypass、实际graph无旧native Prepare/scatter/SPD/T3、camera cut/resize/abort/retry、3inflight/defer、controlled epoch、真实material/winner/HDR事务；首版有Lowering仍强制fsr3 stage的接线错误，已删除该旧假设，原失败保留。此结果在Shading Pyramid调整前；最终producer图仍需重新运行真实Renderer。完整动态256帧矩阵另行执行，不能由17个小序列替代。

## Phase4最终出口：输入语义校准与紧ROI补查

全1080p×256六类矩阵首轮replacement失败，不是原算法质量退化的结论。v2 fixture将同一owner的revision只改部分像素，v3仍将Native原始response.z的coverage语义误用成旧classified mask.z的hard replacement。修正为同一owner全域revision与真正NATIVE_TEMPORAL_SEED_CLASSIFY_WGSL输出mask供Before；Native保持raw response。`.local/phase4-matrix-v1/v2/v3/v4.json`保留全部原件，v4六类1536帧、四固定ROI通过；没有改变阈值或帧数。

为补齐线/MASK/运动/replacement/light/HDR紧bbox的局部检查，新增独立analytic stimulus决定的四类tight ROI，连同原四ROI每family共8ROI。`.local/phase4-matrix-tight-v1.json`六类全部执行，发现仅static thin的vertical/horizontal ROI共4条均值HDR/能量失败：HDR .195190对.193121、.067586对.066000；energy .113698对.112531、.038827对.037387。不能用前一轮宽ROI通过覆盖此失败。

源码对照发现Analyze以手工f32 bilinear代替AMD ShadingChange对RG16尺度的hardware linear采样。改为同参考textureSampleLevel与filtered布局，恢复真实格式/采样边界，不调权重、不引入第二算法。`.local/phase4-semantics-final-v1.json`独立complete Resolve differential与实际receiver/raw depth/生命周期通过；紧ROI矩阵按原条件重跑。

按需闭包：AA-off用已完成Native Surface writer验证Seed/response/identity角色，只在真正提交时发布identity，不执行无人消费classifier；debug仍需求classifier。Analyze移除已由Shading Pyramid消费的current/previous luma与exposure-buffer旧绑定，sampled峰值13→11，Resolve10。空场景提交后退休两种inactive color backend，abort不提前释放。新增stale-role/duplicate-proof/abort测试后38项targeted Node passed。最终Renderer必须再实际覆盖Shading Pyramid、AA-off/debug/empty/native↔upscale，不由这些单测代替。

恢复参考hardware scale filtering后 `.local/phase4-matrix-tight-filtered-v1.json`仍有同4条thin ROI失败（HDR .195216/.067479，energy .113705/.038780），故不能把该表示修正当作根因已修复。下一步使用80-frame固定thin scene的8个intermediate probe读取analysis/frameInfo/color/raw luma/luma history；这是数值定位，不是质量资格或性能benchmark。

薄线定位进一步结果：`.local/phase4-thin-probe-v1/v2/v3.json`分别读取8点的analysis/frameInfo/color/raw luma/luma history及三个尺度。除reset外raw luma、frameInfo.xy与所采尺度一致；frame7 vertical point的change/confidence为旧0/1、新1/255与254/255，造成逐帧lock/history细小偏差。独立256值R8实际UAV store/load显示half-way处理与WGSL round不同；真实storage product上的预先round构成重复量化。删除Analyze/confidence真实store前预量化，消除已删除ShadingChange R8边界的tie差异；不改变算法权重/质量门。`.local/phase4-thin-probe-unorm-v1.json`80frame局部诊断：64–79 vertical HDR .183225对.181804，energy .106455对.105647；horizontal HDR .062577对.061652，energy .037151对.036350，落入原统一门。80帧不代替完整256帧验收。

`.local/phase4-thin-probe-fraction-v1.json`另测R8硬件linear权重，观察8bit fraction及16bit UNORM结果表示；未把这一硬件近似写成production插值算法，不以追求source bit parity改变架构。全部诊断只在test-only matrix probe入口，无production selector。
## 最终闭包与成本结果（2026-10-12）

`.local/phase4-matrix-final-unorm-v1.json` **passed，failures=[]**：1920×1080，六类各256帧、每类8个ROI，共1536帧。完整HDR/display逐frame与aggregate、peak、phase、energy、positive trailing error及settling保持原门；有测得settling的两路径帧号一致，null仅表示两路径在窗口内均未返回pre-change envelope，不证明绝对收敛。synthetic color/Seed矩阵不模拟完整normal/coat/material求值，真实writer和Renderer另查；人工动态显示、Dungeon及全feature整帧资格留Phase5/6。

矩阵build源SHA256 `3fb44f36cb0cd847f183a47b60126f3f1c3d6178fbfce5bf206f3ceaf90616be`、输出 `fc778a7cab2f1fde1e58ae7927500df038d3989d9198292be7bb0af8aae9d2b3`。之后仅增加CPU事务/完整writer校验、按需debug/empty接线和格式整理，shader数学未改；这些变动由下列新鲜build上的真实GPU检查覆盖，不借旧矩阵证明新事务。

- `.local/phase4-semantics-final-v2.json`、格式整理后最终`.local/phase4-semantics-final-v3.json` passed：完整Resolve 8场景19136lane差分最大relative=0；actual Analyze receiver/raw depth、Ksep半confidence、cached七提交、abort/3inflight/fence通过。
- `.local/phase4-quality-final-v2.json` passed：17个小动态/数值序列，补充partial、external jitter、dolly与reset语义；不替代完整矩阵。
- `.local/phase4-writer-final-v2.json` passed：真实Native writer进入当前Measure/Exposure/Shading Pyramid/Analyze/Resolve/RCAS，ordinary/Product写域、motion/identity与共同提交通过。
- `.local/phase4-renderer-final-v1.json` failed：Native Velocity debug使classifier与V2分别导入previous identity，FrameGraph binding重名。已改为Lowering一次导入、两个直接consumer共享同一exact history产品；不增加pass、不改算法、不掩盖失败。
- `.local/phase4-renderer-final-v2.json`、`.local/phase4-product-final-v1.json` passed：最终ordinary/Product真实Renderer、Shading Pyramid、native/upscale/bypass、AA-off无多余classifier、按需debug、空场景failed submit保留历史/成功submit退休、cut/resize/abort/retry/三inflight/defer/controlled epoch与实际winner/material/HDR闭包。
- 完整性校验发现ChangeSignal会捕获observer异常，故新增Renderer直接调用Seed/V2 `assertCompleteFrame`；原生命周期通知保留。39项targeted Node passed，无跳断言或容差放宽。

Renderer/Product/成本build源SHA256 `eb18c731f694d96758b985dee4a8ee7e2f5aca7692a3f5bda9c94ed5a385025b`、输出 `d33022993fd659a0772903080904a371b0a3475a5153d9f55f934bc4b0969c51`。随后只有等价格式整理与writer报告补齐完整pass名；最后fresh build:test、production build（包含typecheck/declarations）通过。最终writer/semantics源SHA256 `93010fdbfd1c5665bd2eb1acf21eca2bd34cb121be887239b27888d220cbc90e`、输出 `92fff3d19f00c770dd0be176217ce9142de3771fe509a69588c8d73e32a7c8c2`。真实adapter只报告NVIDIA/Turing硬件，device/description为空，Chrome154.0.8037.98；不能把它当精确GTX1650Ti型号验证或锁频/热稳条件。

`.local/phase4-cost-final-v1.json` passed：1080p完整Temporal envelope包含pass间隙，两种motion各16warmup、每path12样本ABBA，按`floor((n−1)×.5)`取P50。fractional Before/Native **11.257248/9.655264ms**，stationary **10.007360/8.681472ms**；本窗口观察到unit break-even。raw范围分别9.859040–12.564480/8.887392–12.343232ms、9.384384–11.341760/8.220672–10.575552ms，样本少且未锁clock，不把差值称稳定production净收益。不是Dungeon whole-frame、P95/P99、60FPS或Phase2/3回归已解决的证据。

生产Native已删除旧Prepare/reconstructed clear/atomic scatter/global SPD/T3 owner；必要参考luma/confidence/exposure语义归新owner。完整identity未缩；persistent仍78对旧70B/pixel，store/clear下限68.8125对69。没有大降history容量、整Renderer性能改善或完整SDK bit-exact adoption claim。本轮停在Phase5边界。
