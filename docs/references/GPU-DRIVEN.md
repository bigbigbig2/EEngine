# GPU-Driven 参考项目映射

参考项目提供证据和设计对照，不自动决定 OEngine 实现。当前任务先从 [参考入口](./README.md) 选择直接命中的项目；本页保留项目总表和 R0/R1 历史移植记录。

当前核心算法见 [GPU-DRIVEN-CORE](./GPU-DRIVEN-CORE.md) 与 [VISIBILITY-AND-MATERIAL](./VISIBILITY-AND-MATERIAL.md)；画质和平台分别见 [RENDER-QUALITY](./RENDER-QUALITY.md) 与 [WEBGPU-INFRASTRUCTURE](./WEBGPU-INFRASTRUCTURE.md)。开源复用、许可证、性能和 WebGPU 适配门槛见 [OPEN-SOURCE-REUSE.md](./OPEN-SOURCE-REUSE.md)。

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
meshoptimizer / Bevy：资产层次、误差与 validator
AnKi / Niagara：GPU Scene、工作生成和 ABI 简洁性
nanite-webgpu / The Forge：Visibility、SW/HW 与 Material Resolve
Filament / glTF Sample Viewer：PBR/IBL reference
PlayCanvas / Babylon：WebGPU 工程基础设施
three.js 示例：必须达到的最低垂直功能/性能基线，不是产品上限
OEngine：统一为中大型高密度场景的桌面 WebGPU GPU-driven 管线
```

## three.js 基线边界

两个 compute rasterizer 示例提供的是可运行的最低闭环和直接性能对照：GPU LOD/work generation、Software/Hardware Visibility、材质属性重建和 PBR/IBL。OEngine 应优先核对并在许可证允许时移植其中成熟算法，但不得把示例的单模型、单 source material、固定队列和示例级生命周期固化成产品架构。

“达到 A/B”只表示最低闭环达标。OEngine 还必须把该能力推广到多 geometry/material、Packed Instances、compact GPU tables、hierarchy/SSE LOD、单次 Material Resolve、动态灯光、CSM、Temporal/Upscaling、内存与 feature-off；这些能力由 C 和通用 workload 验证。超大世界、完整 Gameplay 生命周期和专用内容系统不属于当前完成 Gate。

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

### R0 HZB reject 统计语义

```text
upstream repository URL: https://github.com/mrdoob/three.js、https://github.com/Scthe/nanite-webgpu
commit: three.js 7cda7e710d884827fc73ff1a3aa63270846513d7；nanite-webgpu b9cd33f65bb3cdba0464717e0fa621d330d2116f
source: three.js/examples/webgpu_compute_rasterizer_ibl.html；nanite-webgpu src/sys_web/stats.ts
license: MIT
scope: 只核对 HZB reject 应来自实际 GPU 遮挡判断、并作为独立工作量证据的语义；未复制 culling 或统计实现
retained invariants: HZB reject 与 frustum/offscreen reject 分离；统计来自真实执行的 GPU 分支；零值与 unsupported 不混淆
OEngine adaptations: 为现有 initial、dual、second-chance Visibility HZB Shader 生成 sampled-only variant，在 depth-query reject 分支对固定 counter ABI 执行 atomicAdd；非采样 variant 不带 counter binding/atomic
semantic differences: rejectedHzb 是各 Visibility wave 的 reject event 总和，同一逻辑 Cluster 可重复；它不是唯一 Cluster 数，也不是逐像素 reject-reason debug view
local regression: OEngine/tests/hzb-reject-counter.test.mjs、OEngine/tests/benchmark-evidence-gate.test.mjs、examples/r0-frame-smoke
```

### R1-C Compute HZB 金字塔

```text
upstream repository URL: https://github.com/mrdoob/three.js
commit: 7cda7e710d884827fc73ff1a3aa63270846513d7
source: examples/webgpu_compute_rasterizer_ibl.html:557-624、1626-1671、1757-1762
license: MIT
scope: 移植逐 level storage compute pyramid、2D workgroup dispatch 和越界保护的算法结构；没有复制 TSL 表达式、packed buffer ABI 或示例生命周期
retained invariants: level 0 从真实深度生成；后续 level 只读上一层；每层覆盖全部 source texel；GPU 上完成 producer→consumer，不做 CPU readback 驱动
OEngine adaptations: 使用 WebGPU rg16float storage texture；每 texel 保存 reverse-Z farthest(min)/nearest(max)；奇数尺寸按 floor/ceil coverage 映射；一个 Compute Pass 内逐 mip dispatch；per-view 两张 texture 承担 previous/current ping-pong
semantic differences: three.js 上游使用 packed storage buffer 和单深度值、level 0 为 ceil 半分辨率；OEngine 保留已有 texture consumer ABI 和 min/max pair，level 0 沿用 floor 半分辨率，并由 CPU/GPU reference 验证边界不遗漏；history/FrameGraph owner 为 OEngine 自有设计
accepted bound: 每次 build 固定 1 Compute Pass，dispatches = mipCount，HZB Render Pass = 0；后续只有 paired benchmark 证明需要时才升级为 SPD/subgroup 方案
local regression: OEngine/tests/hzb-compute.test.mjs、examples/r1-compute-hzb、examples/r0-frame-smoke
```
