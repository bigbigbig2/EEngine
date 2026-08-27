# 渲染画质参考

当前画质目标是为中大型高密度场景建立高质量 PBR/IBL/CSM、动态灯光和 Temporal/Upscaling 闭环，不建设所有 AAA 内容系统。

## 当前参考

| 领域 | 首选参考 | 当前用途 |
|---|---|---|
| Standard PBR / IBL | Filament、glTF Sample Viewer、glTF spec | metallic-roughness、颜色空间、tangent、BRDF、IBL reference |
| Visibility shading | The Forge TVB | single resolve、Forward+、OIT |
| 动态灯光 | The Forge/AnKi clustered/forward+ | GPU Light Table、cluster list、overflow |
| 阴影 | 当前 CSM + AnKi GPU shadow work | cascade work generation、稳定性、过滤和成本 |
| Temporal | 现有 OEngine/可迁移项目 + Falcor 算法对照 | velocity、history、disocclusion、reconstruction |
| Upscaling | 已有可许可项目/公开算法 | internal/output resolution、dynamic resolution、sharpen |

## 当前顺序

1. Single Material Resolve 输出稳定 Surface/Velocity。
2. Standard PBR/IBL 对齐数值和 HDR 截图 reference。
3. Clustered Lighting 扩展到大量动态灯光，并验证 list overflow/最坏重叠。
4. 保留 CSM，量化 main/cascade traversal、raster 和 atlas 成本。
5. 接入 Transparency/Decal seam。
6. 建立 Temporal Reconstruction、Dynamic Resolution 与 Upscaling。
7. 只有明确项目和 benchmark 时迁移更高级 GI/体积/内容效果。

## Deferred

Virtual Shadow Maps、ReSTIR/Lumen-like GI、terrain/foliage/hair、volumetric cloud/ocean/atmosphere 不属于当前核心实现。未来迁移必须复用统一 Depth/HZB/Surface/Velocity/Lighting 和 FrameGraph seam。
