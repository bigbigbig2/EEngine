# 模块地图

> 模块是设计 v2 能力全集的所有权切分；能力列表以母本为准，不在此删减。

## 依赖方向

```txt
M03 Adapter（three peer）
  → M02 World → M04 GPU Scene
M01 Engine ← 几乎所有 GPU 模块
M05 FrameGraph 挂载 M08–M13
M07 Geometry → 供 M08/M10
M08 Culling → 供 M09/M10
M10 Visibility → M11 Resolve → M12 Lighting → M13 Post
M14 Browser 横切 M01/M13
M15 Stats 横切可观测点
```

## 禁令（来自母本）

```txt
M04–M13 不依赖 three 类型作主路径
不把 WebGPURenderer 当 Layer 3
不把浏览器外壳（M14）当成可有可无
```

## 索引

见 [02-modules/README.md](../02-modules/README.md)。
