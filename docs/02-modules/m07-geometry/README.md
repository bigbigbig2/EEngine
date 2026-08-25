# M07 · Geometry（几何与 Meshlet）

## 1. 一句话职责

规范化网格属性，并在需要时 **构建 meshlet / cluster 数据** 写入 World / GPU Scene。

## 2. 为什么独立成模块

Meshlet 构建（含 meshoptimizer 等）是重预处理，与「每帧 culling」不同生命周期：可离线/导入时做，不应塞进 Adapter 或 Culling。

## 3. 拥有 / 不拥有

### 拥有

```txt
- 属性规范化（position/normal/uv/tangent 生成）
- Meshlet builder（可选依赖 meshoptimizer WASM）
- Meshlet bounds / 压缩布局（后续）
- 导入期 bake 管线钩子
```

### 不拥有

```txt
- 每帧 meshlet expansion 的调度算法细节可与 M08 协作，但「谁被画」的决策在 M08
- three BufferGeometry 对象长期持有（提取后应成为自有数据）
- 像素 shading
```

## 4. 依赖

| 方向 | 模块 |
|------|------|
| 依赖 | M02、M04（写表）、可选外部 meshoptimizer |
| 被依赖 | M03（import 时调用）、M08、M10 |

## 5. 对外概念接口

```txt
normalizeGeometry(desc) → NormalizedMesh
buildMeshlets(mesh, options) → MeshletSet
bakeMeshToWorld(world, mesh) 
```

## 6. 计划中的子文档

| 文件 | 用途 | 状态 |
|------|------|------|
| `attributes.md` | 属性布局 | 未写 |
| `meshlet-format.md` | meshlet 记录格式 | 未写 |
| `builder.md` | 构建参数与失败处理 | 未写 |
| `interface.md` | API | 未写 |

## 7. 关联

- 原则：P4 细粒度可见性的几何基础  
- 母本：设计 v2 §8；Shade 解读 meshlet 章  
