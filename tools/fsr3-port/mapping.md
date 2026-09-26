# FSR3 source mapping

The mapping is anchored to the original SDK host order in
`upstream/sdk/src/components/fsr3upscaler/ffx_fsr3upscaler.cpp`. The ten
algorithm stages remain separate even where the SDK schedules helper functions
inside one dispatch.

| Algorithm stage | Upstream entry / implementation | SDK host scheduling | EEngine production owner |
| --- | --- | --- | --- |
| Prepare Inputs | `PrepareInputs` in `ffx_fsr3upscaler_prepare_inputs.h`; HLSL/GLSL `prepare_inputs_pass` | `PREPARE_INPUTS` | `Fsr3PrepareInputsPass.ts` |
| Prepare Reactivity | `PrepareReactivity` plus disocclusion, divergence and thin feature tests in `ffx_fsr3upscaler_prepare_reactivity.h` | `PREPARE_REACTIVITY` | `Fsr3PrepareReactivityPass.ts` |
| Luma Pyramid | `ComputeAutoExposure` and the included SPD luminance reduction in `ffx_fsr3upscaler_luma_pyramid.h` | `LUMA_PYRAMID` | `Fsr3LumaPyramidPass.ts` |
| Shading Change | `ShadingChange` in `ffx_fsr3upscaler_shading_change.h` | `SHADING_CHANGE` | `Fsr3ShadingChangePass.ts` |
| Shading Change Pyramid | `ComputeShadingChangePyramid` in `ffx_fsr3upscaler_shading_change_pyramid.h`, using SPD | `SHADING_CHANGE_PYRAMID` | `Fsr3ShadingChangePyramidPass.ts` |
| Reproject | `ComputeReprojectedUVs` and `ReprojectHistoryColor` in `ffx_fsr3upscaler_reproject.h` | internal to `ACCUMULATE` | `Fsr3AccumulateShader.ts` |
| Accumulate | `Accumulate` and `ComputeBaseAccumulationWeight` in `ffx_fsr3upscaler_accumulate.h` | `ACCUMULATE` or mutually exclusive `ACCUMULATE_SHARPEN` | `Fsr3AccumulatePass.ts`, `Fsr3AccumulateShader.ts` |
| Upsample | `ComputeUpsampledColorAndWeight` and its Lanczos/sample helpers in `ffx_fsr3upscaler_upsample.h` | internal to `ACCUMULATE` | `Fsr3AccumulateShader.ts` |
| Luma Instability | `LumaInstability` in `ffx_fsr3upscaler_luma_instability.h` | `LUMA_INSTABILITY` | `Fsr3LumaInstabilityPass.ts` |
| RCAS | `RCAS` in `ffx_fsr3upscaler_rcas.h` | optional `RCAS` after accumulation | `Fsr3RcasPass.ts` |

The main dispatch order is `Prepare Inputs -> Luma Pyramid -> Shading Change
Pyramid -> Shading Change -> Prepare Reactivity -> Luma Instability ->
Accumulate/Accumulate Sharpen -> optional RCAS`. The public API exposes a
separate Generate Reactive dispatch; it is not Frame Generation.

## Resource and constant ABI

`ffx_fsr3upscaler_resources.h` is the authoritative resource identifier table;
the complete parsed table is recorded in `sources.json` (60 resource slots, 4
constant-buffer identifiers). The HLSL and GLSL callback
headers preserve binding names and access direction. The host source's
`srvTextureBindingTable`, `uavTextureBindingTable`, and
`constantBufferBindingTable` patch shader reflection names to those identifiers;
the WGSL stage bindings are explicit in the local passes, with resources
lowered to WebGPU texture and buffer binding limits.

The `Fsr3UpscalerConstants` layout is copied from
`ffx_fsr3upscaler_private.h` and includes current/previous render and upscale
sizes, max sizes, device-to-view depth factors, current/previous jitter,
motion-vector scale/cancellation, timing and pre-exposure deltas, frame index,
velocity/reactiveness/shading-change scales, accumulation increment, and the
minimum disocclusion accumulation. The exact field order is recorded in
`sources.json` and must remain ABI stable during the WGSL port.

## Port boundary

The HLSL and GLSL entry sources are preserved as review references. WGSL
translation is in `OEngine/src/render/passes/fsr3/`. SPD is serialized into
per-mip dispatches on the same frame encoder, reconstructed depth uses an
atomic buffer, and unavailable reactive/transparency producers bind a zero
mask. The runtime uses low-resolution motion vectors, inverted depth, HDR
input, f32 arithmetic, and RCAS. GPU behavior and visual quality remain
deferred to final Next Renderer acceptance.
