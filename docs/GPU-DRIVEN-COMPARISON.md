# GPU-Driven 实现对比：three.js Compute Rasterizer 与 reconstructed

> 文档角色：实现对比与技术证据。本文的 P0–P5 建议不再作为独立路线维护；后续约束以 [ENGINE-DIRECTION-AND-CONSTRAINTS.md](./ENGINE-DIRECTION-AND-CONSTRAINTS.md) 为准。

本文比较以下三套本地实现：

- [three.js `webgpu_compute_rasterizer.html`](../../../three.js/examples/webgpu_compute_rasterizer.html)：程序化茶壶、GPU LOD、Compute/Hardware 混合光栅化的基础实验。
- [three.js `webgpu_compute_rasterizer_ibl.html`](../../../three.js/examples/webgpu_compute_rasterizer_ibl.html)：在基础实验上加入真实 glTF、Meshopt Meshlet、HZB、PBR 与 IBL。
- [`reconstructed`](../reconstructed/README.md)：Shade Renderer 当前的通用 GPU Scene、Visibility Buffer 与 Deferred Rendering 引擎。

核实日期：2026-08-23。本文描述的是上述文件在该日期的本地代码状态，不把示例代码的目标等同于 three.js WebGPURenderer 的完整能力。

## 1. 先说结论

三者都属于 GPU-Driven，但驱动范围不同：

- three.js 基础版最适合学习“GPU 如何选择 LOD、生成工作队列，并把小三角形交给 Compute 光栅化”。它结构直接、可视化清楚，但不是通用渲染器。
- three.js IBL 版最适合研究“Compute/Hardware 两条光栅路径怎样汇合到真实 PBR/IBL 材质结果”，也补上了 Meshopt Meshlet 和上一帧 HZB 遮挡剔除。
- `reconstructed` 的 GPU-Driven 覆盖面更广：它围绕 GPU Scene、材质 Bucket、实例与 Meshlet 两级剔除、GPU 间接绘制、Visibility Buffer 和完整 Deferred 管线构建。它是三者中更接近实际通用引擎的一套，但目前没有在主 Visibility 链中找到明确的 GPU Screen-Space Error 几何 LOD 选择，也没有使用 Compute 软件光栅化处理小三角形。

因此，three.js 示例对当前引擎最有价值的部分不是“整体替换现有 Visibility Pass”，而是：

1. 补齐 GPU 几何 LOD/Cluster hierarchy。
2. 对照 three.js IBL 的解析法线导数，验证并完善当前已有的解析 UV 导数、`textureSampleGrad` 与 Specular AA；重点不是从零实现，而是消除跨三角形硬件导数的不确定性。
3. 先增加 LOD、剔除、Meshlet 尺寸和间接工作量的可视化与统计。
4. 只有性能数据证明大量微三角形卡在硬件光栅前端时，再评估 Compute Rasterizer。

## 2. 什么叫 GPU-Driven

传统 CPU-Driven 渲染通常由 CPU 遍历对象、判断可见性、选择 LOD，并为对象或批次逐个发出 Draw Call。对象数量增加后，CPU 遍历、状态切换和命令提交可能先成为瓶颈。

GPU-Driven 的核心不是“所有工作都必须在 GPU 上”，而是把**决定本帧要画什么、画多少，以及如何生成后续 GPU 命令**的关键循环搬到 GPU：

```text
CPU：更新少量帧状态、场景增量和高层 Pass
                         ↓
GPU：剔除 → LOD/分组 → 生成可见列表与间接参数 → 间接绘制
```

它是一个程度问题，不是非黑即白：

- 只把实例剔除搬到 GPU，已经具有 GPU-Driven 特征。
- 再让 GPU 展开 Meshlet、生成 `drawIndirect`/`dispatchIndirect`，驱动程度更高。
- 再让 GPU 做几何 LOD、材质分类、软件光栅化，GPU 控制的范围继续扩大。
- CPU 仍然可以组织 FrameGraph、管理资源、更新场景和选择渲染模式；这不会否定 GPU-Driven。

### 2.1 本文中的关键名词

| 名词 | 含义 | 在三套实现中的作用 |
| --- | --- | --- |
| Instance | 同一份几何的一个场景实例，通常拥有独立变换 | 首先进行粗粒度剔除，避免展开不可见实例的几何工作 |
| LOD | 同一物体的多个细节等级 | three.js 两个示例在 GPU 上按屏幕误差选择；当前 `reconstructed` 主 Visibility 链未发现同类选择 |
| Screen-Space Error | 把几何简化误差投影到屏幕，以像素影响决定 LOD | 比只按世界距离更能反映最终画面误差 |
| Meshlet/Cluster | 一小组顶点和三角形，以及包围体等元数据 | 让 GPU 以比整 Mesh 更细、比单三角形更经济的粒度剔除和调度 |
| Work Queue | GPU 生产、GPU 消费的任务数组，通常配合原子计数器 | three.js 示例把“实例的一个 64 三角形块”写入队列 |
| Prefix Scan | 把每项数量转成紧凑数组写入偏移的并行前缀和 | `reconstructed` 用它从 Mesh 计数生成紧凑 Meshlet 工作列表 |
| Indirect Dispatch/Draw | 参数存放在 GPU Buffer 中，CPU 不必读回数量 | 让前一个 Compute Pass 直接决定后续 Compute 或 Render Pass 的规模 |
| Frustum Culling | 用相机视锥排除视野外对象 | three.js 和 `reconstructed` 都有实例级和更细粒度的剔除 |
| HZB | 深度纹理的层次金字塔，每级代表更大屏幕区域 | 用少量采样保守判断包围体是否被已有深度完全遮挡 |
| Previous-frame HZB | 用上一帧深度判断当前帧可见性 | 便宜，但相机/物体移动时可能短暂误剔除新暴露物体 |
| Second Chance | 先画上一帧判断为可见的对象，建立当前深度，再复查不确定对象 | `reconstructed` 用它降低上一帧 HZB 的时间滞后问题 |
| Visibility Buffer | 像素先保存几何/三角形身份，随后再重建属性和求材质 | 分离几何可见性与材质计算，适合大量几何与延迟着色 |
| Compute Rasterizer | Compute Shader 自己完成三角形覆盖、深度竞争和可见性写入 | three.js 两个示例只让屏幕包围盒较小的三角形走这条路径 |
| Hardware Rasterizer | 固定功能光栅器执行三角形设置、覆盖与插值 | three.js 用于大三角形；`reconstructed` 的主 Visibility 路径全部依赖它 |
| Material Expand | 根据 Visibility ID 取回顶点/材质属性，扩展成 GBuffer | `reconstructed` 的 Visibility 与后续 Deferred Lighting 的连接层 |
| IBL | 使用环境贴图提供漫反射与镜面间接光 | three.js IBL 版和 `reconstructed` 都支持，但后者属于完整引擎管线的一部分 |

> “GPU-Driven”不等于“Compute Rasterizer”。GPU 可以生成间接绘制参数，再让硬件光栅器画，这仍然是典型 GPU-Driven；`reconstructed` 正是这种路线。

## 3. 三套实现的一帧流程

### 3.1 three.js 基础版

```text
CPU 初始化 7 个 Teapot LOD、实例和大 Buffer
    ↓
Compute Clear：清屏幕原子 Buffer、队列计数和间接参数
    ↓
Compute Frustum：实例视锥剔除
                  → Screen-Space Error 选择 LOD
                  → 64 三角形 Chunk 包围球剔除
                  → 原子追加 Work Queue
    ↓
Compute Dispatch：由队列长度生成后续 Dispatch 参数
    ↓
Compute Rasterize：小屏幕三角形 → 原子 Visibility/Depth Buffer
                   大屏幕三角形 → HW Queue
    ↓
Compute HW Args → Hardware drawIndirect
    ↓
Fullscreen Resolve：重建 UV，输出 Meshlet Debug 或 UV Grid
```

### 3.2 three.js IBL 版

```text
CPU 加载 Damaged Helmet + HDR 环境图
    → MeshoptSimplifier 生成 LOD
    → MeshoptClusterizer 构建 Meshlet
    ↓
使用上一帧相机、实例矩阵和 HZB
    ↓
实例视锥/HZB 剔除 → GPU LOD → Meshlet 视锥/HZB 剔除 → Work Queue
    ↓
小三角形 Compute Rasterize + 大三角形 Hardware drawIndirect
    ↓
Visibility Resolve：重建位置、法线、UV、导数和材质输入
    ↓
MeshStandardNodeMaterial PBR/IBL → HalfFloat HDR Target → ACES
    ↓
从本帧 Depth 构建 HZB，供下一帧使用
```

### 3.3 reconstructed

```text
CPU 同步 GPU Scene，并组织材质/渲染状态 Bucket 和 FrameGraph
    ↓
GPU Scene Mesh 过滤
    ↓
实例级视锥 + previous-HZB dual cull
    → positive（可直接画）
    → maybe（上一帧 HZB 下不确定/可能被遮挡）
    ↓
Mesh → Meshlet counts → Prefix Scan → 紧凑展开
    ↓
Meshlet 级视锥/HZB dual cull → GPU 写 DrawIndirect 参数
    ↓
Hardware Visibility Raster
    → R32Uint Triangle ID
    → R32Uint Mesh ID
    → Depth32Float reverse-Z
    ↓
用本帧 positive 深度重建 HZB → second-chance 复查 maybe → 补绘新暴露项
    ↓
Material Expand：Visibility → GBuffer
    ↓
Clustered Direct Lighting + IBL/SSR/LPV/Brick4 + OIT + TAA/NSS + 后处理
```

`reconstructed` 的流程更长，不代表每个局部算法都比示例先进；它说明该实现承担的是完整引擎职责，而两个 three.js 文件刻意把问题收窄到一种 GPU 几何管线实验。

## 4. three.js 基础版详解

### 4.1 场景与 LOD

示例程序化创建 7 个 `TeapotGeometry`，从高细节到低细节分别配置几何误差。场景是 `400 × 400 = 160,000` 个茶壶实例。每帧 Compute Shader 根据实例投影大小和 LOD 的误差值计算屏幕误差，在 GPU 上选择适合的几何。

这里的优势是 CPU 不需要为 16 万个实例逐一选择 LOD，也不需要把选择结果读回。选择结果直接流入同一条 GPU 工作生成链。

### 4.2 Chunk 不等于严格意义上的 Meshopt Meshlet

基础版把每个 LOD 的索引顺序按每 64 个三角形切块，并为块计算包围球。它具备 Meshlet 式的细粒度剔除和调度，但没有通过 Meshopt 重新聚类三角形来提高局部性，也没有 Meshopt 的 Clusterizer 元数据。因此本文把它称为 **64-triangle Chunk**，避免把它和 IBL 版的真正 Meshopt Meshlet 混为一谈。

### 4.3 GPU Work Queue

通过实例和 Chunk 测试的任务由 `atomicAdd` 取得写入位置，追加到固定容量的 Storage Buffer。单个任务包含实例、三角形起点、LOD 三角形数、Chunk 索引等信息。随后 GPU 根据队列计数生成 Dispatch 参数，避免 CPU 读回可见任务数量。

这展示了 GPU-Driven 最关键的“生产者—消费者”模式：

```text
GPU culling producer → GPU work queue/count → GPU raster consumer
```

### 4.4 Compute/Hardware 混合光栅化

每个可见 Chunk 中的三角形投影到屏幕后，根据包围盒大小分流：

- 包围盒宽、高都不超过 `16 × 16` 像素：Compute Shader 自己测试覆盖并写原子 Buffer。
- 更大的三角形：追加到 Hardware Queue，随后由 GPU 写出的 DrawIndirect 参数交给固定功能光栅器。

这样做的实验动机是：极小三角形可能让硬件前端承担大量三角形设置工作，却只产生很少像素；Compute 路径可以用 Workgroup 协作和显式调度探索另一种吞吐模型。大三角形覆盖像素多，固定功能光栅器通常更合适。

它不是普遍保证更快。原子竞争、边规则、精度、MSAA、导数、裁剪和平台 GPU 架构都会影响收益，因此必须用目标内容和设备实测。

### 4.5 Packed Visibility 的限制

Compute 路径为了用 `atomicMax` 同时完成深度竞争与身份写入，把深度放在 32 位整数高位，把 ID 放在低位：

- Triangle Buffer：Triangle ID 14 bits + Depth 18 bits。
- Instance Buffer：Instance ID 18 bits + Depth 14 bits。

这种布局紧凑且方便原子比较，但 ID 容量、深度精度和编码方式互相牵制。它很适合封闭示例，不适合不加抽象地成为通用引擎的全局 ID 规范。

还有一个更隐蔽的一致性问题：`screenTri` 与 `screenInst` 是两个独立的 atomic u32，而且分配给 Depth 的 bit 数不同。它们各自的 `atomicMax` 都是原子的，但“两次 atomicMax 合起来”不是一个事务；当两个 Fragment 的深度在其中一个量化精度下相同、在另一个精度下不同，Triangle winner 与 Instance winner 理论上可能来自不同 Fragment。示例场景未必容易触发，但生产实现需要用单一 winner token、二阶段 Resolve 或其他方式保证跨字段一致性。

### 4.6 最终结果

Fullscreen Resolve 读取胜出的 Triangle/Instance ID，取回顶点并重建 UV，主要输出 Meshlet Debug 或 UV Grid。它没有完整法线材质、真实 PBR、IBL 或 HDR 管线，因此基础版应被理解为几何工作生成和混合光栅化实验，而不是完整画质样例。

## 5. three.js IBL 版详解

IBL 版保留基础版的五段 GPU 主链：`computeClear → computeFrustum → computeDispatch → computeRasterize → computeHWArgs`，但把输入、遮挡和着色都提升到更接近真实资产的水平。

### 5.1 真实资产、LOD 与 Meshlet

- 加载 Damaged Helmet glTF 和 UltraHDR 环境图。
- 用 `MeshoptSimplifier` 从源网格生成多级简化几何。
- 用 `MeshoptClusterizer` 构建 Meshlet 和 Meshlet bounds。
- 每个 Meshlet 的三角形槽补齐到 64，以简化统一的 GPU 索引与任务布局。
- 使用 15,625 个实例，可在 `125 × 125` 平面和 `25 × 25 × 25` 体积分布之间切换。

相较基础版，它的 LOD 和 Meshlet 生成更能代表资产管线，而不只是按原索引顺序切块。

### 5.2 上一帧 HZB 遮挡剔除

IBL 版从本帧 RenderTarget Depth 构建层次深度 Buffer，下一帧使用 previous camera 和 previous world matrix 投影包围球，分别执行：

- 实例级 HZB 遮挡测试。
- Meshlet 级 HZB 遮挡测试。

它还有可调 `occlusionBias`，用于在激进剔除与保守性之间留余量。代价是 HZB 来自上一帧：镜头或物体运动后，本帧刚露出的几何可能在历史深度中仍被判断为遮挡。该示例没有像 `reconstructed` 那样再用当前帧 HZB 做 second-chance 补绘。

### 5.3 更完整的 Visibility Resolve

IBL 版的 Compute 光栅结果不只用于调试颜色。Resolve 会根据 Triangle/Instance ID 重建：

- World Position、View Position 和 View Direction。
- Geometry Normal、UV 和透视正确重心坐标。
- `dUvDx/dUvDy` 以及法线相关导数。
- Albedo、Normal Map、Roughness、Metalness、AO 和 Emissive 输入。

它通过 `overrideNodes()` 把重建出的属性接到 `MeshStandardNodeMaterial`，并使用 Specular AA。Hardware 路径使用匹配的材质逻辑，目标是让 SW/HW 分流不改变最终材质意义。

这部分对 `reconstructed` 很有参考价值：Visibility Buffer 的困难不只是“记录 ID”，而是让后续材质阶段得到正确的插值、纹理梯度和法线过滤信息。

### 5.4 HDR 与调试输出

结果先写入 HalfFloat HDR RenderTarget，再经过 ACES tone mapping 输出。示例能查看 Meshlet、Geometry Normal、Normal Map、UV、Roughness、Metalness、AO、Emissive 等中间结果，便于验证两条光栅路径和材质重建。

### 5.5 Packed bits 的源码注释问题

本地文件的实际表达式是：

- `TRIANGLE_INDEX_BITS = 16`，所以 `DEPTH_TRI_MAX = 2 ** (32 - 16) - 1`，实际是 **16-bit depth**。
- `INSTANCE_INDEX_BITS = 17`，所以 `DEPTH_INST_MAX = 2 ** (32 - 17) - 1`，实际是 **15-bit depth**。

其中初始化处写着 `screenTri: depth(17) | megaTriangleIndex(15)`，Depth Resolve 附近也写着 17-bit；这些注释都与实际常量不一致。本文以常量、掩码和表达式的实际结果为准。

另外，固定 Work Queue 容量为 2,820,000 项，Hardware Triangle Queue 容量为 100,000。示例做了边界判断，但固定的大容量预算仍然会带来显著显存占用和场景上限，不宜原样照搬到通用引擎。

## 6. reconstructed 当前 GPU-Driven 架构

### 6.1 GPU Scene，而不是单模型演示数据

[`GPUSceneContext.ts`](../reconstructed/src/gpu/GPUSceneContext.ts) 汇集 Scene Database、材质/纹理、Animation/Skinning、Light/Shadow、TLAS、Probe 和 Volumetrics 等 GPU 侧系统。与两个 three.js 示例的单模型实例阵列相比，它解决的是异构场景的资源所有权、稳定索引、增量更新和跨 Pass 复用。

这也是当前引擎的最大工程优势：Visibility 不是孤立 Demo，而是完整 Renderer 中可被材质、光照、阴影、时序和后处理消费的一环。

### 6.2 Meshlet 数据

[`niMeshlets.ts`](../reconstructed/src/geometry/niMeshlets.ts) 使用 Meshoptimizer 组织 Meshlet，当前上限为：

- 最大 128 顶点。
- 最大 128 三角形。

[`MeshletDrawList.ts`](../reconstructed/src/gpu/MeshletDrawList.ts) 把一个可见 Meshlet 映射成一个间接绘制 Instance；间接命令固定 `vertexCount = 384`，即 `128 × 3`，`instanceCount = visibleMeshletCount`。Shader 对不足上限的部分自行判定无效，因此可以把不同大小的 Meshlet 合入统一 DrawIndirect。

这比 three.js 示例的 64-triangle 工作单元更大。更大 Cluster 可以降低元数据和调度开销，但剔除粒度更粗，也更容易在屏幕边缘或遮挡边界保留多余三角形；最佳值需要结合模型分布、GPU 和 Shader 成本测量。

### 6.3 两级剔除和 GPU 工作生成

主链不是由 CPU 为每个 Meshlet 发 Draw Call，而是：

1. 根据场景 Mesh、材质和渲染状态组织候选 Bucket。
2. GPU 执行实例级视锥/HZB dual cull。
3. 计算每个可见 Mesh 对应的 Meshlet 数量。
4. 通过 Prefix Scan 获得紧凑输出偏移。
5. 展开 Meshlet 候选。
6. 执行 Meshlet 级视锥/HZB dual cull。
7. GPU 写出可见 Meshlet 数量和 DrawIndirect 参数。
8. Render Pass 直接 `drawIndirect`，不把可见数量读回 CPU。

这条链是真正的 GPU-Driven work generation。CPU 仍负责 FrameGraph、Pass、Bucket 和资源生命周期，这是合理的高层控制，不等于退回 CPU-Driven 逐对象绘制。

### 6.4 HZB dual cull 与 second chance

[`HierarchicalZBuffer.ts`](../reconstructed/src/render/HierarchicalZBuffer.ts) 使用 `rg16float`，配合 [`hzb_reduce.ts`](../reconstructed/src/shaders/hzb_reduce.ts) 保存层级深度范围。主深度是 reverse-Z：近处数值更大，清屏为 0。

[`VisibilityPass.ts`](../reconstructed/src/render/passes/VisibilityPass.ts) 和 Meshlet Draw List 把候选划分为 positive 与 maybe：

1. 首轮用上一帧 HZB 剔除并绘制 positive。
2. 从当前帧 positive 深度建立新的 HZB。
3. 用当前 HZB 重新检测 maybe。
4. 把本帧新暴露的内容补绘进 Visibility Buffer。

相比 IBL 示例单纯相信上一帧 HZB，这套策略对快速镜头移动、遮挡物离开等情况更稳健。代价是额外的 HZB 构建、复查和补绘 Pass，以及更复杂的同步与 Buffer 管理。

### 6.5 Hardware Visibility Buffer

[`visibility_meshlet.ts`](../reconstructed/src/shaders/visibility_meshlet.ts) 走 WebGPU 固定功能光栅器。Visibility Pass 输出：

- `R32Uint` Triangle ID。
- `R32Uint` Mesh ID。
- `Depth32Float` reverse-Z。

它没有把深度与 ID 强行压进同一个 32-bit atomic word，因此不像 three.js Compute 路径那样让 ID 位数直接挤占深度精度，并能使用标准深度测试。但 Triangle ID 自身仍有一层 packing：[`MeshletTypes.ts`](../reconstructed/src/geometry/MeshletTypes.ts) 使用高 24 bits 保存全局 Meshlet ID、低 8 bits 保存 Meshlet 内三角形 ID；Mesh ID 则使用另一个完整 `R32Uint` 附件。也就是说，当前 ABI 仍有约 1,677 万 Meshlet 和每 Meshlet 256 三角形的编码上限，只是这个上限不再与 Depth 精度耦合。

### 6.6 Material Expand 与完整 Deferred 管线

[`MaterialExpandPass.ts`](../reconstructed/src/render/passes/MaterialExpandPass.ts) 根据 Visibility 结果扩展 PBR、Normal、Albedo/AO 和 Emissive 等 GBuffer 信息。算法已经包含透视正确重心、UV `ddx/ddy`、`textureSampleGrad`、Normal Map 与 Kaplanyan roughness filtering。需要注意当前运行时 Pipeline 实际由 [`GPUMaterialContext.ts`](../reconstructed/src/gpu/GPUMaterialContext.ts) 引用 [`material_expand_oracle.ts`](../reconstructed/src/shaders/material_expand_oracle.ts)；[`material_expand.ts`](../reconstructed/src/shaders/material_expand.ts) 与 [`meshlet_read.ts`](../reconstructed/src/shaders/meshlet_read.ts) 是更易读的对应实现，但目前不是该 Pipeline 的直接 import。随后 [`Renderer.ts`](../reconstructed/src/render/Renderer.ts) 接入 clustered direct lighting、IBL、SSR、LPV/Brick4、透明 OIT、Velocity、TAA/NSS 和后处理。

这里有一个重要边界：当前 Material Expand 仍由 CPU 遍历材质，并为每种材质发出一次 `draw(3)` 全屏处理。因此，几何可见性和绘制数量主要由 GPU 驱动，但材质展开调度还不是完全 GPU-driven。是否需要进一步 GPU 化，要看实际材质数量和 Fullscreen Pass 成本，而不是只为了追求“100% GPU-Driven”标签。

### 6.7 当前未找到 GPU 几何 LOD 选择

在当前 Visibility 工作生成链中，没有找到与两个 three.js 示例等价的、基于 Screen-Space Error 的 GPU 几何 LOD 选择。代码中的纹理 `lod`、环境贴图 mip 等不能算几何 LOD。

`niMeshlets.ts` 中存在 BVH/层次数据构造相关代码，场景系统也有其他加速结构；这并不自动意味着主 Visibility 链已经在 GPU 上进行 Cluster hierarchy LOD 选择。若要补齐，需要明确：

- 每个 LOD/Cluster 节点的几何误差和包围体。
- 稳定的父子层次或 LOD range。
- GPU 屏幕误差判定。
- 选择后的无重复、无裂缝输出规则。
- 与 Skinning、材质 Bucket、阴影和 second-chance 的一致性。

## 7. 结合代码架构的逐层分析

前面的流程回答了“每帧做什么”，本节回答更具体的四个问题：

1. 哪个对象拥有数据和 GPU 资源？
2. 每个 Buffer 的元素 ABI 是什么？
3. 哪个 Pass 生产它、哪个 Pass 消费它？
4. CPU 只是在编码命令，还是仍参与逐对象决策？

### 7.1 两种完全不同的代码组织方式

| 架构层 | three.js 两个示例 | reconstructed |
| --- | --- | --- |
| 代码边界 | 一个 HTML 中完成资产、Buffer、TSL Shader、UI 和帧循环 | `gpu/`、`render/`、`shaders/`、`framegraph/`、`geometry/` 分层 |
| Shader 表达 | TSL `Fn()`、Node、`storage()`，由 three.js 生成 WGSL | TypeScript 中的显式 WGSL 模块和显式 Pipeline/BindGroup Layout |
| 资源所有权 | `init()` 闭包中的局部变量 | `GraphicsContext`、`GPUSceneContext`、`GPUViewContext`、各 Pass 对象 |
| 调度编排 | `animate()` 中顺序调用 `renderer.compute/render` | `Renderer.render()` 向 `FrameGraph` 登记资源读写和 Side Effect |
| Pipeline 管理 | WebGPURenderer/NodeMaterial 内部完成 | `GraphicsContext` 中 Pipeline、BindGroup、Buffer/Texture allocator 缓存 |
| 场景变化 | 示例初始化后主要更新相机和实例旋转 | `GPUSceneContext.update/build` 按 Scene version 重建或更新数据库 |
| 可复用性 | 算法集中、易读，但与示例资产强耦合 | 模块可复用、可组合，但追踪一次绘制需要跨多个文件 |

three.js 示例的单文件并不是“架构差”，它的目标就是把实验的完整因果链放在一个页面中。`reconstructed` 的分层也不天然更快，它解决的是多场景、多视图、多材质、资源复用和生命周期管理。

### 7.2 three.js 基础版：代码对象和 Buffer 数据流

基础版 `init()` 可以拆成四层。

#### A. CPU 几何预处理层

```text
7 × TeapotGeometry
    ├─ 合并到 vertexArray / uvArray / indexArray
    ├─ 每个 LOD 记录 triangleStart / triangleCount / chunkStart
    └─ 原索引每 64 triangles 计算一个 bounding sphere
```

对应的 GPU 只读输入为：

| Buffer | 元素 | 生产者 | 消费者 |
| --- | --- | --- | --- |
| `vertexBuffer` | `vec4(position, 1)` | JS 合并 7 个 LOD | Compute Raster、HW Vertex Pulling、Resolve |
| `uvBuffer` | `vec2` | JS 合并 7 个 LOD | HW Fragment、Resolve |
| `indexBuffer` | `u32` | JS 把各 LOD 索引改成 mega-buffer 全局索引 | 两条光栅路径和 Resolve |
| `lodOffsetsBuffer` | `uvec4(triangleStart, triangleCount, chunkStart, 0)` | JS | `computeFrustum` |
| `chunkBoundsBuffer` | `vec4(center, radius)` | JS 每 64 三角形计算 | `computeFrustum` Chunk cull |
| `meshletIdBuffer` | 每三角形一个 Debug ID | JS | SW/HW Debug Color |

一个容易忽略的代码细节是：基础版真正的剔除/工作单元是 **64 三角形 Chunk**，但 `meshletTriangleArray` 的 Debug ID 每 **126** 个三角形递增。也就是说，屏幕上的“Meshlet Debug 色块”不严格等于 Work Queue 中的 Chunk；不能仅凭颜色判断 64-triangle culling 的边界。

#### B. 实例状态层

`instanceDataBuffer` 的每项是 `vec4(position.xyz, scale)`。`computeFrustum` 每帧根据 `time + instanceIndex` 生成旋转矩阵，然后写：

- `instanceWorldBuffer[instance]`：供 HW Vertex Pulling 使用。
- `instanceMvpBuffer[instance]`：供 Compute Raster 和 SW Resolve 重投影使用。

所以实例动画本身也在 GPU 上计算。CPU 每帧只更新相机矩阵、相机位置、视锥平面和 FOV 相关 uniform。

#### C. GPU 生成的瞬时工作层

| Buffer | 布局 | 写入阶段 | 读取阶段 |
| --- | --- | --- | --- |
| `workQueueCount` | `atomic<u32>` | `computeFrustum` | `computeDispatch`、`computeRasterize` |
| `workQueue` | `uvec4(instance, lodTriStart, lodTriCount, chunkIndex)` | `computeFrustum` 原子追加 | `computeRasterize` |
| `dispatchBuffer` | WebGPU `x,y,z`，3 × u32 | `computeDispatch` | `computeRasterize.compute(indirect)` |
| `hwQueue` | 基础版为一个 packed u32/triangle | `computeRasterize` 的大三角分支 | HW Vertex Pulling |
| `hwDrawBuffer` | `vertexCount, instanceCount, firstVertex, firstInstance` | `computeHWArgs` | `BufferGeometry.setIndirect()` |

`computeDispatch` 把超过 WebGPU 单维 65,535 Workgroup 的任务拆成二维 dispatch。`computeRasterize` 按“一项 Chunk × 64 invocation”解释任务：

```text
workItemId        = globalInvocation / 64
localTriangle     = globalInvocation % 64
megaTriangleIndex = lodTriStart + chunkIndex × 64 + localTriangle
```

这说明 Work Queue 的粒度是 Chunk，但真正进入三角形投影、背面剔除和 SW/HW 分类时仍是一线程一个三角形槽。

#### D. 像素可见性与合并层

`screenTri` 和 `screenInst` 都是屏幕分辨率大小的 atomic Storage Buffer。Compute Raster 通过 Top-Left Rule、增量 Edge Function、Bounding Box 循环和 `atomicMax` 选出可见三角形。

基础版最终不是把 SW 和 HW 写进同一个 Visibility Buffer：

1. Fullscreen Quad 先读取 SW atomic Buffer，重建 UV 和 Depth。
2. Quad 的 `depthNode` 把自定义 fourth-root depth 还原成硬件 Depth。
3. HW Mesh 后画，并通过标准 Depth Test 与刚才写入的 SW Depth 合并。

因此它的“混合”发生在最终 RenderTarget 的硬件深度测试上，而不是两条路径共同原子写同一份 ID Buffer。

### 7.3 three.js IBL 版在基础架构上增加了什么

IBL 版没有重写主链，而是在相同插槽上替换或增加模块：

```text
Teapot LOD                 → glTF + MeshoptSimplifier LOD
顺序 64-triangle Chunk     → MeshoptClusterizer Meshlet
Position + UV              → Position + Normal + UV + PBR textures
Frustum only               → Frustum + previous-frame HZB
Debug Resolve              → MeshStandardNodeMaterial PBR/IBL Resolve
Canvas                     → HalfFloat Scene RT → ACES → Canvas
```

#### LOD 是“CPU 生成，GPU 选择”

`MeshoptSimplifier.simplifyWithAttributes()` 只在初始化资产时运行；GPU 每帧并不会在线简化网格。每级 LOD 保存累计 world-space error，`computeFrustum` 用：

```text
pixelError ≈ errorWorld × instanceScale
             × cot(FOV/2) × screenHeight / (2 × cameraDistance)
```

从最粗级向细级检查，选择满足 `pixelError <= lodThreshold` 的最粗 LOD。这个区分很重要：GPU-Driven LOD 指 GPU 做**运行时选择**，不代表 GPU 做简化算法。

#### Meshlet 资产布局

`buildMeshlets(indices, positions, 3, 64, 64, 0.25)` 限制最大 64 顶点、64 三角形。代码提取每个 Meshlet 后，把不足 64 的部分补成退化三角形，因此所有 Work Item 仍保持固定 64 槽。当前上传到 `chunkBoundsBuffer` 的只有 Meshlet bounding sphere；Clusterizer 可能计算出的其他信息没有进入该 culling ABI。

#### HZB 是扁平 Storage Buffer，不是 mipmapped Texture

IBL 版把全部层级连续放入一个 `Float32Array`：

```text
hzbLevelTable[level] = vec4(offset, width, height, 0)
hzbBuffer[offset + y × width + x] = farthest depth in region
```

每个层级对应一个 TSL Compute Kernel，Level 0 从完整 DepthTexture 做 2×2 max reduce，后续 Level 从上一段 Buffer reduce。`sphereOccluded()` 根据球体屏幕直径选层级，再取四个角的最大深度做保守测试。

这和 `reconstructed` 的 HZB 资源模型不同：前者便于在单文件 TSL 中手工寻址，后者把 mip 层交给 GPUTexture 和 Texture View 管理，且一份 texel 同时保存 min/max。

#### SW/HW 材质并非共用同一个 Shader 实例

IBL 版建立两套材质节点：

- HW：Vertex Pulling 后由硬件插值 UV/Normal，片元阶段使用硬件 `dFdx/dFdy`。
- SW Resolve：根据 Visibility ID 重投影三角形，解析计算透视重心、UV 梯度和法线梯度。

两者都接入 `MeshStandardNodeMaterial`，使用相同 glTF 纹理和 PBR 参数，但代码路径仍是两套，必须靠 Debug View 和对照图保证结果一致。

#### 固定队列的真实边界风险

代码虽然定义了 `MAX_WORK_ITEMS = 2,820,000` 和 `MAX_HW_TRIANGLES = 100,000`，但计数器是先 `atomicAdd` 再检查是否写 Buffer；后续 Dispatch/Draw 参数又直接使用未 clamp 的计数值。因此在极端溢出时，不只是“少画超出部分”，还可能让后续阶段按超过 Buffer 容量的数量读取。基础版 Work Queue 甚至没有对应的写入边界检查。

这正体现了示例与生产引擎的目标差异：示例用已知场景选择足够大的预算；通用引擎必须提供容量上界、clamped indirect count、overflow telemetry 和可恢复降级。

### 7.4 reconstructed 的对象所有权图

```text
Renderer
├─ GraphicsContext
│  ├─ shared MeshletGpuTable / GPUMaterialRegistry
│  ├─ Pipeline + BindGroup caches
│  └─ Buffer/Texture allocators
├─ ViewManager
│  └─ GPUViewContext(camera, scene)
│     ├─ current GPUCameraState
│     ├─ previous GPUCameraState
│     ├─ per-view HierarchicalZBuffer
│     └─ GPUSceneContext
│        ├─ SceneDatabase(meshes + transforms)
│        ├─ shared MeshletGpuTable reference
│        ├─ Material Registry reference
│        ├─ Animation/Skinning
│        ├─ Lights/Shadows
│        ├─ TLAS
│        └─ Probe/Volumetrics
├─ MeshletDrawList（本帧瞬时工作列表）
├─ VisibilityPass
├─ MaterialExpandPass
└─ Lighting / IBL / SSR / OIT / Temporal / Post passes
```

这里有三类生命周期：

- **共享资源**：Geometry/Meshlet 和 Material Registry 由 `GraphicsContext` 持有，可跨场景复用。
- **每场景资源**：`GPUSceneContext` 持有 Scene Database、灯光、TLAS、动画等。
- **每视图资源**：`GPUViewContext` 持有当前/上一帧 Camera State 和 HZB；同一 Scene 用不同 Camera 渲染时不会错误共享历史遮挡。
- **每帧瞬时资源**：`MeshletDrawList` 通过主 Buffer Allocator 取得 list/count/scan/indirect Buffer，并在 Command Context 完成后归还。

这比 three.js 示例闭包里的全局变量复杂，但解决了“一个资源到底属于设备、场景、视图还是本帧”的核心工程问题。

### 7.5 当前 Shader source-of-truth 仍是混合状态

追踪 TypeScript import 后，当前运行路径并非全部使用同名的易读 Shader 文件：

| 功能 | 当前运行时 import | 易读对应模块 |
| --- | --- | --- |
| 普通 Instance HZB cull、Mesh Expand、Prefix Scan | `oracle_visibility_work_generation.ts` 的 `ORACLE_*` 常量 | `mesh_instance_cull.ts`、`meshlet_expand*.ts`、`meshlet_prefix_scan.ts` |
| Instance/Meshlet dual cull | `mesh_instance_cull_dual.ts`、`meshlet_hzb_cull_dual.ts` | 同一文件，直接使用 |
| Material Depth | `material_depth_oracle.ts` | `material_sr.ts` 等可读模块表达相关语义 |
| Material Expand | `material_expand_oracle.ts` | `material_expand.ts` + `meshlet_read.ts` |
| Hardware Visibility | `visibility_meshlet.ts` | 同一文件，直接使用 |

因此修改前不能只搜索“看起来名字正确”的 WGSL 文件，必须从 Pipeline 创建处反查 import：

- `MeshletDrawList.ts` 决定 Work Generation 实际使用哪份 WGSL。
- `GPUMaterialContext.ts` 决定 Material Depth/Expand 实际使用哪份 WGSL。
- `VisibilityPass.ts` 决定 Visibility Raster 和 Alpha Tested 实际使用哪份 WGSL。

这是当前引擎相比 three.js 单文件示例更明显的维护风险：可读重建模块与 active oracle 常量可能发生语义漂移。引入 GPU LOD 前，最好先为 active Pipeline 建立唯一 source-of-truth 或等价性测试。

### 7.6 GPU Scene 的 CPU → GPU 建库路径

[`GPUSceneContext.build()`](../reconstructed/src/gpu/GPUSceneContext.ts) 的关键调用链是：

```text
Scene.instances
    ↓ materials.obtain(material)
GPUMaterialRegistry / MaterialMetadataTable
    ↓ skinning.obtain_geometry_index(mesh)
shared MeshletGpuTable：取得稳定 geometry index
    ↓ scene.updateMatrices + TLAS.instance_add
SceneDatabase.clear/rebuild
    ├─ addTransform(root / mesh nodes / other nodes)
    └─ addMesh(geometry, material, node, bounds)
    ↓ uploadDatabaseBuild
MeshletGpuTable.update → SceneDatabase.update
```

`SceneDatabase` 的 Mesh Row 至少包含：

```text
geometry index
material index
transform/node row
bounding AABB
bounding sphere
```

Transform Row 包含 local translation/rotation/scale、`global`、`prev_global` 和 parent row。Shader 通过生成的 `scene_read_mesh()` / `scene_read_node()` 读取同一份 paged database。

这一段主要仍是 CPU-Driven 数据维护：CPU 检测 scene instance version、分配稳定 row、打包 typed table 并上传。它不在每帧读取 GPU 可见性结果，也不为每个可见对象提交 Draw Call；所以它与后面的 GPU-Driven Visibility 并不冲突。

### 7.7 Geometry、Meshlet Header 和属性数据 ABI

当前引擎把几何分成三层索引：

```text
Scene Mesh Row.geometry
    ↓
Geometry Meta（每 geometry 64 bytes）
    ├─ bounds sphere / AABB
    ├─ index_count
    ├─ meshlets_address
    └─ meshlets_count
        ↓
Meshlet Header（每 meshlet 40 bytes）
    ├─ local AABB：6 × f32
    ├─ data address：u32 word offset
    ├─ primitive_count
    ├─ vertex_count
    └─ attribute flags
        ↓
Meshlet Data
    ├─ 8-bit local triangle indices，4 个打包到一个 u32
    ├─ position：3 × f32 / vertex
    └─ normal/tangent/color/uv/joints/weights：按 flags 压缩或默认值
```

[`niMeshlets.ts`](../reconstructed/src/geometry/niMeshlets.ts) 的默认上限是 128 vertices / 128 triangles。与 IBL 示例补齐成固定 64 个退化三角形不同，当前引擎在 Header 中保存真实 `primitive_count`；Raster Vertex Shader 仍固定发 384 vertices，但把超出真实三角形范围的 `vertex_index` clamp 到最后一个有效索引。

`niMeshlets.ts` 还会构建 triangle/Meshlet BVH，但该数据进入的是 Geometry BLAS/ray-query 相关用途。当前主 Visibility work generation 读取的是 `meshlets_address + meshlets_count` 的平坦范围，不能把“资产里存在 BVH”误认为“Visibility 已经在做 Cluster hierarchy LOD traversal”。

### 7.8 MeshletDrawList 的列表 ABI

所有主要 list 都以 16-byte Header 开头，Count 位于 byte 0，元素从 byte 16 开始：

```text
Mesh List:
  [count, pad, pad, pad, meshId0, meshId1, ...]

Meshlet List:
  [count, pad, pad, pad,
   meshletId0, meshId0,
   meshletId1, meshId1, ...]
```

主要 Buffer 的职责如下：

| Buffer | 内容 | 生命周期/用途 |
| --- | --- | --- |
| `meshListBuffer` | 视锥过滤后的 Mesh IDs | 所有材质 Bucket 的输入 |
| `bucketCountsBuffer` | 每种渲染状态 Bucket 的 count/scan 临时数据 | GPU Bucket scatter |
| `bucketDataBuffer` | 按 Bucket 紧凑排列的 Mesh IDs | 实例 dual cull 输入 |
| `meshPositiveBuffer` | 上一帧 HZB 下可直接展开的 Mesh | 首轮 Meshlet expand |
| `meshMaybeBuffer` | 上一帧 HZB 下疑似遮挡的 Mesh | second chance 实例复查 |
| `countsBuffer` | 每个 Mesh 的 Meshlet count，之后原地变成 prefix sums | 平坦 Mesh → Meshlet 展开 |
| `spineBuffer` | Blelloch/分块 scan 的中间数据 | Prefix Scan |
| `listBuffer` | 展开后的 `(meshletId, meshId)` | Meshlet cull 或 Raster |
| `positiveBuffer` | Meshlet HZB 后确认可画的 pairs | 首轮或 second chance Raster |
| `meshletMaybeBuffer` | 首轮 Meshlet 遮挡项，以及 second chance 展开的 Meshlet append 目标 | second chance Meshlet 复查 |
| `dispatchArgsBuffer` | 3 × u32 | 多个 Compute Pass 的 `dispatchWorkgroupsIndirect` |
| `argsBuffer` | 4 × u32 | Visibility Raster 的 `drawIndirect` |

容量并非 three.js 示例那样固定为数百万项。`prepareGpuMeshFilterOutput()` 在 CPU 上扫描 SceneDatabase 的 CPU 镜像，计算所有 Meshlet 的保守上界；Buffer 容量按至少 16、随后倍增的策略由 allocator 取得。CPU 仍参与**容量规划**，但实际可见 count 留在 GPU Buffer 中。

### 7.9 从 Scene Mesh 到可见 Meshlet 的真实 Pass 链

Opaque 首轮在代码中不是简单的“Cull → Expand → Draw”，而是：

```text
VisibilityPass.dispatchSceneMeshFilter
  └─ paged SceneDatabase：sphere + AABB frustum test
       输出 meshListBuffer

MeshletDrawList.dispatchBucketScatter
  ├─ ka_ra：读取 Mesh.material metadata，统计 bucket count
  ├─ ka_ga：生成 bucket offsets
  └─ ka_ja：scatter Mesh ID 到 bucketDataBuffer

for each opaque ActiveMaterialBucket（CPU 编码循环）
  ├─ dispatchInstanceCullDual
  │    previous camera + previous HZB
  │    ├─ visible/unprojectable → meshPositiveBuffer
  │    └─ occluded             → meshMaybeBuffer
  │
  ├─ dispatchExpandGpuSp
  │    ├─ ep-counts：每 Mesh 写 meshlets_count
  │    ├─ og-prefix：Prefix Scan
  │    ├─ rp-dispatch：根据总 Meshlet 数写 DispatchIndirect
  │    ├─ $g-expand：二分查 prefix sums，写 (meshletId, meshId)
  │    └─ Yg-commit：提交输出 count
  │
  ├─ dispatchHzbCullDual
  │    current frustum + previous HZB
  │    ├─ positiveBuffer
  │    └─ meshletMaybeBuffer
  │
  ├─ fill_draw_indirect_args
  └─ Visibility/ID+Depth/bucket-N：drawIndirect
```

这里的 CPU `for each bucket` 并没有读回每个 Bucket 的可见数量；Bucket 内 Compute 和 Draw 的规模仍由 GPU count/indirect arguments 决定。它是“CPU 编码少量渲染状态分支 + GPU 驱动大量对象”，不是 CPU 逐 Mesh 绘制。

### 7.10 second chance 的两类 maybe 如何汇合

首轮可能产生两种历史遮挡项：

- `meshMaybeBuffer`：整个 Mesh 在实例级就被上一帧 HZB 判为遮挡，尚未展开 Meshlet。
- `meshletMaybeBuffer`：Mesh 通过实例级测试，但某个 Meshlet 在细粒度 HZB 被判为遮挡。

首轮 positive 完成 Raster 后，`Renderer` 立即从当前 Depth 重建 HZB。第二轮随后执行：

```text
meshMaybeBuffer
    → current-HZB instance cull
    → expand surviving meshes
    → append 到 meshletMaybeBuffer

原 meshletMaybeBuffer + 新 append meshlets
    → current-HZB meshlet cull
    → positiveBuffer
    → 重新按 material bucket scatter
    → per-bucket drawIndirect，load 原 Visibility/Depth
```

第二轮必须重新做 Meshlet Bucket scatter，因为来自不同首轮 Bucket 的 maybe 已经汇入公共列表，而 Raster Pipeline 的 `cullMode` 等状态仍需正确。这个细节是 IBL 示例没有覆盖的通用引擎问题。

`Renderer` 在 opaque second chance 后再次重建 HZB；如果场景有 Alpha Tested 材质，还会执行独立 Alpha Visibility Pass，再第三次重建 HZB。因此当前代码中一帧可能出现多次 HZB build，换取后续阶段看到更完整的深度。

### 7.11 HZB 数据结构与查询差异

| 属性 | three.js IBL | reconstructed |
| --- | --- | --- |
| 资源 | 一个线性 `float` Storage Buffer | 一个 mipmapped `rg16float` GPUTexture |
| Level 0 | 半分辨率 | 半分辨率 |
| Reduce | Compute Kernel/level | Fullscreen Render Pass/mip |
| 深度约定 | 标准方向，far 接近 1；存区域 max/farthest | reverse-Z，far 接近 0；R=min/farthest，G=max/nearest |
| 查询包围体 | Bounding Sphere | 实例/Meshlet AABB 的 8 角投影 |
| 采样 | 手工 level offset，四角读取 | `textureLoad` 指定 mip，四角读取 R 通道 |
| 历史修复 | Bias | positive/maybe + same-frame second chance |
| 复用 | 主要服务示例 culling | 同一 per-view HZB 还可供 light clustering、SSR 等 Pass 使用 |

[`visibility_cull_common.ts`](../reconstructed/src/shaders/visibility_cull_common.ts) 将 AABB 的屏幕跨度转成 mip level，取覆盖矩形四角的 R/min depth；在 reverse-Z 下，区域最小值代表最远遮挡深度，是保守剔除所需的通道。G/max 当前可供需要近端信息的其他算法复用。

### 7.12 Hardware Visibility Raster 的 Vertex Pulling

[`visibility_meshlet.ts`](../reconstructed/src/shaders/visibility_meshlet.ts) 没有传统 Vertex Buffer layout。它利用：

```text
instance_index → Meshlet List 的 (meshletId, meshId)
vertex_index   → Meshlet 内第几个三角形顶点槽
Meshlet Header → primitive_count / data address
Meshlet Data   → 8-bit local index → position
SceneDatabase  → Mesh Row.node → Transform.global
Camera         → view_projection_matrix
```

固定 `vertexCount = 384`，`instanceCount = visibleMeshletCount`，所以一个 DrawIndirect 就可以提交一个 Bucket 的大量 Meshlet。Fragment Shader 只输出：

```text
triangleId = encode(meshletId:24, localTriangle:8)
meshId     = SceneDatabase mesh row
depth      = fixed-function reverse-Z Depth32Float
```

这个设计让 Fragment Shader 极轻，真实纹理和 PBR 不在 Visibility Pass 中执行。代价是 Material Expand 必须再次读取三角形顶点并重建插值属性。

### 7.13 多材质 Material Expand 为什么要先写 Material Depth

three.js IBL 只有一个源 `MeshStandardMaterial`，一个 Fullscreen Resolve 就能处理全部 SW 像素。`reconstructed` 必须支持多个材质，每个材质有自己的 texture BindGroup，而 WebGPU 一个 Draw 内不能随意从数组中动态选择任意传统 BindGroup。

当前解决方法分两步：

1. `Material Expand/depth` 全屏扫描 Mesh ID，根据 `scene_read_mesh(meshId).material` 写 `materialId / 2^24` 到 `depth32float`。
2. CPU 遍历非透明材质；每个材质画一个 Fullscreen Triangle。Vertex Shader 把该材质 ID 写成同样的 Z，Pipeline 使用 `depthCompare = equal`，所以 Fragment Shader 只在属于该材质的像素运行。

随后 Fragment Shader 执行：

```text
Triangle ID → decode meshletId/localTriangle
Mesh ID     → Scene Mesh → node/global + geometry/material
Meshlet Data→ position/normal/tangent/color/uv
            → perspective barycentrics + analytic UV ddx/ddy
            → textureSampleGrad + Normal Map + roughness AA
            → GBuffer(PBR, normal, albedo/AO, emissive)
```

上述逻辑能在 active `material_expand_oracle.ts` 中找到；可读的 `material_expand.ts` 和 `meshlet_read.ts` 提供了同一算法更清晰的结构化版本。因此当前 Material Expand 是一种 **Visibility-driven shading + CPU material pass scheduling**。它的优点是不用 bindless texture 就能支持异构材质；缺点是活跃材质越多，全屏几何和深度测试重复次数越多，即使每次真正执行 Fragment Shader 的像素只属于一个材质。

### 7.14 当前引擎到底哪些部分是 GPU-Driven

| 决策/工作 | 执行方 | 是否需要 CPU 读回 |
| --- | --- | --- |
| 资产 Meshlet 构建、属性打包 | CPU/WASM，加载或建库阶段 | 不适用 |
| Scene Row、Transform、Geometry/Material stable index | CPU | 不适用 |
| Scene Mesh 视锥过滤 | GPU Compute | 否 |
| 按渲染状态 Bucket 统计/Scatter | GPU Compute；CPU 只循环有限 Bucket | 否 |
| 实例 previous-HZB 分类 | GPU Compute | 否 |
| Mesh → Meshlet Count/Scan/Expand | GPU Compute | 否 |
| Meshlet 当前视锥 + previous-HZB 分类 | GPU Compute | 否 |
| Dispatch/Draw 数量 | GPU 写 Indirect Args | 否 |
| Visibility Raster | GPU Hardware Raster | 否 |
| same-frame second chance | GPU Compute + Indirect Draw | 否 |
| Material Expand 的材质遍历 | CPU 编码每材质 Fullscreen Draw | 不读可见数量，但 CPU 决定材质 Pass |
| Lighting/IBL/Post 的 Pass 拓扑 | CPU FrameGraph 编码，GPU 执行 | 通常否 |

所以更准确的定义是：**当前引擎的几何可见性和几何工作量是 GPU-Driven；场景建库、渲染状态拓扑和多材质调度仍由 CPU 组织。**

### 7.15 如果把 three.js 的 GPU LOD 接入当前架构，代码应该落在哪里

不能只在 `visibility_meshlet.ts` 加一个距离判断，因为到 Raster 阶段 Meshlet 已经选完并写入 list。合理插入点在“实例 cull 之后、平坦 Meshlet expand 之前”。

最小的平坦 LOD 方案需要扩展 Geometry ABI：

```text
GeometryFamilyMeta
├─ lod_table_address
├─ lod_count
└─ bounds

GeometryLodMeta[]
├─ meshlets_address
├─ meshlets_count
├─ geometric_error
└─ optional bounds
```

然后把当前：

```text
Mesh ID → GeometryMeta.meshlets_count → Prefix Scan → Expand
```

改成：

```text
Mesh ID + Camera
  → select_lod(error × projection scale)
  → SelectedMesh(meshId, lodAddress, meshletCount)
  → Prefix Scan → Expand selected range
```

`Meshlet List` 仍输出 `(meshletId, meshId)`，所以 Hardware Visibility Raster 可以保持不变。Material Expand 也可以继续用全局 Meshlet ID 读属性；主要改动集中在 Geometry Meta、LOD 资产生成和 Expand 输入。

需要同步处理的系统包括：

- **Skinning**：每级 LOD 是否共享骨骼顶点、clone geometry address 如何稳定。
- **Velocity/TAA**：上一帧和当前帧 LOD 不同，Triangle ID 无法一一对应时如何生成稳定 Motion Vector。
- **Shadow**：主相机屏幕误差不能直接用于不同 Shadow Camera；需要 shadow-specific threshold。
- **HZB second chance**：LOD 选择使用当前 Camera，历史 HZB 只负责遮挡；不要让历史相机错误决定当前 LOD。
- **Material Bucket**：LOD 内 Meshlet 必须保持与 Mesh 材质/渲染状态一致，或把 material range 纳入 Cluster metadata。
- **ID 容量**：全部 LOD 共用全局 Meshlet 24-bit 空间，需要在上传时检查上限。

### 7.16 如果实验 Compute Rasterizer，接入点和 ABI 问题

最小侵入的插入点是 `dispatchHzbCullDual/secondChance` 之后、`fill_draw_indirect_args` 之前：

```text
visible Meshlet List
    → micro-triangle classifier
       ├─ Hardware Meshlet/triangle queue → 现有 Hardware Visibility
       └─ Software triangle queue         → Compute Raster
```

但不能直接复制 three.js 的两个 atomic u32，因为当前下游要求：

- Triangle ID：`meshlet24 | localTriangle8`。
- Mesh ID：独立 SceneDatabase row。
- Depth：reverse-Z `Depth32Float`。
- Alpha Tested、Velocity、Material Expand 和 second chance 都读取这一语义。

WebGPU 基线没有一个原子操作能同时更新 Depth、Triangle ID 和 Mesh ID 三个独立 32-bit 值。可选原型方式是：

1. SW 路径先写局部 packed atomic Buffer，内部位预算只服务微三角形队列。
2. Fullscreen Resolve 把胜者转换为引擎统一 Triangle/Mesh ID，并写硬件 Depth。
3. 现有 HW Visibility Pass 使用 `load`，让固定功能 Depth Test 与 SW 结果合并。

这与 three.js 的“SW Resolve 先写 Depth，HW 后覆盖”结构相似，但必须适配 reverse-Z、现有 ID ABI 和 FrameGraph 资源依赖。第一阶段应排除 Alpha Tested、Transparent、Shadow 和 Skinned 特例，只验证 opaque static mesh 的真实性能收益。

## 8. 逐项对比

| 维度 | three.js 基础版 | three.js IBL 版 | reconstructed |
| --- | --- | --- | --- |
| 目标 | 教学/实验：GPU LOD + 混合光栅 | 真实材质实验：混合光栅 + PBR/IBL/HZB | 通用 GPU-Driven Renderer |
| 场景 | 单个程序化茶壶的大量实例 | 单个 Damaged Helmet 的大量实例 | 异构场景、Mesh、材质、灯光、动画等 |
| 实例数 | 160,000 | 15,625 | 动态场景容量，不绑定示例常量 |
| GPU Scene | 简化的示例 Buffer | 简化的示例 Buffer | 有 SceneDatabase 和多类 GPU 常驻资源 |
| 几何 LOD | 7 个程序化 LOD，GPU SSE 选择 | MeshoptSimplifier 生成，GPU SSE 选择 | 主 Visibility 链未发现明确 GPU 几何 LOD |
| 几何小块 | 原索引顺序每 64 三角形切 Chunk | MeshoptClusterizer Meshlet，补齐到 64 三角形 | Meshoptimizer Meshlet，最多 128 顶点/128 三角形 |
| 实例剔除 | 视锥 | 视锥 + previous HZB | 视锥 + HZB dual cull |
| Meshlet 剔除 | Chunk 包围球视锥 | Meshlet 包围球视锥 + previous HZB | Meshlet 视锥 + HZB dual cull |
| 历史遮挡误差修复 | 无 HZB | Bias；无 second chance | 当前帧 HZB second chance 补绘 |
| 工作紧凑化 | 原子追加固定 Work Queue | 原子追加固定 Work Queue | Counts + Prefix Scan + 紧凑列表 |
| 间接执行 | Compute dispatch + HW draw indirect | Compute dispatch + HW draw indirect | GPU drawIndirect；多阶段 GPU 工作生成 |
| 光栅化 | 小三角 Compute，大三角 Hardware | 小三角 Compute，大三角 Hardware | Hardware Visibility Raster |
| SW/HW 阈值 | 最大 `16 × 16` 像素 | 最大 `32 × 32` 像素 | 不适用 |
| 可见性表示 | 两个 packed atomic u32 | 两个 packed atomic u32 | Triangle：Meshlet 24 bits + Local Triangle 8 bits；另有 Mesh R32Uint + Depth32Float |
| 材质 | UV/Grid/Debug | MeshStandardNodeMaterial PBR/IBL | Material Expand + Deferred PBR 管线 |
| 导数处理 | 已解析 UV 梯度，服务纹理调试 | 解析 UV/Normal 导数 + Specular AA | 已解析 UV 梯度 + `textureSampleGrad`；roughness AA 仍含 `fwidth` 路径 |
| HDR/Tone Mapping | 无完整 HDR 管线 | HalfFloat + ACES | 完整 HDR/曝光/Tonemap 管线 |
| 动画/Skinning | 无 | 无通用系统 | 有 GPU Animation/Skinning 系统 |
| 阴影/透明 | 无 | 非完整通用系统 | Shadow + Transparent OIT |
| 时序/后处理 | 无 | 基础输出 | Velocity、TAA/NSS、SSR、Bloom 等 |
| 可扩展性 | 常量与单文件耦合，适合读代码 | 仍是单文件示例和固定容量队列 | 模块化，但系统复杂、组合成本高 |

## 9. 优缺点

### 9.1 three.js 基础版

优点：

- 单文件就能看到从剔除、LOD、队列、间接参数到两种光栅路径的完整闭环。
- 160,000 个实例使 CPU 逐对象调度与 GPU 批量调度的差异很直观。
- GPU Screen-Space Error LOD 是当前引擎值得吸收的核心算法。
- Compute/Hardware 分流和调试显示便于研究微三角形问题。

缺点：

- Chunk 只是顺序切分，不代表高质量 Meshlet 聚类。
- 没有 HZB 遮挡剔除。
- 没有真实材质、完整属性重建、HDR 和引擎系统。
- 固定大 Buffer、固定容量和 packed bit budget 限制场景规模。
- Triangle 与 Instance 分开执行 `atomicMax` 且 Depth 量化位数不同，缺少跨 Buffer 的 winner 原子一致性保证。
- Work/HW Queue 的 counter 可能超过实际 Buffer 容量，Indirect 参数又没有 clamp；它依赖示例场景不溢出，而不是完整的生产级 overflow 处理。
- Debug Meshlet ID 以 126 三角形分组，与真正 64 三角形 Chunk 的工作边界并不一致。
- Compute Rasterizer 的精度、边规则、导数和 MSAA 等问题被示例范围简化。

### 9.2 three.js IBL 版

优点：

- Meshopt LOD/Meshlet 更接近真实资产预处理。
- 实例和 Meshlet 两级 HZB 剔除减少被遮挡工作。
- 演示了 Visibility Resolve 如何接入真实 PBR/IBL，而不是只输出 ID 调试色。
- 解析导数、Normal Map、Specular AA 和 SW/HW 材质匹配很有研究价值。
- 调试输出丰富，便于发现插值、材质和路径不一致。

缺点：

- 仍围绕单模型、单组示例材质和固定实例布局，无法代表通用 Scene Database。
- previous HZB 没有 second chance，动态遮挡下需要依赖保守 Bias。
- 固定 2,820,000 Work Items 和 100,000 HW Triangles，显存预算与上限不自适应。
- 队列写入虽然部分有边界判断，但原子 counter 和最终 Indirect Count 没有同步 clamp；真正溢出时仍可能越界消费。
- ID 与深度 packing 绑定；Triangle ID、Instance ID、Depth 精度之间存在硬限制。
- Compute/Hardware 两套路径增加 Shader 维护、验证和跨设备性能调优成本。
- 本地源码有一处 bit 数注释与实际表达式不一致，说明此类低层布局需要自动化测试保护。

### 9.3 reconstructed

优点：

- GPU Scene、稳定资源表和完整渲染管线适合真实异构场景。
- 实例级与 Meshlet 级 GPU 剔除、Prefix Scan、DrawIndirect 构成成熟的 GPU 工作生成链。
- previous HZB + current HZB second chance 比只用历史 HZB 更稳健。
- 标准 Hardware Raster 和独立 ID/Depth 附件规避 packed atomic 的 ID/深度位数耦合。
- Visibility 能继续服务 Deferred Lighting、IBL、SSR、阴影、OIT、TAA/NSS 等系统。
- 材质和渲染状态 Bucket 比单模型示例更接近生产需求。
- Material Expand 已实现透视重心、解析 UV 梯度、`textureSampleGrad`、Normal Map 和 roughness AA，不是只有 ID 输出的简化 Visibility Buffer。

缺点：

- 系统复杂度明显更高，资源生命周期、Pass 排序、Bucket 和多轮 HZB 更难调试。
- 当前主 Visibility 链缺少明确的 GPU Screen-Space Error 几何 LOD，远处或小投影 Meshlet 仍可能展开和提交过多几何。
- 先按 Mesh 展开 Meshlet 再剔除，若没有层次 LOD/Cluster traversal，超高密度资产的候选生成成本可能较高。
- 只走 Hardware Raster，无法利用 Compute Rasterizer 在特定微三角形负载上的潜在收益。
- Material Expand 的每材质 CPU 循环和 Fullscreen `draw(3)` 会随活跃材质数量增长。
- `prepareGpuMeshFilterOutput()` 仍在 CPU 上扫描 Mesh Row 计算 Meshlet 容量上界；它不参与可见性判断，但超大动态场景中也需要计入帧开销。
- Work Generation 和 Material Expand 仍混用 active oracle WGSL 与易读重建 WGSL；修改错误文件或两份实现漂移是现实维护风险。
- 两个 R32Uint + Depth32Float 相比紧凑 packed Buffer 使用更多附件带宽；换来的是更通用的 ID 空间和标准深度行为。Triangle ID 仍固定为 Meshlet 24 bits + Local Triangle 8 bits，需要容量检查。
- second chance 提高正确性和稳定性，但增加额外 HZB、Compute 与补绘成本。

## 10. 对 reconstructed 的建议

### P0：先补观测，不先换光栅器

增加可视化和 GPU 统计：

- 每帧候选/可见 Mesh、Meshlet、Triangle 数。
- 实例视锥剔除、实例 HZB 剔除、Meshlet 视锥剔除、Meshlet HZB 剔除各自命中数。
- positive、maybe、second-chance 补绘数量及耗时。
- Meshlet 屏幕包围盒尺寸直方图，特别是 `≤ 1 px`、`≤ 4 px`、`≤ 16 px`、`≤ 32 px`。
- Material Bucket 数和 Material Expand 全屏绘制次数。
- LOD 级别、屏幕误差、Meshlet ID 和遮挡结果 Debug View。

没有这些数据，无法判断瓶颈来自候选展开、硬件三角形设置、像素着色、附件带宽，还是材质展开。

### P1：补 GPU Screen-Space Error 几何 LOD

优先借鉴 three.js 两个示例的 LOD 判定思想，但不要照搬其单模型数组布局。建议把以下数据纳入现有 GPU Scene/MeshletGpuTable：

- LOD/Cluster 的对象空间 bounds。
- 简化产生的几何误差。
- LOD range 或父子 Cluster 索引。
- 材质、蒙皮和几何流的稳定引用。

GPU 应在大规模 Meshlet 展开前尽早选择 LOD。这样不仅减少最终三角形，还减少候选 Meshlet、Prefix Scan、剔除和间接绘制工作。

切换策略需要考虑迟滞或时间稳定性，否则 TAA 下会出现 LOD 闪烁；阴影、Velocity、second chance 和主视图也应使用语义一致的 LOD 规则。

### P2：从平坦 LOD 走向 Cluster hierarchy

对超高密度网格，单纯在多个完整 Mesh LOD 中选一个仍可能粒度过粗。可以评估层次 Cluster traversal：父 Cluster 屏幕误差足够小时直接输出父级代理，否则展开子节点。

这与 `reconstructed` 已有 Prefix Scan 和间接调度框架相容。需要注意，`niMeshlets.ts` 的 `buildCsBvh()` 当前构造的是 triangle/Meshlet BLAS，主要服务 ray-query；它不是带 geometric error 和代理几何的 LOD Cluster hierarchy。可以复用 Meshlet bounds、打包和分配设施，但不应把现有 BLAS 节点直接当作 LOD 节点。

### P3：验证已有导数链，并补强法线导数一致性

当前 active oracle Shader 已有解析重心坐标、UV `ddx/ddy`、`textureSampleGrad` 和 roughness filtering，不应把任务定义成“重新实现导数”。参考 IBL 示例建立明确的对照验证项，并验证 `material_expand_oracle.ts` 与可读 `material_expand.ts`/`meshlet_read.ts` 的等价性：

- 透视正确的重心坐标。
- UV 梯度、upscale ratio 下的 mip bias 和纹理 mip 选择。
- Geometry Normal、tangent frame 与 Normal Map。
- 对比当前 `fwidth(mapped normal projection)` 与 IBL 解析 `dNdx/dNdy`；确认三角形边界和不同 Visibility ID 相邻时是否污染 Specular AA。
- Hardware Visibility、Alpha-tested、Material Expand、Velocity 等路径的属性一致性。

建议把 Debug View 和小型截图/数值回归测试放在同一批工作中，因为此类错误常表现为远处闪烁、错误 mip、法线接缝或 TAA 拖影。

### P4：只在数据支持时原型化 Compute Rasterizer

满足以下条件后才值得做隔离原型：

1. 统计确认大比例可见三角形覆盖极少像素。
2. GPU profile 显示 Hardware Visibility 的 primitive setup/front-end 是主要瓶颈。
3. 目标 GPU 上 Storage Atomic 和 Compute occupancy 足以抵消软件实现成本。
4. 已定义 SW/HW 一致的裁剪、填充规则、Depth、Alpha Test、导数、Velocity 和 Debug 规范。

原型可以先只处理 opaque、single-sample、极小屏幕包围盒的 Meshlet/triangle，保留现有 Hardware Visibility 作为主路径和回退。不要一开始就把 Compute Rasterizer 扩散到阴影、透明、蒙皮和所有材质。

### P5：评估 Material Expand 调度，而不是默认重写

先记录每帧活跃材质数和 Material Expand GPU 时间。如果大量材质导致全屏三角形重复扫描成为瓶颈，再评估：

- GPU 生成像素/Tile 的材质列表。
- Material classification 后按材质间接 Dispatch。
- 更统一的 bindless/resident material 执行模型。

若实际活跃材质很少，现有 CPU 循环可能更简单、更稳定，并不需要为了概念纯度重写。

## 11. 不建议直接照搬的部分

### 11.1 不直接替换成 Compute Rasterizer

当前引擎已有 Hardware Visibility、reverse-Z、second chance、Material Expand 和完整 FrameGraph。整体替换会同时影响深度、ID、Alpha Test、Velocity、阴影、材质、时序和调试，风险远大于先补 GPU LOD 的收益确定性。

### 11.2 不采用示例的 Depth + Payload packed 规范

示例把 Depth 和 Triangle/Instance Payload 放进同一个 u32，是为 `atomicMax` 服务的局部算法选择。当前引擎的 Triangle ID 虽然也使用 `meshlet24 | triangle8` packing，但它与独立 `Depth32Float` 没有共享位数预算。若未来引入 Compute 路径，可以只在 SW Raster 临时 Buffer 内局部 packing，Resolve 后转换到引擎统一 Visibility 表示，避免降低主路径 Depth 精度。

### 11.3 不复制固定巨大 Work Queue

应基于场景容量、上一帧峰值和安全上限分配，提供 overflow counter、Debug 警告和可恢复降级。固定数百万项既浪费小场景显存，也不能证明超大场景不会溢出。

### 11.4 不复制单模型/单材质布局

示例布局有利于阅读，但会绕开 `reconstructed` 已解决的稳定 GPU 索引、异构材质、动画、资源流送和 Bucket 问题。应把 LOD/Meshlet 元数据整合进现有 Scene Database，而不是旁建一套“Demo Scene Buffer”。

### 11.5 不退回仅 previous-HZB

IBL 示例的 previous-HZB 很适合展示概念，但 `reconstructed` 的 second chance 已解决更真实的动态场景问题。引入 LOD 或 hierarchy 时应保持这项优势，并明确 LOD 变化后的 bounds 与历史可见性如何匹配。

## 12. 建议的验证顺序

若按本文建议推进，可用以下顺序降低风险：

1. 加入 GPU 统计和 Debug View，建立现状基线。
2. 为静态 opaque Mesh 实现离线/加载期 LOD 误差数据。
3. 在实例剔除后、Meshlet 全量展开前加入 GPU LOD 选择。
4. 对比候选 Meshlet、可见三角形、GPU 时间和画面误差。
5. 加入迟滞、Velocity、阴影、蒙皮与 second-chance 兼容。
6. 再评估 Cluster hierarchy。
7. 最后依据微三角形统计决定是否做 Compute Rasterizer 原型。

验收不应只看平均 FPS，还应检查：快速转动镜头时是否漏绘、LOD 是否闪烁、TAA/Velocity 是否一致、极端材质数是否退化、Work Queue 是否溢出，以及多个目标 GPU 上的性能方差。

## 13. 代码索引

three.js 示例：

- [基础 Compute Rasterizer](../../../three.js/examples/webgpu_compute_rasterizer.html)
- [Compute Rasterizer + IBL](../../../three.js/examples/webgpu_compute_rasterizer_ibl.html)

`reconstructed` 关键入口：

- [GPUSceneContext.ts](../reconstructed/src/gpu/GPUSceneContext.ts)：GPU Scene 各子系统所有权。
- [SceneDatabase.ts](../reconstructed/src/gpu/SceneDatabase.ts)：Mesh/Transform typed table 与 GPU frustum filter。
- [MeshletGpuTable.ts](../reconstructed/src/gpu/MeshletGpuTable.ts)：Geometry Meta、全局 Meshlet Header/Data 所有权。
- [MeshletDrawList.ts](../reconstructed/src/gpu/MeshletDrawList.ts)：实例/Meshlet GPU 工作生成、Prefix Scan、HZB cull 和间接参数。
- [VisibilityPass.ts](../reconstructed/src/render/passes/VisibilityPass.ts)：Visibility attachments、Raster Pass 和 second chance 编排。
- [ViewContext.ts](../reconstructed/src/render/ViewContext.ts)：per-view 当前/历史 Camera 与 HZB 生命周期。
- [HierarchicalZBuffer.ts](../reconstructed/src/render/HierarchicalZBuffer.ts)：HZB 资源和格式。
- [hzb_reduce.ts](../reconstructed/src/shaders/hzb_reduce.ts)：HZB min/max reduce。
- [visibility_cull_common.ts](../reconstructed/src/shaders/visibility_cull_common.ts)：AABB 投影、mip 选择和保守 HZB 查询。
- [oracle_visibility_work_generation.ts](../reconstructed/src/shaders/oracle_visibility_work_generation.ts)：当前运行时普通 Instance Cull、Prefix Scan 和 Meshlet Expand 的 active WGSL。
- [meshlet_expand.ts](../reconstructed/src/shaders/meshlet_expand.ts)：易读的 Meshlet Expand 对应实现；当前 DrawList 不直接 import。
- [visibility_meshlet.ts](../reconstructed/src/shaders/visibility_meshlet.ts)：Hardware Meshlet Visibility Shader。
- [MaterialExpandPass.ts](../reconstructed/src/render/passes/MaterialExpandPass.ts)：Visibility 到 GBuffer。
- [GPUMaterialContext.ts](../reconstructed/src/gpu/GPUMaterialContext.ts)：Material Pipeline 的实际 Shader import 和 BindGroup ABI。
- [material_expand_oracle.ts](../reconstructed/src/shaders/material_expand_oracle.ts)：当前运行时 Material Expand 的 active WGSL。
- [meshlet_read.ts](../reconstructed/src/shaders/meshlet_read.ts)：易读的 Meshlet 属性读取、透视重心和解析 UV 导数模块。
- [material_expand.ts](../reconstructed/src/shaders/material_expand.ts)：易读的纹理梯度、Normal Map、roughness AA 和 GBuffer 编码对应实现。
- [MeshletTypes.ts](../reconstructed/src/geometry/MeshletTypes.ts)：Triangle Visibility ID 的 24/8 bit packing ABI。
- [niMeshlets.ts](../reconstructed/src/geometry/niMeshlets.ts)：Meshoptimizer Meshlet 构建和打包。
- [Renderer.ts](../reconstructed/src/render/Renderer.ts)：完整 FrameGraph 和后续渲染管线。
