# OEngine Browser Examples

`examples/` 保存直接引用 OEngine 源码的浏览器 fixture。它同时服务学习、调试和回归，但不拥有第二套 Renderer 或共享 GPU runtime。

## 结构

- `runtime/00-foundations/`：基础颜色、方向光和纯几何等最小独立案例。
- `runtime/01-geometry/`：Source Geometry、Meshlet、Cluster、Hierarchy、SSE/LOD、BVH8 和 Runtime Asset Package。
- `storybook/`：案例目录与 Story 外壳。
- `rendering-lab/`：综合质量、性能和迁移证据 fixture。
- `validation/`：Smoke、Visibility、Surface、Lifecycle 四个日常真实 WebGPU Fixture。
- `validation-tools/`：Case Registry、源码域 Selector、唯一 ChromeRunner 与结果合同。
- `basic-scene/`、`model-loading/`、`geometry-preprocess/`：较小的独立功能 fixture。

## Runtime 边界

每个颗粒化案例拥有独立 iframe 和 Runtime，包括 canvas、Renderer、Camera、controls、scene、RAF、错误状态与销毁路径。案例之间不共享 GPUDevice、Renderer、Scene、Camera、History、Profiler 或 Panel 状态。

可以共享的只有 Storybook 外层目录、静态 React 页面壳、样式 token 和不持有 GPU 状态的展示组件。不得引入会隐藏 Renderer 生命周期或资源 owner 的共享 ExampleHarness。

一个 Story 只验证一个明确阶段或 Feature。综合交互和多 Feature 组合留给 Rendering Lab，不把综合页面复制成多套主管线。

## 运行

```powershell
Set-Location examples
yarn install
yarn storybook
```

```powershell
yarn build
yarn build:storybook
yarn verify:changed
yarn verify:full
```

也可以运行 `yarn verify visibility`、`yarn verify surface`、`yarn verify lifecycle` 或 `yarn verify visibility.occlusion`。`verify changed --base <ref>` 比较 `<ref>...HEAD`，`verify paths <path...>` 验证显式路径。Runner 为每个 Case 创建独立 Context，并检查协议 schema、runId/frame 新鲜度、断言、GPU diagnostics、console/page/request error 和截图。退出码 0/1/2 分别表示 passed/failed/inconclusive；生成物位于 `temp/validation/`，不是发布基线。

## 新增案例

- 选择最小可验证目标，并在 `runtime/` 下创建独立 Runtime。
- 在 `storybook/stories/` 注册对应 Story。
- 提供清晰的 failure 状态、资源销毁和必要的 JSON/截图入口。
- 性能案例一次只改变一个自变量，并遵循 [`docs/VALIDATION.md`](../docs/VALIDATION.md)。
