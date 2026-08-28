# R3-B Hierarchical Work Generation

该示例是 R3-B 的测试 consumer，不是 R3-C Hardware Visibility 闭环。

它真实运行：

```text
GpuAssetStore + GpuScene resident tables
→ InstanceCull
→ RootTraversalQueue
→ ping/pong dispatchWorkgroupsIndirect rounds
→ VisibleClusterQueue
→ test-only staging readback
→ CPU oracle selected-set comparison
```

固定 case 覆盖 Perspective、Orthographic、多 Geometry/Instance、near-plane、镜像/非均匀 scale、空 queue 和强制小 traversal capacity 的 parent fallback。Readback 只用于阶段验证，不决定当帧 dispatch 或 draw。

运行：

```powershell
cd examples
npm run dev:host
```

打开 `http://127.0.0.1:5173/r3-hierarchical-work-generation/`。页面通过后下载 JSON；R3-C 才会把 VisibleCluster 展开成 RasterWork 并接 Hardware `drawIndirect()`。
