# R5-01 · Surface Lighting / FX-03 IBL Alignment

Status: implementation complete; clean production Gate is the closure authority.

## Reference ID

`R5-01-surface-lighting`

## Authorities and licenses

### Google Filament

```text
repository: https://github.com/google/filament
commit: bdd01e82539938db70c60259e4e6c17bc2bdaba4
license: Apache-2.0
source paths:
  libs/ibl/src/CubemapIBL.cpp
  shaders/src/surface_light_indirect.fs
  shaders/src/surface_brdf.fs
decision: port mathematical invariants; reimplement WebGPU owner and octahedral storage
```

保留的不变量是 Hammersley sequence、GGX/Trowbridge-Reitz importance sampling、
perceptual roughness 与 linear roughness 的区分、独立 cosine-weighted diffuse
irradiance、split-sum LUT 和 scene-referred working-linear 语义。未复制 Filament 的
cubemap/GL/Vulkan descriptor、allocator、线程和离线工具结构。

### Khronos glTF Sample Viewer / Sample Renderer

```text
viewer repository: https://github.com/KhronosGroup/glTF-Sample-Viewer
viewer commit: f9fce9ee7bc62c5433d2a1bf84be229225c7bd19
renderer repository: https://github.com/KhronosGroup/glTF-Sample-Renderer
renderer commit: 863b981fb755359063e370ff7b6e956bda0716e2
license: Apache-2.0
source paths:
  source/Renderer/shaders/ibl.glsl
  source/Renderer/shaders/brdf.glsl
  source/ResourceLoader/resource_loader.js
decision: numeric/material semantic cross-check; no runtime dependency
```

Sample Renderer 用于交叉检查 Lambertian diffuse environment、GGX specular
environment、BRDF LUT、metallic/roughness 与环境方向约定。OEngine 不采用其
WebGL binding、cubemap owner 或资源加载生命周期。

### three.js baseline

```text
workspace revision: 7cda7e710d884827fc73ff1a3aa63270846513d7
paths:
  examples/webgpu_compute_rasterizer.html
  examples/webgpu_compute_rasterizer_ibl.html
decision: minimum vertical visual/performance baseline only
```

`three.js/` 不是 OEngine runtime dependency，FX-03 没有修改该 gitlink，也不把通过
两个示例当作产品上限。

## Scope and ownership

```text
ShadeTexture working-linear HDR octahedral base mip
  -> GPULightCollection (lifetime / allocation owner)
     -> GGX specular rgba16float mip chain
     -> cosine-convolved rgba16float diffuse irradiance
  -> IblSpecularPass / IblDiffusePass
  -> split-sum IndirectCompositePass
  -> working-linear rgba16float scene HDR
```

`GPULightCollection` 独立持有 specular 与 diffuse texture。环境 identity 改变时，
`EnvironmentPrefilterPass` 在同一个外部 frame command context 中编码一次；稳定帧
不重新卷积、不私有 submit、不 readback。Loader 临时对象不是 GPU owner。

## Input/output ABI and color contract

- 输入为 `rgba16float`、octahedral、working-linear、scene-referred radiance。
- Specular 输出为完整 mip chain；mip 0 保留输入，mip `i` 的 perceptual roughness
  为 `i / (mipCount - 1)`。
- Diffuse 输出为 32×32 单 mip irradiance integral；`IndirectCompositePass` 使用
  `diffuseColor * irradiance * 1/PI`，禁止重复或遗漏 π。
- Runtime roughness 从 Surface ABI v1 `PBR.g` 读取，使用 `textureNumLevels()` 动态
  映射，不假设 5 mip。
- BRDF LUT 继续使用现有 split-sum asset；本次没有把 LUT generation 搬进稳定帧。
- Tonemap/exposure 只属于最终 output owner；FX-03 数值 oracle 在 output transform 前验证。

## WebGPU/OEngine adaptation

- 使用 2D octahedral texture 而不是 cubemap，保留 seam-aware 手写 bilinear wrap。
- Compute workgroup 为 8×8；specular 每 texel 128 samples，diffuse 256 samples。
- 每个 roughness mip 都从原始 base environment 采样，不递归读取上一 mip。
- WebGPU 不生成 mip；每个 storage mip view 由 owner 显式写入。
- uniform 为 16 B：roughness、sample count、source resolution、padding。
- `rgba16float` 不依赖 `float32-filterable`；consumer 使用 `textureLoad` 手写双线性。
- 1×1 环境合法：specular 只有 mip 0，diffuse 仍独立生成；consumer upper mip clamp
  保证不越界。

## Precision and semantic differences

OEngine 的 runtime prefilter 没有移植 Filament 的 cubemap solid-angle mip bias；当前固定
64×64 benchmark environment 与 128 samples 先关闭方向、粗糙度和能量契约。更大 HDR
输入的 sample-count/solid-angle A/B 属于后续画质/性能调优，不允许改回递归 cone blur。
半精度存储允许小量量化误差；GPU constant-HDR oracle 的 specular 容差为 0.02，diffuse
为 0.04。

## Evidence and counters

GPU counter schema v6 新增：

```text
iblSampledPixels
iblMip0 .. iblMip7
iblMip8  // mip >= 8 overflow bin
```

`PackedSurfaceCounterPass` 只存在于 profiler sampled frame，并复用已有 Surface counter
扫描；非采样帧没有额外 Pass/atomic/readback。每个有效且非 Unlit pixel 根据 Surface
perceptual roughness 和真实 environment mip count 进入一个 dominant-mip bin。

CPU frame counters同时记录：

```text
lighting.environment.specularAllocatedBytes
lighting.environment.diffuseAllocatedBytes
lighting.environment.specularMipLevelCount
gpu.residentBytes
```

纹理 footprint 已修正为“所有 mip texel × bytes/sample × samples”；2D array layer 不随
mip 缩小，只有 3D texture 的 depth 缩小。

## Performance hypothesis

- 环境卷积只在环境改变时执行，因此稳定帧成本是两个 fullscreen IBL consumer 与
  split-sum composite，不是逐 mip prefilter。
- 独立 32×32 diffuse 增加 8,192 B，但删除“roughness=1 specular mip × π”错误近似。
- 64×64 seven-mip specular chain 为 43,688 B；benchmark 不再用只有一个 texel却读取
  五个 mip 的无效输入。
- sampled histogram 用来判断后续是否需要 size class/streaming；FX-03 不预先引入
  streaming owner。

## Fallback and failure behavior

- 无环境 image：沿用 `requireShadeImage` 的显式失败，不生成伪环境。
- mip count 为 1：LOD 固定 0，upper mip clamp 到 0。
- GPU counter 非采样帧：字段 absent，不解释为真实零。
- validation/uncaptured/device-loss、counter missing、histogram sum 不等于 sampled pixels、
  provenance mismatch 或截图无变化均使 browser Gate 失败。
- Environment loader 不再在正常加载时触发浏览器下载副作用。

## Local tests and production Gate

```text
OEngine/tests/r5-ibl-alignment.test.mjs
examples/benchmark-shared/recipes/fx03-environment.json
examples/r5-shading-oracle/
examples/scripts/run-r5-fx03-gate.mjs
```

自动测试覆盖动态 LOD、perceptual/linear roughness、Hammersley、oct orientation、
constant diffuse irradiance、sun direction loader、shader source、counter ABI、所有 mip
显存计算、debug topology 与无下载副作用。浏览器页面使用生产 Renderer、单个 Damaged
Helmet、零 direct light、冻结 64×64 linear HDR environment；保存 Surface、Diffuse IBL、
Specular IBL、Linear HDR visualisation 和 Final Tonemapped，并直接运行 production
prefilter WGSL 的 constant-HDR GPU numeric readback。

## Decision

`port` Filament 的 IBL 数学不变量；`reference` Khronos 的 glTF material/IBL 语义；
`reimplement` OEngine/WebGPU 的 octahedral texture owner、FrameGraph consumer 与证据；
`reject` 固定 5 mip、递归前一 mip cone blur、diffuse 复用 specular 最粗 mip、稳定帧
prefilter/readback 和未登记的表达性代码复制。
