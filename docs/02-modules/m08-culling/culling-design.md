# M08 · Culling 设计

> 母本：设计 v2 §7；Shade v3 §7；docs/source/comparison-three-vs-shade.md occlusion

## 1. 目标分层

```txt
L1  GPU frustum（Phase 3）
L2  previous-frame HZB occlusion + maybe（Phase 7）
L3  meshlet 级同样 visible/maybe（Phase 4+）
L4  更细 triangle / 小 primitive（Shade 方向，后置）
```

## 2. 输入 / 输出（接 pass-contracts）

```txt
In:  Instance + world Bounds + Camera [+ DepthPyramid]
Out: Visible* / Maybe* / Counters
```

## 3. Visible / Maybe / Rejected（母本语义）

| 集合 | 含义 |
|------|------|
| Visible | 明确要画（锥内 + 保守 occlusion 通过） |
| Maybe | 需要当前帧更可信深度再判 |
| Rejected | 明确不画 |

简化阶梯（母本允许）：

```txt
先：仅 visible，无 maybe
再：visible + maybe
再：prev HZB + current resolve
```

## 4. Frustum 意图

```txt
对 world bounds（球/盒）测锥
layerMask 与相机层
padding 防边界闪烁（实现参数，设计要求可调）
```

## 5. HZB 意图

```txt
投影 bounds → 选 mip → 读保守深度 → 比较
false negative（错杀）比多画更伤：需 padding / maybe / 延迟 1 帧策略
Apple 等平台 prefix/scan 表现差异（Shade 经验）→ 实现可选算法，设计要求可替换
```

## 6. 与绘制的衔接

```txt
仅 frustum 阶段：Visible list → Baseline 或 indirect draw
VB 阶段：Visible meshlet list → VisibilityRaster
Stats：total / visible / maybe / occluded
```

## 7. 何时可关

```txt
docs/source/comparison-three-vs-shade.md：少遮挡开阔场景收益低
产品分档可关 occlusion，保留 frustum
```
