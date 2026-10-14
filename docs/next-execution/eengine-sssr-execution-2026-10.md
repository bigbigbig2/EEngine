---
id: eengine-sssr-execution-2026-10
state: current
verifies:
  files:
    - docs/next-design/eengine-sssr-2026-10.md
    - docs/porting/next-renderer.md
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - OEngine/src/render/program
    - OEngine/src/render/surface/SurfaceV4.ts
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/gpu/GpuNativeMaterialScene.ts
    - OEngine/src/shaders/native_surface.ts
    - OEngine/src/render/reflections
    - OEngine/src/render/assets/sssr
    - OEngine/src/shaders/sssr_classify.ts
    - OEngine/src/shaders/sssr_intersect.ts
    - OEngine/src/shaders/sssr_reproject.ts
    - OEngine/src/shaders/sssr_prefilter.ts
    - OEngine/src/shaders/sssr_resolve_temporal.ts
    - OEngine/tests/contract/sssr.test.mjs
    - OEngine/tests/oracle/sssr-algorithm-gpu.mjs
    - OEngine/tests/oracle/sssr-reference.mjs
    - tools/test-build.mjs
    - OEngine/tests/contract
    - OEngine/tests/oracle
    - tools/gpu-oracle/registry.mjs
---

# SSSR 执行计划

唯一细设计为[SSSR设计](../next-design/eengine-sssr-2026-10.md)，粗路线由workstream.roadmap导航。设计提交为`93fe6822`；用户随后授权完成SSR-1并对照文档返工，SSR-2仍在下一单元边界。详细状态与实际结果只在这里维护；不预建Local Probes/SSGI细计划。

## 1. 两个完整单元

| 单元 | 状态 | 关闭边界 |
|---|---|---|
| SSR-1 完整算法与资源闭包 | 已完成（非生产闭包） | 所选SDK完整FP32 SSSR+三阶段denoiser在非生产fixture中连通；两lobe、容量/写域、radiometry、历史和提交事务完整，尚不切换生产 |
| SSR-2 Native生产原子接入与收口 | 待实施 | 全物理route/产品/consumer同时切换；settings/debug/demo/recovery与退役闭合，真实Renderer验证并逐项核对文档；停在下一模块边界 |

两个单元对应算法闭包与生产ownership切换，不按shader文件、API、每条测试拆小阶段。实施时可临时不编译；单元闭合后集中检查。SSR-1关闭停在SSR-2边界；继续授权已覆盖的单元不重复索要确认。实施发现关键假设不成立时直接修本对文档及Cost Card，不另造一套plan或旧新A/B桥。

### SSR-1：完整算法与资源闭包

- 从来源R06的固定commit重核函数/host排序/callback和MIT、Playdead notice；按源1spp表导入实际消费的noise数据并记录hash，不拉D3D/Vulkan框架或其他版本拼接。settings与GPU ABI共享，参数解析、两个immutable内存预算和完整capacity plan可独立验证。
- 建立单一SSR owner，完成R32F reverse-Z depth、portable64lane classify/prefix/quad复制、GPU列表/2D indirect、完整VNDF/hierarchical trace/ValidateHit/mip0颜色与环境补缺；hit flag、confidence与world ray length各按真实语义，不互相冒充。
- 完整Reproject→Prefilter→Resolve：9×9统计、virtual-hit/surface候选、3×3/2×2修复、15-neighbor滤波、tile average、samplecount/variance、双重clip和dark分支均保留。FP32算术/F32 shared、Rec2020 half物理存储与Rec709算法域转换、独立R32F ray length、统一half α、NPOT/步数退出、预曝光brightness阈值等适配分别留短source map。
- base/coat顺序共用scratch/queues，独立radiance/stat/average history；完整初始化/alias-after-read current raw copy、几何snapshot、candidate/commit/abort/retry/fence退休一并完成。不创建未消费的production产品、不先交一个“只有trace”的SSR。

关闭证据为下面的小算法验证、相关typecheck/build与一次architecture self-review：逐阶段核对输入/输出/分支、全部valid/OOB写域、frame-to-frame角色和绑定是否合法。没有真实adapter或必要数值缺项时保持未完成，不能凭编译宣称完整port。

### SSR-2：生产完整切换

- 沿实际NativeMaterialScene descriptor规划/PSO candidate/lease提交，加入有限off/sssr-base-coat物理输出profile；Surface全部dense/compact、ordinary/Product、混合unlit及background/early-return完整32B record写入。使用现有env/DFG/coat计算值输出W/B，不重新评估材质；最宽16 buffer/4 storage texture与device实际limits在分配前核验。
- FrameProgram/Lowering接最终Depth、当前opaque H、SSR独立owner与GPU曝光/Seed，发布corrected opaque后原有Sky/Aerial/Native或FSR/显示全链；禁止循环颜色依赖、额外frame submit和当前帧CPU工作控制。结构key只有效启停，其他设置晚绑定，物理profile未齐全帧defer。
- 公开七项settings、初值/只读快照/原子setter，checkpoint与device recovery保desired配置；颜色/反射reset范围、off/empty/all-unlit释放、resize与预算退避/退休连通。正strength间编辑保反射history，不重置geometry/HZB/VSM/曝光。
- 四个debug模式按新阶段真实重接，选中lobe的按需diagnostics列入额外内存；Dungeon补启停、质量、阈值、尺度、厚度、stability/strength与base/coat诊断。删除旧SSR专用shader/输入和假null接线，共享helper移到中立owner后迁移所有现存consumer，不启动其他效果。
- 集中验证后逐项对设计：producer→record→trace→history→response/baseline→最终HDR→重建/显示；记录真实descriptor/粗成本、失败修复、未运行项和限制，更新已实现domain事实与粗模块结论。

## 2. 轻量、真实的集中验证

开发中按需要跑局部typecheck或单个GPU复现，不每patch全套。复用现有gpu-oracle宿主和真实Renderer fixture，新增至多两个范围明确的GPU entry，GPU作业串行；新增CPU文件按语义归组，扩已有FrameProgram/Native合同，不写仅靠源码字符串或镜像实现的“通过证据”。

| 集中点 | 最小必要覆盖 |
|---|---|
| SSR-1 CPU/ABI | settings默认/非法patch原子性和派生f32；32B pack/unpack、同一canonical α；quad复制/prefix/尾tile容量与超过单轴的2D args；真实descriptor求和与allocation前拒绝。只用代表边界，不做参数笛卡尔积 |
| SSR-1 小GPU算法fixture | 极小平面/薄物体/屏幕边缘与一个奇数尺寸；独立full-res brute trace核对少量确定射线的命中、退屏、自交/背面、步数耗尽、末行列。VNDF核对固定输入与方向/分布必要量，noise核固定源数据；不能仅测一张反射截图 |
| 同一算法fixture的denoiser/能量 | 几个小tile核对所选源FP32三阶段的关键数值（CPU独立oracle或固定源reference数据），覆盖9×9 halo、15 offsets、disocclusion修复、clip/samplecount和dark；按声明的Rec2020存储/F32 shared精度核对，不要求源half shared逐bit。加一个工作域可表示但709 half越界的饱和HDR输入及一条>65504 world-unit ray length；独立base/coat响应与baseline替换公式；P=1/0.25反曝光等价与历史曝光跳变，检查ray length不当confidence/不随曝光缩放 |
| SSR-2 编译/合同 | 一次`npm --prefix OEngine run build`、新鲜`build:test`及受影响CPU文件，实际改到的demo targeted typecheck；数值cache-hit晚绑定、异步profile未ready的defer、所有route选同profile。未改依赖不跑npm ci，不跑整个examples/Storybook |
| SSR-2 一个真实Renderer fixture | 当前真实材质/几何/IBL生产者，少量base金属/介质/独立coat normal+roughness、unlit反射目标、MASK与ordinary/Product代表组合；检查最终HDR/四类debug、非选lobe保持、不是额外叠IBL。authored environment作可控数值预期，physical environment作短接线核对，无需全资产画质矩阵 |
| 同一production fixture的短生命周期 | 静止暖帧+普通运动/揭露+移动亮物体/屏幕边缘，off/on/strength0、positive strength编辑、数值编辑、一次resize/奇数域、Native/FSR/颜色AA关闭切换、一次abort→retry与受控device loss；empty/all-unlit真实不执行SSR。用少量短序列代表覆盖，不做数百帧或全部组合 |
| SSR-2 1080p资源/成本观察 | 实际ray/tile/dispatch、最宽binding、资源descriptor及退休峰值，确认无截断/漏像素，off无全屏SSR链；记录测试adapter/配置及粗粒度耗时性质，不设FPS/ABBA/P95或对off净提速门槛 |

两个GPU entry在实现登记后才填实际名称/命令/结果。SSR-1算法fixture不伪装成生产接线证明；SSR-2不调用整套native-surface大矩阵再重复做一遍。本模块确实新增完整复杂算法，必要数学/生命周期检查不能像普通glue那样省略，但可限制为少量独立可解释输入。当前存活的material numeric/导数/coverage/normal/HDR/Seed语义保留；只有实际修改了这些数学才补受影响专项，不无故重跑全部oracle。

容差按源FP32/half存储、颜色矩阵及depth/像素精度推导，禁止全图逐bit门槛，也禁止为了通过任意放宽误差。必要失败先保报告、按[VALIDATION](../VALIDATION.md#validation-failure-contract)分类，局部修根因并重跑受影响检查。保留源的finite guard不等于允许以零图吞掉数值失败。缺GPU/未运行/画面异常如实未完成；不以缺少正式整Renderer性能资格阻塞功能，也不将其追认为已通过。

## 3. 设计检查记录与实施结果位置

2026-10-15，设计起点`1d1a67fc`。读取当前Surface所有物理组/材质绑定、完整IBL/coat与色域转换、异步Native发布、FrameProgram颜色版本、reverse-Z HZB、Seed/曝光与debug实际消费；固定SDK源码研究包括classify/intersect/depth/noise/args、三阶段denoiser的FP32与共享packing、HLSL/GLSL callback、SSSR/denoiser host资源与sample最终合成，另核对Heitz VNDF论文。未构建上游D3D样例。

主要裁决：不需要opaque color pyramid；不复用半尺寸RG16F几何HZB；反射sidecar以第16个SSBO保持四张Surface写纹理；base/coat各自追踪与历史；环境补缺已在trace混合，最终只做同色域/响应的baseline替换。噪声与完整denoiser保留，数值适配明确为Rec2020 half物理辐射、Rec709 FP32算法/F32 shared、R32F ray length，避免额外收窄现有HDR/场景单位范围；variance-guided按全rate算最坏情况。两单元依赖与关闭边界明确，Local Probes不混入。

设计提交轮仅创建这对细文档、更新来源短映射与导航；没有production实现，也没有创建尚无consumer的SSR资源。后续实施结果在此按SSR-1/SSR-2记录实际源码、证据、失败及限制，不新增progress/status文件。

文档检查：`node --test tools/tests/document-system.test.mjs` 7/7通过；`vibe doctor`无errors/warnings且registry字节一致；两份SSSR文档、Native Surface和NativeMaterialScene的context均只返回新的SSSR authority一对，当前模块唯一；`git diff --check`通过。全库及changed `docs-verify`仍为原有1个finding（Git忽略的`docs/status.generated.md`缺frontmatter）与81条historical warnings，没有本轮新增finding。未运行engine build、GPU或benchmark，因为本轮只有文档/导航变化；不将文档结构检查当算法正确性、生产完成或性能证明。

## 4. SSR-1 实施与逐项复核（2026-10-15）

用户本轮授权SSR-1。实现为`render/reflections/{ScreenSpaceReflectionsSettings,SssrAbi,SssrNoiseData,SssrRuntime}`、九个`shaders/sssr_*`及固定noise资产；没有Renderer/FrameProgram生产调用，不修改既有Surface材质数学或复活旧SSR owner。以下复核的是完整非生产闭包，SSR-2保持待实施。

| 设计合同 | 实际实现与关闭证据 |
|---|---|
| 固定完整来源，不简化成trace+blur | SDK固定`c6efa6bf7f2027b3ec94f28578bb5965eabb9e55`，SSSR1.5/Denoiser1.3 FP32；源码SHA清单、786432B Sobol/scrambling、AMD/Playdead完整notice入库。VNDF、hierarchy、ValidateHit和全部三阶段分支逐函数核对；depth逐mip、portable prefix等差异见来源映射 |
| 全像素分类、两类列表、正确间接派发 | 8×8/64lane remap与shared prefix，1/4spp、mirror与variance提升、三个copy位；指定base无效时独立发ray，所有eligible像素恰有一个writer。GPU生成二维trace/tile args；六个计数边界包括0及超过单轴。33×17薄目标与NPOT末行列按独立full-res brute期望核对 |
| 完整追踪与真实长度 | 24个固定VNDF输入；8条独立射线含6个预期hit，另验退屏/自交/背面/边缘和1步预算miss。固定noise十个texel核相位；R32 world ray length=70000不溢出，不冒充confidence、不随P变化 |
| 完整三阶段denoiser与历史候选 | 两lobe独立CPU数值核对8×8亮度平均、中心+15 Halton、方差及9×9统计/双clip/样本混合；GPU覆盖3×3 surface search、逐tap2×2修复、完整identity失配、virtual-hit及其曝光。另用真实透视/相机平移、不同前后帧projection核对virtual parallax（约0.01863 UV）与成对矩阵，最大坐标误差2.87e-8 |
| 色域、HDR与两lobe替换 | 实际Rec2020 half存储、709 F32计算/F32 shared，原GPU P/Pprevious；独立CPU核对`H+strength*(M(Wbase*Qbase+Wcoat*Qcoat)-B)`。工作域可表示而709 half越界的实际hit达到709约103995.5，完整链有限；P=1/0.25、新旧P不同及正strength编辑覆盖，mirror/dark全P需求且samplecount保留 |
| 资源/绑定与提交闭包 | 11个稳定PSO、显式BGL、有限binding cache，同一借用encoder严格base→coat并共享scratch/queues；完整初始化与raw-copy-after-history-read，最后snapshot。prepare→encode→成功submit commit才发布phase/history/matrices；active/candidate/abort/retry/invalidate/release、预算退休退避验证。attached abort用命令事件接口seam核对传播，不宣称Renderer真实接入；LUT和未提交uniform写入也按fence退休 |
| 容量与真实成本界 | 创建前协商完整device profile，P/T全容量、不降尺寸或截尾；真实GPU descriptor求和与预算账区分。17×19首帧owner实际855226B（包含819204B全局noise/占位），1080p规划含借用record为290910096B，低于298869376B保守上界。1080p数值是实际device limits下的规划，不是分配/driver驻留/目标4GB资格；22 compute+两次8P radiance copy上界见设计Cost Card |

对照文档返工修正：Seed实际为`current_uv-previous_uv`；non-glossy环境仍是denoiser halo输入；旧radiance槽必须在history读取后copy当前raw，不能clear成黑色；组合RG16不能丢dark samplecount；部分无效history候选仍应进入repair；halo复用前须统一barrier；间接ceil/padded索引避免u32溢出；metersPerWorldUnit同时作用于prefilter depth sigma与history key。最后一轮又发现共享reprojection statistics在本lobe未派发tile留下另一lobe方差，修为仅eligible邻居读取其真实writer，其他邻居源语义variance0；新增不对称base/coat tile fixture先复现失败再通过，没有删除non-glossy颜色/几何halo。上述修正均已同步设计及来源映射，没有删阶段或新增生产fallback。

最终集中命令：`npm --prefix OEngine run build`通过（含typecheck/Vite/声明，仅既有codec的node:module externalization warning）；最后生命周期/halo修正后重新运行新鲜`npm --prefix OEngine run build:test`、`node --test OEngine/tests/contract/sssr.test.mjs`（4/4）及`node tools/gpu-oracle.mjs sssr-algorithm --json`通过。只有一个新GPU entry，26项范围有限的结果；最终adapter为NVIDIA Turing硬件、Chrome155，不能推断具体显卡型号。GPU scoped/uncaptured errors为0。oracle约710.8ms包含初始化、CPU与readback等待，整次宿主约2.4s，**不是GPU帧时或性能提升证明**。

新鲜GPU报告留在忽略目录`.local/sssr-algorithm-final3.json`：source SHA256 `dbfb397ceae5de4e5b0f97ca9a5bbcdcc8aa39c4bbe61f64de9ff1342d1e1177`，test output SHA256 `c932d92e1abcdff96519764647c1a51447e39251fe058e50182c78c9b2ac5aa7`，oracle SHA256 `257902b52e5e2a550ce314fc98d7349fb114c2a805922177716ea279ff62c08d`。误差按4 half ULP加F32运算界，denoiser最终误差/容许界最大约0.318；近常量方差用独立F64统计与基于二阶矩的gamma96绝对F32取消误差界核对，再核对clip/resolve，不能对接近零的方差用无意义相对误差。

原开发失败保存在`.local/sssr-algorithm-run*.json`，不删除失败后只留成功：noise请求403属宿主asset allowlist路径错误；WGSL显式整数转换与reserved identifier属编译缺陷；初版独立oracle把F32取消误差用half相对界衡量属oracle缺陷。分别局部修路径/语法/数学比较，未跳必需断言、放宽最终格式界或增加测试专用production分支。

额外保留`.local/sssr-algorithm-shared-halo-before.json`：不对称tile的coat prefilter variance实际0.1256103515625、独立期望0.11281231117025184，明显超过原格式容许界，分类为真实shader写域缺陷；最后报告用相同输入/原容差重跑通过。

architecture self-review已逐核producer/consumer、四storage纹理与最多10KiB shared、有效/OOB/barrier、alias角色、二维间接容量、队列写入和device-loss guard；使用webgpu-review检查真实布局及同步，没有发现剩余SSR-1必需项。受控device loss/recovery、全Native route发布、settings/debug/Dungeon、普通运动/移动亮物体画面、1080p真实资源峰值/粗GPU成本均属于SSR-2；本轮没有运行或宣称完成。没有构建上游D3D样例，没有整Renderer FPS/ABBA/4GB验收，没有提升R06生产adoption。现在停止在SSR-2边界。

实施文档检查：`document-system.test.mjs` 7/7、`vibe doctor`无errors/warnings且registry未改，新增runtime/shader context均归shading并指向唯一SSSR authority；`git diff --check`通过。`docs-verify`仍为原有1个finding（忽略的`docs/status.generated.md`缺frontmatter）及81条historical warnings，没有新增finding。
