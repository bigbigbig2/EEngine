---
id: archive/2026-09-22-web-100m-phase-h-adaptive-gpu-residency
state: history
---
# ADR-0018 Phase H Adaptive GPU Residency 审评（2026-09-22）

本记录把 Phase H 的 Portable、Balanced、HighEnd 物理驻留 profile 落到共享
Product page-bank owner，并保留 Product/Page ABI 与 Cook 输出不变。

## 结果

- 新增纯 profile selector：只消费 negotiated `maxBufferSize`、
  `maxStorageBufferBindingSize`、`maxStorageBuffersPerShaderStage`，不读取或猜测
  物理 VRAM。
- Portable/Balanced/HighEnd 分别使用四个 128/192/256 MiB bank，总容量为
  512 MiB/768 MiB/1 GiB；四个 shader binding、256 KiB page 和所有 Product
  identity 保持不变。
- `VirtualGeometryResidency`、admission、multi-Product runtime 和 Renderer
  ProductScene options 共享同一个 device-wide profile；replacement 与 device
  recovery 沿用该 profile，不 recook。
- feature-off、`maxStorageBuffersPerShaderStage < 16` 和低于 Portable 的
  negotiated limits 在创建 metadata/page bank 前 fail closed。
- GPU budget ledger 改为记录实际选中容量，仍以 shared pool 避免候选/旧 revision
  重复创建物理 bank。

## ADR-0018 对照

| ADR-0018 Phase H 要求 | 实现与证据 | 结论 |
| --- | --- | --- |
| 同一 Product ABI 跨三种 profile 无需 recook | `GeometryProductResidencyProfileV1` 只改变 bank capacity；Product/Page/Shader ABI 不变；Balanced integration test | 满足 implementation/contract |
| 依据 negotiated limits，不假定物理 VRAM | selector 只读取 post-device limits；无 adapter memory/VRAM 分支 | 满足 implementation/contract |
| Portable 512 MiB | 4 × 128 MiB shared bank | 满足 |
| Balanced 768 MiB–1 GiB 目标 | 4 × 192 MiB；显式预算可回退到 Portable | 满足 bounded target |
| HighEnd 1–2 GiB target | V1 先冻结 4 × 256 MiB = 1 GiB；更高容量需后续 binding/预算证据 | 部分满足，1 GiB target only |
| feature-off/low-limit 不分配未使用 profile resources | selector disabled；residency 在 `createBuffer` 前拒绝；4-case contract | 满足 implementation/contract |

## 验证边界

本次定向验证通过：

```text
4 Phase H profile contract tests passed
npm run typecheck
npm run build:test
```

这不是 RuntimeValidated、Performance Evaluated 或 formal 100M PERF 证据。仍需
独立 `validation/` browser host 在不同真实 adapter 上采集 profile、resident/
retiring bytes、demand overflow、fallback 和 device-loss recovery 证据。
