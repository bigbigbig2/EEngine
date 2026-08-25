# M15 · Stats / Debug 设计

> 母本：P9；设计 v2 §22；verification 计数精神

## 1. 计数器字典意图（稳定命名）

```txt
cpu.syncMs
cpu.encodeMs
gpu.frameMs（若 timestamp 可用）
upload.bytes
upload.fullCount / upload.rangeCount
scene.instances / meshes / materials / textures
cull.total / cull.visible / cull.maybe / cull.occluded
draw.calls / draw.triangles（估计）
meshlet.visible
pass.time.*（可选）
```

## 2. DebugView 枚举意图

```txt
final
albedo
normal
roughness
metallic
emissive
depth
hzbMip
instanceId
meshletId
materialId
motion
historyWeight
overdrawProxy（若有）
```

## 3. 输出方式意图

```txt
overlay 文本
读回（调试，注意性能）
控制台节流日志
```

## 4. 与验收

```txt
Phase 完成意图依赖这些计数存在且合理变化
无计数 = 无法用docs/source/comparison-three-vs-shade.md 方式讨论瓶颈
```
