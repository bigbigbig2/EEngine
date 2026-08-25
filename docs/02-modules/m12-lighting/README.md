# M12 · Lighting（光照）

## 1. 一句话职责

消费 G-buffer 或 baseline 着色输入，完成 **直接光 / IBL**，并预留阴影与多光扩展点。

## 2. 为什么独立成模块

光照与材质 resolve、与后处理都要解耦：换 clustered/阴影不应逼改 VB。也便于和 three 的灯光白名单对齐。

## 3. 拥有 / 不拥有

### 拥有

```txt
- Deferred / forward lighting pass
- Directional + IBL 主路径
- LightTable 消费约定
- 阴影 pass 挂载点（CSM/contact 后写）
-（后续）tiled/clustered 划分
```

### 不拥有

```txt
- 完整 GI 系统（probe/SVLM 可作为后续子模块或 M13 协作，默认不塞进 v1 内核）
- TAA（→ M13）
- 材质参数提取（→ M03）
```

## 4. 依赖

| 方向 | 模块 |
|------|------|
| 依赖 | M09 或 M11、M04、M06、M05 |
| 被依赖 | M13、M15 |

## 5. 对外概念接口

```txt
registerLightingTasks(frameGraph)
LightingSettings { ibl, shadows, ... }
```

## 6. 计划中的子文档

| 文件 | 用途 | 状态 |
|------|------|------|
| `direct-light.md` | 直接光 | 未写 |
| `ibl.md` | 环境光 | 未写 |
| `shadows.md` | 阴影（后） | 未写 |
| `clustered.md` | 多光（后） | 未写 |
| `interface.md` | API | 未写 |

## 7. 关联

- 原则：P7  
- 母本：设计 v2 §11、§16  
