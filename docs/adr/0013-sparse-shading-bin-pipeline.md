# ADR-0013: Sparse Shading Bin

Status: accepted

## Context

Material class attachment、fullscreen resolve 和重复 direct-lighting 会对所有像素/材质支付固定成本，并形成多套生产 backend。

## Decision

Visibility 输出由 GPU classifier/finalizer 形成固定上限的 Shading Bin；active bins 通过 indirect dispatch 进入 revision-local specialized compute shading。完整材质只求值一次，direct lighting 可在同一 specialization 融合；compact Surface/velocity 只按真实 consumer demand 创建。

## Consequences

ShadingProgram、material/texture routing 和 bind-group closure 必须随 `GpuRenderWorld` revision 原子发布。旧 material class/tile/evaluator backend 不保留 runtime fallback。opaque path 所需 subgroup/limits 按 WebGPU 能力合同显式协商。

## Verification

验证 Visibility -> classifier -> active-bin indirect consumer、exactly-once、容量/overflow、revision closure、patch/relocation、device loss、feature-off、旧 backend 零残留及正式浏览器 PERF；当前 gate 见 [STATUS](../STATUS.md)。历史 baseline 冻结、Step 6 formal A/B、删除前后比较与相对收益门禁已以 `closed / requirement-removed` 关闭，不再阻塞验收，也不等待补测。
