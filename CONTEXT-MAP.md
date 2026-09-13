# OEngine 领域路由

第一次搜索或修改前读本页。先从首选源码根定位真实 owner，再读一份权威文档；不要从历史任务编号扩大搜索范围。

| 任务 | 首选源码根 | 权威文档 |
| --- | --- | --- |
| 产品范围、平台、workload | `OEngine/src/index.ts`、Renderer capability | `docs/PRODUCT.md`、`docs/WEBGPU.md` |
| 导入、Cook、meshoptimizer、Runtime Asset | `OEngine/src/loaders`、`OEngine/src/geometry`、`OEngine/src/assets` | `docs/ARCHITECTURE.md`、`docs/porting/geometry.md` |
| Scene、实例、patch | `OEngine/src/scene`、`OEngine/src/gpu/GpuScene.ts`、`OEngine/src/gpu/GpuRenderWorld.ts` | `docs/ARCHITECTURE.md`、`docs/adr/0006-packed-render-world-convergence.md` |
| GPU 资产、表、resident、Packed Scene | `OEngine/src/gpu` | `docs/ARCHITECTURE.md`、`docs/adr/0002-runtime-assets-and-gpu-driven.md`、`docs/adr/0006-packed-render-world-convergence.md` |
| Meshlet、Cluster、hierarchy、SSE | `OEngine/src/geometry`、`OEngine/src/gpu` | `docs/PIPELINE.md`、`docs/porting/geometry.md` |
| Culling、HZB、Indirect、VisibilityKey | `OEngine/src/gpu`、`OEngine/src/render/passes`、`OEngine/src/shaders` | `docs/PIPELINE.md`、`docs/porting/visibility.md` |
| Surface、材质、光照、阴影、GI/AO/SSR/OIT/TAA/Post | `OEngine/src/render`、`OEngine/src/material`、`OEngine/src/shaders` | `docs/PIPELINE.md`、`docs/porting/shading.md` |
| Device、features/limits、WGSL、FrameGraph、cache、readback | `OEngine/src/gpu/GraphicsContext.ts`、`OEngine/src/render/pipeline/MainRenderPipeline.ts`、`OEngine/src/framegraph` | `docs/WEBGPU.md`、`docs/ARCHITECTURE.md`、`docs/porting/platform.md` |
| 正确性、性能、counter、Inspector、browser evidence | `OEngine/tests`、`OEngine/src/debug`、`OEngine/src/addons/inspector`、`OEngine/benchmarks`、`validation/` | `docs/VALIDATION.md`、`docs/adr/0014-browser-validation-and-performance-host.md` |
| 当前风险、迁移顺序 | 命中的生产 owner | `docs/STATUS.md` |

## 共享入口

- 文档总入口：`docs/README.md`
- 长期架构决策：`docs/adr/`
- 外部来源与许可证：`docs/porting/`
- 公开 interface：`OEngine/src/index.ts`
- 示例库：`examples/`，standalone Vite MPA + Storybook iframe catalog；不承担验证或正式性能测试
- 浏览器验证与性能宿主：`validation/`；边界由 [ADR-0014](docs/adr/0014-browser-validation-and-performance-host.md) 定义
- 示例库重置历史边界：[ADR-0012](docs/adr/0012-example-library-reset.md)

外部项目不在本仓库保存镜像。需要采用算法时，从 porting ledger 的固定 URL/revision 路由到上游；无许可证或未登记来源的表达性代码不得复制。
