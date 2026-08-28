# R4-B-01 · Single Material Resolve

Status: source freeze / implementation pending

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

Physical attachment formats 由 `R4-B-04` 依据 format capability、精度与带宽冻结。

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
- Surface physical formats 尚未冻结；半精度、normal packing、emissive range 和 velocity precision 由 `R4-B-04` 数值误差与带宽测试决定。
- glTF 定义输入语义，Filament/Sample Viewer/three.js 用于 BRDF/IBL、颜色空间和视觉对照；允许实现结构不同，但容差、曝光和 tone mapping 条件必须固定。

## Performance hypothesis

删除 `activeMaterials × fullscreen pixels`，新增随机 Geometry/Material/Texture lookup 和 Surface bandwidth。材质 1→N sweep 必须证明 pass 数恒定，并报告 lookup/gradient/texture/PBR GPU time、bytes/pixel、resident/transient bytes 和 fallback。

## Fallback / failure behavior

- TextureRef/record invalid：debug counter + deterministic fallback material/texture。
- resident set 超 adapter limits：拒绝或拆分明确资源集，不恢复 per-material主链。
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
