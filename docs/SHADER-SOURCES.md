# Shader Source-of-Truth 清单

本文记录 `OEngine/src/shaders/*.ts` 到实际 runtime pipeline owner 的静态证据。完整逐文件清单由 `OEngine/tools/audit-shader-sources.mjs` 生成到 `OEngine/benchmarks/shader-source-audit.json`；本文只拥有分类规则、当前结论和迁移边界。

## 重现

```powershell
Set-Location OEngine
npm run audit:shaders
```

审计沿相对 TypeScript import 图追踪 WGSL。Shader 先穿过其他 Shader 聚合文件，再停在最近的 pipeline owner：`render_pipelines.obtain`、`compute_pipelines.obtain`、对应 Cache 的 `obtain`、原生 pipeline 创建或 `constructComputePass`。动态 import、运行时字符串拼接和仓库外 generator 仍需人工确认。

## 当前结论

| 分类 | 数量 | 含义 |
|---|---:|---|
| `authored-live` | 65 | 能到达 runtime pipeline，当前 authored 文件是运行事实源 |
| `dead` | 0 | 当前审计未发现无 owner 的 shader；后续删除必须仍核对 feature 注册与动态路径 |
| `unknown` | 5 | runtime pipeline 正在使用 oracle/generated 文件，但仓库内没有登记 generator/source，所有权尚未闭环 |

历史上曾有 5 项 `dead` shader，已在 P9 硬切换删除；当前 `audit:shaders` 复核为 `dead=0`。`unknown` 仍保留 5 项 oracle/generated，其所有权闭环归对应模块的 authored/generator 迁移波次。

当前总数为 70、`authored-live` 为 65。R4-B 新增 authored `packed_material_resolve.ts` 并扩展统一 `render_debug_view.ts`，旧 `packed_velocity.ts` 已删除；FX-02 又以 authored `lighting_direct.ts` 和 `fullscreen_triangle.ts` 替换 Lighting runtime 对 `lighting_ch_oracle.ts` 的依赖。上述文件均由明确 runtime pipeline owner 消费。

## 正在运行但所有权未闭环

| Shader | 最近 runtime pipeline owner | 当前问题 |
|---|---|---|
| `material_depth_oracle.ts` | `GPUMaterialContext.ts` | oracle 文件是 Material Depth 的实际运行源 |
| `material_expand_oracle.ts` | `GPUMaterialContext.ts` | oracle 文件是 Material Expand 的实际运行源 |
| `oracle_visibility_work_generation.ts` | `MeshletDrawList.ts` | oracle 文件直接驱动 instance cull、prefix/expand 和 indirect work generation |
| `probe_legacy.generated.ts` | `GPULightProbeVolumeRenderer.ts` | generated 文件在运行，但仓库内没有 generator/source |
| `temporal_post_legacy.generated.ts` | `AutomaticExposurePass.ts` | generated 文件经 `automatic_exposure.ts` 转发进入运行管线，但仓库内没有 generator/source |

这些文件不能被当作长期设计权威，也不能仅因文件名含 `oracle/generated` 就直接删除。后续修改对应模块前必须先选择并登记 authored source 或可重复 generator，添加视觉/数值回归，再迁移 pipeline owner。

FX-02 已完成 Lighting source-of-truth 迁移：`LightingPass.ts` 直接消费 authored
`lighting_direct.ts`，`GPUMaterialContext.ts` 的通用 fullscreen vertex 改由
`fullscreen_triangle.ts` 提供；`lighting_ch_oracle.ts` 已删除并由 Node source test
与 production browser Gate 防止回归。

## 删除候选边界

原 `dead` 5 项 `material_expand.ts`、`material_sr.ts`、`mesh_instance_cull.ts`、`meshlet_expand_counts.ts` 与 `meshlet_expand.ts` 已在 P9 硬切换删除：它们曾是 oracle Material/Visibility work-generation 路径旁边没有 runtime owner 的可读重写或旧分支。`audit:shaders` 已复核为 `dead=0`；`material_expand_oracle.ts`（owner `GPUMaterialContext.ts`）与 `mesh_instance_cull_dual.ts`（owner `MeshletDrawList.ts`）不在删除范围，仍为 live/unknown 运行时源。

## Artifact 字段

每个 entry 保存：

- `shader`、`sourceKind`、`classification`；
- `directConsumers` 与所有 `runtimeConsumers`；
- 最近的 `pipelineOwners`；
- 仓库内 `generatorCandidates`；
- `deletionCandidate` 和当前状态说明。

生成结果必须保持确定性。修改 Shader import、pipeline owner 或 generator 后，同一提交必须重新运行 `npm run audit:shaders` 并提交 JSON 差异。
