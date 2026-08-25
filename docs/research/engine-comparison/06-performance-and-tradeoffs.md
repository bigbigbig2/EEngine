# three.js Compute Rasterizer 与 reconstructed：性能及工程权衡

> 状态：静态源码分析；尚未完成同机、同画质 benchmark  
> three.js：package `0.185.0`，commit `7cda7e710d884827fc73ff1a3aa63270846513d7`  
> reconstructed：工作区当前版本  
> 核验日期：2026-08-04

## 0. 先说结论

不存在不带场景条件的“谁一定更快”。当前源码更支持下面的判断：

| 场景 | 更可能占优 | 原因 |
|------|------------|------|
| 单一/少量 mesh、单一材质、超多实例、微小三角形 | three.js compute rasterizer | 数据布局极专用，几乎没有通用场景和材质管理成本；小三角形走 compute software raster |
| 大面积三角形、近景、普通几何覆盖 | reconstructed 的 hardware visibility 路线 | 固定功能 raster/depth 通常比 compute 内像素循环和 storage atomics 更合适 |
| 大量不同 mesh、不同材质、alpha-tested、透明、阴影 | reconstructed | 已有 GPU scene、material bucket、alpha-tested、OIT、shadow 等系统路径 |
| 很小的普通场景 | three.js 默认 renderer，而不是这两个重型 GPU-driven 路径 | GPU-driven 的 cull/queue/resolve 固定成本可能得不偿失 |
| 重遮挡复杂场景 | 未验证；reconstructed 架构更完整 | 两边都有 HZB，reconstructed 还有 second-chance、多 bucket；但其 pass 和带宽成本也更高 |
| 默认配置直接比 FPS | 没有意义 | reconstructed 默认开启更多效果，输出质量和工作量明显更高 |

一句话概括：

> three.js 示例像一辆为固定赛道减重的原型车；reconstructed 像一套正在形成完整车辆系统的引擎。前者在命中专用场景时可能非常快，后者为通用场景、资源生命周期和完整效果付出更多固定成本。

本文中的 `[推断]` 是基于执行路径、内存访问和提交方式形成的性能模型，不等于实测结果。

## 1. 公平对比的前提

reconstructed 当前默认开启：

- shadows
- SSAO
- TAA
- bloom
- automatic exposure
- sharpening

源码：[reconstructed Renderer feature defaults](/D:/shu/engine/research/shade-re/reconstructed/src/render/Renderer.ts:174)。

three.js 基础 compute rasterizer 主要做 visibility 和简单 texture/debug resolve；IBL 版本有环境光 PBR，但没有 reconstructed 默认的整套 shadow、SSAO、TAA、bloom 和 exposure 路线。

因此 benchmark 至少要分两组：

1. **等画质核心路径**：visibility + 相同 PBR/IBL，关闭 reconstructed 的额外效果。
2. **产品默认路径**：比较最终画质、功能和总帧时，而不是只看 FPS。

否则 reconstructed 即使更慢，也可能只是因为它完成了更多工作。

## 2. CPU 性能

### 2.1 three.js 示例的优势

`[事实]` 大量实例不是大量 `Object3D`。实例 transform、LOD、bounds 和 geometry 都在自定义 storage buffers 中。每帧 CPU 主要更新相机数据并提交固定 pass，不构建十几万项 RenderList。

`[推断]` 在“一个模板 mesh × 十几万实例”场景中，CPU 成本会很低且较稳定。

`[事实]` 基础示例直接在 GPU 中根据静态 position/scale 和 `time` 生成每个实例的 `matrixWorld`，不需要 CPU 每帧上传全部矩阵。

源码：[GPU instance transform/cull](/D:/shu/engine/three.js/examples/webgpu_compute_rasterizer.html:392)。

### 2.2 three.js 示例的提交成本

每次独立调用 `renderer.compute()` 都会：

1. 创建 command encoder。
2. 创建 compute pass。
3. 编码 dispatch。
4. `finishCompute()`。
5. 调用 `device.queue.submit()`。

源码：

- [Renderer.compute()](/D:/shu/engine/three.js/src/renderers/common/Renderer.js:2873)
- [WebGPUBackend.beginCompute()](/D:/shu/engine/three.js/src/renderers/webgpu/WebGPUBackend.js:1849)
- [WebGPUBackend.finishCompute() 提交](/D:/shu/engine/three.js/src/renderers/webgpu/WebGPUBackend.js:1988)

基础示例在 `Both` 模式下一帧源码可见的提交大致是：

```txt
5 × renderer.compute()
1 × fullscreen resolve render
1 × hardware fallback render
≈ 7 次 queue submit
```

IBL 版本还对每个 HZB mip level 单独调用一次 `renderer.compute()`。1080p 从半分辨率降到 1×1 大约有 11 层，因此源码路径可能接近：

```txt
5 compute
+ 1 scene render
+ ~11 HZB compute
+ 1 blit
≈ 18 次 queue submit
```

`[推断]` 这些 submit 不等于同步等待，但会增加 command buffer 创建、JS/backend 调用与队列提交开销。它是当前示例很明确的 CPU 优化机会：将相关 compute nodes 放到更少的 encoder/submit 中。

### 2.3 reconstructed 的优势

reconstructed 的主渲染帧创建一个 `ShadeGPUCommandContext`，把 FrameGraph 中的 compute/render passes 编码进同一个 command encoder，最后一次 `queue.submit()`。

源码：

- [主帧创建与 encodeGraph](/D:/shu/engine/research/shade-re/reconstructed/src/render/Renderer.ts:506)
- [ShadeGPUCommandContext.encodeGraph()](/D:/shu/engine/research/shade-re/reconstructed/src/framegraph/ShadeGPUCommandContext.ts:152)
- [统一 finish/submit](/D:/shu/engine/research/shade-re/reconstructed/src/framegraph/ShadeGPUCommandContext.ts:353)

`[推断]` 对 pass 很多的完整 renderer，这种方式更有利于减少 CPU 提交开销和 command buffer 碎片。

### 2.4 reconstructed 当前实现的 CPU 代价

这并不代表 reconstructed 每帧只有一次提交：

- `ViewContext.update()` 每帧调用 `GPUSceneContext.update()`。
- `GPUSceneContext.update()` 当前总会创建并提交一个 `animationFlush` command context。
- scene instance 结构变化时，还会完整 `build()` scene database 并单独提交 database upload。

源码：

- [ViewContext.update()](/D:/shu/engine/research/shade-re/reconstructed/src/render/ViewContext.ts:155)
- [GPUSceneContext.update()](/D:/shu/engine/research/shade-re/reconstructed/src/gpu/GPUSceneContext.ts:308)
- [GPUSceneContext.build()](/D:/shu/engine/research/shade-re/reconstructed/src/gpu/GPUSceneContext.ts:199)
- [database-build submit](/D:/shu/engine/research/shade-re/reconstructed/src/gpu/GPUSceneContext.ts:356)

`[事实]` 当前 `build()` 会重新遍历 instances、更新矩阵、重建 CPU TLAS、清空并重建 transform/mesh 表，然后上传数据库。

`[推断]` 高频 add/remove mesh 或更换会影响 instances version 的场景可能出现明显 CPU 与上传尖峰。reconstructed 的架构比 three.js 示例更能表达动态场景，但当前实现还没有把所有结构变化做到细粒度增量更新。

### 2.5 FrameGraph 的 CPU 成本

`[事实]` reconstructed 每帧新建 `FrameGraph`，在执行前调用 `compile()`，分析 pass/resource 使用和生命周期。

源码：

- [每帧创建 FrameGraph](/D:/shu/engine/research/shade-re/reconstructed/src/render/Renderer.ts:526)
- [FrameGraph.compile()](/D:/shu/engine/research/shade-re/reconstructed/src/framegraph/FrameGraph.ts:445)

`[推断]` 这会产生 three.js 手写固定流水线没有的 CPU 固定成本。它换来的是资源依赖检查、pass 剔除、生命周期释放和更好的维护 locality。是否值得取决于 pass 数量与 CPU budget。

## 3. GPU 可见性与光栅化

### 3.1 three.js compute software raster 的优势

`[事实]` 每个 compute thread 处理一个三角形，小三角形在 compute 中遍历很小的屏幕 bounding box，并用 `atomicMax` 写 packed depth/visibility。

`[推断]` 当三角形大量小于一个或几个像素时，这条路径有机会：

- 避免传统 raster 对微三角形的部分固定开销。
- 先 visibility、后每像素一次 shading，减少几何过密带来的重复 fragment shading。
- 通过 GPU work queue 避免 CPU draw submission。

这正是该示例最有价值的性能实验区。

### 3.2 three.js compute software raster 的代价

它的主要风险也直接写在源码中：大三角形会让单线程做近似面积级的像素循环，因此示例设置 `MAX_RASTER_SIZE`，超过阈值就转入 hardware queue。

源码：[large triangle safeguard](/D:/shu/engine/three.js/examples/webgpu_compute_rasterizer.html:624)。

其他代价：

- storage buffer 原子竞争。
- 手写 edge rules、depth packing、clipping 和 derivative reconstruction。
- 不能直接获得硬件 raster 的全部固定功能优化。
- packed depth 位数低于 `depth32float`。
- 当前 near-plane 处理更接近 rejection，而不是完整 triangle clipping。
- 性能对三角形屏幕尺寸分布极其敏感。

`[推断]` 近景、大面积三角形、强 overdraw 或大量线程写同一区域时，compute atomics 和像素循环可能比硬件 raster 更差。

### 3.3 reconstructed hardware visibility 的优势

reconstructed 在 GPU culling、expand、bucket 之后，通过 render pass 的 `drawIndirect()` 输出 triangle ID、mesh ID 与硬件 depth。

源码：

- [VisibilityPass GPU cull/expand/bucket](/D:/shu/engine/research/shade-re/reconstructed/src/render/passes/VisibilityPass.ts:650)
- [VisibilityPass.drawIndirect()](/D:/shu/engine/research/shade-re/reconstructed/src/render/passes/VisibilityPass.ts:1515)

`[推断]` 对普通尺寸和大面积三角形，它更能利用 GPU 固定功能 raster、depth test 和硬件优化，性能曲线通常会比纯 compute raster 更稳定。

### 3.4 reconstructed visibility 的代价

为了支持通用场景，它会执行更多 GPU 阶段：

- scene mesh filter
- material bucket scatter/slice
- instance cull
- meshlet expand
- HZB cull
- second-chance cull/raster
- alpha-tested material sort/raster
- fill indirect args

源码：[VisibilityPass stage notes](/D:/shu/engine/research/shade-re/reconstructed/src/render/passes/VisibilityPass.ts:58)。

`[推断]` 这些 pass 会增加 dispatch、buffer clear、全局内存读写和中间队列流量。在单 mesh、单 material 的极端同质场景里，这些通用能力可能成为纯开销，three.js 专用示例反而更容易领先。

## 4. Shading、Overdraw 与画质

### three.js IBL

优势：

- visibility resolve 后每个覆盖像素只做一次主要材质/IBL shading。
- 几何密度和 overdraw 不会等比例重复执行完整 PBR fragment shader。
- 直接复用 `MeshStandardNodeMaterial` 的 lighting implementation。

代价：

- 为每像素重新读取 triangle vertices、normal、UV。
- 重建 barycentric coordinates。
- 计算显式 texture gradients 和 normal derivatives。
- 当前只针对一个 source material/mesh 数据模型。

### reconstructed

优势：

- 同样先 visibility，再 material expand 和 lighting，避免在 visibility pass 做完整 shading。
- 材质、光照、间接光、时域和后处理已经拆成可组合 modules。
- 可以为不同输出/效果复用 GBuffer。

代价：

- material expand 写多个 GBuffer。
- 后续 lighting/SSAO/SSR/TAA/post 再读取，显著增加带宽。
- 完整效果链的 pass 与 history texture 固定成本较高。

`[推断]` three.js IBL 更像“单次专用 resolve”；reconstructed 更像“为完整效果生态支付额外带宽”。在只需要简单 IBL 时前者可能更省；效果越多，后者的共享 GBuffer 和模块化路线越可能回收成本。

## 5. 显存与带宽

以下只计算源码中容易确定的部分，不代表总显存：

| 资源 | 估算 |
|------|------|
| three 固定 work queue：`2,820,000 × uvec4` | 约 43.03 MiB |
| three 两个 uint32 visibility screen buffers，1080p | 约 15.82 MiB |
| three 两个 uint32 visibility screen buffers，4K | 约 63.28 MiB |
| three 基础版 160k instance data + world + MVP | 约 21.97 MiB |
| reconstructed mesh ID + triangle ID + depth，1080p | 约 23.73 MiB |
| reconstructed mesh ID + triangle ID + depth，4K | 约 94.92 MiB |

three.js 示例的特点：

- work queue 按最大容量一次性预分配，简单但浪费潜力较大。
- visibility buffer 随像素数线性增长。
- IBL 还增加 previous transforms、scene HDR target、depth、HZB 和纹理。
- LOD/mega buffer 也会占用较大常驻空间。

reconstructed 的特点：

- visibility 本身就有两个 `r32uint` attachment 和 `depth32float`。
- 还有 previous depth、GBuffer、HDR、velocity、TAA history、bloom 等资源。
- GPU scene、material metadata、meshlet table 和多个 work lists 长期常驻。
- 总显存与带宽大概率高于 three 基础示例，但它提供的功能也多得多。

FrameGraph 会在 transient resource 的最后一次使用后释放到 allocator，可让后续资源复用已有分配：

- [FrameGraph last-use release](/D:/shu/engine/research/shade-re/reconstructed/src/framegraph/FrameGraph.ts:499)

`[推断]` reconstructed 更适合做生命周期优化，但当前大量 imported/persistent render targets 仍限制了可别名空间；需要实际 memory instrumentation 才能得到峰值。

## 6. 不同变化模式下的表现

### 仅相机移动、场景静态

- three 示例：非常理想。CPU 只更新相机，GPU 重算 visibility/LOD。
- reconstructed：也适合，但仍承担完整 scene update、FrameGraph 和功能链固定成本。

### 大量简单实例做规则动画

- three 示例：当前旋转公式直接在 compute 中生成 transform，极其专用且高效。
- reconstructed：GPU animation/skinning 路线更通用，但管理和同步成本更高。

### 任意 transform 高频更新

- three 示例：需要扩展 instance buffer 更新纪律；当前 demo 没有通用 scene sync。
- reconstructed：已有 transform table/animation manager，更容易承接，但需验证每帧上传量和 animationFlush 成本。

### 高频 add/remove mesh

- three 示例：基本不支持，需要重建或另写 allocator/database。
- reconstructed：语义上支持，但当前 instances version 变化会触发全量 scene database rebuild，可能产生尖峰。

### 多 mesh、多 material

- three 示例：优势会快速消失，因为必须加入 asset ID、material ID、bucket/bindless、pipeline 分类和资源生命周期。
- reconstructed：已经为此支付了 material metadata 与 bucket 成本，扩展性更好。

## 7. 其他工程维度

| 维度 | three.js compute rasterizer | reconstructed |
|------|-----------------------------|---------------|
| Interface | 没有稳定 GPU-driven interface；需要理解并修改大量示例内部状态 | `Renderer`、`GPUSceneManager`、`FrameGraph`、pass modules 相对明确 |
| Module depth | 算法集中在一个示例，实验快但复用 leverage 低 | 复杂实现藏在多个 module 后，调用侧 leverage 更高 |
| Locality | 单文件便于读实验，但变化会牵动大量局部变量和顺序约束 | cull/material/lighting/resource 生命周期各有 owner，但跨 module 调试更复杂 |
| Shader 开发 | TSL 表达力高，可复用 NodeMaterial/lighting | WGSL 更显式、可预测，控制力强但维护成本高 |
| 材质生态 | 可接 three NodeMaterial，但当前例子只有一个 source material | 固定 GPU material schema/buckets，更适合批量，但任意自定义材质更困难 |
| 资产生态 | three loaders、materials、controls、inspector 成熟 | 自有 glTF/USD/scene 格式，生态和兼容面更窄 |
| 调试 | Inspector/timestamp；流程短，但原子和生成 WGSL 难查 | GPUTimer、FrameGraph DOT、debug passes；信息丰富但路径长 |
| 正确性 | 实验性 clipping、固定 bit packing、queue caps | 更完整 alpha/OIT/shadow/temporal 路径，但状态空间更大 |
| 平台 | 此示例本身 WebGPU-only | WebGPU-only |
| fallback | compute rasterizer 无 WebGL fallback | 无 fallback |
| 启动 | 浏览器内生成 LOD/meshlet并编译大型 TSL shader，可能首帧重 | 初始化大量 pipeline/database，也可能首帧重；需实测 |
| 维护风险 | upstream 仅示例，interface 随版本变化的可能性高 | 自有代码可控，但 reconstructed/迁移状态和复杂度带来风险 |

## 8. 当前 reconstructed 最需要警惕的性能点

从源码看，优先级较高的风险是：

1. 每帧无条件 animationFlush 独立 submit。
2. instances 结构变化触发 scene database 全量 rebuild/upload。
3. 每帧 FrameGraph 重建与 compile 的 CPU 成本。
4. visibility 多阶段 bucket/cull/second-chance 的固定 GPU 成本。
5. 默认效果链过重，容易让核心 visibility 性能被 post 掩盖。
6. 多个全分辨率 ID/GBuffer/HDR/history 资源的带宽与峰值显存。
7. 目前部分源码注释仍标记 `stub`、`gap` 或 reconstructed 对齐状态，架构目标不能自动等同于当前实现质量。

这些不意味着路线错误，而是说明真正的优势必须靠 profiling 和逐项闭环获得。

## 9. three.js 示例值得 reconstructed 借鉴的点

### 9.1 为微三角形保留可替换 raster adapter

当前 reconstructed 的 visibility module 主要走 hardware raster。可以把 raster 方式做成明确 seam：

```txt
VisibilityWork
  → HardwareVisibilityRasterAdapter
  → ComputeMicroTriangleRasterAdapter（实验）
```

只有当两种 adapter 都存在并由相同 interface 驱动时，这个 seam 才是真实的。先用 benchmark 证明微三角形 software path 有价值，再进入主架构。

### 9.2 避免固定巨型 work queue

借鉴 GPU work generation，但不要照搬固定 `MAX_WORK_ITEMS`：

- 分层容量增长。
- 统计 overflow。
- 按历史峰值自适应。
- debug 模式显式报错。

### 9.3 保持一次/少量 queue submit

three 示例的算法值得研究，但其逐 compute submit 不值得复制。reconstructed 的统一 command context 是更好的执行 seam。

### 9.4 保留专用 fast path

reconstructed 通用路径较重。可为“单 geometry/material × 海量 instances”提供深 module：

```txt
registerHomogeneousInstanceSet(...)
```

调用者只学习一个小 interface，内部选择更轻的 cull/LOD/work generation，避免把 fast-path 细节泄漏到整个 renderer。

## 10. 必须完成的 Benchmark

在得出“谁快多少”之前，应构造相同资产和相同画质的测试矩阵：

| Case | 变量 |
|------|------|
| A 微三角形平面 | triangle pixel size、instance count |
| B 近景大三角形 | screen coverage、SW/HW threshold |
| C 重遮挡体积 | visible ratio、HZB on/off |
| D 异构场景 | mesh/material/bucket 数量 |
| E transform 动态 | 每帧更新比例 |
| F structural churn | 每秒 add/remove 数量 |
| G 分辨率扩展 | 720p、1080p、1440p、4K |
| H 功能阶梯 | visibility-only、PBR、shadow、TAA/post |

每组记录：

- CPU scene/update 时间。
- CPU graph/command encode 时间。
- queue submit 次数。
- GPU cull、raster、resolve、lighting、post timestamp。
- 可见 instance/meshlet/triangle 数量。
- GPU buffer/texture 峰值。
- 每帧上传字节数。
- 平均帧、P95/P99 和首次编译帧。

在这组数据出来以前，最可靠的结论仍然是：

> three.js 示例用专用性换取潜在峰值性能；reconstructed 用更多固定成本换取通用 GPU scene、完整渲染能力和长期可扩展架构。
