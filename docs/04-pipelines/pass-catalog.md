# Pass 名册（设计层）

> 汇总设计 v2 FrameGraph 默认任务 + Shade 一帧阶段  
> **名册 ≠ 每帧全开**；由设置与模块 tree-shake 决定

## 1. 名册

| Pass / 任务族 | 意图 | 主责模块 | 典型阶段 |
|---------------|------|----------|----------|
| BeginFrame | 帧索引、清统计、分辨率 | M05/M15/M14 | P0+ |
| UploadDirtyScene | 脏表上传 | M04 | P2+ |
| CullInstances | 视锥（及后 occlusion） | M08 | P3+ |
| MeshletExpand | instance→meshlet 列表 | M07/M08 | P4+ |
| CullMeshlets | meshlet 级过滤 | M08 | P4+ |
| VisibilityRaster | 写 VB + depth | M10 | P5+ |
| DepthPyramid | HZB 构建 | M08/M10 | P7（及依赖方） |
| MaybeResolve | 二次可见性 | M08 | P7 |
| VisibilityRasterMaybe | 补 raster | M10 | P7 |
| MaterialId / 分发辅助 | 材质路由 | M11 | P6 |
| MaterialResolve | 可见像素材质→GBuffer | M11 | P6 |
| Lighting | 直接光/IBL/… | M12 | P1 简 / P6 全 |
| Shadow | CSM/contact 等 | M12 | P9 |
| AO（GTAO 等） | 环境光遮蔽 | M13/M12 | 路线 |
| SSR | 屏空反射 | M13 | P9 |
| GI | 探针/SVLM 等 | M12/M13 | P10 |
| TAA | 时间累积 | M13 | P8 |
| Bloom | 光晕 | M13 | 路线 |
| AutoExposure | 曝光 | M13 | 路线 |
| Tonemap / RCAS | 输出 | M13 | P1 简 / 后加强 |
| Present | 交换链 | M01/M05 | P0+ |
| DebugView | 覆盖调试 | M15 | 全程 |

## 2. 与 Shade #86 精神对齐

```txt
filter instances
→ expand meshlets
→ visibility
→ pyramid
→ maybe
→ material
→ lighting / post
```

名册用工程任务名表达同一故事。

## 3. Baseline 路径上的子集

在 VB 成熟前，名册可出现：

```txt
Upload → Cull → BaselineDraw（M09）→ Tonemap → Present
```

这是 **阶梯**，不是最终替换 Visibility/Resolve 行。

## 4. 依赖边（粗）

```txt
Upload → Cull →（Meshlet*）→ Visibility* → Pyramid → Maybe*
MaterialResolve → Lighting →（Shadow/AO/SSR/GI）→ TAA → Bloom/Tonemap → Present
```

TAA 对 motion/depth/history 的边见 M13 设计意图。
