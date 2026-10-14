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
    - OEngine/tests/contract
    - OEngine/tests/oracle
    - tools/gpu-oracle/registry.mjs
---

# SSSR 执行计划

唯一细设计为[SSSR设计](../next-design/eengine-sssr-2026-10.md)，粗路线由workstream.roadmap导航。本轮只形成设计/执行文档，**未授权开始生产实现，两个单元均待实施**。详细状态与实际结果只在这里维护；不预建Local Probes/SSGI细计划。

## 1. 两个完整单元

| 单元 | 状态 | 关闭边界 |
|---|---|---|
| SSR-1 完整算法与资源闭包 | 待实施 | 所选SDK完整FP32 SSSR+三阶段denoiser在非生产fixture中连通；两lobe、容量/写域、radiometry、历史和提交事务完整，尚不切换生产 |
| SSR-2 Native生产原子接入与收口 | 待实施 | 全物理route/产品/consumer同时切换；settings/debug/demo/recovery与退役闭合，真实Renderer验证并逐项核对文档；停在下一模块边界 |

两个单元对应算法闭包与生产ownership切换，不按shader文件、API、每条测试拆小阶段。实施时可临时不编译；单元闭合后集中检查。SSR-1关闭停在SSR-2边界；继续授权已覆盖的单元不重复索要确认。实施发现关键假设不成立时直接修本对文档及Cost Card，不另造一套plan或旧新A/B桥。

### SSR-1：完整算法与资源闭包

- 从来源R06的固定commit重核函数/host排序/callback和MIT、Playdead notice；按源1spp表导入实际消费的noise数据并记录hash，不拉D3D/Vulkan框架或其他版本拼接。settings与GPU ABI共享，参数解析、两个immutable内存预算和完整capacity plan可独立验证。
- 建立单一SSR owner，完成R32F reverse-Z depth、portable64lane classify/prefix/quad复制、GPU列表/2D indirect、完整VNDF/hierarchical trace/ValidateHit/mip0颜色与环境补缺；hit flag、confidence与world ray length各按真实语义，不互相冒充。
- 完整Reproject→Prefilter→Resolve：9×9统计、virtual-hit/surface候选、3×3/2×2修复、15-neighbor滤波、tile average、samplecount/variance、双重clip和dark分支均保留。FP32算术/F32 shared、Rec2020 half物理存储与Rec709算法域转换、独立R32F ray length、统一half α、NPOT/步数退出、预曝光brightness阈值等适配分别留短source map。
- base/coat顺序共用scratch/queues，独立radiance/stat/average history；完整初始化/alias-after-read clear、几何snapshot、candidate/commit/abort/retry/fence退休一并完成。不创建未消费的production产品、不先交一个“只有trace”的SSR。

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

本轮仅创建这对细文档、更新来源短映射与导航；不写production实现，不创建尚无consumer的SSR资源。将来实施结果在此按SSR-1/SSR-2记录实际源码、证据、失败及限制，不新增progress/status文件。

文档检查：`node --test tools/tests/document-system.test.mjs` 7/7通过；`vibe doctor`无errors/warnings且registry字节一致；两份SSSR文档、Native Surface和NativeMaterialScene的context均只返回新的SSSR authority一对，当前模块唯一；`git diff --check`通过。全库及changed `docs-verify`仍为原有1个finding（Git忽略的`docs/status.generated.md`缺frontmatter）与81条historical warnings，没有本轮新增finding。未运行engine build、GPU或benchmark，因为本轮只有文档/导航变化；不将文档结构检查当算法正确性、生产完成或性能证明。
