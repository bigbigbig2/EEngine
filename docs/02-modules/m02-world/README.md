# M02 · World（CPU 场景数据）

## 1. 一句话职责

用 **plain data + typed id + store** 表达场景，替代渲染路径上的 Object3D 树。

## 2. 为什么独立成模块

Authoring 可以是树；**运行时渲染数据必须是表**。World 是 Adapter 的写入目标、GPU Scene 的上传源，必须独立且不依赖 three。

## 3. 拥有 / 不拥有

### 拥有

```txt
- TransformStore
- MeshStore / InstanceStore
- MaterialStore / TextureStore（CPU 侧描述）
- LightStore / Camera 描述（或每帧参数源）
- Typed ID 分配与回收（freeList）
- DirtyTracker / dirty ranges（CPU 侧）
- WorldContext 聚合
```

### 不拥有

```txt
- THREE.Object3D 引用作为渲染主数据（映射表可放 Adapter）
- GPUBuffer 真正创建（→ M04 / M01）
- 剔除与绘制
- 材质 BRDF 实现（→ M06 / M09）
```

## 4. 依赖

| 方向 | 模块 |
|------|------|
| 依赖 | 无 three；可选持有 Engine 引用 |
| 被依赖 | M03（写）、M04（读）、M07（读 mesh 描述） |

## 5. 对外概念接口

```txt
createWorld(engine?) → WorldContext
addMesh / addInstance / remove*
getMaterial(id) / setMaterial params
markDirty(kind, id | range)
iterateDirty(kind) → ranges
```

## 6. 计划中的子文档

| 文件 | 用途 | 状态 |
|------|------|------|
| `stores.md` | 各 Store 职责 | 未写 |
| `ids.md` | ID 规则（链到 03-data） | 未写 |
| `dirty.md` | 脏标记语义 | 未写 |
| `interface.md` | World API | 未写 |

## 7. 关联

- 原则：P2 Data-oriented，P5 No hidden scene graph  
- 母本：设计 v2 §3.3 Flat WorldContext、§4.1  
- 共享布局：`03-data/`  
