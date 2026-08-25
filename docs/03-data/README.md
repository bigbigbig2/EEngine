# 03 · Data — 数据面设计

> 权威：设计 v2 §6、§10.4、附录 A/G

## 文件索引

| 文件 | 内容 |
|------|------|
| [ids.md](./ids.md) | ID 规则、稳定性、分配权、TextureId≠采样下标 |
| [lite-handle.md](./lite-handle.md) | three ↔ id 桥梁 |
| [table-family.md](./table-family.md) | 表家族职责 |
| [records-fields.md](./records-fields.md) | Instance/Transform/Mesh/Material/… 字段 |
| [mother-doc-field-map.md](./mother-doc-field-map.md) | **母本 §6 ↔ 分册字段对照**（阶段就绪矩阵） |
| [meshlet-record.md](./meshlet-record.md) | Meshlet 记录 |
| [flags-and-masks.md](./flags-and-masks.md) | Material/Instance/Mesh flags、layerMask |
| [store-model.md](./store-model.md) | CPU Store / freeList / dirtyRange |
| [dirty-model.md](./dirty-model.md) | 脏种类与反模式 |
| [frame-and-camera.md](./frame-and-camera.md) | Frame/Camera 常量、jitter、prevVP |
| [gbuffer-layout.md](./gbuffer-layout.md) | GBuffer 成员、分档、空间约定 |
| [bind-group-layout.md](./bind-group-layout.md) | Group 0–3 分层 |
| [ownership-and-lifetime.md](./ownership-and-lifetime.md) | 所有权与生命周期 |

## 阅读顺序

```txt
ids → lite-handle → table-family → records-fields
 → mother-doc-field-map（与母本 §6 对齐检查）
 → meshlet-record → flags-and-masks
 → store-model → dirty-model
 → frame-and-camera → gbuffer-layout → bind-group-layout
 → ownership-and-lifetime
```

## 状态

```txt
✅ 语义与字段意图（含母本对照表）
❌ byte stride 冻结 / WGSL binding 号定稿
```
