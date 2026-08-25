# M13 · Post（后处理与时间域）

## 1. 一句话职责

在 lighting 输出之后做 **TAA / SSR / Bloom / Tonemap** 等，并把 temporal history 当作一等资源管理。

## 2. 为什么独立成模块

后处理强依赖 history 与 motion，且易拖垮主路径进度；独立模块可整开关，并与 M14 的 visibility 恢复协作。

## 3. 拥有 / 不拥有

### 拥有

```txt
- TAA（jitter 输入约定、history、clamp）
- Tonemap / 基础 color grading
-（后续）SSR、Bloom、RCAS、Auto exposure
- history 纹理生命周期
```

### 不拥有

```txt
- G-buffer 生成（→ M11）
- 场景加载
- 把 TAA 伪装成可任意外挂的无状态滤镜（文档必须写清管线侵入点）
```

## 4. 依赖

| 方向 | 模块 |
|------|------|
| 依赖 | M12、M05、M06、depth/motion 来源（M10/M11） |
| 被依赖 | Present；M14（history 丢弃） |

## 5. 对外概念接口

```txt
registerPostTasks(frameGraph)
PostSettings { taa, ssr, bloom, exposure, ... }
invalidateHistory(reason)
```

## 6. 计划中的子文档

| 文件 | 用途 | 状态 |
|------|------|------|
| `taa.md` | TAA 数据依赖 | 未写 |
| `ssr.md` | SSR（后） | 未写 |
| `bloom-tonemap.md` | 光晕与色调 | 未写 |
| `history.md` | history 策略 | 未写 |
| `interface.md` | API | 未写 |

## 7. 关联

- 原则：P8 浏览器与 temporal  
- 母本：设计 v2 §13–14；Shade TAA 章  
