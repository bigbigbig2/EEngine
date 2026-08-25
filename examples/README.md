# OEngine Examples

本目录逐步收纳可在浏览器运行、可截图和可采集 counter 的垂直验证场景。示例通过相对路径引用 `../OEngine`，用于验证真实 WebGPU 主链，不复制引擎实现，也不承担 three.js API 兼容。

## 目录约定

```text
examples/
├─ README.md
├─ r0-observability/       # profiler、环境清单、结果导出
├─ visibility-minimal/     # triangle/meshlet/depth/VisibilityKey
└─ benchmark-*/            # A/B/C 固定场景，按 R0 逐步加入
```

每个示例目录应包含：

- 独立启动命令和所需浏览器能力；
- 从 `../../OEngine/src/index.ts` 或明确的相对包入口导入引擎；
- 固定资产、seed、相机轨迹和 feature set；
- 预期画面、counter/debug view 与不允许出现的 validation error；
- 对应实施任务 ID，以及需要保存的 JSON/截图路径。

## 当前示例

- [r0-observability](./r0-observability/README.md)：真实初始化 WebGPU/OEngine，并导出 GraphicsContext 更新的 R0 观测结果。
- [r0-frame-smoke](./r0-frame-smoke/README.md)：运行真实 `Renderer.render()`、固定 Box 场景和 GPU timestamp 采样。

在本目录运行 `npm install` 后，可用 `npm run dev:host` 启动全部示例；`npm run build` 同时执行类型检查和生产构建。后续页面继续按最小垂直切片加入。
