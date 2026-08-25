# Meshlet 记录意图

> 母本：设计 v2 §8；Shade v3 §8

## 1. 为什么单独成文

```txt
MeshRecord 描述整模
MeshletRecord 描述可 cull 的簇
Phase 4 起成为几何主粒度之一
```

## 2. 逻辑字段意图

| 意图 | 说明 |
|------|------|
| 归属 mesh | meshId 或隐式 offset 窗口内 |
| 几何范围 | 局部 index/vertex 范围，或压缩包引用 |
| bounds | 局部或世界预计算；cull 用 |
| 锥体/法线锥 | 可选，背面或小特征 |
| 三角数量 | ≤ 母本量级（如 ~64/128，可配） |
| 压缩标志 | 后期 meshlet compression |

## 3. 与 MeshRecord

```txt
mesh.meshletOffset + mesh.meshletCount
覆盖 MeshletTable 连续段
instance 可见 → 展开该段 → meshlet cull
```

## 4. Expansion 问题（Shade #92）

```txt
不同 mesh meshlet 数量差几个数量级
→ thread divergence
设计要求：存在 batch/二级扩展策略的位置
不在本文件锁算法
```

## 5. 无 mesh shader

```txt
生成 visible meshlet list 在 compute
绘制用间接/硬件 raster 消费 list
```

## 6. Debug

```txt
伪彩 meshletId
统计：每帧可见 meshlet 数 vs 全量
```
