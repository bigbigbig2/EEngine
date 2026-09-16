# ADR-0016-A: OEGPACK V3 与 Offline Geometry Cooker

Status: accepted

## Context

Runtime-first 主路线不消除预处理资产的价值。大规模静态内容、弱客户端、低首帧延迟和 CDN Range 分发仍需要确定性、可校验、可独立寻址的离线几何产物。现有 Native/C++ cooker 与 OEGPACK V3 已实现这条路线的基础，但不应反向规定 Web Runtime Cooker 的实现方式。

## Decision

保留独立 Native/C++ Offline Cooker，并以 OEGPACK V3.0 作为其分发容器。OEGPACK 使用 little-endian metadata、固定 256 KiB decoded page、page-local Group/Meshlet payload、raw 或 LZ4 block codec、内容 hash/checksum、bootstrap page 集和显式 vertex format；磁盘 offset 使用 u64，GPU 可见局部 ID 使用 u32。

Native Offline Cooker 可以采用与 Web Cooker 不同的参数、packing、压缩、线程和内存策略，但不能删除或替换 Nyx 几何算法阶段。两者无需字节一致；Offline 产物通过 `OegPackProductSource` 适配 [Geometry Product V1](../specs/geometry-product-v1.md)，从 admission 开始与 Web 产物共享同一 Runtime。

算法实现不得脱离 Nyx 来源另起炉灶。Offline Cooker 至少逐项移植 `MeshletBuilder.cpp` 的 meshlet/Group/LOD/simplification/hierarchy/page 生产与 `ModelConvert.cpp` 的 scene/material 归属；凡采用 Nyx 的 streaming 或 GPU consumption 语义，必须对应移植 `GeometryStreaming.cpp/.h`、`DAGCull.slang` 和 `VBufferMesh.slang` 的函数/entry point。参数、任务编排和序列化可不同，但 seam/attribute lock、refine/error 传播、保守 bounds、合法 cut、page 独立性和 local primitive identity 等不变量不能删除。

[OEGPACK V3 spec](../specs/oegpack-v3.md) 仅冻结文件容器及其 decoded profile。TypeScript reader 必须拒绝非法范围、reserved bits、hash、checksum、跨页 Group 和越界 payload。Web Runtime Cooker 不必生成 OEGPACK，也不得把“在浏览器中调用 CLI、等待完整 pack、再读回”作为主路线。

## Consequences

OEGPACK 是 Offline 第二路线、golden corpus 和 corruption/determinism 载体，不是两个 Cooker 的共享中间格式。它可以单独优化离线质量与网络分发，但不能拥有独立 Geometry Residency、地址表、Visibility 或 shading path。

只有 production consumer 验证通过后，OEGPACK ABI 才能从 candidate 冻结。未来新增 decoded layout 必须显式版本化；不能修改 V3 来暗中匹配 Web Cooker 实验。

## Verification

需要 native/TypeScript golden、同 producer recipe 的 determinism、corruption matrix、页独立解码、bootstrap cut，以及 `OegPackProductSource -> Geometry Product admission -> production Visibility` 的真实消费者证据。Offline 与 Web 产物只验证各自确定性和共同 Runtime conformance，不要求跨 producer 字节相同。
