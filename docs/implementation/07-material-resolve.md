# 07 · R5 单次 Standard PBR Material Resolve

## 阶段目标

用一次可见像素扫描替代当前“material depth + 每活跃材质一个全屏三角形”。Resolve 从统一 VisibilityKey 回查 VisibleCluster、Instance、Geometry、triangle attributes 和 MaterialTable，输出光照需要的紧凑 surface data 与 velocity。

## 非目标

- 不按材质数量重复扫描全屏。
- 不让每个材质拥有热路径 BindGroup/Pipeline。
- 不在 v1 建立通用 Shader Graph 或任意用户 WGSL。
- 不让纹理 residency 依赖 WebGPU baseline 不保证的 bindless descriptor。
- 不在 Material Resolve 内重新做 alpha test；alpha-tested visibility 必须已经正确 discard。

## 当前代码入口

| 当前入口 | 当前行为 | 目标处理 |
|---|---|---|
| `OEngine/src/render/passes/MaterialExpandPass.ts` | material depth 后遍历 scene materials，每项 `draw(3)` | 新 Resolve 接通后删除 |
| `OEngine/src/shaders/material_depth_oracle.ts`、`material_expand*.ts` | 旧 mesh/material GBuffer 逻辑 | 核对属性语义后删除/重写 |
| `OEngine/src/gpu/GPUMaterialContext.ts` | per-material pipeline/bind group | Standard PBR 改为 MaterialTable record |
| `GPUResidentMaterialContext.ts`、`GPUTextureManager.ts` | material/texture residency 来源 | 收口到 bounded texture pools |
| `StandardShadeMaterial.ts` | 当前 Standard 材质接口 | 映射到固定 PBR feature bits，逐步去历史命名 |
| `VelocityPass.ts` | 独立 velocity 路径 | opaque velocity 合并到 Resolve；特殊对象另列 |

## Resolve 数据流

```text
pixel(x, y)
  → VisibilityKey
  → visibleClusterSlot + localTriangle
  → VisibleClusterRecord
  → InstanceRecord + GeometryRecord + Meshlet/Cluster
  → triangle position/normal/tangent/UV/color
  → screen-space barycentric + perspective correction
  → materialSlot
  → MaterialRecord + resident texture pools
  → Surface buffers + Velocity + reactive/material flags
```

empty key 直接输出背景 sentinel，不访问 lookup table。每次回查都以 key、slot 和 range validation 为 debug 契约；release shader 避免昂贵分支，但 producer 必须保证合法。

## 属性重建

### Barycentric

Resolve 读取三角形 object positions，经 current instance transform 和 camera 投影到屏幕，按像素中心计算 barycentric，再做 perspective correction。final depth 用于 world/view position 重建和一致性检查，不把近似深度当作 triangle ID。

### Texture gradients

Fullscreen resolve 不能盲目对重建 UV 使用普通 implicit derivatives，因为相邻像素可能属于不同三角形。v1 计算当前三角形的解析屏幕 barycentric derivatives，得到 `dUVdx/dUVdy`，使用 `textureSampleGrad` 选择 mip。退化或 clip 边界无法稳定求导时使用保守显式 LOD 并增加 counter/debug view。

### Velocity

同一个 local triangle 使用 current/previous instance transform 和 current/previous camera 计算屏幕位置差。新增实例、无 previous、camera cut、LOD 对应不稳定时写 invalid/reactive 标记，不写巨大错误速度。LOD 切换通过 object/cluster 稳定信息和 reactive mask 处理时域权重。

## MaterialRecord v1 逻辑 ABI

| 字段组 | 字段 |
|---|---|
| base | baseColorFactor、metallic、roughness |
| normal/occlusion | normalScale、occlusionStrength |
| emissive | emissiveFactor、emissiveStrength |
| alpha | alphaCutoff；blend mode 已在 visibility/transparent path 分类 |
| extensions | unlit、clearcoat 等少量固定 feature bits 与参数 |
| texture refs | baseColor、normal、ORM、emissive、可选 extension refs |
| UV | uv set 与 TextureTransform table index |
| sampling | bounded sampler class；不存任意 GPUSampler/BindGroup |

目标 stride 初始预算为 96–128 bytes；`MAT-01` 必须根据实际字段给出 16-byte 对齐的 TypeScript/WGSL layout。没有使用的扩展数据可以放旁表，不能让少量 clearcoat 材质把所有 record 永久膨胀。

## WebGPU baseline texture residency

v1 使用有限、显式的 resident texture pool，不假设 bindless：

```text
BaseColorOpacityPool   sRGB texture_2d_array banks
NormalPool             linear texture_2d_array banks
OrmPool                linear texture_2d_array banks
EmissivePool           sRGB/linear policy fixed by cooker
SamplerClasses         bounded nearest/linear + wrap/clamp combinations
```

TextureRef 逻辑字段为 `poolClass/bank/layer/samplerClass/uvTransform`。Cooker 统一 format、mip policy 和 page size class；WGSL 绑定固定上限的 banks，并通过小型 switch 选择，不为每材质换 bind group。

限制与 fallback：

- bank 数、array layers、sampled texture bindings 和 sampler 数在 startup 与 package resident 时验证。
- 全驻留 v1 超过容量时明确拒绝/拆分场景资源集，不静默采样错误纹理。
- atlas 与 texture-array bank 必须在 `MAT-02` 用 B/C 比较 padding、mip、内存和分支成本；若更改默认方案需记录 ADR。
- texture streaming/page fault 属于后续阶段；不得混入 v1 key/resolve 正确性。

## Surface output v1

逻辑输出必须至少包含：

```text
baseColor + metallic
shadingNormal + perceptualRoughness
emissive + occlusion
surface/material flags
velocity + validity/reactive
```

候选物理布局：

| Attachment | 候选格式 | 内容 |
|---|---|---|
| Surface0 | `rgba8unorm` | baseColor RGB + metallic |
| Surface1 | `rgba16float` | encoded/xyz normal + roughness |
| Surface2 | `rgba16float` | emissive RGB + occlusion |
| SurfaceFlags | `r32uint` 或可验证的 packed channel | unlit/clearcoat/reactive 等 |
| Velocity | `rg16float` | motion vector |

`MAT-04` 必须验证目标浏览器 attachment/storage 支持、精度和带宽后冻结。允许更紧凑布局或 resolve-lighting fusion，但不能因此恢复每材质扫描，也不能让 AO/SSR/TAA 各自重新重建同一表面。

首版优先使用一次 fullscreen Render Pass：它能自然写多个 color attachments 并使用纹理采样；Compute Resolve 只有在 storage formats、写带宽和 dispatch 数据证明更好时替换，输出契约不变。

## Producer/consumer 与生命周期

- Producer：Cooker/MaterialRegistry 生成 MaterialRecord/TextureRef；ResidencyManager 上传；Visibility 生成 key/depth。
- Consumer：Material Resolve；后续 Lighting、AO、SSR、TAA、Transparency composite 和 debug。
- MaterialTable owner：GPU Render World；texture pool owner：ResidencyManager。
- Surface outputs：FrameGraph transient；Velocity/history inputs 按 view 拥有。
- feature off：若没有任何 consumer，FrameGraph 裁掉对应 Surface channel；不能固定分配最大 GBuffer。

## 执行任务

### MAT-01 · 冻结 Standard PBR schema

列出 B/C 所需 glTF PBR 字段、feature bits、旁表和 fallback。生成 TypeScript/WGSL offsets、encode/decode、默认材质与 invalid texture tests。

### MAT-02 · 冻结纹理池方案

用真实 B/C 资产比较 texture array banks 与 atlas：resident bytes、mip/padding、upload、sampling、binding limits 和画质。选择 WebGPU baseline v1，写入 capability validation。

### MAT-03 · 最小 debug resolve

从 VisibilityKey 回查并输出 instance/cluster/triangle/material debug color；覆盖 empty/invalid/max key 和 SW/HW 同结果。

### MAT-04 · 属性、梯度与 surface layout

实现 position/normal/tangent/UV/color、analytic gradients、normal mapping 与候选 outputs。用 CPU/reference raster 小图和 B 画质金标冻结布局。

### MAT-05 · Standard PBR 单次 Resolve

接入 factors、四类主纹理、unlit/emissive/alpha-tested surface 语义。一个 fullscreen pass 扫描可见像素，active material 数不增加 draw 数。

### MAT-06 · Velocity 合并

opaque velocity 在 Resolve 输出；处理 previous transform/camera、new object、LOD switch、camera cut 和 reactive mask。确认独立 `VelocityPass` 是否只剩特殊 consumer。

### MAT-07 · 少量 extension feature bits

按 benchmark/画质需求逐项加入 clearcoat 等扩展。每项必须有 record 成本、shader branch、texture pool 和 off 成本证据；不一次移植全部旧材质分支。

### MAT-08 · Shader Bin 边界原型

只为 Standard PBR 无法表达的少量固定类别验证 bin 方案。bin 数有硬上限，工作只扫描该 bin 的像素/tiles；禁止材质数 × 全屏。未证明需要时不进入主链。

### MAT-09 · 迁移 consumers

Lighting/AO/SSR/TAA/debug 改读新 Surface/Velocity。每迁移一个 consumer，删除其对旧 GBuffer/material depth 的依赖。

### MAT-10 · 删除 Material Expand

删除 `MaterialExpandPass`、material depth texture、per-material fullscreen pipeline/bind group、无 consumer shader 和旧 opaque Velocity pass。材质 registry 只保留资产/API 语义与新 table residency。

## Counters 与 debug views

记录 visible/empty pixels、invalid key/lookup、active material、texture pool/bank/layer 使用、fallback texture、gradient fallback、各 feature-bit 像素、Resolve bandwidth estimate 与 GPU time。

Debug views：material ID、base/normal/roughness/metallic/AO/emissive、mip/gradient、texture pool bank、velocity/reactive、invalid lookup。

## 验收

### 正确性

- CPU/reference 小图验证 barycentric、透视、gradient、normal mapping 和 velocity。
- HW/SW/Hybrid 对同一可见像素输出相同 surface。
- B 的 PBR/IBL 输入属性与 three.js 基线逐项对齐；色彩空间、normal convention、roughness/metallic 不靠目测猜。
- camera cut、new object、LOD switch、resize 和 device lost 的 velocity/history 标记正确。

### 性能

- Resolve draw/dispatch 数不随 active material 数增长。
- C 场景从 1 到 N materials 的 GPU 时间只反映真实纹理/分支/cache 变化，不再是 N 次全屏扫描。
- 报告旧/new attachments 字节每像素、transient 峰值、纹理 resident bytes 和 GPU time。
- feature/channel off 后对应 attachment 和 shader 工作被 graph 裁掉。

## 回退与失败条件

- 纹理池超过 baseline limits：拒绝 resident 或缩小明确资源集；不恢复 per-material bind group 主链。
- analytic gradient 画质失败：修正导数/clip/LOD fallback；暂时固定更保守 mip 只作为可见调试回退。
- 单次通用 shader 分支过重：按少量有界 Shader Bin/feature permutation 分流，但每个 bin 只处理其工作集合。
- surface 带宽仍过高：先量化 channel consumer，再压缩、半精度或 fusion；不无证据删除高画质必需数据。

## 阶段退出

Standard PBR/IBL 主路径只做一次可见像素 Resolve，纹理 residency 在 WebGPU baseline 有明确上限和错误行为，旧 material depth/每材质全屏链删除；B/C 画质和材质缩放性能通过 gate。更新 shading/gpu-world/asset Context、ADR（若 texture/layout 成为长期决策）和 `CURRENT-STATE`。
