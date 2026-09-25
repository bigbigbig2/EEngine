# EEngine Next：开源迁移来源与采用边界

调查日期：2026-09-25。当前采用边界对应 [ADR-0020](../adr/0020-clean-cut-renderer.md) 和 [单路径重建路线](../next-renderer.md)。这是影响当前选型的来源账本，不是已移植清单；表中的模块是目标 owner，不表示迁移顺序。

本轮通过 GitHub 固定 revision 的目录、许可证原文和下列标明的实现文件进行核查；未构建这些上游工程，未跑其 benchmark，也未证明移植后的 WebGPU 性能。**固定 commit 是复现调查的版本，不是自动引入依赖或升级现有来源的指令。** 本地已有 port 继续以 [geometry](./geometry.md)、[visibility](./visibility.md)、[shading](./shading.md)、[platform](./platform.md) 的既有 revision 为准。

所有新增候选当前 Adoption 均为 **not adopted**。下表的“优先/候选/参考”只表示实施推荐；完成实际迁移后，逐项写入本地生产文件、源函数映射、差异和验证，再改为 `traceable local port` 或其他真实采用方式。

## 1. 推荐总表

| 用途 / owner | 优先来源 | 应迁移的范围 | 仍由本地完成的部分 |
| --- | --- | --- | --- |
| Renderer Core / frame-runtime | 现有 FrameGraph；Filament 参考 | 参考图生命周期与裁剪，不替换本地整套图 | 产品语义、有限物理计划、跨 Provider 成本选择 |
| Renderer Core / visibility | GPUPrefixSums | 完整 Reduce-Then-Scan WGSL 算法 | 队列协议、容量、间接执行和生命周期 |
| Scene & Virtual Resources / virtual-assets | 现有 Nyx、meshoptimizer ledger | 继续现有忠实迁移 | 不因 Next 重写正确的 geometry 基础 |
| Visibility & Surface / shading | The Forge VisibilityBuffer2 | 插值、解析梯度及依赖数学 | EEngine identity、资源布局、显式纹理梯度 |
| Visibility & Surface / shading、materials-textures | 现有 Filament；MaterialX 可选 | 沿用 PBR；graph/lowering 参考 | 有界 binding/kernel family、去重合法性、frequency planning |
| Light Transport / shading | XeGTAO | 深度预处理、求值、边缘感知降噪 | 产品空间适配、输出/Temporal 接口 |
| Light Transport / shading、visibility | FidelityFX SDK v1.1.4 SSSR + Denoiser | 分类、工作列表、追踪、验证、完整信号重建 | WebGPU wave/绑定适配和镜面能量组合 |
| Light Transport / shading、virtual-assets、visibility | Timberdoodle（需原型） | 页面需求、分配、失效、缓存、采样 | 无 mesh shader 的硬件 indirect 页执行 |
| Light Transport / shading、virtual-assets | Atlas DDGI（候选）；Speedball（补充） | probe 更新/遮挡/状态/查询；评估软件 ray producer | 动态需求、VG 代理、非 bindless 资源与预算 |
| Light Transport / Screen GI | **UnitySSGIURP 优先算法候选**；Wicked Engine compute 链作执行对照 | 对照完整追踪、fallback、时域、降噪、上采样；实施前固定一个完整 profile | 改写 fullscreen/URP 依赖、GPU ray work、与 World Field/Sky 的能量边界及求值预算 |
| Environment & Media / shading | Takram atmosphere WebGPU | LUT、太阳/天光、shadow-aware aerial transport | 去 Three/TSL 宿主、单位与环境权威 owner |
| Environment & Media / shading | Adria VolumetricFog（候选） | 注入、历史、积分与合成 | bounded binding、介质输入和大气区间合成 |
| Temporal & Presentation / frame-runtime、shading | FidelityFX SDK v1.1.4 FSR3 Upscaler | 所选版本的完整非神经超分链 | WebGPU 后端、统一 history/exposure 接口 |
| Visibility & Surface / 频率分类 | FidelityFX VRS 仅作分类数学参考 | 可选的对比度/运动分类条件 | compute work 生成、重建与质量合同属本地集成，无完整 donor |
| VT / materials-textures | **Wicked Engine 地形 VT + LibVT 通用 VT 双来源候选** | 前者取 GPU 请求/分配/驻留，后者对照页表/过滤/离线切页完整性；先保留 Texture Residency | 两者均不能整套直搬；通用资产布局、WebGPU 有界绑定、异步反馈/上传闭环需原型 |
| Adaptive Compute Shading / shading | **无已核实整套 donor**；AMD VRS 分类参考 | 可迁移选中的分类数学，不能冒称完整算法来源 | 频率产品合同、材质频带、重建与质量控制 |

## 2. 公共基础与材质来源

### R01 · GPUPrefixSums：优先采用已有 WGSL scan

- **Upstream / Revision**：[b0nes164/GPUPrefixSums](https://github.com/b0nes164/GPUPrefixSums/tree/98d93a4e9ed2f3c8353119515bf9be90a2e137ad)，`98d93a4e9ed2f3c8353119515bf9be90a2e137ad`。
- **Source**：[rts.wgsl](https://github.com/b0nes164/GPUPrefixSums/blob/98d93a4e9ed2f3c8353119515bf9be90a2e137ad/GPUPrefixSumsWebGPUapis/SharedShaders/rts.wgsl)；同目录 `csdl.wgsl`、`csdldf.wgsl`、`csdldf_struct.wgsl` 仅为备选。已读 README、LICENSE 和 RTS 实现。
- **License**：本体 MIT；仓库 LICENSE 另含第三方 BSD notices。所读 `rts.wgsl` 标注 SPDX MIT；实际复制子集保留对应 notice。
- **Local owner / Adoption**：visibility 的工作基础算子；not adopted，首选完整 Reduce-Then-Scan 路线。
- **Retained invariants**：归约、扫描和最终分发阶段完整；分区边界、非整组长度、全零/稀疏计数正确；由 GPU 输出 offset/count 供 GPU 消费。
- **WebGPU differences**：接入本地 queue 生命周期、容量和 dispatch。RTS 选型是选择一个完整上游算法，不是删减 decoupled-lookback；后者需要单独证明设备上的前进保证与内存模型，不依赖跨 workgroup 自旋“碰巧成功”。
- **Fallback / lifecycle**：能力适配保留相同 scan 结果语义；不能借 fallback 将本帧有效工作读回 CPU。队列失败/溢出采用显式界限政策。
- **Local validation**：小型 CPU reference 比较 prefix/total，包括边界长度和容量极限；一个真实 Meshlet/Shading/Ray consumer 检查间接消费。尚未执行该 port 的验证。

### R02 · The Forge：Visibility 后的属性重建

- **Upstream / Revision**：[ConfettiFX/The-Forge](https://github.com/ConfettiFX/The-Forge/tree/cd5046893faba2dc7869243873bf01f02a6f0df9)，`cd5046893faba2dc7869243873bf01f02a6f0df9`。
- **Source**：[VisibilityBufferShadingUtilities.h.fsl](https://github.com/ConfettiFX/The-Forge/blob/cd5046893faba2dc7869243873bf01f02a6f0df9/Common_3/Renderer/VisibilityBuffer2/Shaders/FSL/VisibilityBufferShadingUtilities.h.fsl)（已读）；同子系统 `TriangleFiltering.h.fsl`、`VisibilityBuffer2.cpp` 为关联入口。
- **License**：根 LICENSE Apache-2.0，已读；依赖和第三方资产单独核对。
- **Local owner / Adoption**：shading/visibility；not adopted（本轮新调查，不重置旧 visibility ledger）。
- **Retained invariants**：透视正确属性插值、解析梯度与纹理采样 LOD 关系；退化与裁剪场景不能因换语言而省略必要处理。
- **WebGPU differences**：FSL → WGSL；绑定和 visibility identity 使用 EEngine 合同，不能照搬 native descriptor/indirect。Visibility Buffer 2.0 是数学与组织参考，不搬整套 renderer。
- **Fallback / lifecycle**：已有 Surface/visibility 作为迁移对照；必要 unsupported material 仍经统一主管线的合法 provider 处理，不能静默错误着色。
- **Local validation**：透视平面、高 UV 梯度、退化/近裁剪案例，与参考插值/梯度对照；复用现有 sparse-shading validation。未运行上游工程。

### R03 · Filament：沿用 PBR，参考图与照明组织

- **Upstream / Revision**：[google/filament](https://github.com/google/filament/tree/41f996de8fcc2d6b60b73159aa1bc44a05a40700)，调查 pin `41f996de8fcc2d6b60b73159aa1bc44a05a40700`。现有 PBR 使用 [shading ledger](./shading.md) 的既有 pin，**不自动升级**。
- **Source**：[FrameGraph.cpp](https://github.com/google/filament/blob/41f996de8fcc2d6b60b73159aa1bc44a05a40700/filament/src/fg/FrameGraph.cpp)、`shaders/src/surface_light_indirect.fs`（已读）；`libs/filamat/src/shaders/ShaderGenerator.cpp`、`filament/src/Froxelizer.cpp` 为进一步入口。本轮仓库递归目录响应被截断，具体已读文件通过固定 URL 单独获取，不声称遍历完整仓库。
- **License**：根 LICENSE Apache-2.0，已读。
- **Local owner / Adoption**：frame-runtime/shading；新 pin not adopted，既有 port 状态不变。
- **Retained invariants**：图的资源依赖/生命周期和现有 BRDF/能量语义；不要把改组织结构变成重写材质数学。
- **WebGPU differences**：复用本地 FrameGraph 和 compiler；Filament 并不直接提供本设计的 semantic product compiler。Froxelizer 是光源分簇，不是完整 Froxel fog integrator。
- **Fallback / lifecycle**：稳定程序缓存与 revision-local 绑定分离；device loss/resize 按本地 owner 管理。
- **Local validation**：图裁剪/feature-off 与现有材质参考检查；只迁移实际选择的数学/功能，不追求 API 同构。

### R04 · MaterialX：可选的离线图与 WGSL lowering 参考

- **Upstream / Revision**：[AcademySoftwareFoundation/MaterialX](https://github.com/AcademySoftwareFoundation/MaterialX/tree/2d516f56752abbb8bc5d6d438bfb7970d1b6f8f7)，`2d516f56752abbb8bc5d6d438bfb7970d1b6f8f7`。
- **Source**：[ShaderGraph.cpp](https://github.com/AcademySoftwareFoundation/MaterialX/blob/2d516f56752abbb8bc5d6d438bfb7970d1b6f8f7/source/MaterialXGenShader/ShaderGraph.cpp)、`source/MaterialXGenGlsl/WgslShaderGenerator.cpp`（均已读）。包含拓扑排序、未使用节点处理与 WGSL 生成入口。
- **License**：Apache-2.0，根 LICENSE 已读。
- **Local owner / Adoption**：shading/materials-textures；not adopted，可选，不要求引入完整用户材质语言。
- **Retained invariants**：选中节点图的类型/依赖/输出语义，不将复杂节点悄悄换成常数或简化 BRDF。
- **WebGPU differences**：其 WGSL generator 不等于本引擎 compute material、显式导数与绑定闭包已完成；本轮没有证明它提供目标所需的采样等价去重。先整理已有有限材质编译路径，按实际收益决定采用范围。
- **Fallback / lifecycle**：不支持的 node 显式拒绝或采用已声明 provider；shader cache key 需包含真实图/绑定/能力差异。
- **Local validation**：若采用，用少量代表材质与源生成结果比较输出/依赖；无需为本轮先建设 MaterialX 编辑器。

## 3. 屏幕空间光传输

### R05 · XeGTAO：首选 AO 来源

- **Upstream / Revision**：[GameTechDev/XeGTAO](https://github.com/GameTechDev/XeGTAO/tree/a5b1686c7ea37788eeb3576b5be47f7c03db532c)，`a5b1686c7ea37788eeb3576b5be47f7c03db532c`；项目已 archived，不能假设上游继续维护。
- **Source**：[XeGTAO.hlsli](https://github.com/GameTechDev/XeGTAO/blob/a5b1686c7ea37788eeb3576b5be47f7c03db532c/Source/Rendering/Shaders/XeGTAO.hlsli)、`Source/Rendering/Shaders/XeGTAO.h`。已读实现中的 `XeGTAO_PrefilterDepths16x16`、`XeGTAO_MainPass`、`XeGTAO_Denoise` 与相关 bent-normal 编解码。
- **License**：MIT，LICENSE 已读。
- **Local owner / Adoption**：shading；not adopted，优先迁移。
- **Retained invariants**：深度预处理、可见性积分、边缘权重和降噪成链；正确的深度空间和尺度。若选 bent normal 输出 profile，连带编码/解码与消费语义一起迁移。
- **WebGPU differences**：HLSL → WGSL；reverse-Z、mip 格式、绑定及工作组适配。不能把 occlusion HZB 直接冒充算法要求的 filtered depth，也不凭“都是 AO”拼接 CACAO 参数/阶段。
- **Fallback / lifecycle**：关闭 AO 不保留 depth prefilter/denoise 的孤儿消费者；无 AO 产品时提供中性可见性，不改变 GI 能量两次。
- **Local validation**：平面/墙角/薄几何与运动的 reference 输出或 oracle，检查 halo/深度边缘和尺度。不是只证明 shader 编译。

### R06 · FidelityFX SSSR + Reflections Denoiser：首选反射链

- **Upstream / Revision**：[GPUOpen-LibrariesAndSDKs/FidelityFX-SDK v1.1.4](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK/tree/c6efa6bf7f2027b3ec94f28578bb5965eabb9e55)，`c6efa6bf7f2027b3ec94f28578bb5965eabb9e55`。
- **Source**：[SSSR GPU 目录](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK/tree/c6efa6bf7f2027b3ec94f28578bb5965eabb9e55/sdk/include/FidelityFX/gpu/sssr)：`ffx_sssr_classify_tiles.h`、`ffx_sssr_intersect.h`、depth downsample、prepare blue noise/indirect args、common/callbacks；[Denoiser 目录](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK/tree/c6efa6bf7f2027b3ec94f28578bb5965eabb9e55/sdk/include/FidelityFX/gpu/denoiser) 中 `ffx_denoiser_reflections_{reproject,prefilter,resolve_temporal,common,config}.h`。
- **Host 入口**：`sdk/src/components/sssr/ffx_sssr.cpp`、`samples/sssr/sssrrendermodule.cpp`。实施时连同常量、noise 资源、callbacks 和 host 排序对照，不能只抓两段 shader。
- **检查深度 / License**：已读所选 classify/intersect、反射降噪文件及 `sdk/LICENSE.txt`；该固定版本所选源 MIT。未构建上游样例。
- **Local owner / Adoption**：shading/visibility；not adopted，优先迁移。
- **Retained invariants**：基于 roughness/variance 的分类、samples-per-quad/copy flags、ray 与 denoiser tile 两类需求、noise 序列、层次遍历、hit validation、重投影/预滤波/时域 resolve。不得退化成全屏 ray march + 简单 mix 历史后称为 SSSR 移植完成。
- **WebGPU differences**：wave lane/quad 分组和 subgroup 大小显式适配；ray reservation/count 与 indirect 仍由 GPU 闭环。保持深度/法线/roughness/运动输入约定和 specular baseline replacement，资源绑定换成有界 WebGPU bindings。
- **Fallback / lifecycle**：屏幕外/无效 hit 回到环境或 probe；history 随曝光、尺寸、身份和相机切换失效；空 ray list 不执行昂贵 trace。
- **Local validation**：高/低粗糙度、屏幕边界、薄遮挡、揭露/运动下的分类和 hit/temporal 对照；看 ray count、denoiser count 与总成本，不仅 trace 耗时。
- **备用来源**：[旧独立 FidelityFX-SSSR](https://github.com/GPUOpen-Effects/FidelityFX-SSSR/tree/34dcacd1feefcfab2855b82e76c7d711f2020a75)，`34dcacd1feefcfab2855b82e76c7d711f2020a75`，MIT，已读 license/classify/intersect；不作为默认与 SDK 混合拼接。

## 4. Virtual Shadow 与世界 GI

### R07 · Timberdoodle：VSM 页面算法候选，执行后端必须重做

- **Upstream / Revision**：[Ipotrick/Timberdoodle](https://github.com/Ipotrick/Timberdoodle/tree/1987cf3b8ddda42585d2470bb5806efbc96c6cae)，`1987cf3b8ddda42585d2470bb5806efbc96c6cae`。
- **Source**：[virtual_shadow_maps](https://github.com/Ipotrick/Timberdoodle/tree/1987cf3b8ddda42585d2470bb5806efbc96c6cae/src/rendering/virtual_shadow_maps)：`mark_required_pages.hlsl`、`allocate_pages.hlsl`、`invalidate_pages.hlsl`、`free_wrapped_pages.hlsl`、`force_always_resident_pages.hlsl`、`find_free_pages.glsl`、`clear_pages.hlsl`、`clear_dirty_bit.glsl`、`gen_dirty_bit_hiz.hlsl`、`vsm_state.hpp`、`vsm.inl`；采样入口 `src/shader_lib/vsm_sampling.hlsl`。
- **已读关键链**：`vsm.inl`、需求标记/分配、`cull_and_draw_directional_pages.hlsl`。后者实际使用 amplification shader、`DispatchMesh`/mesh shader 与 Daxa 指针风格资源访问。不是拿到 WGSL 翻译即可运行。
- **License**：Apache-2.0，根 LICENSE 已读。
- **Local owner / Adoption**：shading/visibility/virtual-assets；not adopted，需先证明页执行模型。
- **Retained invariants**：完整的 receiver demand → residency/allocation → dirty/invalidation → rendering → sampling 闭环；缓存重用和移动 clipmap/页失效；缺页处理必须与采样保持一致。不能只移植 page table 却宣称 VSM 完成。
- **WebGPU differences**：选中的页面管理算法保持语义；几何发射后端替换为现有 GPU hierarchy + 有界 hardware indirect raster。页批次、viewport/atlas 映射和绑定成本需实测；不用 CPU 获取当前活跃页数后逐页扫描 caster。
- **Fallback / lifecycle**：旧 CSM 仅供离线对照，不进入 Next production fallback；VSM 未完成时允许暂时无影。物理页更新、sun/geometry 变化与 history 的失效范围需连通，缺页采样有明确行为。
- **Local validation**：移动相机/光源、屏幕外 caster、页溢出/回收；同时看 dirty-page 数、caster work 和实际命令开销。本轮未证明可在目标设备上高效执行。

### R08 · Atlas：DDGI 与软件 BVH 主候选

- **Upstream / Revision**：[tippesi/Atlas-Engine](https://github.com/tippesi/Atlas-Engine/tree/76e4916e55706c0f6eac971d17d65bd8feacf70e)，`76e4916e55706c0f6eac971d17d65bd8feacf70e`。
- **Source**：[DDGI shaders](https://github.com/tippesi/Atlas-Engine/tree/76e4916e55706c0f6eac971d17d65bd8feacf70e/data/shader/ddgi)：`rayGen.csh`、`rayHit.csh`、`probeUpdate.csh`、`probeState.csh`、`copyEdge.csh`、`ddgi.hsh`；host `src/engine/renderer/DDGIRenderer.cpp` 的 `TraceAndUpdateProbes`；`data/shader/raytracer/bvh.hsh` 的软件 `HitClosest` 路径。
- **检查深度**：已读上述 host、probe update/state/query 和 BVH；BVH 源确有 `#ifndef AE_HARDWARE_RAYTRACING` 软件分支，不是只有硬件 ray query 的包装。
- **License**：根 `LICENSE.md` MIT，已读。DDGI 源引用论文并注明 WickedEngine inspiration；正式复制前追溯具体派生函数/第三方 notice，根许可证不是全部来源已经核清的证明。
- **Local owner / Adoption**：shading/virtual-assets；not adopted，优先做世界场切片调查。
- **Retained invariants**：radiance 与 distance 样本、hysteresis、距离统计与 Chebyshev 遮挡权重、backface/状态、边缘复制、级联/空间查询的相互关系；若选择 relocation/classification profile，必须逐项对照其完整实现，不以名词替代源码。
- **WebGPU differences**：GLSL → WGSL；非一致纹理访问和 native 绑定不能直接搬。用户已选择首版动态几何与动态光源：必须对照动态结构 refit/rebuild、实例增删/变形、光源变化与 Probe 失效的完整链。ray producer 可以基于声明过的世界代理，不要求追踪所有 VG 微三角形，但代理生产/误差/动态更新是显式设计取舍，不能悄悄用 sky color 或静态烘焙填所有 probe 冒充动态 DDGI。
- **Fallback / lifecycle**：无有效 field 或低置信度时回到声明的 Sky/烘焙边界；相机移动、几何更新与 probe 状态按范围失效；GPU 时间预算限制更新速度。
- **Local validation**：角落漏光、墙后遮挡、移动光源、场边界与历史收敛；首先证明样本确实来自合法 producer，再评估规模和吞吐。

### R09 · Speedball：WebGPU DDGI 补充来源

- **Upstream / Revision**：[cl0nazepamm/speedball](https://github.com/cl0nazepamm/speedball/tree/a997aee5b0791be61b49719377e811c41720df59)，`a997aee5b0791be61b49719377e811c41720df59`。不是演示站的 `norio/speedball-gi`。
- **Source**：[js/gi_probes.js](https://github.com/cl0nazepamm/speedball/blob/a997aee5b0791be61b49719377e811c41720df59/js/gi_probes.js)、`js/spectral_traverse.js`、`js/gi_budget.js`、`js/gi_oct.js`。已读 README/LICENSE 和大文件中 probe update、classification、variance/query、BVH 生命周期相关段落；**未逐行审计整份约 292k 字符实现**。
- **License**：根 MIT 已读；Three/three-mesh-bvh 等依赖按对应许可证追踪。
- **Local owner / Adoption**：shading/virtual-assets；not adopted，WebGPU 可行性补充，不替换 Atlas 调查或本地 Scene。
- **Retained invariants**：选中 probe 更新、距离可见性、backface 分类、预算与历史必须成链。文件开头 phase 注释和实现不完全同步：正文已有 `classifyKernel` 等逻辑，不能凭旧注释断言它缺 classification。
- **WebGPU differences**：支持 Three WebGPU/TSL 及另一后端不意味着可零成本移植到 EEngine。源码含依赖主线程/idle 的同步 BVH rebuild 路径，需要与 GPU-ready 资产/Worker 流程适配；先确认真正 GI traversal 的完整调用链，不能误用 `caustic_bvh.js` 当 GI 主 producer。
- **Fallback / lifecycle**：迁移候选必须保持更新预算与重建期间 field 有效性；禁止把闲时 rebuild 的暂停/卡顿悄悄带入场景 publication。首版动态 GI 已确认，仅能等待场景静止再更新的路径不足以满足该要求；保留其算法参考，执行与更新后端必须另行验证。
- **Local validation**：补完整 producer→probe update→shading consumer 映射后再做同一 GI 场景对照。本轮仅证明存在相关源实现，不宣称成熟度或大场景性能。

## 5. 物理环境与介质

### R10 · Takram：Physical Environment 的主要来源

- **Upstream / Revision**：[takram-design-engineering/three-geospatial](https://github.com/takram-design-engineering/three-geospatial/tree/b012ad06d858fc035d88aacfd73f092f93c994e4)，`b012ad06d858fc035d88aacfd73f092f93c994e4`。用户展示链接是效果入口，真正主要代码在该仓库 atmosphere package。
- **Source**：[packages/atmosphere/src/webgpu](https://github.com/takram-design-engineering/three-geospatial/tree/b012ad06d858fc035d88aacfd73f092f93c994e4/packages/atmosphere/src/webgpu)：`AtmosphereLUTTexturesWebGPU.ts`、`AtmosphereLightNode.ts`、`multiscattering.ts`、`runtime.ts`、`AerialPerspectiveNode.ts`、`precompute.ts`、`common.ts`；`packages/atmosphere/WEBGPU.md`。
- **检查深度**：本轮读 WebGPU 说明、multiscattering 实现与 package LICENSE，核对关联入口。说明明确为 Bruneton 4D LUT 配合 Hillaire 高阶多重散射 LUT，以及避免精度问题的散射积分路径；实施时仍需完成各入口逐项映射。
- **License**：package LICENSE 包含 MIT 主体、Bruneton BSD 条件和 Hillaire notices。不能只写“整个算法 MIT”；复制所选代码时保留派生来源及相应条款。
- **Local owner / Adoption**：Environment & Media（当前路由 shading）；not adopted，优先来源。
- **Retained invariants**：预计算/运行时参数一致，太阳透射、直射/间接散射和 aerial transport 在同一单位与空间下组合；所选 shadow-aware transport 不能省成单纯距离雾。光照与天空消费同一个环境状态。
- **WebGPU differences**：TSL → WGSL 或本地生成器；不引入 Three/R3F runtime。去地理接口不等于删除行星尺度、观察高度和大气几何模型；由 EEngine 约定世界长度与局部原点映射。
- **Fallback / lifecycle**：LUT 参数变更版本化重算/替换；未完成更新可保留上个有效环境，不能将部分新旧 LUT 混用。feature-off 清理无消费者计算，物理环境可提供稳定 Sky/IBL fallback。
- **Local validation**：固定太阳高度和观察高度下对照透射、天光与 aerial perspective；检查太阳方向/曝光/长度转换，而不只比较天空截图。

### R11 · Adria：Froxel 局部介质候选

- **Upstream / Revision**：[mateeeeeee/Adria](https://github.com/mateeeeeee/Adria/tree/8b8b365e1307030481085dc3504ca8973ef79af2)，`8b8b365e1307030481085dc3504ca8973ef79af2`。
- **Source**：[VolumetricFog.hlsl](https://github.com/mateeeeeee/Adria/blob/8b8b365e1307030481085dc3504ca8973ef79af2/Assets/Shaders/Lighting/VolumetricFog.hlsl)，`LightInjectionCS`、`ScatteringIntegrationCS`；host `Source/Rendering/FogVolumesPass.cpp`。已读两份实现，包含 Texture3D history、注入/积分/合成生命周期。
- **License**：根 MIT 已读，选取代码时仍保留文件/依赖 notice。
- **Local owner / Adoption**：shading；not adopted，局部介质迁移候选。
- **Retained invariants**：密度/散射输入、光注入、时域重投影与路径积分的前后依赖；不能把体积介质简化成后处理颜色 lerp 仍保留原算法名称。
- **WebGPU differences**：HLSL 和 `ResourceDescriptorHeap` 换成明确有界 bindings；Froxel history 接 Temporal & Presentation，Local Volume/Particles 数据接本地场景。将输入扩成统一消光/散射系数属于明确扩展，不能宣称已完整复刻 Frostbite。
- **Fallback / lifecycle**：无介质返回零散射/单位透射；resize、相机与光源变化参与 history 失效。与大气分配路径区间，透明合成按实际深度处理。
- **Local validation**：均匀介质可解析积分对照、局部体积边界、运动历史和阴影中的光散射；验证关闭后的零成本产品裁剪。

## 6. Temporal 与频率分类

### R12 · FSR3 Upscaler：默认非神经重建候选

- **Upstream / Revision**：与 R06 相同的 [FidelityFX SDK v1.1.4](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK/tree/c6efa6bf7f2027b3ec94f28578bb5965eabb9e55)，`c6efa6bf7f2027b3ec94f28578bb5965eabb9e55`。
- **Source**：[fsr3upscaler GPU 目录](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK/tree/c6efa6bf7f2027b3ec94f28578bb5965eabb9e55/sdk/include/FidelityFX/gpu/fsr3upscaler)，`ffx_fsr3upscaler_{prepare_inputs,prepare_reactivity,luma_pyramid,shading_change,shading_change_pyramid,accumulate,reproject,upsample,luma_instability,rcas}.h` 及其 common/callback 依赖；host `sdk/src/components/fsr3upscaler/ffx_fsr3upscaler.cpp`。
- **检查深度 / License**：核对该 tag 的源码目录、MIT `sdk/LICENSE.txt` 和选中 shader headers，读 accumulate；实施前需按 host 时序展开完整阶段映射。没有跑 FSR 样例或完成 WGSL 移植。
- **Local owner / Adoption**：frame-runtime/shading；not adopted，优先最终超分候选。
- **Retained invariants**：所选版本的 motion/depth/exposure/jitter 约定、输入准备、reactivity/shading-change、重投影/累积/重建与稳定性处理。保留合法 profile 内全部必要阶段；可选 sharpening 等范围预先写清。不能替换成历史 mix + sharpen 仍称 FSR3。
- **WebGPU differences**：HLSL/GLSL callbacks 和 wave 操作改成 WGSL；资源/格式 limits 协商；Temporal Fabric 提供公共状态而不强行替换算法内部历史语义。这里选的是 **Upscaler，不包含 Frame Generation**。
- **Fallback / lifecycle**：analytic 基线是具名后端；后端切换/相机切换/分辨率与曝光变化的历史兼容性明确。FSR 不是 sparse/coarse shading 自动正确的保证，Visibility & Surface 必须提供合法输入与置信度。
- **Local validation**：静态细节、运动细边、遮挡揭露、透明/高亮、曝光和动态分辨率；用固定源输入/输出作对照，连同完整重建成本评估。

### R13 · FSR2：备选，不与 FSR3 内部阶段拼装

- **Upstream / Revision**：[GPUOpen-Effects/FidelityFX-FSR2](https://github.com/GPUOpen-Effects/FidelityFX-FSR2/tree/1680d1edd5c034f88ebbbb793d8b88f8842cf804)，`1680d1edd5c034f88ebbbb793d8b88f8842cf804`（2.2 来源）。
- **Source**：`src/ffx-fsr2-api/shaders/ffx_fsr2_{reconstruct_dilated_velocity_and_previous_depth,depth_clip,lock,accumulate,reproject,upsample,compute_luminance_pyramid,rcas}.h`。
- **License / 检查深度**：已读 LICENSE.txt，MIT 文本；GitHub 检测显示 NOASSERTION 不等于无许可。目录核对，不声称本轮读完所有 shader。
- **Local owner / Adoption**：frame-runtime/shading；not adopted，备选。若改选，完整采用该版本时序、锁与历史语义；不把 FSR2 的 lock 阶段机械套进 FSR3。
- **WebGPU / lifecycle / validation**：与 R12 相同的能力协商与重建输入要求；切换为独立 backend，做该版本自己的对照，不能继承另一版本的证据。

### R14 · FidelityFX VRS：仅作为频率分类来源

- **Upstream / Revision**：FidelityFX SDK v1.1.4，`c6efa6bf7f2027b3ec94f28578bb5965eabb9e55`。
- **Source**：[ffx_variable_shading.h](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK/blob/c6efa6bf7f2027b3ec94f28578bb5965eabb9e55/sdk/include/FidelityFX/gpu/vrs/ffx_variable_shading.h)，已读；所选 SDK MIT 条款同 R06。
- **Local owner / Adoption**：shading；not adopted，有限算法参考。
- **Retained invariants**：如移植其对比度/运动分类，保留对应输入、阈值含义和输出区域语义；不等于所有材质可由 roughness 降频。
- **WebGPU differences**：上游输出 hardware VRS image，WebGPU 默认没有对应 shading-rate attachment。可采用分类数学，之后的 compute-work 生成与质量重建必须明确为本地新集成，不能标记为“完整 VRS 已迁移”。
- **Fallback / lifecycle**：full-rate 可作为合法计划；history 无效或高频边界不能只复制低频结果。
- **Local validation**：同时比较分类开销、总工作量与重建误差。该 donor 没有解决本引擎 adaptive compute shading 的完整正确性问题。

## 7. 补充核查：可替换原空白选型的源码

### R15 · UnitySSGIURP：Screen GI 完整信号链优先候选

- **Upstream / Revision**：[jiaozi158/UnitySSGIURP](https://github.com/jiaozi158/UnitySSGIURP/tree/8450297537b658218be1abbc973e9240a2aab71c)，`8450297537b658218be1abbc973e9240a2aab71c`；根 `LICENSE.md` 为 MIT。
- **Source**：[ScreenSpaceGlobalIllumination.shader](https://github.com/jiaozi158/UnitySSGIURP/blob/8450297537b658218be1abbc973e9240a2aab71c/Shaders/ScreenSpaceGlobalIllumination.shader)、`Shaders/SSGI.hlsl`、`Shaders/SSGIDenoise.hlsl`、[ScreenSpaceGlobalIlluminationURP.cs](https://github.com/jiaozi158/UnitySSGIURP/blob/8450297537b658218be1abbc973e9240a2aab71c/Runtime/ScreenSpaceGlobalIlluminationURP.cs)。已核实 host 的 history/fallback 调度和 shader 声明的 direct-light copy、trace、temporal reprojection、spatial denoise、stabilization、history depth、GI combine/upscale 阶段；未逐函数审计所有质量分支。
- **Local owner / Adoption**：shading/temporal；**not adopted**。替换此前“完全无 Screen GI donor”的判断，作为实施前首个完整算法 profile 候选；不是已经选定的生产移植。
- **必须保留**：直接光与间接光拆分、防止重复计能；screen hit/miss 与 Sky/Probe fallback；运动/深度历史有效性、拒绝、降噪、上采样。URP 的 ambient/APV 输入语义须与本地 World Field/Sky 显式对照，不能只搬 raymarch 函数。
- **WebGPU 差异 / 风险**：原实现是 Unity URP fullscreen blit + GBuffer + camera history，不是 GPU ray queue，也不自动满足 EEngine 的 workload reduction。候选迁移应把昂贵 trace 变成分类后 GPU consumer，比较分类/压缩/dispatch 成本；保留信号处理语义，不能宣称上游已有该 queue。历史所有权接本地 Temporal，透明/缺屏幕数据需具名 fallback。
- **验证映射**：固定场景比较静态/运动、遮挡揭露、屏外 hit、强 emissive、Sky/Probe 边界与能量；先证明完整阶段对照，再决定队列化是否有净收益。上游工程未运行。

### R16 · Wicked Engine：compute SSGI 与地形 VT 闭环

- **Upstream / Revision**：[turanszkij/WickedEngine](https://github.com/turanszkij/WickedEngine/tree/2ff1d9e7b36091d6edf9f823af77e6bc9af20e3b)，`2ff1d9e7b36091d6edf9f823af77e6bc9af20e3b`；根 `LICENSE.txt` 为 MIT。
- **SSGI source**：[wiRenderer.cpp](https://github.com/turanszkij/WickedEngine/blob/2ff1d9e7b36091d6edf9f823af77e6bc9af20e3b/WickedEngine/wiRenderer.cpp) 的 `Postprocess_SSGI`、`shaders/ssgi_deinterleaveCS.hlsl`、`ssgiCS.hlsl`、`ssgi_upsampleCS.hlsl`。已核实 depth/color/normal atlas、deinterleave、compute GI 和 upsample 的调用链；本次未证明它含有与 R15 等价的独立时域链，因此作为 compute 组织对照，不混称 R15 的完整替代。
- **VT source**：[wiTerrain.cpp](https://github.com/turanszkij/WickedEngine/blob/2ff1d9e7b36091d6edf9f823af77e6bc9af20e3b/WickedEngine/wiTerrain.cpp) 的 `UpdateVirtualTexturesCPU`、`virtualTextureTileRequestsCS.hlsl`、`virtualTextureTileAllocateCS.hlsl`、`virtualTextureResidencyUpdateCS.hlsl`、`terrainVirtualTextureUpdateCS.hlsl`。已核实 GPU 反馈/请求/分配、异步 readback、CPU 页决策、atlas 页生成、驻留映射及消费；当前源码定义 `NOSPARSE`，可研究不依赖硬件 sparse 的 atlas 路线。
- **Local owner / Adoption**：shading、materials-textures/virtual-assets；**not adopted**。VT 是**地形专用**实现，不自动满足通用材质/资产 VT。
- **WebGPU 差异 / 风险**：SSGI deinterleave 的多 UAV 输出与 WebGPU 有界 storage texture 布局冲突，需重新分段/打包并计入带宽；VT shader 使用 native bindless descriptor index，须改为有界资源表。CPU readback 仅用于异步页调度，不能变成本帧 shading 的同步依赖；页命中、缺页、mip 祖先与 eviction 时序须保留。
- **验证映射**：SSGI 与 R15 只比较可对齐的 trace/重建阶段；VT 比较页请求、延迟上传、淘汰、缺页 fallback、跨 mip 过滤、地形外资产适用性和 4 GiB 预算。未运行上游工程。

### R17 · LibVT：通用 VT 页表/过滤的第二来源

- **Upstream / Revision**：[core-code/LibVT](https://github.com/core-code/LibVT/tree/464397d9e2c655f72ad59cd1166b14e29e1bad3a)，`464397d9e2c655f72ad59cd1166b14e29e1bad3a`。根 `LICENSE` 原文声明 LibVT 本体 MIT，`Dependencies/*` 各有独立许可；复制子集前按文件核对。
- **Source**：[LibVT_PageTable.cpp](https://github.com/core-code/LibVT/blob/464397d9e2c655f72ad59cd1166b14e29e1bad3a/LibVT/LibVT_PageTable.cpp)、`LibVT_Cache.cpp`、`LibVT_Readback.cpp`、`LibVT_PageLoadingThread.cpp`、[renderVT.frag](https://github.com/core-code/LibVT/blob/464397d9e2c655f72ad59cd1166b14e29e1bad3a/LibVT/renderVT.frag)、`readback.frag`、`LibVT-Scripts/generateVirtualTextureTiles.py`。README 说明页检测、异步 stream、fallback 页表、双/三线性与各向异性过滤；已读 README、根许可和采样 shader，尚未逐函数审计所有 C++/依赖。
- **Local owner / Adoption**：materials-textures；**not adopted**。比 R16 更适合作为通用 VT 语义和离线切页参考，但实现停留在旧 OpenGL/GLSL/PBO 架构；**不推荐整套替换**现代 WebGPU residency runtime。
- **WebGPU 差异 / 验证**：页表坐标、tile border、显式梯度/LOD 和跨 mip fallback 可移植；GL readback/PBO、纹理格式和 CPU cache 所有权必须重建。把 R16 的 GPU demand 与 LibVT 的通用采样契约组合是**新设计**，不是任何单一上游已实现的完整 port；需测高频 UV、三线性边界、缺页与热缓存抖动。

### R18 · Bevy meshlet：强对照，但不替换 WebGPU 主链

- **Upstream / Revision**：[bevyengine/bevy](https://github.com/bevyengine/bevy/tree/dd66a3959725df860bb7c7217a6769d3deb661ef)，`dd66a3959725df860bb7c7217a6769d3deb661ef`；仓库标记 Apache-2.0，具体复制仍核对文件 notice。
- **Source**：[meshlet/mod.rs](https://github.com/bevyengine/bevy/blob/dd66a3959725df860bb7c7217a6769d3deb661ef/crates/bevy_pbr/src/meshlet/mod.rs) 明确宣称高密几何 GPU-driven、预处理、meshlet culling 和单 draw；同目录 `cull_instances.wesl`、`cull_bvh.wesl`、`cull_clusters.wesl`、`visibility_buffer_hardware_raster.wesl`、`visibility_buffer_software_raster.wesl`、`visibility_buffer_resolve.wesl` 是后续源码入口。
- **Local owner / Adoption**：virtual-assets/visibility；**reference only, not adopted**。当前 `MeshletPlugin` 明确要求 `WgpuFeatures::TEXTURE_INT64_ATOMIC`，且仅支持 Vulkan/Metal；不能因使用 WESL/wgpu 就宣称浏览器 WebGPU 可移植。用它比较层次剔除和 visibility 组织，不能替换已工作的 Nyx/VG/VisibilityKey 链。未逐 shader 审计或运行样例。

### R19 · voidin：WGSL work/visibility 轻量对照

- **Upstream / Revision**：[pannapudi/voidin](https://github.com/pannapudi/voidin/tree/36e84bb4e6c1bf4619df076cd2acdbeba1e63306)，`36e84bb4e6c1bf4619df076cd2acdbeba1e63306`；根 `LICENSE` MIT。
- **Source**：[emit_draws.wgsl](https://github.com/pannapudi/voidin/blob/36e84bb4e6c1bf4619df076cd2acdbeba1e63306/shaders/emit_draws.wgsl)、`visibility.wgsl`、`shading.wgsl`、`utils/bvh.wgsl`。可对照 WGSL 生成 indirect draws、visibility 消费和软件 BVH 查询；尚未核实其所有 host-side feature/limit 与浏览器运行路径。
- **Local owner / Adoption**：visibility/shading；**reference only, not adopted**。`shading.wgsl` 使用 `binding_array<texture_2d<f32>>`；该资源模型不能直接当作 EEngine 标准浏览器 WebGPU 的自由 bindless。这个项目也不证明本地 Work Runtime、VT 或完整 GI 已有现成替代。

本轮对既有优先来源的替换判定：

| 原选型 | 新候选 | 判定与理由 |
| --- | --- | --- |
| “Screen GI 无 donor” | R15 + R16 | **改判**：R15 已有完整信号链候选；R16 的 compute 组织另作对照。具体 WebGPU profile 尚须实施前定案。 |
| “VT 无合格整套 donor” | R16 + R17 | **改判**：已有互补源码可设计完整通用 VT，但没有单一可直搬的 WebGPU 生产实现。先做页反馈/采样闭环原型。 |
| 现有 Nyx/VG + The Forge visibility | R18 + R19 | **不替换**：Bevy 要求非目标原子能力；voidin 的 texture binding 假设尚未证明目标浏览器可用。只吸收可核实的算法差异。 |
| FidelityFX SSSR、FSR3 Upscaler、XeGTAO | 本轮检索到的 Screen GI/VT/meshlet 仓库 | **不替换**：这些候选没有提供同功能、更完整且更接近 WebGPU 的整套算法证据；保持已固定来源。 |
| Adaptive Compute Shading 本地设计 | R18/R19、FidelityFX VRS | **不冒名替换**：既无完整频率决策→稀疏执行→重建的可核实 donor，也不能把硬件 VRS image 当作 WebGPU compute shading。 |

## 8. 不默认采用的来源与技术

| 来源 | 本轮核查结果 | 本项目处理 |
| --- | --- | --- |
| FidelityFX SDK 最新 v2.3.0，`60f4ea81909200d8542eca14dccb2628b763a9a3` | `Kits/FidelityFX/docs/license.md` 已读，存在默认 binary redistribution 条款与文件级例外；部分 FSR3 header 为 MIT | 不把整个最新 SDK 标成 MIT；本轮采用固定 v1.1.4 的已核查源子集 |
| [RTXGI-DDGI](https://github.com/NVIDIAGameWorks/RTXGI-DDGI/tree/f33e496ca31b3f0eec1c4e2cbaa8bb620e337fa6)，`f33e496ca31b3f0eec1c4e2cbaa8bb620e337fa6` | 根 `License.txt` 为 NVIDIA RTX SDK LICENSE；已读 `ProbeBlendingCS.hlsl`、`ProbeRelocationCS.hlsl`、`Irradiance.hlsl` | 保留算法对照/条件候选，不作为已批准的 MIT donor；默认先评估 Atlas，不能将 license 风险藏在 migration 里 |
| [NRD](https://github.com/NVIDIA-RTX/NRD/tree/7033ffbc48dbd74713194555abc13da8d7de4bcb)，`7033ffbc48dbd74713194555abc13da8d7de4bcb` | 根 LICENSE.txt 为 NVIDIA RTX SDK LICENSE；目录有 REBLUR/RELAX，不等于完成全文算法核查 | 信号语义参考，当前反射优先 MIT FidelityFX Denoiser；未来按实际文件/条款再选 |
| [Unity Graphics](https://github.com/Unity-Technologies/Graphics/tree/a7e4c051d256a781ab362c64316b125a1e104694)，`a7e4c051d256a781ab362c64316b125a1e104694` | 根 Unity Companion License 已读；有 HDRP fog/VBuffer 源 | 不作为本外部引擎的默认代码移植来源；局部介质选 Adria 候选 |
| Unreal Nanite / GPU-Driven Materials / VSM | 技术资料与受 Epic 条款约束的引擎来源，不是普通宽松许可 donor | 借鉴管线思想；不宣称找到可直接移植的开放 Nanite 实现 |
| Frostbite、Decima/Nubis | 有有价值的论文/演讲，未在本轮找到可直接采用的完整公开生产源码 | 用于空间、光传输和缓存设计比较；不虚构开源仓库，不阻塞云后置 |
| ReSTIR DI/GI、NRC、DLSS SR/RR、FSR4 类神经后端 | 其研究/SDK 输入和执行依赖不等于当前 WebGPU 能力 | 留信号/后端接口；当前不把硬件 RT、专有推理或零复制 WebNN 当成立条件 |
| CACAO | 成熟 AO 替代路线，但最终目标已选择 XeGTAO | 不引入第二套 AO 生产后端；需要改选时再做固定版本完整来源核查 |

许可记录用于工程选源，不等于法律意见；关键是准确保留上游文本、版权/NOTICE 和派生来源，不把根仓库标签当作所有文件的授权证明。无需等待所有备选许可调查结束才开始已核实的宽松许可迁移。

## 9. 实施时必须补齐的最小映射

每个选定切片在本账本或其所属领域 ledger 中补一张表即可，不新增一套审批系统：

| 源阶段 / entry | 条件、输入输出、必要不变量 | 本地生产 owner / entry | 差异 / fallback / 未覆盖项 | 对照入口 |
| --- | --- | --- | --- | --- |
| 具体固定 revision 的函数或 shader | 写实际语义，不写“沿用某某思想” | 真实生产文件，不能仅指 demo | 平台转换、选定 profile、明确行为差异 | 现有或新增的聚焦 case/oracle |

**不得偷懒简化算法**意味着：迁移选中 profile 的完整算法链，保留关键接受/拒绝分支、数据依赖、历史更新与失效、缺页/越界/溢出行为；不能删掉难移植的阶段后改称“等价优化”。不要求搬走上游所有模式、编辑器、资产或整套引擎；排除范围必须在实施前写清，不能完成后才补理由。

语言、布局、bindings、dispatch 和缓存 owner 可以改变，只要语义保留且差异可对照。遇到 WebGPU 无法保持的核心语义，明确记录缺口并确认算法/profile 调整；未确认、未对照的部分保持未完成。源算法本身不适合目标时可以换一个完整算法，但必须具名改变采用决定，不能在同一个名称下悄悄换成简化近似。

本轮没有复制任何候选进入 production，也没有引入新的 runtime dependency。下一批按 [workstream](../../project/workstreams/active/eengine-next-clean-rebuild.yaml) 直接切断旧 composition，建立最小 GPU Scene → Visibility → Present 主链；之后在新 owner 上逐项完整移植。旧 A 批次合同不再是开工前门禁。

## 10. 文章/论文：用于判定语义与边界，不冒充移植源码

| 原始资料 | 对 EEngine 的具体用途 | 与开源实现的关系 |
| --- | --- | --- |
| [Mayer, *Virtual Texturing*（TU Wien, 2010）](https://www.cg.tuwien.ac.at/research/publications/2010/Mayer-2010-VT/) | 页表、缓存、mip/filter 与反馈链的语义对照；尤其核查 page border 和 miss fallback | R17 README 明确链接该论文；论文不替代 R16/R17 的源码许可与 WebGPU 原型 |
| [McGuire 与 Mara, *Efficient GPU Screen-Space Ray Tracing*（JCGT, 2014）](https://jcgt.org/published/0003/04/04/) | SSR/Screen GI 的层次深度遍历、步进/命中和屏幕缺失条件；区分 ray work 减量和每 ray 成本 | R06/R15/R16 的 trace 对照；不能据此宣称 SSSR 或 SSGI port 完成 |
| [Karis 等, *Nanite: A Deep Dive*（SIGGRAPH Advances, 2021）](https://advances.realtimerendering.com/s2021/Karis_Nanite_SIGGRAPH_Advances_2021_final.pdf) | VG 层次、可见性和流送的性能边界；审视 EEngine 自己的 hardware-first raster 选择 | 技术演讲，不是宽松许可源码；不替换现有 Nyx 来源映射 |
| [Hillaire, *A Scalable and Production Ready Sky and Atmosphere Rendering Technique*（EGSR, 2020）](https://sebh.github.io/publications/egsr2020.pdf) | 多重散射 LUT、太阳/天空能量与 aerial perspective 的物理接口 | 与 R10 Takram WebGPU 实现交叉核对，不能把论文中的全部配置等同于该仓库已有功能 |
| [GPUOpen, *FidelityFX SSSR* 技术页](https://gpuopen.com/fidelityfx-sssr/) | 对照分类、追踪、降噪的官方功能边界及适用条件 | R06 的固定源码 revision 仍是实际迁移基准 |
| [Bitterli 等, *Spatiotemporal Reservoir Resampling for Real-Time Ray Tracing with Dynamic Direct Lighting*（2020）](https://research.nvidia.com/publication/2020-07_spatiotemporal-reservoir-resampling-real-time-ray-tracing-dynamic-direct) | 判断未来 ReSTIR DI 需要的候选生成、重用、可见性与历史语义 | 研究路线储备；当前浏览器 WebGPU 无成熟硬件 RT 管线，不把论文列为 Phase 4 默认 donor |

本次检索后的取舍是：**Screen GI 优先评估 R15 的完整信号链，R16 仅补 compute 执行对照；VT 以 R16 的 GPU 需求链和 R17 的通用采样/资产链共同指导原型。** 两处都还没有可不改写地整套移入 WebGPU 的单一项目。R18/R19 说明“wgpu/WGSL”标签不等于目标设备能力已经成立。Adaptive Compute Shading 仍缺一个经源码核实的完整、WebGPU 可移植 donor；保持本地架构问题，不用 VRS 分类算法冒充解答。
