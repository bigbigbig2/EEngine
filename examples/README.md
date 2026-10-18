# OEngine Example Library

`examples/` 本身就是示例根目录。每个功能模块是一个独立示例，各自持有自己的页面、入口、配置和资源；示例之间不互相依赖，也不共享公共目录。

```text
examples/
  integrated/
    bistro-texture-compression/            index.html + main.ts + example.json + tsconfig.json + vite.config.ts
    dungeon-warkarma-texture-compression/  同结构，资源在示例自己的 assets/ 下
    surface-cache-gi-lab/                  同结构，纯程序化场景，不挂载任何外部模型
  assets/                                 引擎与 validation 共用的测试资源（不属于任何单个示例）
  scripts/check-examples.mjs              示例结构检查
  tests/                                  示例自有 helper 的定向测试
  package.json  tsconfig.json  vite.config.ts  README.md
```

## 当前示例

| 示例 | 内容 | 独立命令 | 端口 |
| --- | --- | --- | --- |
| `integrated/bistro-texture-compression` | Bistro Exterior + authored materials + BC texture product；默认 Cooked，`?mode=raw` 走浏览器 Raw cook | `yarn demo:bistro` | 5174 |
| `integrated/dungeon-warkarma-texture-compression` | Dungeon Warkarma 离线 cook 几何与 BC 贴图；控件与渲染默认值与 Bistro 示例一致 | `yarn demo:dungeon` | 5176 |
| `integrated/surface-cache-gi-lab` | 程序化连通房间与 SCGI 近场残差调试实验屋，不依赖外部模型 | `yarn demo:scgi` | 5173 |

每个示例目录里的 `example.json` 只描述该示例本身（`id`/`title`/`description`/`tags`），不再有数字分类或全局排序字段。

## 运行

```powershell
Set-Location examples
yarn install

yarn dev                 # 5173，一个 dev server 提供全部三个示例
yarn demo:bistro         # 5174，只启动 Bistro 示例
yarn demo:dungeon        # 5176，只启动 Dungeon 示例
yarn demo:scgi           # 5173，只启动 SCGI 实验屋
```

`yarn dev` 下三个页面的地址：

```text
http://localhost:5173/integrated/bistro-texture-compression/index.html
http://localhost:5173/integrated/dungeon-warkarma-texture-compression/index.html
http://localhost:5173/integrated/surface-cache-gi-lab/index.html
```

单示例命令用 `--port` 覆盖端口即可（`yarn demo:bistro -- --port 5180`）。每个示例的 `vite.config.ts` 都是自包含的：自己的 `root`、端口、COOP/COEP 头、`fs.allow`、资源插件和构建入口，不读取其他示例的配置。

## 检查与构建

```powershell
yarn check:examples # 结构契约：必需文件、example.json 字段、无兄弟示例依赖、无 demos/shared/数字目录
yarn typecheck      # 全库 typecheck
yarn typecheck:scgi # 单个示例 typecheck（bistro / dungeon / scgi）
yarn test           # 示例 helper 的定向测试
yarn build          # typecheck + check + 三个示例一起构建到 examples-static/
yarn build:dungeon  # 单个示例构建（同样输出到 examples-static/）
```

`build:*` 输出统一写在 `examples-static/integrated/<name>/`，该目录与其他构建产物一样不入库。

## 资源归属

- 示例私有资源放在示例自己的 `assets/`（例如 Dungeon 的 `cooked/` 与 `playground-cooked/`），由该示例的 Vite 插件挂载，dev 与构建都由示例自己负责。
- 需要外部大模型时，示例用 dev-only 路由从 `.local/` 只读挂载（例如 Bistro 的 `/assets/local-bistro/...`），模型不复制进仓库、也不进构建产物。
- `examples/assets/` 只保留引擎 oracle 测试与 validation 仍要读取的共享 fixture（Dungeon 源模型、HDRI 及其 license/source 说明）；它不是示例之间的共享代码目录，示例不得依赖其他示例的目录。

## 定位

Example Library 是开发与观察入口，不是 Browser Validation Runner，也不是正式 benchmark。页面可运行、typecheck 或静态构建通过，都不能单独作为 Renderer 正确性或性能证据。
