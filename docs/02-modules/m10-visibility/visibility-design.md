# M10 · Visibility Buffer 设计

> 母本：设计 v2 §9；Shade v3 §6

## 1. 管线位置

```txt
… → Cull/Meshlet → VisibilityRaster →（Pyramid/Maybe）→ MaterialResolve → …
```

## 2. 写什么

**身份（identity）** 而非材质结果。

MVP 格式意图（母本）：

```txt
偏调试友好的多通道 uint（如 instance / triangle / material）
生产可 pack 为 rg32uint
```

同时写 **depth**，供 HZB 与后续。

## 3. 不写什么

```txt
完整 albedo/normal 着色
光照
纹理采样（除 alphaTest 等最小需求外尽量避免变贵）
```

alphaTest / hashed：可在 VB 或后续策略中处理；母本允许 alpha-test 路径，需在设计中单列（不静默当 opaque）。

## 4. 如何画几何（母本建议）

```txt
MVP：硬件 raster
组织：由 visible meshlet/triangle 列表驱动
后期：才研究 software compute raster
```

无 mesh shader → 列表生成在 compute（M07/M08）。

## 5. 与 G-buffer 的分工

```txt
VB：谁
GBuffer（M11）：看上去怎样（材质属性）
Lighting：怎样被照亮
```

## 6. 代价（必须写进评审）

```txt
+ 减 overdraw 材质浪费
− 带宽、重建属性、无 bindless 纹理难
```

## 7. Debug

```txt
伪彩 instanceId / meshletId / triangleId / materialId
无 ID 区域应可识别（清零/背景）
```
