# 目录结构

> 本文描述当前目录职责。新增模块和依赖调整必须遵守 [ENGINE-DIRECTION-AND-CONSTRAINTS.md](./ENGINE-DIRECTION-AND-CONSTRAINTS.md) 的 seam 与依赖方向。

## 顶层

```text
shade-re/
├─ reconstructed/   WebGPU 渲染器库
├─ example/         Vue + Vite 示例
└─ docs/            当前架构与重构文档
```

## reconstructed/src 当前结构

```text
src/
├─ index.ts         唯一公开 interface
├─ core/            基础类型、数学、WGSL ABI
├─ scene/           Scene、Node3D、Mesh
├─ camera/          Camera 与控制器
├─ light/           CPU 灯光模型
├─ animation/       CPU 动画资源
├─ geometry/        Geometry、Meshlet、BVH 构建
├─ material/        CPU 材质模型和 bucket
├─ texture/         CPU 纹理模型
├─ loaders/         glTF、USD、SHADE、环境贴图
├─ gpu/             GPU 资源、数据库和常驻状态
├─ framegraph/      命令和图执行
├─ render/          Renderer、View、Targets、Pass
└─ shaders/         WGSL 源码和生成逻辑
```

## 依赖规则

```text
core
↑
scene / camera / light / animation / geometry / material / texture
↑
loaders

core + world/assets
↑
gpu
↑
framegraph + render/passes
↑
Renderer
↑
src/index.ts
↑
example
```

允许 `gpu`、`render` 和 `shaders` 因 WGSL ABI/生成逻辑存在受控的内部依赖，但这些依赖不能泄漏到 `src/index.ts` 的调用者。

## 已移除的旧结构

- `src/package`：31 个只做 re-export 的浅模块
- `src/research.ts`：旧逆向研究聚合入口
- `src/archive`：历史 smoke/M1 路径
- `src/dev` 和库内 `index.html`：旧状态页
- 源码目录内 README：旧 evidence/status 文档，统一由根 `docs` 取代
