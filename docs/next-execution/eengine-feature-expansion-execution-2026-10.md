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
    - OEngine/src/assets/TextureProduct.ts
    - OEngine/src/gpu/TextureResidency.ts
    - OEngine/src/gpu/NativeMaterialBindings.ts
    - OEngine/src/gpu/GPUSceneEnvironmentContext.ts
    - OEngine/src/render/DynamicResolutionScaling.ts
    - tools/project-navigation.mjs
    - tools/docs-verify.mjs
---

# EEngine 功能扩展执行总计划

唯一总体设计为[功能扩展路线](../next-design/eengine-feature-expansion-roadmap-2026-10.md)。用户本轮授权仔细读取代码、调整文档系统方向与粗计划；没有在本轮启动 AO/VT/SSR 等渲染实现。本文件维护粗粒度模块状态和详细设计入口，入口页/workstream不复制本表。

## 1. 推进单元与边界

| 单元 | 当前状态 | 完整交付范围 / 下一入口 |
|---|---|---|
| F0 源码核对与文档方向调整 | 已完成；全库既有文档 finding 单列于 §4 | 核对真实生产链与功能缺口，切换当前 authority，清理旧并行入口并保留既有实现/失败/延期义务；不改生产源码 |
| F1 AO 功能完善 | 未开始 | 先细化已有 scalar XeGTAO 的 settings/quality/debug/场景尺度与验证单元；不重写现有算法，不默认捆绑 temporal/bent normal |
| F2 Virtual Texture | 未开始 | 先研究并设计压缩分页 Product→provider→页表/物理页→Native+MASK/VSM采样→反馈/流送/淘汰全链；不直接套用几何页ABI |
| F3 Reflection | 未开始 | 当前 Native 的真实输入/有限产品、反射来源、去噪/history、IBL composition、HDR/clearcoat、开关与退休 |
| F4 Indirect Lighting | 未开始 | 根据目标场景研究并选择首个完整间接光方案；probe/Brick4/SSGI/ReSTIR不预先宣称已选择或采用 |
| F5 Transparency | 未开始 | 独立透明工作与正确合成，先明确 BLEND 范围，再按需求扩展折射/透射/水面；不恢复 retired owner |
| F6 Media | 未开始 | 在已有 Sky/Aerial 之上按需求设计局部参与介质/体积灯光，闭合密度、阴影、积分/透射率与history |
| F7 重建与显示策略 | 未开始 | 在已有 Native/FSR 基础上接入真实 DRS 等所需策略；各前序效果的motion/reactivity正确性不后移 |
| F8 完整组合、性能与最终验收 | 延期到功能组合稳定 | 统一功能/质量profile，集中整帧归因与优化、长窗口/尾延迟、冷启动与同时峰值、4GB OS驻留和最终画质 |

顺序表达当前功能优先级，不伪造模块间硬依赖。每个大模块结束停在边界，用当时源码决定下一模块详细设计；若场景要求提前透明等模块，先更新本表的顺序与范围，不自动跨模块编码。开工时只为当前模块建立一对详细设计/执行并更新 workstream；未来模块本轮不制造详案或占位实现。

## 2. 单模块完成口径

1. 设置/资产输入→producer→产品→全部直接 consumers→最终画面真实接通；开关、debug、能力与不支持范围清楚。
2. 改变数学/格式前有独立预期和成熟来源核对；既有语义测试保留，旧表示测试可按真实退休迁移。源码存在/编译通过不能代替运行。
3. settings、quality、资源和history身份进入真实 publication/图缓存生命周期；覆盖 resize、cut、普通motion、abort/retry、replacement、device loss与最后consumer fence退休。
4. 模块连通后集中 typecheck/build、新鲜build:test、必要Node/串行真实GPU、场景画质与开关/组合检查；资源容量/溢出及粗粒度成本须可说明。未完成的必需检查如实保留，不能靠漏像素/永久缺页或放宽断言结束。
5. 正式全Renderer同条件性能资格留F8；开发新效果不以V5净收益/60FPS先通过为门。错误、失控内存或实际无法运行不在此延期之列。

## 3. 已有工作与延期资格

| 原模块 / 记录 | 保留事实 | 本轮处理 |
|---|---|---|
| [V4 M1/M2](eengine-v4-native-shading-execution-2026-10.md)、[M3 Lighting](eengine-v4-lighting-execution-2026-10.md) | 已切换的Native/Geometry/Lighting及各自实际验证范围 | 保留生产底座，不重新执行旧迁移；实际缺口由新模块真实消费者决定 |
| [Texture Compression](eengine-v4-texture-compression-execution-2026-10.md) | 已闭合的BC/exact-alpha生产链及限定workload验收 | 作为VT输入；raw cook/包IO、driver/crossGPU等开放项不改成通过；既有excluded资产约束保留 |
| [V5 Final Pixel](eengine-v5-final-pixel-performance-execution-2026-10.md) | Phase1–5及追加局部单元的实际实现和证据 | Phase6正式qualification、条件Phase7延期；不作为启动新效果的统一前置，F8重核完整图 |
| [VSM V4](eengine-v4-vsm-execution-2026-10.md) | R1–R3已实现链及后来采样/正确性修复 | R4完整场景/动态压力/画质/成本资格仍未完成；与新效果相交的正确性不得延期 |
| [Minimal GPU Work](eengine-v4-minimal-gpu-work-execution-2026-10.md) | 已落地A–F工作与原始负成本/P95结果 | 保持暂停，不从A重做；相关性能问题留集中归因 |
| 历史B2数值失败 | 没有被本轮修复或追认 | 继续沿workstream deferredValidation与原记录追溯；存活语义由当前真实owner承担 |

这些行是延期责任路由，不复制旧模块逐单元状态。新的效果组合改变需求后，F8重新冻结真实quality/feature/profile及reference，不将旧V5的采样默认、历史热机数字或不同renderScale数据冒充最终基线。

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
