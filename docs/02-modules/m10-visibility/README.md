# M10 · Visibility（可见性缓冲路径）

## 1. 一句话职责

将可见几何光栅到 **Visibility Buffer**（及深度），只记录「看见了谁」，不做昂贵材质计算。

## 2. 为什么独立成模块

VB 是 Shade-like 架构中枢，工程复杂度高（ID 格式、光栅路径、与 meshlet 衔接）。必须与 Material Resolve 拆开：一个写 ID，一个读 ID。

## 3. 拥有 / 不拥有

### 拥有

```txt
- Visibility 纹理格式与含义（mesh_id / triangle_id 等）
- Visibility raster pass
- 与 depth 输出的配合
-（可选）小 primitive 剔除
- VB debug 可视化数据
```

### 不拥有

```txt
- 材质纹理采样与 BRDF（→ M11）
- 光照积分（→ M12）
- 导入与白名单（→ M03）
```

## 4. 依赖

| 方向 | 模块 |
|------|------|
| 依赖 | M04、M07、M08、M05、M06 |
| 被依赖 | M11、M13（motion/depth 依赖链）、M15 |

## 5. 对外概念接口

```txt
registerVisibilityTasks(frameGraph)
VisibilityBufferDesc { format, size }
// 输出资源名：VisibilityColor, MainDepth, ...
```

## 6. 计划中的子文档

| 文件 | 用途 | 状态 |
|------|------|------|
| `buffer-format.md` | ID 打包格式 | 未写 |
| `raster-path.md` | 光栅路径 | 未写 |
| `meshlet-draw.md` | meshlet 绘制衔接 | 未写 |
| `interface.md` | API | 未写 |

## 7. 关联

- 原则：P4 Visibility first  
- 母本：设计 v2 §9；Shade 解读 VB 章  
