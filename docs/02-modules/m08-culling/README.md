# M08 · Culling（GPU 剔除）

## 1. 一句话职责

在 GPU 上对 instance / meshlet 做 **frustum（及后续 occlusion）剔除**，输出 compact visible list。

## 2. 为什么独立成模块

剔除是 GPU-driven 的第一收益点，可在没有 VB 时独立交付；与 shading 解耦，便于单独测 stats。

## 3. 拥有 / 不拥有

### 拥有

```txt
- Frustum cull compute
- Visible list compaction / counters
-（后续）HZB 采样与 occlusion 测试
-（后续）maybe-set 二级解析
- cull debug 数据输出（供 M15）
```

### 不拥有

```txt
- depth pyramid 的「纹理资源声明」可与 M05 协作，但 Hi-Z 构建 pass 可属本模块或 depth 子模块——**默认归属本模块的 occlusion 子部分**
- 材质 resolve
- three 视锥（可用数学结果，但不依赖 THREE.Frustum 类型进入内核）
```

## 4. 依赖

| 方向 | 模块 |
|------|------|
| 依赖 | M04 GPU Scene、M05 注册 pass、M06 shader、M01 |
| 被依赖 | M09 绘制源、M10、M15 |

## 5. 对外概念接口

```txt
registerCullingTasks(frameGraph)
CullingSettings { enableOcclusion, padding, ... }
// 输出：visibleInstanceCount, buffers in GPUScene
```

## 6. 计划中的子文档

| 文件 | 用途 | 状态 |
|------|------|------|
| `frustum.md` | 视锥剔除 | 未写 |
| `occlusion-hzb.md` | HZB 遮挡 | 未写 |
| `compaction.md` | 列表压缩 | 未写 |
| `interface.md` | 设置与 task | 未写 |

## 7. 关联

- 原则：P3 GPU-driven  
- 母本：设计 v2 §7；Shade HZB 章  
