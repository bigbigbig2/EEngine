# ADR-0012 · 产品级渲染管线硬切换重构

Status: accepted

Supersedes: ADR-0003 关于 Software/Hybrid Visibility 作为当前产品路径的默认设计；保留 ADR-0005 的单一主管线、ADR-0007 的桌面 WebGPU 与 mostly-static workload、ADR-0010/0011 的 VisibilityKey、Surface 和 GPU producer/consumer 约束。

## 背景

当前 OEngine 已经具备 GPU Scene、Packed Instances、Hierarchy/SSE、Hardware Visibility、Single Material Resolve、FrameGraph、Clustered Lighting、CSM、AO、SSR、Temporal 和 HDR Post 的多个局部实现，但效果组合、资源归属、历史管理和旧路径残留使 TAA、SSR、GTAO 及最终画面质量不稳定。

继续在旧 Renderer 上叠加局部参数或保留新旧双路径会扩大 composition debt，无法证明最终画质、性能和 Feature-off 行为。产品目标已经明确为桌面 WebGPU、高质量、中等偏高固定默认配置和 GPU-driven 主链，不再为低端设备维护兼容渲染路径。

## 决策

1. OEngine 采用一条统一的 GPU-driven FrameGraph 管线，固定概念阶段为 Scene Update、Visibility、Surface、Lighting、Transparency、Temporal、HDR Post、Present。
2. Opaque/Alpha-Test 使用 Hardware-first Visibility Buffer → Single Material Resolve；透明使用独立 Forward/OIT。Compute Software Raster、Mesh/Task Shader、硬件光追是未来可替换 Backend，不是当前 WebGPU 主路径或默认 fallback。
3. FrameGraph 是唯一执行编排层；Render Feature 声明输入、输出、依赖、配置和调试信息。默认单 CommandEncoder、单次主 Queue Submit。
4. GPU Scene 是渲染数据的长期真相。CPU 只提交资产/Transform/Light Patch、Frame 参数和 Graph 配置，不生成最终可见列表。
5. Lighting 采用统一线性 HDR PBR 合成：GPU Clustered Direct Lighting、Shadow Service、GI Service、Reflection Service 和 AO Service 共享 Surface Contract，不在最终颜色阶段互相硬乘或覆盖。
6. GI 首版为可独立存在的 Lightmap + Probe Volume 双层 Provider；反射固定为 Local Reflection Probe + SSSR correction + IBL fallback；AO 独立输出 Material AO、Diffuse Visibility、Specular Visibility 和 Bent Normal。
7. Temporal 是独立的 Temporal Reconstruction 子系统，默认 TAAU + DRS，内部隔离颜色、AO、Reflection/Confidence 历史，不替上游效果隐藏错误。
8. 默认配置为中等偏高，初始化 `RendererConfig` 可覆盖参数和 Feature 开关；不使用运行时 GPU Budget Governor，不设计 Low/Medium/High 三套真实管线。
9. 采用硬切换式重构：直接删除冲突旧实现，不建立过渡适配层、长期 fallback 或双生产路径。新管线主体完成或大部分完成后再建立正式示例验证。
10. 具体算法优先从许可证兼容且可追溯的成熟开源实现完整移植，不做仅保留表面流程的简化移植。验证通过后删除旧路径。

## 后果

- P1–P8 可以在同一重构分支中直接替换现有生产路径，阶段性不可运行不构成保留旧架构的理由；提交前必须恢复可构建、可验证状态。
- ADR-0003 中的 Software/Hybrid Visibility 继续作为研究和未来 Backend 参考，但不再生成当前默认产品路径或兼容分支。
- 现有 `Renderer.ts`、旧 Material Expand、重复 AO/SSR/Temporal composite、旧资源 owner 和手工 Pass 顺序都必须按真实引用重新归属或删除。
- 资产 Cooker、Runtime Asset Registry、GPU Resource Tables 与 Render Feature 保持分离；Lightmap、Probe、IBL 等重数据主要由离线工具生成。
- 画面不以当前实现为兼容基准；验收基准是设计文档定义的目标画质、性能、显存和可观测性。
- 开源移植必须在 `docs/references/porting/` 记录 source、commit/tag、路径、许可证、不变量、WebGPU 差异和 A/B 结果。

## 验证

- P0：源码映射覆盖所有生产 consumer、shader 和资源 owner；删除候选有引用证据；相关 ADR 和文档有替代关系。
- P1/P2：FrameGraph、Feature、ViewContext、GPU Scene Patch、配置、能力检查、Persistent/Transient 资源和单 submit 可观测。
- P3/P4：GPU producer → GPU consumer、Hardware Visibility、Surface ABI、Clustered Lighting、Shadow 和 HDR composition 通过 GPU timestamp、计数器和截图/数值回归。
- P5–P8：GI/Reflection/AO fallback、透明 OIT、Temporal history/resize/cut、HDR Post 和 Feature-off 通过固定序列验证。
- P9：Static Geometry、Dynamic Lighting、Indoor GI、Reflection、Temporal Stress、Heavy Workload 六组场景在 1920×1080、DPR1、中等偏高默认配置下完成画质、性能、显存和删除残留 Gate。
