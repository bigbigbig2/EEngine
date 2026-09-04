# Shading

## SHADE-SURFACE · Surface and material reconstruction

- Local owner/source: `GpuSurfaceAbi.ts`、`PackedMaterialResolvePass.ts`、`packed_material_resolve.ts`、velocity/debug owners。
- Upstream: OEngine VisibilityKey/Material records；Filmic Worlds deferred attribute interpolation reference。
- Revision: local ABI follows source version；external paper/reference has no copied source revision。
- Upstream source: <https://filmicworlds.com/blog/visibility-buffer-rendering-with-material-graphs/>。
- License: mathematical/reference use only；no expressive external source copied。
- Adoption: independent implementation of reconstruction invariants。
- Retained invariants: one visible-pixel resolve、barycentric interpolation、analytic gradients、material decode、normal/tangent frame、current-minus-previous internal-pixel velocity。
- OEngine/WebGPU differences: OEngine attachment formats、metadata bits and resource domains；legacy Scene can still produce Surface without metadata。
- Fallback/lifecycle: invalid key/material rejects visibly；singular previous transform invalidates motion instead of emitting non-finite velocity。
- Local validation: Surface ABI、packed material resolve、velocity、debug view and counter tests。

## SHADE-PBR · PBR, IBL and clustered direct lighting

- Local owner/source: `LightingFeature`、`LightClusterPass`、direct/IBL shaders and environment owners。
- Upstream: Google Filament <https://github.com/google/filament>；Khronos glTF Sample Viewer/Renderer；Clustered Deferred and Forward Shading paper。
- Revision: Filament `bdd01e82539938db70c60259e4e6c17bc2bdaba4`；Sample Viewer `f9fce9ee7bc62c5433d2a1bf84be229225c7bd19`；Sample Renderer `863b981fb755359063e370ff7b6e956bda0716e2`。
- Upstream source: Filament `shaders/src/surface_brdf.fs`、`surface_shading_lit.fs`、`libs/ibl/src/CubemapIBL.cpp`；Sample Renderer `source/Renderer/shaders/ibl.glsl`、`brdf.glsl`。
- License: Filament/Khronos Apache-2.0；clustered-lighting paper is reference only。
- Adoption: mathematical/numeric authority; OEngine-authored WGSL and resource ownership。
- Retained invariants: metallic/roughness PBR、working-linear HDR、GGX、split-sum LUT、separate specular radiance/diffuse irradiance、bounded screen/depth light clusters。
- OEngine/WebGPU differences: octahedral environment resources and paged LightDatabase；不采用 native descriptors、renderer/thread/allocator ownership。
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
- Local validation: temporal/history/velocity/classification tests and Rendering Lab camera sequences。

## SHADE-AO · GTAO ambient occlusion

- Local owner/source: `AOService`、AO passes and OEngine-authored `ssao.ts` WGSL。
- Upstream: Intel GameTechDev XeGTAO <https://github.com/GameTechDev/XeGTAO>；Jimenez et al. GTAO paper。
- Revision: XeGTAO `0d177ce06bfa642f64d8af4de1197ad1bcb862d4`。
- Upstream source: `Source/Rendering/Shaders/XeGTAO.hlsli`、`Source/Rendering/Shaders/XeGTAO.h`。
- License: SPDX-License-Identifier: MIT；paper is mathematical reference only。
- Adoption: 保留并修复当前实现；algorithm-invariant reference，未直接复制外部 HLSL/WGSL。
- Retained invariants: depth position reconstruction、horizon slices/steps、view-depth screen radius、low-discrepancy sampling、bent normal and edge-aware filter。
- OEngine/WebGPU differences: full/half raw path resolves to full `AmbientOcclusionFrame` and shares temporal invalidation；不采用 D3D owner、UAV layout、FP16 macros or autotune chain。
- Fallback/lifecycle: invalid history weight is zero；feature-off prunes raw/spatial/temporal resources and histories。
- Local validation: `r5-fx07-ambient-occlusion.test.mjs`、half/full、temporal off/on and debug views。

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
- Retained invariants: one `resolveOpaqueLighting` entry、Brick4/LPV/IBL explicit mode、diffuse/specular baseline and shared Surface interpretation。
- OEngine/WebGPU differences: Renderer pre-imports ResourceId；GIService owns provider selection/fallback but not external resource creation。
- Fallback/lifecycle: unavailable static/dynamic provider falls back to IBL baseline；owners are lazy and retire through Feature lifecycle。
- Local validation: GI provider composition、fallback、feature-off and indirect-lighting tests。
