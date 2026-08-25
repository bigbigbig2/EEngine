# M11 · Material Resolve 设计

> 母本：设计 v2 §10；Shade §9；对比 overdraw

## 1. 输入契约

```txt
VisibilityBuffer（最终）
Depth（重建/插值辅助）
Mesh 属性缓冲
MaterialTable + TextureRegistry
Transform（世界位置/法线）
Camera（反投影）
```

## 2. 处理步骤意图

```txt
1. 读像素 identity
2. 取三角三顶点属性
3. 重心坐标插值（或等价）
4. 采样材质（受无 bindless 策略）
5. 写 GBuffer：albedo、normal、orm、emissive、motion…
```

## 3. GBuffer 成员意图（集合，格式后定）

| 成员 | 用途 |
|------|------|
| albedo / base color | 光照 |
| world/view normal | 光、SSR、AO、GI |
| roughness / metallic / ao | PBR |
| emissive | 合成 |
| motion vector | TAA/SSR |
|（可选）material id | 调试/特殊路径 |

打包与精度：带宽敏感（对比/局限）；设计要求可降精度档。

## 4. 材质分发意图

Shade 精神：

```txt
可对 material 组织 pass
使昂贵 shader 按材质块跑在可见像素上
draw 与材质数相关案例存在（archviz）
```

无 bindless 时：

```txt
同一 material pass 内绑定该材质纹理集
或 uber + array/atlas
策略在 TextureRegistry 与 flags 中体现
```

## 5. 与 Baseline（M09）

```txt
M09：无 VB 时验证 PBR 语义
M11：VB 后的生产路径
二者共享 MaterialRecord 语义与 BRDF 意图，不共享「必须 forward」
```

## 6. 透明

```txt
母本：透明后置
Resolve 主路径按 opaque/alphaTest
```
