# OEngine 参考与移植入口

`references` 提供外部证据，不拥有产品方向或执行状态。当前方向由 `docs/DIRECTION.md`、`docs/TARGETS.md`、ADR 和 `docs/ROADMAP.md` 决定。

## 当前阅读顺序

| 要解决的问题 | 首选文档 |
|---|---|
| GPU Scene、Meshlet、Hierarchy、Work Queue、Indirect Consumer | [GPU-DRIVEN-CORE.md](./GPU-DRIVEN-CORE.md) |
| VisibilityKey、HW/SW Raster、Material Resolve | [VISIBILITY-AND-MATERIAL.md](./VISIBILITY-AND-MATERIAL.md) |
| PBR/IBL、Clustered Lighting、CSM、Temporal/Upscaling | [RENDER-QUALITY.md](./RENDER-QUALITY.md) |
| WebGPU capability、cache、format 和工程约束 | [WEBGPU-INFRASTRUCTURE.md](./WEBGPU-INFRASTRUCTURE.md) |
| 项目总表与已有历史移植记录 | [GPU-DRIVEN.md](./GPU-DRIVEN.md) |
| 许可证、采用方式和完成门槛 | [OPEN-SOURCE-REUSE.md](./OPEN-SOURCE-REUSE.md) |
| 已采用算法的固定登记 | [porting/README.md](./porting/README.md) |

## 优先级

### 当前核心

- three.js compute rasterizer：最低 WebGPU 垂直闭环和直接性能对照。
- Scthe/nanite-webgpu：WGSL hierarchy、SW/HW raster、HZB 和统计。
- meshoptimizer：Meshlet/Cooker、bounds、cone 和顶点局部性。
- Bevy Meshlet：hierarchy/BVH8/error/validator；不照搬原生 capability。
- AnKi/Niagara：GPU Scene、cull/compact/work generation 数据流。
- The Forge TVB：Visibility Buffer、Material Resolve、Forward+/OIT。
- Filament/glTF Sample Viewer：PBR/IBL/材质语义和视觉 reference。
- PlayCanvas/Babylon：WebGPU pipeline/bind group/cache 工程实践。

### Deferred

Nanite streaming、World Partition、3D Tiles、Virtual Shadow Map、ReSTIR/Falcor 高级 GI、terrain/foliage/hair、完整 ECS/animation 等保存在 [deferred](./deferred/README.md)。它们不进入当前 Gate，除非新的 ADR/目标文档明确提升优先级。

## 使用规则

1. 先从本页选择与任务直接相关的核心参考，不进行无目标的大范围项目扫描。
2. 定位上游真实源码、测试、commit/tag 和许可证，README/博客不能单独证明正确性或性能。
3. 在 [porting](./porting/README.md) 或任务文档记录采用、移植、独立实现或拒绝理由。
4. 将上游算法转换成 OEngine 自己的 ABI、owner、capacity、overflow/fallback 和 WebGPU consumer。
5. 以本地 reference test、浏览器 example 和固定 benchmark 关闭任务。
