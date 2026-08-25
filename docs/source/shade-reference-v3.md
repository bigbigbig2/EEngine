# Shade - WebGPU graphics：three.js 论坛整帖技术解读与实现拆解（v3 完整版）

> 原帖：<https://discourse.threejs.org/t/shade-webgpu-graphics/66969>  
> 覆盖范围：当前可读的完整讨论串，Page 1 - Page 9，#1 - #181，时间跨度 2024-06-17 到 2026-05-12。  
> 说明：这不是原帖逐字翻译，也不是简单摘要；这是按整帖内容重新组织后的中文技术解读。为了避免变成难读的流水账，正文以技术主题为主，后面附楼层时间线。所有关键技术点、实现思路、和 three.js / WebGPURenderer / TSL / Babylon / PlayCanvas / Unity 的对比都纳入整理。

---

## 目录

- [0. 一句话结论](#0-一句话结论)
- [1. 这篇帖子的主线](#1-这篇帖子的主线)
- [2. Shade 到底是什么](#2-shade-到底是什么)
- [3. 为什么作者不直接用 three.js WebGPURenderer](#3-为什么作者不直接用-threejs-webgpurenderer)
- [4. GPU-resident / GPU-driven renderer 的核心思想](#4-gpu-resident--gpu-driven-renderer-的核心思想)
- [5. Shade 的主渲染管线：从实例到像素](#5-shade-的主渲染管线从实例到像素)
- [6. Visibility Buffer：Shade 的架构中枢](#6-visibility-buffershade-的架构中枢)
- [7. HZB / Depth Pyramid / Occlusion Culling](#7-hzb--depth-pyramid--occlusion-culling)
- [8. Meshlet 架构与 WebGPU 没有 Mesh Shader 的替代方案](#8-meshlet-架构与-webgpu-没有-mesh-shader-的替代方案)
- [9. Material Pass：用深度测试做材料分发，实现接近 0 overdraw](#9-material-pass用深度测试做材料分发实现接近-0-overdraw)
- [10. FrameGraph / RenderGraph：资源别名与后处理组织](#10-framegraph--rendergraph资源别名与后处理组织)
- [11. 后处理栈：GTAO、TAA、SSR、Bloom、RCAS、Auto Exposure](#11-后处理栈gtaotaa-ssrbloomrcasauto-exposure)
- [12. TAA：为什么它是整套系统的胶水](#12-taa为什么它是整套系统的胶水)
- [13. SSAO / GTAO / Bent Normals](#13-ssao--gtao--bent-normals)
- [14. SSR：不只是屏幕空间反射，而是一个完整时空降噪问题](#14-ssr不只是屏幕空间反射而是一个完整时空降噪问题)
- [15. 阴影系统：从软件 ray tracing 到 CSM / contact shadow](#15-阴影系统从软件-ray-tracing-到-csm--contact-shadow)
- [16. 光照模型、BRDF、Specular AA、Shadow Terminator](#16-光照模型brdfspecular-aashadow-terminator)
- [17. 天空、大气、HDR、Tonemapping、自动曝光](#17-天空大气hdrtonemapping自动曝光)
- [18. GI：从 DDGI 到 Sparse Volumetric Light Map](#18-gi从-ddgi-到-sparse-volumetric-light-map)
- [19. Path Tracer：GI bake、debug、累积 path tracer](#19-path-tracergi-bakedebug累积-path-tracer)
- [20. Texture / Mipmap / Alpha / Bindless 缺失](#20-texture--mipmap--alpha--bindless-缺失)
- [21. 自定义场景格式与流式加载](#21-自定义场景格式与流式加载)
- [22. GPU Animation / GPU Skinning](#22-gpu-animation--gpu-skinning)
- [23. 与 three.js 的系统性对比](#23-与-threejs-的系统性对比)
- [24. 与 WebGPURenderer / TSL / NodeMaterial 的对比](#24-与-webgpurenderer--tsl--nodematerial-的对比)
- [25. 与 Babylon.js / PlayCanvas / Unity / Unreal 的对比](#25-与-babylonjs--playcanvas--unity--unreal-的对比)
- [26. 性能数据与 Benchmark 解读](#26-性能数据与-benchmark-解读)
- [27. 按楼层 / 时间线完整整理](#27-按楼层--时间线完整整理)
- [28. 技术词汇表](#28-技术词汇表)
- [29. 如果你是 three.js / WebGL / WebGPU 开发者，应该重点学什么](#29-如果你是-threejs--webgl--webgpu-开发者应该重点学什么)
- [30. 总结](#30-总结)

---

## 0. 一句话结论

这整篇帖子的核心不是“某个 WebGPU demo 很好看”，而是作者 Usnul 在展示一个完整的、从零写的、面向现代 AAA 渲染思路的浏览器图形引擎 **Shade**。

它和 three.js 最大的区别不是 API 风格，而是渲染架构：

- three.js 的主流架构仍然是 **CPU 管场景、CPU 遍历对象、CPU 发 draw call、GPU 执行绘制**。
- Shade 的目标是 **场景数据长期驻留 GPU，剔除、排序、间接绘制、meshlet 展开、可见性判断、部分动画、部分光照数据处理都尽量在 GPU 上完成**。

所以 Shade 讨论的并不是“WebGPU 版 three.js 能不能快一点”，而是：“如果浏览器里也能实现一个 GPU-resident renderer，那么 Web 图形能不能接近现代主机/PC 游戏引擎的架构？”

---

## 1. 这篇帖子的主线

原帖大致可以分成九个阶段：

### 阶段 A：2024-06，项目公开与架构宣言

主帖 #1 解释为什么做 Shade：作者喜欢 three.js 的易用性，但想要 Unreal 级别的现代渲染能力。WebGPU 出现后，浏览器终于有机会实现 GPU-resident renderer。

早期目标包括：

- Occlusion culling：不画被遮挡物体。
- GPU draw dispatch：不再每个 mesh 从 CPU 发一个 draw call。
- Visibility-based deferred shading：只给最终可见像素做昂贵的材质/光照计算。
- 现代后处理：SSAO / SSR / AA / Bloom。
- Turn-key global illumination：尽可能开箱即用的全局光照。
- 后续还包括 shadow、IBL、path tracing、GI bake、scene streaming、GPU animation。

### 阶段 B：2024-06 到 2024-07，基础管线、TAA、GTAO、ray-traced shadow、path tracer

作者展示百万动态 mesh 的基准测试、GPU occlusion culling、GTAO、TAA、早期 ray traced shadows 和 path tracer。这里已经出现 Shade 与 three.js 的根本差异：Shade 不靠 instancing / batching 规避 draw call，而是把“发 draw”本身改成 GPU-resident 问题。

### 阶段 C：2024-08 到 2024-10，GI、DDGI、SSR、specular AA、TAA reprojection

作者把 light probe volume / DDGI 相关技术迁入 WebGPU，讨论 probe leakage、color bleeding、SSR denoise/reprojection、blue noise、ACES、sky/atmosphere、specular anti-aliasing。

### 阶段 D：2024-10 到 2024-11，WebGPURenderer / NodeMaterial / TSL 讨论

这部分是整帖对 three.js 最有价值的讨论之一。作者明确说 three.js WebGPURenderer 方向本身没错，但它仍是传统渲染架构，不适合他的 GPU-resident renderer。作者也批评 TSL / NodeMaterial 作为低层 shader 编程接口时引入了额外抽象成本、编译成本、开发体验问题。

### 阶段 E：2024-11 到 2025-03，demo、Bloom、Oren-Nayar、HDR env、GI、radiance probes、benchmark

Shade 发布早期 demo，加入 Bloom，讨论 Oren-Nayar vs Burley diffuse，HDR environment map，octahedral projection，infinite bounce GI，specular GI，benchmark 反馈。

### 阶段 F：2025-05 到 2025-10，visibility buffer 管线细节、bindless/virtual textures、meshlet 重构、SSR ray reuse

#86 是整篇最关键的实现楼层之一：它完整解释了 Shade 每帧怎么从 instance → meshlet → triangle → visibility buffer → material pass。后续 #92 解释 meshlet expansion 的瓶颈和 batch 方案，#100 左右讨论 SSR 邻域 ray reuse。

### 阶段 G：2025-10 到 2025-12，TAA texture sampling、mipmap filter、pipeline state、contact shadow、GI visibility

作者开始大量打磨“画质细节”：TAA 下如何稳定 UV，如何给 mip 做 bias，如何用 Mitchell / MKS 改进 mipmap，如何做 alpha premultiplication，如何处理 contact shadow 与 pipeline state。

### 阶段 H：2026-01 到 2026-03，自动曝光、CSM cascade blending、Sparse Volumetric Light Map

这部分 Shade 的 GI 方向发生重要演化：从早期 DDGI/radiance probe，逐渐进入 Sparse Volumetric Light Map（SVLM）。它包含 probe tree、SH3、RGBE9995、GPU bake、probe compression、specular GI、reservoir sampling、GGX convolution 等。

### 阶段 I：2026-04 到 2026-05，性能优化、对比表、场景格式、RCAS、累积 path tracer、GPU animation/skinning

作者重新做 occlusion culling 以适配 Apple Silicon，发布 performance upscale demo，给出与 three.js/Babylon/Unity/PlayCanvas 的对比表，做自定义 scene format，把 Sponza + textures + BVH + environment 压到 29.5MB，再到 zip 16MB。最后进入 GPU animation：动画曲线、tracks、clips、bindings、node hierarchy、bounding volume update、skinning 都放到 GPU。

---

## 2. Shade 到底是什么

Shade 不是 three.js 插件，也不是 WebGPURenderer 的上层封装。作者明确表示 Shade 是从零实现的，没有第三方依赖。

它的定位更接近：

```text
browser-native modern renderer
+ WebGPU
+ GPU-resident scene
+ meshlet-based visibility buffer
+ clustered lighting
+ TAA / GTAO / SSR / Bloom / Auto Exposure
+ GI / SVLM / software ray tracing
+ streaming scene format
+ GPU animation
```

### 2.1 不是通用“小白友好”3D 框架

three.js 的强项是：

- API 简单；
- 生态成熟；
- WebGL/WebGPU/WebXR/loader/examples 丰富；
- 非游戏场景很好用；
- 学习门槛低；
- 适合产品展示、数据可视化、网页交互、普通 3D 应用。

Shade 的目标是：

- 大规模动态实例；
- 大场景可见性剔除；
- 稳定的高质量后处理；
- GI / shadow / SSR / TAA 等现代 frame stack；
- 更接近 AAA renderer 的架构；
- 更少 CPU overhead；
- 更固定、更高度集成的渲染管线。

这意味着 Shade 不追求 three.js 那种“你可以随意拼 shader、换材质、加后处理插件”的灵活性。它更像一个 opinionated engine：作者会选择一个默认最优路径，而不是暴露一堆可任意组合的组件。

### 2.2 商业化而非开源

帖子里多次有人问 repo / code / 是否贡献到 three.js。作者的回答很明确：

- 不会很快开源；
- 目标最终是 license；
- 原因是这类 renderer 复杂、维护成本高、商业价值明显；
- 它也不适合放进 three.js examples/addons，因为架构差异太大。

这个点很重要：原帖不是一个开源项目文档，而是一个长期开发日志 + 技术讨论串。

---

## 3. 为什么作者不直接用 three.js WebGPURenderer

作者对 three.js 的态度不是否定。他反复强调 three.js 简单是优势，Shade 甚至约 90% 的 shading model 借鉴/参考了 three.js 的工作。

真正的问题是：three.js WebGPURenderer 的方向仍然是传统场景图 + renderer 后端替换。

### 3.1 three.js 的传统渲染模型

大致流程是：

```text
Scene graph on CPU
  ↓
CPU traversal
  ↓
CPU frustum culling / sorting / render list
  ↓
For each render item:
  set material / geometry / uniforms
  issue draw call
  ↓
GPU executes draw
```

即使 WebGPU 替代了 WebGL，three.js 的核心抽象仍围绕：

- Object3D；
- Mesh；
- Material；
- Geometry；
- RenderItem；
- 每个对象/材质/几何组合发起绘制。

这对易用性非常好，但对百万动态对象、极大材料数量、复杂遮挡关系而言，CPU 侧会成为瓶颈。

### 3.2 Shade 的模型

Shade 想做的是：

```text
Scene data lives on GPU
  ↓
GPU culls instances / meshlets
  ↓
GPU builds visible lists / indirect draw buffers
  ↓
GPU draws visibility buffer
  ↓
GPU/material passes shade only visible pixels
```

CPU 每帧只提交少量固定命令，数据结构和可见性判断主要在 GPU 上完成。

### 3.3 “WebGPU renderer”不是“现代 renderer”

这是整帖隐含的核心观点：

> 使用 WebGPU API 不等于拥有现代渲染架构。

WebGPU 给你 compute shader、storage buffer、indirect draw、timestamp query、bind groups 等能力，但如果上层仍然按传统 CPU-driven renderer 组织，性能上限和架构上限不会自动改变。

Shade 的价值在于：它试图把 WebGPU 的能力用到架构层，而不是只把 WebGL backend 换成 WebGPU backend。

---

## 4. GPU-resident / GPU-driven renderer 的核心思想

### 4.1 什么叫 GPU-resident

GPU-resident 指的是场景关键数据长期存在 GPU 内存中，而不是每帧由 CPU 组织后发给 GPU。

包括：

- instance data；
- transform；
- geometry / meshlet；
- material ID；
- texture handle / texture slot；
- BVH / acceleration structures；
- light data；
- animation data；
- bounding volumes；
- indirect draw buffers；
- visibility buffer / depth pyramid。

CPU 不再是“每帧计算全部渲染列表的指挥官”，而更像是“提交 frame graph 命令、上传变更、处理用户逻辑”的调度者。

### 4.2 什么叫 GPU-driven

GPU-driven 更强调每帧流程由 GPU 生成/筛选/调度：

- GPU 做 frustum culling；
- GPU 做 occlusion culling；
- GPU 做 meshlet expansion；
- GPU 生成 visible lists；
- GPU 生成 indirect draw 参数；
- GPU 做 sorting / prefix sum / compaction；
- GPU 更新 animation / bounding volumes；
- GPU 负责多数 expensive workloads。

### 4.3 为什么这对 Web 很重要

浏览器里的 JS 主线程本来就很忙：

- input；
- UI；
- layout；
- framework runtime；
- gameplay；
- network；
- asset streaming；
- GC；
- render command encoding。

如果每帧还要遍历几十万对象并提交几万 draw call，Web 场景会非常容易卡。

Shade 的策略是把 CPU 侧 per-object overhead 降到最低，使 CPU 主要处理：

- 用户逻辑；
- 资源流式加载；
- 少量状态变更；
- 提交固定数量的 GPU pass。

---

## 5. Shade 的主渲染管线：从实例到像素

#86 给出了非常关键的 frame breakdown。整理成更清楚的版本如下。

### 5.1 输入数据

输入大致包括：

- instances / meshes；
- geometry；
- meshlet data；
- material data；
- transforms；
- lights；
- previous frame depth pyramid；
- camera / frustum；
- GPU-side spatial structures。

### 5.2 第一阶段：instance culling

GPU compute shader 处理所有 instances，把它们分为：

```text
visible set
maybe visible set
culled set
```

其中：

- visible：通过 frustum 和保守 occlusion check；
- maybe：当前信息不足，需要后续更精确判断；
- culled：确定不可见。

为什么需要 maybe？因为基于上一帧/当前粗略 depth 的 occlusion culling 不能一刀切，否则会出现错误剔除、闪烁或 popping。

### 5.3 第二阶段：mesh → meshlet expansion

可见 instance 被展开成 meshlets。

meshlet 是一小块局部三角形簇，通常最多 128 triangles。它的好处是：

- 空间局部性更好；
- bounding volume 更紧；
- occlusion / frustum / LOD 更细粒度；
- GPU culling 更可预测；
- 不需要每次处理整个大 mesh。

### 5.4 第三阶段：meshlet culling

meshlet 再次被分为 visible / maybe / culled。

这一步比 instance culling 更细。比如一个超大的 terrain mesh，从 object-level 看整体可见，但实际上屏幕只看到极小一块。meshlet culling 可以只提交可见小块。

### 5.5 第四阶段：visibility buffer rasterization

Shade 早期会继续 expand meshlets 到 triangles，然后把可见 triangle rasterize 到 visibility buffer。

Visibility buffer 是一个 `rg32uint` texture，保存：

```text
R: mesh_id
G: triangle_id
```

这个 pass 很像 depth pre-pass：shader 很简单，不做复杂材质和光照，只记录“这个 pixel 最终看到的是哪个 mesh 的哪个 triangle”。

后续作者优化后，在很多情况下不再显式 triangle buffer，而是直接 draw meshlets，因为单独 triangle culling 的收益不总是抵得过 culling 本身的成本。

### 5.6 第五阶段：构建 depth pyramid / HZB

第一次 rasterize 后，生成 depth pyramid。

depth pyramid 是一组 mip level：

```text
level 0: full resolution depth
level 1: half resolution conservative depth
level 2: quarter resolution
...
```

它用于快速判断一个 bounding box / meshlet / instance 是否被已有深度遮挡。

### 5.7 第六阶段：处理 maybe set

有了当前帧部分 depth pyramid 后，重新处理 maybe set：

- 用更准确的 HZB 判断遮挡；
- 释放之前不确定的对象；
- 过滤剩余可见几何。

### 5.8 第七阶段：第二次 rasterization

把 maybe 里最终确认可见的几何再 rasterize 到 visibility buffer。

到这里，Shade 实际 geometry drawing 主要是两次 raster pass。作者提到还会有 depth pyramid 的多个 pass，但每个 mip 处理像素数量越来越少，因此相对便宜。

### 5.9 第八阶段：material ID / material pass

后面进入材料阶段。Shade 通过 visibility buffer 取出 mesh/material 信息，然后用一个非常巧妙的深度测试策略分发材料 shader。

见第 9 章。

---

## 6. Visibility Buffer：Shade 的架构中枢

### 6.1 Visibility Buffer 和 G-buffer 的区别

传统 deferred renderer 通常会先写 G-buffer：

```text
albedo
normal
roughness
metalness
depth
motion vector
...
```

这样的问题是：G-buffer pass 已经执行了材质 shader，仍然会有一定 overdraw，而且 material / texture switching 在场景复杂时仍然昂贵。

Visibility buffer 的做法是先只记录“可见性”：

```text
pixel -> mesh_id + triangle_id
```

真正的材质属性在后续按需 fetch / evaluate。

### 6.2 为什么 visibility buffer 适合大场景

优点：

- 首次 raster pass 极轻；
- 只对最终可见 pixel 做材质计算；
- 几何/材质/纹理数量增加时更稳定；
- 可以在后续 pass 中根据 material ID 组织 shading；
- 对 meshlet / Nanite-like renderer 友好。

代价：

- GPU bandwidth 压力更大；
- 需要自己管理很多 GPU-side 数据结构；
- shader 里要能从 ID 找回几何/材质/纹理；
- pipeline 更复杂；
- WebGPU 缺少 bindless 让纹理访问更麻烦。

### 6.3 与 Nanite 的关系

Shade 的 visibility-based deferred shading 和 meshlet 思路显然受现代 virtualized geometry / Nanite-style renderer 影响。

它不是 Nanite 的完整复刻，因为：

- WebGPU 没有 mesh shaders；
- 没有 native hardware ray tracing；
- 没有 bindless resources；
- 没有 Unreal 那套 offline build pipeline；
- Shade 是浏览器 JS/WebGPU 环境。

但核心精神类似：

```text
先解决可见性，再解决材质与光照。
```

---

## 7. HZB / Depth Pyramid / Occlusion Culling

### 7.1 为什么 occlusion culling 是核心

如果一个场景有百万物体，但最终屏幕上只看到几万个 meshlet，传统 renderer 仍可能把大量对象交给 GPU。Shade 想避免这一点。

Occlusion culling 的目标：

```text
不要画被前景挡住的东西。
```

这和 frustum culling 不同：frustum culling 只看是否在视锥内，而 occlusion culling 关心是否被已经可见的前景遮挡。

### 7.2 HZB 的基本原理

HZB = Hierarchical Z-Buffer。它把深度 buffer 做成 mip pyramid。

判断一个 bounding box 是否被遮挡时，不必逐像素比较，而是：

1. 把 bounding box 投影到屏幕；
2. 根据屏幕大小选择合适 mip；
3. 从 HZB 读取保守深度；
4. 如果 box 的最近深度仍在已有深度之后，则认为被遮挡。

### 7.3 Shade 的 progressive culling

Shade 不是只做 object-level culling，而是 progressive：

```text
instance → meshlet group → meshlet → triangle / rasterization primitive
```

这样可以做到：

- 大对象内部只画可见部分；
- shadow atlas 也能用类似 culling；
- 对复杂场景，GPU 实际处理的 primitive 大幅减少。

### 7.4 小 primitive culling

作者后来还做了 rasterization culling：如果 primitive 不会覆盖任何 texel center，就剔除。这类似“太小画不出来就别画”。

它只带来约 5% 的 primitive reduction，但实现简单，属于 almost-free win。

### 7.5 Apple Silicon 相关优化

2026-04 作者重做 occlusion culling 架构，因为：

- OneSweep prefix scan 在 Apple Silicon 上表现不好，导致 stutter / low FPS；
- HZB rebuild 在低端 GPU 上占用明显。

改造后在 M1 Pro、GTX 1080、RDNA2 iGPU 上都给出可跑 demo，并带来整体 10-15% FPS 提升；复杂场景收益更大。

---

## 8. Meshlet 架构与 WebGPU 没有 Mesh Shader 的替代方案

### 8.1 Meshlet 是什么

Meshlet 是一个小三角形簇，比如最多 128 triangles。

可以理解成：

```text
Mesh = many meshlets
Meshlet = local cluster of triangles + local bounds + compact geometry data
```

它的核心价值：

- 更细粒度 culling；
- 更好的空间局部性；
- 更适合 GPU 并行；
- 更适合 virtual geometry；
- 更适合 visibility buffer；
- 更适合 shadow / multi-view culling。

### 8.2 WebGPU 没有 mesh shaders

现代 native engine 可以用 mesh shader / task shader 管理 meshlet。但 WebGPU 没有 mesh shader，因此 Shade 需要自己用 compute + indirect draw 模拟。

基本思路：

```text
compute: filter mesh instances
compute: expand instances to meshlets
compute: compact visible meshlets
render: draw meshlets / triangles using indirect draw
```

### 8.3 Meshlet expansion 的 thread divergence 问题

#92 是重点。作者解释：如果一个 compute thread 负责展开一个 mesh，那么不同 mesh 的 meshlet_count 可能差异巨大。

例子：

```text
grass blade: 1 meshlet
high-poly tree: 7813 meshlets
```

如果同一个 thread group 里有的线程只循环 1 次，有的线程循环 7813 次，那么整个 group 会等最慢线程。GPU SIMD/SIMT 执行模式下，这就是 execution divergence。

### 8.4 作者的解决方案：meshlet batches

旧流程：

```text
filter meshes
expand meshes to meshlets
expand meshlets to triangles
draw huge triangle buffer
```

新流程：

```text
filter meshes
expand meshes to meshlet batches
expand batches / draw meshlets directly
```

其中 batch 例如最多 64 meshlets。这样一个百万三角 mesh 的 7813 meshlets 会被拆成约 123 个 batch，单个 thread 的循环压力降低很多。

### 8.5 Prefix sum / scan

作者提到实现了 efficient prefix sum shader，后续会迁移。Prefix sum 在 GPU compaction / allocation / output offset 里非常关键。

典型用途：

```text
visible flags: [1,0,1,1,0]
prefix sum:    [0,1,1,2,3]
compact out: visible elements packed contiguously
```

### 8.6 Meshlet compression

2025-10 后作者把 meshlet 管理重写为“meshlet 携带完整 geometry data”，并参考 Ubisoft / Alan Wake 2 / Unreal Nanite / Capcom RE Engine 等 meshlet compression 思路。

目的：

- 减少 GPU memory footprint；
- 降低 memory bandwidth；
- 减少 indirection；
- 数据可直接按 GPU uniform-like vec4u buffer 读取。

这属于现代 renderer 的典型方向：计算通常不是瓶颈，memory layout / bandwidth / cache coherence 才是。

---

## 9. Material Pass：用深度测试做材料分发，实现接近 0 overdraw

#86 里作者描述了一个很有意思的做法。

### 9.1 Visibility buffer 之后如何 shading

有了 visibility buffer 之后，每个 pixel 知道自己对应哪个 mesh/triangle。接下来需要执行材质 shader。

但 WebGPU 没有 bindless，材质/纹理切换仍然棘手。Shade 的做法是：

1. 从 visibility buffer 取 mesh_id；
2. 得到 material_id；
3. 把 material_id 写入某种 depth-like buffer；
4. 对每个 material 做一次 pass；
5. depth test 设置为 equal，只 shade 对应 material 的像素。

### 9.2 为什么说 0 overdraw

因为 material shader 只在最终可见 pixel 上运行，而且每个 pixel 只属于一个 material。换句话说：

```text
一个 pixel 最终只执行一次真正昂贵的材质 shading
```

这不是“几乎没有 overdraw”的口语表达，而是在 material shading 阶段接近严格意义的 0 overdraw。

### 9.3 代价是什么

代价是：

- 每个 material 需要 pass；
- material 数量很多时 draw/pass 数量上升；
- 需要维护 material ID buffer；
- 需要深度测试 hack / depth-like routing；
- 对 pipeline state / texture binding / shader variant 管理要求很高。

但作者认为，这比传统 forward renderer 的 per-object overdraw 和 material switching 更适合大场景。

### 9.4 111 materials ≈ 111 draw calls

在 archviz 场景中，有 111 unique PBR materials，作者说 draw call 数大致等于 material 数，加上一些固定 overhead。也就是说：

```text
draw calls ≈ material groups + fixed passes
```

而不是：

```text
draw calls ≈ mesh count
```

这就是 Shade 能在大量动态 mesh 下维持低 CPU overhead 的关键。

---

## 10. FrameGraph / RenderGraph：资源别名与后处理组织

### 10.1 FrameGraph 解决什么问题

现代 renderer 有很多 pass：

- visibility pass；
- depth pyramid；
- material pass；
- GTAO；
- SSR trace；
- SSR resolve；
- TAA；
- Bloom downsample/upsample；
- Auto exposure histogram；
- Tonemap；
- RCAS；
- shadow pass；
- GI sampling；
- debug views。

这些 pass 会产生大量临时 texture/buffer。手动管理会很痛苦。

FrameGraph 做的是：

```text
声明每个 pass 读什么、写什么
系统自动推导资源生命周期
自动复用/alias 临时资源
自动安排依赖
```

### 10.2 与 three.js 后处理的对比

three.js postprocessing 通常是手动 EffectComposer / Pass 链：

```text
RenderPass -> SSAOPass -> BloomPass -> OutputPass
```

临时 render target 复用需要开发者/Pass 作者自行处理。

Shade 的 FrameGraph 更像现代游戏引擎里的 render graph：

- 关掉某个效果时，相关资源自动消失；
- 资源 alias 自动发生；
- pass 之间的 dependency 更清楚；
- 后处理 stack 更容易稳定扩展。

### 10.3 Bloom 与 SSR 共享资源

作者在 Bloom 实现中提到只用两个 render targets 做 downsample/upsample，且 Bloom 依赖 RenderGraph，因此 render target 会被其它效果如 SSR 复用。

这体现出 FrameGraph 的价值：不是单个效果更快，而是整套 frame stack 的内存和资源调度更合理。

---

## 11. 后处理栈：GTAO、TAA、SSR、Bloom、RCAS、Auto Exposure

Shade 的后处理不是“用户手动拼插件”，而是内置统一 stack。

### 11.1 后处理列表

整帖里出现的后处理包括：

- GTAO / SSAO；
- Bent normals；
- TAA；
- FXAA fallback；
- SSR trace/resolve/reprojection/denoise；
- Bloom；
- ACES tonemapping；
- dithering；
- auto exposure / eye adaptation；
- RCAS sharpening；
- contact shadows；
- temporal upscaling / dynamic resolution 思路；
- blue noise / STBN。

### 11.2 为什么它必须统一设计

TAA、SSR、GTAO、Bloom、Auto Exposure 不是独立效果。它们共享：

- depth；
- normals；
- motion vectors；
- roughness / metalness；
- previous frame history；
- color pyramid；
- luminance downsample；
- noise sequence；
- disocclusion mask。

如果像传统 postprocessing 插件那样各自为政，很容易出现：

- ghosting；
- flicker；
- incorrect energy；
- aliasing；
- color space 错误；
- 重复 downsample；
- 内存浪费。

作者多次强调，TAA 是 intrusive technique：它要求整个 pipeline 都知道 TAA 的存在。

---

## 12. TAA：为什么它是整套系统的胶水

### 12.1 TAA 不是简单抗锯齿

在 Shade 中，TAA 不只是替代 FXAA/MSAA。它同时服务于：

- edge anti-aliasing；
- texture supersampling；
- noisy effects accumulation；
- SSR denoise；
- GTAO temporal stability；
- shadow / ray traced effects stability；
- dynamic resolution / temporal upscaling；
- background velocity stabilization；
- history rejection / disocclusion handling。

### 12.2 为什么 deferred renderer 不能直接用 MSAA

传统 MSAA 对 forward renderer 很自然，但在 deferred pipeline 中成本高、实现复杂。MSAA 会让 G-buffer 多采样，后处理也要处理多采样数据，成本和复杂度都高。

所以现代 deferred renderer 常常使用 TAA。

### 12.3 TAA 的主要问题

TAA 典型问题：

- smearing；
- ghosting；
- texture blur；
- history contamination；
- disocclusion artifacts；
- moving object trailing；
- specular shimmer。

作者说他读了大量 papers，花了很长时间调参，才做到“无明显 ghosting、不 smear”。

### 12.4 TAA 下的 texture sampling

#102 专门讲这一点。TAA 本身像 1 pixel 的时间模糊核，会让纹理变糊。作者做了两件事：

1. 从用于采样 material texture 的 UV 中正确移除 TAA jitter，让 UV 相对屏幕稳定。
2. 给 mip level 做 bias，让 TAA 的多帧采样收益反映到纹理 mip 选择上。

直观理解：

```text
如果 TAA 通过多帧 jitter 近似提高了采样密度，纹理采样也应该使用更清晰的 mip。
```

否则画面边缘抗锯齿了，但书本、砖墙、文字会糊。

### 12.5 YCoCg clamp

后续作者改进 TAA color clamp，利用 YCoCg 色彩空间的感知权重，让稳定性更好、ghosting 更少。

YCoCg 的好处是把亮度和色度分离，做历史裁剪/钳制时更符合感知。

### 12.6 Background velocity

作者还提到单独处理 background velocity，让背景在运动时不再轻微 smear。

这说明 Shade 的 TAA 不只是普通 history blend，而是有完整 motion vector / background / disocclusion 逻辑。

---

## 13. SSAO / GTAO / Bent Normals

### 13.1 GTAO 早期实现

主帖中作者说 SSAO 方案参考 GTAO paper 和 Intel 资源，使用 temporal/spatial blue noise，9 taps 就能得到不错效果。

关键 trick：采样 depth mip map。通过 depth mip，一个 tap 可以代表更大范围的贡献。例如 2 个 depth mips 可以让一次 tap 近似覆盖 16 pixels，5 mips 则能累计到更大范围。

### 13.2 GTAO 和 HBAO 的讨论

Page 9 有 HBAO vs GTAO 讨论。benjaminsuch 认为：

- HBAO 静态质量可以接近；
- HBAO motion 下 variance 更大，更容易 temporal ghosting/shimmer；
- GTAO 更贵一点，但时间差很小；
- GTAO 可输出 bent normals；
- bent normals 对 GI 有用；
- TAA 与 GTAO 的 temporal stability 协同更好。

作者也认同 HBAO/GTAO 概念上都属于 horizon-based AO，但具体实现和 temporal behavior 很重要。

### 13.3 Bent normals 的意义

Bent normal 不是几何 normal，而是“未被遮挡方向的平均方向”。

用于：

- ambient lighting；
- probe sampling；
- diffuse GI；
- IBL occlusion；
- 减少错误环境光。

Shade 把 GTAO 与 GI/PBR 整合，而不是简单在最终图上乘一层灰。

---

## 14. SSR：不只是屏幕空间反射，而是一个完整时空降噪问题

### 14.1 早期 SSR

作者最初以为 SSR 难点是 ray tracing / ray marching。后来发现真正难点在：

- hit resolve；
- blurred color mip chain；
- reprojection；
- compositing；
- denoising；
- energy conservation；
- roughness-aware sampling；
- reflection plane 不同导致 history projection 更麻烦。

### 14.2 SSR 的流程

一个完整 SSR 大致包括：

```text
1. 根据 depth/normal/roughness/metalness 生成 reflection ray
2. 在 screen-space depth/hiz 中 trace
3. 找 hit / 判断 miss / edge fade
4. 用 color mip chain resolve hit color
5. roughness-aware blur / filtering
6. temporal reprojection
7. variance-guided history mix
8. spatial denoise
9. 与 IBL / GI / direct lighting 按能量组合
10. 进入 TAA / tonemap / bloom
```

### 14.3 Blue noise / STBN

作者从 hash random 换成 scrolling 2D / 3D blue noise，并后续集成 STBN。Blue noise 的价值是：

- 噪声频谱更适合视觉；
- 与 temporal accumulation 更配；
- 不容易出现低频脏斑；
- 方便 denoiser/TAA 消化。

### 14.4 SSR ray reuse

2025-10 作者尝试 ray reuse：邻近 pixel 的 ray hit 可以被当前 pixel 利用，但要检查：

1. 当前 pixel 是否可能 cast 这条 ray；
2. 邻居 hit 是否可由这个 fake ray 产生；
3. 这条 ray 被采样的概率/pdf；
4. 是否符合 importance sampling；
5. mirror surface 情况不能弄糊。

这本质上是屏幕空间的 sample reuse / denoising 思路。它不能解决 SSR 看不到屏幕外信息的问题，但能让已有屏幕信息更充分，降低噪声。

### 14.5 SSR 的上限

SSR 永远有蓝色区域：即 screen-space trace 无论怎么做都拿不到的信息，例如屏幕外、被遮挡后方、背面。作者用 false color 展示了有效/无效 ray，说明 SSR 的上限不是算法调参能彻底突破的。

---

## 15. 阴影系统：从软件 ray tracing 到 CSM / contact shadow

### 15.1 早期 ray-traced shadows

作者早期尝试软件 ray traced shadows。WebGPU 没有原生 RTX API，所以他用 compute shader 做 BVH traversal。

发现：

- 没命中的 shadow rays 最贵，因为要遍历很多节点才能确认没有遮挡；
- compute shader 软件 traversal 远慢于硬件 RT；
- native RTX 有命令排序、专用 BVH traversal hardware、硬件 intersection、专用 BVH format/compression。

所以早期 ray traced shadows 画质好，但低端 GPU 成本高。

### 15.2 Shadow map 优化

后来作者转向 CSM / shadow maps，并优化：

- shadow atlas HZB culling；
- primitive rasterization culling；
- meshlet culling；
- alpha-tested vegetation 的阴影；
- cascade blending；
- contact shadows 补高频细节。

### 15.3 CSM cascade selection

作者的 CSM 不按传统 view depth 直接选 cascade，而是“尽可能晚切换 cascade”，优先使用最高可用分辨率 cascade。

这样可以利用已经计算出的高分辨率 shadow texels，获得感知上约 20-50% 的阴影分辨率提升。

难点是 cascade blending：如果按 projection matrix 选择 cascade，blend 不再平凡。作者花时间做出 forward-only blend。

### 15.4 Contact shadows

Contact shadows 用屏幕空间短 ray 修复 shadow map 缺失的接触细节。

特点：

- 只 trace 几个像素距离；
- 用于补高频细节；
- 成本低；
- artifact 随 tracing 距离增加而增加；
- deferred pipeline 中便宜，因为只 shade visible pixel。

### 15.5 Omnidirectional shadows

Sun Temple 场景里有点光源穿透的问题，作者解释那不是 GI leak，而是 point light 没有 shadow。后面他也承认需要尽快做 omni-directional shadows。

---

## 16. 光照模型、BRDF、Specular AA、Shadow Terminator

### 16.1 Burley vs Lambert vs Oren-Nayar

作者尝试 Oren-Nayar diffuse。Oren-Nayar 对粗糙漫反射表面（砖、粉笔、织物）更物理，但画面显得更 flat，边缘/掠射角的明暗变化减少。

作者最后仍倾向 Burley，因为：

- 更有深度感；
- 视觉更讨好；
- 生产里更常用；
- EON/Oren-Nayar 虽然物理更讲究，但如果不引入 fuzz/sheen/subsurface 等更多参数，整体未必更好。

### 16.2 Specular anti-aliasing

作者实现了基于 NVIDIA “Filtering Distributions of Normals for Shading Antialiasing” 的 specular AA。

问题背景：高频 normal map / 几何细节会导致 specular aliasing，尤其是 motion 中闪烁。Specular AA 通过过滤 normal distribution，让 roughness / normal variance 进入 shading，降低高光闪烁。

作者也展示 Shade 与 three.js 在齿轮/金属边缘上的对比，认为 three.js aliasing 很明显，运动中更糟。

### 16.3 Shadow terminator

作者测试多个 shadow terminator fix：

- Disney / Burley 相关论文；
- Estevez microfacet-based shadowing function；
- DreamWorks 的 targeted softening。

后来从 ray-traced shadows 转到 shadow maps 后，发现 terminator fix 额外收益很小，因此当前禁用。这个结论很重要：不是所有 paper technique 在具体 pipeline 中都有足够收益。

---

## 17. 天空、大气、HDR、Tonemapping、自动曝光

### 17.1 物理天空

作者把 sky simulation 集成进 direct lighting 和 path tracer/GI。模型基于 Epic Games / Sébastien Hillaire 的 scalable production-ready sky/atmosphere technique。

考虑因素包括：

- altitude；
- Mie scattering；
- Rayleigh scattering；
- ozone absorption；
- multiscattering；
- sun position；
- sun color/intensity。

### 17.2 Octahedral environment map

作者不喜欢 equirectangular 和 cube map，选择 octahedral projection：

优点：

- 单张 2D texture；
- texel 利用率高；
- 边缘 angular error 更低；
- 写入/卷积/滤波更方便；
- shader 里 mapping 便宜。

### 17.3 ACES / exposure / gamma

作者使用标准 ACES tonemapping，不使用传统 ambient hack，目标更物理。

论坛讨论里有人觉得画面偏暗。作者解释现代 GI renderer 需要更真实/更强的 light intensity 来产生室内亮度，不像 three.js ambient term 那样简单把阴影抬亮。

典型输出流程：

```text
linear scene color
→ exposure
→ tonemapping
→ OETF / gamma
→ display
```

### 17.4 Auto exposure / eye adaptation

2026-01 作者加入自动曝光：

1. 在 log luminance 空间构建 histogram；
2. 排除最低/最高一部分 luminance；
3. 计算平均场景亮度；
4. 以 0.18 mid-gray 为目标计算 exposure scale。

因为 Bloom 已经有 downsample pass，所以可复用低分辨率稳定图像来构建 histogram，性能几乎免费。

---

## 18. GI：从 DDGI 到 Sparse Volumetric Light Map

这是整帖最庞大的技术线之一。

### 18.1 早期 light probe volume

作者把之前在 WebGL/JS 里的 light probe volume 移植到 WebGPU。早期展示 Sponza with probes / without probes / probe contribution。

关键点：

- probes 实时增量更新；
- 没有传统离线 bake；
- load scene 后，每帧给一部分 probe 发 ray；
- lighting 改变后 probes 会逐渐更新；
- color bleeding 明显改善氛围；
- 但有 light leak / deringing / self-shadowing 问题。

### 18.2 DDGI 的基本结构

DDGI = Dynamic Diffuse Global Illumination。作者后来解释它的 leak control 包括五部分：

1. probes 分 cells，cells 提供 locality；
2. 每个 probe 有自己的 depth map，用于 probe visibility；
3. probe weighting 时考虑 surface normal；
4. sampling 时做 parallax correction；
5. 做类似 parallax occlusion mapping 的 refinement。

### 18.3 Radiance atlas 替代 spherical harmonics progressive update

作者从 spherical harmonics 进展不顺，转向每个 probe 存 octahedral map atlas。

做法：

- probe 存 radiance；
- rendering probe 时用 ray tracing 生成 G-buffer；
- probe texel shading 时再次采样 probes；
- 因此获得 infinite bounce；
- 最终再把 radiance 过滤/转换为 irradiance。

### 18.4 Specular GI

作者意识到 probe atlas 里其实是 radiance，不只是 diffuse irradiance，因此可以做 specular indirect。

重要观点：传统 environment map reflection 不做 visibility，容易出现错误反射。Radiance probe / GI cache 可以提供带局部可见性的 specular response。

### 18.5 Probe placement 与 light leak

Probe 固定在网格点会造成问题：

- probe 可能落在墙体内部；
- probe 太靠近表面会 oversample；
- 表面两侧最近 probe 突变会造成 lighting discontinuity；
- light leak 比轻微 lighting shift 更显眼。

作者的策略：

- bake 时把 probe 推离/推出表面；
- sampling 时仍用原隐式网格位置；
- 这引入 bias，但抵消网格本身带来的更严重 bias；
- 如果从原位置到目标位置 raycast 碰撞，则移动到中点，避免 worsen aliasing。

### 18.6 Sparse Volumetric Light Map（SVLM）

2026-01 作者开始做 SVLM。它不是 UE 的直接复刻，但思路类似：稀疏 3D probe structure。

关键参数：

- 4x4x4 probe grid；
- intermediate nodes 也有 64 branching factor；
- 限制总内存和最低 LOD；
- 每 probe 存 second-order spherical harmonics，9 coefficients；
- RGB 通道用 RGBE9995 编码；
- GPU bake；
- probe compression；
- diffuse + specular；
- 支持 streaming/demo 中直接进 GPU memory。

### 18.7 SVLM 数据点

帖子里出现的数据：

- 1MB limit 下 Bistro：609 nodes，24,025 unique probes，38.36% probe reuse；
- 363,722 SH probes，RTX 4090 上 GPU bake 14s；
- bake settings 1024 samples/probe，7 bounces；
- 后续 324,674 probes，16,384 samples/probe，20MB VRAM，267s bake；
- 新 compression：26 bytes/probe，之前 56 bytes/probe；
- demo lightmap 2.2MB，60,826 probes，7 bounces，32,000 samples/probe；
- diffuse+specular GI runtime 约 0.1ms；
- specular 部分曾测到 0.05ms at 1080x1080 on RTX 4090。

### 18.8 Specular SVLM

作者用 SH3 probes + GGX ZH basis 做 specular component。为了避免每 pixel blend 8 corners，使用 reservoir sampling 每 pixel 抽 2 个 unique probes。

受 NVIDIA “Stochastic Texture Filtering” 启发。

作者测试 parallax correction 后认为 SH3 angular resolution 太低，SVLM spatial resolution 已经较高，parallax correction收益不明显，因此删掉，少做 GPU work。

---

## 19. Path Tracer：GI bake、debug、累积 path tracer

### 19.1 WebGPU storage buffer 限制

早期作者实现 path tracer 时遇到 WebGPU storage buffer 数量限制。Path tracer 需要在一个 compute shader 里访问：

- mesh instances；
- geometries；
- materials；
- geometry attributes；
- indices；
- lights；
- TLAS nodes；
- BLAS nodes；
- BLAS lookup pointers；
- output buffers。

这些很快超过默认 8 个 storage buffers 的限制。

作者的解决方向是把多个数组打包进一个大 input buffer，用自定义 memory/data model。

### 19.2 Path tracer 的用途

早期作者明确说 path tracer 主要用于构建 irradiance cache / GI，不是 viewport renderer。

原因：

- 真实 path tracing 要大量 samples per pixel；
- 即便有 RTX API，实时 path tracing 高质量仍难；
- WebGPU 软件实现成本更高。

### 19.3 Temporal / spatial denoising

作者用 path tracer 做 ray-traced soft shadows 和 GI 时，也在做 denoiser：

- early version 只有 single-frame spatial denoise + TAA；
- temporal accumulation 未完成时会 flicker；
- 后续 SSR / ray effects 都持续改 reprojection 和 variance guidance。

### 19.4 累积 path tracer

2026-04 作者做了 accumulating path tracer，用于 debug / visualization：

- camera change 时 reset accumulation；
- 使用 biased exponential moving average；
- 每帧 1 path；
- 无 denoiser；
- 1 path/frame 线程分歧更低，性能更好；
- 加入 light PDF 到 MIS 后早期收敛更快；
- 加 tile 适配低端 GPU；
- de-blocking 用 mip-chain flood fill 保持整体 brightness，避免 pinholes。

---

## 20. Texture / Mipmap / Alpha / Bindless 缺失

### 20.1 WebGPU 没有 bindless textures

这是 Shade 的痛点。作者在讨论 `CompressedArrayTexture` 时说 texture array 有几个问题：

- 所有 texture 尺寸必须一致；
- layer count 有上限，例如默认 256；
- Bistro 这类场景可能有 400 textures；
- 不同格式/通道数难统一；
- software sampling 比 hardware sampling 慢接近一个数量级；
- cache utilization 差。

最佳答案本来是 bindless textures，但 WebGPU spec 暂时没有。

### 20.2 Texture array atlas 的折中

作者在 ray tracing path 中做过 texture array atlas：

- fixed texture resolution 128x128；
- 跳过 mipmaps；
- 把多个 textures pack 到 layer；
- 对 GI/ray tracing 够用；
- 但不能用于一般材质渲染。

### 20.3 Virtual textures

作者认为 virtual textures 是可行替代：

- 物理 texture 小；
- GPU cache utilization 好；
- 可管理内存；
- 但实现复杂；
- 作者以前在 WebGL 实现过，但真正做好仍然很大工程。

### 20.4 Mipmap generation

作者不满意标准 box/linear mipmap，因为会糊。

尝试过：

- Mitchell-Netravali；
- Catmull-Rom；
- Wronski 2021 kernel；
- MKS / Magic Kernel Sharp；
- Linear baseline（三.js 使用的普通生成方式）。

结论演化：

- 2025-12：Mitchell 比普通线性更保细节；
- 2026-03：MKS 更好地抑制 ringing / moiré，成为 color textures 默认 filter；
- MKS 比 Mitchell 柔一点，但更稳；
- mipmap generation 更慢，但 runtime 不受影响。

### 20.5 Alpha texture darkening

Alpha-tested vegetation 在 mipmap 中会变暗，这是常见问题。作者实现 alpha pre-multiplication pipeline，使草、树等 alpha-tested 内容在 mip 后保持亮度/覆盖感。

---

## 21. 自定义场景格式与流式加载

### 21.1 为什么不直接用 glTF

glTF 很通用，但不是 Shade 最优 runtime format。

Sponza glTF 数据：

- JSON metadata 171KB；
- binary buffer 9.08MB；
- 68 textures，JPEG/PNG，总计 37.4MB；
- glTF 总计 46.6MB；
- 加 8K HDR environment 96.9MB；
- 加预构建 BVH；
- 不含 BVH 已经 143.5MB。

### 21.2 Shade format

作者重新压缩 textures，但不降分辨率，使用 engine geometry format 和 per-meshlet compression。

结果：

- geometry + textures + materials + env map + BVH：29.5MB；
- ZIP/GZ 类压缩后：16.0MB；
- 数据无需额外 decode，网络加载后直接进 GPU；
- Sponza demo 整个 scene 29MB；
- volumetric light map 2.17MB，并行加载，直接进入 GPU memory；
- 无 shader compilation；
- 无昂贵 texture decode；
- time to first frame 很低。

### 21.3 Fully streaming engine

Page 9 作者回答：Shade 是 fully streaming engine。

这意味着：

- geometry/textures 可以按需加载；
- asset 不必一次性全进内存；
- scene format 为 GPU runtime 设计；
- custom pipeline 对商业 renderer 很重要。

---

## 22. GPU Animation / GPU Skinning

最后阶段作者开始做 animation system。

目标不只是 GPU skinning，而是整条动画链都在 GPU：

- curves；
- tracks；
- animation clips；
- bindings；
- current playback time；
- node hierarchy；
- local transforms；
- world transforms；
- bounding volume updates；
- dynamic add/remove/modify；
- skinning。

他还写了 GPU-side database，把多种数据类型放到一个 buffer 中。

示例数据：

- 786,655 total meshes；
- 100 individual roots；
- 324 characters，各自有 skinning information 和独立 timeline，无 instancing；
- 2,500 characters 的 skinning demo。

这和 three.js 的 CPU-side animation mixer / skeleton update 思路完全不同。Shade 是把动画更新也纳入 GPU-resident scene 的一部分。

---

## 23. 与 three.js 的系统性对比

### 23.1 抽象层级不同

three.js：

```text
Object3D / Mesh / Material / Geometry / Texture
```

Shade：

```text
GPU scene database / meshlets / visibility buffer / frame graph / GPU passes
```

three.js 是用户友好的 scene graph framework。Shade 是高度集成的 renderer。

### 23.2 Draw call 模型不同

three.js：

```text
mesh count / material count / shader variant → draw calls increase
```

Shade：

```text
GPU visibility pipeline + material groups → draw calls mostly bounded by passes/materials
```

### 23.3 Culling granularity 不同

three.js 通常：

- object-level frustum culling；
- 无内置 GPU occlusion culling；
- 大 mesh 内部不可见部分仍然作为整体处理；
- instancing / batching 需要用户设计。

Shade：

- GPU instance culling；
- GPU meshlet culling；
- HZB occlusion；
- shadow pass 也复用 culling；
- small primitive culling；
- dynamic spatial structures。

### 23.4 后处理整合不同

three.js：

- EffectComposer / examples / third-party；
- 组合自由；
- 但统一 motion vectors / TAA / SSR / GI / tonemapping 很难；
- 很多效果 image-level，不一定 PBR aware。

Shade：

- opinionated full frame stack；
- TAA 是 pipeline-wide；
- SSR、GTAO、Bloom、Exposure、Tonemap 互相协作；
- less flexible but more coherent。

### 23.5 光照/GI 不同

three.js：

- LightProbe 类只是拼图的一小块；
- 没有完整 volumetric GI；
- lightmaps 依赖外部 bake 和 UV2；
- specular GI 基本不是内置能力；
- ambient/environment 常常是 hack / IBL 近似。

Shade：

- in-engine software ray tracing；
- DDGI / SVLM；
- diffuse + specular volumetric lightmap；
- probe visibility / depth / parallax / compression；
- GPU bake；
- 运行时低成本采样。

### 23.6 API 哲学不同

three.js 的强项是：开放、灵活、适合多数 Web 3D 需求。

Shade 的强项是：固定、更少分叉、更像游戏引擎渲染后端。

如果你要做产品展示、普通 3D 页面、数据可视化，three.js 更合适。

如果你要做浏览器 AAA-like 场景、大规模动态对象、复杂 GI/shadow/postprocess，Shade 这种架构更接近目标。

---

## 24. 与 WebGPURenderer / TSL / NodeMaterial 的对比

### 24.1 WebGPURenderer

作者认为 WebGPURenderer 的代码简洁，方向合理，但架构仍传统。

它可以提供 WebGPU backend，但不会自然变成 GPU-resident renderer。

### 24.2 NodeMaterial

作者认可 node-based language 的潜力，但认为低层 node API 如果没有极强 UI 支撑，会变成 pain with no gain。

他提到 Unity / Unreal 的 shader graph 之所以可用，是因为有复杂节点和可视化 UI。但纯 API 层 node shader 对写复杂 SSR/TAA/GI shader 的开发者未必更清晰。

### 24.3 TSL

作者对 TSL 的看法：

优点：

- 可跨 WebGL / WebGPU；
- 提供模块化；
- 对某些用户可降低门槛。

缺点：

- 抽象不是免费的；
- 增加编译/翻译开销；
- bundle 更大；
- startup 更慢；
- 低层开发时表达力可能受限；
- 针对多个 backend 时容易变成 lowest common denominator。

作者不是说 TSL 一定坏，而是说它需要更完整 tooling，尤其是 UI，否则作为低层 shader 编程接口并不理想。

### 24.4 Raw WGSL 与作者的选择

作者也不喜欢 WGSL，但认为它是 standardized pain：

- 有标准；
- 有参考资料；
- 直接表达 WebGPU 能力；
- 不需要自己承受多 backend translation 的损失。

他自己写了非常简单的 WGSL module/chunk 系统，用依赖关系拼 shader code。

---

## 25. 与 Babylon.js / PlayCanvas / Unity / Unreal 的对比

### 25.1 Babylon.js / PlayCanvas

作者认为 Babylon / PlayCanvas 有很多功能，但整合程度和画质稳定性不够。

例如 Babylon 有：

- Reflective Shadow Maps；
- IBL shadows；
- SSR；
- TAA。

但问题是这些技术常常相互独立，不能自然组合成统一 frame stack。

作者批评 Babylon 的一些 demo aliasing 严重，TAA 也不够稳定。当然 trusktr 指出 Babylon demo 可能没有按 devicePixelRatio 渲染，作者承认提高 DPR 后更好，但仍认为问题存在。

### 25.2 PlayCanvas

PlayCanvas 有 lightmaps / clustered 等能力，但作者认为 lightmaps 依赖用户提供 UV unwrap，通常缺少 specular response。

### 25.3 Unity / Unreal

Shade 的技术目标显然更接近 Unreal/Unity 高端渲染栈，但 Web 部署条件不同：

- Unity WebGL/WASM bundle 重；
- 许多 native/desktop 特性不能算 browser capability；
- Unreal/Nanite/Lumen/VSM 是强参考，但不能直接搬到 WebGPU；
- Shade 是纯 JS/WebGPU 方向。

作者做的 comparison table 也强调只比较 web-deployed browser capability。

---

## 26. 性能数据与 Benchmark 解读

### 26.1 百万 mesh 基准

早期 benchmark：

- 1,000,000 individual meshes；
- 每个 cube 12 triangles；
- 总三角 12M；
- 实际 rasterizer 只画约 1,090,040 triangles，约 9%；
- RTX 4090 GPU utilization 约 34%；
- 144 FPS（屏幕 cap）；
- CPU frame 约 1.4ms，含 postprocess；
- 加 1000 random materials 仍 144 FPS；
- 加 10,000 unique geometries 仍 144 FPS，CPU sample 约 1.13ms。

意义：Shade 的瓶颈不在 mesh count / draw call count，而在 GPU 实际可见工作量。

### 26.2 Archviz demo

2025-05 archviz scene：

- 170MB；
- 158 textures；
- 223 meshes；
- 446,446 triangles；
- 21 lights；
- 111 unique PBR materials。

draw calls 大致 111，即 material 数。

### 26.3 GI demo 用户反馈

March 2025 demo：

- GTX 1660：GI off 30 FPS，GI on 18 FPS；
- RTX 4060：GI off ~80 FPS，GI on ~40 FPS；
- RTX 2070 Super / Ubuntu 用户也反馈性能数据。

这说明软件 RT / GI 当时仍明显吃性能。

### 26.4 Blender 3.3 splash torture scene

场景数据：

- Mesh count：374,734；
- Unique geometries：353；
- Total polycount：717,869,562 triangles。

作者后期称：

- Shade 曾经 21 FPS；
- 后来 46 FPS；
- frame time 约 21.74ms；
- 含 shadows、volumetric light map 等；
- three.js 在该场景约 3671ms；
- Shade 约快 168x。

这个对比要谨慎看：它是一个极端 torture scene，最能放大 CPU-driven per-mesh draw 的劣势。

### 26.5 April 2026 demo 性能

Demo A/B：

- A full resolution；
- B performance upscale，60% internal resolution。

数据：

- Apple M1 Pro：A 32 FPS @ 3456x2234；B 47 FPS；
- GTX 1080：B 61 FPS @ 3840x2160；
- RDNA2 iGPU：A 19 FPS @ 1080x1080；B 33 FPS。

feature stack：

- GTAO；
- Bent Normals；
- Volumetric Lightmap diffuse & specular；
- Bloom；
- Auto Exposure；
- 3-cascade CSM。

---

## 27. 按楼层 / 时间线完整整理

这一节按帖子顺序整理所有技术上有意义的内容。非技术的称赞、追问、表情类回复只在影响上下文时记录。

### Page 1：#1 - #16，项目宣言、百万 mesh、shadows、语言选择

#### #1：项目公开

作者说明想做一个有 three.js 易用性、Unreal 级别功能的 WebGPU graphics engine。核心目标：occlusion culling、GPU draw dispatch、visibility-based deferred shading、postprocessing、GI。展示早期截图，说明 TAA/GTAO/FrameGraph/visibility pipeline 已经有雏形。

#### #2/#4/#5：社区反应

社区认为这是 WebGPU 真正承诺的方向，即 end-to-end / AZDO-style pipeline。也有人说 three.js 更像工具箱/框架，而不是完整高端引擎。

#### #6：与 three.js 对比图

作者展示同一 bookshelf scene 在 three.js 和 Shade 中的对比，强调 AA / texture filtering / TAA mip bias 的差异。项目不准备马上开源。

#### #7：百万 dynamic meshes

作者展示 1,000,000 individual meshes，无 instancing/batching，12M triangles，实际只 rasterize 约 9%，144 FPS，CPU frame 约 1.4ms。随后加入 1000 materials、10,000 geometries 仍维持类似性能。

#### #8/#9：ray-traced shadows

作者尝试 shadow solution，原本考虑 VSM，但觉得复杂且难避免多次绘制，转向 ray traced shadows。热力图显示 miss rays 最贵。结论：ray traced shadows 可行，但未来要做 VRS、upscaling、occluder caching、ray length limiting/SDF fallback。

#### #10-#14：代码、移动端、中端设备、透明

有人问代码，作者再次说明暂不开源。透明还没处理，未来先 alpha masking，再 forward transparency pass。depth peeling 暂不考虑，因为额外 rasterization 和 memory 成本不合目标。

#### #14：复杂度与 three.js 维护哲学

作者说 three.js 没有 spatial index、light probe volume 等，不是因为 three.js 差，而是因为这些功能复杂、维护成本高、开源项目难以长期维护。three.js 的简单是优势。

#### #15/#16：商业化与语言

作者目标是 license。语言选择 JS 而非 TS/WASM。原因：JS 原生、JSDoc 足够、TS 需要编译、WASM debugging/compile/browser API/multithreading/SIMD 等不满足他的偏好。性能慢时用 C-like JS 写法，可接近 WASM。

### Page 2：#23 - #41，path tracer、DDGI、SSR、sky、specular AA

#### #23：path tracer 与 storage buffer 限制

WebGPU storage buffer 数量限制暴露：path tracer 需要 instances、geometries、materials、attributes、indices、lights、TLAS、BLAS、lookup 等，轻易超过默认限制。作者倾向把数据打包进大 buffer。

#### #28：temporal denoiser / ray-traced soft shadows

path tracer 改进后，作者做 temporal denoiser。当前主要依赖 spatial denoise + TAA，temporal accumulation 未完成，有 flicker。

#### #29：light probe volumes

移植 light probe volumes。Sponza with/without probes 对比显示 color bleeding 和暖色 bounce。Probe rendering 是实时增量的，不是离线 bake。

#### #30：DDGI 进展与 artifact

移植 DDGI 到 GPU，仍有 probe boundaries、leaks、self-shadowing。作者讨论 probe placement、bias、grid resolution 对结果影响。

#### #32-#35：SSR 早期

作者做 SSR。发现难点不只是 ray tracing，而是 hit resolve、blurred color mip chain、reprojection、compositing。换用 blue noise，修 BRDF 和 ray marching bug，加入 spatial denoise。

#### #36/#37：画面偏暗、ACES、无 ambient

社区问为什么画面暗。作者说明有 ACES tonemapping，但刻意避免 handwavy ambient term，希望尽量物理。

#### #37：sky/atmosphere/environment

作者完成 environment support，与 sky simulation 整合。使用 Epic/Hillaire sky technique，采用 octahedral projection 做 environment map。

#### #39/#40：specular AA

社区指出金属边缘问题。作者发现 specular antialiasing 有 bug 并修复，基于 NVIDIA normal distribution filtering。展示 Shade vs three.js specular aliasing 对比。

#### #41：SSR reprojection

作者展示 raw SSR、1/2/3 pass spatial denoise、temporal denoiser、variance-guided history mix、TAA 后结果。说明 noisy input 经过合理时空处理能非常稳定。

### Page 3：#44 - #61，WebGPURenderer、TSL、Bloom、demo、开源争议

#### #44：WebGPURenderer 批评

作者认为 WebGPURenderer 方向合理、代码简洁，但 three.js 仍是 traditional rendering architecture。Shade 目标是 GPU-resident renderer，可实时渲染百万 instances，CPU overhead 很低。

#### #44：NodeMaterial/TSL 观点

Node-based language 要有高级 UI 才有价值。低层 node API 写 SSR 等复杂 shader 不一定比 WGSL/GLSL 清晰。TSL 是 WGSL with extra steps；跨 backend 有抽象/编译/bundle 成本。

#### #44：SSRNode 评价

作者认为 three.js SSRNode 是 toy/teaching tool：step-wise depth ray marching、basic denoise，但非物理、不 respect StandardMaterial、不 energy-preserving。

#### #47-#50：TSL 深入讨论

作者说 TSL 提供跨 API 和模块化，但抽象牺牲语义能力，增加编译/下载成本。多 target 容易 lowest common denominator。不是说 TSL 坏，而是需要更多 tooling。

#### #57：Bloom

加入 Bloom：HDR、5 mip levels、progressive blur、无 threshold、13 taps、Karis/luma filtering，2 render targets，依赖 RenderGraph 资源复用。

#### #59：demo 发布与功能列表

demo 包括 GTAO、SSR、TAA、Bloom、ACES、soft RTX shadows、GPU-driven draw、HZB culling、progressive frustum culling、small primitive culling、depth-buffer-based material evaluation、IBL diffuse、physically-based sky、specular AA、Burley diffuse。

#### #61：为什么不进 three.js

作者说明架构差异太大、复杂度高、不会只有他维护、最终商业化，因此不适合贡献到 three.js。

### Page 4：#62 - #81，demo feedback、Oren-Nayar、HDR env、GI/specular probes、benchmark

#### #63：Firefox 与 RTX 性能

Firefox 主版本当时 WebGPU 支持不完整。低端 GTX1050 上 RTX/shadows 性能差。作者解释 compute shader 软件 RT 缺少 native RTX 的 sorting、专用 traversal、硬件 intersection、专用 BVH format。

#### #66：Oren-Nayar

作者测试 Oren-Nayar vs Burley。Oren-Nayar 更 flat，物理上可能更准确，但视觉深度感弱，生产里少用。作者保留 Burley。

#### #72：TAA/MSAA/FXAA 解释

作者说明 TAA edge 稳定，FXAA 只是每帧猜边缘，MSAA 很好但成本高、与 deferred/postprocess 不友好。

#### #73：测试场景与 postprocess 拆解

展示 vroom vroom 场景，开关 postprocessing/GI/AA。说明 SSAO 负责很多 contact shadow，SSR 让金属更有质感，GI 让画面更暖。

#### #74：HDR environment maps 与 octahedral projection

加入 HDR env maps，GI 加 infinite light bounce。环境图从 equirectangular 转 octahedral，便于 convolution/write/filter。

#### #74：probe atlas 与 infinite bounce

从 SH progressive update 转为每 probe octahedral atlas。probe G-buffer ray tracing 后再 shading，probe shading 采样其它 probes，得到 infinite bounce。

#### #75/#76：specular GI / parallax correction

作者用 radiance probes 替代 environment map sampling，获得带 visibility 的 specular indirect。加入 parallax correction 到 specular reflections。

#### #77-#81：GI demo benchmark

作者发布 demo 求性能数据。用户反馈 GTX1660、RTX2070 Super、RTX4060 等数据。作者调整 bytesPerSample 从 64 到 32，修 console stats。

### Page 5：#82 - #101，archviz、visibility pipeline、bindless、meshlets、SSR ray reuse、alpha/mipmap/shadows/meshlet compression

#### #84：archviz demo

实际 Blender archviz scene，170MB，158 textures，223 meshes，446k triangles，21 lights，111 PBR materials。

#### #86：Shade frame breakdown

关键楼层。作者解释 frame：instances culling → meshlet expansion → triangle/meshlet rasterization → visibility buffer → depth pyramid → maybe set → second rasterization → material pass。draw calls 约等于 material 数。

#### #86：bindless 缺失

讨论 texture array / CompressedArrayTexture。问题是统一尺寸、layer limit、Bistro 400 textures、maxTextureArrayLayers 256。最佳是 bindless textures，但 WebGPU 没有。virtual textures 是未来方向。

#### #88：texture atlas/layer packing 复杂性

作者解释 2D/3D allocator、preallocation、cache、software sampling、texture format/channel waste 等问题。越逆硬件/API 而行，痛苦越大。

#### #91：新 demo：MBOIT、CSM、clustered lighting

加入透明 MBOIT、CSM、clustered lighting。每个蜡烛都是 dynamic point light。

#### #92：meshlet expansion 重构

关键楼层。Shade 是 meshlet-based resident renderer。旧流程 mesh→meshlets→triangles，后来去掉 triangle buffer，直接 draw meshlets。解释 thread divergence，加入 meshlet batch 降低单 thread 长循环。

#### #94：GPU coherence 教学

作者解释 GPU conditional/loop divergence、execution coherence、memory coherence、cache locality。这个楼层很适合当 GPU 编程教学材料。

#### #98：Shade vs three.js 根本差异

作者回应说 Shade 是 GPU-driven，three.js 必须每个 mesh 发 draw command。Shade 用 visibility buffer 和 depth-based material sorting，shading 0 overdraw。

#### #100：SSR ray reuse

作者做 SSR 邻域 ray reuse，用 fake ray validity、hit normal、pdf、importance sampling 判断可复用性。减少噪声，让 denoiser 更容易工作。

#### #101：alpha testing、shadow terminator、shadows、meshlet compression

实现 alpha pre-multiplication 修 alpha mip darkening；测试 shadow terminator fix 后认为 shadow map 下收益不大；优化 shadow map rendering，HZB culling 获得约 20% surviving primitives reduction；性能从 72 FPS 到 101 FPS；重写 meshlet compression。

### Page 6：#102 - #121，TAA texture、mipmap、pipeline state、contact shadows、Babylon 对比、DDGI leak explanation

#### #102：TAA texture sampling

改进 TAA UV 稳定性和 mip bias。对比 Shade vs three.js MSAA，作者认为 TAA 通过足够数学处理能在清晰度和稳定性上超过 native MSAA。

#### #103：Sponza demo 与 TAA/STBN/hashed alpha

改进 TAA filtering speed，整体 perf up 20%；YCoCg clamp；SSR combine；infinite far plane；hashed alpha performance up 20-40%；background velocity 更稳定；集成 STBN。demo 只有加载 GLTF 和设置 camera，shadow/postprocess 自动。

#### #104：Mitchell mipmaps

重做 mipmap generation。普通 box/linear 会丢细节，Unity/Unreal 使用 Mitchell-Netravali。Shade 加 Mitchell 后书本/文字更清晰。

#### #105：pipeline state management

GPU-resident draw 不能随意切 raster state。不能在一次 draw 中切 triangles/points、winding order、culling side。因此需要 pipeline state grouping/management。

#### #106/#107：contact shadows

作者从过去 RTX shadow + screen-space fallback 的经验中抽取短距离 screen-space contact shadow，用 CSM 补微细节。也测试所有 light 的 screen-space shadows。

#### #111/#112：Babylon/PlayCanvas/Unity/three.js 对比

作者说 Babylon/PlayCanvas 功能孤立，后处理/GI 支持不够整合。Babylon SSR/RSM/TAA demo 有 aliasing/ghosting 等问题。three.js 对某些简单任务反而更合适，比如 point cloud、volume、iso surface，可用旧版 three.js 也足够。

#### #116：DDGI light bleeding 解释

作者解释 GI leak：cells、per-probe depth map、normal visibility、parallax correction、refinement。展示 PicaPica、Sibenik、Breakfast room 等测试。

#### #118-#121：gamma/exposure 讨论

社区觉得图暗。作者解释 exposure 与 tonemapping，曾使用 2.2 exposure boost 但会过早压缩 colors。讨论 archviz linear workflow、gamma、artistic preference。

### Page 7：#122 - #141，auto exposure、CSM、Meep、SVLM 初版

#### #124：色彩、曝光、目的、显示器

作者系统解释 output shader：linear scene color → exposure → tonemap → OETF/gamma。图像亮暗与 taste、purpose、monitor、HDR、观看环境都有关系。

#### #129：auto exposure

加入 eye adaptation：log luminance histogram，排除最低/最高，target mid-gray 0.18。复用 bloom downsample 图构建 histogram，性能几乎免费。

#### #132：Gaussian splats

社区提到 splats。作者认为 Gaussian Splats 很强，但应用有限，目前主要用于渲染 splats 本身，尚未广泛成为实时渲染主线组件。

#### #133：CSM cascade blending

作者做出 cascade blending，选择 cascade 尽可能晚切换，以使用更高分辨率 shadow texels。传统 view-depth cascade 会浪费高分辨率 texels。

#### #137/#139：Meep 与 Shade

Meep renderer 是基于 heavily modified three.js，Forward+、postprocess、decals、particles、virtual textures 等。Shade 是从零实现，无第三方依赖。作者给出 Meep EngineHarness 基本项目和 ShadedGeometry 示例。

#### #140：SVLM 初版

Sparse Volumetric Light Maps：4x4x4 probe grid，64 branching factor，限制 memory/LOD。每 probe 存二阶 SH，RGBE9995。1MB memory 下 24,025 unique probes。

#### #141：SVLM baking

加入 GPU bake：363,722 SH probes，RTX4090 14s，1024 samples/probe，7 bounces。

### Page 8：#142 - #161，probe placement、SVLM compression/specular、MKS mip、occlusion rewrite、comparison table

#### #142/#144：probe placement optimization

确保 surface 附近 C0 continuity，purge incomplete node levels；优化 probe 实际 bake 位置，减少 light leak。28,376 probes 只占 1.8MB VRAM。

#### #145：sample/bounce 讨论

7 bounces 有些 overkill，通常 3 bounces 得到 90% lighting。复杂场景为了 uniform nearby samples 需要很多 samples，4k 左右开始收敛，没 denoise 就需要更多 samples。

#### #146：高采样 bake

324,674 probes，16,384 samples/probe，20MB VRAM，267s bake on RTX4090。

#### #147：probe compression 与 median histogram

每 probe 26 bytes，之前 56；GPU per-probe median 用 histogram 32 buckets 近似；outlier filtering 从 mean 改 median，减少 blow-up。

#### #148-#151：SVLM 集成 GI / specular

SVLM 接入 GI。specular 用 probes + GGX convolution。使用 reservoir sampling 抽 2 unique probes/pixel，参考 stochastic texture filtering。lightmap 2.2MB，60,826 probes，32k samples/probe，diffuse+specular runtime 约 0.1ms。

#### #156/#157：MKS mip filter

作者测试 Magic Kernel Sharp、Mitchell、Catmull-Rom、Wronski kernel。最终 MKS 成为 color textures 默认 filter，因其减少 aliasing/ringing/moiré，同时保留整体 sharpness。

#### #158：occlusion culling rewrite + performance demos

重做 occlusion culling，解决 Apple Silicon OneSweep scan 性能问题和低端 GPU HZB rebuild 成本。给出 M1 Pro/GTX1080/RDNA2 iGPU performance。Blender 3.3 splash 从 21 FPS 到 46 FPS，three.js 在该极端场景约 3671ms。

#### #159：comparison table

作者整理 Shade vs three.js / Babylon / Unity / PlayCanvas。涵盖 rendering architecture、culling/scene scale、shadows、post-processing、transparency/materials、GI/ray tracing、memory/performance/integration。

### Page 9：#162 - #181，HBAO/GTAO、meshlets worth it、workers、scene format、RCAS、path tracer、GPU animation/skinning

#### #163-#165：HBAO vs GTAO / auto exposure / color science

作者说 HBAO/GTAO 概念接近。benjaminsuch 补充：GTAO 更适合 AAA，因为 temporal stability 更好，并可输出 bent normals，TAA 协同更好。

#### #167：meshlets 是否值得

作者认为 100% worth it。没有 meshlets 很难做 GPU-driven drawer；meshlet spatial distribution 让 culling performance 更可预测。大 terrain 只提交小部分 geometry。

#### #167：LOD、streaming、DDGI、multithreading

当前无显式 LOD，用户可 CPU 侧 swap geometry；未来想做 virtual geometry。Shade 是 fully streaming。DDGI 内置但默认关闭，因为低端设备 RTX load 高。CPU overhead：复杂 scenes/materials 约 4ms，典型约 1ms，与 mesh 数无关。

#### #169-#171：Web workers 争论

作者认为 workers 不是真正轻量线程，共享内存慢、worker 启动/生命周期/部署麻烦。benjaminsuch 反驳 Chrome 可以很多 workers，共享 typed arrays 不一定慢，render-worker 很有价值。作者承认部分信息可能过时，但在 GPU-driven draw 下分离 submit thread 收益小。

#### #172：custom scene format

Sponza glTF + env + BVH 原始很大；Shade format 使用 texture recompression、engine geometry、per-meshlet compression，29.5MB，zip 16MB，数据可直接进 GPU。

#### #173/#174：Sponza demo

整个 scene 29MB，textures/geometries/BVH/env map 全含。time to first frame 很低，无 shader compilation，无昂贵 texture decode，SVLM 2.17MB parallel load。

#### #175：RCAS

加入 AMD RCAS / CAS sharpening，WGSL port。作者原以为 CAS 是坏 upscaling 的 crutch，看 Pragmata/RE Engine 分析后认为高质量 frame stack 中 RCAS 也能增加细节感。

#### #177/#178：accumulating path tracer

加入累积 path tracer：camera change reset，biased EMA，1 path/frame。后续加入 light PDF 到 MIS，variance 降低，早期 convergence 快；tiles 支持低端 GPU；mip-chain flood fill deblocking；无 denoising。

#### #179：GPU animation system

目标：animation、skinning、bounding volume updates 全 GPU。GPU 中有 curves/tracks/clips/bindings/playback time/node hierarchy/local/world transforms。GPU-side database 存多数据类型。

#### #181：GPU skinning

skinning 正常工作。324 characters，每个都有独立 skinning information 和 timeline，无 instancing。又展示 2,500 characters。

---

## 28. 技术词汇表

### GPU-resident renderer

场景数据和渲染所需数据长期驻留 GPU，CPU 不再每帧重建完整 render list。

### GPU-driven renderer

剔除、排序、间接绘制参数生成等由 GPU 完成，CPU 只提交较少固定命令。

### Visibility Buffer

记录每个 pixel 最终可见的 primitive ID，如 mesh_id + triangle_id，而不是直接写完整 G-buffer。

### Meshlet

小三角形簇，通常最多 64/128 triangles，用于细粒度 culling、LOD、compression、GPU-driven draw。

### HZB / Depth Pyramid

多级深度 mip，用于快速 occlusion culling。

### GTAO

Ground-Truth Ambient Occlusion。比简单 SSAO 更接近物理，能输出 bent normals。

### Bent Normal

未被遮挡方向的平均 normal，用于环境光/GI 采样。

### TAA

Temporal Anti-Aliasing。通过多帧 jitter + history accumulation 抗锯齿，同时为 SSR/GTAO/shadow 等 noisy effects 提供 temporal stability。

### SSR

Screen-Space Reflections。只用屏幕已有 depth/color 信息追踪反射，因此有屏幕外/遮挡信息缺失的上限。

### DDGI

Dynamic Diffuse Global Illumination。基于 probe grid / ray tracing / visibility 的动态 diffuse GI。

### SVLM

Sparse Volumetric Light Map。稀疏 3D lightmap/probe structure，可存 diffuse/specular GI，适合运行时快速采样。

### SH3

三阶球谐（常指到 l=2 的 9 coefficients）低频方向表示，常用于 irradiance/probe lighting。

### RGBE9995

一种紧凑 HDR-ish 编码，用 4 bytes 存 RGB 共享 exponent/特定位宽数据。

### RCAS / CAS

AMD FidelityFX Contrast Adaptive Sharpening / Robust CAS，用于锐化和提升细节感。

### MBOIT

Moment-Based Order-Independent Transparency，用于透明物体的顺序无关透明近似。

### STBN

Spatiotemporal Blue Noise。适合时空采样/denoise/TAA 的蓝噪声序列。

---

## 29. 如果你是 three.js / WebGL / WebGPU 开发者，应该重点学什么

### 29.1 第一优先级：理解现代 renderer 不是 API 替换

WebGPU 的价值不是“把 WebGL 函数换成 WebGPU 函数”，而是让你有机会重写架构：

```text
CPU-driven object renderer → GPU-driven scene renderer
```

### 29.2 第二优先级：补 GPU compute 基础

需要理解：

- workgroup；
- thread divergence；
- memory coalescing；
- cache locality；
- prefix sum / scan；
- compaction；
- indirect draw；
- buffer layout；
- atomics；
- barriers；
- GPU timing。

### 29.3 第三优先级：visibility buffer / deferred pipeline

如果你只是 forward rendering，很多 Shade 的技术不容易用上。需要掌握：

- depth pre-pass；
- G-buffer；
- visibility buffer；
- material ID buffer；
- motion vectors；
- normal reconstruction；
- depth pyramid。

### 29.4 第四优先级：TAA

TAA 是现代实时渲染的核心。要学：

- jitter sequence；
- reprojection；
- motion vectors；
- history rejection；
- disocclusion；
- neighborhood clipping；
- variance clipping；
- YCoCg clamp；
- mip bias；
- TAAU。

### 29.5 第五优先级：GI / probes / lightmaps

要学：

- spherical harmonics；
- irradiance vs radiance；
- octahedral mapping；
- DDGI；
- probe visibility；
- parallax correction；
- sparse grids；
- light leak mitigation；
- path tracing bake。

### 29.6 第六优先级：资源格式和 runtime pipeline

现代 renderer 的性能不只在 shader。还包括：

- asset format；
- texture compression；
- mipmap generation；
- meshlet compression；
- BVH prebuild；
- streaming；
- no decode path；
- startup shader compilation strategy。

---

## 30. 总结

这整篇帖子真正有价值的地方，是它把 WebGPU 图形开发从“API 使用”推进到了“现代渲染架构”层面。

Shade 的技术路线可以浓缩成：

```text
GPU-resident scene
+ meshlet-based culling
+ visibility buffer
+ material-level shading dispatch
+ FrameGraph
+ integrated TAA/GTAO/SSR/Bloom/Exposure
+ physically-based sky/HDR
+ software RT for bake/debug
+ DDGI/SVLM global illumination
+ custom GPU-ready scene format
+ GPU animation/skinning
```

它与 three.js 的关系不是“谁替代谁”，而是两种不同目标：

- three.js 是开放、通用、友好、生态强的 Web 3D framework；
- Shade 是高度集成、现代渲染栈优先、商业化倾向的 browser renderer。

如果你的目标是常规 Web 3D，three.js 仍然是最实际选择。  
如果你的目标是学习 WebGPU 能把浏览器实时图形推到哪里，Shade 这条帖子非常值得精读。

---

## 附：本 v3 和前两版的区别

前两版的问题是：

- 把整帖压缩成了综述；
- 楼层时间线不够完整；
- 很多中后期内容没有展开，比如 SVLM、scene format、GPU animation；
- three.js/TSL/Babylon/Unity 的对比没有单独系统化；
- 实现细节不足。

本版补充了：

- Page 1 - Page 9 的阶段性主线；
- #1 - #181 中所有主要技术楼层；
- visibility buffer 完整流程；
- meshlet expansion / divergence / batch；
- material pass 0-overdraw 机制；
- TAA texture sampling、YCoCg clamp、background velocity；
- SSR resolve/reprojection/ray reuse；
- shadow map / CSM / contact shadow / terminator；
- DDGI / radiance probes / SVLM / probe compression；
- mipmap filter 从 Mitchell 到 MKS；
- bindless 缺失与 texture array/virtual texture；
- scene format 与 streaming；
- GPU animation/skinning；
- 和 three.js/WebGPURenderer/TSL/Babylon/PlayCanvas/Unity 的系统对比。


---

# 深入附录 A：把 Shade 的一帧渲染写成伪代码

下面是根据整帖内容归纳出的“概念级伪代码”。它不是作者源码，只是为了帮助理解架构。

```ts
function renderFrame(frame) {
  // 0. CPU 只上传本帧少量变化：camera、时间、用户修改、streaming 资源状态
  uploadFrameConstants(camera, time, exposureState);
  uploadChangedSceneData();

  // 1. GPU culling：instance 级别
  dispatch(instanceFrustumAndConservativeOcclusionCull);

  // 2. GPU expansion：instance -> meshlet groups / meshlet batches
  dispatch(expandVisibleInstancesToMeshletBatches);

  // 3. GPU culling：meshlet group / meshlet 级别
  dispatch(meshletFrustumCull);
  dispatch(meshletOcclusionCullWithPreviousHZB);
  dispatch(smallPrimitiveCull);

  // 4. draw visibility buffer
  beginRenderPass(visibilityBufferPass);
  drawIndirect(visibleMeshletIndirectBuffer);
  endRenderPass();

  // 5. build current depth pyramid
  for (let level = 1; level < hzbMipCount; level++) {
    dispatch(buildHZBMipLevel(level));
  }

  // 6. process maybe set with current HZB
  dispatch(resolveMaybeVisibleSet);

  // 7. second visibility rasterization
  beginRenderPass(visibilityBufferPassAppendOrOverwrite);
  drawIndirect(maybeResolvedMeshletIndirectBuffer);
  endRenderPass();

  // 8. rebuild HZB for next frame / downstream passes
  for (let level = 1; level < hzbMipCount; level++) {
    dispatch(buildHZBMipLevel(level));
  }

  // 9. material ID / gbuffer generation
  beginRenderPass(materialIdPass);
  drawFullscreenOrVisibilityDrivenMaterialIds();
  endRenderPass();

  // 10. per-material shading with depth equal routing
  for (const materialPipeline of activeMaterialPipelines) {
    beginRenderPass(gbufferPass, { depthEqual: materialPipeline.id });
    drawMaterialPixels(materialPipeline);
    endRenderPass();
  }

  // 11. Lighting / GI / post stack
  dispatch(clusteredLightingOrDeferredLighting);
  dispatch(sampleVolumetricLightmapDiffuseSpecular);
  dispatch(gtao);
  dispatch(ssrTrace);
  dispatch(ssrResolve);
  dispatch(ssrSpatialTemporalDenoise);
  dispatch(bloomDownsampleUpsample);
  dispatch(autoExposureHistogram);
  dispatch(taaResolve);
  dispatch(tonemapAndDither);
  dispatch(rcasOptional);

  present();
}
```

重点不是函数名，而是职责分配：CPU 没有 for every mesh draw；真正与对象数量相关的工作被移到 GPU。

---

# 深入附录 B：为什么传统 CPU-driven renderer 在极端场景会崩

传统 three.js 风格的渲染器，在场景复杂时通常会遇到这些成本：

```text
N objects
→ CPU 遍历 N 个 Object3D
→ 更新矩阵 / world matrix
→ frustum culling
→ material/geometry/program sorting
→ 为每个 render item 设置 pipeline-ish state
→ 发 draw call
```

即使 GPU 画得动 7 亿 triangles，CPU 也未必能在一帧内提交 37 万 mesh 的绘制命令。

Shade 的做法不是“更聪明地 batch 一下”，而是：

```text
把 N objects 变成 GPU 数据库
让 GPU 自己筛选 visible subset
CPU 不再按 object 提交 draw
```

这就是为什么 Blender 3.3 splash 这类极端场景会把差距拉到非常夸张：它不是普通模型复杂，而是 mesh count 极高，正好打在 CPU-driven renderer 的痛点上。

---

# 深入附录 C：Visibility Buffer 与 Deferred G-buffer 的对照

| 项目 | Traditional Deferred G-buffer | Visibility Buffer |
|---|---|---|
| 第一阶段写入 | albedo/normal/roughness/depth 等 | mesh_id/triangle_id/depth |
| 初始 shader 成本 | 需要执行材质相关逻辑 | 近似 depth pre-pass，非常轻 |
| overdraw | G-buffer pass 仍可能多次写 | material shading 只对最终可见 pixel |
| 材质复杂度 | 材质越复杂，G-buffer pass 越贵 | 后续按可见 pixel 取材质 |
| 数据回溯 | 已经写了属性 | 需要从 ID 找 geometry/material |
| 适合场景 | 中等复杂度、传统 deferred | 超大场景、meshlet、GPU-driven |
| 代价 | G-buffer bandwidth | ID indirection + GPU data layout 复杂 |

Visibility buffer 最适合和 meshlet / GPU culling 配合。只用 visibility buffer 而没有 GPU-side 数据结构，意义会打折扣。

---

# 深入附录 D：Meshlet culling 的层次

一个对象可能由多个 meshlets 组成。对每级做更细判断：

```text
Scene
└── Instance A
    ├── Meshlet 0
    ├── Meshlet 1
    ├── Meshlet 2
    └── ...
```

实例级判断：

```text
if instance.bounds outside frustum:
    discard whole instance
```

meshlet 级判断：

```text
for meshlet in instance.meshlets:
    worldBounds = transform(meshlet.localBounds)
    if outside frustum:
        discard meshlet
    else if occludedByHZB(worldBounds):
        discard meshlet
    else:
        append visible meshlet
```

小 primitive 判断：

```text
if projectedPrimitiveDoesNotCoverTexelCenter:
    discard
```

这三个层级叠加后，最终提交到 rasterizer 的 geometry 远少于原场景总量。

---

# 深入附录 E：Meshlet expansion 的 divergence 问题图解

假设一个 workgroup 有 4 个线程：

```text
thread 0: meshlet_count = 1
thread 1: meshlet_count = 2
thread 2: meshlet_count = 1
thread 3: meshlet_count = 7813
```

如果每个线程循环 `meshlet_count` 次：

```text
for i in 0..meshlet_count:
    append(meshlet)
```

GPU 的执行会被 thread 3 拖住。其它线程很早完成，但不能立刻去做别的完全无关工作。

所以作者加中间层：

```text
mesh -> meshlet batches -> meshlets
```

把 7813 次循环拆成约 123 个 batch，每个 batch 最多 64 meshlets。这样 work distribution 更均匀。

---

# 深入附录 F：为什么 Shade 的 material pass 可以按材质数而不是 mesh 数扩展

传统 forward：

```text
for mesh in visibleMeshes:
    set mesh geometry
    set mesh material
    draw
```

如果 223 meshes：理论上至少 223 draw items。若 shadow pass、depth pass、post pass、transparent pass 叠加，次数更多。

Shade：

```text
visibility pass: draw all visible meshlets into ID buffer
material routing pass: generate material ID per visible pixel
for material in uniqueMaterials:
    shade pixels whose material ID == material.id
```

如果有 111 materials，则 shading pass 近似 111 个材料组，而不是 223 个 mesh。更重要的是，在 374,734 mesh 的 torture scene 中，material 数远小于 mesh 数时收益巨大。

---

# 深入附录 G：TAA 的数据依赖清单

一个稳定 TAA 大致需要：

```text
current color
previous color history
motion vector
current depth
previous depth
current normal
previous normal / material info 可选
jitter sequence
exposure history 可选
disocclusion mask
reactive mask 可选
neighborhood color statistics
```

Shade 中 TAA 还影响：

```text
texture sampling UV stability
mip bias
SSR temporal resolve
GTAO stability
background velocity
dynamic resolution / upscaling
```

所以作者说 TAA 是 intrusive：不是“最后接一个 TAA pass”就完了。

---

# 深入附录 H：TAA texture blur 的机制

正常 raster：

```text
pixel center -> surface point -> uv -> texture sample
```

TAA raster：

```text
jittered pixel center -> slightly different surface point -> slightly shifted uv -> texture sample
history accumulates shifted samples
```

如果不修正，纹理会因为多帧 UV jitter 被平均掉。

Shade 做两件事：

```text
1. remove jitter from UV used for material texture sampling
2. bias mip level lower / sharper
```

这就是为什么文字、书本、砖墙这类高频纹理在 Shade TAA 下仍能清晰。

---

# 深入附录 I：SSR 的难点分层

SSR 可以分成四类问题。

## I.1 几何问题

- ray 从当前 pixel 出发；
- 只能访问屏幕空间 depth；
- 屏幕外信息不存在；
- 被前景遮挡的反射物不存在；
- thin geometry 容易 miss；
- depth precision 影响 hit。

## I.2 材质问题

- roughness 决定 lobe 宽度；
- metalness 影响反射强度；
- dielectric 反射较弱但仍重要；
- energy conservation 要和 IBL/GI/direct specular 协调。

## I.3 时域问题

- 反射 plane 与主表面 motion 不同；
- reprojection 不能简单套主 pixel；
- disocclusion 更复杂；
- history rejection 过强会 noisy，过弱会 ghost。

## I.4 滤波问题

- raw SSR 很 noisy；
- 需要 color mip chain resolve；
- 需要 roughness-aware spatial filter；
- 需要 temporal filter；
- 需要 variance metrics；
- 最后仍要和 TAA 协同。

---

# 深入附录 J：GTAO / SSR / GI 与 TAA 的协同

现代 frame stack 不是各技术独立相加，而是互相依赖：

```text
GTAO 产生 AO + bent normals
bent normals 帮 GI / environment visibility
SSR 产生 noisy reflections
TAA 稳定 SSR 和 edges
Bloom 使用 HDR color
Auto exposure 使用 downsampled luminance
RCAS 在 tone/post 后增加细节
SVLM 提供 diffuse/specular indirect
```

如果任意一个环节不稳定，后面都会放大问题：

- SSR noisy → TAA ghost/flicker；
- bad motion vectors → TAA smear；
- bad AO temporal stability → shadow shimmer；
- wrong exposure → bloom/tonemap 感觉不对；
- poor mipmaps → TAA 后仍糊。

---

# 深入附录 K：Shadow 技术路径演化

Shade 的 shadow 路径不是一开始就定型。

```text
VSM / virtual shadow map investigation
    ↓
software ray-traced shadows
    ↓
发现 native RTX 缺失导致低端成本高
    ↓
CSM / shadow map 成为主线
    ↓
shadow atlas HZB culling
    ↓
small primitive raster culling
    ↓
contact shadows 补微细节
    ↓
cascade selection/blending 改进
```

这条演化说明：现代 renderer 不是只选“最先进论文”，而要根据平台约束取舍。WebGPU 没有 native RT，所以全软件 RT 不能作为默认路径覆盖所有设备。

---

# 深入附录 L：GI 技术路径演化

GI 路径也有多次演化：

```text
path tracer for irradiance cache
    ↓
light probe volume
    ↓
DDGI-like dynamic probes
    ↓
probe depth / visibility / parallax correction
    ↓
radiance atlas instead of pure SH progressive update
    ↓
infinite bounce by probes sampling probes
    ↓
specular GI from radiance probes
    ↓
Sparse Volumetric Light Map
    ↓
SH3 + RGBE9995 + compression
    ↓
GGX convolution / specular SVLM
    ↓
reservoir sampling 2 probes per pixel
```

核心问题始终是：如何用小内存、低 runtime cost 近似真实 multi-bounce lighting，并减少 leak。

---

# 深入附录 M：Probe leakage 的分类

## M.1 位置泄漏

Probe 落在墙后或墙内，导致采样到错误光照。

解决：probe placement optimization，把 probe 推到表面外侧。

## M.2 可见性泄漏

Surface 从某 probe 看其实不可见，但仍被加权。

解决：per-probe depth map + surface normal check。

## M.3 网格不连续

Surface 穿过 probe grid 时，最近 probe 从墙一侧跳到另一侧。

解决：cells locality + C0 continuity + probe movement bias。

## M.4 角分辨率不足

Probe 表示太低频，specular/parallax correction 不明显。

解决：提高 spatial resolution、使用 radiance atlas 或接受低频限制。

---

# 深入附录 N：Mipmap filter 对实时渲染为什么重要

很多开发者认为 mipmap generation 是小事，但作者花很多时间研究，原因是：

- TAA 会放大纹理清晰度问题；
- 高分辨率 texture 经过 box mip 会丢很多细节；
- 书本/文字/砖墙/草叶都是高频测试；
- mip filter 是 offline/加载阶段成本，不影响 runtime shader；
- 改善 mip 等于“免费提升画质”。

比较：

```text
Linear/box: 便宜，容易糊
Mitchell: 保细节，有锐化感
Catmull-Rom: 更锐但可能 ringing
MKS: 抑制 moiré/ringing，整体锐度保留较好
Wronski kernel: 另一种高级方案
```

Shade 最终 color texture 默认 MKS。

---

# 深入附录 O：为什么 bindless 对这种 renderer 很关键

在传统 renderer 中，材质切换时 CPU 可以 bind texture。

在 GPU-resident renderer 中，GPU shader 希望能根据 material_id 自己访问任意 texture：

```wgsl
let material = materials[material_id];
let baseColor = sampleTexture(material.baseColorTextureId, uv);
```

如果有 bindless textures，textureId 可以直接索引巨大 descriptor heap。

WebGPU 没有 bindless，就会遇到：

- texture array layer limit；
- 必须统一 texture size/format；
- atlas packing；
- virtual texture；
- software sampling；
- 多 pass 分材质；
- shader/pipeline routing。

Shade 的 material pass 方案某种程度上就是在 WebGPU 约束下绕过 bindless 缺失。

---

# 深入附录 P：自定义 scene format 的意义

Web runtime 中，资产加载成本包括：

```text
network transfer
JSON parse
image decode
texture upload
geometry decode
BVH build
shader compilation
pipeline compilation
GPU buffer allocation
```

Shade format 试图减少这些：

```text
network transfer compressed binary
→ no expensive decode
→ direct GPU buffer/texture upload
→ prebuilt BVH
→ precompressed meshlets
→ no shader compilation at startup
```

这对 Web 特别重要，因为用户等待首帧的耐心很少。

---

# 深入附录 Q：GPU animation 为什么难

传统 animation：

```text
CPU animation mixer evaluates curves
CPU updates node transforms
CPU updates skeleton matrices
CPU updates bounding boxes sometimes
GPU vertex shader skins vertices
```

Shade 目标：

```text
GPU stores curves/tracks/clips
GPU stores bindings/playback time
GPU evaluates animation
GPU updates local/world transforms
GPU updates bounding volumes
GPU skins vertices
GPU culls animated meshlets
```

难点：

- 数据结构异构；
- buffer 内需要 GPU-side database；
- 动态增删改；
- hierarchy update 需要拓扑顺序；
- bounding volume update 要和 culling pipeline 接起来；
- 每个角色独立 timeline 时不能靠 instancing 简化。

作者展示 324 characters / 2500 characters，说明这部分已经从 prototype 走向可运行。

---

# 深入附录 R：three.js 开发者如何复现部分思路

如果你现在用 three.js，不可能直接复制 Shade，但可以借鉴部分方向。

## R.1 低风险可借鉴

- 用 TAA/temporal techniques 时注意 motion vectors；
- 用 better mipmap generation 预处理纹理；
- alpha texture 做 coverage/premultiply 处理；
- 做后处理时尽量统一 color space/exposure；
- 避免把 SSAO 当最终图灰度滤镜，要 PBR aware；
- 对复杂场景做 spatial index；
- 大场景分 chunk，而不是单巨大 mesh。

## R.2 中等难度

- 自己做 HZB occlusion culling；
- 自己管理 indirect draw；
- 使用 InstancedMesh / batched rendering；
- 为 shadow pass 做更强 culling；
- SSR 中加入 color mip chain 和 temporal reprojection；
- 引入 RenderGraph-like resource manager。

## R.3 高难度

- GPU-resident scene database；
- meshlet conversion；
- visibility buffer renderer；
- GPU material routing；
- DDGI/SVLM；
- GPU animation database；
- custom scene format。

---

# 深入附录 S：这篇帖子对 WebGPU 生态的启发

## S.1 WebGPU 的限制同样重要

帖子里频繁出现 WebGPU 限制：

- storage buffer count；
- no bindless；
- no mesh shaders；
- no native RT；
- browser/platform variance；
- Apple Silicon scan performance；
- Firefox WebGPU rollout；
- worker / JS runtime 约束。

一个成熟 renderer 不是只展示 WebGPU 能力，还要绕开这些限制。

## S.2 高端 Web renderer 需要自己的 asset pipeline

只靠 glTF runtime parse 很难达到最短首帧和最优 GPU memory。未来高端 Web renderer 可能都需要自己的 runtime-ready binary format。

## S.3 TAA 是 WebGPU 高画质路径核心

MSAA 在 WebGL forward renderer 中很好用，但 deferred/postprocess/SSR/GI 时代，TAA 几乎绕不过。

## S.4 Web 也可以做 AAA-style frame stack

Shade 的意义不一定是“马上成为主流”，而是证明浏览器里可以跑：

- GPU culling；
- visibility buffer；
- meshlets；
- TAA；
- SSR；
- GTAO；
- volumetric lightmap；
- custom scene format；
- GPU animation。

---

# 深入附录 T：可作为学习路线的论文/主题关键词

根据帖子里提到或暗示的方向，可以按这个顺序学：

## T.1 基础 GPU 架构

- SIMT / warp / wavefront；
- thread divergence；
- cache locality；
- memory bandwidth；
- atomics；
- prefix sum；
- compaction。

## T.2 WebGPU

- WGSL；
- storage buffers；
- bind groups；
- indirect draw；
- compute pass；
- render pass；
- timestamp query；
- buffer alignment；
- texture format limits。

## T.3 Rendering architecture

- deferred rendering；
- visibility buffer；
- clustered lighting；
- tiled lighting；
- frame graph；
- render target aliasing。

## T.4 Geometry

- meshlets；
- mesh shaders；
- virtual geometry；
- Nanite；
- meshlet compression；
- BVH / TLAS / BLAS。

## T.5 Image quality

- TAA；
- TAAU；
- FXAA/SMAA/MSAA tradeoffs；
- blue noise / STBN；
- mipmap filtering；
- specular AA。

## T.6 Lighting

- PBR；
- Burley diffuse；
- Oren-Nayar；
- GGX；
- ACES；
- HDR；
- tone mapping；
- auto exposure。

## T.7 Global illumination

- light probes；
- DDGI；
- spherical harmonics；
- radiance vs irradiance；
- parallax-corrected cubemaps；
- sparse volumetric lightmaps；
- path tracing bake。

---

# 深入附录 U：整帖里反复出现的取舍原则

## U.1 画质 vs 稳定性

很多技术 raw output 很好看，但 motion 下不稳定就不能用于生产。TAA/GTAO/SSR 都是这个问题。

## U.2 物理准确 vs 视觉讨好

Oren-Nayar 更物理，但 Burley 更有深度感。无 ambient 更物理，但用户觉得暗。renderer 最终需要给艺术家/用户调节空间。

## U.3 性能 vs 复杂度

Virtual textures、bindless 替代、SVLM、GPU animation 都能带来收益，但实现和维护复杂度非常高。

## U.4 通用性 vs 集成度

three.js 通用灵活，Shade 集成固定。二者不是同一个优化目标。

## U.5 CPU 简单 vs GPU 数据结构复杂

把工作移到 GPU 后，CPU 更轻，但 GPU-side allocator、database、scan、compaction、buffer layout 全都变复杂。

---

# 深入附录 V：一句话对照表

| 技术点 | Shade 的选择 | three.js 常见路径 | 影响 |
|---|---|---|---|
| 场景组织 | GPU-resident | CPU scene graph | Shade CPU overhead 更低 |
| Draw dispatch | GPU indirect / material grouped | CPU per mesh | Shade 大 mesh count 更强 |
| Geometry | Meshlet | Mesh/BufferGeometry | Shade culling 更细 |
| Culling | GPU HZB + meshlet | CPU frustum | Shade 遮挡场景优势大 |
| Shading | Visibility buffer | Forward / traditional deferred-ish extensions | Shade material overdraw 低 |
| AA | TAA | MSAA/FXAA/SMAA | Shade 更适合 deferred/postprocess |
| AO | GTAO + bent normals | SSAO-like addons | Shade 更 PBR/GI aware |
| SSR | integrated stochastic SSR | addon / SSRNode | Shade 更物理/稳定 |
| GI | DDGI/SVLM | lightmap/lightprobe basic | Shade 有体积 GI |
| Shadows | CSM + culling + contact | per-light shadow maps/manual | Shade 更自动但复杂 |
| Mipmaps | Mitchell/MKS | standard mipmaps | Shade 纹理更清晰 |
| Scene format | GPU-ready binary | glTF loaders | Shade 首帧/内存更优 |
| Animation | GPU curves/skinning | CPU mixer + GPU skinning | Shade 大量角色更有潜力 |
| API | opinionated engine | flexible framework | 面向场景不同 |

---

# 深入附录 W：最终判断

如果你读这篇帖子的目标是“学 three.js WebGPU 怎么用”，那它并不是教程。它更像是一个现代 renderer 设计案例。

最值得带走的不是某个效果，而是整体模式：

```text
1. 让 GPU 长期持有场景数据
2. 用 meshlets 把几何切成可管理的小块
3. 用 HZB 做层级遮挡剔除
4. 先写 visibility，再做 material shading
5. 用 TAA 统一稳定各种 noisy effects
6. 用 RenderGraph 管理 frame stack
7. 用 volumetric/probe-based GI 提供低成本间接光
8. 用自定义格式减少 Web runtime 加载成本
9. 把动画/包围盒等动态数据更新也推向 GPU
```

这就是 Shade 和普通“WebGPU demo”的本质区别。

