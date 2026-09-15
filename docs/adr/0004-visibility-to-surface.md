# ADR-0004: Visibility-to-Surface

Status: superseded by ADR-0013

## Context

本决策曾以 MaterialClassDepth 和 fullscreen Surface Resolve 连接 Visibility 与材质求值。该设计会重复分类、固定分配 Surface，并保留第二套材质后端。

## Decision

不再新增或恢复 MaterialClassDepth/class-discard/fullscreen resolve 路径。其目标由 [ADR-0013](./0013-sparse-shading-bin-pipeline.md) 的可见像素分类和 active-bin sparse shading 承担。

## Consequences

历史 ABI 和实施过程只在 Git 中保留。新功能必须接入唯一 Sparse Shading owner，不能把本 ADR 当作兼容要求。

## Verification

源码、compiled graph/shader 与浏览器 topology 中不得重新出现旧 backend；材质 exactly-once 与 feature-off 由 ADR-0013 的验证合同覆盖。
