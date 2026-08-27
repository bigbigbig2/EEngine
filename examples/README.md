# OEngine Examples

本目录逐步收纳可在浏览器运行、可截图和可采集 counter 的垂直验证场景。示例通过相对路径引用 `../OEngine`，用于验证真实 WebGPU 主链，不复制引擎实现，也不承担 three.js API 兼容。

## 目录约定

```text
examples/
├─ README.md
├─ r0-observability/       # profiler、环境清单、结果导出
├─ r0-frame-smoke/         # 真实 Renderer 主帧 smoke
├─ r2-package-kernel/      # SourceGeometry 与 Package Kernel 浏览器验证
├─ r2-meshlet-cooker/      # meshoptimizer 与新 Meshlet sections 浏览器验证
├─ r2-geometry-package/    # 完整 hierarchy/BVH8/streams/material package
├─ benchmark-shared/       # A/B/C manifest、fixture 与统一 runner
├─ benchmark-a/            # 160k Teapot 最低线
├─ benchmark-b/            # 15,625 Helmet PBR/IBL 最低线
└─ benchmark-c/            # OEngine 异构动态世界通用性输入
```

每个示例目录应包含：

- 独立启动命令和所需浏览器能力；
- 从 `../../OEngine/src/index.ts` 或明确的相对包入口导入引擎；
- 固定资产、seed、相机轨迹和 feature set；
- 预期画面、counter/debug view 与不允许出现的 validation error；
- 对应实施任务 ID，以及需要保存的 JSON/截图路径。

## 当前示例

- [r0-observability](./r0-observability/README.md)：真实初始化 WebGPU/OEngine，并导出 GraphicsContext 更新的 R0 观测结果。
- [r0-frame-smoke](./r0-frame-smoke/README.md)：运行真实 `Renderer.render()`、固定 Box 场景和 GPU timestamp/counter 采样；采集后可切换统一 Render Debug View，并查看 unsupported 原因。
- [r2-package-kernel](./r2-package-kernel/README.md)：验证 Box → SourceGeometry → deterministic package → reopen/corruption reject，不创建 GPU 资源。
- [r2-meshlet-cooker](./r2-meshlet-cooker/README.md)：运行官方 meshoptimizer 1.0.0 WASM，验证 32/64、64/64、64/128 variants、新 Meshlet sections 和 reopen validator。
- [r2-geometry-package](./r2-geometry-package/README.md)：验证可绘制层次/error、未量化保守 BVH8、未压缩 streams/material、完整 validator、CPU selector 与纯 package reopen。
- [benchmark-shared](./benchmark-shared/README.md)：A/B/C 的冻结输入、正式/烟雾 profile、资产归属和统一验收方法。三个页面默认使用 `?profile=smoke` 开发链接；无查询参数才加载完整实例数量。

在本目录运行 `npm install` 后，可用 `npm run dev:host` 启动全部示例；`npm run build` 同时执行类型检查和生产构建。Teapot 输入由 `npm run generate:benchmark-assets` 从本地 three.js revision 确定性再生。
