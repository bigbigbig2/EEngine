# ADR-0001 · GPU-first WebGPU 引擎方向

Status: superseded by ADR-0007

## 背景

旧方向围绕 three.js 生态输入和 reconstructed Renderer 展开，文档与实现被兼容叙事和历史研究名称牵制。

## 决策

OEngine 定位为 WebGPU baseline 的 GPU-first 游戏引擎核心。近期不兼容 three.js；资产编译、Application World、GPU Render World、渲染和性能工具属于同一产品方向。

## 后果

- three.js 仅作为算法、实现和 benchmark 参考。
- 不为 three Scene/Material/TSL 保留 seam。
- 引擎边界可以继续扩展，但渲染性能闭环优先于编辑器和 Gameplay 生态。

## 验证

公开 interface、目录所有权和 roadmap 不再依赖 three.js 类型或包。
