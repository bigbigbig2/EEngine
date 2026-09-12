# OEngine Example Library V2

这里是面向 Renderer 开发的独立示例库。每个 `demos/**/example.json` 对应一个独立 HTML 页面；Storybook 只从 metadata 生成目录，并用 iframe 打开同一份 Vite runtime。

当前只实现 `00-foundations/basic-scene` 这一条垂直切片，其余分类仅保留空目录。

## 直接运行示例

```powershell
Set-Location examples
yarn install
yarn dev
```

打开 <http://localhost:5173/demos/00-foundations/basic-scene/>。

## 运行 Storybook Catalog

```powershell
yarn storybook
```

该命令同时启动 Vite（5173）和 Storybook（6006），Storybook 本身不创建 Renderer 或 WebGPU 资源。

## 静态检查与构建

```powershell
yarn typecheck
yarn build
```

`yarn build` 分别输出 `examples-static/` 和 `storybook-static/`。生成的 Story 位于 `stories/generated/`，不要手工编辑。

Example Library 不是 Browser Validation Runner 或 Formal Benchmark。页面可运行、typecheck 或静态构建通过，都不能单独作为 Renderer 正确性或性能证据。
