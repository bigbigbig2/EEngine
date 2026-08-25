# 记录字段语义（设计级）

> 母本：设计 v2 §6.3–§6.8  
> **字段含义与用途**；对齐/padding/_pad 为实现细节，此处可出现母本结构作参照，不锁死最终字节。  
> **与母本逐项对照 / Phase 就绪矩阵：** [mother-doc-field-map.md](./mother-doc-field-map.md)

---

## 1. InstanceRecord

### 字段

| 字段 | 含义 |
|------|------|
| meshId | 几何资源 |
| materialId | 材质 |
| transformId | 当前/历史变换所在行 |
| boundsId | 世界空间包围（供 cull） |
| flags | 可见、阴影投射/接收、动态等 |
| layerMask / objectLayerMask | 层过滤（与相机/光层） |

### 用途（母本）

```txt
culling：读 bounds
visibility：instance → mesh/material/transform
material resolve：→ material
motion：→ transform 的 prev/current
```

### 更新频率意图

```txt
结构增删：导入/流式/销毁时
material 换绑：中频
每帧：通常不改行内容（只改 transform 表）
```

---

## 2. TransformRecord

### 字段意图

| 块 | 含义 |
|----|------|
| world 矩阵 | 当前帧物体→世界 |
| prevWorld 矩阵 | 上一帧，供 motion vector / TAA |
| normal 矩阵 | 可预计算，避免 shader 里 inverse-transpose |

母本用多组 vec4 存矩阵行/列（实现可选 mat3x4 压缩）。

### 更新策略（母本）

```txt
静态：上传一次
动态：每帧只上传 dirty range
动画：可先 CPU 写表，后 GPU animation（Phase 11）
```

### 与 TAA 的契约

```txt
有 prevWorld 才能稳定物体运动向量
相机运动另由 CameraUniform 的 prevViewProj 等承担
缺 prev：TAA/SSR 只能做降级（无运动或仅相机）
```

---

## 3. MeshRecord

### 字段

| 字段 | 含义 |
|------|------|
| vertexOffset / indexOffset | 大缓冲内偏移 |
| vertexCount / indexCount | 计数 |
| meshletOffset / meshletCount | 在 MeshletTable 中的范围 |
| attributeMask | 有哪些属性（pos/n/tan/uv/…） |
| flags | 压缩格式、是否 skinned 等 |
| boundsId | mesh 局部包围（可选） |

### 属性缓冲意图（母本 MVP layout 方向）

```txt
position
normal
tangent
uv0
（color 可选）
```

后期可压缩；设计层要求 **可经 id 取到三角顶点数据** 供 VB resolve。

---

## 4. MeshletRecord（意图级）

母本 §8 方向；字段级设计意图：

```txt
local 三角/顶点范围或压缩几何引用
local bounds（中心半径或 AABB）
所属 meshId 或隐式由 mesh.meshletOffset 推导
cone / 法线锥（可选，背面/小特征 cull）
```

服务：meshlet cull、expansion、VB 绘制组织。

---

## 5. BoundsRecord

### 字段（母本）

| 字段 | 含义 |
|------|------|
| center + radius | 球包围，frustum/occlusion 快测 |
| aabbMin / aabbMax | 盒包围，更紧 |

### 空间

```txt
object-space：mesh 局部
world-space：instance 级，cull 优先读这个
```

母本建议：cull 读 **world-space**，避免 compute 每帧变换 8 个角点（除非 GPU 更新 bounds）。

---

## 6. MaterialRecord

### 字段（母本 MVP PBR）

| 字段 | 含义 |
|------|------|
| baseColorFactor | 基础色 + alpha 因子 |
| metallic / roughness | PBR |
| alphaCutoff | alphaTest |
| flags | 贴图有无、双面、unlit、阴影标志等 |
| baseColorTextureId 等 | 0=无贴图 |
| emissiveFactor | 自发光 |
| uvTransform* | 贴图变换（对齐 three/glTF 约定） |

### flags 意图（母本枚举精神）

```txt
HAS_BASE_COLOR / NORMAL / ORM / EMISSIVE 贴图
ALPHA_TEST
DOUBLE_SIDED
UNLIT
RECEIVE_SHADOW / CAST_SHADOW
```

### 范围

```txt
第一阶段：opaque + alpha-test（及 hashed 方向）
透明 blend：后置单独管线（母本明确）
```

语义对齐 three MeshStandard 子集（docs/05）。

---

## 7. TextureRecord / Registry

### 为何不能「id 即 bindless 下标」

```txt
WebGPU 无真正 bindless（母本 §6.8 + Shade）
```

### Registry 模式意图

```txt
array | atlas | virtual | bind-group-batches
```

### TextureRecord 字段意图

| 字段 | 含义 |
|------|------|
| id | TextureId |
| width/height/format/mipCount | 资源描述 |
| samplerId | 采样器 |
| arrayLayer | 在 array 中的层 |
| atlasRect | atlas UV 矩形 |
| virtualPageTableId | VT 方向预留 |

### 策略阶梯（母本）

```txt
MVP：array / atlas + 硬约束
Production：VT 或材质批 + 更强打包
```

---

## 8. LightRecord（意图）

```txt
type（dir/point/spot/…）
方向/位置/色/强度
范围与衰减
shadow 索引或 flags
层 mask
```

细节随 clustered/CSM 阶段加字段；表必须存在以便 lighting 不扫 three 灯对象。

---

## 9. Camera / Frame 常量（非表行，但是数据面）

每帧（或 dirty）Uniform 意图：

```txt
viewProj / invViewProj
prevViewProj
camera position
jitter（TAA）
z 参数 / 分辨率
时间 / 帧号
曝光等全局
```

归属：FrameGraph BeginFrame / 相机模块；与 Transform.prev 共同服务 TAA。

---

## 10. 中间列表元素（意图）

### VisibleInstance 元素

```txt
instanceId
（可选）LOD / 排序键
```

### Maybe 元素

```txt
instanceId 或 meshletId
需二次测试的原因位（可选）
```

### 间接绘制参数

```txt
符合 WebGPU indirect 布局的 vertex/instance 计数等
由 compaction / prefix sum 类过程填充（Shade 精神）
```

---

## 11. 字段演进规则

```txt
可加字段：新 Phase 需要时
不可偷偷改语义：已有 id 含义需 ADR
压缩/改布局：渲染核版本或 bake 版本号
```
