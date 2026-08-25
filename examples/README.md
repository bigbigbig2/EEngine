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

这里只先冻结目录和验证约束。具体页面随 R0 工作包按最小垂直切片加入，避免先生成无法运行的空示例。
