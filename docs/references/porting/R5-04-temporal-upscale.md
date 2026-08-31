# R5-04 · Temporal / Upscale Foundation / FX-06A

## 登记结论

- **Reference ID**：`R5-04-temporal-upscale`
- **decision**：`port algorithm and integration invariants / independently reimplement WebGPU owner`
- **当前范围**：FX-06A 的共享 history 生命周期、reprojection/acceptance contract、reactive/disocclusion 分类、最小 TAA reference、internal/output resolution contract 与异步 DRS feedback。
- **未闭环范围**：FX-07 已提供共享 registry 下的 AO temporal 输入，FX-08 SSR 尚未完成；最终 TAA/TAAU/upscale 质量、锁定与 sharpening 仍属于 FX-06B，不能由本记录提前宣称完成。

仓库没有复制、翻译或改写下列 HLSL/CG/Unity 表达性代码。OEngine 保留公开的算法与集成不变量，并以 WGSL、FrameGraph 和现有 Surface/Packed ABI 独立实现。

## 上游来源与许可证

### Brian Karis / High-Quality Temporal Supersampling

```text
authority: Advances in Real-Time Rendering in Games, SIGGRAPH 2014
page: https://www.advances.realtimerendering.com/s2014/index.html
material: High-Quality Temporal Supersampling, Brian Karis, Epic Games
material URL: https://www.advances.realtimerendering.com/s2014/epic/TemporalAA.pptx
license: presentation/reference material; no source code copied
decision: concept reference only
```

保留 jittered temporal sampling、motion reprojection、current-neighborhood history clamp、HDR/luminance-aware history confidence和对 translucency/ghosting 的显式处理方向。本实现不采用 Unreal 的 engine owner、平台 API 或未在 OEngine 当前范围内验证的 final-quality recipe。

### Playdead / INSIDE Temporal Reprojection AA

```text
repository: https://github.com/playdeadgames/temporal
commit: 4795aa0007d464371abe60b7b28a1cf893a4e349
license: MIT (LICENSE.txt)
source paths:
  Assets/Shaders/TemporalReprojection.shader
  Assets/Shaders/VelocityBuffer.shader
  Assets/Scripts/FrustumJitter.cs
  Assets/Scripts/TemporalReprojection.cs
  Assets/Scripts/VelocityBuffer.cs
reference material:
  GDC2016_Temporal_Reprojection_AA_INSIDE.pdf
decision: port invariants; reject Unity component/resource ownership
```

保留 current/previous motion、camera jitter、history reprojection、neighborhood clamp、luminance confidence和 view discontinuity reset。不移植 Unity camera component、RenderTexture lifecycle、command buffer 或 tagged renderer traversal；OEngine motion 继续使用冻结的 `current-minus-previous internal-pixel` Surface contract。

### AMD FidelityFX Super Resolution 2 v2.2.1

```text
repository: https://github.com/GPUOpen-Effects/FidelityFX-FSR2
tag: v2.2.1
commit: 1680d1edd5c034f88ebbbb793d8b88f8842cf804
license: MIT
source paths:
  src/ffx-fsr2-api/ffx_fsr2.h
  src/ffx-fsr2-api/shaders/ffx_fsr2_accumulate.h
  src/ffx-fsr2-api/shaders/ffx_fsr2_reproject.h
  src/ffx-fsr2-api/shaders/ffx_fsr2_depth_clip.h
  src/ffx-fsr2-api/shaders/ffx_fsr2_autogen_reactive_pass.hlsl
  src/ffx-fsr2-api/shaders/ffx_fsr2_tcr_autogen.h
decision: adopt integration contracts; reject direct dependency and shader port in FX-06A
```

保留 render/presentation resolution 分离、jitter/motion/reset 输入、reactive 与 transparency/composition mask 语义、previous output history 以及 reproject/accumulate 阶段边界。FSR2 的 HLSL/GLSL、DX12/Vulkan backend、FP16/wave recipe、lock/luma-pyramid/Lanczos/RCAS pipeline 均未移植；最终是否局部采用这些算法由 FX-06B 的质量与性能证据决定。

## 本地输入、输出与 owner

```text
Surface metadata MotionValid/Reactive + Packed transparency reactive
  + disocclusion confidence + current-minus-previous velocity
  -> RG8 Temporal classification (reactive, motion-valid)
  -> minimum TAA reference at output resolution
  -> rgba16float history write
  -> submission-aware history commit / abort invalidation
```

- `TemporalHistoryRegistry` 是 CPU source-of-truth，不拥有 GPU 对象；它定义 channel、read/write index、revision、无效化原因和 submitted commit。
- `Renderer` 按需拥有两张 output-resolution `rgba16float` history，合计 `16 B/output pixel`；1080p 约 `31.64 MiB`，低于 `128 MiB` history cap。
- `TemporalClassificationPass` 只在 Temporal topology 打开时创建 `rg8unorm` transient；R=reactive，G=motion-valid。
- sampled evidence 复用全局 512 B GPU counter ABI 和三槽异步 readback ring，不增加私有 readback、encoder 或 submit。
- DRS 只消费已完成、至少延迟一帧且未重复的 GPU timestamp；它复用 `FrameProfiler`，没有同步 `mapAsync`、额外 readback 或第二 submit。
- public seam 只暴露控制器和有界数值 evidence；GPU texture/pass/shader owner 不从 `src/index.ts` 泄漏。

## 保留的不变量

1. velocity 单位为 internal pixel，方向固定为 `current - previous`；history coordinate 为 `current - velocity`。
2. camera cut、output/internal resize、render scale、feature、format、view switch 和 abort 都使 history 失效。
3. ping-pong 只在已提交且确实产生 history 的 frame completion 上推进；编码失败不提交半帧 history。
4. reactive、motion-invalid、history 越界或低 disocclusion confidence 保守拒绝 history。
5. accepted history 先 clamp 到 current 3×3 neighborhood，再由 motion、luminance、reactive 和 disocclusion confidence 共同限制权重；权重上限 `0.92`。
6. internal/output resolution 是显式输入；history 始终使用 output resolution，current/velocity/depth/classification 使用 internal resolution。
7. feature-off 不保留 Temporal pass、classification transient、history texture、私有 readback 或 submit。
8. DRS 不读 CPU frame time作 GPU pressure proxy，只消费 profiler 已完成的 timestamp sample。

## 精度、语义差异与失败行为

- FX-06A 使用普通 `rgba16float` history 与 FP32 WGSL 运算，不要求 shader-f16。
- classification 采用保守二值/强度输入；透明贡献沿用 FX-05 `reactive=1`，在 transparent velocity 完成前拒绝累积。
- 当前最小 reference 使用 bilinear current/history sampling和 RGB neighborhood min/max；没有 YCoCg clipping、variance clipping、history lock、Lanczos upscale、RCAS 或 exposure-aware final recipe。
- 非有限/非法 DRS sample、current-frame sample 与重复 sample被拒绝，不改变 scale。
- history 超过维度/格式契约不会继续复用；资源分配/编码错误进入 Renderer 既有 abort 和 WebGPU diagnostics。

## 性能假设与门禁

相对旧 parity ping-pong/legacy generated TAA owner：

- history 生命周期不再由 frame parity 猜测，避免 abort/cut/resize 后错误复用；
- classification 与最小 resolve 均为固定 fullscreen work，不随材质数增加 draw/pass；
- 非 sampled frame 不编码 Temporal counter evidence；
- feature-off 从 topology 裁掉 pass/transient/history；
- DRS 复用 delayed profiler 数据，不增加同步 stall。

浏览器 C-resolution sweep 固定 `1.0 / 0.85 / 0.67 / 0.5`，每段先执行 30 帧 warm-up、再独立统计 120 帧；native 1080p 的 Temporal GPU P50 门槛为 `2 ms`。LOD 段使用可生成多级 hierarchy 的 16×16×16 segmented box，并要求 sampled `selectedClusters` 的 min/max 实际变化。该 focused 门禁证明 FX-06A production wiring 与预算，不等价于最终 TAAU 质量或完整 Benchmark A/B/C 产品闭环。

## 本地实现与验证

- history：`OEngine/src/render/TemporalHistoryRegistry.ts`
- CPU contract：`OEngine/src/render/TemporalResolveContract.ts`
- DRS：`OEngine/src/render/DynamicResolutionScaling.ts`
- pass：`OEngine/src/render/passes/TemporalClassificationPass.ts`、`TemporalAntiAliasingPass.ts`
- WGSL：`OEngine/src/shaders/temporal_classification.ts`、`taa.ts`
- Renderer owner：`OEngine/src/render/Renderer.ts`
- automated seam：`OEngine/tests/r5-fx06-temporal.test.mjs`
- production page：`examples/r5-temporal-foundation/`
- runner：`examples/scripts/run-r5-fx06-gate.mjs`
- evidence：18 段 ×（30 warm-up + 120 measured）帧，覆盖 static repeat、slow/fast pan、moving object、disocclusion、transparent motion、真实 hierarchy LOD cut transition、camera cut、resize、四档内部分辨率、feature-off/on；输出 environment/result/graph-counters JSON 与逐段 PNG。
