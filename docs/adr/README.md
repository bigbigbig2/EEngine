# OEngine ADR

ADR 只保存跨模块、长期且仍有解释价值的决策。它不承担规格书、实施计划、当前状态或验证日志。

## 生命周期

- `proposed`：可讨论，不能覆盖现有 accepted 决策。
- `accepted`：方向已批准，不代表实现、验证或切换完成。
- `superseded`：不再约束新实现，替代关系写入正文。
- `rejected`：明确不采用，保留拒绝理由。

每篇 ADR 仅包含 Context、Decision、Consequences、Verification。目标控制在能一次读完的长度；精确字段进入 [specs](../specs/README.md)，活跃切片进入 [implementation](../implementation/README.md)，可变状态进入 [STATUS](../STATUS.md)。

## 索引

- [0001 · GPU-first 产品范围](./0001-gpu-first-scope.md)
- [0002 · Runtime Asset 与 GPU-driven](./0002-runtime-assets-and-gpu-driven.md)
- [0003 · 统一渲染主管线](./0003-unified-render-pipeline.md)
- [0004 · Visibility-to-Surface（已由 0013 替代）](./0004-visibility-to-surface.md)
- [0006 · Packed Render World 收敛](./0006-packed-render-world-convergence.md)
- [0007 · GPU-native Runtime Assets 与 Residency](./0007-gpu-native-runtime-assets-and-residency-v2.md)
- [0008 · GPU-driven Geometry 与 Hardware Visibility](./0008-gpu-driven-geometry-and-visibility-v2.md)
- [0009 · Advanced Frame Pipeline](./0009-compute-shading-and-advanced-frame-pipeline-v2.md)
- [0010 · WebGPU 2026 Desktop 能力合同](./0010-webgpu-2026-capability-contract.md)
- [0011 · Asset Codec 与 GPU-native Texture](./0011-asset-codec-and-gpu-native-texture-pipeline-v3.md)
- [0012 · Example Library 边界](./0012-example-library-reset.md)
- [0013 · Sparse Shading Bin](./0013-sparse-shading-bin-pipeline.md)
- [0014 · 独立浏览器验证宿主](./0014-browser-validation-and-performance-host.md)
- [0015 · Visibility-native PBR Receiver](./0015-visibility-native-pbr-receiver.md)
- [0016 · Runtime-first 虚拟化资产](./0016-virtualized-assets.md)
- [0016-A · OEGPACK V3 与 Offline Geometry Cooker](./0016-a-geometry-pack-and-cooker.md)
- [0016-B · Geometry Product Admission 与 Virtual Geometry Residency](./0016-b-virtual-geometry-residency.md)
- [0016-C · Virtual Geometry 生产消费与原子切换](./0016-c-v3-geometry-consumption.md)
- [0016-D · Progressive Texture Delivery 与 Physical Residency](./0016-d-progressive-texture-residency.md)
- [0017 · Geometry Product 增量发布与页身份解耦](./0017-incremental-geometry-product-publication.md)
