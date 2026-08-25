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
three.js 示例：必须追平的垂直性能基线
OEngine：统一到完整游戏引擎核心与效果管线
```

## 许可证

- 只复制明确兼容许可证的代码，并保留必要声明。
- 无许可证或 All Rights Reserved 项目只能用于概念核对，不得复制、翻译或移植实现。
- 原生 Vulkan/wgpu 项目只迁移算法思想；WebGPU 缺失能力必须重新设计 fallback。
