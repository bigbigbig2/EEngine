# ADR-0011 · Exact RasterWork 与 Direct VisibilityKey

Status: accepted

Supersedes: ADR-0010 中 `VisibilityKey v1` 的 bit packing、Meshlet 粒度 RasterWork 与 resolve lookup；ADR-0010 的 reverse-Z、Hardware-first、alpha coverage、SW feature-off 和 Surface 后继边界继续有效。

## 背景

生产证据显示旧链把一个 Meshlet RasterWork 固定提交为 128 个 triangle 上限，`109,312 triangles` 是 `854 × 128` 的容量推算，不是实际可见三角形。每像素 resolve 还需要 `VisibilityKey → RasterWork → VisibleCluster → Meshlet` 回查。低中几何 Dungeon 已在 Hardware Raster 与 Material Resolve 暴露该结构的固定成本，不能以未来高几何场景为理由保留。

## 决策

1. 只有一条生产链。现有类型和文件原位迁移，不增加 `V2`、`next`、`legacy/new` 产品路径。
2. `SelectedCluster` 之后执行 exact triangle filter/compact；每个 `RasterWork` record 精确对应一个 triangle，包含 instance、geometry、meshlet、local triangle、material 和 raster flags。
3. OPAQUE 与 MASK 是同一 producer 的两个有界语义区间/队列。Hardware Visibility 最多两个固定 drawIndirect；不按材质 draw。
4. indirect `vertexCount = writtenTriangleCount × 3`、`instanceCount = 1`。vertex shader 使用 `vertex_index / 3` 和 `% 3`，删除固定 384-vertex submit。
5. `VisibilityKey` 是最终 RasterWork slot：`0xFFFFFFFF` empty、`0xFFFFFFFE` invalid，其余是合法 slot。删除 localTriangle bit packing 和 VisibleCluster 热路径回查。
6. 生产 queue 在 encode 前由 package/scene capacity 和 adapter storage limit 证明；overflow 不截断。所有 queue 定义 ABI、capacity、attempted/written/peak/overflow/fallback 与真实 producer/consumer。
7. exact filter 以固定 The Forge commit 为主要移植来源，并保留其完整分类、compaction、numeric/overflow 与测试不变量；OEngine 只改 WebGPU bindings、record ABI 和 clip/viewport conventions。
8. Runtime package、material、texture 和 instance owner 分离；场景 cold load 是 validate/reserve/encode/publish 的单一事务，半场景不得发布。

## 后果

- ABI 数字版本递增，旧 package/queue/key reader 在仓库调用方迁移后删除；Git 历史是回退手段。
- candidate exact work 可以是 filter 的内部输入，但不能被最终 Visibility 当作未过滤生产队列。
- OPAQUE visibility 不绑定 PBR texture；MASK 只绑定 coverage 所需资源。
- 纹理压缩驻留必须通过 KTX2/Basis 的可追溯采用完成；固定 4K RGBA8 array 扩容不是替代方案。
- 第二步才处理 visible-pixel classification、specialized Material Resolve 和 compact Surface；本 ADR 不改变 Surface 后的 Forward/Deferred/Lighting 决策。

## 验证

- CPU/GPU oracle：degenerate、backface、frustum、near-plane、small primitive、mirrored、double-sided、OPAQUE/MASK；
- exact queue/header/indirect/key ABI 和 overflow property tests；
- alpha/UV0-2/texture transform、reverse-Z、debug direct lookup；
- package/manifest/hash/capacity、transaction commit/rollback/device loss；
- Dungeon 与 dense 同链 paired artifact，使用 `docs/PERFORMANCE.md` 固定条件。
