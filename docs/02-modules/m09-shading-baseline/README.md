# M09 · Shading Baseline（可画对的 PBR 底座）

## 1. 一句话职责

在完整 Visibility 路径之前/并行，提供 **table-driven 的 PBR 绘制底座**，保证导入场景视觉正确。

## 2. 为什么独立成模块

「架构正确」和「像素正确」要拆开验收。先有 Baseline，Adapter/GPU Scene/Culling 才有视觉回归基准；避免直接跳进 VB 却无法判断材质错在哪。

## 3. 拥有 / 不拥有

### 拥有

```txt
- Forward 或早期 table-driven draw path
- MeshStandard 子集的 WGSL 绑定（与 M06 协作）
- 与 MaterialTable / TransformTable 的读取约定
- 基础 debug：albedo/normal 输出模式
```

### 不拥有

```txt
- Visibility buffer 算法（→ M10）
- 完整 deferred G-buffer 打包定案（可过渡到 M11/M12）
- TAA（→ M13）
- 白名单政策（→ M03）
```

## 4. 依赖

| 方向 | 模块 |
|------|------|
| 依赖 | M04、M06、M05、M08（有 culling 后） |
| 被依赖 | 早期演示；M12 可复用 BRDF；M15 |

## 5. 对外概念接口

```txt
registerBaselineDrawTasks(frameGraph)
ShadingMode = 'forward' | 'debug-albedo' | ...
```

## 6. 计划中的子文档

| 文件 | 用途 | 状态 |
|------|------|------|
| `pbr-subset.md` | 支持的 Standard 参数 | 未写 |
| `forward-path.md` | 前向路径 | 未写 |
| `debug-modes.md` | 调试输出 | 未写 |
| `interface.md` | API | 未写 |

## 7. 关联

- 原则：P7 Static opaque first  
- 母本：设计 v2 §10.5 PBR 子集、§11  
