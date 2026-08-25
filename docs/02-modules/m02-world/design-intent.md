# M02 · World — 设计意图

> 母本：设计 v2 flat world / plain data；对比 CPU scene graph 瓶颈

```txt
渲染侧场景 = stores + ids，不是 Object3D 树
Authoring 树留在 Layer 1；本层是 flatten 后的运行时真源（CPU）
供 M04 镜像为 GPU-resident
dirty 模型服务增量，不服务每帧 rebuild list
```
