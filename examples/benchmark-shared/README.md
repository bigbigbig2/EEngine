# OBS-02 A/B/C browser harness

三个入口共享本目录的 manifest loader、场景 fixture、页面 runner、`BenchmarkRunController`、Schema v3 Result writer 和证据门禁，不存在 benchmark 专用 Renderer：

- `benchmark-a/`：three.js `webgpu_compute_rasterizer` 的 7 级 Teapot 输入、160,000 实例布局与相机契约。
- `benchmark-b/`：three.js `webgpu_compute_rasterizer_ibl` 的 Damaged Helmet、15,625 实例、PBR 纹理与参考环境资产契约。
- `benchmark-c/`：仓库自有的多 geometry/material、alpha-tested、Point/Spot/Directional light 与动态 transform 配方。

```powershell
Set-Location examples
npm run dev:host
```

正式输入使用无查询参数的页面，例如 `http://127.0.0.1:5173/benchmark-a/`。开发验收使用 `?profile=smoke`，它只缩小实例数与采样帧数，但保持分辨率、主管线、资产、相机和 feature set；Result 会强制加入 `benchmark-profile-smoke-not-gate` dirty reason，因此永远不能误入 G0 artifact。

每个页面必须最终显示 `采集完成`，控制台不得有 WebGPU validation/uncaptured/device-lost error，并能下载 Schema v3 JSON。Packed Instances 已由 A/B/C 的生产主链和真实 counter 标记为 supported；Hierarchy/SSE LOD、cone culling 和 Compute SW Visibility 仍返回稳定 blocker，而不是假 counter。B 的 UltraHDR JPEG 当前明确为 `declared-unsupported + MAT-05`；程序化中性环境与一盏不投影的验证方向光只用于检查材质可读性，不能宣称 B 环境画质对齐或 Packed CSM 已完成。

## 资产来源与许可

- Teapot GLB：由 `scripts/generate-teapot-benchmark-assets.mjs` 从 three.js `TeapotGeometry.js` 生成；上游 revision、源码和 MIT 许可见 `benchmark-assets/README.md`。
- Damaged Helmet：Khronos glTF Sample Models，从固定 three.js revision `7cda7e710d884827fc73ff1a3aa63270846513d7` 复制到 `examples/benchmark-assets/damaged-helmet/`；原资产 README 标注 CC BY-NC，限 benchmark/研究使用。页面不读取 `three.js/`，也不将其变成 OEngine 运行时依赖。
- Royal Esplanade：three.js 本地示例环境输入，当前只冻结 hash，尚不由 OEngine 消费。

所有 `workspace:` 资产及相机 keyframe 的 SHA-256 都由 `OEngine/tests/benchmark-scene-manifest.test.mjs` 自动核对。
