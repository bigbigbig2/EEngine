# M11 · Material Resolve（材质解析）

## 1. 一句话职责

根据 Visibility Buffer 中的 ID，**重建属性并执行材质**，输出 G-buffer 或等价 shading 输入；目标是材质只在最终可见像素上跑。

## 2. 为什么独立成模块

与 VB 分离：Resolve 涉及 barycentric、材质表、纹理策略、per-material pass 等，是独立失败点；也可在「无 VB」时用深度预过 + deferred 的降级路径对照。

## 3. 拥有 / 不拥有

### 拥有

```txt
- 从 mesh/triangle id 重建属性（barycentric 等）
- Material table 驱动的 resolve
- G-buffer 布局写出
- per-material 分发策略（depth-equal 或 batch）— 策略文档化
- 与无 bindless 纹理方案的衔接约定
```

### 不拥有

```txt
- 可见性光栅本身（→ M10）
- 最终光照积分（→ M12）
- 纹理硬上限政策可与 M03/M04 共有，本模块消费策略
```

## 4. 依赖

| 方向 | 模块 |
|------|------|
| 依赖 | M10、M04、M06、M05 |
| 被依赖 | M12、M13、M15 |

## 5. 对外概念接口

```txt
registerMaterialResolveTasks(frameGraph)
GBufferDesc { formats... }
MaterialPassStrategy = 'per-material' | 'uber' | ...
```

## 6. 计划中的子文档

| 文件 | 用途 | 状态 |
|------|------|------|
| `reconstruction.md` | 属性重建 | 未写 |
| `gbuffer-layout.md` | G-buffer | 未写 |
| `material-dispatch.md` | 材质分发 | 未写 |
| `texture-access.md` | 无 bindless 访问 | 未写 |
| `interface.md` | API | 未写 |

## 7. 关联

- 原则：P4  
- 母本：设计 v2 §10；Shade material pass 0-overdraw  
