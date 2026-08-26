# GPU-Driven 参考项目映射

参考项目提供证据和设计对照，不自动决定 OEngine 实现。

| 项目 | 主要学习对象 | 不能直接照搬 |
|---|---|---|
| three.js compute rasterizer | 最短 GPU LOD/work queue/SW-HW/resolve 闭环 | 单模型布局、固定巨型队列、低位宽 packed visibility |
| three.js compute rasterizer IBL | HZB、真实材质属性重建、PBR/IBL | 单 source material、示例生命周期和多次 submit |
| Scthe/nanite-webgpu | Meshlet LOD hierarchy、误差、SW/HW、统计 | 无通用 GPU Scene/Visibility Buffer/streaming |
| Bevy Meshlet Renderer | Cooker ABI、BVH8、实例→BVH→Cluster、early/late visibility | Vulkan/Metal 特性要求、64 位原子、subgroup 假设 |
| renderling | GPU-resident slab、owner、frustum/HZB、indirect | native multi-draw-indirect 和未完成遮挡路径 |
| Niagara | 紧凑 GPU Scene ABI、分阶段 work generation、LOD/HZB/Meshlet | Vulkan 专有提交能力 |
| PlayCanvas | GPU scan/scatter、WebGPU backend/cache | GSplat 专用链不等于通用 Mesh GPU-driven |
| Babylon.js | Device、Pipeline/BindGroup cache、FrameGraph、浏览器工程化 | 通用 Mesh 主链不是目标 GPU-driven 架构 |
| RedGPU / bundle-culling | 最短实例 compact/LOD/indirect fast path | 功能窄、部分项目许可证不允许复制 |

## 组合原则

```text
Bevy / nanite-webgpu：资产层次与混合 Visibility
Niagara：工作生成和 ABI 简洁性
renderling：GPU Render World 所有权
PlayCanvas / Babylon：WebGPU 工程基础设施
three.js 示例：必须达到的最低垂直功能/性能基线，不是产品上限
OEngine：统一到完整游戏引擎核心与效果管线
```

## three.js 基线边界

两个 compute rasterizer 示例提供的是可运行的最低闭环和直接性能对照：GPU LOD/work generation、Software/Hardware Visibility、材质属性重建和 PBR/IBL。OEngine 应优先核对并在许可证允许时移植其中成熟算法，但不得把示例的单模型、单 source material、固定队列和示例级生命周期固化成产品架构。

“达到 A/B”只表示最低闭环达标。OEngine 还必须把该能力推广到多 geometry/material、动态对象与 Packed Instances、GPU Render World、hierarchy/SSE LOD、Shadow/Transparency/Lighting/Temporal/Post，以及完整 device/resource 生命周期；这些能力由 C 和通用 vertical cases 验证。

## 许可证

- 只复制明确兼容许可证的代码，并保留必要声明。
- 无许可证或 All Rights Reserved 项目只能用于概念核对，不得复制、翻译或移植实现。
- 原生 Vulkan/wgpu 项目只迁移算法思想；WebGPU 缺失能力必须重新设计 fallback。

## 实现移植记录

具体算法开始编码前，应先在本页映射的项目中定位可运行源码，而不是只根据项目简介或论文重新实现。每个移植任务必须固定以下证据：

```text
upstream repository URL
commit / tag
source file(s) and relevant test/example
license and retained notice
copied/ported algorithm scope
OEngine/WebGPU adaptations
known semantic or precision differences
local regression example/test
```

提交中的注释不必堆叠整段上游说明，但必须能链接到仓库内的移植记录。没有兼容许可证时只记录算法对照和独立验证，不复制表达性代码。

### R0 异步 readback 生命周期

```text
upstream repository URL: https://github.com/mrdoob/three.js
commit: 7cda7e710d884827fc73ff1a3aa63270846513d7
source: src/renderers/webgpu/utils/WebGPUTimestampQueryPool.js
license: MIT
scope: timestamp readback buffer 的 map/unmap/destroy 生命周期设计参考；未复制算法代码
retained invariants: resolve 与 COPY_DST/MAP_READ 分离、mapState 检查、禁止并发 pending resolve、map 后复制 ArrayBuffer 再 unmap、destroy 处理 pending/mapped 状态
OEngine adaptations: 固定至少 3 slots；主 encoder 编码 copy；submit 后异步 map；ring 满丢样本并计数；按 frameIndex 归档；profiler off 不分配 counter/ring
semantic differences: three.js owner 是 timestamp query pool；OEngine owner 是通用 GpuReadbackRing，目前首个 consumer 为 256-byte frame counter ABI
local regression: OEngine/tests/gpu-readback-ring.test.mjs、OEngine/tests/r0-observability.test.mjs、examples/r0-frame-smoke
```

### R0 最终 Visibility 像素统计

```text
upstream repository URL: https://github.com/Scthe/nanite-webgpu
commit: b9cd33f65bb3cdba0464717e0fa621d330d2116f
source: src/sys_web/stats.ts、src/passes/rasterizeCombine/rasterizeCombine.wgsl.ts
license: MIT
scope: 参考 Rendered/SW/HW 工作量字段语义，以及空像素 sentinel 不进入 resolve 的语义；没有复制统计实现
retained invariants: 最终 Visibility 只有真实 surface pixel 进入后续 resolve；统计字段必须来自 GPU 实际结果
OEngine adaptations: 对最终 r32uint mesh-id attachment 做 8×8 workgroup shared-memory reduction，每个工作组最多两次全局 atomicAdd，直接写入 256-byte counter ABI
semantic differences: 上游没有最终 Visibility 像素 reduction；OEngine mesh-id sentinel 为 1 << 24，并要求 shadedPixels + emptyVisibilityPixels 严格等于内部渲染像素数；shadedPixels 当前表示非空 Visibility coverage，不是 Material/Lighting invocation
local regression: OEngine/tests/visibility-counter-pass.test.mjs、OEngine/tests/r0-observability.test.mjs、examples/r0-frame-smoke
```

### R0 Visibility 工作量字段语义

```text
upstream repository URL: https://github.com/Scthe/nanite-webgpu
commit: b9cd33f65bb3cdba0464717e0fa621d330d2116f
source: src/sys_web/stats.ts
license: MIT
scope: 参考 Rendered/Hardware/Software triangle 与 cluster 工作量字段的可解释语义；没有复制 reducer 或队列实现
retained invariants: 工作量统计来自 GPU producer/consumer 的真实队列；HW triangle 表示送入硬件路径的 primitive；overflow 不能静默
OEngine adaptations: 采样帧以 1-workgroup GPU reducer读取 count-prefixed queue raw count，根据真实 Buffer size、header 与 element stride 推导 capacity，并原子累加到固定 counter ABI；scene filter 额外使用实际 dispatch 输入 row 数推导 candidate/accepted/frustum-rejected 不变量；HW/alpha 当前按 drawIndirect 固定 384 vertices 换算为每 Meshlet 128 个 submitted primitives；同一 reducer 也覆盖 4-byte header 的 LightCluster filtered list
semantic differences: 上游统计围绕其 hierarchy/SW-HW pipeline；OEngine 当前还没有 SW raster/hierarchy，candidateClusters 是现有所有 visibility wave/bucket 的队列项总和，不声明唯一 cluster；queueOverflowMask 使用稳定 bit ABI，目前接通 scene-mesh、meshlet 与 light list
local regression: OEngine/tests/gpu-list-counter-accumulator.test.mjs、examples/r0-frame-smoke
```
