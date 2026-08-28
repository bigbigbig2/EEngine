# R4-A-01 · Unified Hardware Visibility Contract

Status: R4-A-01 implemented and R4-A-02 Hardware opaque producer integrated 2026-08-28 / alpha, debug and paired Gate pending

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

## Input/output ABI

Input：

```text
RasterWork[rasterWorkSlot]
  visibleClusterSlot: u32
  meshletRecordIndex: u32

VisibleCluster[visibleClusterSlot]
Instance / Geometry / Meshlet records
MaterialVisibilityRecord
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

## Precision / semantic differences

- final depth：post-clip viewport depth 的 framebuffer-space 插值。
- perspective correction：只用于后续 attributes。
- reverse-Z clear `0.0`，Visibility clear `0xFFFFFFFF`。
- `rasterWorkSlot` 若每帧重排，key 不提供跨帧 primitive identity。

## Performance hypothesis

新增一次 RasterWork lookup 和 `r32uint` write，可删除有歧义 ID/旧 attachment 转换，并让 R4-B 只扫描一次可见像素。R4-A paired A/B/C 必须报告 Hardware raster、lookup/debug、attachment bytes 和 active alpha materials；不能只报告总帧。

## Fallback / failure behavior

- key/RasterWork capacity 无法表示：prepare 明确失败或 unsupported，不截断。
- invalid/empty lookup：debug fail-visible + counter；release producer validation 必须阻止非法 key。
- alpha texture 未驻留：使用已冻结 fallback，不能随机绑定或静默当 opaque。
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
```

R4-A-01/02 没有复制、翻译或改写 Timberdoodle 的表达性源码；实际实现是依据冻结 ABI 对 lookup/producer 不变量做 OEngine 独立 reimplementation，因此没有向本地源码嵌入 Apache-2.0 代码 notice。上游仓库、commit、路径与许可证仍保留在本 ledger，供后续 shader lookup 接线继续核对。

Validation：

```text
cd OEngine
npm run build:test
node --test tests/gpu-visibility-key-abi.test.mjs tests/packed-visibility-r4.test.mjs tests/visibility-counter-pass.test.mjs
result: VisibilityKey/attachment/counter focused tests passed

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
```

Planned by later R4-A tasks：

```text
Hardware alpha key + depth GPU readback oracle
Hardware debug reconstruction and real glTF alpha screenshot
A/B/C paired browser artifact with debug screenshots
```

## Decision

`adopt` R3 ABI；`reimplement` OEngine Key/owner/lifecycle；`port` Timberdoodle 的局部 lookup 不变量；`reject` native API、BDA/bindless 和不兼容 command model。
