# OEngine ADR

ADR 只记录仍生效且跨多个模块的长期决定。`accepted` 表示迁移方向已批准，不表示实现、production cutover 或 ADR completion；实现事实放在 `ARCHITECTURE.md`，当前进度放在 `STATUS.md`，完成语义遵循 [`VALIDATION.md`](../VALIDATION.md)。

- [0001 · GPU-first 范围](./0001-gpu-first-scope.md)
- [0002 · Runtime Asset 与 GPU-driven](./0002-runtime-assets-and-gpu-driven.md)
- [0003 · 统一渲染管线](./0003-unified-render-pipeline.md)
- [0004 · Visibility-to-Surface](./0004-visibility-to-surface.md)
- [0006 · Packed Render World 收敛与实施顺序](./0006-packed-render-world-convergence.md)
- [0007 · GPU-native Runtime Assets 与 Residency V2](./0007-gpu-native-runtime-assets-and-residency-v2.md)
- [0008 · GPU-driven Geometry 与 Visibility V2](./0008-gpu-driven-geometry-and-visibility-v2.md)
- [0009 · Compute Shading 与 Advanced Frame Pipeline V2](./0009-compute-shading-and-advanced-frame-pipeline-v2.md)
- [0010 · WebGPU 2026 Desktop 能力合同](./0010-webgpu-2026-capability-contract.md)
- [0011 · Asset Codec 与 GPU-Native Texture Pipeline V3](./0011-asset-codec-and-gpu-native-texture-pipeline-v3.md)
- [0012 · 示例库重置与重建设计边界](./0012-example-library-reset.md)

新 ADR 必须说明 Context、Decision、Consequences 和 Verification。被替代的演化过程只保留在 Git。
