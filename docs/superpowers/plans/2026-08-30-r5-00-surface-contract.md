# R5-00 Surface Contract Implementation Plan

**Baseline:** `4220ee793df589830ffa04d39d38f54e2ad6cf52`

**Goal:** 在不增加 Surface bytes/pixel、不改变 Resolve draw count 的前提下，冻结 R5 Surface/Velocity metadata ABI，并把 R4-B 分散的 packing magic 迁到一个 TS/WGSL truth source。

## Task 1 · Contract tests first

Files:
- Create `OEngine/tests/r5-surface-contract.test.mjs`
- Modify `OEngine/tests/packed-material-resolve.test.mjs`
- Modify `OEngine/tests/render-debug-view.test.mjs`

Assertions：formats、26 B/pixel、16/16 metadata、reserved=0 producer contract、TS/WGSL constants、Resolve/Counter/Debug no old `24/8` magic、velocity direction/invalid semantic。

## Task 2 · Single Surface ABI owner

Create `OEngine/src/gpu/GpuSurfaceAbi.ts`：
- format/channel/depth schema；
- metadata masks/shifts/flags；
- CPU pack/decode with range/reserved validation；
- WGSL declaration/helpers；
- velocity convention。

## Task 3 · Migrate all current consumers atomically

Modify：
- `RenderTargets.ts`
- `PackedMaterialResolvePass.ts`
- `packed_material_resolve.ts`
- `PackedSurfaceCounterPass.ts`
- `render_debug_view.ts`
- `velocity.ts`
- `RenderDebugView.ts`

保持 compatibility property/name（如 `surfaceFlags`）仅用于降低本提交调用面；资源实际 label/semantic 改为 metadata。

## Task 4 · Documentation / provenance

Update R5-00 exact ABI、人工 baseline procedure，新增 porting decision ledger。Benchmark A/B/C frozen role 不为 Surface contract 临时改写。

## Task 5 · Verification

生成 patch 前：

```text
base touched-file Git blob SHA == GitHub 4220ee7
TypeScript syntax/transpile diagnostics = 0
Node .mjs syntax diagnostics = 0
GpuSurfaceAbi standalone compile/smoke = PASS
git diff --check = PASS
```

Patch round-trip：

```text
clean exact preimage
git apply --check
git apply
git diff --check
applied tree == intended tree
```

用户本机最终 Gate：

```bat
cd OEngine
set NODE_OPTIONS=
npm test
npm run audit:shaders
cd ..\examples
npm run build
```

随后按 R4 focused/sub-Gate 分层采集：ABI focused production browser 通过即可进入只读 ABI 的 FX-01；clean A/B/C baseline + debug captures 必须在 FX-02 修改 Lighting 前完成，`performance-targets.json` 最迟在 G5-L 冻结。证据齐全前状态为 `R5-00 implementation complete / baseline conditional`，不得声明阶段关闭或性能收益。
