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
