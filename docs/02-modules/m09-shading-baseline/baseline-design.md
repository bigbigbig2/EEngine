# M09 · Baseline Shading 设计

> 母本：P7/P8；设计 v2 PBR 子集；阶梯不是终点

## 1. 存在理由

```txt
在 VB 完成前验证：
  表驱动正确
  材质语义正确
  Adapter 导入正确
```

## 2. 行为意图

```txt
读 Instance/Transform/Mesh/Material
按可见列表（有 cull 后）或全量（仅调试）绘制
MeshStandard 子集 PBR + 简单灯/IBL
输出 HDR 或 LDR（阶段早期可简化）
```

## 3. 与 M11 共享

```txt
同一 MaterialRecord
同一纹理策略
同一 BRDF 意图（代码可逐步收敛到公共 lib）
```

## 4. 退役

```txt
Mode C 成熟后：Baseline 可变为
  fallback
  调试模式
  低端分档
但不从仓库目标中「假装从未有过 VB」
```

## 5. Debug

```txt
强制 albedo/normal/roughness 输出
与 three 并排主观对比（不要求像素级）
```
