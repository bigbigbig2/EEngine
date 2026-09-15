# OEngine Example Library V2

这里是面向 Renderer 开发的独立示例库。每个 `demos/**/example.json` 对应一个独立 HTML 页面；Storybook 只从 metadata 生成目录，并用 iframe 打开同一份 Vite runtime。

当前包含五条独立运行的示例：

- `00-foundations/basic-scene`：最小生产 Renderer 场景。
- `14-integrated/rendering-lab`：只有导入的 Dungeon 模型，保留 PBR、环境光、太阳和完整效果。
- `14-integrated/rendering-lab-basic`：相同模型、变换、默认相机和 DPR，使用 Unlit，默认关闭效果。
- `14-integrated/rendering-lab-large`：加载 `assets/oengine/large.glb`，保留 PBR、环境光、太阳和完整效果。
- `14-integrated/rendering-lab-large-basic`：加载同一大型模型，使用 Unlit，默认关闭效果。

其余分类仍只保留空目录。

## 直接运行示例

```powershell
Set-Location examples
yarn install
yarn dev
```

打开 <http://localhost:5173/demos/00-foundations/basic-scene/>。

综合场景位于 <http://localhost:5173/demos/14-integrated/rendering-lab/>。

Basic 对照位于 <http://localhost:5173/demos/14-integrated/rendering-lab-basic/>。

大型模型的 Full 与 Basic 对照分别位于 <http://localhost:5173/demos/14-integrated/rendering-lab-large/> 和 <http://localhost:5173/demos/14-integrated/rendering-lab-large-basic/>。

两个 Rendering Lab 页面共用右侧性能实验面板。点击“重置视角”，设置预热和记录秒数，再点击“开始采样”；采样期间锁定相机和功能开关，等待 GPU readback 完成后显示固定记录的 P50/P95。GPU 表列出全部 Pass 和阶段，Sparse 区列出有效可见像素、队列记录、间接工作组、总 invocation 放大、输出字节核算及异常计数。未采集指标显示不可用，融合 kernel 内的重建/采样/BRDF 不单独计时。

在一个页面完成记录后点击“保存为对照”，到另一页面完成记录后点击“读取已保存对照”。“导出 JSON”保留逐帧原始数据、配置、相机、adapter/capability、GPU diagnostics 和 graph/memory 信息；也可以导入导出的文件比较。请分别运行两个页面，并核对面板中的分辨率、DPR、视角、采样配置和条件差异。功能开关可用于实验，但两页面的默认差值包含材质、光照与后续效果的共同成本。

聚合逻辑的定向测试：`yarn test:performance-panel`（Node 24，直接读取 TypeScript）。

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
