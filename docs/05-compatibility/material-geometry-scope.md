# 材质与几何范围（设计层）

> 设计 v2 §1.3、§25；verification 白名单精神；P8 opaque first  
> **字段级清单可随实现微调**；本文件定 **范围哲学**

## 1. 优先支持面（母本）

```txt
静态 Mesh / 实例
BufferGeometry：position、normal、uv（tangent 可生成）
MeshStandard 方向的不透明 PBR
baseColor / normal / ORM 类贴图 / emissive
常用相机
方向光 + 环境/IBL 方向
alphaTest 可作为不透明管线扩展
双面 flags
```

## 2. 明确后置（母本「第一阶段不适合」）

```txt
完整 ShaderMaterial / NodeMaterial / TSL 内核兼容
复杂透明 / transmission / clearcoat / sheen 优先
WebXR 完整
全 glTF 扩展一次到位
编辑器任意改拓扑
Skinned / morph（Phase 11 方向，非 Phase 1）
```

## 3. 与「尽量用原来的」 

```txt
用原来的：参数名字与艺术家直觉、loader、math
不用原来的：three 内部 program/render list 行为保证
```

## 4. 超出范围时

```txt
可观测：warn / error / unlit / skip
写入 ImportResult 类结果（设计意图）
禁止静默错着色当成功
```
