# R2-D-07 · Packed flat Visibility producer/consumer

## Reference

- Reference ID：`R2-D-07-PACKED-VISIBILITY`
- upstream projects：Scthe/nanite-webgpu、Niagara、AnKi 3D Engine
- repository URLs：https://github.com/Scthe/nanite-webgpu、https://github.com/zeux/niagara、https://github.com/godlikepanos/anki-3d-engine
- locked commits：nanite-webgpu `b9cd33f65bb3cdba0464717e0fa621d330d2116f`；Niagara `eefec2794681a1f8416e1fcc2771c1cdc11a86cb`；AnKi `98d4ce3245337dbfd3b0e7ba1ebebbb4dad3e409`
- source：nanite-webgpu `src/passes/cullInstances/*`、`src/passes/cullMeshlets/*`、`src/scene/naniteBuffers/drawnMeshletsBuffer.ts`；Niagara `src/shaders/drawcull.comp.glsl`、`clustercull.comp.glsl`、`src/scene.{h,cpp}`；AnKi `AnKi/Renderer/Utils/GpuVisibility.*`、`AnKi/Shaders/GpuVisibilityStage1.ankiprog`、`GpuVisibilityStage2And3.ankiprog`
- tests/examples：nanite-webgpu `cullInstancesPass.test.ts`、`cullMeshletsPass.test.ts`；Niagara samples/runtime；AnKi renderer stages
- licenses：nanite-webgpu MIT；Niagara MIT；AnKi BSD 3-Clause
- decision：`reimplement`

## 范围与 ABI

三份上游只提供 instance/cluster cull、compact work 与 GPU consumer 的数据流依据；OEngine 没有复制其 WGSL/GLSL/HLSL 表达。当前 R2-D flat queue ABI 为 16 B header（`written/attempted/visible_instances/rejected_instances`）加 8 B element（Instance record index、Meshlet record index）。producer 还完整写入 16 B `drawIndirect` record；fixed-function Hardware consumer在同一 GPU command 链直接消费，CPU 不 readback count 决定 draw。

保留不变量：sphere-frustum 采用最大轴 scale 保守半径；`attempted` 不因 overflow 截断；`written` 与 indirect `instance_count` 只计真实写入；overflow 设置稳定 counter bit；capacity 包含每个实例的 Geometry Meshlet 数，即共享 Geometry 也必须乘实例数。

## WebGPU 差异与拒绝项

- 不采用 Niagara mesh/task shader、Vulkan MDI 或 AnKi DGC/bindless。
- 一个 WebGPU `drawIndirect()` 消费 compact work；`firstInstance=0`，不依赖可选 `indirect-first-instance`。
- storage/u32 limit 在 material obtain、Instance instantiate 和 Buffer allocation 前拒绝。
- flat `for meshlet` 是 R2 vertical fallback，不是长期 hierarchy 算法；R3 必须以已驻留 hierarchy/SSE 在展开前减量，并复用同一 consumer。

## 性能假设、fallback 与验证

R2 只证明 GPU producer→consumer 和容量语义，不声明 flat loop 高性能。它仍提交每个可见实例的全部 Meshlet、固定最多 384 vertices，并可能浪费无效 vertex；R3 的 flat-vs-hierarchy paired benchmark 决定收益。

本地验证：`packed-r2-algorithms.test.mjs` 的 sphere-frustum reference 与 queue source audit；`gpu-packed-scene-registry.test.mjs` 的 1,000 instances × shared Geometry 精确容量、adapter limit preflight；`examples/r2-packed-scene` 的真实 `drawIndirect()` consumer。
