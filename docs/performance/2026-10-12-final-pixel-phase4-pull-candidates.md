---
id: final-pixel-phase4-pull-candidates-2026-10-12
state: history
---

# V5 Phase4：隔离 previous-depth pull 候选与返工记录

起始生产HEAD `015548a7d5707975701a844c3b06df3ba8a28303`。本记录是候选事实，不是新设计/执行authority。Phase3已完成的结构、语义与提交闭包未发现新返工或延期依据；Phase2/3已有成本回归仍保留，依执行计划在Phase5/6联合收口。没有使用子agent。

**Phase4未完成。** 最终隔离候选的small质量矩阵仍有10条硬门失败，尚未切生产、尚未删除生产native scatter/SPD/histories，不进入Phase5。生产保持Seed classifier→FSR Prepare/scatter/clear/SPDs→旧T3→RCAS。候选失败不满足architecture falsification条件。

## 实际候选物理图与Cost Card

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
