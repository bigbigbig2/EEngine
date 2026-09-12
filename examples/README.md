# OEngine Example Library

当前目录只保留可启动的 Storybook 空壳。旧示例、WebGPU runtime、浏览器验证 Fixture、Validation Runner 和 Rendering Lab 已全部移除；新的示例体系将在完成单独设计后从零建设。

Storybook 空壳不导入 `OEngine`，不创建 `GPUDevice`，也不构成渲染正确性、WebGPU capability 或性能证据。

## 运行空壳

```powershell
Set-Location examples
yarn install
yarn storybook
```

```powershell
yarn typecheck
yarn build
```

`stories/` 目前有意为空。新增任何 Story、runtime、共享 harness 或浏览器 Runner 前，先在 ADR 中确定示例分类、生命周期边界、真实 GPU 验证协议、性能 fixture 和产物所有权。
