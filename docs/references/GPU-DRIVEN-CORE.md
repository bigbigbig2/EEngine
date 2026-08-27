# GPU-driven 核心参考

## 当前问题

OEngine 的核心不是“把 culling shader 放到 GPU”，而是形成完整闭环：

```text
Compact GPU Scene
→ Hierarchy/SSE/Cull
→ Compact Visible Work
→ GPU Indirect Args
→ GPU Hardware/Compute Consumer
```

CPU 不得 readback 最终可见列表后逐项决定绘制。

## 当前 WebGPU Hardware Consumer

OEngine 当前已有可工作的 baseline：`MeshletDrawList` 在 GPU 写入 `vertexCount=384` 和 `instanceCount=visibleMeshletCount`，`VisibilityPass` 执行 single `drawIndirect`，Shader 通过 instance-driven list/vertex pulling 读取 Meshlet。

这条路径应在 R3 正式冻结和验证，而不是重新假设 MDI 或 Mesh Shader：

- producer：R3 Cluster hierarchy cull compact list；flat 只作为阶段内 paired 对照并在 G3 删除；
- args producer：GPU fill indirect args；
- consumer：single fixed-function hardware visibility draw；
- capacity：visible list capacity 与 clamped indirect count；
- fallback：overflow/unsupported primitive 走保守 Hardware path 或显式 frame error；
- counters：attempted/written/overflow、indirect instances、submitted/useful triangles、固定 vertex waste。

## 参考分工

| 参考 | 当前用途 | 禁止照搬 |
|---|---|---|
| meshoptimizer | Meshlet、bounds/cone、vertex reuse、Cooker | 把单一 meshlet size 当跨 GPU 真理 |
| Bevy Meshlet | hierarchy scheduling、SSE/error、CPU validator；其 BVH 只作语义对照 | 直接套用 Bevy BVH record、64 位原子、subgroup 和原生后端假设 |
| AnKi | GPU Scene、micro-patch、cull/compact、shadow work | Vulkan MDI/DGC/bindless runtime |
| Niagara | 紧凑 GPU record 与分阶段 work generation | mesh shader/Vulkan command model |
| Scthe/nanite-webgpu | WebGPU hierarchy、queue、WGSL 和统计 | demo 固定队列与单资产产品 ABI |
| three.js examples | 最短 LOD/work/indirect/SW-HW 闭环 | 单模型、固定巨型队列和示例生命周期 |

## R2/R3 迁移顺序

1. 以 meshoptimizer 生成黄金 Geometry Package，并建立 CPU validator。
2. 参考 Bevy 冻结 Cluster hierarchy、独立 BVH8、geometric error 和 reachability；R3 v1 只用 Cluster hierarchy 形成 LOD cut。
3. 冻结 TS/WGSL shared ABI、queue header/stride/capacity/overflow。
4. 建立 mostly-static GPU Scene、Packed Instances 和 bulk/patch upload。
5. Instance cull → root queue → traversal → SSE select → frustum/cone/HZB → compact list。
6. 将 hierarchy 输出直接接到当前 single `drawIndirect` consumer。
7. 用 flat-vs-hierarchy、不同 Meshlet size、main/CSM view 和跨 adapter benchmark 决定优化。

当前 R2 BVH8 的 leaf 会同时索引不同 LOD 层的 Cluster，不携带 parent/descendant 互斥 cut。它不进入 R3 v1 runtime 热路径；未来接入必须先获得与 LOD traversal 对齐的语义，并通过 CPU reference 和 paired benchmark。R3 的固定来源与采用状态见 [R3-01 porting ledger](./porting/R3-01-hierarchical-work-generation.md)。

## WebGPU 限制

- 没有 baseline MDI：一个 indirect buffer 不会自动执行 N 个 draw。
- 没有 baseline mesh/task shader：不能把 traversal 隐含进 Mesh Shader。
- 没有 buffer device address：表引用必须通过 index/offset ABI。
- 没有 baseline 64 位原子：queue/key/depth 算法必须使用可验证的 32 位方案。
- fixed ping-pong traversal rounds、prefix scan 和 bucket 都可能产生空工作，必须计时而不是默认合理。
