# 母文档 ↔ 记录字段对照

> **权威字段形状**来自设计 v2 §6.3–§6.8（及 §7/§8/§10 相关中间结构）  
> **工程分册语义**落在 `records-fields.md`、`meshlet-record.md`、`flags-and-masks.md`、`frame-and-camera.md`、`gbuffer-layout.md`  
> 本文是 **对照表**：母本叫什么、分册写到哪、何时进入主路径、实现冻结边界。  
> **不锁** byte stride / `_pad` 最终布局 / WGSL binding 号。

---

## 1. 怎么用这张图

```txt
改字段语义 → 先改母本理解与本文「含义」列，再同步 records-fields
加 Phase 字段 → 标「引入阶段」，不偷偷改已有 id 含义（见 records-fields §11）
实现 freeze → 另开 stride/binding 文档；本文保持意图级
```

图例：

| 标记 | 含义 |
|------|------|
| **P0–P11** | 设计 v2 Phase；字段 **主路径需要** 的最早阶段 |
| **预留** | 表/字段可早建，语义严格使用在后阶段 |
| **分册** | `docs/03-data` 内承接页 |

---

## 2. 表家族总览

| 母本概念（设计 v2） | 分册 | 主责模块 | 主路径引入 |
|--------------------|------|----------|------------|
| Instance Table §6.3 | records-fields §1 | M04 | **P2** |
| Transform Table §6.4 | records-fields §2 | M04 | **P2**（prev 语义严用 **P8**） |
| Mesh Table §6.5 | records-fields §3 | M04 / M07 | **P2** |
| Meshlet（§8 方向） | meshlet-record | M07 / M04 | **P4** |
| Bounds | records-fields §5 | M04 / M08 | **P2**（cull **P3**） |
| Material Table §6.6 向 | records-fields §6 | M04 / M09–M11 | **P1–P2** |
| Texture / Registry §6.8 | records-fields §7 | M04 / M14 约束 | **P1–P2** |
| Light | records-fields §8 | M12 | 随 lighting；P1 可简 |
| Frame / Camera 常量 | frame-and-camera | M01/M05 | **P0–P1** |
| Visible / Maybe 列表 | records-fields §10 | M08 / M04 | Visible **P3**；Maybe **P7** 向 |
| G-buffer 成员 | gbuffer-layout | M11 | **P6** |
| Bind group 分层 | bind-group-layout | M04–M06 | 随表绑定；slot 后冻 |

---

## 3. InstanceRecord

**母本（设计 v2 §6.3）CPU / WGSL 形状参照：**

| 母本字段 | 分册含义 | 主读者 | 阶段 |
|----------|----------|--------|------|
| meshId | 几何资源 | VB / Baseline / Resolve | P2 |
| materialId | 材质行 | Resolve / Baseline | P2 |
| transformId | 当前/历史变换行 | 绘制 / motion | P2 |
| boundsId | 世界包围 | Cull | P2–P3 |
| flags | 可见、阴影投射/接收、动态等 | Cull / Shadow | P2+ |
| objectLayerMask / layerMask | 与相机/光层过滤 | Cull / Light | P2–P3 |

**母本用途原文精神 → 分册：**

| 母本用途 | 分册落点 |
|----------|----------|
| culling 读 bounds | records-fields §1；M08 |
| visibility：instance→mesh/material/transform | M10 / M09 |
| material resolve→material | M11 |
| motion→transform prev/current | M13；依赖 Transform.prev |

**分册扩展（非母本 struct 逐字段写出，但设计允许）：** 无强制新列；layer 命名 CPU `objectLayerMask` / WGSL `layerMask` 视为同一语义。

---

## 4. TransformRecord

| 母本块 | 分册含义 | 阶段 |
|--------|----------|------|
| world0–3（矩阵行/列） | 当前帧 object→world | **P2** |
| prevWorld0–3 | 上帧，供 motion / TAA | 字段 **P2 可填**；严格契约 **P8** |
| normal0–2 | 预计算 normal 矩阵 | **P2**（可简化为 shader 算，意图保留） |

| 更新策略（母本） | 分册 |
|------------------|------|
| 静态上传一次 | dirty-model / store-model |
| 动态只传 dirty range | dirty-model |
| 动画先 CPU 后 GPU anim | Phase 11；M03/M07 |

**缺 prev 时：** TAA/SSR 降级（仅相机或无物体运动）——frame-and-camera + M13。

---

## 5. MeshRecord

| 母本字段 | 分册含义 | 阶段 |
|----------|----------|------|
| vertexOffset / indexOffset | 大缓冲内偏移 | P1–P2 |
| vertexCount / indexCount | 计数 | P1–P2 |
| meshletOffset / meshletCount | MeshletTable 范围 | **P4**（P2 可 0） |
| attributeMask | pos/n/tan/uv/… | P1–P2 |
| flags | 压缩、skinned 等 | P2；skin **P11** |
| boundsId | mesh 局部包围（可选） | P2+ |

**属性缓冲方向（母本）：** position、normal、tangent、uv0、（color 可选）→ geometry-design / M07。

---

## 6. MeshletRecord

| 母本方向（§8） | 分册（meshlet-record） | 阶段 |
|----------------|------------------------|------|
| 三角/顶点局部范围或压缩引用 | 几何引用字段意图 | P4 |
| local bounds | cull 用 | P4 |
| mesh 归属（显式 id 或由 mesh 范围推导） | 二选一实现，语义稳定 | P4 |
| cone / 法线锥（可选） | 背面/小特征 cull | P4+ |

**闭环 Phase 0–3：不要求 Meshlet 表参与主路径。**

---

## 7. BoundsRecord

| 母本字段 | 分册含义 | 阶段 |
|----------|----------|------|
| center + radius | 球，frustum/occlusion 快测 | P2；用 **P3** |
| aabbMin / aabbMax | 盒，更紧 | P2–P3 可选加强 |

| 空间 | 母本建议 | 分册 |
|------|----------|------|
| object-space | mesh 局部 | bounds 可挂 Mesh |
| **world-space** | **cull 优先读** | Instance.boundsId → world Bounds |

避免 compute 每帧变换 8 角点（除非 GPU 更新 bounds）——culling-design。

---

## 8. MaterialRecord

| 母本 MVP PBR | 分册含义 | 阶段 |
|--------------|----------|------|
| baseColorFactor | 基色 + alpha 因子 | P1 |
| metallic / roughness | PBR | P1 |
| alphaCutoff | alphaTest | P1+ |
| flags | 贴图有无、双面、unlit、阴影等 | P1–P2 |
| *TextureId（0=无） | Registry 键，**非** bindless 下标 | P1–P2 |
| emissiveFactor | 自发光 | P1+ |
| uvTransform* | 贴图变换（three/glTF 约定） | P1+ |

**flags 精神（母本）：** HAS_BASE_COLOR / NORMAL / ORM / EMISSIVE、ALPHA_TEST、DOUBLE_SIDED、UNLIT、RECEIVE/CAST_SHADOW → flags-and-masks。

**范围：** 先 opaque + alpha-test（hashed 方向）；透明 blend 后置——05-compatibility、M09/M11。

---

## 9. TextureRecord / Registry

| 母本约束 | 分册 |
|----------|------|
| **无真正 bindless** | ids.md；webgpu-browser-limits；06 texture-and-bindless |
| id ≠ 采样数组下标 | ids.md「TextureId≠采样下标」 |
| Registry：array / atlas / virtual / batches | records-fields §7 |

| 字段意图 | 含义 | 阶段 |
|----------|------|------|
| id | TextureId | P1 |
| width/height/format/mipCount | 描述 | P1 |
| samplerId | 采样器 | P1 |
| arrayLayer / atlasRect | 打包策略 | P1–P2 |
| virtualPageTableId | VT 预留 | 生产向 |

---

## 10. LightRecord

| 意图字段 | 阶段 |
|----------|------|
| type、方向/位置、色/强度、范围衰减 | P1 可极简；正式表随 M12 |
| shadow 索引 / flags、layer mask | P9 阴影集成加深 |

Lighting **不扫** three 灯对象列表为主路径——与 Instance 表纪律一致。

---

## 11. Frame / Camera 常量（非表行）

| 母本 / 分册意图 | 用途 | 阶段 |
|-----------------|------|------|
| viewProj / invViewProj | 绘制与重建 | P0–P1 |
| prevViewProj | 相机运动 / TAA | 预留 P1；严用 **P8** |
| camera position | 光照/SSR 等 | P1+ |
| jitter | TAA | **P8** |
| z 参数 / 分辨率 | 深度与全屏 | P0–P1 |
| 时间 / 帧号 | 动画与 stats | P0+ |
| 曝光等全局 | post | 随 M13 |

详见 frame-and-camera.md。

---

## 12. 中间列表与间接参数

| 结构 | 元素意图 | 阶段 |
|------|----------|------|
| VisibleInstanceList | instanceId（可选 LOD/排序键） | **P3** |
| MaybeInstanceList | instanceId 或 meshletId；可选原因位 | **P7** 向（P3 可省略） |
| VisibleMeshletList | meshlet 可见集 | **P4** |
| IndirectArgs | WebGPU indirect 布局计数 | P3+ 可选；Shade compaction 精神 |
| Counters | visible/maybe 原子计数 | **P3** |

Cull 集合语义 Visible / Maybe / Rejected → pass-contracts CullInstances；M08。

---

## 13. G-buffer / VB（对照索引，非 Phase 0–3 主路径）

| 产物 | 分册 | 阶段 |
|------|------|------|
| Visibility 纹理（instance/triangle/… id） | pass-contracts RasterVisibility | **P5** |
| GBuffer 成员（albedo/N/roughness/…） | gbuffer-layout | **P6** |
| Depth / Pyramid | M08 / M10 | Depth P5；Pyramid **P7** |

Phase 0–3 闭环用 **Baseline forward**，不依赖本节产物。

---

## 14. Bind group 分层意图

| 层（设计意图） | 典型内容 | 冻结状态 |
|----------------|----------|----------|
| Group 帧常量 | Camera / Frame | 意图 ✅；slot ❌ |
| Group 场景表 | Instance/Transform/… storage | 意图 ✅；slot ❌ |
| Group 材质/纹理策略 | Registry 视图、采样器 | 随无 bindless 策略 |
| Group pass 资源 | GBuffer、history、shadow | 随 Phase |

见 bind-group-layout.md；**本文不编号 binding。**

---

## 15. Phase 0–3 最小字段就绪矩阵

| 字段/表 | P0 | P1 | P2 | P3 |
|---------|----|----|----|-----|
| Frame 分辨率/帧号 | ● | ● | ● | ● |
| Camera viewProj | | ● | ● | ● |
| Material PBR 因子 + tex id | | ● | ● | ● |
| Mesh 顶点索引范围 | | ● | ● | ● |
| Instance 全字段 | | 可 CPU | **GPU 表** | ● |
| Transform.world | | 可 CPU | **GPU 表** | ● |
| Transform.prevWorld | | | 预留同值 | 预留 |
| Bounds world | | 可算 | **表** | **cull 读** |
| Texture 元数据 | | ● | ● | ● |
| VisibleInstance + Counter | | | | **●** |
| Meshlet* | | | | — |
| GBuffer / VB | | | | — |

● = 主路径需要；— = 本闭环不要求。

---

## 16. 与 ids / handle / store 的交界

| 主题 | 分册 | 母本关系 |
|------|------|----------|
| Id 稳定性、0 哨兵、分配权 | ids.md | 表行键 |
| three 对象 ↔ id | lite-handle.md | Adapter 桥，非 GPU 行内嵌 Object3D |
| freeList / 世代 | store-model.md | CPU 真源生命周期 |
| dirty 种类 | dirty-model.md | 驱动 UploadDirtyScene |
| 所有权 | ownership-and-lifetime.md | dispose / 丢设备 |

---

## 17. 明确不在本对照内冻结的内容

```txt
- 每个 struct 的 byte size / align / _pad 最终值
- WGSL @group @binding 号
- 矩阵行主序 vs 列主序的最终选择（母本用 vec4 行块作参照）
- Texture array 最大层数等平台数字（见 06-constraints）
```

这些进入实现或后续「layout freeze」文档时，必须 **反向不破坏** 本表「含义」列。

---

## 18. 变更规则

```txt
1. 含义变更 = 设计变更 → 同步 records-fields + 本对照 + 必要时 ADR
2. 仅改 padding/打包 = 实现变更 → 可不改本表含义
3. 新 Phase 加列 → 本表加行并标阶段，勿复用旧字段名装新语义
```
