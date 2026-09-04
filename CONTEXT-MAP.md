# OEngine 领域路由

第一次搜索或修改前完整阅读本文件。先在首选搜索根中定位 owner；只有命中跨领域符号或 Context 无法解释时才扩大范围。

| 任务关键词 | 领域 Context | 首选搜索根 |
|---|---|---|
| 导入、Cook、meshopt、压缩、运行时资产 | `docs/contexts/asset-pipeline/CONTEXT.md` | `OEngine/src/loaders`、`OEngine/src/geometry` |
| Scene、Node、World、Change Set、实例 | `docs/contexts/world-runtime/CONTEXT.md` | `OEngine/src/scene`、`OEngine/src/animation` |
| GPU Scene、表、handle、resident、allocator | `docs/contexts/gpu-world/CONTEXT.md` | `OEngine/src/gpu` |
| Meshlet、Cluster、LOD、BVH、几何误差 | `docs/contexts/geometry/CONTEXT.md` | `OEngine/src/geometry`、`OEngine/src/gpu/GeometryBlasPool.ts` |
| Culling、HZB、Indirect、Visibility、软光栅 | `docs/contexts/visibility/CONTEXT.md` | `OEngine/src/render/passes/VisibilityPass.ts`、`OEngine/src/gpu/MeshletDrawList.ts`、`OEngine/src/shaders` |
| 材质解析、GBuffer、光照、阴影、TAA、SSR | `docs/contexts/shading/CONTEXT.md` | `OEngine/src/render/passes`、`OEngine/src/material`、`OEngine/src/shaders` |
| Device、WebGPU limits、Canvas、资源缓存 | `docs/contexts/platform/CONTEXT.md` | `OEngine/src/gpu/GraphicsContext.ts`、`OEngine/src/core/WebGPUTypes.ts` |
| FPS、GPU timestamp、带宽、benchmark | `docs/contexts/performance/CONTEXT.md` | `docs/PERFORMANCE.md`、`OEngine/src/framegraph`、相关 Pass |
| 实施状态、步骤、迁移、删除、验收 | `docs/implementation/STATUS.md` → `docs/implementation/README.md` | `docs/implementation`、命中的代码领域 |

## 共享入口

- 项目词汇：`docs/CONTEXT.md`
- 产品方向：`docs/DIRECTION.md`
- 当前目标平台与 workload：`docs/TARGETS.md`
- 总体架构：`docs/ARCHITECTURE.md`
- 一帧主管线：`docs/RENDER-PIPELINE.md`
- 当前事实：`docs/CURRENT-STATE.md`
- 长期决策：`docs/wiki/adr/`
- 详细执行：`docs/implementation/README.md`
- Agent 工作方法：`docs/wiki/agents/`
- 外部项目路由：`docs/references/README.md`

## 研究与移植参考

- 当前 GPU-driven 核心、Visibility/Material、画质与 WebGPU 工程参考：`docs/references/README.md`。
- 开源复用、许可证、性能和 WebGPU 适配门槛：docs/references/OPEN-SOURCE-REUSE.md。
- 简要项目映射和已有 OEngine 移植记录：docs/references/GPU-DRIVEN.md。
- 超大世界、虚拟化几何、高级 GI 等非当前范围研究：`docs/references/deferred/`。

## 本地参考边界

- `three.js/examples/webgpu_compute_rasterizer*.html`：性能和算法基线。
- `three.js/src`、`three.js/examples/jsm`：three.js authored source。
- `webgpufundamentals/`：WebGPU 学习材料。
- 参考代码只能提供证据；许可证、WebGPU 能力和 OEngine ABI 必须重新核对。
