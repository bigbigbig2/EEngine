# M07 · Geometry 设计

> 母本：设计 v2 §8；Shade meshlet；`03-data/meshlet-record.md`

## 1. 流水线意图

```txt
BufferGeometry 提取
→ 规范化属性（缺 normal/tangent 则生成或关特性）
→ （可选）优化索引（meshoptimizer 方向）
→ meshlet 切分
→ 写入 Mesh + Meshlet + 几何大缓冲
```

## 2. 规范化规则意图

```txt
右手系/单位与 three 一致
uv 集合与材质 transform 配合
索引化网格优先
```

## 3. Meshlet 构建参数意图

```txt
max triangles / max vertices per meshlet
可配置
失败：退回「单 meshlet = 整 mesh」仍可跑
```

## 4. 何时构建

```txt
import 期 bake（主）
离线预计算缓存（后）
运行时改拓扑：昂贵，非友好路径
```

## 5. 与 GPU

```txt
大缓冲布局与 MeshRecord offset 一致
压缩后期做，MVP 可读优先
```
