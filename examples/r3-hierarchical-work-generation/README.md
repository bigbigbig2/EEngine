# R3-C RasterWork + Hardware Indirect

该示例验证 R3-C 的 GPU work ABI 与生成结果；生产 Hardware Visibility
consumer 由 `PackedVisibilityPass` 接入 Benchmark A/B/C 的统一 Renderer 主链。

它真实运行：

```text
GpuAssetStore + GpuScene resident tables
→ InstanceCull
→ RootTraversalQueue
→ ping/pong dispatchWorkgroupsIndirect rounds
→ VisibleClusterQueue
→ RasterWorkQueue
→ GPU 写完整 16 B drawIndirect
→ test-only staging readback
→ CPU oracle selected Cluster/Meshlet set 与 indirect record 对照
```

固定 case 覆盖 Perspective、Orthographic、多 Geometry/Instance、near-plane、镜像/非均匀 scale、空 queue和强制小 traversal capacity 的 parent fallback。Readback 只用于阶段验证，不决定当帧 dispatch 或 draw；生产路径直接以 GPU 写出的 `instanceCount` 调用 `drawIndirect()`。

运行：

```powershell
cd examples
npm run dev:host
```

打开 `http://127.0.0.1:5173/r3-hierarchical-work-generation/`。页面通过后下载 JSON。该页保留 R3-C 的 GPU/CPU RasterWork oracle；R3-D 已删除运行时 flat 开关，新的 hierarchy 结果只与 commit `0b77ce8` 保存的历史 flat artifact 做版本间对照。
