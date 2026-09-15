# ADR-0016-C: V3 Geometry 生产消费与切换

Status: proposed

## Context

另建 Nyx renderer/backend 会复制 GpuScene、work generation、VisibilityKey、shading 和证据体系，也无法证明迁移真正替换生产路径。

## Decision

在现有 `GpuAssetStore -> GpuRenderWorld -> hierarchy/work -> MeshletBucketRaster -> VisibilityKey` 闭环中接入 V3 metadata 和 resident page 地址。GPU traversal 选择 desired LOD；目标页缺失时使用 resident ancestor/bootstrap group 并产生去重 demand。所有 shading/lighting consumer 继续读取同一 Visibility ABI。

旧 geometry package/path 只在所有生产 consumer、普通 Scene adapter、shadow/visibility 和生命周期验证完成后删除；不保留永久 runtime switch。

## Consequences

B 与 C 必须以垂直切片共同推进：先让 bootstrap 真正出像素，再加 demand/residency，最后 cutover。V3 不改变材质和纹理 identity，除非另有 ADR/spec。

## Verification

验证真实 V3 像素、SSE/ancestor fallback、page demand、shadow/main-view 共享、overflow、patch/replace/device loss，以及 source/compiled graph/browser 三层旧路径删除审计。
