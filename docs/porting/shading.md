# Shading

## SHADE-SURFACE · Surface and material reconstruction

- Local owner/source: `GpuComputeMaterialAbi.ts`、`GpuHdrAbi.ts`、`PackedMaterialResolvePass.ts`、`packed_material_compute.ts`、velocity/debug owners。
- Upstream: OEngine VisibilityKey/Material records；Filmic Worlds deferred attribute interpolation reference。
- Revision: local ABI follows source version；external paper/reference has no copied source revision。
- Upstream source: <https://filmicworlds.com/blog/visibility-buffer-rendering-with-material-graphs/>。
- License: mathematical/reference use only；no expressive external source copied。
- Adoption: independent implementation of reconstruction invariants。
- Retained invariants: one visible-pixel resolve、barycentric interpolation、analytic gradients、material decode、normal/tangent frame、current-minus-previous internal-pixel velocity。
- OEngine/WebGPU differences: production ABI is the named compact 20 B/pixel working set plus consumer-driven 4 B velocity；metadata/PBR/emissive share `rg32uint`，MaterialId debug dereferences VisibilityKey/MeshletWork instead of storing a per-pixel slot；there is no Surface V1 conversion attachment or legacy Scene Surface producer。
- Fallback/lifecycle: invalid key/material rejects visibly；singular previous transform invalidates motion instead of emitting non-finite velocity。
- Local validation: compact ABI pack/unpack、static velocity-off/on shader interfaces、packed material resolve、debug view/counters、full Surface Chrome fixture and Rendering Lab base/full profiles。

## SHADE-TEXTURE-RESIDENCY · Bounded TextureRef size-class banks

- Local owner/source: `GpuTextureRefAbi.ts`、`TextureResidency.ts`、Packed Surface/Transparency/Visibility/CSM consumers and validation oracle。
- Upstream: W3C WebGPU/WGSL specifications；Google Filament texture/resource lifecycle as an ownership reference <https://github.com/google/filament>。
- Revision: WebGPU/WGSL living standards checked 2026-09-09；Filament `bdd01e82539938db70c60259e4e6c17bc2bdaba4`。
- Upstream source: WebGPU limits/bind-group/texture-array contracts；Filament `filament/src/details/Texture.cpp`、`filament/include/filament/Texture.h` and `libs/gltfio/src/ResourceLoader.cpp`。
- License: W3C specification reference；Filament Apache-2.0。
- Adoption: `OEngine-authored-policy`；没有复制外部表达性代码。局部策略 benchmark 比较了 five bounded size-class banks 与 stable-TextureRef migrating high bank；后者虽在 2 GiB hard budget 内，但相同排列下需要 704 MiB final allocation、725–1045 MiB growth peak、更多且随顺序变化的 resize/copy，因此拒绝。
- Retained invariants: explicit device limits、source texture identity deduplication、full mip chains、transactional publish/abort and queue-completion retirement。
- OEngine/WebGPU differences: ABI v1 使用 `version[31:28] / bank[27:24] / layer[23:0]`；五个显式 `texture_2d_array` binding，不使用 binding array、descriptor indexing、MDI、64-bit atomics 或非基线能力。逻辑 class 固定为 256/512/1024/2048/4096，质量/device resolution cap 只降低 physical resolution，不减少 logical texture count。
- Capacity/lifecycle: 每个 bank 保留 layer 0 fallback，最大 layers 为 64/32/16/32/2；base bank 随 owner 创建，其他 bank lazy allocate，低成本 bank 按 power-of-two、高成本 bank 按实际需求增长；2 GiB hard transaction-peak budget 覆盖 policy-cap 内最坏旧/新 bank 共存，固定产品 workload 实测 peak 为 603979656 bytes。容量、budget 与 device overflow 均在 mutation 前检查，abort 回滚 provisional refs/resources，commit 后等待 queue completion 再销毁旧 bank。
- Cost: Packed sampling增加有界 five-way bank branch 与五个 sampled-texture bindings；未增加 Pass、production readback 或 submit。候选 benchmark artifact 为 `OEngine/benchmarks/texture-residency-policy.json`。
- Local validation: 120 个同集合排列、512↔2048、多批小后大、各 bank exact fill/+1 overflow、release/reuse、duplicate refs、growth allocation fault/abort、quality/device cap；真实 Chrome `surface.texture-ref-oracle`、`surface.textured`、`surface.texture-fallback`、`surface.transparent` 和 alpha-tested `visibility.shadow`。

## SHADE-PBR · PBR, IBL and clustered direct lighting

- Local owner/source: `LightingFeature`、`LightClusterPass`、direct/IBL shaders and environment owners。
- Upstream: Google Filament <https://github.com/google/filament>；Khronos glTF Sample Viewer/Renderer；Clustered Deferred and Forward Shading paper。
- Revision: Filament `bdd01e82539938db70c60259e4e6c17bc2bdaba4`；Sample Viewer `f9fce9ee7bc62c5433d2a1bf84be229225c7bd19`；Sample Renderer `863b981fb755359063e370ff7b6e956bda0716e2`。
- Upstream source: Filament `shaders/src/surface_brdf.fs`、`surface_shading_lit.fs`、`libs/ibl/src/CubemapIBL.cpp`；Sample Renderer `source/Renderer/shaders/ibl.glsl`、`brdf.glsl`。
- License: Filament/Khronos Apache-2.0；clustered-lighting paper is reference only。
- Adoption: mathematical/numeric authority; OEngine-authored WGSL and resource ownership。
- Retained invariants: metallic/roughness PBR、working-linear HDR、GGX、split-sum LUT、separate specular radiance/diffuse irradiance、bounded screen/depth light clusters。
- OEngine/WebGPU differences: octahedral environment resources and paged LightDatabase；IBL/Probe Volume 以 OEngine-authored fused baseline pass 合成 diffuse、energy compensation、environment specular 与 bent-normal occlusion，SSR consumer 存在时才启用第二个 baseline-specular MRT；不采用 native descriptors、renderer/thread/allocator ownership。
- Fallback/lifecycle: unavailable environment uses declared baseline；cluster overflow is counted；disabled lighting resources are pruned where allowed。
- Local validation: BRDF/IBL numerical tests、cluster list/counter tests、Rendering Lab lighting/debug views。

## SHADE-CSM · Cascaded shadows

- Local owner/source: `ShadowContract.ts`、packed CSM/pass/feature owners and `ShadowVisibilityFrame`。
- Upstream: Microsoft DirectX-SDK-Samples <https://github.com/microsoft/DirectX-SDK-Samples>；three.js <https://github.com/mrdoob/three.js>。
- Revision: DirectX `07e3eaa10e7dd026ec9d95fe326db2d5c4227e1b`；three.js `7cda7e710d884827fc73ff1a3aa63270846513d7`。
- Upstream source: `C++/Direct3D11/CascadedShadowMaps11/CascadedShadowsManager.cpp`、`.h`、`.hlsl`；three.js `examples/jsm/csm/CSMShadowNode.js`。
- License: DirectX-SDK-Samples — license: MIT；three.js — license: MIT。
- Adoption: port cascade-fit/stabilization and practical-split invariants; reimplement WebGPU owner。
- Retained invariants: camera frustum slices、light-space orthographic fit、texel snapping、explicit depth/slope/normal bias and atlas viewport isolation。
- OEngine/WebGPU differences: Packed hierarchy selects casters and GPU indirect consumer records draws；不依赖 MDI、mesh shader、64-bit atomic，也不复制 CPU scene traversal。
- Fallback/lifecycle: feature-off retires atlas/owners；invalid capacity is counted/fail-visible；three cascades and filter contract come from local ABI。
- Scope exclusions: Packed point/spot shadow 保持未支持；legacy non-Packed Scene 暂保留原 ShadowRaster consumer。
- Local validation: `packed-csm-shadow.test.mjs`、shadow contract/counter/debug and Rendering Lab。

## SHADE-OIT · Packed MBOIT transparency

- Local owner/source: `TransparencyFeature`、`PackedTransparentOitPass`、MBOIT WGSL and reactive output。
- Upstream: Moment-Based Order-Independent Transparency <https://momentsingraphics.de/I3D2018.html>。
- Revision: official archive SHA-256 `3A09C53B232908B356633D7BC1D9D651AE502E9A73E4E161527A73305B55C1FC`；upstream has no Git commit。
- Upstream source: `MomentOIT.hlsli`、`MomentMath.hlsli`、`ComplexAlgebra.hlsli`、`TrigonometricMomentMath.hlsli`。
- License: CC0 according to the author distribution page。
- Adoption: port mathematical invariants; independently reimplement WebGPU queue/resource owner。
- Retained invariants: optical absorbance、four power moments、Hankel/Cholesky resolve、bounded bias/overestimation and conservative non-finite failure。
- OEngine/WebGPU differences: Packed hierarchy and fixed 16 B indirect drive raster；no A-buffer、PPLL、unbounded fragment pool、CPU material loop or per-material draw。
- Fallback/lifecycle: degenerate resolve returns bounded total transmittance；feature-off creates no moment/history/counter resources；legacy `TransparentOitPass` remains migration debt。
- Local validation: transparency math/oracle、queue overflow、reactive/counter and feature-off tests。

## SHADE-TEMPORAL · Temporal and upscale

- Local owner/source: `TemporalFeature`、temporal passes/shaders、`TemporalHistoryRegistry` and `TemporalSurfaceFrame`。
- Upstream: Playdead temporal <https://github.com/playdeadgames/temporal>；AMD FidelityFX FSR2 <https://github.com/GPUOpen-Effects/FidelityFX-FSR2>；Brian Karis TAA reference。
- Revision: Playdead `4795aa0007d464371abe60b7b28a1cf893a4e349`；FSR2 v2.2.1 `1680d1edd5c034f88ebbbb793d8b88f8842cf804`。
- Upstream source: Playdead `Assets/Shaders/TemporalReprojection.shader`、`VelocityBuffer.shader`；FSR2 `src/ffx-fsr2-api/shaders/ffx_fsr2_reproject.h`、`ffx_fsr2_accumulate.h`、`ffx_fsr2_depth_clip.h`。
- License: MIT for Playdead; license: MIT for FSR2；presentation material is reference only。
- Adoption: port integration/algorithm invariants; independent WGSL owner; FX-06B includes OEngine upscale-quality work, not a direct FSR2 shader port。
- Retained invariants: jitter、motion reprojection、neighborhood/history clamp、reactive/disocclusion、render/output resolution separation、submitted-history commit and cut/resize reset。
- OEngine/WebGPU differences: current-minus-previous internal-pixel velocity、OEngine FrameGraph/history slots；不采用 Unity components、DX/Vulkan backend、wave/FP16 recipe or direct dependency。
- Fallback/lifecycle: invalid motion/history forces current-frame result；abort、resize、scale、camera cut、feature toggle invalidate affected histories。
- Completion claim: Q05 的 clean/full provenance 与整帧性能仍未闭环，不能由本记录提前宣称完成；Sharpen 保持在独立 Post owner。
- Local validation: temporal/history/velocity/classification tests and Rendering Lab camera sequences。

## SHADE-AO · GTAO ambient occlusion

- Local owner/source: `AOService`、`GtaoPass.ts`、`gtao.ts` and `AmbientOcclusionFrame`；旧 `ScreenSpaceAmbientOcclusionPass.ts`/`ssao.ts` owner 已删除。
- Upstream: three.js <https://github.com/mrdoob/three.js>；Activision/Jimenez et al. GTAO equation is reached through the pinned implementation's own reference trail。
- Revision: three.js `148ef33ecb6d2502ff796d4554abd1549c95d519`（r186）。此前 XeGTAO `0d177ce06bfa642f64d8af4de1197ad1bcb862d4` reference 状态已由本 production replacement 取代，不再拥有 runtime path。
- Upstream source: `examples/jsm/tsl/display/GTAONode.js` and `examples/webgpu_postprocessing_ao.html` at the pinned revision。
- License: three.js MIT；本地文件保留来源/revision，本记录承担移植追溯。
- Adoption: `traceable-local-port`。horizon/slice integration、3/5 direction selection、quadratic ray stepping、5×5 magic-square spatial rotation、六帧 temporal rotation、四帧 spatial offset、view-space thickness、squared distance falloff 与 Activision Eq. 7 由上游表达翻译为 OEngine WGSL；不是 three.js runtime dependency。
- Retained invariants: reverse-projected position、双向 horizon search、projected-normal weighting、world-space radius、view-space thickness gate、stochastic direction/step distribution and scalar ambient visibility。
- OEngine/WebGPU differences: 不移植 TSL、NodeMaterial、QuadMesh、three.js `RenderTarget`、`builtinAOContext` 或额外 `TRAANode` owner。Raw trace 读取 OEngine reverse-Z Depth、shared HZB 与 compact world normal；同一 horizon producer 扩展 world-space bent normal。AO/second moment/oct bent-normal 打包进 half-resolution `rgba16float`，空间与时域阶段共同滤波三者，最终唯一 joint depth/normal resolve 拆成 full-resolution `r8unorm` visibility + `rg16uint` bent normal，供 OEngine indirect diffuse/specular-occlusion consumer 使用。
- Cost/quality policy: high 默认 3 directions × 6 bidirectional steps（36 depth samples/GTAO pixel）at half resolution；medium 为 3×4，ultra 为 full-resolution 5×6。此档位只改变同一 producer 的预算，不形成第二条 AO 管线。无独立 noise texture、旧 bent-normal pass、额外 full-frame TRAA 或额外 submit。
- Fallback/lifecycle: velocity、motion/reactive/disocclusion 与 history generation 控制 temporal weight；invalid/reprojected-outside history 回退当前帧。`mode=off`/feature-off 退役 `GtaoPass` 两张 history，裁剪 linear-depth/raw/spatial/temporal/evidence/joint-resolve pass、全部 GTAO transient 和 counter dispatch。
- Local validation: `advanced-frame-abi.test.mjs` 固定上游分布/厚度/衰减/Eq.7 和 packed temporal ABI；真实 Chrome `surface.gtao-replacement` 检查 production graph、单 trace、history footprint、one-submit、feature-off、薄几何/边缘观察 artifact 与 GPU diagnostics；Rendering Lab 综合 profile 检查稳定帧 history accepted/rejected counter 和 GPU phase。

## SHADE-SSR · Screen-space reflections

- Local owner/source: `ReflectionService`、SSR trace/prefilter/resolve/denoise and shared indirect composite。
- Upstream: AMD FidelityFX SSSR candidate。
- Revision: no upstream revision adopted; local authored implementation was revalidated before replacement consideration。
- Upstream source: FidelityFX SSSR source was not imported。
- License: MIT for the candidate。
- Adoption: `retained-current-authored`; FidelityFX SSSR is `not adopted` unless correctness/quality/performance requires replacement and a pinned record is added。
- Retained invariants: main HZB、Surface roughness/normal、velocity、submission-aware history、environment/IBL miss fallback and shared indirect composite。
- OEngine/WebGPU differences: current shaders and resource ownership are OEngine-authored；no FidelityFX expression-level port or native backend。
- Fallback/lifecycle: miss keeps declared environment baseline；off prunes SSR passes、histories and debug resources。
- Local validation: `r5-fx08-screen-space-reflections.test.mjs`、hit/miss、roughness、offscreen、history and feature-off cases；replacement must first revalidate current path。

## SHADE-SSGI · Screen-space diffuse GI and ambient visibility

- Local owner/source: `ScreenSpaceDiffuseService`、`SsgiPass.ts`、`ssgi.ts`、`ScreenSpaceDiffuseResolvePass.ts` and the conditional `DiffuseSurfaceLite`/pre-SSGI radiance products。
- Upstream: three.js <https://github.com/mrdoob/three.js>。
- Revision: three.js `148ef33ecb6d2502ff796d4554abd1549c95d519`（r186）。
- Upstream source: `examples/jsm/tsl/display/SSGINode.js` and `examples/webgpu_postprocessing_ssgi.html` at the pinned revision。
- License: three.js MIT；本地 shader 文件保留 source/revision，本记录承担表达级移植追溯。
- Adoption: `traceable-local-port`。保留 32-zone horizon bitfield、hemisphere slice/双向 step、quadratic near-field stepping、六帧 temporal rotation、四帧 spatial offset、radius/thickness、backface-lighting control、newly-occluded-zone radiance weighting、AO/GI dual output 与 luminance/firefly bound；不是 three.js runtime dependency。
- OEngine/WebGPU differences: 不移植 TSL、NodeMaterial、QuadMesh、three.js RenderTarget 或独立 `TRAANode`。输入是 OEngine full-resolution、working-linear、pre-exposed `PreExposedOpaqueRadianceSource`，并读取 shared reverse-Z Depth/HZB、compact world normal、Velocity、surface validity 和 shared occlusion confidence。当前半分辨率 trace 写 `rgba16float AO/second-moment/oct-bent + rgba16float incident-GI/confidence`，joint spatial/temporal filter 后一次 full-resolution bilateral resolve 拆成 `r8unorm + rg16uint + rgba16float + r8unorm`。
- Composition invariant: source 明确位于当前帧 SSGI 之前；`ScreenSpaceDiffuseResolve` 只替换 long-range diffuse 与 baseline specular 的 screen-visibility 部分，并对 incident diffuse GI 使用 receiver diffuse reflectance、metalness energy remainder 与 Material AO 恰好一次。Direct、emissive、unlit 不乘 screen AO；SSR 存在时 baseline specular 保持到 Reflection correction owner 再替换，避免双重 subtract。
- Provider selection: producer texture alpha 已表达逐 receiver validity，但当前迁移态仍由 `indirect_lighting_mode` 在 scene/frame 级选择 Brick4 或 Probe Volume；有效 receiver 使用所选 producer，无效 receiver 在同一 lighting resolve 内回退 IBL。它不会把多个 full-screen provider 相加，但还没有实现同一 frame 的 `valid Brick4 > valid Probe Volume > IBL` 完整 receiver chain。现有 GPU counters 只证明所选 producer/IBL 的互斥归属，不能冒充完整 precedence 证据。
- Cost/quality policy: medium `1×12` half-resolution、high `2×8` half-resolution、ultra `3×16` full-resolution；每档仍是同一 producer。四张 history texture 仅在 `mode=ssgi && temporalEnabled` 存在。`mode=gtao` 时 SSGI owner、radiance-source dependency、component MRT、resolve、history 和 counter dispatch 均不存在；`mode=ssgi` 时 GTAO owner/history 全部退役。
- Fallback/lifecycle: background/invalid depth、退化 normal 或无有效 horizon 使用 input normal、visibility 1、GI/confidence 0；history 由 `TemporalHistoryRegistry` 在 camera cut、resize、render-scale、lighting、view、format、feature toggle 与 aborted submit 时失效。公开配置只有 `screenSpaceDiffuseMode: off | gtao | ssgi`，不保留互相矛盾的 GTAO/SSGI 双布尔。
- Local validation: `surface.ssgi-production` 固定 production graph、pinned revision、exclusive owner、source-before-resolve、history/provider counter closure 和 one-submit；正式综合性能仍必须使用唯一 `comprehensive-full` workload 产生 Step 5 clean artifact 后才能宣称完成。

## SHADE-GRADING · HDR color grading

- Local owner/source: `PostFeature`、`ColorGradingPass`、`OEngine/src/shaders/color_grading.ts`。
- Upstream: Google Filament <https://github.com/google/filament>。
- Revision: use the Filament revision pinned by SHADE-PBR when revalidating shared math。
- Upstream source: `filament/src/filament/ColorGrading.cpp`、`filament/src/shaders/color_grading.fs`。
- License: Apache-2.0; source header SPDX-License-Identifier: Apache-2.0。
- Adoption: algorithm-invariant reference; authored WGSL, no direct shader port。
- Retained invariants: linear HDR before tone mapping、ASC-CDL-like lift/gamma/gain、Rec.709 saturation and log2 contrast。
- OEngine/WebGPU differences: single fullscreen pass without 3D LUT bake；identity defaults preserve pixels。
- Fallback/lifecycle: PostFeature owns lazy creation/destruction；non-finite parameters are rejected/normalized by local settings contract。
- Local validation: color-grading numerical/order/lifecycle tests。

## SHADE-GI · GI provider composition

- Local owner/source: `GIService`、Brick4、LPV、IBL baseline and `OpaqueLightingResolvePass`。
- Upstream: Filament IBL math from SHADE-PBR；Brick4/LPV composition is OEngine-authored。
- Revision: Filament `bdd01e82539938db70c60259e4e6c17bc2bdaba4`；no additional external source copied。
- Upstream source: Filament `surface_light_indirect.fs` and `CubemapIBL.cpp` for baseline invariants。
- License: Apache-2.0 for Filament reference；local composition authored by OEngine。
- Adoption: compose existing providers; no external composition source copied。
- Retained invariants: one `resolveOpaqueLighting` entry、receiver-validity provider selection、materialized pre-SSGI diffuse/specular components only when demanded、shared Surface interpretation and non-additive long-range authority。
- OEngine/WebGPU differences: Renderer pre-imports ResourceId；GIService owns provider selection/fallback and screen-space diffuse energy resolve but not external resource creation。Brick4/Probe raw provider alpha carries per-receiver validity；SSGI topology forces the otherwise-fused baseline to expose temporary resolved components。
- Fallback/lifecycle: 当前 scene/frame policy 选择一个 static/dynamic producer；invalid receiver falls through to IBL in the same resolve。Brick4 invalid 后继续尝试 Probe Volume、以及 IBL unavailable 后进入 black，仍是 Step 5 的开放实现项。Owners are lazy and retire through Feature lifecycle；`mode!=ssgi` 不创建 SSGI-only component MRT。
- Local validation: GI provider composition、fallback、feature-off and indirect-lighting tests。
