# ADR-0005 · 单一统一主管线

Status: accepted

## 背景

按 Core/Quality/Experimental 维护三档独立管线会复制资源契约、历史语义和验证矩阵。

## 决策

OEngine 只有一条主管线。Lighting、Shadow、Transparency、AO、SSR、TAA、Bloom、Exposure、Tonemap 等功能通过配置、场景需求和 FrameGraph 依赖启停。

## 后果

- 不设计三档真实管线。
- 功能关闭后不得保留 Pass、资源、readback 或 submit。
- 可存在 capability adapter 或算法实现选择，但共享同一资源和输出契约。

## 验证

针对每项 feature 检查 off 状态的图、资源分配和 GPU timestamp。

