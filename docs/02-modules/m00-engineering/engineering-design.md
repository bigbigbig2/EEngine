# M00 · 工程骨架设计意图

> 母本：设计 v2 §21；repo-alignment

## 1. 目标包图（与模块对齐）

```txt
packages/engine          M01
packages/world           M02
packages/adapter-three   M03  peer: three
packages/gpu-scene       M04
packages/frame-graph     M05（或并入 engine）
packages/shaders         M06
packages/geo             M07
packages/render/*        M08–M13
packages/browser         M14
packages/debug           M15
examples/*
```

可合并包，但 **依赖方向** 不可反：

```txt
render ✗→ three
仅 adapter-three → three
```

## 2. 文档与代码同构

```txt
docs/02-modules/mXX  ↔  package 边界
改边界先改文档/ADR
```

## 3. 示例

```txt
minimal：Phase 0
import-gltf：Phase 1
tables-cull：Phase 2–3
… 随阶段加
```

## 4. 许可

```txt
three MIT peer
复制公式保留声明
```
