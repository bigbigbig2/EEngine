# OEngine 产品级渲染管线目标设计

> 状态：目标设计快照，不是当前实现状态。
>
> 当前源码事实：[CURRENT-STATE](../CURRENT-STATE.md)；阶段状态：[STATUS](./STATUS.md)；当前执行：[11-render-pipeline-reconstruction](./11-render-pipeline-reconstruction.md)。

## 1. 产品边界

- 面向桌面 WebGPU 和独立 GPU，不为低端设备维护另一套真实管线。
- 目标基线为 1920×1080、DPR 1、60 FPS，默认配置为中等偏高；初始化配置可覆盖参数或关闭单项 Feature。
- 保留 GPU Scene、Packed Instances、层次工作生成、Hardware-first Visibility、VisibilityKey 和 GPU producer → GPU consumer 闭环。
- 只有一条主管线；Feature 关闭时不保留无消费者 Pass、资源、history、readback 或独立 submit。
- 画面不以当前旧实现为兼容基准，以目标画质、正确性、性能、显存和可观测性 Gate 为准。

## 2. 目标帧结构

```text
Scene / Asset Patch
  → GPU Scene + ViewContext
  → Hierarchy / SSE / Culling / Work Generation
  → Hardware Visibility Buffer + Depth / HZB
  → Single Material Resolve → Surface + Velocity
  → Clustered Direct + Shadow
  → GI / IBL + AO + Local Probe / SSSR correction
  → Transparency / OIT
  → Temporal Reconstruction / TAAU + DRS
  → HDR Post (Exposure / Bloom / Grading / Sharpen / Tonemap)
  → Present
```

FrameGraph 是唯一执行编排层，FramePlan 只解释跨 graph 的依赖和更新频率。默认单 CommandEncoder、单主 Queue Submit。

## 3. 所有权与数据合同

### GPU Scene

Runtime Asset、GPU 资源表和 Scene 表分离。CPU 只提交资产、transform/material/light patch、camera/frame 参数和 Graph 配置；CPU 不遍历完整对象列表生成最终可见列表。

### Visibility

Hierarchy traversal 在 Meshlet 展开前完成 SSE、frustum、cone 和 previous-HZB culling，输出有界 `VisibleCluster`、`RasterWork` 和 indirect args。每个 GPU queue 必须声明 ABI、容量、overflow/fallback、producer、consumer 和计数器。Hardware consumer 使用统一 `VisibilityKey + reverse-Z depth`；Compute Software Raster/Hybrid 是未来 adapter，不是当前默认路径。

### Surface

单次 Material Resolve 根据 VisibilityKey 回查 RasterWork、Geometry、Instance、Material 和有界纹理引用，输出 Standard PBR Surface、Material AO、Emissive、Velocity 和 metadata。禁止恢复每材质全屏扫描或逐像素矩阵求逆。

### Lighting

统一线性 HDR 方程消费 Surface、clusters、shadow、GI、AO 和 environment。Direct、IBL、emissive、透明和后处理不得互相隐式覆盖或重复解释材质。

## 4. 默认效果组合

### Direct Light / Shadow

动态 Directional、Point、Spot 进入 GPU Light Table 和 clustered list，列表必须有界并报告 attempted/written/overflow/fallback。默认产生阴影；CSM 是 directional baseline，软阴影和近距离 Contact Shadow 由 Shadow Service 承担。Packed point/spot shadow 仍是待完成能力，不在此目标快照中伪装成现状。

### GI / IBL

GI Provider 采用可独立启用的双层方案：静态 Lightmap 与动态 Probe Volume；缺失时回退到 IBL，再回退到无间接光。IBL 同时提供 GGX specular radiance、diffuse irradiance 和 split-sum LUT。动态灯光允许影响静态场景的间接光。

### Reflection

反射组合为 `Local Reflection Probe → SSSR correction → IBL fallback`。Opaque Lighting 先产生完整 specular baseline，SSSR 只输出 `resolved - baseline` correction；miss、越界、低置信度和粗糙表面连续回退，不写黑色覆盖。

### AO

AO 独立输出 Material AO、Diffuse Visibility、Specular Visibility 和 Bent Normal。GTAO 使用 physical-meter 半径、linear/view depth、depth mip、边缘感知滤波、half-resolution 默认和共享 opaque validity；不得把 GTAO 写回 Material AO 或直接乘最终颜色。

### Transparency

透明对象使用独立 Forward/OIT 资源和合成，复用同一 Light/Shadow/GI/Reflection 输入，不破坏不透明 Visibility/Surface。透明贡献写入 Reactive/Velocity 语义，Transmission、Refraction 和透明动态 GI 留作扩展。

### Temporal / Upscale

Temporal Feature 统一 jitter、Velocity、Depth、Reactive、Disocclusion、颜色 history 和 DRS。Opaque 与 Final validity 分层；AO/SSR 可维护独立 history，但最终 TAA/TAAU 不替上游隐藏错误。Velocity 已包含 jitter delta，resolve 不二次补偿。DRS 只使用固定 resolution buckets 和已完成 GPU timestamp，不使用 CPU frame-time governor。

### HDR Post

```text
Final HDR Internal
  → TAA/TAAU
  → Exposure Meter + Bloom Pyramid
  → Bloom Composite
  → HDR-aware Sharpen
  → Color Grading
  → Tonemap / Output Transform
  → Present
```

Exposure 输入必须独立于 Bloom 开关；working-linear、scene-referred 和 display/output color space 必须显式声明。

## 5. 配置原则

- 默认效果开启，初始化 `RendererConfig` 覆盖 Feature bits、resolution scale、meters 参数和 history 开关。
- Topology/resource 变化与 runtime uniform 变化分离；滑块更新不得无故重建 Graph。
- 不设计 Low/Medium/High 三套真实管线，也不引入隐藏运行时质量 Governor。
- 跨 internal/output resolution 的消费者必须声明 domain conversion 和 history invalidation 规则。

## 6. 开源算法采用规则

所有算法先从 [references](../references/README.md) 路由到成熟实现或规格。可采用状态只有：直接依赖、可追溯局部移植、按规格独立实现、拒绝采用。移植记录必须包含上游仓库、commit/tag、源码路径、许可证、保留不变量、WebGPU 差异、fallback 和 paired benchmark。不能把删掉关键步骤的“简化移植”当作完成。

## 7. 完成定义

目标设计只有在以下证据全部成立后，才能在 [STATUS](./STATUS.md) 标为产品闭环：

1. producer/consumer、ABI、容量、overflow、fallback 和 completion-safe lifecycle 成立；
2. CPU/reference/GPU/browser 正确性和真实截图/序列通过；
3. GPU phase、整帧预算、显存、上传和 transient/history 预算通过固定条件 benchmark；
4. Feature-off 接近零成本；
5. 被替代的 legacy consumer、shader、资源 owner 和配置已删除；
6. 目标场景覆盖静态几何、动态灯光、室内 GI、Local Probe/SSSR、Temporal Stress 和 Heavy Workload。

具体执行顺序和删除任务不在本文重复，统一由 [11-render-pipeline-reconstruction](./11-render-pipeline-reconstruction.md) 管理。

## 8. 明确非目标

完整 World Partition、超大世界坐标、Virtual Geometry/Shadow/Texture、ReSTIR/Lumen-like GI、硬件光追、地形/植被/角色/粒子/云/水专用 Renderer、完整 Gameplay/ECS/Editor 和 Decal 均不属于当前产品闭环；重新纳入必须更新 ADR、目标 workload 和 Gate。
