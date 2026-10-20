---
id: eengine-feature-expansion-execution-2026-10
state: current
verifies:
  files:
    - docs/next-design/eengine-feature-expansion-roadmap-2026-10.md
    - project/workstreams/active/eengine-next-clean-rebuild.yaml
    - AGENTS.md
    - README.md
    - docs/README.md
    - docs/VALIDATION.md
    - docs/domains/shading.md
    - docs/domains/materials-textures.md
    - docs/domains/frame-runtime.md
    - OEngine/src/render/pipeline/RendererCore.ts
    - OEngine/src/render/program/FrameProgram.ts
    - OEngine/src/render/program/FrameProgramLowering.ts
    - OEngine/src/render/ao
    - OEngine/src/assets/ImageTextureSource.ts
    - OEngine/src/gpu/TextureResidency.ts
    - OEngine/src/gpu/NativeMaterialBindings.ts
    - OEngine/src/gpu/GPUSceneEnvironmentContext.ts
    - OEngine/src/render/DynamicResolutionScaling.ts
    - tools/project-navigation.mjs
    - tools/docs-verify.mjs
---

# EEngine 功能扩展粗执行总计划

唯一总体粗设计为[功能扩展路线](../next-design/eengine-feature-expansion-roadmap-2026-10.md)。本文件只维护模块级状态、已有细设计/执行入口与延期责任；细单元状态及实际结果只在对应模块执行文维护，入口页/workstream不复制。当前模块设计/执行从workstream.authority读取，粗记录完成不自动代表各效果已实施。

## 1. 推进单元与边界

| 粗模块 | 模块级状态 / 已有细文档入口 | 能力目标与细设计入口 |
|---|---|---|
| F0 粗计划与文档推进机制 | 已完成本轮融合；检查与既有 finding 见 §5 | 核对真实源码并评审讨论方案，维护粗→细设计/执行一对→实施→收口的唯一导航；不改生产源码 |
| F1 AO 功能完善 | 已实施并完成模块集中验证：[设计](../next-design/eengine-ao-functionality-2026-10.md) / [执行及限制](eengine-ao-functionality-execution-2026-10.md#5-ao-1-实施与核对2026-10-14) | 已有scalar XeGTAO的settings/quality/debug/场景尺度与恢复；保留完整算法，不捆绑temporal/bent normal；停在SSR细设计边界 |
| F2 SSR | 已实施并完成模块集中验证：[设计](../next-design/eengine-sssr-2026-10.md) / [执行及限制](eengine-sssr-execution-2026-10.md#5-ssr-2-生产接入与逐项复核2026-10-15) | 完整SSSR与反射去噪、Native base/coat响应及环境替换已接生产；实际资源/质量覆盖与未做的整Renderer性能资格只读细文档；当时停在Local Probes边界（后续方向以当前粗路线为准） |
| 启动可用性专项 | 已实施并复核：[设计](../next-design/eengine-initialization-scheduling-2026-10.md) / [执行结果与限制](eengine-initialization-scheduling-execution-2026-10.md) | 几何帧事务/VSM更新、有界Worker批准备、并行首屏/纹理分块/真实view-settled已接入；启动精化低帧率与4GB/整帧性能资格仍有限，详见唯一执行记录。不恢复F11、不降最终质量；2026-10-16用户随后选择先设计F4 |
| F4 Streaming VT | 已实施并完成追加复审：[设计](../next-design/eengine-streaming-vt-2026-10.md) / [执行与限制](eengine-streaming-vt-execution-2026-10.md) | shading tile、完整过滤、反馈/背压与VSM完整页调度已接生产；几何固定槽和首帧剩余等待进入下列独立专项；不追认4GB或整Renderer性能资格 |
| 几何驻留与首帧专项 | 模块闭合及限制：[设计](../next-design/eengine-geometry-residency-startup-2026-10.md) / [执行§8](eengine-geometry-residency-startup-execution-2026-10.md#8-grs-3-集中复核与返工2026-10-16) | 2026-10-16完成紧凑物理区间、metadata/容量增长、准确async PSO准备与完整场景集中验证；修复Native反射输出重复准备，保留完整质量。长任务、GPU波动及4GB/正式整Renderer资格限制见唯一执行记录；当时停在F3边界；2026-10-17用户选择SCGI |
| SCGI Surface Cache GI | 详细设计已建立，代码待实施：[设计](../next-design/eengine-surface-cache-gi-2026-10.md) / [执行](eengine-surface-cache-gi-execution-2026-10.md) | 当前唯一模块；合并原F5/F7漫反射方向，完整world query/cache/近场增强；无4GB大场景保证 |
| F3 Local Specular Cache | 后置待细设计；尚无细文档 | 屏幕外镜面radiance、预滤波/选择/更新与SSSR/global IBL合成，具体表示不预先锁死传统probe |
| F6 Local Shadows | 待细设计；尚无细文档 | 点/聚光的实际 caster、容量/过滤/更新、Native 消费与 lifecycle；先补直接光遮挡，不把 LocalLightWork 或方向光 VSM 当作已实现 |
| F8 Transparency / Refraction | 待细设计；尚无细文档 | 先明确完整 BLEND，再按场景扩展透射/折射/水面；独立工作与正确合成，不恢复 retired owner |
| F9 Media | 待细设计；尚无细文档 | 与现有 Sky/Aerial 协调的局部参与介质/体积灯光，覆盖密度、阴影、积分/透射率与history |
| F10 重建、显示与后处理完善 | 待选择具体模块；尚无细文档 | 在现有 Native/FSR/曝光/LUT 显示上按需补 DRS、Motion Blur、公开调色等；每次只选一个连贯模块，各前序效果的时序正确性不后移 |
| F11 完整组合、性能与最终验收 | 延期到功能组合稳定 | 统一功能/质量profile，集中整帧归因与优化、长窗口/尾延迟、冷启动与同时峰值、实际设备工作集/OS驻留和最终画质，不承诺4GB大场景 |

顺序以当前粗路线为准。原F5/F7已合并到SCGI，不再单独施工；主表面局部阴影与SCGI hit visibility是不同consumer。Decals、RVT、ReSTIR、高级 world specular、AI 等作为粗设计中的候选能力，未选当前模块，不预建详案或占位实现。以后按场景选择它们时增加实际模块入口，不藏在 F10 中一次全部实施。

模块状态只记录待细设计、细设计中、待实施、实施中或模块闭合及其限制；文档链接只在文件实际创建后填写。每个大模块结束停在边界，用当时源码决定下一模块。旧 F0 记录按当时模块编号理解，不据重排追改原结果。

用户启动一个模块的细设计时，从粗设计对应段落重新读代码与成熟来源，形成唯一模块设计/执行一对；更新本表的模块入口和 workstream.authority/currentSlice，workstream.roadmap 保留本粗记录。模块实施和细单元状态只由那一对负责；设计授权不自动变成实现授权，已有执行授权不重复询问。完成后本表只记模块结论与链接，不复制细执行结果。

## 2. 单模块完成口径

1. 设置/资产输入→producer→产品→全部直接 consumers→最终画面真实接通；开关、debug、能力与不支持范围清楚。
2. 改变数学/格式前有独立预期和成熟来源核对；既有语义测试保留，旧表示测试可按真实退休迁移。源码存在/编译通过不能代替运行。
3. settings、quality、资源和history身份进入真实 publication/图缓存生命周期；覆盖 resize、cut、普通motion、abort/retry、replacement、device loss与最后consumer fence退休。
4. 模块连通后集中 typecheck/build、新鲜build:test、必要Node/串行真实GPU、场景画质与开关/组合检查；资源容量/溢出及粗粒度成本须可说明。未完成的必需检查如实保留，不能靠漏像素/永久缺页或放宽断言结束。
5. 正式全Renderer同条件性能资格留最终整合模块；开发新效果不以V5净收益/60FPS先通过为门。错误、失控内存或实际无法运行不在此延期之列。

## 3. 已有工作与延期资格

| 原模块 / 记录 | 保留事实 | 本轮处理 |
|---|---|---|
| [V4 M1/M2](eengine-v4-native-shading-execution-2026-10.md)、[M3 Lighting](eengine-v4-lighting-execution-2026-10.md) | 已切换的Native/Geometry/Lighting及各自实际验证范围 | 保留生产底座，不重新执行旧迁移；实际缺口由新模块真实消费者决定 |
| [Texture Compression](eengine-v4-texture-compression-execution-2026-10.md) | 已闭合的BC/exact-alpha生产链及限定workload验收 | 作为VT输入；raw cook/包IO、driver/crossGPU等开放项不改成通过；既有excluded资产约束保留 |
| [V5 Final Pixel](eengine-v5-final-pixel-performance-execution-2026-10.md) | Phase1–5及追加局部单元的实际实现和证据 | Phase6正式qualification、条件Phase7延期；不作为启动新效果的统一前置，最终整合重核完整图 |
| [VSM V4](eengine-v4-vsm-execution-2026-10.md) | R1–R3已实现链及后来采样/正确性修复 | R4完整场景/动态压力/画质/成本资格仍未完成；与新效果相交的正确性不得延期 |
| [Minimal GPU Work](eengine-v4-minimal-gpu-work-execution-2026-10.md) | 已落地A–F工作与原始负成本/P95结果 | 保持暂停，不从A重做；相关性能问题留集中归因 |
| 历史B2数值失败 | 没有被本轮修复或追认 | 继续沿workstream deferredValidation与原记录追溯；存活语义由当前真实owner承担 |

这些行是延期责任路由，不复制旧模块逐单元状态。新的效果组合改变需求后，最终整合重新冻结真实quality/feature/profile及reference，不将旧V5的采样默认、历史热机数字或不同renderScale数据冒充最终基线。

## 4. F0 源码审查与文档实施记录（2026-10-14）

起点为 `2caf5fe2`、初始工作区干净。先核对公开入口/RendererConfig、RendererCore的owner创建与提交/中止、FrameProgram的真实stage/product和lowering，再追踪：

- AO preparation/Main/denoise→Native diffuse IBL消费；settings常量、medium/high与denoise能力、私有深度法线、固定noise、缺专属history与debug入口。
- TextureProduct/PcMaterialTextures→TextureResidency整尺寸segment/渐进上传/回收→Native banks/显式梯度/exact-alpha；几何延迟反馈只作为机制对照。
- Native material mutation/publication、Surface/VSM独立shadow工作、Physical/authored IBL、曝光/Bloom、Seed/Native/FSR历史与成功提交/退休。
- SSR旧packed输入和当前null debug/缺stage；probe/Brick4/volumetrics惰性数据与缺实际消费；transparent/transmission/OIT参考的能力边界；DRS/RenderFeatureRegistry类与生产调用的区别。

据此更新总体路线、workstream、根协作规则/入口、V5延期说明、验证层级及相关domain事实。V4 母稿抽出原 M1/M2 历史推演，只保留跨模块不变量；19 份旧设计/执行改为 history 并声明替代关系，两个暂停 workstream 去掉并行任务/状态表。Texture Compression 保留现行产品边界和原结果，明确不是待执行第二路线。通用失败合同移至 VALIDATION，当前入口不再依赖旧迁移计划发号施令。

当前模块只做文档；没有改变TS/WGSL、资产、依赖、测试阈值，也没有进行新算法donor研究或新的GPU/性能实验。2026-10-14先前提交的175项Node及GPU结果保留原身份，不能当作本轮未来效果验证。

集中检查结果：document-system 7/7 通过；vibe doctor 无 errors/warnings、registry 字节一致；AO、TextureResidency、RendererCore 和新路线的 context 均只返回一对当前 authority；git diff --check 通过。next-design/next-execution 的 current 文件收口为总体路线/执行一对、V4 不变量母稿、Texture 产品边界/执行记录一对；V4 母稿由基线 409 行缩至 122 行，原推演完整保留在 archive。

全库 docs-verify 仍报告 **1 个既有 finding**：Git 忽略的 `docs/status.generated.md` 缺 frontmatter；另有 81 条原有历史断链 warnings。本轮修改/新增文档无新增 finding，也未增加历史 warnings。该遗留本地生成文件问题未修复，不能宣称全库检查通过；不修改 checker 或删除原件掩盖它。未运行引擎 build、browser、GPU 或 benchmark，因为本轮没有生产源码/资产变化，文档检查不证明未来效果正确性或性能。

F0 在文档交付边界结束；F1 的详细设计与实现尚未启动，不自动跨入 AO 编码。

## 5. 讨论方案融合与推进机制（2026-10-14）

本轮从 `aa04fd65` 再核对 RendererConfig、FrameProgram/Bindings/Lowering、HZB/reduction、Native environment/输出、coverage 子图、TextureResidency、旧 color pyramid/probe/post 与现行 Present。重新评审用户提供的讨论，保留 Feature Completion 与分层推进，撤下预建通用框架、固定 sidecar/baseline 和提前定案 SDF GI 等未经消费者与成本支持的选择，具体裁决只见粗设计，不另增评审/状态文。

默认顺序将 SSR 前置于 VT，局部镜面 probe 独立成模块，screen diffuse/world GI 分开，并补局部阴影、候选 Decals/RVT 与已有显示链的真实边界。现有 HZB 不是现成 SSR 精细层级，AO weighted depth 不强行合并；间接光替换要求同 lobe/响应/预曝光，颜色产品依赖必须无环；VT v1 保护完整 coverage 依赖，而不只是 alpha 标签。相关来源只是粗评审入口，未选择完整 donor/profile，未实施或提升 adoption。

文档导航增加稳定 roadmap 层并保留唯一当前 authority；粗执行表只维护模块入口，细设计/执行文件等用户启动对应模块时再创建。当前 CLI 的 context 仍展示当前 authority，roadmap 从 workstream 数据读取，本轮没有新增工具执行行为。

集中检查：document-system 7/7 通过；vibe doctor 无 errors/warnings、registry 字节一致；roadmap 两个入口均存在且为 current，AO/HZB/TextureResidency/RendererCore 的 context 均只返回一对当前 authority；git diff --check 通过。全库 docs-verify 仍因既有 Git 忽略的 docs/status.generated.md 缺 frontmatter 返回 exit1、1 个 finding，另有81条原历史断链 warnings；没有新增 finding/warning，不宣称全库通过。

本轮未创建模块详案、生产基础设施、资产/ABI、依赖或测试阈值。未运行 engine build、browser、GPU 或 benchmark，原因是只修改文档/导航，没有生产代码或资产变动。本轮粗记录完成，停在任何功能细设计/实现之前。

## 6. SCGI方向切换（2026-10-17）

依据用户选定母稿及当前源码，撤下独立SSGI、SDF/Atlas DDGI/probe优先world GI路线，合并为Surface Cache GI；Local Specular Cache后置。当前细设计/执行已建立，全部代码单元仍待实施，验证结果仅见SCGI执行记录；没有追认任何旧GPU/性能失败。
