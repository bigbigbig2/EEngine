# 07 · R4-B 单次 Standard PBR Material Resolve

## 阶段目标

用一次可见像素扫描替代当前“material depth + 每活跃材质一个全屏三角形”。Resolve 从 R4-A `VisibilityKey v1` 回查 R3 RasterWork、VisibleCluster、Instance、Geometry、Meshlet triangle 和 MaterialTable，输出光照与时域需要的紧凑 surface/velocity。

本阶段依赖 R4-A Hardware Visibility Contract，不依赖 R4-C Software Raster。HW-only 必须先形成完整 Standard PBR/IBL 闭环；以后 SW/HW 只替换 key/depth producer，不复制 Resolve。

长期边界见 [ADR-0010](../wiki/adr/0010-r4-unified-visibility-contract.md)，算法来源见 [R4 research guide](../references/R4-ALGORITHM-GUIDE.md) 与 [R4-B porting ledger](../references/porting/R4-B-01-single-material-resolve.md)。

## 实施状态

`R4-B-01..06`、`R4-B-09` 已于 2026-08-28 集成，`R4-B-07/08` 按条件任务跳过，Packed 范围的 `R4-B-10` 已关闭。生产 Packed 主链现在只写 `VisibilityKey + depth`，随后由一次 `PackedMaterialResolvePass` 输出 Standard PBR Surface 与 velocity；active material 数不再增加 fullscreen draw。

冻结结果：`MaterialRecord v2` 为 128 B；有界纹理 residency 为 64-layer、`256×256`、9-mip `texture_2d_array`，其中 layer 0 固定为 deterministic fallback，layer 1..63 是 63 个可驻留层；Surface 为 26 B/pixel；`GPU_COUNTER_SCHEMA_VERSION=4`。Packed Material Expand、Packed Velocity 与旧 auxiliary MRT 已删除。普通 `Scene` 的 legacy `MaterialExpandPass/VelocityPass` 因仍有公开 consumer 而保留为惰性路径，Packed 帧不创建其 owner、Pass 或资源，最终类级删除归 `FX-12`。

## 非目标

- 不按材质数量重复全屏。
- 不让每个材质拥有热路径 BindGroup/Pipeline。
- 不在 v1 建立通用 Shader Graph、任意用户 WGSL 或无界 Shader Bin。
- 不假设 WebGPU baseline 有无限 bindless descriptor。
- 不在 Resolve 重新决定 alpha coverage；R4-A 已完成 mask discard。
- 不把 Texture Streaming、Virtual Texture、Lighting fusion 当作 v1 前置。

## 当前事实与删除对象

| 当前入口 | 已有价值 | R4-B 处理 |
|---|---|---|
| `PackedMaterialExpandPass`/packed material shader | 已有 Packed triangle attribute reconstruction | 迁移数学到 Single Resolve，删除逐材质全屏 consumer |
| `MaterialExpandPass` 与 material depth | 旧 Scene 画面 oracle | consumers 迁移后删除 |
| `GPUMaterialContext`/per-material bind group | API/资产语义 | Standard PBR 热路径改为 GPU MaterialTable |
| `GPUResidentMaterialContext`/`GPUTextureManager` | 现有 residency 能力 | 收口为有界 texture owner，不复制长期 owner |
| `PackedVelocityPass` | 已验证 motion 语义 | 合并 opaque velocity，删除重复 fullscreen path |
| R2-D-08/R2-D-09 tests | barycentric/gradient/frame/velocity oracle | 必须复用并扩展，不能重新实现一套未经验证数学 |

## Resolve lookup

```text
pixel(x, y)
→ VisibilityKey(rasterWorkSlot, localTriangle)
→ RasterWork[rasterWorkSlot]
→ visibleClusterSlot + meshletRecordIndex
→ VisibleCluster[visibleClusterSlot]
→ InstanceRecord + GeometryRecord
→ Meshlet triangle indices + vertex streams
→ screen barycentric + perspective-correct attributes
→ material handle
→ MaterialRecord + bounded TextureRef
→ Surface outputs + Velocity + validity/reactive flags
```

empty key 直接输出 background sentinel，不访问 table。debug/validation Shader 对每一层做 range check 并记录具体 failure；release 依赖 producer 已验证 ABI，不用昂贵 per-pixel 全链防御掩盖 producer bug。

## 必须迁移的本地数学

### Attribute reconstruction

以 [R2-D-08](../references/porting/R2-D-08-packed-material-reconstruction.md) 为首要实现来源：

- 从 object triangle current clip positions 计算屏幕 barycentric。
- UV、position、normal、tangent/color 做 reciprocal-W perspective correction。
- fullscreen 相邻像素可能跨三角形，不对重建 UV 使用 implicit derivatives。
- 使用解析 barycentric gradient 产生 `dUVdx/dUVdy`，通过 `textureSampleGrad` 选 mip。
- normalized integer decode、non-uniform/mirrored transform normal/tangent frame 保持已有 reference 语义。
- clip/degenerate 无法稳定求导时走有 counter 的保守 LOD fallback。

R4-A final depth 用于一致性检查和 world/view position 辅助重建，不当 Triangle ID，也不重新应用“perspective-correct depth”。

### Velocity

以 [R2-D-09](../references/porting/R2-D-09-packed-velocity.md) 为首要实现来源：

- 使用 CPU/Instance ABI 已预计算的 `previous_from_current`，禁止 per-pixel `mat4_inverse`。
- current/previous instance 和 current/previous camera 计算同一 surface point 的屏幕运动。
- new instance、singular transform、camera cut、missing previous 与不稳定 LOD 对应写 invalid/reactive，不输出 NaN/巨大速度。
- Temporal consumer 只在 validity 成立时信任 velocity。

## Material Visibility 与 MaterialRecord

R4-A 的 `MaterialVisibilityRecord` 是完整 record 的前缀、旁表或无损投影，只有一个 owner：

```text
R4-A visibility fields
alphaMode / alphaCutoff / doubleSided
baseColorFactorAlpha / alpha TextureRef
uvSet / uvTransform / samplerClass

R4-B shading fields
baseColor RGB / metallic / perceptualRoughness
normalScale / occlusionStrength
emissiveFactor / emissiveStrength
unlit / bounded extension feature bits
normal / ORM / emissive / extension TextureRef
```

`R4-B-01` 根据 B/C 真实资产冻结 16-byte 对齐的 TS/WGSL layout、默认值、invalid handle 和旁表边界。初始 stride 预算只能作为测量输入，不能为了满足预设 96/128 B 丢字段或制造隐式 owner。

glTF 2.0 冻结字段语义；Filament、glTF Sample Viewer 和 three.js IBL baseline 冻结颜色空间、normal convention、BRDF/IBL 与可见画面对照。不能只凭肉眼猜 roughness/metallic 或曝光差异。

### MaterialRecord v2 UV contract

- 当前 128 B record 只有一组 `uvSet + scale/rotation/offset`，由 baseColor、normal、ORM、emissive 共享；这是一条显式 v1 限制，不代表 glTF 的每纹理 UV 语义已完整实现。
- glTF loader 按 baseColor → normal → metallicRoughness/occlusion → emissive 归一化有效映射；`KHR_texture_transform.texCoord` 覆盖 TextureInfo `texCoord`，缺失 transform 归一化为 identity。
- 只接受 `TEXCOORD_0/1`。任一已使用纹理的 texCoord、offset、scale 或 rotation 与共享映射不同，必须在进入 GPU residency 前明确拒绝，禁止静默按 baseColor UV 采样其它纹理。
- Packed Material Resolve 根据 `MaterialRecord.uv_set` 选择 Geometry GPU ABI 的 UV0/UV1 descriptor，并保持同一套 analytic `dUVdx/dUVdy` 与 `textureSampleGrad` 路径。
- 后续若真实 B/C 资产要求 per-texture mapping，必须先扩展并重新冻结 MaterialRecord/TextureRef ABI、resident bytes、lookup/branch 成本和浏览器 Gate；不能在 Shader 中增加未登记旁表。
- `occlusionTexture` v2 只允许与 `metallicRoughnessTexture` 共用同一个 glTF texture index；没有 metallic-roughness texture 或使用 separate occlusion texture 都在 loader 阶段显式拒绝，不能警告后继续采错通道。

## WebGPU 有界纹理访问

候选而非预设答案：

```text
1. format/size-class texture_2d_array banks
2. padded atlas + explicit mip policy
3. 少量固定 texture bindings/banks + bounded switch
```

统一逻辑 `TextureRef` 至少包含：

```text
poolClass / bank-or-page / layer-or-rect
samplerClass / uvTransform / colorSpace
invalid/fallback state
```

`R4-B-02` 必须用真实 B/C 资产比较：

- adapter sampled texture/sampler/array-layer limits；
- resample、format/size class、mip 和 atlas padding 画质；
- upload/resident bytes 与 fragmentation；
- WGSL switch/branch、cache 和 sampling GPU time；
- R4-A alpha 与 R4-B shading 是否共用 owner；
- over-capacity 是拒绝、拆分 resident set 还是明确 fallback。

The Forge 的 native descriptor/resource arrays 只提供组织参考，不能直接当作 WebGPU `texture_2d_array` 实现。v1 全驻留超过明确上限时拒绝或缩小资源集，不静默采错纹理，也不恢复 per-material bind group 主链。

当前 texture owner 的 lifecycle contract：

- 同一 `ShadeTexture` 在多个 MaterialRecord 间共享一个 layer，并由引用计数持有；材质换纹理时先 retain 新层，旧层绑定到本次 owning command 的完成点释放。
- 最后引用释放后 layer 进入 retiring；在对应 `gpuDone` settle 前既不能归还 free-list，也不能被其它纹理覆盖。重新 retain 会用 generation 取消旧退休回调。
- stage abort 回滚本次新增 retain、材质到纹理集合和 free-list；owner 不创建 private submit/readback。
- evidence schema v4 同时报告 resident/retiring/free material slots 与 resident/retiring/free texture layers；恒等式为 `resident + retiring + free = 63`，物理 layer 0 不计入 free-list。

## Surface output v1

逻辑输出：

```text
baseColor + metallic
shadingNormal + perceptualRoughness
emissive + occlusion
surface/material flags
velocity + validity/reactive
```

物理布局已由 `R4-B-04` 冻结：

| Attachment | 格式 | 内容 |
|---|---|---|
| PBR | `rg8unorm` | metallic + perceptual roughness |
| Normal | `rgba16uint` | shading + geometric normal 的双 octahedral encoding |
| Albedo/AO | `rgba8unorm` | base color + occlusion |
| Emissive | `r32uint` | RGBE9995 emissive |
| SurfaceFlags | `r32uint` | valid/motion/reactive/gradient 与材质 feature bits |
| Velocity | `rg16float` | motion |

合计 26 B/pixel，已在目标 adapter 核对 renderability 与 bytes/pixel。FrameGraph 只在 Packed Resolve consumer 存在时创建整组 Surface；更细粒度 channel pruning 留给真实 consumer profile，不提前复制第二套 attachment contract。

首版优先一次 fullscreen Render Pass，因为可自然写多个 color attachments 并采样纹理；Compute Resolve 必须在 storage-format、写带宽和 GPU time 证明更好后替换。两者共享同一逻辑输出契约。

## PBR/IBL authority

R4-B v1 至少冻结：

- metallic-roughness input mapping；
- sRGB/linear decode 与 emissive policy；
- tangent-space normal convention；
- GGX D、Smith-correlated V、Fresnel F；
- diffuse/specular IBL 与 environment prefilter/BRDF LUT；
- exposure、tone mapping 与 screenshot compare 条件。

优先复用 OEngine 已有 lighting/IBL 函数中有来源和测试的区段；新增或替换数学从 Filament/glTF Sample Viewer/three.js 固定 commit 路由并登记。glTF 规范只拥有材质语义，不单独拥有 BRDF 数值实现。

## Producer、consumer 与 owner

- Cooker/MaterialRegistry 产生 device-independent material/texture metadata。
- GPU Asset/Material Table owner 上传 MaterialRecord；Texture residency module 独占 texture bank/atlas 和 handle 生命周期。
- `StandardShadeMaterial.id` 只表示 CPU/runtime 身份，不得直接作为 GPU MaterialTable 下标。`GpuMaterialVisibilityTable` 为 active resident material 分配有界 dense slot，并由 Packed Scene 把 material dictionary index 映射为 instance `material_handle`。
- dense slot 使用引用计数和 free-list；stage abort 回滚，最后引用 release 后先进入 retiring，只有 owning command 已提交且 GPU completion 成立后才允许复用。Packed Scene material patch 接收 dictionary `materialIndices`，不接受全局 `material.id` 或裸 GPU slot。
- Visibility 只产生 key/depth，不拥有完整 shading material。
- Material Resolve 产生 transient Surface/Velocity；Lighting、AO、SSR、TAA、debug 是 consumers。
- 无 consumer 的 Surface channel和 feature 必须从 FrameGraph、resource allocation 和 Shader work 中裁掉。

## R4-B 执行任务

### R4-B-01 · 来源与 Standard PBR schema

- 完成 [R4-B porting ledger](../references/porting/R4-B-01-single-material-resolve.md)。
- 冻结 MaterialVisibility 到 MaterialRecord 的单 owner 映射、feature bits、旁表、default/invalid。
- 生成 TS/WGSL layout/offset/stride 和 encode/decode tests。

### R4-B-02 · TextureRef 与有界 residency

- 用 B/C 资产完成 array-bank/atlas/fixed-bank benchmark。
- 冻结 TextureRef、sampler classes、color-space、mip 和 over-capacity behavior。
- alpha 和 shading 共用 texture owner；feature off 不创建无消费者 bank。

### R4-B-03 · Single debug Resolve

- 从 R4-A key 走完整 lookup，一次输出 instance/cluster/meshlet/triangle/material debug color。
- 覆盖 empty/invalid/max key、multi-Meshlet Cluster 和真实 Damaged Helmet fixture。
- draw/dispatch 数不随 active material 数增长。

### R4-B-04 · 属性、gradient 与 Surface layout

- 迁移 R2-D-08，不重写另一套 barycentric/gradient/frame。
- 用 CPU reference 小图和 B visual gold 验证 position/normal/tangent/UV/color/normal map。
- 冻结 physical Surface formats、precision、bytes/pixel 和 gradient fallback。

### R4-B-05 · Standard PBR/IBL Single Resolve

- 接 factors、baseColor/normal/ORM/emissive、unlit 与 alpha-tested surface 语义。
- `normalTexture.scale` 写入 `MaterialRecord.normalScale` 并只缩放 tangent-space normal 的 XY；默认值为 1。
- `KHR_materials_unlit` 仅消费 baseColor factor/texture、vertex color 与 alpha；Resolve 将其写为零 lit albedo + baseColor emissive，并保留统一 tone-map/output consumer。normal/ORM/emissive PBR 纹理不进入 residency、feature bits 或采样分支。
- 对齐 glTF、Filament/Sample Viewer 和 three.js B baseline 的颜色空间、BRDF/IBL 输入输出。
- 一次 visible-pixel pass；active material 增长不增加 fullscreen pass。

### R4-B-06 · Velocity 合并

- 迁移 R2-D-09 `previous_from_current` 和 singular fallback。
- 覆盖 previous camera/transform、new object、camera cut、LOD switch 和 reactive mask。
- 确认独立 Packed/opaque Velocity consumer 无剩余调用后删除。

### R4-B-07 · 有证据的少量 extension

按目标资产逐项增加 clearcoat 等 glTF extension。每项登记 record/texture/branch/off cost；未进入 B/C 的扩展不为“完整性”提前加入。

### R4-B-08 · Shader Bin 条件原型

只有 universal shader profile 显示 feature divergence 是热点才执行。bin 数有硬上限，只处理该 bin 的像素/tile/work list；禁止恢复 `materials × fullscreen`。

### R4-B-09 · Consumer 迁移

Lighting/AO/SSR/TAA/debug 逐个改读新 Surface/Velocity。每迁移一个 consumer，删除其旧 material depth/GBuffer/velocity 依赖并验证 feature-off。

### R4-B-10 · 删除旧 Material Expand

删除 `MaterialExpandPass`、Packed Material Expand、material depth texture、per-material fullscreen pipeline/bind group、无消费者 shader 和旧 opaque Velocity pass。Material registry 只保留资产/API 语义与新 GPU table residency。

交付边界：Packed production chain 已删除 Packed Material Expand、material depth/triangle/instance auxiliary MRT、per-material fullscreen consumer 与 Packed Velocity；普通 `Scene` 仍真实使用 legacy 类，因此本阶段不按类名误删。legacy 实例改为按普通 Scene 请求惰性创建，对 Packed feature 为零成本；类级删除截止为普通 Scene consumer 迁移与 `FX-12`。

## 交付证据

- clean commit：`4e1206bd8d32670fddf3c5659710b92e46888210`；Chrome 151、NVIDIA Turing、`1280×720`、DPR 1、60 warm-up + 180 sample、每 6 帧 timestamp/counter。
- B/C Gate 均 `passed=true`、issues/counter issues/WebGPU diagnostics 为 0；一个 main submit、一个 Packed Hardware drawIndirect、一个 fullscreen Resolve。
- material sweep：active materials `1 → 3`，fullscreen draw 恒为 1。B Resolve P50/P95/P99 `1.559088/1.7152/2.05827136 ms`；C `0.66336/0.6934896/0.69565568 ms`。
- Surface 从旧链 34 B/pixel 降为 26 B/pixel，1280×720 每帧少 `7,372,800` transient bytes。B texture owner 分配 `22,893,824` B，其中 resident texture `22,369,536` B，4 个纹理且 fallback 为 0。
- B 保存 final-color 与 12 个 debug screenshots，13/13 hash 唯一；C 为 12/13，重合项是合法零值 view。final-color 非黑像素分别为 `806,587/923,601` 与 `910,154/923,601`。
- R4-A 旧链 B/C Material Expand P50 为 `1.02664/0.75264 ms`。新 B 包含完整纹理采样与 velocity，回退到 `1.559088 ms`；新 C 把 3 draws 收为 1 draw，并改善约 11.9%。这证明结构伸缩性，不声明所有场景绝对更快。
- artifact 位于 `temp/r4-b/full/`，不纳入 Git；shader audit 为 69 total、58 authored-live、5 dead、6 unknown。
- 2026-08-28 P1 UV/dense-slot 修正另有 `temp/r4-b/p1/` focused 证据：Chrome UV1 fixture `passed=true`，生产 Benchmark B smoke 为 1 Resolve draw、1 active/4095 free material slots、4 resident textures、0 fallback/0 WebGPU diagnostics。该 dirty smoke 仅作 correctness evidence，不替代上面的 clean full Gate。
- 2026-08-30 lifecycle/material-contract 修正加入 texture refcount/free-list/completion-safe retirement、evidence schema v4、separate occlusion explicit reject、`normalTexture.scale` 与真实 unlit Resolve；本条提交后的 clean B/C full Gate 必须重新采集，不能沿用 2026-08-28 artifact 证明这些新增语义。
- 原始 Damaged Helmet B fixture 使用 separate AO 与 metallic-roughness 图片；为保持 loader 的 explicit reject，benchmark 在计时前按 glTF ORM 通道约定把 `AO.R + roughness.G + metallic.B` 确定性打包到同一 Blob，并让两个 TextureInfo 指向同一 index。该步骤属于 benchmark/runtime-asset 准备，不进入 steady frame、Material owner 或第二条渲染路径。

`R4-B-07` 跳过，因为 B/C 目标资产不要求额外 glTF extension；`R4-B-08` 跳过，因为 universal Resolve profile 未证明 feature divergence 是热点。二者都没有被伪装成“实现了空功能”。

## Counters 与 debug

至少记录：visible/empty pixels、invalid lookup layer、active materials、texture pools/banks/pages/layers、fallback texture、gradient fallback、feature-bit pixels、Surface bytes/pixel、transient peak、resident texture bytes、Resolve GPU P50/P95/P99。

Debug views：lookup layer、material ID、base/normal/roughness/metallic/AO/emissive、mip/gradient、texture pool、velocity/reactive、invalid/fallback。

## Gate G4-B

### 正确性

- R2-D-08/09 的 reference cases 全部继续通过，并补 multi-Meshlet key lookup。
- B 的 PBR/IBL 输入、颜色空间、normal convention、roughness/metallic 与固定 authorities 对齐。
- camera cut/new object/LOD switch/resize/device lost 的 velocity/history flags 正确。
- 浏览器真实 glTF 截图、debug view 和 WebGPU diagnostics 通过；不能只跑 TypeScript tests。

### 性能与内存

- Resolve draw/dispatch 数不随 active material 数增长。
- 材质 1→N sweep 只反映真实 texture/cache/branch 工作，不再出现 N 次全屏。
- 报告 old/new attachment bytes、transient peak、texture resident bytes、lookup/gradient/texture/PBR GPU time。
- feature/channel off 后相关资源、Pass 和 Shader work 被裁掉。
- B 与 two three.js examples 的对照只是最低垂直基线；C 继续验证多资产、Packed Instances、多材质、alpha、内存和扩展曲线。

## 回退与失败

- Texture residency 超 baseline limits：明确拒绝/拆分 resident set；不恢复 per-material bind group 主链。
- Analytic gradient 画质失败：修正数学/clip/LOD fallback；保守 mip 只能作为带 counter 的临时回退。
- Universal shader 分支过重：先给出 profile，再使用少量 bounded bin；不得按材质全屏。
- Surface 带宽过高：先量化 consumers，再压缩/半精度/fusion；不得无证据删掉画质或时域必需数据。
- 新 Resolve 未覆盖 consumer：旧链只保留到对应 `R4-B-09` 迁移完成，不建立无截止兼容层。

## 阶段退出

Standard PBR/IBL 主路径只做一次可见像素 Resolve；Material/Texture owner、capacity、fallback 和 feature-off 明确；旧 material depth/逐材质全屏/Packed Velocity 链删除；B/C 画质、材质扩展性能与浏览器 Gate 通过。R4-B 关闭后才进入 R4-C。
