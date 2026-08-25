# OEngine 推进路线

路线是依赖顺序，不是功能档位。每阶段必须有可运行 benchmark 和退出标准。

three.js 的 A/B 只是最低垂直功能与性能基线，不是路线终点。A/B 证明 GPU LOD、work generation、SW/HW Visibility 与 PBR/IBL 基础闭环不落后；C 和通用 vertical/lifecycle cases 继续证明 OEngine 在多资产、动态世界、效果完整性、生命周期与扩展性上超过样例范围。所有阶段最终汇入一条主管线。

可直接领取的任务、ABI、迁移和验收门禁见 [详细实施手册](./implementation/README.md)。

## R0 · 建立真实性

实施包：[01 · 基线与可观测性](./implementation/01-baseline-and-observability.md)

- 固定 three.js A/B 最低基线与 OEngine C 通用能力 benchmark。
- 为现有主帧补 CPU/GPU 分段、submit/readback、工作量计数和 debug view。
- 能切换现有 Visibility/HZB/Material Expand 的关键阶段。
- 明确实际运行 Shader source-of-truth。

退出：能够解释一帧慢在资产候选、工作生成、光栅、材质、带宽还是运行时提交。

## R1 · 收紧运行时成本

实施包：[02 · 单帧提交、FrameGraph 与 HZB](./implementation/02-runtime-submit-and-framegraph.md)

- 合并主帧 submit，移除空 animation flush。
- 统计 readback 改为显式采样。
- 缓存稳定 FrameGraph 拓扑。
- HZB 改为 Compute 编码，消除逐 mip Render Pass。
- feature off 达到近零成本。

退出：空场景和简单场景固定成本有明确预算。

## R2 · GPU-ready 资产与 Render World

实施包：[03 · Runtime Asset 与 GPU Render World](./implementation/03-runtime-assets-and-gpu-world.md)、[04 · Geometry Cooker 与层次结构](./implementation/04-geometry-cooker-and-hierarchy.md)

- 冻结 Runtime Asset/Resident Resource seam。
- 建立 versioned Geometry ABI、稳定 handle 和增量 Change Set。
- 建立 Packed Instance Set。
- Cooker 输出 Meshlet、Cluster Group、误差和 BVH8。

退出：大量实例和异构资产不依赖 JS 对象数量线性扩张。

## R3 · 层次工作生成

实施包：[05 · 层次工作生成](./implementation/05-hierarchical-work-generation.md)

- Instance → BVH → Cluster GPU traversal。
- SSE LOD、frustum/cone/HZB culling。
- 紧凑 SelectedCluster queue 和明确 overflow。
- 只在必要位置保留 scan/scatter。

退出：在 Raster 前显著减少候选 Cluster，并在 A/B/C benchmark 可量化。

## R4 · Hybrid Visibility

实施包：[06 · 软硬件混合 Visibility](./implementation/06-hybrid-visibility.md)

- 统一 VisibilityKey 和 VisibleCluster table。
- Compute micro-raster 深度/ID 正确性原型。
- Hardware queue 与统一 depth/visibility 合并。
- 动态阈值、SW/HW 统计和跨 GPU 对比。

退出：Hybrid 在目标微三角形场景有收益，其他场景不明显退化。

## R5 · 单次材质解析与效果管线

实施包：[07 · 单次 Material Resolve](./implementation/07-material-resolve.md)、[08 · Lighting、Temporal 与 Post](./implementation/08-lighting-temporal-post.md)

- MaterialTable、纹理页和单次 Standard PBR Resolve。
- 移除每材质全屏扫描。
- 压缩 GBuffer/Surface 数据并评估 resolve-lighting fusion。
- 逐项恢复并验证 Lighting、Shadow、Transparency、Temporal/Post。

退出：效果打开/关闭的成本和资源依赖透明，同画质 B/C benchmark 达标。

## 后续

全驻留层次、生命周期和 benchmark 稳定后，再以数据决定 geometry residency/streaming、虚拟化阴影、更复杂 GI、native enhanced profile 或完整 Gameplay/Editor 扩张。
