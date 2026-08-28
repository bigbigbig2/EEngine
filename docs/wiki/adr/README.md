# Architecture Decision Records

ADR 记录已经接受、会长期约束实现的决策。普通实现细节、调查假设和短期任务不写 ADR。

## 状态

- `accepted`：当前必须遵守。
- `superseded`：已被新 ADR 替代，保留历史原因。
- `rejected`：讨论过但拒绝。

## 规则

- 新 ADR 使用 `NNNN-short-name.md`。
- 必须包含状态、背景、决策、后果和验证方式。
- 推翻已有 ADR 必须新增 ADR 并标明替代关系，不能静默改正文。

## 当前 ADR

- [0001 · GPU-first WebGPU 引擎方向](./0001-gpu-first-webgpu-engine.md)
- [0002 · GPU-ready 资产与层次几何](./0002-gpu-ready-assets-and-hierarchy.md)
- [0003 · 软硬件混合 Visibility](./0003-hybrid-visibility.md)
- [0004 · 单次 Standard PBR Material Resolve](./0004-single-material-resolve.md)
- [0005 · 单一统一主管线](./0005-unified-render-pipeline.md)
- [0006 · 性能证据是架构门槛](./0006-performance-evidence-gate.md)
- [0007 · 桌面 WebGPU 中大型场景与 Hardware-first 主链](./0007-desktop-webgpu-hardware-first.md)
- [0008 · Runtime Asset Package Kernel v1](./0008-runtime-asset-package-kernel-v1.md)
- [0009 · R3 以 Cluster hierarchy 生成 GPU Raster Work](./0009-r3-cluster-hierarchy-work-generation.md)
- [0010 · R4 统一 Visibility Key、光栅语义与 Resolve 边界](./0010-r4-unified-visibility-contract.md)
