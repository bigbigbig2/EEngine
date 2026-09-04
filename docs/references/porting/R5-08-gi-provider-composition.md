# R5-08 · GI Provider Composition（静态 Lightmap / 动态 Probe Volume / IBL 基线）

## 登记结论

- **Reference ID**：`R5-08-gi-provider-composition`
- **decision**：`compose existing providers / no external source copied`
- **当前状态**：`GIService.resolveOpaqueLighting` 已成为 Renderer 唯一组合入口；静态 Lightmap（Brick4）、动态 Probe Volume（LPV）与 IBL 均通过显式 `mode` ABI 进入统一 resolve owner，Diffuse fallback 链有代码证据。
- **替换结论**：把静态 Lightmap provider（Brick4 diffuse/specular/fused）与动态 Probe Volume provider（LPV diffuse + IBL specular 基线）的所有权收拢进 `GIService`，由单一 `resolveOpaqueLighting` 接口统一组合后经 `OpaqueLightingResolvePass` 合成；Renderer 只预导入 `ResourceId` 并传入，具体的 Provider 选择与 fallback 决策收敛在 `GIService` 内部。

## 算法来源与许可证

本条目不新增算法移植，不复制任何外部源码。三个 Provider 的算法归属见既有台账：

- IBL diffuse/specular 基线：`R5-01-surface-lighting.md`（Filament IBL 数学不变量，Apache-2.0）。
- 静态 Lightmap（Brick4）消费 GPU-ready Lightmap：OEngine authored（`Brick4IndirectPass`）。
- 动态 Probe Volume（LPV）消费 Probe Volume：OEngine authored（`LpvIndirectDiffusePass`）。

## 组合范围与所有权

```text
Renderer 预导入 ResourceId + late-bound job
  -> GIService.resolveOpaqueLighting(mode=brick4)  （静态 Lightmap provider）
       -> Brick4 diffuse（bentNormal）/ specular（normal） 或 Brick4 fused
       -> OpaqueLightingResolvePass
  -> GIService.resolveOpaqueLighting(mode=lpv)（动态 Probe Volume provider）
       -> LPV indirect diffuse + IBL specular 基线（resolveBaselineSpecular）
       -> OpaqueLightingResolvePass
  -> GIService.resolveOpaqueLighting(mode=ibl)（无静态/动态 provider 时的 IBL 基线）
  -> working-linear rgba16float scene HDR
```

- `GIService` 持有 `Brick4DiffusePass` / `Brick4SpecularPass` / `Brick4FusedIndirectPass` 三个静态 provider pass，以及惰性创建的 `LpvIndirectDiffusePass`。
- IBL provider 的实现由 `OpaqueLightingPipeline` 提供，`GIService.resolveOpaqueLighting` 是 Renderer 唯一组合入口。
- Renderer 不再直接构造或持有 `Brick4*Pass` / `LpvIndirectDiffusePass` / `OpaqueLightingPipeline`。

## Input / Output ABI

- `LightmapIndirectInputs`：`hdr/depth/normal/bentNormal/albedoAo/pbr/splitSum/stbn/view/camera/lightMap` + 可选 `ambientVisibility/metadata` + `extent{width,height}` + `fused`。
- `ProbeVolumeIndirectInputs`：`hdr/depth/normal/bentNormal/albedoAo/pbr/splitSum/environment/camera` + 可选 `ambientVisibility/metadata` + `atlasRadiance/atlasDepth/meshBvh/metadataBuffer/tetrahedra/probes` + `extent` + `job`（late-bound camera/sampler/尺寸）。
- `ProbeVolumeIndirectOutput`：`{ hdr, indirectDiffuse, indirectSpecular }`；`indirectSpecular` 即 IBL specular 基线，供后续 SSSR delta correction 消费。
- `LightmapIndirectOutput`：`{ hdr, indirectDiffuse, indirectSpecular }`；非 fused 路径 `indirectSpecular` 为 `Brick4SpecularPass` 输出（specular 基线），供后续 SSSR delta correction 消费；fused 路径直接累加 hdr、无独立 diffuse/specular 基线，两个字段为 `null`。
- 三种 provider 的输出都汇入同一个 `OpaqueLightingResolvePass`，不复制 Surface 解释。

## Retained Invariants

- Diffuse fallback 链 `Lightmap → Probe Volume → IBL → 无间接光`（§7.1）有代码证据：Renderer 只调用 `resolveOpaqueLighting`，provider mode 在接口 ABI 中显式选择。
- `OpaqueLightingResolvePass` 是唯一 HDR 间接光合成入口（不引入第二套合成 owner）。
- 动态 Probe Volume 的 specular 仍走 IBL 基线（`resolveBaselineSpecular`），LPV 只贡献 diffuse；`indirectSpecular` 输出与 IBL 分支的 `iblSpecular` 语义一致，供 SSR 修正复用。
- 静态 Lightmap 的 `fused` 路径直接累加 hdr，非 fused 路径分离 diffuse（bentNormal）/ specular（normal）后合成。
- `resetFrameEvidence()` 重置 composite + 全部 brick4 pass + lpvDiffuse 的 `lastRan`；`destroy()` 销毁 implementation 与 lpvDiffuse（brick4 系列 pass 无 `destroy()`，仅释放引用）。

## OEngine / WebGPU 适配

- Renderer 侧通过 `bind(name, fn)` 构造 LPV 的 late-bound job（camera/sampler/internalWidth/Height），与既有 FrameGraph slot 延迟解析约定一致。
- 所有输入资源由 Renderer 预导入为 `ResourceId`，GIService 只做组合，不负责资源解析或生命周期外的创建。
- Transparency/OIT 路径独立消费 `bindings.gpuScene.volumetric_light_map.buffer`（`brick4LightMapRes`），是独立 consumer，不受本组合迁移影响。

## Fallback / Failure Behavior

- 无 Lightmap、无 Probe Volume、无环境时依次回退，最终为「无间接光」（IBL baseline 在无环境时仍走 `requireShadeImage` 显式失败语义）。
- Provider 缺失不创建对应 pass/资源：`lpvDiffuse` 惰性创建，静态 provider pass 随 `GIService` 构造创建但不消费时无 FrameGraph 工作。

## 本地实现与验证

- owner：`OEngine/src/render/features/GIService.ts`
- 消费侧：`OEngine/src/render/Renderer.ts`（`resolveOpaqueLighting`）
- automated seam：`OEngine/tests/p5-gi-reflection-ao-service.test.mjs`、`OEngine/tests/r5-composition-rebuild.test.mjs`

## 决策

`compose` 现有三个 provider 到 `GIService.resolveOpaqueLighting` 统一组合入口；`OpaqueLightingResolvePass` 保留为唯一 HDR resolve owner，Renderer 不再暴露 provider-specific 组合调用。
