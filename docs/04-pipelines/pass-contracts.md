# Pass 输入 / 输出契约（设计层）

> 母本：设计 v2 §5、§7、§9–§11、§17；Shade 一帧  
> 契约 = **读什么、写什么、依赖谁、失败含义**；不是 shader 代码。

图例：

```txt
R = 读   W = 写   RW = 读写   opt = 可选
```

---

## BeginFrame

| | |
|--|--|
| **意图** | 帧号、分辨率、统计清零、可见性/丢失策略入口 |
| **R** | 设置项、Browser 状态、swapchain 尺寸 |
| **W** | FrameContext 常量草稿、Stats 帧头 |
| **模块** | M05、M14、M15、M01 |

---

## UploadDirtyScene

| | |
|--|--|
| **意图** | CPU World → GPU tables 增量对齐 |
| **R** | dirty ranges、CPU stores |
| **W** | Instance/Transform/Material/… GPUBuffer |
| **不变量** | 本 pass 后，本帧后续 pass 所见表与 dirty 意图一致 |
| **模块** | M04、M02 |

---

## ResetCounters

| | |
|--|--|
| **意图** | visible/maybe 计数、indirect 清零 |
| **W** | counter buffers |
| **模块** | M04/M08 |

---

## CullInstances

| | |
|--|--|
| **意图** | instance → visible / maybe / culled |
| **R** | Instance、Bounds、Camera；opt 上一帧 DepthPyramid |
| **W** | VisibleInstanceList、MaybeInstanceList、Counters |
| **阶段** | 先 frustum only；后加 HZB |
| **模块** | M08 |

**语义（母本）：**

```txt
Visible：锥内且保守 occlusion 明确可见
Maybe：锥内但 occlusion 不确定
Rejected：锥外或明确遮挡
```

---

## ExpandMeshlets / CullMeshlets

| | |
|--|--|
| **意图** | 可见 instance 展开为 meshlet，再细粒度过滤 |
| **R** | Visible instances、Mesh、Meshlet、Bounds、Camera、opt HZB |
| **W** | VisibleMeshletList、（Maybe meshlet）、Counters |
| **模块** | M07 + M08 |
| **约束** | 承认 expansion divergence（Shade）；设计需 batch 意识 |

---

## RasterVisibility

| | |
|--|--|
| **意图** | 轻量光栅，写「看见了谁」 |
| **R** | 可见 meshlet/triangle 组织结果、Transform、Mesh 几何、Camera |
| **W** | VisibilityBuffer、MainDepth |
| **不做** | 完整 PBR 着色 |
| **模块** | M10 |

**VB 内容意图（母本方案）：**

```txt
MVP 可偏冗余：instanceId / triangleId / materialId 等
生产可 pack 到 rg32uint
```

**光栅路径意图：**

```txt
MVP：硬件 raster pipeline
后期：才考虑 compute software raster 研究
```

---

## BuildDepthPyramid

| | |
|--|--|
| **意图** | 由 depth 建 HZB，供 occlusion / SSR 等 |
| **R** | MainDepth |
| **W** | DepthPyramid mips |
| **模块** | M08 / M10 协作，调度在 M05 |

---

## ResolveMaybe / RasterMaybeVisibility

| | |
|--|--|
| **意图** | 用更可信 depth/HZB 消化 maybe，补写 VB |
| **R** | Maybe 列表、当前 Pyramid、几何表 |
| **W** | 更新 Visibility/Depth、列表压缩 |
| **模块** | M08、M10 |

---

## MaterialResolve

| | |
|--|--|
| **意图** | 读 VB → 重建属性 → 材质 → GBuffer |
| **R** | Visibility、几何属性、Material、Texture 策略、Transform |
| **W** | GBuffer（albedo/normal/orm/motion/emissive… 集合成员随阶段） |
| **目标** | 昂贵材质逻辑面向最终可见像素（对比/Shade） |
| **模块** | M11 |

**分发意图：**

```txt
per-material 或 batch
受无 bindless 约束的纹理访问
```

---

## DeferredLighting（及早期 BaselineDraw）

### BaselineDraw（阶梯）

| | |
|--|--|
| **意图** | 无完整 VB 时 table-driven 画对 PBR |
| **R** | tables、相机、灯、纹理 |
| **W** | 颜色目标（+ 可选 depth） |
| **模块** | M09 |

### DeferredLighting

| | |
|--|--|
| **意图** | 读 GBuffer 做直接光/IBL 等 |
| **R** | GBuffer、LightTable、Shadow maps、IBL |
| **W** | HDR 光照色 |
| **模块** | M12 |

---

## Shadow

| | |
|--|--|
| **意图** | 阴影图/级联/contact 等 |
| **R** | 可见 caster 列表或复用 cull 思想、灯参数 |
| **W** | shadow maps / 屏空 contact 缓冲 |
| **模块** | M12 |
| **阶段** | Phase 9 方向为主 |

---

## SSR

| | |
|--|--|
| **意图** | 屏空反射；难点在 resolve/denoise/history（Shade） |
| **R** | depth/HZB、normal、roughness、HDR 色、motion |
| **W** | 反射色；与 TAA 共享时间稳定 |
| **模块** | M13 |
| **分档** | 半分辨率默认策略（局限） |

---

## GI

| | |
|--|--|
| **意图** | 间接光（probe / SVLM / bake 等母本方向） |
| **R** | 世界位置/法线、探针数据、可见性辅助 |
| **W** | 间接光照贡献 |
| **模块** | M12/M13 |
| **阶段** | Phase 10；可关 |

---

## TAA

| | |
|--|--|
| **意图** | 时间抗锯齿与多效果稳定胶水 |
| **R** | 当前 HDR、history、motion、depth、jitter 元数据 |
| **W** | 稳定色；更新 history |
| **侵入** | 相机 jitter；材质采样去抖；mip bias（Shade） |
| **模块** | M13 |
| **Browser** | 隐藏/lost 后 invalidate history（M14） |

---

## Bloom / AutoExposure / Tonemap / RCAS

| | |
|--|--|
| **意图** | 展示链；可与 SSR 等共享中间 RT（Shade FrameGraph） |
| **R/W** | HDR ↔ 展示色；直方图/曝光状态可跨帧 |
| **模块** | M13 |

---

## Present

| | |
|--|--|
| **意图** | 写入 swapchain |
| **R** | 最终色 |
| **W** | canvas 纹理 |
| **模块** | M01、M05 |

---

## DebugView

| | |
|--|--|
| **意图** | 覆盖显示 albedo/normal/depth/id/hzb/motion… |
| **R** | 任意中间资源 |
| **W** | debug 目标或替换 Present 源 |
| **模块** | M15 |

---

## 契约级不变量（全集）

```txt
1. 无 Upload 完成前，Cull/Raster 不得假设表新鲜
2. 无 Visibility 稳定前，MaterialResolve 无定义
3. TAA 无 motion/depth 契约时必须降级，不得假装稳定
4. Pass 可融合（母本 §17.4），但逻辑契约仍可分解叙述
5. 名册全开不是默认；分档关闭不删契约定义
```
