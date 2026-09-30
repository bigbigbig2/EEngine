# Surface 着色性能：源码诊断与候选设计（历史调查）

日期：2026-09-30。性质：设计分析，未实施；不代表 GPU 性能提升或上游采用完成。

> 已收敛为 [Surface 最终设计](surface-sample-driven-shading-final-2026.md) 与 [四阶段实现重构](../next-execution/surface-sample-driven-shading-rebuild-2026.md)。本文保留调查、比较和决策经过；具体实现边界与顺序以最终文档为准，不再从下文的历史排序另起一条实施路线。

## 问题与建议

目标是在唯一 WebGPU production renderer 中减少 Surface 的重复几何解码、材质采样和光照求值，同时保留现代 PBR、运动与遮挡边界的正确性。当前先做设计，不切换 currentSlice，不恢复 retired renderer。

当前建议（2026-09-30 用户明确接受删除重构后更新）：**直接以材质与光照联合分频为主线，解除重着色与屏幕像素的一一绑定；A/B 小优化后移。** 原先“先缩短 full-rate 热路径”的实施顺序被本文下一节替代，后文保留各方案的技术分析与早先估计。不能把全屏 dispatch 改成等量像素队列就称为 sparse shading。

## 性能瓶颈优先：激进重构后的排序（当前建议）

用户允许删除实现、重构 owner 和调整架构，希望先解决主瓶颈。以下是对当前引擎的**实施优先级判断**，不是实测速度排名，也不是以工程量最小排序。重构授权不自动等于允许任意画质损失：目标仍是现代 PBR；使用近似降频须明确误差预算，而不是声称逐像素等价。此次仍是设计评估，没有改生产代码或 currentSlice。

### 首选与排序

| 顺序 | 方案 | 能触及的主成本与选择理由 | 工程量与边界 |
| --- | --- | --- | --- |
| 1 | **F+：表面连续性感知的材质 + 光照分频，压紧代表样本** | 同时减少允许区域的 VG/属性恢复、纹理采样、BSDF/光照求值次数；直接改每像素重算模型。跨 primitive 连续表面是 VG 场景的核心范围，不是最后再补的装饰 | 约 35–65 人日：熟悉项目的资深工程师，首个 rigid opaque Standard PBR 完整闭环、必要 Product/publication 改造、full-rate 退路及模块检查；高不确定性。比原 F 的 25–50 扩大了跨 primitive 与质量重建范围；不含全部动态表示和最终平台矩阵 |
| 2 | **H：对象/纹理空间的局部材质或 irradiance cache** | 在同一表面跨帧重复计算占主导时，可进一步把重算量关联到新需求/失效样本；长期条件性上限很高。排第二因缺少当前 VG 的稳定参数化、LOD/接缝与失效闭环，尚不能把缓存命中当成既有事实 | 沿用 50–100+ 人日，仅选定静态资产/信号 profile，完整动态 AAA 范围更大；低置信度 |
| 3 | **E：仅光照分频** | 若剩余主成本集中在 lighting，可直接节省；但仍支付全率几何/材质。作为 F+ 中的信号执行方式或条件性退路，不再默认花一个独立项目先做完 | 原独立范围 12–25 人日；与 F+ 的基础重叠，不相加 |
| 4 | **C：按可见 primitive / 局部块共享几何 setup** | 改变几何不变量的重复恢复；大三角形近景可有价值，但纹理和照明仍每像素执行，微三角形下重复少 | 原局部 workgroup 范围 7–15 人日；全局 cache/新 Product 格式另计。主线需要的上下文共享随 F+ 做，不先做独立全面优化 |
| 5 | **G：DACS 多轮方差 refinement** | 理论也能减少很多着色样本；多轮调度、读写及漏采细节使净收益更不确定。保留研究对照，不与 F+ 同时建设第二套生产管线 | 20–40 人日仅原型/profile 范围，不能当成熟全材质交付估计 |
| 6 | **D：exception tile/mask 与容量重构** | 解决 overflow 时的长尾；不直接减少普通热材质的重着色。若受控数据证明 overflow 才是主耗时，应立即前移 | 原独立范围 5–12 人日；若 F+ 已替换旧调度，所需容量/唯一写者设计包含在主线 |
| 7 | **A/B：原子、barrier、VG/UV 局部复用、IBL 过滤等** | 缩短每次求值或固定成本；有用，但不以它们作为进入主瓶颈改造的前置阶段 | 沿用 A 4–8、B 3–7 人日；暂缓，仅随主线做必要的确定性清理 |

这里的第二名不表示 H 在所有场景都比 E/F 快：高命中、稳定表面时 H 有跨帧优势，冷启动、移动灯、动画和频繁 LOD/驻留变更时可能失效。也不能从“小三角形多”直接判定全面缓存一定更快。需要的不是一个与 workload 无关的虚假总排名，而是先把最可能覆盖当前整条重路径的 F+ 做实。

### 新核对：DOOM 原始演讲对本地选择的约束

本轮下载并提取核对 GPC 2025《Variable-Rate Compute Shaders in DOOM: The Dark Ages》71 页原始幻灯片；核对文字、调度说明和嵌入代码的可提取文本，没有运行其 shader，也不声称取得完整开源 donor。PDF 来自大会静态站点 `public/2025/talks/variable-rate-compute-shaders-in-doom-the-dark-ages/Fuller-Hammer-variable-rate-compute-shaders-in-doom-the-dark-ages.pdf`，SHA256 `e5fe7cf223006bf95089eb2890c878a47aecccd612eb9e5398c1fe43273d0fad`；本地留存 `.tmp/surface-shading-oss-study/doom-vrcs-gpc2025.pdf`。

- **第 14、23–25 页**：代表像素和重复像素混在一个 wave 会损失收益；deferred texturing 使用 compact primary-pixel commands，lighting 的 tile 组织还要考虑 cluster light 的统一读取。不能机械要求所有阶段采用同一种全局排序。
- **第 25 页**：把 texturing、lighting、GBuffer update 合成一个 shader 的尝试遇到 VGPR/长程序困难，未完成。故本地设计只要求逻辑分频，不预先锁死成一个超长 kernel，也不预先强制拆成大 GBuffer。
- **第 27–38 页**：代表位置偏移、去块和随机噪声会影响实际画质；2×2 不能简单复制颜色就宣布完成。第 35 页描述的同 UAV 原地去块存在 race，本地不复制这种做法；需要无数据竞争的邻域读写或独立输出。
- **第 42、51–52 页**：三角形边缘增加 full-rate 工作，小三角形/低内部分辨率/foliage 会削弱收益；不能套用报道中的 1–2 ms 或 pass 百分比。
- **第 55–58 页**：提出用 surfaceID 而非 TriangleID 来减少内部边界过度着色，尤其针对细网格与低分辨率；这是演讲的 future potential，不能说 DOOM 已量产完成此改进。EEngine 的跨 primitive continuity 属于具名本地 F+ 设计。
- **第 62 页**：反射对 normal 变化敏感，提出必要时逐像素输出 normal、其他部分可降频。因此未来 SSSR/GI 的消费者会改变能省下的成本；全率 normal 不是“免费附件”。

### F+ 如何真正击中当前代码

当前 PBR 在 `surface_material_kernel.ts::sparse_evaluate_geometry` 内逐样本恢复三角形属性/梯度并采样纹理，`surface_execution.ts` 的 dense 入口直接调用重求值；当前 planner 只接受受限 Unlit。需要替换的是这个执行模型，而不是仅调 workgroup 大小。

```text
VisibilityKey / depth / coverage（保持内部全分辨率）
  + Product 表面连续性、材质/纹理变化信息
          ↓
轻量当前帧分析 + 全率 motion/identity
          ↓
少量 profile/family 下的 full / 2×1 / 1×2 / 2×2 代表样本
          ↓
按需要压紧的材质与照明 worker（两者可用不同率）
          ↓
身份/深度/信号边界约束的重建 + 高频信号合成
          ↓
HDR → 现有 Temporal / FSR3
```

1. **把 motion 与重 PBR 解开。** rigid opaque 可研究由 depth 重建 current world、再用实例 previous-from-current 映射计算 motion；当前 `temporal_facts.ts::previous_clip_for_surface` 已有相关数学入口。不能为了每像素 motion 又完整恢复三顶点/纹理。它仍有逐像素变换成本，变形表示需自己的 previous mapping，不能伪造零 motion。
2. **第一版必须触及普通纹理 PBR 的材质求值次数。** 只让常量 Unlit、或只让便宜漫反射变 coarse，不构成此任务完成。先选明确支持的 opaque Standard PBR 区域，Coated/高频细节保留同架构 full-rate 分支。
3. **跨三角形 continuity 纳入核心。** 将几何 winner identity 与可共享 shading 的 surface/chart identity 区分；后者至少考虑 instance、材料、UV/属性接缝、法线/切线取向和 representation/generation。同 material、深度接近、同 surfaceID 都不能单独证明整个 BRDF 低频。Product/Cooker 保留或传播连续性，LOD 边界不能随意借用；这不要求第一版就建立跨帧稳定 cache 参数化。
4. **分类必须便宜，且承认近似边界。** 使用 publication 常量/变化范围、当前 depth/覆盖及可用低成本信息；历史对比度只能提示风险，不能证明新出现的细发光线不存在。不先算满四个完整 PBR 再决定省三个。无法廉价认证且未经质量策略允许的区域走 full-rate；因此最终可降频比例是未知量。
5. **压紧与空间局部性同时考虑。** 保持少量 family/profile，材质任务可以压紧代表样本，lighting 尽可能保 tile/cluster 局部性；full-rate 连续区域直接执行，避免全员像素记录。新体系内保留有界容量、互斥写域与 GPU 同帧完整退路。全率 kernel 是新架构必要执行分支，不是保留旧 renderer 桥梁。
6. **重建不是全图模糊。** 处理代表位置/footprint、真实轮廓、薄几何、法线/粗糙度/发光与 sharp specular；按需要让高频信号全率求值。新去块/插值必须无数据竞争；如全率字段占比过大，则承认可削减份额下降，不另加隐性全率 PBR 补算。

### 删除边界与先后顺序

- 替换 `shading_frequency.ts` 的“相机完全静止 + 相同 key + Unlit”作为唯一粗频机制；保留其适用条件下的常量快速处理价值，不能直接删判据放行全部 PBR。
- 重写 `SurfaceMaterialPass` 的工作生成/重样本执行，删除被替代的 dense 热着色 + 后置七 lane producer 耦合；全率与 coarse 用同一代 Product、材质和 radiometry 合同。
- 拆出全率 motion/identity 权威；`FrameProgramLowering` 只接线，shading 持有算法，geometry/materials-textures 发布连续性和变化信息。不得添加本帧 GPU→CPU→GPU 调度或独立 submit。
- 首个完整模块就交付 F+：基础计数/必要 publication → 普通 PBR 重样本减少 → packed worker 与重建 → 边界/容量/生命周期闭环。A/B 独立优化不排在它前面，E 是模块中的信号选择，不另设必须先完成的阶段。
- F+ 成立后，若重复材质/间接项仍主导，再选择 H 的一类缓存；不要同时铺 atlas、完整辐射缓存和多轮 DACS。

### 性能目标与判断标准

以均匀成本的纯算例说明收益对象：若 80% 像素的某条重路径可用 2×2，20% 需全率，其独立重样本量是 `0.8/4 + 0.2 = 0.4P`，即该部分少算 60%。这不是 Surface 总时间减少 60%，也不是 EEngine 场景覆盖预测。light/material 用不同率时分别计数，不能只看一个 coarse 像素百分比。

完整成本写成 `P×轻量事实/分类 + S_M×重几何/材质 + S_L×照明 + 重建/写回`；必要的 full-rate 属性与重复读取必须计入。目标是降低重计算随覆盖增长的系数；最终全分辨率事实与输出仍为 O(P)，不能宣称整个渲染复杂度脱离像素数。

少量开发计数记录：有效 PBR 像素、实际重材质/光照样本、按三角形与按表面 continuity 的拒绝比例、full-rate 原因、overflow 和分析/重建成本。先解决链路，不以完整平台 benchmark 作为每批编码门禁；最终评价包含新增所有 pass 与帧时。若 representative 场景中 r 很低，先定位微三角形接缝、材质频率或误差策略，不让 A/B 小优化掩盖主线未成立。

单独降低内部分辨率 + upscaler 是另一种有明确画质代价的策略，不能由“允许架构重构”自动推出用户接受。现有 FSR3 下还需考虑低内部分辨率压低重复样本比例，不能把与 VRCS 的收益相加。

## 已核实的当前事实

1. `OEngine/src/render/surface/SurfaceMaterialPass.ts:165` 无条件注册 spatial frequency planner；`:289` 的 Dense dispatch 为内部宽高各除以 8 向上取整。`:326`、`:332` 分别创建全内部尺寸 rgba16float HDR 和 rg16float motion。
2. `OEngine/src/shaders/shading_frequency.ts:25` 要求当前/前帧 VP 完全一致；`:41` 只接受 set 0、family 0、opaque、静态实例及常量 Unlit 或发布证明均匀的 UnlitTexture；`:63` 还要求块内相同 VisibilityKey 和深度差不超过 1e-5。Standard PBR 和 Coated 不享有此降频。普通纹理不满足；1×1 源纹理经发布证明的均匀纹理是例外。
3. `OEngine/src/shaders/surface_execution.ts:185` 每组 64 threads 在重求值前后经过三次 workgroupBarrier；`:213` 七个 lane 都执行全局 atomicAdd，未以 count > 0 排除空预约。activeExceptionLanes 缩减 host dispatch 不等于删除 Dense 中这段 producer。
4. `OEngine/src/render/surface/SurfaceExecutionAbi.ts:20` 每 lane 容量最多 ceil(width×height/7)，设备限制还可进一步缩小。单 lane 超过容量时，`surface_execution.ts:33` 的 finalize 取消它的 binned dispatch 并启用整屏条件 fallback；这是正确性退路，也可能形成性能突变。
5. `OEngine/src/shaders/surface_material_kernel.ts:57` 的三个 virtual triangle corner 查询和 `:72` 的三个 vertex-ref 查询分别遍历 Product metadata/page/header。`:670`、`:671` 对每个 PBR sample 解码三顶点、变换、投影和计算透视重心/梯度。它们是源码层重复，实际设备访存与编译器 CSE 收益尚未测量。
6. 同文件 `:614` 每纹理 role 重新恢复三份 UV 并插值；`:678`–`:684` 包括独立 ORM/AO/specular 采样。应在完整采样语义相同后共享，不能只比较图片 ID。`:564` 的 TBN 构造在 generic 路径中需要审查无 normal/coat-normal 输入时的可裁剪性。
7. `OEngine/src/shaders/environment_ibl.ts:69` 的八面体双线性为四次 textureLoad，`:91` 对相邻两 mip 调用它，所以每次环境镜面查询有八次源码 textureLoad；Coated 可再查询一组。硬件事务数和实际代价不是该源码计数。
8. `SurfaceMaterialPass` 的输入和 bindings 中没有 LargeTriangleSetup；现存 builder 使用普通 Geometry/Meshlet ABI，不能因文件名或 FrameProducts 注释就认为 VG/PBR 已消费缓存。
9. `OEngine/src/shaders/temporal_facts.ts:125` 已有 instance/geometry/material/dynamic revision 的 identity；不能把当前引擎描述成完全没有 temporal facts。但它尚不等于跨 VG LOD 稳定的 shading-sample cache identity。

## 证据边界

2026-09-25 报告 `docs/performance/2026-09-25-rendering-lab-basic-gpu-analysis.md` 属于旧 revision 89f0a94、GTX 1650 Ti 的交互式诊断。它支持调查 per-visible-pixel 材质/IBL，但其中 2.56/3.41/5.83 ms 不是当前 Surface 的分项耗时，更不能把差值直接相加为算子成本。报告也记录了温控降频。

本轮是源码/设计/外部来源核查，未运行 browser、GPU benchmark、typecheck 或 build。后续节记录来源、方案、成本条件与实施顺序。

本轮本地基线为 `f4c2127a`；写入本文前工作树仅报告既有 `.tmp/` 未跟踪目录。没有修改 production TS/WGSL、正式采用状态或活跃 workstream。本文行号用于本次核对，符号名为长期导航。

## 成本模型：到底减少什么

令 A 为内部总像素，P 为有效可见像素，G/M/D/I 分别为每 sample 的几何恢复、材质、直接光与间接/环境求值成本。当前近似为：

`T = Tplan + A × Cclassify + P × (G + M + D + I) + Texception + Twrite`。

对于 PBR，当前 coarse eligibility 为零。仅把 P 个像素换成 P 个 queue record，仍支付 P 份 G/M/D/I，还增加分类、写读与调度；只有节省的发散/无效线程等成本超过新增成本才获益。相反，把允许共享的部分改成 S 个独立 samples，S < P，才直接改变重求值数量。输出和 coverage 仍可以是全分辨率。

静态预算示例（不是 benchmark）：4K 的 8×8 groups 为 129,600，当前源码七 lane 全局预约为 907,200 次 atomicAdd 调用，即使 count 为零。单像素记录 8 B，在设备限制不收紧时异常池约 63.3 MiB；rgba16float HDR + rg16float motion 单次全帧写约 94.9 MiB，未计 clear/后续读取/压缩。不要用这些数直接推导 GPU ms。

若可见 PBR 中 60% 合法使用 2×2、40% full-rate，相关重 sample 数为 `0.6P/4 + 0.4P = 0.55P`。这只说明重样本数减少 45%；分类、边界、motion、重建、带宽以及 occupancy 决定净帧时，不能称整帧快 45%。

## 来源核对与适用边界

先核对 GitHub 源码，再对照作者论文和第一方技术说明。固定 SHA 是此次调查版本，不自动替换已有 ledger 的 pin。更完整的阶段映射见 `docs/porting/next-renderer.md` 本日 Surface 调查补充。

| 来源 | 实际核对范围 | 对 EEngine 的价值与边界 |
| --- | --- | --- |
| The Forge，Apache-2.0，`cd5046893faba2dc7869243873bf01f02a6f0df9` | `Common_3/Renderer/VisibilityBuffer2/Shaders/FSL/VisibilityBufferShadingUtilities.h.fsl`，CalcFullBary / Interpolate2DWithDeriv | 保持透视梯度、LOD 数学；它本身不减少每像素材质求值。现有 R02 已有映射，不能再包装成新的解决方案。 |
| Wicked Engine，MIT，`df44c3db4c4927492bc9c791eac715d98d7ed091` | `visibility_resolveCS.hlsl`、`visibility_shadeCS.hlsl` | tile/profile 分桶、uniform primitive 对照；shade 仍逐 pixel load Surface 与 lighting。改善调度，不自动让 PBR sample 数低于可见像素数。 |
| Intel DeferredCoarsePixelShading，Apache-2.0，`63ad5c1adafbfcc2869a200f50a5ea11f28b4887` | `ComputeShaderTile.hlsl` 的四 sample GBuffer 读取、RequiresPerPixelShading、coarse/full 消费、共享补做队列和写回 | 可复核的 2×2 光照降频闭环，但材质/GBuffer 已全率支付。单移植判据不能解决 EEngine 前半段几何/材质成本。 |
| DACS，Mallett/Yuksel，HPG 2018 | 作者项目页的层次采样/方差/warp coherence；另核对下列独立实现 | 研究上支持低于一 shading/pixel；低方差不证明未采区域没有细高光/薄线，不能当精确条件。 |
| WeakKnight/DeferredAdaptiveComputeShading，`da514fe9f6b1a2c5a732b0b9f2e20c25227960e3` | 完整 `AdaptiveLightingPass.slang` pass0–4、shouldShade、DistributeWork；`EntryPoint.py` 调度、`Shading.slang` | 多阶段 coarse-to-fine 与 wave 内任务重分配很贴题；该树未见明确许可证，固定 WAVE_SIZE=32，shade 示例读取已存在 GBuffer、简化照明并做 sqrt 色变换。它不是 EEngine 完整 PBR donor，不能直接复制、不能把其固定方差阈值搬到 pre-exposed HDR。 |
| DOOM: The Dark Ages VRCS，Hammer/Fuller，GPC 2025 演讲；Microsoft 2026-04-09 第一方文章 | compute deferred texturing/lighting 采用软件可变率；后续追加核对 71 页原始幻灯片的 scheduling、quality、limitations 和 future potential，详见前文 | 与当前问题最贴近的生产方向；没有取得完整开源 donor，也没有运行其 shader，不能宣称完整 port。surfaceID 属演讲未来提议；其他游戏收益不作为 EEngine 预测。 |
| Real-time Seamless Object Space Shading，EG 2024，Apache-2.0，`473a59bbcdd30e3366cc567d66a5a97353620d48` | README/许可；`ObjectSpaceShadingPipeline.cs` 和 `RenderTaskProcessing.compute` 的 shadel 分配/任务/indirect；未完成全仓 host+GI 审计 | 作者完整研究工程入口可用；需要 atlas/halfedge 参数化、需求/缓存/LOD/失效。工程要求 Unity、RT GPU，不能整套视为 WebGPU 可移植。值得作长期局部材质/漫反射缓存参考。 |
| FastAtlas，EG 2025 | 作者项目页、实时 chart/parameterization/packing 说明和 shader supplement 入口 | atlas 紧凑性与接缝方案参考；本次未审 shader supplement 许可证和完整 consumer，不能登记完整 donor。 |

已核对的主来源：

- [The Forge 固定文件](https://github.com/ConfettiFX/The-Forge/blob/cd5046893faba2dc7869243873bf01f02a6f0df9/Common_3/Renderer/VisibilityBuffer2/Shaders/FSL/VisibilityBufferShadingUtilities.h.fsl)
- [Wicked resolve](https://github.com/turanszkij/WickedEngine/blob/df44c3db4c4927492bc9c791eac715d98d7ed091/WickedEngine/shaders/visibility_resolveCS.hlsl)、[shade](https://github.com/turanszkij/WickedEngine/blob/df44c3db4c4927492bc9c791eac715d98d7ed091/WickedEngine/shaders/visibility_shadeCS.hlsl)
- [Intel CPS](https://github.com/GameTechDev/DeferredCoarsePixelShading/blob/63ad5c1adafbfcc2869a200f50a5ea11f28b4887/ComputeShaderTile.hlsl)
- [DACS 作者页](https://graphics.geometrian.com/research/dacs.html)、[论文](https://www.cemyuksel.com/research/papers/DACS_HPG2018.pdf)、[独立实现固定 shader](https://github.com/WeakKnight/DeferredAdaptiveComputeShading/blob/da514fe9f6b1a2c5a732b0b9f2e20c25227960e3/AdaptiveLightingPass.slang)
- [Microsoft VRCS 第一方说明及内嵌演讲](https://developer.microsoft.com/en-us/games/articles/2026/04/variable-rate-compute-shaders-doom-the-dark-ages/)
- [对象空间论文工程](https://github.com/WeakKnight/real-time-seamless-object-space-shading/tree/473a59bbcdd30e3366cc567d66a5a97353620d48)、[FastAtlas 作者页](https://www.cs.ubc.ca/labs/imager/tr/2025/fastatlas/)
- [WGSL 2026-09-21 草案](https://www.w3.org/TR/2026/CRD-WGSL-20260921/)：subgroups、uniformity、textureSampleLevel/Grad。草案出现某能力不证明当前浏览器/设备已启用；本设计 core 路线不依赖固定 wave32 或 native bindless。

论文阅读范围：DACS 已核对作者摘要、方法说明和独立实现，不声称已通读论文 PDF。FastAtlas 此轮核对作者页和补充入口，未下载约 200 MB 论文或审计完整 supplement。VRCS 追加核对原始演讲幻灯片提取文本，未审计或运行完整原始 shader，具体页码和边界见前文。

一个影响取舍的重要反例：DACS 作者在 [HPG 2020 后续项目说明](https://graphics.geometrian.com/research/dacs_in_hw.html) 指出，2018 年之后 GPU driver 的改变曾使原样软件实现不再具有性能净收益，因此研究硬件 scatter tiles。这不证明今日所有 DACS 变体都慢，但足以否定“论文 sample 数变少就一定更快”的推论。本地必须评价 scheduling、inter-pass traffic 和重建的合计成本。

## A/B/C 技术候选：缩短 full-rate 热路径（当前后移）

### 1. 删除无收益固定成本

- 以 publication 能证明的 `hasEligibleSpatialMaterial` 决定是否需要 frequency planner；所有可能出现的材质都不满足 coarse 条件时使用恒 full-rate shader，仍保留合法 Unlit 候选。不能因为相机每帧移动/静止而反复变换 Graph topology。对动态风险在固定拓扑内处理。
- publication 证明没有 exception 时编译无 producer 的热 specialization，删除七 lane 初始化/预约/finalize 与 shader 中相关 barriers；有 exception 时先排除 `count == 0` 的全局预约。
- 进一步比较将异常分类/压紧放在重 shading 前，使等待不横跨昂贵 PBR。只有确认 uniformity 和写域不变量后调整 barriers；不能在部分线程提前 return 后让剩余线程碰 workgroupBarrier。
- pipeline/layout 本身已有缓存，不把问题误诊成每帧编译全部 shader。当前 bind groups 和 lane 参数存在帧内重复创建，后续用实际资源身份/epoch 的缓存处理，但不把 CPU 优化冒称 GPU 重求值减量。

### 2. 几何恢复先复用上下文，再考虑共享 setup

- 每个 hit 只解析一次 VG asset/group/page/meshlet/format context，一次读取该 primitive 的三个局部索引，生成三份 vertex ref。保持所有 generation、缺页、越界与非法值处理；不是删除检查来换快。
- 同一个 sample 内，每个实际使用的 UV set 只解码和插值一次；role 自己应用线性梯度变换/offset/sampler。材质 route 仍按角色验证。
- 第二阶段以可见同 primitive 的空间块复用三顶点和投影 setup；只复用几何不变量，位置、透视权重、法线与纹理 footprint 继续按 sample 求值。近裁剪/退化回到相同主链的直接重建。
- 优先 workgroup 内有界复用，避免全局无界 hash/spin。全屏 microtriangle 情况没有足够重复，强行共享会更慢。只有 `重复像素省下的恢复成本 > 查表+shared memory+barrier成本` 才使用。
- 不直接打开旧 LargeTriangleSetup 开关：当前它不支持完整 VG Product 恢复，且 Surface 没有消费绑定。若选择跨组 setup，重新核对 owner/ABI/生产 consumer 与容量，不能只加一个无人读取的 buffer。

### 3. 材质公共采样与输入需求

编译/发布时对 `ref + generation + UV set + UV transform + sampler + gradient/LOD policy + color decode` 建采样等价关系。例如 ORM 和 AO 完全相同时共享一次 fetch；不同 sampler/transform/色域时保持独立。常量参数和未使用 normal/coat-normal 不产生无效 TBN/纹理工作。限制在少量成本 family，避免每个材质/flag 组合一份 PSO。

### 4. IBL 优先优化过滤实现，而不是删除 IBL

当前 filtered sky 为 128×128、8 mip，roughness→LOD 与 producer 的反函数对应（`PhysicalSkyIblResources.ts`）。粗糙度为 1 时落在 1×1 最后一级；源码仍评估上下两个 bilinear，upper==lower。这提供合法的单 mip/终端 texel 快路径，不能推出任意高 roughness 都是常量。

建议先比较保持现有 octahedral representation 的 interior hardware filtering：当两个 mip 的双线性 footprint 均不越边时用硬件过滤；边界继续用现有 oct-wrap，或逐 mip interior/edge 分支。没有正确 gutter 时不能把 oct-wrap 直接换 clamp sampler，否则球面接缝改变。硬件过滤与手算可能有舍入差异，采用误差容限而非 bit-exact 声明。

若 producer/consumer 合计仍高，再考虑在环境 generation 更新时生成可硬件过滤的 cubemap。必须同时检查各 mip solid-angle、GGX convolution、粗糙度映射、面接缝、sun 动态更新频率与额外显存；不是仅把采样函数改名字。保留现有 BRDF、DFG、specular AO、coat 衰减和 radiometry。roughness 高或 metallic=0 都不等于 specular 为零。

## 推荐方案二：GPU 驱动的分频 Compute Surface

这是改变性能上限的主方向，暂名 **EEngine Signal-Rate Surface**，属于具名本地设计。引用 CPS/DACS/VRCS 的思想不代表其中任一完整算法已移植。它与整体架构 §3 的分频/按需字段方向一致，但把执行条件与拒绝规则具体化。

```text
VisibilityKey + Depth + Material/Geometry publication
    ↓
轻量 Surface Analysis + 精确逐像素 motion / identity
    ├─ full-rate / mixed tile descriptors
    ├─ 2×2 合法 material samples
    └─ 单独的低频 lighting samples
    ↓ GPU counters / bounded lists / indirect
按 profile × 少量 family × signal rate 执行重计算
    ↓
身份/边缘约束的 reconstruction + 全分辨率 composition
    ↓
现有 Temporal / FSR3 / Present
```

### 频率合同

| 信号 | 第一版选择 | 能降频的必要条件 |
| --- | --- | --- |
| visibility/depth/coverage | full-rate | 不合并轮廓、alpha coverage 或不同赢家 |
| motion / temporal identity | full-rate | motion 单独算，不复制代表点；使用当前与上一帧正确 jitter 约定 |
| 几何 setup / Product header | 尽量按同 primitive/局部块共享 | 相同实例、primitive、representation 和 generation；只共享不随像素变化的部分 |
| base/normal/ORM 等材质 | 默认 full；证明允许后 2×2 | UV/顶点色/normal map/roughness/贴图 footprint 与空间变化风险受控；材质相同不代表样本相同 |
| direct specular / clearcoat / 阴影边缘 | 第一版 full-rate | 后续专门建立方向、BRDF lobe、normal 与 visibility 误差界才放宽 |
| 平滑间接漫反射/粗糙环境项 | 优先研究 2×2 | 连续表面/法线、光场、遮蔽、DFG/AO/roughness 的变化风险；最终按像素调制高频 albedo/AO |
| 4×4 | 保留现有可证明常量 Unlit | 第一版不广泛开放给未知 PBR；扩展需单独品质证据 |

不能用 `roughness > 阈值` 一个条件决定整块 PBR。相同三角形可以有棋盘纹理、尖锐 normal、细发光线；不同三角形也可能属于连续平面。同 key 是几何恢复共享的强条件，但在 microtriangle 工作负载里会让粗频命中率接近零。跨 primitive 放宽只能建立在可靠 continuity/参数化信息上，不能只认相同 material。

材质变化的证据优先由发布/资产阶段生成：常量证明、UV/属性连续性、每 mip 的 conservative min/max 或方差信息、normal cone/roughness range。不是拿普通颜色 mipmap 当“高频不存在”的证明。没有证据就 full-rate；classifier 不能为决定是否省一次重求值而先把四个完整 PBR 全算出来。

当前/历史颜色的 contrast、motion 和 DACS 方差可提供优先级或保守拒绝信号，但不能单独认证当前帧安全：新出现的细线、运动灯、阴影边界和 disocclusion 可能没被上一帧样本覆盖。若引入误差容限下的近似，必须明确为画质预算，并纳入时域闪烁评价。

### Wave 利用率与物理执行

“仅保留 (x%2==0 && y%2==0) 的线程”仍可能让每个 wave 带着少量活跃 lane 跑完整巨型 shader。应把合法代表 sample 连续装入 worker，或让一个 workgroup 统一处理同 rate 区域；预先完成需要全组参与的分类/屏障，再让无需执行的整组退出。不要把不相容的剩余 barrier 留在 coarse worker 后面。

核心能力路线使用 workgroup memory 和有界 prefix/compact；subgroups 为协商后的可选特化，不能抄固定 wave32 和 32-bit ballot 假设。全率热块继续直接密集执行，只有任务稀疏/分频/昂贵例外才写工作描述；不是恢复旧 64-class 全员逐像素 scatter。tile 的 shape 初始可用 8×8，但最终取决于局部 primitive 数、shared memory、registers 和 GPU 测量。

物理 kernel 可以保持 material+部分 lighting 融合，只在需要跨 sample 重建/SSR/GI 共享的字段上物化紧凑数据。不要为逻辑分离先写一个全屏巨型 GBuffer。每新增 16 B/pixel 的写+读，4K 约增加 253.1 MiB/frame 的名义流量；实际压缩/cache 另测。

### Motion 与历史

现在 frequency planner 比较的是含 jitter 的 GPU VP：`RendererCore.ts:1382` 设置 jitter，`GPUCameraState.update` 将 viewport offset 写进 projection，Surface 上传该矩阵。因此默认非零变化 jitter 即使相机静止也可关闭当前粗频。不能简单删除 static 判断，因为现在 coarse store 同时复制 motion。

将 motion 作为独立 full-rate 几何事实；对当前刚体 opaque 模型，可用 depth→world + instance previous-from-current + previous VP 计算，复用已有 temporal 数学和单位定义。skin/morph/非刚体需其真实 previous geometry，不冒称此公式通用。Surface 与 Temporal owner 只保留一个 motion 权威，并相应调整 lowering 的依赖顺序。第一版分频不依赖跨帧 radiance reuse。

现有 temporal geometry signature 包含 meshlet_slot、primitive 和 packed_profile_lod，它能保守拒绝 LOD 变化，但不是稳定物体表面参数化。未来 radiance cache 还要有 signal-specific invalidation：灯、shadow page、环境 generation、AO/GI 状态、纹理 residency、视角变化、曝光比值、resize/cut/device epoch。FSR3 接收到全分辨率图片不代表粗频误差被自动修复。

### 异常工作容量与溢出

第一版先把不均衡的七等分容量问题显式化并计数。随后优先评估 tile descriptor + pixel mask：每 lane 每 tile 最多一个 record，满屏相同冷材质只是 T 个 tile，不是 P 个像素。当 T=ceil(W/8)×ceil(H/8)、每 record 假设 16 B（tile、64-bit mask、rate/tag）时，七 lane 最坏 4K 约 13.84 MiB；这是布局估算，不是冻结 ABI。还应计入热 lane、计数和间接参数。

相同像素只属于一条 family/profile lane；同 tile 可以因混合材质进入多条 lane，consumer 仅消费自己的 mask。多个 profile 同 tile 的重复启动可能比像素 compact 更差，必须用 dense/sparse 分布比较。备选为共享 chunk pool，但不能引入无限预约、自旋等待或不完整帧。

容量在资源创建前按设备限制协商；overflow 必须 GPU 取消该失败队列的所有局部写出并启用同信号的 full-rate 处理，确保唯一写者、同帧完整。没有当前帧 GPU→CPU→GPU 回路，没有独立 submit。默认足够容量时不要把典型冷材质覆盖率误判为异常 fallback。

## 暂不优先的方向

| 方向 | 此时不优先的原因 | 何时重新评估 |
| --- | --- | --- |
| 全部像素 material sorting / binned | 不减少 sample 数，还付 queue 带宽；容易恢复已删除的全员队列 | 异构材质发散/纹理 profile 数据证明确为主导时 |
| 全局 2×2/4×4 复制完整 PBR | 破坏高光、normal map、阴影、motion；没有高质量前提 | 只对已证明常量或满足明确误差预算的信号 |
| 先改传统全屏 GBuffer | 几何重建/材质成本可能仍在，并增加显著带宽 | 多个真实 consumer 的字段复用超过物化成本时 |
| 首先全面对象空间/texture-space cache | VG simplification 改变 primitive/UV/切线，尚缺稳定 chart 映射；缓存失效/分配/filter 都是新成本 | 先针对稳定静态资产的 view-independent 材质或低频 irradiance 建闭环 |
| ReSTIR DI/GI 直接替换 Surface | 可减少昂贵光采样，但不是材质/VG 恢复替代品；当前灯数与成本未证明需要 | many-light/trace 确成为主导，并有完整 visibility/history donor 时 |
| 首先 VT | 容量与流送不等于减少 resident 材质求值；页表还增加间接访问 | 纹理驻留规模/带宽成为已测瓶颈时 |
| 单改 workgroup 大小、f16、async compute | 可有收益，但不改变重 sample 数；precision/调度需单独证据 | 主链明确后按 shader profile 微调 |

## 早先保守实施顺序（已被前文 F+ 主线替代）

所有权和改动面：

| Owner | 具体入口 | 应承担的改动 |
| --- | --- | --- |
| shading | SurfaceMaterialPass / surface_execution / surface_material_kernel / shading_frequency | 分析、少量 execution/rate family、融合求值、按需 fields 与重建；拥有工作容量和唯一写域 |
| geometry / virtual-assets | Product metadata 和恢复 helper | 已发布几何 context 与可复用 setup 的身份/代际；不让 shading 自建第二套几何权威 |
| materials-textures | GpuMaterialStore、canonical closure、TextureResidency | 发布采样等价/常量/变化风险；Loader 不持有长期 GPU cache |
| environment / shading | PhysicalSkyIblResources、physical_sky_ibl、environment_ibl | 成对修改环境 producer/filter/storage/consumer 与 generation |
| frame-runtime / temporal | FrameProgram、FrameProgramLowering、temporal_facts | 需求闭包、真实 producer→consumer 边、单一 motion 权威及 history invalidation |
| platform | SurfaceKernelBindingPlan、capability negotiation | 资源/绑定/dispatch/工作组容量、subgroups 可选路径；仍只有一个 frame submit owner |

稳定后再定义新的 ABI/contracts；本文中的 sample/tile 字节数只是设计预算，不预先制造正式 ABI。

1. **热路径成本收敛**：零 exception specialization、零预约、planner 静态裁剪；VG context/UV/采样复用；oct IBL interior/终端 mip。先保 full-rate 画质与现有能量合同。
2. **可观测性与几何复用**：增加或复用 GPU counters/debug views，记录 PBR full/coarse 数、lane attempted/written/overflow、primitive repetition、材质采样同源比例；评估局部 setup 的收益阈值。counter 延后读回只观测，不控制本帧。
3. **第一条真实分频信号闭环**：motion 单一生产者、全率 coverage；从平滑环境/间接项 2×2 开始，full-rate high-frequency composition；完整 GPU work→consumer→reconstruct→FSR3。不要先铺设所有未来 cache。
4. **材质降频与混合 tile**：有资产/发布风险证据后开放 2×2 材质样本；wave/workgroup packed 执行，统一 profile/family/rate lane 和 tile masks。保持 conservative full-rate 退路。
5. **长期缓存研究**：只在第 3/4 步确实受益且稳定 identity/LOD seam 有完整方案后，推进对象空间材质/irradiance cache。完整 specular radiance 依赖 view，不作为第一批跨帧长期缓存。

这是一条生产路径内的阶段演进。被替代的实现随 coherent module 切换删除，Git commit/独立诊断 harness 用于对照；不建立 permanent legacy/new A/B renderer。分析没有擅自把 currentSlice 从 VG correctness 改走。

## 早先方案横向比较与投入评估（2026-09-30，排序已由前文替代）

以下等级与人日是基于本次源码分析的工程判断，不是外部项目统计或实际排期承诺。性能比较对象是 Surface 及其新增依赖的合计 GPU 成本，不是整帧 FPS。小/中/大表示可触及的工作范围，不对应未经实测的百分比。

工程量假定一位熟悉当前 TS/WGSL、VG Product 和 FrameGraph 的资深渲染工程师，资产和 GPU 调试环境可用；包括所述边界的生产主链接入、关键失败分支与模块 targeted checks，不包括修完当前 VG 问题、全部未来 provider 或最终跨浏览器/跨硬件验收。概念验证可能更快，但不能把演示跑通视为该工作量已完成。复杂方案估计置信度较低，未决问题可明显推高上限。

| 方案 | 减少哪部分工作；性能潜力判断 | 工程量估计 | 新资源/维护成本 | 画质风险与最易失败的场景 | 我的当前选择 |
| --- | --- | --- | --- | --- | --- |
| A 热路径清理 + 单 sample 内 VG/UV/等价纹理复用 | 固定调度、重复 metadata/属性/采样；小到中，适用范围较广；不减少独立 PBR sample | 4–8 人日 | 不需长期 cache；新增少量 profile/采样等价信息 | 低：目标是保持求值语义；必须保留代际检查和完整 sampler/UV/色域条件；编译器已消除的重复不会再次带来收益 | 优先实施，性价比最高之一 |
| B IBL 采样快路径 | 同 mip/末级 texel 与 oct 内部硬件过滤；环境项重时潜力中，整体收益受 IBL 份额约束 | 3–7 人日 | 保持当前表示时资源增量小；不含新 cubemap producer | 低到中：oct seam、LOD、过滤舍入需要验证；八条 textureLoad 不是八倍性能或带宽 | 与 A 优先；源/consumer 成对核对 |
| C 同 primitive 局部 setup 共享 | 重复几何解码/变换/投影；大三角形近景可能中到大，microtriangle 下可能零或负 | 7–15 人日 | workgroup memory、barrier、寄存器/occupancy 压力；不含跨帧 cache | 低到中：不共享不同 sample 的透视权重/法线；近裁剪/退化/多 primitive 密集区域需要直接恢复分支 | 观察同 primitive 复用率后选择 |
| D exception tile + mask | 队列流量/原子及七等分容量导致的 fallback；主要保护异常场景耗时，热 profile 场景改善小 | 5–12 人日 | tile list/mask/indirect；mixed tile 会重复进入多个 lane | 低：样本仍全率；唯一写者、容量和空/满屏边界是关键 | overflow/cold coverage 触发频繁时前移 |
| E 仅部分光照信号 2×2 | 只减少允许共享的 lighting samples；中等潜力，几何与材质成本仍全付 | 12–25 人日 | 分类、紧凑中间信号、重建、独立 motion 依赖；需可视化/误差调参 | 中：高光、shadow/AO/normal 边界和运动场景；分类/中间写读可能吃掉便宜 lighting 的节省 | 首个分频闭环候选，先确认 lighting 确实够贵 |
| F 材质 + 光照分频 compute | 同时减少合法区域的几何/材质/光照重样本；高潜力，但细节多时有效粗频覆盖可能很低 | 25–50 人日（已包含 E 的通用基础，不与 E 相加） | publication 风险信息、sample scheduling、有限 kernel family、fallback/reconstruction | 中到高：细纹理/发光线/normal、高光、disocclusion；必须保 full-rate coverage/motion，并高效执行剩余样本 | 极致性能主线，分阶段完成 |
| G DACS 多轮由粗到细的颜色方差自适应 | 由已算颜色决定后续重算/插值；理论可少算很多，实际净收益不确定 | 20–40 人日，当前只是独立原型/profile 范围，不保证覆盖全部生产材质 | 多轮读写/同步、work distribution、方差阈值与曝光域管理 | 高：漏采细节和新亮点、多轮插值误差；软件调度成本对硬件/驱动敏感 | 研究对照，不选当前默认主线 |
| H 对象空间/纹理空间 cache | 利用空间及跨帧重用；静态、高成本、稳定参数化信号上潜力高，动态/缺页/失效多时可能更慢 | 50–100+ 人日，仅指选定静态 opaque 的材质或 irradiance cache profile；完整动态 AAA 范围更大且未估 | atlas/chart、需求/分配/eviction、过滤/gutter、history/LOD 映射；最大资源与维护成本 | 高：接缝、残影、LOD/纹理/光照失效；完整 view-dependent specular 不宜作为首批长期 cache | 长期局部路线，当前不全面押注 |

### 性能数字如何合理比较

无法从当前源码给 A–H 填上可信的实际加速百分比。用同一简化模型评估投入上限，避免把不同 workload 的论文数字拼在一起：

`Surface 新耗时 / 原耗时 ≈ 1 - f × r × (1 - 1/q) + o`。

- f：原 Surface 时间中，被所选方案真正降频的工作份额；不是材质数或代码行数。
- r：按成本加权、可以使用该粗率的比例；各像素成本近似相同时才可用像素覆盖率代替。
- q：每份重 sample 代表的像素数；2×2 为 4。
- o：新增分析、排队、重建、字段写读等时间相对原 Surface 的份额。该一阶模型假设其余成本不变，不描述复杂 cache、occupancy、GPU overlap 和 CPU 瓶颈。

纯假设示例，令 r=60%、q=4、o=8%：

| 假设可降频的原 Surface 时间份额 f | 模型 Surface 新/旧耗时 | 模型 Surface 耗时减少 |
| --- | --- | --- |
| 30% | 0.945 | 5.5% |
| 60% | 0.810 | 19.0% |
| 80% | 0.720 | 28.0% |

这些是敏感性算例，不是 EEngine 预测。E 和 F 的区别在于后者可能覆盖更多成本 f，但也可能提高 o、降低可安全合并的 r。因此不能保证 F 比 E 更快，更不能把 A/B/E/F 的百分比直接相加。若仍假设整帧 10 ms，其中 Surface 5 ms，并采用中间行，则新帧时 5+5×0.81=9.05 ms，帧时减少 9.5%，理想 GPU-bound FPS 约从 100 到 110.5；不是整帧改善 19%。

以 o=8%、f=60%、q=4 为假设，r 需大于约 17.8% 才跨过模型盈亏平衡点；f=30% 时阈值提高至约 35.6%。这解释为什么本地已变便宜的 sky/IBL 项不一定还值得独立分频。实际分项可受编译器/寄存器改变影响，不把 shader feature-off 差值当作严格可加的 f。

### 早先按工作负载选择（保留成本判断，顺序已替代）

| 目标场景 | 优先组合 | 为什么 |
| --- | --- | --- |
| 热 profile 占满屏、典型 PBR | A + B，再比较 E/F | 减少每像素都支付的成本；之后针对真正剩余的昂贵信号分频 |
| 大三角形/大平面近景 | A + B + 条件 C | 同 primitive 投影/setup 可能被许多像素反复使用；仍保材质细节 |
| 密集小三角形、复杂高频法线/纹理 | A + B；F 保守选择区域 | C 复用率低，强行 coarse 的品质风险高；保留 full-rate 执行效率 |
| 冷 profile 大面积出现或 fallback 频繁 | D + A | 先消除队列容量分配造成的性能突变；这改善稳定性，未减少所有材质求值 |
| 光照很贵、材质解析较便宜 | E，效果成立再 F | 第一条分频信号可直接触及主要成本 |
| 几何/材质占主要成本，lighting 优化后已便宜 | C（看复用率）或直接推进 F 所需基础 | E 只节省 lighting，无法解决主要矛盾 |
| 稳定静态世界、昂贵且可复用的材质/irradiance | F 之后选择性 H | 有条件摊销长期缓存，但不缓存未经失效治理的完整 PBR radiance |

### 证据与判断的区别

- [Microsoft 对 DOOM VRCS 的第一方报道](https://developer.microsoft.com/en-us/games/articles/2026/04/variable-rate-compute-shaders-doom-the-dark-ages/)报告原工作负载约 1–2 ms 节省、重 deferred passes 常见约 30% 降低；这支持 F 的方向，不能用于承诺 WebGPU/EEngine 的同等收益。
- [Intel CPS 固定 shader](https://github.com/GameTechDev/DeferredCoarsePixelShading/blob/63ad5c1adafbfcc2869a200f50a5ea11f28b4887/ComputeShaderTile.hlsl)先读 GBuffer 再选择光照粗率，说明 E 的节省边界。
- [Wicked 固定 shade shader](https://github.com/turanszkij/WickedEngine/blob/df44c3db4c4927492bc9c791eac715d98d7ed091/WickedEngine/shaders/visibility_shadeCS.hlsl)在 binned tile 内仍逐 pixel load Surface/lighting；全员分桶不等于减少 PBR samples。
- [DACS 作者 2018](https://graphics.geometrian.com/research/dacs.html)给出按方差层次 shading/插值，[2020 后续说明](https://graphics.geometrian.com/research/dacs_in_hw.html)记录驱动变化使原软件实现失去净收益；G 的风险有直接来源支持。
- [OSS 作者工程](https://github.com/WeakKnight/real-time-seamless-object-space-shading/tree/473a59bbcdd30e3366cc567d66a5a97353620d48)明确虚拟化 per-halfedge 参数化与 Unity/RT 依赖；H 的跨 LOD 与 WebGPU 适配是本地额外工作，而不是即插即用。

早先以工程性价比为先的组合为 **A+B → 有条件 C/D → F**；用户明确要求先解决主瓶颈后，该实施顺序作废，改为前文 **F+ 主线 → 条件性 H → 再做局部优化**。此表保留各方案的成本边界与历史估计，不能再引用为当前优先级。只做全员排序、巨型 GBuffer 或 VT 仍不作为解决此次 per-pixel 重计算的默认第一步。

## 最小验证与未决项

实施中按调试需要做单个 targeted 检查，大模块贯通后集中 typecheck/build/必要 tests；不把正式 browser matrix 或文档同步当逐批编码门禁。未跑的测试必须明确。

- 数学/采样 oracle：重心/梯度、UV transform、ORM/AO 等价与不等价、oct 边界/角/末级 mip、roughness→LOD、pre-exposure，保护实际语义。
- GPU 工作闭环：奇数尺寸/背景/边界、全热/单冷占满/混合 profile、恰好容量/超限、每像素唯一写入、合法 indirect 和 device epoch。
- 画质场景：细线/发光棋盘、高频法线、低 roughness/clearcoat、阴影边界、相机平移/旋转/jitter、遮挡揭露、LOD 切换。跨三角形/接缝必须专测，不靠一张静帧。
- 性能决定项：固定视角、分辨率、驱动、温度/时钟，记录分析+队列+重 shader+重建+整帧 P50/P95。样本减少但总帧时未降低不能叫优化。基线用固定 revision/harness，不留第二条生产 path。
- 当前尚无 GPU 证据判定 geometry/texture/ALU/register/atomic 的耗时占比；因此优先级是源码和成本模型支持的实施假设，不承诺倍数。

本轮没有实现上述方案，没有运行编译、GPU/浏览器或性能测试，也没有完整运行任何外部样例。已核实完整源文件与只定位到论文/工程入口的范围分别标注；外部收益只属于其原工作负载。
