---
id: performance/2026-09-25-rendering-lab-basic-gpu-analysis
state: history
---
# rendering-lab-basic 近景 GPU 性能分析

日期：2026-09-25  
性质：交互式诊断记录，**不是**正式 Performance 验收或优化收益声明。  
代码基线：`89f0a94`，测试时工作树含示例面板的逐 Pass 计时改动；临时 shader A/B 改动均已还原。

## 结论

相机靠近场景时，主要新增 GPU 耗时发生在 **Sparse Shading Resolve**，不是 Hardware Visibility。该 Pass 为可见像素重建几何和材质，再执行直接光照与 IBL；场景占据更多屏幕像素时，其成本明显上升。对同一近景做临时 shader A/B，关闭光照后该 Pass 约为 2.56 ms，加入直接光照约为 3.41 ms，完整 PBR + IBL 约为 5.83 ms。结果支持 **IBL 是当前材质路径中最值得先优化的部分**，但跨重载视角和 GPU 温度未被严格锁定，差值不能当作精确的独立算子耗时。

持续近景运行还观察到 GPU 约 90°C、软件温控降频激活、SM 时钟约 450 MHz；这时完整画面 GPU Pass 合计升至约 18.87 ms。因此这里有两个叠加问题：**像素着色工作量随近景覆盖率增长**，以及**高负载下的温控降频**。单凭任务管理器利用率，无法区分二者；这次诊断未见显存耗尽证据。

## 测试对象与方法

- 示例：[入口代码](../../examples/demos/14-integrated/rendering-lab-basic/main.ts)、[遥测](../../examples/demos/14-integrated/rendering-lab-basic/telemetry.ts)、[面板](../../examples/demos/14-integrated/rendering-lab-basic/panel.ts)。独立 Worker 在运行时 Cook `dungeon_warkarma.glb`，完成后约 798 primitive / 798 instance；使用 25 个源材质。
- 浏览器：本机 Chrome WebGPU；GPU：NVIDIA GeForce GTX 1650 Ti。示例以 canvas CSS 尺寸作为渲染尺寸，`internalScale: 1`，DPR 目标为 1。此次没有把浏览器、驱动、确切内部像素尺寸与环境温度冻结为正式基准参数。
- 画质：单个无阴影 DirectionalLight（强度 2.8）与 `venice_sunset_1k.hdr` 环境光；阴影、屏幕空间漫反射与反射、TAA、Bloom、自动曝光、运动模糊、锐化均关闭。`geometryOnly: false`。
- 采样：示例 GPU timestamp 每 8 帧采样一次；逐 Pass 面板取最近 24 个已完成 GPU 样本的 P50/P95。下表主要列 P50，单位 ms。对比均在 Cook 完成、画面稳定后读取；“近景”为从中心视角继续拉近，使模型占据屏幕大部分区域。
- A/B：临时分别输出材质解析的 `surface.base_color`，以及保留直接光照但关闭环境 IBL；每次重新加载并等待稳定后读数，最后还原完整 shader。没有保存严格一致的相机矩阵、温度曲线或可复算原始样本，故它是定位实验。

## 观察数据

| 场景 / shader 变体 | Sparse Shading Resolve P50 | Hardware Visibility P50 | GPU Pass 合计 P50 | 解释 |
| --- | ---: | ---: | ---: | --- |
| 全览 · 完整 PBR | ≈0.46 | ≈0.33 | ≈4.19 | 场景屏幕覆盖率低 |
| 近景 · 完整 PBR，初次 | ≈6.09–6.16 | ≈0.85 | ≈12.39–12.98 | 材质着色是主要增量 |
| 近景 · 仅材质解析并输出 base color | ≈2.56 | ≈0.66 | ≈7.14 | 保留可见像素解析，去掉光照计算 |
| 近景 · 材质解析 + 直接光照 | ≈3.41 | ≈0.66 | ≈8.78 | 与上一行相比增加直接光照 |
| 近景 · 还原完整 PBR + IBL | ≈5.83 | ≈0.79 | ≈11.21 | 与上一行相比恢复环境 IBL |
| 持续近景、高温时 · 完整 PBR | ≈9.04 | ≈1.51 | ≈18.87 | 与温控降频同时发生，不能用于评估代码变更 |

全览到初次近景，Resolve 大约从 0.46 ms 增至 6.1 ms，而 Visibility 约从 0.33 ms 增至 0.85 ms。A/B 的 Resolve 差值约为：直接光照 +0.85 ms、恢复 IBL +2.42 ms。这些差值只用于确定下一步调查顺序；shader 变体会改变编译器生成代码、资源访问和缓存行为，三段不能视为严格可加的 Pass 内分摊。

高温采样时，`nvidia-smi` 显示 GPU 利用率约 99%、温度约 90°C、SM 时钟约 450 MHz，`clocks_throttle_reasons.sw_thermal_slowdown` 为 `Active`；显存约 2026/4096 MiB。拉远后的一次采样仍为 90°C、温控状态仍激活，但时钟约 1350 MHz、利用率约 69%。这证明该机器的热状态显著影响后段结果；不支持“显存不足导致近景变慢”的判断。Windows 任务管理器显示的约 14.6/15.9 GB 是系统内存，不是 GPU 显存。

## 代码路径与原因判断

在该历史基线中，每帧先经过几何工作生成和 Hardware Visibility，再由已删除的 `SparseShadingResolvePass`/`sparse_shading_resolve.ts` 对着色输出执行 compute。它是全屏发射、可见像素执行较重工作的路径，不是只按唯一材质数计算一次。当前方向改由 SurfaceWork V3 统一 Work/GeometryRecord/cache/signal，见[第三版设计](../next-design/eengine-v3-extreme-performance-aaa-final-refactor-design-2026-10.md)。

完整 lit 路径在材质解析后调用 `sparse_direct`：先做标准材质直接光照，随后为 IBL 采样 split-sum LUT、预过滤环境镜面图与环境漫反射图，并计算能量与 AO。当前资产的 25 个材质 metallic factor 都是 0，roughness factor 默认为 1；材质依然进入这条完整 IBL 路径。因此肉眼看着接近“纯色”，不能据此认为 PBR 没有执行。粗糙材质的高光本来较钝，而额外工作仍要按可见像素支付。

材质评估代码还分别处理 ORM 与 AO 纹理槽。此资产的两槽指向同一图像、相同 UV 集，这提示存在复用一次采样的机会；实际能否合并，还需核对 sampler、UV 变换及材质 contract。**尚未测得这项优化的收益**，不能把它列为已证实的主瓶颈。与之类似，每像素三角形/属性重建的基线成本由“仅材质解析”近景约 2.56 ms 反映，但其中还包含其他 Pass 内操作，不能直接解释成纯几何解码耗时。

面板中的“分块 / Meshlet ID”只是切换 `RenderDebugView.MeshletId`；当前 FrameGraph 仍运行 Sparse Shading 和 LightCluster，并添加调试输出。它**不是**“纯几何管线”对照组，不能用两个按钮的帧率差证明材质管线成本。此前纯色版本与当前版本也没有在同一 revision、同一视角和热状态下做正式 A/B，因此没有证据说几何管线发生性能回退。

## 优先行动

1. **建立有效对照**：让几何调试模式真正裁掉无消费者的 Sparse Shading、LightCluster、HDR 材质输出与相关资源，或在独立 `validation/` 性能场景中提供 feature-off 控制组；验证 GPU producer/consumer 闭环和关闭 feature 后的零残留。
2. **先研究 IBL 的质量/成本取舍**：对当前非金属、高粗糙材质研究 specialization、低成本高粗糙度路径或环境采样复用；保持直接光和环境光的视觉结果，固定相机与冷却条件，用图像误差和逐 Pass GPU P50/P95 同时验收。简单全局关闭 IBL 会降低画质，不能当作等价优化。
3. **验证纹理采样复用**：只有纹理引用、UV 集、变换、sampler 均一致时才合并 ORM/AO 读取；加 contract/oracle 覆盖不同组合，再测真实 GPU 收益。
4. **再评估重建成本**：如果 IBL 优化后 Resolve 仍主导，进一步隔离 per-pixel meshlet/triangle 解码、属性插值和材质读取，而不是先进行渲染架构大改。
5. **固定热状态复测**：记录 GPU 温度、时钟与温控原因，控制浏览器/内部分辨率、相机矩阵、预热与采样窗口；避免拿 450 MHz 的热机结果与冷机结果比较。正式性能结论按照 [验证合同](../VALIDATION.md)进入独立 `validation/` 宿主及 L4 流程。

当前数据不支持优先引入虚拟纹理来解决此近景问题：纹理已驻留，显存采样约 2/4 GiB，而最明显的增长发生在每可见像素的材质/IBL计算及热降频。虚拟纹理可作为未来更大纹理集的容量与流送设计，需另设工作负载和证据。

## 证据边界

本报告来自示例页面的交互式 GPU timestamp、临时 shader A/B 与一次 `nvidia-smi` 热状态观察，没有独立 `validation/` case 的原始 artifact、clean revision、固定相机矩阵、固定温度或多轮可复算结果。GPU Pass 合计是该面板记录的各 GPU segment 耗时之和，不应直接等同于完整端到端帧时。报告用于确定优化方向；任何“性能已改善”或正式比较，必须重新按 [L4 要求](../VALIDATION.md)采集证据。
