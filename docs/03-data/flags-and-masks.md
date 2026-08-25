# Flags 与 Mask 约定（设计层）

> 汇总 Material / Instance / Mesh 等 flags 意图，避免各模块私自定义冲突

## 1. Material.flags（母本 §6.7 精神）

| 位意图 | 含义 |
|--------|------|
| HAS_BASE_COLOR_TEXTURE | 采样 baseColor |
| HAS_NORMAL_TEXTURE | 法线贴图 |
| HAS_ORM_TEXTURE | occl/rough/metal 打包贴图 |
| HAS_EMISSIVE_TEXTURE | 自发光贴图 |
| ALPHA_TEST | alpha cutoff 路径 |
| DOUBLE_SIDED | 双面 |
| UNLIT | 不走完整 PBR 光 |
| RECEIVE_SHADOW | 收阴影 |
| CAST_SHADOW | 投射（也可在 instance） |

实现可用 bitfield；**名字语义**以此表为准。

## 2. Instance.flags 意图

```txt
VISIBLE（逻辑可见，不同于 GPU cull 结果）
STATIC
DYNAMIC_TRANSFORM
CAST_SHADOW / RECEIVE_SHADOW（可覆盖材质）
UI_LAYER / 不进主相机 等
SKINNED（Phase 11）
```

## 3. Mesh.flags / attributeMask

```txt
attributeMask：哪些属性通道存在
flags：压缩格式、是否量化、是否 skinned 几何
```

## 4. LayerMask

```txt
instance.layerMask & camera.layerMask
用于多相机/多用途渲染（反射相机等后置）
对齐 three layers 思想，不保证 bit 位置与 three 数值一致
映射在 Adapter
```

## 5. 变更规则

```txt
新增 flag：扩本表 + 版本说明
禁止 silently 复用已有 bit 含义
```
