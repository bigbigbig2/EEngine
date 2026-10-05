# Surface V3 Phase 7：正式整合与验收

日期2026-10-05；起点`a7e415d2`（Phase6通过并提交）。状态：实施/验收中，未完成。依据总V3设计§8–11、有界设计§22、执行计划§10、VALIDATION。源代码与固定条件结果分别核对；诊断不是accepted evidence。

## 必需覆盖矩阵

| 条款/不变量 | producer→产品→全部消费者 | 正常/边界/失败与独立预期 | 成本/结构/实际结果 |
|---|---|---|---|
| 整合编译与合同 | 当前TS/WGSL/FrameGraph唯一链 | fresh build:test/typecheck/build、必要整合回归、退休语义映射 | 本阶段build:test/build含typecheck与492modules通过；97+89相关targeted通过；全仓runner仍未完成通过 |
| 身份与数值 | candidate/value/certificate→Field/Signal lookup→worker/Store/compose | UV/sampler/梯度/side/LOD/content/provider、正常hit与局部拒绝、parent误差/复合误差 | 原GPU入口重跑；完整identity、无热consumer重decode |
| 唯一写域/失败覆盖 | controls/actual queues→unique record/closure/kind→Store/ref/HDR | empty/partial/last/all-hit/miss/fine、hash/cache/memo/proof/mixed满、NaN poison、writer/key≤1 | output总覆盖/互斥、实际witness/proof/ref/cold量及overflow原因 |
| 真实生产材质/Geometry | ordinary+静态Product+current/previous刚性变换→唯一record | perspective/near clip/W、nonuniform/mirror/tangent、UV/ORM/normal/coat、缺页/LOD切换 | 实际producer→reader数值，不预填正确结果；skin/morph不在本次范围 |
| providers | clustered lights/VSM/physical/authored IBL/AO→独立signals→cheap compose | 非零有效provider、π/AO/finite/coat一次、动态版本各自失效 | 20 Lighting及4实际provider、非零lit链通过；完整场景组合/连续质量仍待测；unlit零工作独立断言通过 |
| lifecycle | Surface/TemporalFacts/Stores/renderer→resize/cut/abort/device reset | NPOT/rapid/back-and-forth、namespace/pin/generation、单Product/多Product恢复、空场景 | 实际fence/retire/预算/资源重建，非mock生命周期证明 |
| browser能力 | adapter/device limits→当前shader/profile→真实dispatch | 用户最新约束：仅Playwright调用本地Chrome；optional feature不作为正确性要求 | Chrome实际feature/limits/编译/输出；其它浏览器未验收，不算通过 |
| 连续画质 | near/far/static/orbit-return+高频/低频/multi材质/强IBL | AA/normal/ORM/spec/coat/轮廓、AO开关、direct+VSM、纹理更新、LOD/page miss | 连续截图/受控全rate独立参考及误差，不只小链出图 |
| fixed timing/detailed/quality | 固定资产/相机/feature/输出/热状态→连续窗口 | timing禁细counter、detailed单独、quality独立trajectory；重复独立运行 | CPU/GPU span/pass sum/Surface全成本P50/P95、真实内存/BG/clear/copy/工作量 |
| 历史性能 | 独立checkout `89f0a94/15f12f7b/e7296be9/14c17078/final` | 共同能力子集同画质/条件，完整最终功能另列，warm/cold/motion/high-frequency | 小于波动不判收益；同质量落后继续按热点返工 |
| 正式证据/claims | 可复算固定revision/条件→validation宿主→接受流程 | 原始失败保留、final生产改动后受影响重跑、不拼快照 | 最后才接受，只限真实通过范围，当前未晋级 |

## 起点身份与本机可用环境

Phase6提交`a7e415d2`后工作树clean。Chrome154.0.8037.93、Edge146.0.3856.59、Firefox150.0.1可执行文件存在；这不等于WebGPU能力通过。首要设备GTX1650Ti、1920×1080；固定驱动/adapter/feature/clock和temperature从实际runner记录，不能猜测。

Phase6原报告保持其身份；当前尚无Phase7正式验收结果。历史89f0a94没有next-renderer-showcase，使用当时RenderingLab production宿主的能力映射；不得直接注入新renderer或修改历史shader来凑统一入口。原Dungeon GLB存在于五版本，仍需核对完整资源与材质语义。历史source/production能力差异影响共同子集，需要独立消费者与同画质检查。

用户最新要求（2026-10-05）：浏览器只能使用Playwright调用本地Chrome。已停止本次Firefox/BiDi runner及其子进程；不再执行Edge、Firefox或直接BiDi。既有失败报告保留，均不计验收通过。Chrome headed视觉宿主的Instance dropped错误尚待定位；headless真实GPU链通过不替代连续质量验收。

用户再次明确本次不需要skin/morph支持。Phase7只验收当前静态Geometry/Product、current/previous刚性变换和已有deformation revision/motion-invalid合同；不建立skin/morph producer，不把它们列为本目标阻塞。总设计/历史清单中的skin/morph/previous deformation是未来representation能力，整体架构的不同backend边界和可靠motion原则仍保留。本阶段矩阵之前列入skin/morph为范围误判，现已撤回。

执行顺序保持§10：整合→数值/覆盖/overflow→真实生产Geometry/provider→browser/lifecycle/连续质量→固定条件历史比较→热点返工→正式evidence。必需缺口未通过前不标完成；性能和质量目标不降低。

## 本轮集成修复与复测

生产身份：HEAD `a7e415d22f621e4ee2dc58ffd0ab80b0675f2f88`+本阶段dirty，`.local/validation/phase7-unlit-integration-source`的886文件组合SHA256为`29f7976faea50c068abb42759de8a84cb12098e42a70e08b2d26cd7b79023450`。此快照后未改生产源码；测试/宿主/文档变动不冒充clean正式evidence。

- 原真实unlit失败保留于`phase7-unlit-original`：FrameProgram无cluster/IBL产品，却无条件要求lit providers。修权威lowering和Surface Lighting owner，按正式ABI导出算完整无页lookup与最小合法空绑定，不产生cluster/IBL pass；资源显式account/destroy，Lighting同一indirect链仍以零实际需求执行。
- `phase7-unlit-contract`：11项真实Renderer用例，10995可见像素、coverage pass，Lighting records/signal values/cache requests/diffuse/specular/coat/IBL均为0；无cluster/environment producer；空绑定buffer98392B+texture8B纳入真实accounting，destroy后owner无存量。namespace/recovery像素最大差0，scratch峰251528696B，errors/pageErrors=[]。
- `phase7-lit-after-unlit`：27当前modules、8帧、32个NaN poison batch，原数值/覆盖/cache/proof满及实际产量断言通过。`phase7-lit-lifecycle-after-unlit`：10项真实Product+PointLight+physical IBL生命周期通过，namespace/recovery最大像素差1，scratch峰251430304B，errors/pageErrors=[]。
- 当前GPU组件分别重跑于`phase7-phase3-geometry-current`（5例）、`phase7-phase3-record-current`（14kind/CXY/hot-cold）、`phase7-phase4-tree-current`（19例）、`phase7-phase5-demand-current`（37例）、`phase7-phase5-lighting-current`（20例+4真实provider），全部passed、apiErrors=[]。小链范围不推广为全部场景质量完成。
- 新鲜`npm run build:test`、`npm run build`（含typecheck，492modules），97 Surface/整合测试与89 Appearance/Temporal/variation/Product关联测试通过，无skip。全仓首次运行未完成且存在非本切片失败，不宣称全仓通过。

整合失败按原合同定位并迁移，原日志`phase7-integration-failures/original.log`保留：FrameProgram旧Surface mock缺frameVertices/publication，迁移唯一SurfaceWork并保留实例来源、依赖、Present、feature-off断言；FrameGeometryVertices mock补真实API的getCompilationInfo，现行64B settings+32B control+16B indirect+16/32B raster与packed heaps对应原资源/失败语义。LUT原预期7 textures遗漏已存在的diffuse irradiance；独立核对五Earth LUT+三sky generation textures，保留fence前不销毁，新增逐texture身份、无double destroy、新generation存活及共享DFG不退休断言。生产未为mock新增fallback，也未放宽数值容差。

## Chrome质量宿主诊断

`phase7-visual-chrome-headless`完成9张静止/旋转/后运动/meshlet/近景/resize往返/太阳编辑与恢复截图，错误计数0；只证明该连续诊断路径完成，不证明既定画质误差预算或全质量矩阵。headed的`phase7-visual-serial-repro`、`phase7-visual-chrome-default`、`phase7-visual-chrome-headed-click`均在首帧前Instance dropped，getCompilationInfo/popErrorScope报错，截图0；默认启动参数、禁HMR、UI click仍复现，根因未确定，不计通过。

此前`phase7-performance-serial`的720p low/high timing/detailed各20帧完整，仅诊断；不是1080p正式性能或历史收益。低覆盖Surface timing P50/P95=137.6256/139.91936ms，高覆盖341.508096/541.196288ms；高覆盖长尾尚需定位。GPU并行污染的`phase7-performance-smoke`结果不采纳。正式五revision共同能力、相同质量比较尚未完成，Phase7保持未完成。
