# OEngine 领域路由

第一次搜索或修改前读本页。先从源码定位真实 owner，再读取一份当前事实页；不要用历史 ADR 的阶段编号扩大搜索范围。

| 任务 | 首选源码根 | 先读 | 按需再读 |
| --- | --- | --- | --- |
| 产品、平台、workload | `OEngine/src/index.ts`、Renderer capability | `docs/PRODUCT.md`、`docs/WEBGPU.md` | `docs/adr/` |
| 资产导入、Cook、package | `OEngine/src/loaders`、`OEngine/src/geometry`、`OEngine/src/assets` | `docs/ARCHITECTURE.md` | `docs/specs/`、`docs/porting/geometry.md` |
| Scene、实例、patch、GPU 表 | `OEngine/src/scene`、`OEngine/src/gpu` | `docs/ARCHITECTURE.md` | ADR-0002、ADR-0006 |
| Meshlet、hierarchy、SSE、虚拟几何 | `OEngine/src/geometry`、`OEngine/src/assets`、`OEngine/src/gpu` | `docs/PIPELINE.md`、`docs/STATUS.md` | ADR-0016 系列、`docs/specs/`、`docs/implementation/` |
| Culling、HZB、Indirect、VisibilityKey | `OEngine/src/gpu`、`OEngine/src/render/passes`、`OEngine/src/shaders` | `docs/PIPELINE.md` | ADR-0008、ADR-0013、`docs/porting/visibility.md` |
| 材质、光照、阴影、GI/AO/SSR/OIT/Temporal/Post | `OEngine/src/render`、`OEngine/src/material`、`OEngine/src/shaders` | `docs/PIPELINE.md` | ADR-0009、ADR-0013、ADR-0015、`docs/porting/shading.md` |
| Device、feature/limit、FrameGraph | `OEngine/src/gpu/GraphicsContext.ts`、`OEngine/src/framegraph`、`OEngine/src/render/pipeline` | `docs/WEBGPU.md`、`docs/ARCHITECTURE.md` | ADR-0010、`docs/porting/platform.md` |
| 正确性、性能、浏览器证据 | `OEngine/tests`、`OEngine/benchmarks`、`validation/` | `docs/VALIDATION.md` | ADR-0014、case registry |
| 当前风险和交付顺序 | 命中的生产 owner | `docs/STATUS.md` | `docs/implementation/` |

## 文档入口

- 总入口：`docs/README.md`
- 决策：`docs/adr/`
- 精确合同：`docs/specs/`
- 活跃实施：`docs/implementation/`
- 外部来源：`docs/porting/`
- 非权威研究：`docs/others/`
- 示例：`examples/`；不承担浏览器验证或正式性能测试
- 验证宿主：`validation/`；边界由 [ADR-0014](docs/adr/0014-browser-validation-and-performance-host.md) 定义

外部项目不在本仓库保存运行时镜像。复用实现时从 porting ledger 的固定 revision 路由到上游；无许可证或未登记来源的表达性代码不得复制。
