---
id: eengine-ao-functionality-execution-2026-10
state: current
verifies:
  files:
    - docs/next-design/eengine-ao-functionality-2026-10.md
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - OEngine/src/render/RendererConfig.ts
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/render/program
    - OEngine/src/render/ao
    - OEngine/src/shaders/xegtao_denoise.ts
    - OEngine/src/shaders/native_surface.ts
    - OEngine/src/debug/RenderDebugView.ts
    - OEngine/src/render/passes/RenderDebugViewPass.ts
    - OEngine/tests/contract/frame-program.test.mjs
    - OEngine/tests/contract/xegtao-scalar-product.test.mjs
    - OEngine/tests/oracle/native-surface-production-gpu.mjs
    - examples/demos/14-integrated/dungeon-warkarma-texture-compression/main.ts
    - tools/gpu-oracle/registry.mjs
---

# AO 功能完善执行计划

唯一模块设计：[AO功能完善](../next-design/eengine-ao-functionality-2026-10.md)。粗路线/其他模块由workstream.roadmap导航，本文件只维护AO单元状态与实际结果。本轮授权是复查与细设计；没有实施生产代码，也没有授权自动进入SSR。

## 1. 一个完整实现单元

| 单元 | 状态 | 完整交付 |
|---|---|---|
| AO-1 参数化、生产消费与诊断闭包 | 待实施 | 七项设置→配置/运行期快照→FrameProgram结构/绑定→完整XeGTAO→Native diffuse IBL/AO debug→示例调校；同时闭合缓存、颜色reset、abort/retry/recovery、旧开关退休与集中验证 |

设计已形成；AO-1尚未开始，不把文档完成算功能完成。以下是同一单元的工作清单，不设每项状态或逐项验证门禁，可连续实现后一起验收：

- 公共settings/type/default/原子解析、RendererConfig初值和Renderer运行期API；取帧快照，区分desired与成功提交签名，恢复checkpoint携带设置。
- 结构key只增加effective quality与denoise；数值通过SceneFrameBindings晚绑定。稳定三个owner提供有限PSO，Main同一Hilbert LUT支持Medium/High，denoise保完整0..3调度，ABI80→96一次更新全部reader/writer。
- 最后donor输出后做strength混合；Native仍只消费有效scalar，pack无consumer继续裁掉。只重置必要颜色累计，保identity/HZB/曝光/VSM；abort/defer保pending变化，resize/empty/all-unlit/device loss沿既有事务闭合。
- 独立AO debug接真实scalar和Present bypass；Dungeon调校入口；迁移全部真实xe_gtao_enabled调用方并删除旧字段，不保第二状态或兼容分支。完成后更新实际domain事实。

实现顺序可按文件依赖安排，阶段内允许临时不编译；不要拆成“先上API、以后接GPU/恢复/关闭”的多个发布阶段。若源码复查发现本设计关键假设不成立，修本对文档后继续，不另开plan。

## 2. 集中验证，范围保持小

开发按需要typecheck/局部调试；连通后集中执行下列检查。复用既有host与fixture，不创建第二套renderer/验收系统，不运行全仓测试、全部GPU oracle、全场景browser矩阵或正式长窗口性能资格。

| 检查 | 最小有意义覆盖 |
|---|---|
| 编译与CPU合同 | 一次engine build（已含typecheck），新鲜build:test；新增一组settings测试，并扩现有frame-program与xegtao-scalar-product合同，随后一起运行。公开API调用方使用已有受影响demo的targeted typecheck，不跑整个examples/Storybook构建 |
| settings/图的重点 | 默认与非法patch原子拒绝、质量/遍数结构key及off归一化、数值不换图/PSO且新帧实际晚绑定、0..3的max(1,D)与pack裁剪；避免只测试源码字符串/镜像实现 |
| 一个小型真实GPU场景 | 用已有真实Renderer/小几何+非零diffuse IBL，观察实际AO debug与HDR；验证默认、strength0/中间值/1、半径/世界尺度、Medium/High、denoise0与多遍，边界组合代表覆盖即可，不做所有参数笛卡尔积 |
| 同一GPU场景的生命周期 | off/on、一次奇数尺寸/resize、普通motion、一次短Native/upscale切换、一次abort→retry、一次受控device loss→设置恢复；用现有事务与实际输出/资源观察，不跑数百帧或全部故障矩阵 |
| 粗成本/资源 | graph实际pass、选中pipeline和资源descriptor与Cost Card相符，关闭不保AO全屏工作、切换不反复创建LUT/PSO，观察常用1080p一次资源/成本；无FPS或相对off净提速门禁 |

可以新增一个范围很小的 `ao-functionality` GPU entry，复用现有gpu-oracle宿主/Renderer生产fixture；它只负责上述模块变化，不调用完整native-surface-production大矩阵。必要时扩用原生产entry的可选AO子用例，但不能为此改弱该entry原默认断言。GPU作业串行，调试成功后不无故重复整组。

数值独立预期以强度公式、同物理场景单位变换、默认快照及source定义的final恢复为主；隔离数值观察时使用固定曝光/关闭颜色AA，两个重建域的reset另作短接线核对。denoise0不能断言等于跳过filter；8/18采样与0..3必要阶段按实际pipeline/执行核对。默认比较可在改动前保留同fixture基线，不能拼不同曝光/相机/质量。沿既有量化/数值容差，不新增全图逐bit或电影级画质阈值，也不放宽既有断言；新增R8混合的可接受误差须来自实际量化，不能吞掉偏移/漏像素。

若实际修改Main/weighted depth/denoise的数学或新加不在既有profile的分支，再补该处局部独立oracle；不能只凭PSO编译、图有pass或出图就宣布数学正确。mock只能证明局部合同，GPU缺项如实未完成。

建议复用现有命令：`npm --prefix OEngine run build`、`npm --prefix OEngine run build:test` 后显式运行受影响Node文件，模块GPU entry实际登记后再通过 `node tools/gpu-oracle.mjs <实际名称>`运行。不为尚未存在的测试文件/entry预填通过结果。文档变化另跑docs-verify，未改依赖不跑npm ci。

## 3. 来源与错误处理

本轮重新核读固定XeGTAO revision与本地Main/denoise/ABI/实际Native消费者，完整来源/保留步骤见设计§7。实现沿既有profile，不复制D3D框架、不删weighted mip/积分/对角/边缘/末遍恢复；艺术强度调节与上游算法明确分开，不宣称新完整port或性能采用。

按[VALIDATION](../VALIDATION.md#validation-failure-contract)保原失败并分类；只修本单元根因，必要相关回归随改动运行。缺adapter/timeout/未build/未运行保持缺项，旧性能资格与旧adoption不自动晋升。测试范围缩小用于聚焦本单元，不能通过删算法、漏consumer、永久中性输出、吞异常或放宽阈值结束。

## 4. 设计记录（2026-10-14）

起点`efd62c3f`、工作区干净。复查当前公开开关/配置、三pass构造与数值常量、scalar/packed两个消费者、FrameProgram缓存晚绑定、Native diffuse IBL合成、debug入口、颜色历史reset及device loss checkpoint。关键纠正是：已有开关需迁移；0遍仍保final恢复；默认noise0；数值不能捕获进缓存闭包，运行期设置不能在恢复时丢失。

本次只新增本模块设计/执行一对，并将粗执行表链接与workstream.authority/currentSlice切换到AO；不启动AO-1、不创建SSR文档或生产资源。文档系统测试7/7通过，vibe doctor无错误/警告且registry字节一致，AO源码/RendererConfig/两份细文档的context均只返回AO这一对authority，git diff --check通过。

全库docs-verify仍返回既有1个finding：Git忽略的docs/status.generated.md缺frontmatter；另有81条原历史断链warnings，本轮没有新增finding/warning，不宣称全库通过。引擎build、Node模块用例、GPU和benchmark未运行，原因是本轮只有文档/导航变化，不能将这次文档检查当功能证明。

AO-1关闭后在此记录实际改动、所运行检查/缺项、必要成本和限制；粗执行表只回链模块结论。停止在SSR细设计边界，后续由用户启动。
