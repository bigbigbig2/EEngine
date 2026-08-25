# Bind Group 布局意图

> 母本：设计 v2 附录 G；系统学习（bind group 显式）；无 bindless

## 1. 分层原则

```txt
Group 0  帧全局：Frame / Camera / 公共 sampler
Group 1  场景表：Instance/Mesh/Meshlet/Material/Transform/Bounds…
Group 2  几何大缓冲：position/normal/tangent/uv/index
Group 3  Pass 资源：纹理 array/目标 RT/深度/VB…
```

目的：

```txt
场景表布局稳定 → 少重建 bind group
Pass 资源每 pass 换 → 隔离在 Group 3
避免「一个巨大 group 绑全世界」导致每 draw 全换
```

## 2. Group 0 意图（母本 G.1）

```txt
frame uniform
camera uniform
linear / nearest sampler（公共）
```

## 3. Group 1 意图（母本 G.2）

```txt
storage read：
  instances, meshes, meshlets, materials, transforms, bounds
（lights 可同组或扩展 binding）
```

注意 **storage 数量上限**（Shade 讨论）：表可合并、或分 pass 只绑子集。

## 4. Group 2 意图（母本 G.3）

```txt
几何属性 storage
供 VB resolve 回读顶点
与 MeshRecord 的 offset 配合
```

## 5. Group 3 意图（母本 G.4）

```txt
MVP：texture_2d_array 分用途
  baseColor / normal / orm / emissive + sampler
Material resolve 另绑：
  visibilityTex、depthTex
Lighting/Post 再换：
  GBuffer 附件、history、shadow 等
```

**不是** `textures[textureId]` 无限 bindless。

## 6. 与 Material 分发

```txt
per-material pass：
  Group 3 可换成该材质相关绑定
  或同一 array，layer 来自 MaterialRecord

uber pass：
  全靠 array + id→layer 元数据
```

## 7. 稳定性与缓存

```txt
Group 0/1 键：场景版本 + 帧常量布局版本
Group 3 键：pass 名 + 资源版本
M01 pipeline/bindGroup cache 消化创建成本
```

## 8. 演进

```txt
slot 编号实现时冻结并写 ADR
本文只锁「分层职责」，不锁最终 binding 整数
```
