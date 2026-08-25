# CPU Store 模型（设计语义）

> 母本：设计 v2 附录 A Store / DirtyRange；§3 plain data

## 1. Store 共性

每种记录一族 Store，例如：

```txt
InstanceStore
TransformStore
MeshStore
MaterialStore
…
```

能力意图：

```txt
dense 数组（或等价稠密存储）
freeList 回收槽位
version / generation（可选）
dirtyRanges 本帧脏区间
```

## 2. 与 id

```txt
id 即稠密下标（常见）
或 id → 稀疏槽映射（若要稳定 id 与紧凑 GPU 上传分离）

设计偏好（母本精神）：
  简单稠密 id==index，GPU 直接 index
  删除用 freeList 与 generation 防 ABA
```

## 3. DirtyRange

```txt
{ start, count }
连续合并
过多 → full upload 标志
```

见 `dirty-model.md`。

## 4. 单向所有权

```txt
Store 项不持有 World 反向强引用
不持有 three 对象（映射在 Adapter）
```

## 5. 线程意图（局限文档）

```txt
Store 主线程写为主（authoring/sync）
worker 可做几何 bake，结果合并回 Store 须有明确交接
不默认 SharedArrayBuffer 全共享无设计
```
