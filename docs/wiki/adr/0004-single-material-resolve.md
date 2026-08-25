# ADR-0004 · 单次 Standard PBR Material Resolve

Status: accepted

## 背景

当前 Material Expand 先写 material depth，再为每个材质画全屏三角形，成本随像素数与活跃材质数增长。

## 决策

Standard PBR 主路径一次扫描可见像素，通过 VisibilityKey、VisibleCluster、Geometry、Instance 和 MaterialTable 动态重建表面属性。纹理使用 resident page/array/atlas 方案。

## 后果

- 当前每材质全屏实现属于迁移对象。
- 初期材质模型保持固定 PBR feature bits。
- 未来自定义材质使用少量 Shader Bin，不恢复无界全屏材质循环。

## 验证

材质数量增长 benchmark 必须显示 resolve 成本不再近似线性乘以全屏像素。

