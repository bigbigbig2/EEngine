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
    - OEngine/tests/contract/ambient-occlusion-settings.test.mjs
    - OEngine/tests/oracle/ao-functionality-gpu.mjs
    - OEngine/tests/oracle/native-surface-production-gpu.mjs
    - examples/demos/14-integrated/dungeon-warkarma-texture-compression/main.ts
    - tools/gpu-oracle/registry.mjs
---

# AO 功能完善执行计划

唯一模块设计：[AO功能完善](../next-design/eengine-ao-functionality-2026-10.md)。粗路线/其他模块由workstream.roadmap导航，本文件只维护AO单元状态与实际结果。设计于`8f84be4d`先提交，随后用户明确授权按本计划实施、验证并核对文档；不自动进入SSR。

## 1. 一个完整实现单元

| 单元 | 状态 | 完整交付 |
|---|---|---|
| AO-1 参数化、生产消费与诊断闭包 | 已完成（本单元范围） | 七项设置→配置/运行期快照→FrameProgram结构/绑定→完整XeGTAO→Native diffuse IBL/AO debug→示例调校；同时闭合缓存、颜色reset、abort/retry/recovery、旧开关退休与集中验证 |

以下是本单元的实施清单，实际完成结论与验证范围见§5；不设每项状态或逐项验证门禁：

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

## 5. AO-1 实施与核对（2026-10-14）

从设计提交`8f84be4d`连续实施同一单元。`AmbientOcclusionSettings`为唯一七项状态，公开配置初值与原子运行期API，非法patch保旧快照；半径/派生falloff同时拒绝非normal/溢出f32，避免GPU flush-zero后除零。旧公开字段及真实调用方全部迁移，没有兼容别名。Dungeon加入七项调校、独立AO视图和设置快照，strength0与关闭有明确中性说明。

三个owner设备期稳定：Main两档固定PSO/同一LUT，Denoise三个滤波PSO及既有pack；96B共享ABI保前80B，强度只在最终完整量化输出之后应用。Main积分、normal、weighted-depth、edges/对角/leak、1.5恢复、noise0及2/4 storage split未删步骤。FrameProgram只以有效quality/denoise区分结构；数值晚绑定。Native继续只为diffuse IBL消费有效scalar，AO debug读同一最终产品；关闭/unlit不造AO工作，empty仍clear-present。

颜色内容签名只在成功submit提交，数值/结构变化在下一个实际内容变化帧仅reset颜色后端；普通motion与等效半径、off中的无关参数编辑保留历史。abort/defer保旧签名，retry继续reset；checkpoint携带desired设置，device recovery在首次准备前恢复。没有AO history、新frame submit、通用效果框架或SSR资源。

### 验证与限制

最终集中检查通过：`npm --prefix OEngine run build`、新鲜`build:test`、三个合同文件19/19、Dungeon/Bistro/Zorah的targeted typecheck，以及`node tools/gpu-oracle.mjs ao-functionality --json`。真实GPU用例运行约6秒（宿主oracleMs，含CPU/初始化/等待，并非GPU计时）；source SHA `2e62fe2f4ad1a7d4316cb6214953a11854e7a9fa8cf09b0b741fcce649a86094`、output SHA `31f786e5af9ec54ef39eeab9184ad8dc60ae43f28f80a2666f37678e708a3e14`、oracle SHA `f797232796b1f9aad936df8436d30dd3b1285a7f9de6a774bbc2dac9414ddb3a`。真实错误聚合为零；结果是本单元范围通过：

| 观察 | 实际范围 / 结论 |
|---|---|
| 数值与真实消费 | 192×128三块几何接触场景、非零authored diffuse IBL；读真实scalar/debug/Surface HDR。strength0/0.5/1有效，中间值与独立R8公式最大误差0字节，HDR变亮且保持有限；不同半径/power在缓存命中图中真实生效 |
| 单位与默认 | 几何/相机/near/far整体16倍、metersPerWorldUnit=1/16，scalar最大差0字节；设置恢复默认后逐字节回到本轮默认快照。未保存改动前同fixture golden，不能把本次回放当跨版本画质矩阵；未改变Main/weighted-depth/滤波数学 |
| 质量/去噪 | Medium/High实际执行，0/1/2/3均保max(1,D)及唯一末遍；0遍对原working byte的1.5恢复符合独立预期（含原滤波允许的1字节边界），多遍强度混合仅发生在末遍；无consumer pack裁掉，owner/LUT/PSO不重建 |
| 历史/事务 | Native与FSR暖帧保color；AO编辑只resetcolor且Seed previous-valid保留、曝光epoch不变，下一成功帧不重复reset；普通motion、off/on、off中编辑、defer、注入abort→retry、193×129及0.73 renderScale域切换、device loss恢复非默认七项设置、unlit/empty通过 |
| 1080p必要成本 | 默认实际5次AO dispatch，未执行pack；由实际live descriptor求和25,645,440B（约24.46MiB），与设计Cost Card一致。没有新全屏纹理/history；D3比D1逻辑多2P，约28.41MiB。共享allocator/退休账同时采样，包含其他owner/尺寸，不能充当AO专属物理峰值或driver驻留 |

最终报告保存在Git忽略的`.local/ao-functionality-final.json`，原失败/中间报告保留`.local/ao-functionality-run*.json`；宿主记录Chrome155、NVIDIA Turing硬件adapter与fresh身份，未获取具体device型号，不能将历史GTX型号自动补到本次记录。1080p观察时共用账本current/peak为286,639,745/289,080,483B、retired为0，共享transient pool为83,076,332B；含整个fixture、其他owner、不同尺寸的可复用缓存，不是AO独占/driver显存或完整4GB资格。单个1080p冷帧CPU+queue等待146.7ms包含编译/整Renderer/debug/观察器接线，不是AO GPU计时；不由该值宣称提速或退化，也不与历史GPU帧时拼接。GPU测试中的HDR离线读回可单独submit复制，生产渲染仍只有原frame submit，没有GPU→CPU→GPU工作控制。

保留失败分类：首轮真实GPU在编码前发现AO debug新增依赖漏登记INPUT_CONTRACTS，补回归先复现再修合同；后一次用例在submit后读取已结束的Seed帧，被owner正确拒绝，观察点已移到prepare。新增CPU用例初次缺GPUBufferUsage测试全局，已修fixture；没有跳断言/放宽容差。Dungeon原typecheck因本机缺少锁定的Node/undici类型包失败，按examples/yarn.lock的版本与SHA512补回本地node_modules后通过；没有改依赖清单或锁文件。

本单元不运行全部GPU oracle、上游D3D工程、完整Main/normal/weighted-depth对上游逐阶段GPU数值差分、长窗口/全资产Dungeon与Bistro画质矩阵、ABBA/FPS/P95或driver 4GB同时峰值。2-storage分支和原完整生产大矩阵未本轮重跑；既有算法/容量检查保留，新增路径已由小型production fixture验证。旧C阶段来源adoption与V5/VSM正式资格不晋升。

架构与文档逐项核对：API→快照→key/late binding→96B reader/writer→最后滤波→Native/debug→submit/abort/recovery→全部旧调用方；domain页更新已实现事实，粗路线只维护模块入口/边界，来源账本区分Local strength与既有Reference/Adapt。完成后停在SSR细设计前。

文档系统测试7/7、`vibe doctor`无错误/警告且registry字节一致；新AO源码context只返回当前AO设计/执行一对，`git diff --check`通过。全库`docs-verify`仍是原有1个finding：Git忽略的`docs/status.generated.md`缺frontmatter，另81条historical warnings，本单元未新增；该外部既有文档问题保留，不宣称全库文档检查绿色。引擎build仅保留既有codec的node:module externalization提示。
