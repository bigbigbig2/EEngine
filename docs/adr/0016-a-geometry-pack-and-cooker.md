# ADR-0016-A: OEGPACK V3 与 Native Geometry Cooker

Status: accepted

## Context

虚拟几何需要确定性离线构建、range-readable metadata、固定解码页和跨 native/TypeScript 一致的解析合同。

## Decision

采用 native C++ cooker 生成 OEGPACK V3.0。pack 使用 little-endian metadata、固定 256 KiB decoded page、page-local group/meshlet payload、raw 或 LZ4 block codec、内容 hash/checksum、bootstrap page 集合和显式 vertex format。磁盘 offset 使用 u64，GPU 可见 id 保持 u32。

精确布局由 [OEGPACK V3 spec](../specs/oegpack-v3.md) 管理；TypeScript parser/loader 必须拒绝非法范围、reserved bits、hash、checksum、跨页 group 和越界 payload。

## Consequences

Cooker 与 parser 可以独立于完整 streaming runtime 交付，但只有 production renderer consumer 通过后 ABI 才能从 candidate 冻结。该决策不定义 page heap、feedback、eviction 或新 renderer backend。

## Verification

native/TypeScript golden、determinism、corruption matrix、页独立解码、bootstrap 可显示，以及第一个真实 V3 Visibility consumer；性能 workload 不替代格式正确性。
