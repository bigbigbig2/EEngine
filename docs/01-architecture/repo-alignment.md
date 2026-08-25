# 文档模块 ↔ 代码包对齐

> 代码尚未强制创建；此表是 **目标对齐**，避免文档一套、仓库一套。

| 模块 ID | 文档目录 | 建议 package / 路径 |
|---------|----------|---------------------|
| M00 | `02-modules/m00-engineering` | repo root, `examples/`, tooling |
| M01 | `m01-engine` | `packages/core` 或 `packages/engine` |
| M02 | `m02-world` | `packages/world` |
| M03 | `m03-adapter-three` | `packages/adapter-three`（peer: three） |
| M04 | `m04-gpu-scene` | `packages/gpu-scene` 或 `packages/render/scene` |
| M05 | `m05-frame-graph` | `packages/core/frame-graph` |
| M06 | `m06-shaders` | `packages/shaders` |
| M07 | `m07-geometry` | `packages/geo` |
| M08 | `m08-culling` | `packages/render/cull` |
| M09 | `m09-shading-baseline` | `packages/render/shading` |
| M10 | `m10-visibility` | `packages/render/visibility` |
| M11 | `m11-material-resolve` | `packages/render/material-resolve` |
| M12 | `m12-lighting` | `packages/render/lighting` |
| M13 | `m13-post` | `packages/render/post` |
| M14 | `m14-browser` | `packages/core/browser` |
| M15 | `m15-debug-stats` | `packages/debug` |

## 依赖可见性

```txt
adapter-three  →  world, engine, three(peer)
render/*       →  engine, world 类型/ID, gpu-scene, shaders
render/*       →  ✗ three
```
