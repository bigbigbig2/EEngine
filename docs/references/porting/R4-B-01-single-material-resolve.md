# R4-B-01 · Single Material Resolve

Status: integrated / browser gate passed

## Reference ID

`R4-B-01-single-material-resolve`

## Primary local sources

```text
R2-D-08-packed-material-reconstruction.md
  decision: adopt/port verified local implementation
  scope: barycentric, analytic gradients, decode, normal/tangent frame

R2-D-09-packed-velocity.md
  decision: adopt/port verified local implementation
  scope: previous_from_current, singular fallback, velocity reference

R3-01-hierarchical-work-generation.md
  decision: adopt local ABI
  scope: RasterWork and VisibleCluster lookup
```

R4-B 不重新编写上述数学；迁移时保持原 reference tests，并增加 R4-A key lookup cases。

## External authorities

### Filmic Worlds / Deferred Attribute Interpolation

```text
URL: https://filmicworlds.com/blog/visibility-buffer-rendering-with-material-graphs/
paper: https://doi.org/10.1145/2790060.2790066
decision: reimplement mathematical invariants
scope: visibility shading and analytic derivatives
```

### The Forge

```text
repository: https://github.com/ConfettiFX/The-Forge
commit: cd5046893faba2dc7869243873bf01f02a6f0df9
license: Apache-2.0
decision: port structure/invariants / reject native descriptor and command model
source/example paths:
  Examples_3/Visibility_Buffer/src/Visibility_Buffer.cpp
  Examples_3/Visibility_Buffer/Shaders/ (actual adopted files must be pinned in code task)
```

采用 single visible-pixel shading、triangle/material lookup 与 workload organization；“texture arrays”按 native descriptor/resource array 理解，不直接翻译成 WebGPU `texture_2d_array`。

### Falcor

```text
repository: https://github.com/NVIDIAGameWorks/Falcor
commit: eb540f6748774680ce0039aaf3ac9279266ec521
license: NVIDIA BSD-style redistribution terms
decision: reference/reimplement scene/material abstraction
scope: material/scene lookup and validation organization
```

实际复制表达性代码前必须在任务提交中补具体源码/测试区段和 retained notice；DXR、native bindless 和 D3D runtime 拒绝采用。

### glTF / Filament / Sample Viewer / three.js

```text
glTF 2.0: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
  decision: implement material field semantics to specification

KHR_materials_unlit:
  https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_materials_unlit
  decision: implement extension semantics to specification
  retained invariant: baseColor/vertex color/alpha remain authoritative; lighting and other PBR inputs do not contribute

Filament: https://github.com/google/filament
  commit: bdd01e82539938db70c60259e4e6c17bc2bdaba4
  license: Apache-2.0
  source paths:
    shaders/src/surface_brdf.fs
    shaders/src/surface_shading_model_standard.fs
    shaders/src/surface_shading_lit.fs
    shaders/src/surface_shading_parameters.fs
    libs/ibl/src/CubemapIBL.cpp
  decision: PBR/IBL numeric and color-space reference; adopted function/line region pinned before code port

glTF Sample Viewer: https://github.com/KhronosGroup/glTF-Sample-Viewer
  commit: f9fce9ee7bc62c5433d2a1bf84be229225c7bd19
  license: Apache-2.0
  renderer submodule: KhronosGroup/glTF-Sample-Renderer
  renderer commit: 863b981fb755359063e370ff7b6e956bda0716e2
  renderer license: Apache-2.0
  source paths:
    source/Renderer/shaders/brdf.glsl
    source/Renderer/shaders/ibl.glsl
    source/Renderer/shaders/material_info.glsl
    source/Renderer/shaders/pbr.frag
    source/Renderer/shaders/textures.glsl
    source/gltf/material.js
  decision: material/numeric/visual oracle; adopted function/line region pinned before code port

three.js local baseline
  commit: 7cda7e710d884827fc73ff1a3aa63270846513d7
  paths: examples/webgpu_compute_rasterizer.html
         examples/webgpu_compute_rasterizer_ibl.html
  license: MIT for three.js code; bundled asset licenses remain separate
  decision: minimum vertical feature/performance baseline
```

Filament/Sample Viewer 当前只作为 numeric/visual authority；没有在具体任务中登记采用函数/行区段和 retained notice 前不得复制其表达性代码。

## Input/output ABI

Input：R4-A `VisibilityKey + depth`、R3 RasterWork/VisibleCluster、Geometry/Instance/Meshlet streams、MaterialRecord、TextureRef、current/previous camera and instance data。

Logical output：

```text
baseColor + metallic
shadingNormal + perceptualRoughness
emissive + occlusion
surface/material flags
velocity + validity/reactive
```

Physical attachment formats 已由 `R4-B-04` 冻结为 26 B/pixel：PBR `rg8unorm`、normal `rgba16uint`、albedo/AO `rgba8unorm`、emissive `r32uint` RGBE9995、velocity `rg16float`、flags `r32uint`。旧 Packed material/velocity 链为 34 B/pixel，同分辨率节省 8 B/pixel。

## Retained invariants

- 一次 visible-pixel Resolve；active material 数不增加 fullscreen draw/dispatch。
- R2-D-08 perspective attributes 与 analytic `textureSampleGrad`。
- R2-D-09 禁止 per-pixel matrix inverse；singular/new/cut/LOD motion 明确 invalid/reactive。
- Material Visibility 与完整 MaterialRecord 只有一个 owner/无损映射。
- texture access 有明确 adapter 上限、fallback 和 resident bytes。
- glTF 拥有字段语义；BRDF/IBL 数值还需 Filament/Sample Viewer/three.js 对照。

## OEngine/WebGPU adaptation

- The Forge/Falcor native descriptors 改为有界 WebGPU TextureRef 与固定 binding/bank/atlas 候选。
- array-bank、atlas、fixed-bank 在 B/C 真实资产 benchmark 后选择，不凭 native “bindless array” 名称拍板。
- Render fullscreen 是 v1 默认候选；Compute 只有 format/带宽/profile 证明后替换。
- Shader Bin 和 Lighting fusion 延后到 universal Resolve profile 证明需要。

## Precision / semantic differences

- final depth 完全沿用 R4-A WebGPU raster contract；只对 attributes 做 reciprocal-W perspective correction。
- R2-D-08 analytic gradients 是 v1 authority；clipped/degenerate triangle 的保守 mip fallback 必须带 counter，不能冒充精确导数。
- Surface physical formats 已冻结为 26 B/pixel；normal 使用现有 `rgba16uint` 双 octahedral encoding，emissive 使用现有 `r32uint` RGBE9995，velocity 保留 `rg16float`，不在 R4-B 另造第二套 GBuffer codec。
- glTF 定义输入语义，Filament/Sample Viewer/three.js 用于 BRDF/IBL、颜色空间和视觉对照；允许实现结构不同，但容差、曝光和 tone mapping 条件必须固定。
- `MaterialRecord v2` 只保存一组共享 UV mapping；glTF 的每纹理 TextureInfo 先按规范解析 effective texCoord/transform，再要求 baseColor、normal、metallicRoughness/occlusion、emissive 完全一致。`KHR_texture_transform.texCoord` 覆盖 TextureInfo `texCoord`，仅支持 Geometry ABI 已提供的 UV0/UV1；不一致或超范围直接拒绝。
- CPU `StandardShadeMaterial.id` 不进入 GPU 地址语义。Material owner 分配 0..4095 dense resident slot，Packed instance 和 Visibility/Resolve 只传该 slot；引用归零后经 owning command 的 GPU completion fence 才回到 free-list。
- 物理 texture array 有 64 layers，但 layer 0 固定为 zero/fallback；只有 layer 1..63 可分配。Texture owner 对共享 `ShadeTexture` 引用计数，最后引用归零后保留 retiring layer，直到 owning command 的 GPU completion settle 才归还 free-list。
- glTF v2 不支持 separate occlusion texture：`occlusionTexture` 必须与 `metallicRoughnessTexture` 使用相同 texture index，否则在 residency 前拒绝。`normalTexture.scale` 直接进入 record 并缩放 tangent-space normal XY。
- Khronos Damaged Helmet 源资产使用 separate AO/MR；B benchmark 在计时前保留 AO.R 与 MR.GB，生成一张确定性 ORM Blob，并规范化两个 TextureInfo 到同一 index。这个 asset-boundary adapter 不改变 loader 的拒绝行为，也不进入 steady GPU frame。
- `KHR_materials_unlit` 只保留 baseColor factor/texture、vertex color 与 alpha 语义；OEngine Resolve 以 zero lit albedo + baseColor emissive 表达同一不变量，继续复用统一 tone-map/output。normal/ORM/emissive PBR texture 不驻留、不置 feature bit，也不贡献 shading。

## Performance hypothesis

删除 `activeMaterials × fullscreen pixels`，新增随机 Geometry/Material/Texture lookup 和 Surface bandwidth。材质 1→N sweep 必须证明 pass 数恒定，并报告 lookup/gradient/texture/PBR GPU time、bytes/pixel、resident/transient bytes 和 fallback。

## Fallback / failure behavior

- TextureRef/record invalid：debug counter + deterministic fallback material/texture。
- resident set 超 adapter limits：拒绝或拆分明确资源集，不恢复 per-material主链。
- 64-layer array 的可用容量是 63；layer 0 永不分配。texture stage overflow 在 upload/record write 前拒绝，stage abort 回滚 retain，retiring layer 在 GPU completion 前不可复用。
- per-texture UV mapping 不满足 v1 shared contract 或请求 `TEXCOORD_2+`：loader/packer 在 GPU work 前显式拒绝；不得选择错误 UV 或退化到 UV0。
- dense material slot 满：在纹理上传、record write、pass 编码前失败；stage abort 恢复引用/free-list，release slot 在 GPU completion 前保持 retiring 且不可复用。
- analytic gradient 不稳定：有 counter 的保守 LOD fallback。
- universal shader 分支成为热点：先 profile，再用少量 bounded bin；禁止每材质全屏。
- consumer 未迁移：旧链仅保留到对应任务，完成后直接删除，不保留无期限兼容层。

## Local tests/examples

```text
reuse R2-D-08 packed material reference cases
reuse R2-D-09 velocity reference cases
multi-Meshlet VisibilityKey lookup cases
MaterialRecord/TextureRef TS-WGSL ABI tests
1→N material scale benchmark
real glTF PBR/IBL screenshots and numeric/debug views
examples/r4-single-material-resolve
```

## Decision

`adopt/port` 已验证 R2 数学；`port/reimplement` The Forge 的 single-resolve 不变量；`implement to specification` glTF；`reference` Filament/Sample Viewer/three.js；`reject` native bindless、BDA、per-material fullscreen 和无证据 Shader Bin/fusion。

## Integrated result

2026-08-28 在 clean commit `4e1206bd8d32670fddf3c5659710b92e46888210` 完成实现与 Chrome 151 WebGPU Gate：

- `MaterialRecord v2` 为 128 B、16-byte 对齐的 Standard PBR ABI；R4-A alpha 与 R4-B shading 共用 `GpuMaterialVisibilityTable` 单 owner，无第二张 Material truth table。
- 2026-08-28 P1 修正让 Resolve 根据 `material_info.uv_set` 在 UV0/UV1 descriptor 间选择；glTF baseColor/normal/ORM/emissive 采用明确的 shared mapping contract，TextureInfo 或 `KHR_texture_transform` 分歧与 `TEXCOORD_2+` 在 residency 前拒绝。
- Material table 改为 4,096 个 dense resident slots：全局递增 `material.id` 不再决定 record offset，Packed Scene stage/patch 使用 material dictionary → resident slot 映射；共享材质引用计数、abort 回滚和 completion-safe free-list reuse 已由 Node tests 覆盖。
- 2026-08-30 follow-up 为 texture layer 增加共享 refcount、free-list、abort rollback 与 completion-safe retirement；Node tests 同时验证 layer 0 保留、retiring 期间不复用以及 completion 后实际 layer 编号复用。browser material evidence 升为 schema v4，Gate 要求 resident/retiring/free 总和为 63 且采集结束 retiring 为 0。
- Chrome focused UV1 fixture 已命中真实 `TEXCOORD_1` descriptor 并 `passed=true`：UV1 alpha case 为 38 pixels，shader/validation/uncaptured/device-lost diagnostics 全为 0。Benchmark B smoke 命中生产 Single Resolve，记录 1 active/4095 free material slots、4 resident textures、0 fallback、1 fullscreen draw 和 0 WebGPU diagnostics；artifact 在 `temp/r4-b/p1/`。该结果只证明本次运行正确性，不冒充 dirty/smoke 条件下的 clean full performance Gate。
- 纹理方案选择一个有界 `texture_2d_array`：64 physical layers、63 usable resident layers、`256×256`、9 mips、`rgba8unorm`，容量超限显式失败或 fallback；目标 adapter 的 `maxTextureArrayLayers=256`。B 实测 4 个 resident texture、texture/sampler fallback 均为 0，resident texture bytes 为 `22,369,536`。
- Single fullscreen Render Resolve 从 `VisibilityKey → RasterWork → VisibleCluster → Instance/Geometry/Meshlet/Material` 完成 production lookup，并复用 R2-D-08 analytic barycentric/gradient/frame 与 R2-D-09 `previous_from_current`；没有复制新的插值或 per-pixel inverse 实现。
- glTF metallic-roughness、base color、normal、occlusion、emissive 与 factors 按规范实现；separate occlusion 作为 v2 unsupported contract 显式拒绝，`normalTexture.scale` 已进入 record/normal decode。`KHR_materials_unlit` 按 Khronos extension 语义实现为 baseColor-only、lighting-independent Surface。Filament、Sample Viewer、three.js 只作为数值/视觉 authority。The Forge 只采用 single visible-pixel shading 的结构不变量；本任务没有复制任何上游表达性代码，因此无需新增 retained source notice。
- `R4-B-07` 未执行：B/C 没有要求额外 glTF extension，不为完整性提前加入 clearcoat 等字段。`R4-B-08` 未执行：当前 universal Resolve profile 没有证明 feature divergence 是 blocker，禁止无证据增加 Shader Bin。
- Packed Material Expand、material depth/triangle/instance auxiliary MRT 与 Packed Velocity producer/shader 已删除。普通 `Scene` 的公开 legacy `MaterialExpandPass/VelocityPass` 仍有真实 consumer，现为惰性创建且 Packed 帧零 owner/Pass/resource；最终类级删除归普通 Scene consumer 迁移与 `FX-12`，不伪装成全仓已删除。
- `GPU_COUNTER_SCHEMA_VERSION=4`，新增 gradient fallback、reactive 和 material feature pixel producers；B/C 的 invalid key、gradient fallback、reactive、texture/sampler fallback、overflow 与 WebGPU diagnostics 均为 0。

Gate artifact 位于 `temp/r4-b/full/`，不纳入 Git。B/C 都使用 `1280×720`、DPR 1、60 warm-up + 180 sample、每 6 帧 timestamp/counter；active material 从 1 增至 3 时 fullscreen draw 始终为 1。B Resolve P50/P95/P99 为 `1.559088/1.7152/2.05827136 ms`；C 为 `0.66336/0.6934896/0.69565568 ms`。相对 R4-A 旧链，B 因加入完整纹理采样和 velocity 从 P50 `1.02664 ms` 回退，不声明普遍提速；C 从 3 draws 降为 1 draw，P50 从 `0.75264 ms` 改善到 `0.66336 ms`，约 11.9%。
