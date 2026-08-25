# 表家族（设计语义）

> 母本：设计 v2 §6；Shade GPU-resident；对比「数据结构层面重写」  
> 只定义 **每张表为什么存在、谁读写**，不定 stride/字节。

## 1. 总原则

```txt
CPU World stores  = 可编辑真源（逻辑）
GPU tables        = 渲染与 compute 真源（执行）
二者靠 dirty upload 对齐
id 稳定，供 GPU 回查
0 = 无效引用（设计 v2 思路）
```

## 2. 核心表

### InstanceTable

```txt
意图：场景中「可绘制实体」一行一个
典型指向：meshId, materialId, transformId, boundsId, flags
读者：cull、visibility、resolve
写者：Adapter import/sync → World → upload
```

### TransformTable

```txt
意图：世界变换（及后续运动相关可扩展）
高频脏：物体移动时
读者：cull、蒙皮前变换、光栅
```

### MeshTable

```txt
意图：几何资源级描述（非实例）
含：顶点/索引范围、属性布局引用、meshlet 范围、flags
读者：expansion、raster、resolve 回查
```

### MeshletTable

```txt
意图：cluster 粒度几何与局部 bounds
服务：细粒度 cull、VB、无 mesh shader 路径
写者：Geometry bake（导入期为主）
```

### MaterialTable

```txt
意图：PBR 参数 + 纹理 id + flags（双面、alphaTest…）
语义对齐 three Standard 子集（兼容层）
读者：baseline 与 material resolve
```

### BoundsTable

```txt
意图：剔除用包围（球/盒等，形式后定）
读者：frustum / occlusion
动态时随 transform/skinning 更新（Phase 11 方向）
```

### LightTable

```txt
意图：灯光参数供 lighting / clustered 等
写者：Adapter 从 three Light 映射
```

### Texture 元数据表

```txt
意图：TextureId → 实际采样来源（array layer / atlas 页 / 绑定策略）
受无 bindless 强约束（Shade + 06-constraints）
```

## 3. 帧中间缓冲（也属数据面）

| 名 | 意图 |
|----|------|
| VisibleInstanceList | GPU cull 输出 |
| MaybeList | progressive occlusion 不确定集 |
| VisibleMeshletList | meshlet 级可见 |
| Counters | 原子计数 / 间接参数源 |
| IndirectArgs | GPU 驱动绘制 |

这些 **每帧生成**，不是 authoring 常驻资产，但同属 GPU Scene 运行时。

## 4. 帧纹理资源（设计 v2 Frame resources 精神）

```txt
Visibility
Depth / DepthPyramid
MaterialId 类辅助（若走 equal-depth 分发）
GBuffer 多附件
Lighting / History(color/depth)
SSR / GI / Bloom 链
```

归属：FrameGraph 临时资源 + Post history；语义见 `04-pipelines`。

## 5. 谁拥有什么

| 数据 | 逻辑拥有 | GPU 镜像 |
|------|----------|----------|
| Instance/Material… | M02 | M04 |
| Meshlet bake 结果 | M07→M02 | M04 |
| Visible lists | M08 生产 | M04 存 buffer |
| VB/GBuffer | M10/M11 生产 | FrameGraph 资源 |
| History | M13 | FrameGraph / 持久池 |

## 6. 脏模型意图

```txt
transform dirty → 上传 Transform（及派生 bounds）
material dirty  → 上传 Material 行 + 可能失效管线键
geometry dirty  → 重上传 Mesh/Meshlet（昂贵）
texture dirty   → 重上传图像或元数据

禁止：每帧全表重建当作默认
```
