# R4-C-01 · Software/Hybrid Raster

Status: source freeze / implementation pending after R4-B

## Reference ID

`R4-C-01-software-hybrid-raster`

## Upstream authorities

### Pineda edge functions

```text
paper: A Parallel Algorithm for Polygon Rasterization
DOI: https://doi.org/10.1145/54852.378457
year: 1988
decision: reimplement mathematical invariant
scope: edge functions and incremental coverage
```

### WebGPU / WGSL

```text
URLs: https://www.w3.org/TR/webgpu/
      https://www.w3.org/TR/WGSL/
snapshot reviewed: 2026-08-28 living specifications
decision: implement to specification
scope: viewport depth, pixel center, u32 atomic, attachments/pass semantics
```

### Microsoft top-left rules

```text
URL: https://learn.microsoft.com/en-us/windows/win32/direct3d11/d3d10-graphics-programming-guide-rasterizer-stage-rules
decision: reimplement as OEngine deterministic SW convention
scope: shared-edge ownership
```

它不是所有 WebGPU HW 后端 exact-edge ownership 的规格保证。

### Scthe/nanite-webgpu

```text
repository: https://github.com/Scthe/nanite-webgpu
commit: b9cd33f65bb3cdba0464717e0fa621d330d2116f
license: MIT
decision: port/reimplement WebGPU pass/resource invariants; reject packed-depth/demo structure
source/test paths:
  src/passes/rasterizeSw/rasterizeSwPass.ts
  src/passes/rasterizeSw/rasterizeSwPass.wgsl.ts
  src/passes/rasterizeSw/rasterizeSwPass.test.ts
  src/passes/rasterizeHw/rasterizeHwPass.ts
  src/passes/rasterizeHw/rasterizeHwPass.wgsl.ts
  src/passes/rasterizeCombine/rasterizeCombine.ts
  src/passes/rasterizeCombine/rasterizeCombine.wgsl.ts
```

采用 WebGPU buffer/pipeline/bind group/merge 的可行结构；拒绝低精度 packed depth、demo owner、固定巨型资源和不符合 OEngine R3 seam 的 work ABI。

### MaskedOcclusionCulling

```text
repository: https://github.com/GameTechDev/MaskedOcclusionCulling
commit: 6cbbd7621cce670cf081a44272669e240300879e
license: Apache-2.0 (license.txt)
decision: port mathematical/validation invariants; reject native SIMD implementation
source/validation paths:
  MaskedOcclusionCulling.cpp
  MaskedOcclusionCulling.h
  MaskedOcclusionCullingCommon.inl
  D3DValidate/D3DValidate.cpp
  FillrateTest/FillrateTest.cpp
  FrameRecorderPlayer/FrameRecorderPlayer.cpp
```

实际采用前登记具体函数/行区段和 retained notice；不翻译 SIMD 表达性代码到 WGSL。

### Nanite SIGGRAPH 2021

```text
URL: https://advances.realtimerendering.com/s2021/Karis_Nanite_SIGGRAPH_Advances_2021_final.pdf
decision: concept-only
scope: micro-triangle HW/SW classification and high-level hybrid rationale
```

拒绝 BDA、64-bit atomic payload、native command generation、完整 streaming/material classification。

## Input/output ABI

Input：R3 selected work seam、R4-A `RasterWork/VisibilityKey` codec、camera/viewport、adapter profile。

New queue：

```text
SW RasterWork element: frozen in R4-C-05
header: attempted / written / peak / overflow / fallback
capacity: derived/proven before allocation
producer: GPU classifier
consumer: SW depth + SW key indirect dispatch
overflow: all affected work routed Hardware
```

Screen buffers：

```text
swDepthAtomic       width × height × u32, clear 0
swVisibilityAtomic  width × height × u32, clear 0xFFFFFFFF
final Visibility    R4-A r32uint
final Depth         R4-A depth32float reverse-Z
```

## Retained invariants

- coverage/depth 实现由两个 SW stages 共享。
- post-clip viewport depth 按 WebGPU raster semantics 插值；attribute perspective correction 留给 R4-B。
- Stage 1 `atomicMax(depthBits)`，Stage 2 equal-depth `atomicMin(key)`。
- tie 只承诺帧内 order-independent。
- exact shared edge 允许 HW/SW primitive owner 不同，但不允许 hole/非法重叠/surface 差异。
- unsupported/clip/alpha/MSAA/overflow/atomic hotspot 保守走 Hardware。
- Material Resolve 不感知 raster source。

## OEngine/WebGPU adaptation

- 用 32 位两阶段完整 depth/key，拒绝 Scthe packed depth 精度。
- classifier 从 R3 seam 建立独立 SW queue；没有 consumer 时不在 R3 预分配。
- SW queue capacity/fallback 遵守 OEngine fail-visible 规则，不 drop triangle。
- 两个 atomic buffers 约 `8 B/pixel`；clear、classifier、transfer/combine 全部进入 profile。
- `feature off` 和 `feature on + queue empty` 分开建模。

## Precision / semantic differences

- OEngine SW top-left 是 deterministic implementation rule；WebGPU exact-edge HW ownership 未冻结。
- finite clamped reverse-Z `[0,1]` 的 positive float bit pattern用于 ordered `u32`；NaN/invalid 不进入 atomic。
- MSAA 不在 v1；不将 per-pixel key 声称为 sample-level 等价。
- fullscreen transfer 写 `frag_depth` 可能限制 early-depth 优化，必须实测。

## Performance hypothesis

目标是微三角形 workload 中节省 Hardware primitive front-end 成本，收益必须大于 SW queue、bbox、coverage、两阶段 atomic、clear 与 merge。A 做 triangle-size/crossover sweep；B/C 报告 feature-on fixed cost 和普通三角形回退。没有跨 adapter 稳定收益时默认 HW。

## Fallback / failure behavior

- clip complex/overflow、alpha、MSAA、huge bbox、unsupported primitive：Hardware。
- SW queue overflow：整组 Hardware fallback + counter。
- invalid depth/NaN/w：Hardware/fail-visible，不写 atomic。
- adapter storage/atomic 性能异常：capability profile 禁用 SW。
- Hybrid 总时间更差：记录 reject evidence，feature 默认 off；不把“存在代码”当完成收益。

## Local tests/examples

```text
CPU fixed-point coverage/depth oracle
small GPU triangle image tests
non-edge exact HW/SW compare
shared-edge no-hole/surface invariant
overlap/order/empty/invalid/clip cases
SW queue capacity/overflow/fallback property tests
feature-off zero-resource graph test
feature-on empty fixed-cost benchmark
A/B/C HW-only/SW-only/Hybrid browser artifacts
examples/r4-hybrid-visibility
```

## Decision

`reimplement` Pineda/top-left/depth math against CPU oracle；`port/reimplement` Scthe WebGPU engineering structure；`port` MOC correctness invariants；`reject` packed low-precision depth、native SIMD/API、64-bit/BDA 和未经 profile 的默认 SW。
