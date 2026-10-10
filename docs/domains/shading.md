---
id: shading
kind: domain
owner: shading
state: current
verifies:
  - OEngine/src/render/surface/SurfaceV4.ts
  - OEngine/src/gpu/GpuNativeMaterialScene.ts
  - OEngine/src/shaders/native_material.ts
  - OEngine/src/shaders/native_surface.ts
  - OEngine/src/render/environment/PhysicalEnvironmentRuntime.ts
  - OEngine/src/shaders/native_environment_brdf.ts
  - OEngine/src/render/program/FrameProgramLowering.ts
---
# Shading

## 当前源码接线

核对日期：2026-10-10，当前工作树生产源码。Surface 和 LocalLightWork 使用唯一生产入口；最新 Lighting 阶段、验收结果与性能限制只读 [M3 执行计划](../next-execution/eengine-v4-lighting-execution-2026-10.md)。

[GpuNativeMaterialScene](../../OEngine/src/gpu/GpuNativeMaterialScene.ts) 从 scene material slots、GraphCompiler、TextureResidency 和 cooked Products 建立 immutable native publication。参数及 dynamic inputs 是实例数据；完整物理资源集合决定 BindingSet，Program 由 shader/layout 结构决定。async PSO 未就绪时延迟整 tick；成功提交才切 active，abort 保留 candidate 供 retry，旧 publication 按实际 fence 退休。

每个 authored material source 只保留一份当前 CPU code/binding snapshot。复用依据是 immutable compiled graph/Product、物理 bank view、set generation、texture route、mip 与 live publication 的精确身份和值；资源改变重新建立绑定，Scene resync/device loss 仍由原 owner 处理。每帧继续读取并验证 Standard 参数与 dynamic inputs，保留直接字段修改和 candidate/active/abort/retry 语义；稳定帧先比较绑定、Unlit 与数值，变化时才重建完整物理资源分组。该 CPU snapshot 不拥有 GPU 资源或 shading result。

[SurfaceV4](../../OEngine/src/render/surface/SurfaceV4.ts) 消费 r32 Visibility、MeshletWork、FrameGeometryArena/vertex sources、frame instances、native publication 与真实 LocalLightWork/VSM/IBL/AO/environment providers。Dense one-route 无 pixel queue；multi-route 在 GPU 构造 compact pixel bins 并 indirect native dispatch。winner geometry、C/X/Y、material、BRDF、lighting 默认在同一 shader 内求值，直接写 pre-exposed working-color HDR 和 demanded reactive。

[LocalLightWorkGenerator](../../OEngine/src/render/lighting/LocalLightWorkGenerator.ts) 借用 Scene-owned LightDatabase staged-or-active publication 和最终 raw winner/depth，产生 128B parameters/header、8B cluster ranges 与 typed complete/compact IDs。零 local lights 使用 NONE；非零生产默认 SPARSE，预算溢出以完整 DIRECT 同数学求值，自动非零 DIRECT 阈值仍禁用。Renderer 拥有 device-local async pipelines 与 fenced frame allocations，Surface 只读 finalized 产品；cache 图逐帧绑定参数/资源/command，不捕获旧 Scene，Lighting 不再要求 HZB。Sun、VSM、IBL、AO 保持独立 provider。

当前 native IBL 使用共享 `native_environment_brdf.ts`：physical/authored 的 DFG 均为 Fc/total visibility，消费系数 `mix(Fc,Total,F0)`；texel-centred NoV/roughness 做 clamp-to-edge 双线性。Clearcoat 以 Schlick NoV Fresnel 衰减 base lobes 并添加 coat，仍为既有 single-scatter profile。环境 diffuse 乘现有 AO/material occlusion，specular 尚无完整场景 sky visibility/GI。PhysicalEnvironment 的分项诊断参数被 native/Sky/Aerial 共同消费；它不改变 IBL cache identity，Unlit 保留自身颜色。

旧 LightClusterPass、cluster-centric kernels、16B metadata/CAS/private256、legacy lighting_direct 和不可达的 PackedTransparentOitPass/wrapper 已删除；透明并非当前 production producer。GpuFrameCounters schema29 封存旧 local-light 槽位，追加 finalized header 的按需采样复制，不能把这些字段解释为 BRDF evaluations 或真实 DRAM traffic。

全 sampled-resource profile 超过协商 limit 时使用有限 native sun continuation，读独立 HDR texture、写新 HDR 版本；不使用 read-write rgba16float storage 或 six-signal store。FrameGraph 管宏依赖及借给 Surface 的最终 HDR；Surface 只拥有执行 scratch 和必要 continuation intermediate，不 submit。

## 直接消费者与边界

NativeVisibilityPass 和 VSM native alpha caster 消费同一 native material publication。NativeTemporalFactsPass 从 winner、authoritative scene instances 与 native material versions 生成 motion、identity/reactive；motion 为 rg32float，身份历史保留完整 pair。FSR 消费 Temporal 的真实产品。background、Sky/Aerial、Radiometry/Post/Present 保持各自 owner。

旧 SurfaceWorkRuntime、GPU Tape/ExactDag interpreter、Closure Cache、coherence、field/signal heap、global Signal History 和 generic opaque Reconstruct 已从本工作树删除；不保留 adapter 或第二条生产路径。资产 cook、Graph 数学/CPU oracle、Geometry、providers、FrameGraph 与 Registry 生命周期继续由真实 owner 持有。历史 B2 数值失败没有被追认为修复；存活语义由 native update/publication/abort-retry/HDR 测试承担。

## 仍需验证

当前单机完整authored场景、streamed多Product、Lighting矩阵和受控恢复/释放的实际覆盖读执行记录；跨浏览器/GPU、完整AAA画质、超出本轮窗口的长序列/极值峰值与正式evidence/claims仍未完成。小场景闭包或预算有界不能证明这些结果，非Surface基线失败继续留在对应执行计划。

未来接口见[V4 母稿](../next-design/eengine-v4-native-shading-2026-10.md)，来源与 adoption 边界见[porting ledger](../porting/next-renderer.md)。算法 history/cache 属于算法 owner，Surface 不恢复通用记录或 reuse 操作系统。
