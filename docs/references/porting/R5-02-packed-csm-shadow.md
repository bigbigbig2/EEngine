# R5-02 · FX-04 Packed CSM Shadow

Status: closed by clean production Gate on `8986dc6256e31a5c3630935d1fff2aed08f7a3bf`.

## Reference ID

`R5-02-packed-csm-shadow`

## Authorities and licenses

### Microsoft DirectX SDK Samples / CascadedShadowMaps11

```text
repository: https://github.com/microsoft/DirectX-SDK-Samples
commit: 07e3eaa10e7dd026ec9d95fe326db2d5c4227e1b
license: MIT
source paths:
  C++/Direct3D11/CascadedShadowMaps11/CascadedShadowsManager.cpp
  C++/Direct3D11/CascadedShadowMaps11/CascadedShadowsManager.h
  C++/Direct3D11/CascadedShadowMaps11/CascadedShadowMaps11.hlsl
decision: port cascade-fit/stabilization invariants; reject D3D11 ownership and CPU draw-list structure
```

保留 cascade frustum slice、light-space orthographic fit、按 shadow texel 对齐投影、显式
depth bias 与 atlas viewport 隔离。OEngine 不复制 D3D11 resource view、effect framework、
CPU object traversal 或 native draw submission。

### three.js CSM reference

```text
repository: local three.js reference; upstream https://github.com/mrdoob/three.js
commit: 7cda7e710d884827fc73ff1a3aa63270846513d7
license: MIT
source path: examples/jsm/csm/CSMShadowNode.js
decision: port practical split and stable-projection math invariants; no runtime dependency
```

保留 uniform/logarithmic practical split 的插值、最后一级精确结束在 camera far、投影
texel snapping。`three.js/` 只作参考，FX-04 不修改 gitlink，也不移植其 scene traversal、
material loop 或 WebGPU node owner。

### R3 hierarchy producer references

GPU caster selection 不重新发明算法，直接复用已经验收的 R3 production
`HierarchicalWorkGenerator`。其上游、commit、许可证和保留不变量由
[R3-01](./R3-01-hierarchical-work-generation.md) 冻结：Bevy hierarchy/BVH8、Niagara
GPU-driven work queues 与 AnKi visibility/work-generation references。FX-04 只增加
orthographic secondary-view 输入和 required instance flags，不复制第二套 traversal。

## Scope and ownership

```text
Packed Instance (CastsShadow)
  -> existing hierarchy / SSE / frustum GPU producer
  -> per-cascade VisibleCluster + SecondaryRasterWork
  -> complete 16 B drawIndirect args
  -> one depth-only indirect consumer per cascade
  -> shared depth32float reverse-Z atlas
  -> existing direct-lighting shadow consumer
```

`ShadowContext` 拥有 atlas、cascade cameras、Packed pass 和 completion-safe feature
lifecycle；`PackedCsmShadowPass` 拥有 secondary-view prepared queues；
`HierarchicalWorkGenerator` 仍是唯一 hierarchy kernel owner。Loader 临时对象和 CPU
Scene object 不成为 Packed shadow owner。

## ABI and capacity

`GpuSecondaryRasterAbi.ts` 冻结 v1 family。它复用 Work Generation ABI v3：

- queue header 32 B：`written/attempted/peak/overflow/fallback/capacity/reject`；
- `VisibleCluster` 20 B：instance、geometry、cluster、material、`raster_flags`；
- `RasterWork` 12 B：visible-cluster slot、meshlet record、`raster_flags`；
- indirect args 固定 16 B：`vertexCount/instanceCount/firstVertex/firstInstance`；
- 每个 cascade 独立 bounded family，不能共享 header 或覆盖其他仍被消费的 view；
- producer 使用 all-or-nothing reservation，consumer 只能读取 `written`；
- overflow 写真实 counter/bit，Gate 失败，禁止静默截断或伪零。

当前每个 shadow view 按 scene 的合法 hierarchy cut/raster capacity 准备资源，因此
不会使用 camera 可见数量猜测容量。`CastsShadow`、`AlphaTested`、`DoubleSided` 沿用
Instance ABI flag，避免创建 shadow-only material classification table。

## Mathematical invariants and WebGPU adaptation

- 三个 practical split 使用 `lambda=0.5` 的 uniform/log blend，单调且最后一级为 1；
- 每级从主 camera frustum slice 拟合 light-space orthographic bounds；
- XY center 对齐实际 atlas tile 的 world-units-per-texel，sub-texel camera motion 不移动投影；
- reverse-Z atlas clear 为 0，compare 为 `greater`，depth bias `2`、slope scale `1.5`；
- caster selection 复用 hierarchy frustum/SSE，增加 `requiredInstanceFlags=CastsShadow`；
- vertex consumer固定最多 128 triangles / 384 vertices，与 Meshlet recipe 上限一致；
- alpha MASK 读取同一 Material visibility record、UV transform、sampler class 和 alpha atlas；
- mirrored/non-mirrored 与 double-sided 在 fragment discard 中保持 main Visibility 的正反面语义；
- Packed directional CSM 不回退 CPU draw list；Packed point/spot shadows不在 FX-04 范围内，
  当前显式跳过，不能冒充完成。

WebGPU baseline 只使用 storage buffer、compute dispatch、普通 `drawIndirect` 和 depth
attachment；不依赖 MDI、mesh shader、64-bit atomic 或 buffer device address。所有 cascade
工作、clear、raster 与 sampled counter 都编码到 Renderer 当帧唯一 command context，无私有
submit/readback。

## Lifecycle and feature-off

Shadow atlas 上限从历史 8192 收敛为 4096 `depth32float`，最大 64 MiB，低于冻结的
128 MiB shadow-atlas cap。功能关闭时 completion-safe 退休 atlas、legacy/Packed pass 和
prepared work；没有 cascade producer、atlas update、counter reducer 或额外 submit。重新开启
按需重建。稳定开启时复用 atlas 与 prepared queue，不按材质数创建 draw/pass。

## Performance hypothesis

FX-04 删除 Packed shadow 的 CPU final-visible list 与 legacy `MeshletDrawList` consumer；每级
只保留 hierarchy GPU producer、viewport clear 和一次间接 depth draw。成本随三个 cascade 的
真实 `RasterWork`、atlas updated pixels 和 alpha-tested work 变化，不随 active material 数线性
增加。FX-04 focused Gate证明结构和预算；最终 1080p 产品性能仍由 G5-P 判定，不能把 focused
smoke 声称为 AAA/three.js parity。

## Failure and fallback

- invalid split/capacity/viewport 在编码前抛错；
- queue overflow 设置 `shadowQueueOverflowMask` 并使 production Gate 失败；
- atlas pressure沿用 `ShadowAtlasAllocator`/resolution controller 的有界布局，不覆盖活跃 tile；
- feature-off 完全裁掉资源与工作；
- Packed point/spot shadow 保持未支持，不偷偷进入 CPU producer；
- legacy non-Packed Scene 暂保留原 ShadowRaster consumer，最终删除由 FX-12 决定。

## Tests and Gate

Automated:

- `OEngine/tests/secondary-raster-abi.test.mjs`
- `OEngine/tests/packed-csm-shadow.test.mjs`
- `OEngine/tests/gpu-work-generation-abi.test.mjs`
- glTF/Packed tests验证默认 `CastsShadow` flag和 alpha/double-sided组合。

Production browser:

- page: `examples/r5-packed-csm-shadow/`
- runner: `examples/scripts/run-r5-fx04-gate.mjs`
- fixed workload: Benchmark C smoke，1280×720、DPR 1、固定 camera/light、三个有效 cascade；
- evidence: cascade `RasterWork`、alpha work、atlas updated pixels/bytes、overflow、一个 submit、
  WebGPU diagnostics、shadow on/off/on sequence和三张 canvas screenshot；
- clean artifact: `temp/r5/fx-04/8986dc6256e31a5c3630935d1fff2aed08f7a3bf/`；
- result: `passed=true`、`gateEligible=true`、issues/overflow/WebGPU diagnostics为零，
  cascade work `5/64/47`，alpha work `38`，shadow GPU P50/P95
  `0.228096/0.884528 ms`；dirty artifact只作探索证据。

## Stage 2B visibility seam (2026-09-04)

Stage 2B 将 FX-04 的 atlas producer 与 Opaque Lighting consumer 固定在
`ShadowVisibilityFrame`：`atlas` 是唯一必需资源，`contactVisibility` 为可选资源，
并携带 `cascadeCount`、PCF kernel、normal offset、depth bias、slope scale 和 atlas 尺寸。
该产品禁止携带 HDR/color target；`LightingFeature` 不再接收裸 `shadowAtlas` 参数。

`ShadowContract.ts` 是 CSM/PCF 参数的单一 ABI 来源：3 级 cascade、5-kernel filter、
0.5 normal offset、depth bias 2、slope scale 1.5。Packed CSM raster 与 direct shader
共享这些常量，避免 producer/consumer 漂移。contact-shadow producer 尚未实现，当前以
`null` 明确表示 unsupported；不得把点光源的 contact-hardening PCF 误报为屏幕空间 contact shadow。
