# M04 · GPU Scene（GPU 常驻表）

## 1. 一句话职责

把 World 中的场景表 **镜像为 GPUBuffer**，管理 dirty upload 与可见列表等 **运行时 GPU 缓冲**。

## 2. 为什么独立成模块

「表的语义」在 World；「表在 GPU 上的布局与上传」是另一套问题（对齐、usage、budget）。独立后 Culling/Visibility 只绑 GPU 资源，不绑 three。

## 3. 拥有 / 不拥有

### 拥有

```txt
- InstanceTable / TransformTable / MeshTable buffer
- MaterialTable / BoundsTable / LightTable buffer
- VisibleList / MaybeList / counters / IndirectArgs buffer
- dirty range → queue.writeBuffer / 分期 upload
- GPUScene 句柄与生命周期
```

### 不拥有

```txt
- 谁被剔除的算法（→ M08）
- meshlet 如何生成（→ M07，只消费 MeshletTable）
- 材质 BRDF（→ M06/M09/M11）
- Authoring API
```

## 4. 依赖

| 方向 | 模块 |
|------|------|
| 依赖 | M01 Engine、M02 World |
| 被依赖 | M08、M09、M10、M11、M12、M07 |

## 5. 对外概念接口

```txt
createGPUScene(engine, world) → GPUScene
uploadDirty(gpuScene, world, budget?)
resizeVisibleBuffers(...)
getBindGroupEntries(sceneTables)   // 供 pass 绑定
```

## 6. 计划中的子文档

| 文件 | 用途 | 状态 |
|------|------|------|
| `tables.md` | 每张 GPU 表的职责 | 未写 |
| `upload.md` | dirty 合并与 budget | 未写 |
| `buffer-usages.md` | usage 标志 | 未写 |
| `interface.md` | API | 未写 |

## 7. 关联

- 原则：P3 GPU-resident  
- 母本：设计 v2 §6 GPU Scene Tables  
- 字节布局：`03-data/`  
