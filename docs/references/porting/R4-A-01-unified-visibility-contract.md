# R4-A-01 · Unified Hardware Visibility Contract

Status: R4-A-01 implemented; R4-A-02..06 integrated; G4-A closed 2026-08-28

## Reference ID

`R4-A-01-unified-visibility-contract`

## Upstream authorities

### OEngine R3 ABI

```text
source: ./R3-01-hierarchical-work-generation.md
decision: adopt local verified ABI
scope: VisibleCluster, RasterWork, queue/capacity/fallback, 16 B drawIndirect
```

R4 不重新设计 R3 producer；只在 `RasterWork` 上建立 frame-local key lookup。

### WebGPU / WGSL

```text
URLs: https://www.w3.org/TR/webgpu/
      https://www.w3.org/TR/WGSL/
snapshot reviewed: 2026-08-28 living specifications
decision: implement to specification
scope: rasterization, fragment position/depth, r32uint/depth32float, u32 atomics, binding limits
```

规格文本是语义权威，不作为可复制源码。

### Burns & Hunt · The Visibility Buffer

```text
URL: https://jcgt.org/published/0002/02/04/
publication: JCGT 2013
decision: reimplement concept/mathematical data flow
scope: compact visibility identity and deferred attribute reconstruction
```

不复制论文附件中未单独确认许可证的表达性代码。

### Timberdoodle

```text
repository: https://github.com/Sunset-Flock/Timberdoodle
commit: aa7f35483a9e312acb458d5a32ae9e0eea13c220
license: Apache-2.0
decision: port selected lookup invariants / reject native API structure
source paths:
  src/rendering/rasterize_visbuffer/draw_visbuffer.hlsl
  src/rendering/rasterize_visbuffer/analyze_visbuffer.hlsl
  src/rendering/rasterize_visbuffer/rasterize_visbuffer.cpp
  src/shader_lib/visbuffer.hlsl
  src/shader_shared/visbuffer.inl
  src/rendering/tasks/shade_opaque.hlsl
```

代码移植时保留 Apache-2.0 notice，并在提交中记录实际采用函数/行区段；本 ledger 不授权整文件复制。

### glTF 2.0

```text
URL: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
version: glTF 2.0 specification, reviewed 2026-08-28
decision: implement material visibility semantics to specification
scope: alphaMode, alphaCutoff, doubleSided, baseColor alpha, texCoord
```

### KHR_texture_transform

```text
URL: https://github.com/KhronosGroup/glTF/tree/main/extensions/2.0/Khronos/KHR_texture_transform
snapshot reviewed: 2026-08-28
decision: implement transform semantics to specification
scope: offset, scale, rotation and extension texCoord override
```

## Input/output ABI

Input：

```text
RasterWork[rasterWorkSlot]
  visibleClusterSlot: u32
  meshletRecordIndex: u32

VisibleCluster[visibleClusterSlot]
Instance / Geometry / Meshlet records
MaterialVisibilityRecord
  v1 / 64 B
  materialId / alphaMode / flags / textureRef
  baseColorFactorAlpha / alphaCutoff / uvSet / samplerClass
  uvOffset / uvScale / cos(rotation) / sin(rotation)

GeometryRecord
  internal GPU ABI v2 / 160 B
  UV0/UV1 byteOffset / stride / format fast paths
```

Output：

```text
VisibilityKey u32
  bits 0..6  localTriangle
  bits 7..31 rasterWorkSlot 0..0x01FFFFFE
  slot 0x01FFFFFF reserved
  0xFFFFFFFF empty

depth32float reverse-Z
```

## Retained invariants

- key 唯一定位 `RasterWork + localTriangle`，从而唯一定位 multi-Meshlet Cluster 内 triangle。
- key 只在本帧有效；稳定 object identity 通过 lookup 返回。
- empty、最大合法 slot、triangle count 和 overflow 在 TS/WGSL 共享 schema 中冻结。
- Hardware fragment depth 是 R4-A oracle；不把 attribute perspective correction 套给 final depth。
- alpha mask 在 visibility fragment discard 后写 key/depth；blend 不进入 opaque path。
- GPU producer → `drawIndirect` → GPU attachment 闭环，不用当前帧 readback 决定 draw。

## OEngine/WebGPU adaptation

- Timberdoodle 的 native descriptor、shader language/runtime 和 command model 不移植。
- 现有 `visibleClusterSlot + localTriangle` 改为 `rasterWorkSlot + localTriangle`；额外 lookup 是解决 multi-Meshlet 唯一性的必要成本。
- R4-A 只建立 Material Visibility 子集；完整 Material/Texture owner 属于 R4-B。
- WebGPU exact shared-edge primitive ownership 未定义，因此 HW oracle 区分非边界 exact 与边界 coverage/surface invariant。
- `PackedVisibilityPass` 只增加同一次 Hardware draw 的第三个 `r32uint` MRT；旧 triangle/instance outputs 暂供 Material/Velocity consumer 使用并登记为 R4-B 删除对象，不复制第二条 producer。
- Key attachment 使用 FrameGraph transient texture，usage 为 `RENDER_ATTACHMENT | TEXTURE_BINDING | COPY_SRC`；width/height 属于 descriptor/graph signature，feature-off graph 不创建该资源。device lost 只随 GraphicsContext/Renderer 重建恢复，live lifecycle stress 留给 `R4-A-05`。
- producer 在 hierarchy prepare 前调用共享 capacity guard；invalid encode 写 reserved-slot marker `0xFFFFFF80`，empty 保持 `0xFFFFFFFF`，两者在 reducer 中分开统计。
- `MaterialVisibilityRecord v1` 是 OEngine 独立冻结的 64 B TS/WGSL ABI；生产 fragment 从 Geometry/Instance/Meshlet/RasterWork 回查 material，不建立 CPU per-material draw loop。
- `GpuMaterialVisibilityTable` 是 `R4-B-02` 前的有界临时 owner：4,096 records、256 个 64×64 tile、约 4.25 MiB 固定资源；随 Packed staging 惰性创建，使用调用方 command，不创建 encoder、不私有 submit。material handle 超界在记录命令前失败；texture tile 满或纹理无效时写显式 factor-only fallback，abort 回滚本表 CPU residency，destroy 随 GraphicsContext/device 生命周期执行。
- WebGPU baseline 只有 8 个 vertex-stage storage buffer slot，因此 Geometry GPU ABI 从 v1/144 B 升到 v2/160 B，在原 binding 中加入 UV0/UV1 fast path；device-independent Geometry Package ABI 不变。支持 `float32x2`、normalized `uint8x2` 与 normalized `uint16x2`，未知/缺失 UV fail 到 factor-only。
- Material table 与 alpha atlas 仅占 fragment binding 9/10。atlas 由 `textureLoad` 手动实现 clamp/repeat/mirror 与 nearest/linear，非法 sampler 使用冻结的 linear-repeat class；没有依赖 bindless、descriptor indexing 或每材质 sampler binding。
- glTF `alphaMode/alphaCutoff/doubleSided/baseColorFactor/baseColorTexture.texCoord` 与 `KHR_texture_transform` 依据 Khronos 规格独立实现；transform 顺序为 scale → rotation → offset，extension `texCoord` 覆盖 texture info `texCoord`。
- Hardware debug 沿用 Timberdoodle/Visibility Buffer 的“compact key 后续回查”不变量，但由 OEngine 依据本地 TS/WGSL ABI 独立实现：单个 fullscreen pass 读取 Key 与五个 storage buffer，按 RasterWork → VisibleCluster → Meshlet/triangle → Instance/Geometry → Material 顺序做有界检查；不移植 native bindless、BDA、descriptor 或 task graph 结构。
- debug settings 固定 32 B；有效像素哈希完整 identity，异常层级使用稳定 fail-visible color。queue 同时检查 header `written` 与 storage runtime array length，table 同时检查 runtime array length 与 owner high-water/capacity，避免损坏 header 导致越界读取。
- production `RenderDebugView.VisibilityKey` 复用既有 debug topology。关闭时不实例化 pass/output/uniform/readback/encoder/submit；开启时新增一次 fullscreen draw 与一个 `rgba16float` transient output，不重新生成 work、不重复 geometry draw。
- `validatePackedVisibilityPreparation()` 是 production prepare 的单一 capacity seam：在 generator 之前同时验证 key 和 adapter buffer limits，返回 required/effective byte evidence；失败不调用 generator、不分配 RasterWork queue、不编码 producer。
- prepared hierarchy 的 epoch replacement、Packed release 和 abort 通过 `destroyAfterGpuDone()` 等待 queue completion；View removal 同样先断开 lookup 再 fence old history。device loss 不复用旧 device resources，只允许 fresh Renderer/GraphicsContext 从 device-independent package 重建。
- counter/debug feature-off 不保留 reducer/readback/额外 submit；256 B disabled counter sink 仅用于当前固定 shader binding ABI，不执行采样 clear/copy/reduce。
- paired Gate 复用 production A/B/C Renderer、manifest、Packed hierarchy producer 与现有 final-color Material Resolve oracle；只在 benchmark 完成后暴露 capture hook，不建立独立渲染管线。artifact 检查 clean/full provenance、cadence、submit/drawIndirect、attachment bytes、pixel partition、queue/counter/timestamp 与 WebGPU diagnostics。
- Packed `alphaClusters` 在 sampled frame 由 64-lane GPU reducer沿 `RasterWork → VisibleCluster → MaterialVisibilityRecord` 统计 `MASK` RasterWork 子集；counter-off frame 不创建该 Pass/readback，reducer 不读回 count 决定本帧工作。
- WebGPU baseline 没有 negotiated pipeline-statistics producer，submitted fragments 使用稳定平台能力标识 `WEBGPU-01-PIPELINE-STATISTICS` 登记 unsupported；G4-A 不以假零值或伪造 submitted/useful 比例通过。

## Precision / semantic differences

- final depth：post-clip viewport depth 的 framebuffer-space 插值。
- perspective correction：只用于后续 attributes。
- reverse-Z clear `0.0`，Visibility clear `0xFFFFFFFF`。
- `rasterWorkSlot` 若每帧重排，key 不提供跨帧 primitive identity。
- alpha atlas 使用 `rgba8unorm`，只读取 base-color alpha；sRGB RGB 解码不参与 cutoff。R4-A 临时 owner 固定缩放到 64×64 tile，不宣称保留完整材质纹理 mip/各向异性语义，完整 owner 由 `R4-B-02` 接管。
- mirrored transform 由 object-to-world 3×3 determinant 修正 front-facing；double-sided 绕过单面 discard。alpha discard 发生在 key/depth 写出前，不显式写 `frag_depth`。

## Performance hypothesis

新增一次 RasterWork lookup 和 `r32uint` write，可删除有歧义 ID/旧 attachment 转换，并让 R4-B 只扫描一次可见像素。alpha 临时 owner 固定增加约 4.25 MiB；首次 residency 最坏为 256 个 tile resize render pass，稳定帧不重复编码。opaque fragment 不采样 atlas；mask nearest 为一次 `textureLoad`，linear 为四次 `textureLoad` 加手工插值。R4-A paired A/B/C 必须报告 Hardware raster、lookup/debug、attachment bytes、active alpha materials 与 alpha staging/pass 数；不能只报告总帧。

## Fallback / failure behavior

- key/RasterWork capacity 无法表示：prepare 明确失败或 unsupported，不截断。
- invalid/empty lookup：debug fail-visible + counter；release producer validation 必须阻止非法 key。
- alpha texture 未驻留：使用已冻结 fallback，不能随机绑定或静默当 opaque。
- alpha texture/sampler fallback：invalid/未驻留 texture 使用 factor-only；非法 sampler 保留有效纹理并使用冻结 sampler class，同时记录独立 fallback flag/counter。
- capability 不支持所需 attachment/format：报告 capability blocker，不退回 CPU material/object draw loop。

## Local tests/examples

Implemented：

```text
OEngine/src/gpu/GpuVisibilityKeyAbi.ts
  shared TS schema/constants and generated WGSL codec
  strict encode/decode/empty/invalid/max behavior
  adapter-aware RasterWork capacity and explicit producer failure
  CPU VisibilityKey -> RasterWork -> VisibleCluster lookup reference

OEngine/tests/gpu-visibility-key-abi.test.mjs
  TS/WGSL generated constant parity
  reserved slot, empty, maximum and rejected input boundaries
  key-limit/header/adapter capacity cases
  multi-Meshlet Cluster unique lookup and invalid table ranges

OEngine/src/shaders/packed_visibility.ts
OEngine/src/render/passes/PackedVisibilityPass.ts
  production RasterWork + drawIndirect Hardware producer
  VisibilityKey v1 MRT + depth32float reverse-Z
  FrameGraph transient attachment and explicit capacity failure

OEngine/src/render/passes/VisibilityCounterPass.ts
OEngine/src/debug/GpuFrameCounters.ts
  legacy-id / visibility-key-v1 sampled reducer variants
  useful, empty and reserved-slot invalid key counters

OEngine/tests/packed-visibility-r4.test.mjs
  attachment descriptor/owner/feature-off contract
  submitted/useful/invalid observability declaration

examples/r4-hardware-opaque-producer
  production WGSL + HierarchicalWorkGenerator + GPU drawIndirect
  key/depth/RasterWork/VisibleCluster validation-only readback and screenshot

OEngine/src/gpu/GpuMaterialVisibilityAbi.ts
OEngine/src/gpu/GpuMaterialVisibilityTable.ts
OEngine/src/gpu/GpuGeometryAbi.ts
OEngine/src/loaders/gltf/gltfMaterials.ts
OEngine/src/shaders/packed_visibility.ts
OEngine/src/render/passes/PackedVisibilityPass.ts
  64 B Material Visibility ABI and bounded temporary owner
  Geometry GPU ABI v2 UV0/UV1 fast paths without a ninth vertex storage binding
  opaque/mask/blend, factor/texture/transform/cutoff and facing classification

OEngine/tests/gpu-material-visibility-abi.test.mjs
OEngine/tests/gpu-material-visibility-table.test.mjs
OEngine/tests/gpu-asset-store.test.mjs
OEngine/tests/gpu-packed-scene-registry.test.mjs
OEngine/tests/packed-visibility-r4.test.mjs
  TS/WGSL ABI, glTF transform, independent texture/sampler fallback
  bounded owner staging/abort/capacity/destroy and production graph contract

examples/r4-alpha-tested-visibility
  production WGSL, eight RasterWork slots and one drawIndirect
  key/depth validation-only readback, full-page screenshot and canvas screenshot

OEngine/src/gpu/GpuVisibilityDebugResolve.ts
OEngine/src/shaders/render_debug_view.ts
OEngine/src/render/passes/RenderDebugViewPass.ts
OEngine/src/render/passes/PackedVisibilityPass.ts
  shared debug status/settings/color ABI and CPU full-lookup oracle
  one production fullscreen lookup consumer over the producer-owned GPU tables
  runtime release/destroy cleanup and legacy debug fallback

OEngine/tests/gpu-visibility-debug-resolve.test.mjs
OEngine/tests/render-debug-view.test.mjs
OEngine/tests/packed-visibility-r4.test.mjs
  empty/reserved/max and every lookup failure layer
  complete valid identity/material result, seven-binding ABI and one-pass graph order
  feature-off graph and Packed debug source contract

examples/r4-debug-resolve
  static MASK/alpha texture/KHR_texture_transform glTF through the public Packed path
  production Renderer ID heatmap and same-WGSL 16-case fail-visible GPU injection

OEngine/tests/r4-visibility-lifecycle.test.mjs
OEngine/tests/gpu-submit-owner.test.mjs
  prepare-before-allocation rejection and exact boundary
  epoch replacement/release/abort GPU fence and view recreation
  guarded counter/debug optional work and classified view lifecycle submit

examples/r4-visibility-lifecycle
  production Packed alpha path with feature-off and sampled counter evidence
  resize, camera cut, view recreation and immediate release/re-upload
  intentional device destroy, old Renderer stop and fresh adapter/device/Renderer rebuild

OEngine/src/render/passes/PackedVisibilityAlphaCounterPass.ts
examples/benchmark-shared/R4A06BrowserGate.ts
examples/benchmark-shared/BenchmarkPage.ts
  sampled-only Packed alpha RasterWork reducer
  production A/B/C full Gate artifact and oracle/key/depth capture hook
```

R4-A-01/02/03/04/05/06 没有复制、翻译或改写 Timberdoodle 的表达性源码；实际实现是依据冻结 ABI、WebGPU/WGSL 与 Khronos glTF 规格，对 lookup/producer/material alpha/debug bounds/lifecycle/observability 不变量做 OEngine 独立 reimplementation，因此没有向本地源码嵌入 Apache-2.0 代码 notice。上游仓库、commit、路径与许可证仍保留在本 ledger，供后续 shader lookup 接线继续核对。

Validation：

```text
cd OEngine
npm run build:test
node --test tests/gpu-material-visibility-abi.test.mjs tests/gpu-material-visibility-table.test.mjs tests/gpu-asset-store.test.mjs tests/gpu-packed-scene-registry.test.mjs tests/packed-visibility-r4.test.mjs
result: 15/15 Material ABI/fallback/glTF, owner lifecycle/capacity, Packed staging and graph contract tests passed

cd examples
npm run build
Chrome WebGPU: examples/r4-hardware-opaque-producer
result: passed=true; valid/empty=6820/69980; invalid/unresolved/depthMismatch=0/0/0;
        reverse-Z depth=0.025; shader/validation/uncaptured diagnostics empty
artifacts: temp/r4-a-02/r4-a-02-cdp.json and r4-a-02-cdp.png

Chrome WebGPU: examples/benchmark-a/?profile=smoke
result: production Renderer completed; 3 sampled frames all exported invalidVisibilityKeys=0;
        validation/uncaptured/device-lost/timestamp/counter diagnostics empty
note: smoke profile and existing Software Visibility blocker make this non-gate evidence
artifacts: temp/r4-a-02/benchmark-a-smoke.json and benchmark-a-smoke.png

Chrome WebGPU: examples/r4-alpha-tested-visibility
result: passed=true; drawIndirect=[384,8,0,0]; CPU material draw loops=0;
        opaque/mask-texture/mask-factor/blend/double-sided/mirrored/invalid-texture/sampler-fallback
        pixels=2892/2177/0/0/2913/2849/2850/1440;
        invalid key/depth mismatch=0/0; WGSL/validation/uncaptured/device-lost diagnostics empty
artifacts: temp/r4-a-03/r4-a-03.json, r4-a-03.png and r4-a-03-canvas.png

cd OEngine
npm run build:test
node --test tests/gpu-visibility-debug-resolve.test.mjs tests/render-debug-view.test.mjs tests/packed-visibility-r4.test.mjs
result: 10/10 debug ABI/oracle, bounds layers, binding ABI and FrameGraph topology tests passed

Chrome WebGPU: examples/r4-debug-resolve
result: passed=true; production Packed alpha glTF path completed for 6 frames;
        16/16 empty/reserved/max/lookup-layer/valid cases matched frozen colors;
        WGSL/validation/uncaptured/device-lost diagnostics empty
artifacts: temp/r4-a-04/r4-a-04.json, r4-a-04.png and r4-a-04-canvas.png

cd OEngine
npm run build:test
node --test tests/r4-visibility-lifecycle.test.mjs tests/packed-visibility-r4.test.mjs tests/gpu-submit-owner.test.mjs
result: capacity prepare, replacement/release/abort fence, view recreation, feature-off guards and submit owner passed

Chrome WebGPU: examples/r4-visibility-lifecycle
result: passed=true; feature-off readbacks=0 and counter sampled=false;
        sampled queueOverflowMask/invalidVisibilityKeys=0/0;
        resize=768x432->640x360, camera invalidations=1->2, view id=0->1;
        immediate Packed release/re-upload passed; exact key capacity 33,554,431 passed and
        33,554,432 rejected before allocation; intentional destroyed loss stopped old Renderer;
        fresh NVIDIA Turing Renderer completed 3 frames with zero diagnostics
artifacts: temp/r4-a-05/r4-a-05.json, r4-a-05.png and r4-a-05-canvas.png

cd OEngine
npm test
npm run audit:shaders

cd examples
npm run build

Chrome WebGPU: benchmark A/B/C full R4-A-06 Gate
result: 1280x720, DPR 1, 60 warm-up + 180 sample, timestamp/counter every 6 frames;
        clean/gate eligible; one main submit and one Packed drawIndirect per frame;
        invalidVisibilityKeys=0, queueOverflowMask=0, useful+empty=921,600;
        C alpha RasterWork=40/127; validation/uncaptured/device-lost/timestamp/counter,
        browser console and page errors all zero; oracle/key/depth silhouettes matched
artifacts: temp/r4-a-06/full/*.json and *.png
```

## Decision

`adopt` R3 ABI；`reimplement` OEngine Key/owner/lifecycle；`port` Timberdoodle 的局部 lookup 不变量；`reject` native API、BDA/bindless 和不兼容 command model。
