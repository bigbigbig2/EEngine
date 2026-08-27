# R2-C-07 · GPU Scene residency 与 patch owner

## Reference

- Reference ID：`R2-C-07-ANKI-GPU-SCENE`
- upstream project：AnKi 3D Engine
- repository URL：https://github.com/godlikepanos/anki-3d-engine
- locked commit：`98d4ce3245337dbfd3b0e7ba1ebebbb4dad3e409`
- source：`AnKi/GpuMemory/GpuSceneBuffer.{h,cpp}`、`AnKi/Scene/GpuSceneArray.{h,inl.h}`、`AnKi/Shaders/GpuSceneMicroPatching.ankiprog`
- license：BSD 3-Clause；没有复制表达性 C++/HLSL 代码
- maturity class：production engine reference
- verified on：2026-08-27
- decision：`reimplement`

## 范围与保留不变量

参考 AnKi 的集中 GPU Scene buffer、typed array 与 micro-patch 职责分离，只保留以下架构不变量：GPU 表由单一 owner 管理；CPU handle 与 GPU byte offset 分离；bulk residency 和小范围 patch 是不同路径；grow/replace 后旧资源必须按 GPU completion 退休。

OEngine 输入是 validated `GeometryAssetPackage` / `InstanceSource`，输出是 WebGPU storage bindings、opaque generation handle 和可复算 evidence。Geometry/Cluster/Meshlet/Instance ABI 均由 OEngine TS/WGSL schema 拥有，不使用 AnKi 的地址、allocator、descriptor、DGC/MDI 或 Vulkan/D3D lifetime。

## OEngine / WebGPU 差异

- `GpuAssetStore` 和 `GpuScene` 分别是 Geometry payload 与 Instance table 的唯一 owner；Loader/Package 不持有 GPU 资源。
- Buffer 引用是 `u32` record/element index，不使用 buffer device address。
- grow/copy/patch 只编码到调用方 command；稳定帧和 feature-off 不创建私有 submit。
- release/stale handle 立即从 CPU lookup 失效，物理 Buffer destroy 等待 `queue.onSubmittedWorkDone()`。
- append-first payload 释放量登记为 `reclaimableBytes`；没有 profile 前拒绝移植通用 compactor。

## 性能假设、fallback 与验证

减少一实例一 JS/GPU object、重复 owner 和稳定帧全量重建；代价是每 set CPU record shadow、grow copy 和显式 patch span。adapter storage limit、`u32` 容量、package corruption 在 owner 变更前拒绝；command abort 恢复 cursor、slot、CPU shadow 和 replacement buffer。

本地验证：`gpu-asset-store.test.mjs`、`gpu-scene.test.mjs`、`gpu-packed-scene-registry.test.mjs`、`examples/r2-gpu-residency`、`examples/r2-packed-scene`。R2-C/D 浏览器证据登记在实施文档；本记录不把上游成熟度冒充 OEngine 性能收益。
