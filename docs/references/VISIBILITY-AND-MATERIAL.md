# Visibility 与 Material Resolve 参考

## 执行顺序

```text
HW Visibility contract
→ Unified VisibilityKey / Depth
→ Minimal attribute reconstruction
→ Single Standard PBR Material Resolve
→ optional Compute SW/Hybrid
```

Software Raster 不是 Single Material Resolve 的前置依赖。

## 核心参考

| 参考 | 用途 |
|---|---|
| The Visibility Buffer paper | frame-local key、triangle/instance 回查、属性重建 |
| The Forge TVB | 可运行 triangle filtering、Visibility Buffer、Forward+、OIT、Resolve |
| Bevy Meshlet | Meshlet attribute resolve、barycentric/geometry lookup 对照 |
| Scthe/nanite-webgpu | WebGPU SW/HW raster、32 位原子、micro triangle 分类 |
| MaskedOcclusionCulling | conservative coverage、top-left、depth 和 CPU oracle |
| three.js examples | WebGPU 最短 SW/HW/resolve 垂直闭环 |

详细固定 commit、许可证、源码路径与拒绝边界从 [R4 research guide](./R4-ALGORITHM-GUIDE.md) 路由，并在 [porting ledgers](./porting/README.md) 登记。本页不重复维护任务映射。

## 必须冻结的不变量

- frame-local VisibilityKey 编码 `rasterWorkSlot + localTriangle`，再经 `RasterWork → VisibleCluster/Meshlet` 唯一回查；它与 stable asset/object handle 分离；
- empty/invalid sentinel、key 位宽和 overflow 明确；
- reverse-Z、clip、pixel center、degenerate 和 depth tie 一致；OEngine SW 固定 top-left，但 exact shared-edge 的 HW primitive owner 不作为跨 WebGPU 后端硬保证；
- perspective-correct barycentric、UV gradient/mip、normal/tangent 和 velocity 可验证；
- final Hardware depth 按 WebGPU rasterization 语义处理，不套用 attribute reciprocal-W 校正；
- alpha-tested discard 在 Visibility 阶段完成；
- Material Resolve 不感知像素来自 HW 还是 SW；
- HW-only 是完整正确性 baseline。

## Material Resolve 性能假设

单次 Resolve 删除 `activeMaterials × fullscreen pixels`，但可能增加随机 geometry/material/texture lookup。必须同时报告：

- resolve GPU time 与 shaded pixels；
- active material 与 texture bank 分支；
- geometry/material table stride 与读取字节；
- surface attachment 带宽；
- fallback texture、invalid key 和 derivative error。

## SW/Hybrid 采用门槛

Compute Micro Raster 只处理目标微三角形 workload。alpha/复杂 clip、near-plane 大三角形、超大 bbox、queue overflow、atomic hotspot 和 MSAA 必须回退 Hardware。只有目标桌面 adapter 的 P50/P95 证明收益时才默认启用。

SW feature off 必须零资源/零 Pass；feature on 但 GPU queue empty 时仍需报告 atomic buffer、clear、classifier 和 merge 固定成本。
