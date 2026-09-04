# OEngine 领域路由

第一次搜索或修改前读本页。先从首选源码根定位真实 owner，再读一份权威文档；不要从历史任务编号扩大搜索范围。

| 任务 | 首选源码根 | 权威文档 |
| --- | --- | --- |
| 产品范围、平台、workload | `OEngine/src/index.ts`、Renderer capability | `docs/PRODUCT.md` |
| 导入、Cook、meshoptimizer、Runtime Asset | `OEngine/src/loaders`、`OEngine/src/geometry` | `docs/ARCHITECTURE.md`、`docs/porting/geometry.md` |
| Scene、实例、patch | `OEngine/src/scene`、`OEngine/src/gpu/GpuScene.ts` | `docs/ARCHITECTURE.md` |
| GPU 资产、表、resident、Packed Scene | `OEngine/src/gpu` | `docs/ARCHITECTURE.md`、`docs/adr/0002-runtime-assets-and-gpu-driven.md` |
| Meshlet、Cluster、hierarchy、SSE | `OEngine/src/geometry`、`OEngine/src/gpu` | `docs/PIPELINE.md`、`docs/porting/geometry.md` |
| Culling、HZB、Indirect、VisibilityKey | `OEngine/src/gpu`、`OEngine/src/render/passes`、`OEngine/src/shaders` | `docs/PIPELINE.md`、`docs/porting/visibility.md` |
| Surface、材质、光照、阴影、GI/AO/SSR/OIT/TAA/Post | `OEngine/src/render`、`OEngine/src/material`、`OEngine/src/shaders` | `docs/PIPELINE.md`、`docs/porting/shading.md` |
| Device、limits、FrameGraph、cache、readback | `OEngine/src/gpu/GraphicsContext.ts`、`OEngine/src/framegraph` | `docs/ARCHITECTURE.md`、`docs/porting/platform.md` |
| 性能、内存、counter、browser evidence | `OEngine/src/debug`、`OEngine/benchmarks`、`examples/rendering-lab` | `docs/VALIDATION.md` |
| 当前风险、迁移顺序 | 命中的生产 owner | `docs/STATUS.md` |

## 共享入口

- 文档总入口：`docs/README.md`
- 长期架构决策：`docs/adr/`
- 外部来源与许可证：`docs/porting/`
- 公开 interface：`OEngine/src/index.ts`
- 当前浏览器 fixture：`examples/rendering-lab/`

外部项目不在本仓库保存镜像。需要采用算法时，从 porting ledger 的固定 URL/revision 路由到上游；无许可证或未登记来源的表达性代码不得复制。
