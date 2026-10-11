---
id: performance/final-pixel-phase1-closure-2026-10-11
state: current
verifies:
  files:
    - OEngine/src/gpu/FinalPixelAbi.ts
    - OEngine/src/gpu/GpuNativeMaterialPublication.ts
    - OEngine/src/render/surface
    - OEngine/src/render/temporal/NativeTemporalSeed.ts
    - OEngine/src/render/environment/FinalPixelSolarPublication.ts
    - OEngine/src/render/lighting/LocalLightWorkGenerator.ts
    - OEngine/src/render/vsm/VsmSamplingPublicationPass.ts
    - OEngine/src/shaders/native_surface.ts
    - OEngine/src/shaders/native_surface_lighting.ts
    - OEngine/src/shaders/native_temporal_seed.ts
    - OEngine/src/shaders/surface_geometry_completion.ts
    - OEngine/src/shaders/atmosphere/runtime.ts
    - OEngine/tests/contract/final-pixel-phase1.test.mjs
    - OEngine/tests/oracle/final-pixel-phase1-gpu.mjs
    - OEngine/tests/oracle/final-pixel-solar-gpu.mjs
    - tools/gpu-oracle/registry.mjs
---

# V5 Phase1：非生产Final Pixel闭包

交付是 geometry-once / fused Sun / Native Seed / classifier 的完整非生产 producer→consumer 实现和生命周期验证。**没有生产cutover、没有性能收益或整体动态画质通过声明。** Production `FrameProgramLowering` / `RendererCore` 接线未改，仍是S3+T3；Phase2/3负责原子切换与旧链删除，Phase4负责真正Native Temporal V2。完整合同只读[V5 execution §4](../next-execution/eengine-v5-final-pixel-performance-execution-2026-10.md#4-phase-1--final-pixel-ownership--native-seed非生产完整闭包)。

起始源码 `49fcaa300fafcbbe3db142df403baa3487f89956`，authority先提交 `e2ebed80d6025c80b4435e5d5e6cb2c9aadd7575`。设备由真实GPU report给出 Nvidia / Turing / hardware，device名称字段为空；**不冒称GTX1650Ti**。Chrome `154.0.8037.98`，Node `v24.14.0`。全部GPU作业串行；计时未采样，无Dungeon、P50/P95/P99、spill/occupancy/DRAM claim。

## 实际替代闭包与成本

Native staged completion保留本次winner/instance/vertices/position/coefficients，再为同一次invocation完成attributes。Sun在material大live-set之前完成原point-PCF，跨material只携带scalar visibility；Seed利用现有world position/instance/materialdirectory写motion、预测previous/current正viewZ、原四u32 identity和response。compact unassigned writer复用原bins classify，assigned lane由Native唯一写；empty-domain处理sky及malformed winner。classifier只读Seed/response/current/previous identity，比较原hard/soft replacement与4-neighbor MASK提示，无Scene/Geometry输入。

local lookup和VSM descriptor直接写同一个当帧container的各自区间；FrameGraph按同一resource version串联生产者，不复制这两个容量级产品。Native目录32B/slot；raster仍16B/slot；目标无separate8B/slot versions副本，因此目录净physical增量为8B/slot，不能只按directory16B增量报总内存。Seed/response scratch20B和identitypair32B，共52B/pixel；1080p102.83MiB，加classifier4B/pixel transient mask7.91MiB。旧opaque4+Facts28=32B producer写；目标Native36+classifier4=40B，临时多8B/pixel写；Phase4 Analyze吸收classifier，不能把Phase1当已删除Temporal全部traffic。

Solar传输candidate C0需要7+M+P sampled，不能覆盖旧合法continuation的全部域；C1保留同一fusion结构，将原固定half LUT放进已有lighting binding，变6+M+P。ADD131072B/container/frame、固定copy边、four-half-texel buffer读取+decode/linear clamp ALU；原filtered读取至多四texel逻辑32B，不能把改变访存类型当作32B免费删除。VSM/local容量级copy仍为0；无新compute dispatch、atomics/WGbarriers或submit。完全版storage15+Bm、outputs4；Sun-only seam两输出/旧directory与Aux，可独立迁移Phase2，不提前分配无consumer Seed。

DELETE在prototype图中成立：没有独立Shadow receiver/fullscreen mask、没有Facts reconstruction、没有目标Sun continuation/第二HDR。production删除仍为0。理想/预期成本有真实删除项，worst为新Native occupancy、descriptor lookup、Solar manual interpolation或Seed traffic覆盖其收益；0/50/100%删除兑现均扣新增税，必须在正式完整cutover后证明break-even，现阶段不由小oracle运行时间改架构。

## 验证结果与raw索引

raw只保留于 `.local/`，不提交大型原始结果；report包含完整source/output/oracle SHA及device/limits/errors。

| 检查 | 结果 / raw |
|---|---|
| Engine typecheck + `npm --prefix OEngine run build` | 通过；Vite仅既有codec `node:module` browser externalization警告 |
| fresh `build:test` | 通过；closeout sourceSHA `f7815b3ae82c36f8ead3398f374f33d8669f32d9ecd43fc72f434db37d724e1b`，outputSHA `67823b8635e05b9f066675509d9bd7a175da66b137b8249603f249ad8fdebf0e`；原结果各保留其自身fingerprint |
| 受影响Node contracts | 41/41通过，`.local/final-pixel-phase1-final-affected-node.txt`；ABI/capacity、submit/abort、三unresolved fences、resize/domain rollback、material publication/bins/Surface/local/lighting |
| 完整闭包，16 storage / 16 sampled / 4 storage textures | 10场景×18成功提交=180；`.local/final-pixel-phase1-final-minimum.json`（原minimum-first也保留）；M10+B_m1真实消费、Product+compact合法 |
| 完整闭包，16 storage / 19 sampled / 4 storage textures | 10场景×18=180；`.local/final-pixel-phase1-closeout.json`；M13+B_m1真实消费，参考旧合法Sun continuation，无目标continuation；zero scoped/uncaptured GPU errors |
| 16 sampled能力反例→修正 | `.local/final-pixel-phase1-binding-boundary.json`保存C0反例；`binding-boundary-fixed.json`证明旧primary16/continuation14和目标单shader16均真实GPU compile |
| Solar byte/采样 | `.local/final-pixel-phase1-solar-closeout.json`及原solar-numeric：4145 UV；half字节逐项相同，非Solar区间poison未被覆盖；CPU max误差5.960464477539063e-8≤2^-20，旧filtered GPU最大差0.00026172399520874023≤原.003合同 |
| controlled deviceepoch | `.local/final-pixel-phase1-epoch-second.json`；两个独立adapter/device epochs，实际Seed producer→classifier→submit，然后有active+pendingresize时destroydevice；每epoch29224B→0，下个epochhistory invalid；不称真实driver故障 |
| 既有production资源profile回归 | `.local/final-pixel-phase1-final-resource-profile.json`通过；actual Native material Product、MASK/coat/normal、普通与Product布局等；不是整Renderer性能 |
| 原VSM精确PCF/publication回归 | `.local/final-pixel-phase1-final-vsm.json`通过；固定源reference、全部query状态与radius/taps、exact PCF |
| bins / local work回归 | `.local/final-pixel-phase1-final-bins.json`、`local-work.json`通过；原classify/finalize与count/scan/scatter算法未改 |

闭包场景：dense、compact partial、Product资源布局、真实residentProduct decoder、真实textured MASK/coat/normal/material Products、unlit、empty、perspective sky rotation、max material textures、Shadow-only seam。每scene包含首帧/cut、camera dolly、rigid affine、material/geometry full-generation replacement、deformation invalid、sky/malformed keys、已分配但primitive completion失败、abort/retry、resize/domain切换与三帧在途。先poison三输出以揭示未写lane，非全屏clear后假通过。resident Product是解析缓存分支fixture，不是streaming/admission/全production VG验收。

## 品质边界与失败保留

Motion独立CPU max误差1.1920928955078125e-7，当前/预计previous positive viewZ按原小numeric门核验，identity保留原完整四u32格式及原hash语义，不新截断generation。Sun-only seam与完整融合图HDR最大差0。与旧S3比较中，page边界之外HDR max差0.00048828125；**全域最大差0.1279296875，未宣称S3全域画质等价。** 差异发生在独立解析plane/light-page边界容差域：旧receiver从Depth inverse-VP恢复position，新Native使用barycentric winner，f32微差可选中不同page/tap。报告保留每frame boundary差异计数和最大值；oracle分类此问题用于Phase1定位，**不豁免Phase2动态shadow质量矩阵、不放宽原全Renderer门**。Phase2必须处理/证明receiver arithmetic与actual moving-shadow/normal合同后才能cutover完成。

先前原始失败不覆盖：`first..eleventh.json`保存WGSL重复UV变量、fixture提交label、exact page边界、bin去重fixture、malformed empty-domain写域、BC feature未协商等。第六次因执行期间修改依赖导致freshness无效，不能算验证；这次之后GPU期间冻结源码。`epoch.json`的失败是fixture复用已consumed adapter，修正为每epoch重新requestAdapter后epoch-second通过；未改Seed行为。Node fixture首次缺少GPUShaderStage也保留，改用已有test globals；binding-red保存17≠16，C1后binding-green通过。

全量Node额外检查**未通过**：首轮从repo根调用，native工具相对路径错误，结果无资格代表engine suite；正确OEngine cwd重跑仍发现以下范围外失败，随后独立重现，未跳断言/改fixture/修改Geometry Frontend：

- `material-closure-v2`：zero coat仍生成coat sample；本轮CanonicalMaterial/glTF loader及该test与HEAD未变。
- `product-cutover-audit`：递归扫到原有ignored Dungeon `dist/assets`旧bundle的`uploadScene`；本轮未改这些bundle，未删测试以求绿。
- `oegpack-v3` A1-A7：native cook bytes未达跨thread deterministic；A8：bootstrap计数0≠2；raw `.local/final-pixel-phase1-unrelated-failures.txt`（同次Nyx differential等11项通过）。
- `nyx-function-map`：缺 `dag-process-meshlet / hierarchy_projected_error_pixels` GPU semantic evidence；raw `.local/final-pixel-phase1-nyx-provenance-second.txt`；未生成证据来掩盖缺项。
- 全套在 `pc-texture-product.test.mjs` worker未退出，主动中止，`.local/final-pixel-phase1-all-node-tests-engine-cwd.txt`保留部分结果；无完整套pass/count声明。

全套范围外失败不当Final Pixel收益/架构反例。它们仍未修复；任何相关功能的未来cutover必需门不得因此被追认通过。Phase1出口只采信完整受影响contracts与真实非生产GPU闭包；1080p动态画质、生产GPU cutover、Dungeon ABBA、P50/P95/P99、GTX1650Ti身份/4GB峰值和寄存器/访存验收均留对应后续Phase，未执行。
