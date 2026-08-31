# 算法移植登记

新移植记录使用独立 Markdown 文件，文件名建议为 `<task-id>-<algorithm>.md`。每条记录至少包含：

```text
Reference ID
upstream repository URL
commit/tag
source and test/example paths
license and retained notice
algorithm scope
input/output ABI
retained invariants
OEngine/WebGPU adaptation
precision/semantic differences
performance hypothesis and benchmark case
fallback/failure behavior
local test/example
decision: adopt / port / reimplement / reject
reason
```

R0/R1 已有历史移植记录暂保存在 [GPU-DRIVEN.md](../GPU-DRIVEN.md)；后续任务从本目录开始一任务一记录，避免项目总表继续膨胀。

## R2 登记

- [R2-C-07 GPU Scene residency 与 patch owner](./R2-C-07-gpu-scene-residency.md)
- [R2-D-07 Packed flat Visibility](./R2-D-07-packed-visibility.md)
- [R2-D-08 Packed Material reconstruction](./R2-D-08-packed-material-reconstruction.md)
- [R2-D-09 Packed Velocity](./R2-D-09-packed-velocity.md)
- [R2-D-10 Packed glTF 静态导入](./R2-D-10-packed-gltf-import.md)

## R3 登记

- [R3-01 Cluster hierarchy GPU work generation](./R3-01-hierarchical-work-generation.md)

## R4 登记

- [R4-A-01 Unified Hardware Visibility Contract](./R4-A-01-unified-visibility-contract.md)
- [R4-B-01 Single Material Resolve](./R4-B-01-single-material-resolve.md)
- [R4-C-01 Software/Hybrid Raster](./R4-C-01-software-hybrid-raster.md)

## R5 登记

- [R5-00 Surface ABI v1 freeze](./R5-00-surface-abi.md)
- [R5 FX-02 Clustered Direct Lighting](./R5-FX02-clustered-direct-lighting.md)
- [R5-01 Surface Lighting / FX-03 IBL Alignment](./R5-01-surface-lighting.md)
- [R5-02 Packed CSM Shadow / FX-04](./R5-02-packed-csm-shadow.md)
