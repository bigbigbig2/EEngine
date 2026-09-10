# OEngine WebGPU 2026 能力合同

状态：目标平台规范。审查快照：2026-09-10。

本页定义 OEngine 对 WebGPU/WGSL 的唯一能力口径。API 与 Shader 语义以 [GPUWeb WebGPU Editor's Draft](https://gpuweb.github.io/gpuweb/) 和 [WGSL Editor's Draft](https://gpuweb.github.io/gpuweb/wgsl/) 为准；[MDN `GPUSupportedFeatures`](https://developer.mozilla.org/en-US/docs/Web/API/GPUSupportedFeatures)、[MDN texture format tiers](https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/createTexture) 与 [MDN transient attachment](https://developer.mozilla.org/en-US/docs/Web/API/GPUTexture/usage) 只用于浏览器暴露方式和兼容性核对。GPUWeb proposal 索引中的 merged 只表示已经合入规范，不能替代规范正文或目标浏览器实测。

## 产品能力线

OEngine 的主要产品能力线是 **WebGPU 2026 Desktop**，替代过去含义不清的“WebGPU baseline”或“High-2026”：

- 请求并验证 core adapter；`adapter.features` 必须包含 `core-features-and-limits`，不把 compatibility mode 当作目标性能平台。
- 以一条 Renderer、同一 FrameProducts、同一 GPU queue/asset ABI 承载能力 specialization；不存在 Core/Portable 两套主管线。
- 先读取 `adapter.features`、`adapter.limits` 与 `navigator.gpu.wgslLanguageFeatures`，只把当前配置和已创建 owner 真正会使用的可选能力放入 `requiredFeatures` / `requiredLimits`。
- `device.features` 是实际启用集合；Shader、pipeline、asset variant、FrameGraph cache key 和 benchmark provenance 必须使用这一集合，而不能根据浏览器版本或 GPU 型号猜测。
- 可选能力缺失时只能走同一逻辑合同的正确 specialization，或在创建任何依赖资源前明确拒绝初始化；不得静默编译错误 Shader、改变 ABI 语义或回退为 CPU 最终可见列表。

`requestAdapter({ featureLevel: "core", powerPreference: "high-performance" })` 是目标表达；为兼容尚未暴露 `featureLevel` 的浏览器，最终仍以 `core-features-and-limits` 的实际探测结果为准。

## 生产能力集合

下表是能力策略，不表示当前代码已全部落地。当前实现状态以 `STATUS.md` 为准。

| 能力 | WebGPU 2026 Desktop 策略 | OEngine 用途 | 无能力时的合同 |
| --- | --- | --- | --- |
| `core-features-and-limits` | 必需 | core WebGPU limits/validation 和现代图形 API 能力线 | 初始化失败；不降为 compatibility profile |
| `indirect-first-instance` | 主路径需要时必需 | GPU work slot/range 到 indirect draw 的稳定映射 | 使用不依赖非零 `firstInstance` 的等价 mapping |
| `subgroups` | 默认优先启用 | queue compact、classification、scan/reduction、histogram | workgroup shared memory/atomic specialization；不得假设固定 subgroup size |
| `primitive-index` | Visibility V2 默认优先启用 | fragment 阶段恢复 rasterized local primitive identity | 保持 meshlet work + local triangle 的等价 identity mapping |
| `shader-f16` | 精度审计通过后优先启用 | 非 identity、非 depth、非 history-critical 的局部算术和中间值 | f32 specialization |
| `texture-formats-tier1` | 目标 Surface/HZB 格式需要时必需 | 扩展 render/storage format 集；隐式包含 `rg11b10ufloat-renderable` | 选择 core-compatible format，或在无等价格式时拒绝配置 |
| `texture-formats-tier2` | 按具体 read-write storage format 启用 | 紧凑 Surface/HDR/compute 中间格式 | Tier 1/core-compatible format；不得只因 tier 名称启用 |
| `texture-compression-bc` / `etc2` / `astc` | 选择 adapter 支持且资产实际存在的一族 | 直接上传和采样 Cooked GPU-compressed texture | 选择另一兼容压缩 variant 或显式 uncompressed variant |
| `texture-compression-unaligned` | 工具链支持后按资产尺寸启用 | 允许 mip 0 存在 partial edge block | Cooker padding/尺寸对齐；当前 `@webgpu/types` 尚未声明该名称 |
| `timestamp-query` | 正式性能证据优先需要，但不是渲染正确性前提 | GPU frame/phase timing | 标记 unavailable；CPU timing 不冒充 GPU timing |
| `subgroup-size-control` | 仅固定宽度算法有证据时启用 | 指定 `@subgroup_size` | 不固定宽度的 subgroup 或 workgroup specialization |
| `texture-component-swizzle` | 仅能删除真实转换/复制时启用 | texture view 通道重映射 | Cooker/runtime 显式通道布局 |
| `float32-filterable`、`float32-blendable`、`bgra8unorm-storage`、`clip-distances`、`dual-source-blending`、depth/3D compression features | 按 consumer 和格式逐项启用 | 特定 attachment、sampling、blend、clip 或 3D asset path | 等价格式/Shader specialization，或拒绝相关配置 |

WebGPU 规范保证 core adapter 至少支持 BC，或同时支持 ETC2 与 ASTC；这不等于 Runtime 可以任意选择格式。Cooker 必须生成有声明的 variant，Asset Store 再按实际启用能力选择，不能把三族压缩格式全部列为设备硬要求。

## 2026 Core API 能力

Immediate Data 与 Transient Attachments 已进入 2026 WebGPU/WGSL 规范，但不是 `GPUFeatureName`，不得写入 `requiredFeatures`。

### Immediate Data

使用前同时验证：

- `GPUPipelineLayoutDescriptor.immediateSize` 和 pass encoder `setImmediates()` 的 API surface；
- `device.limits.maxImmediateSize` 满足所需字节数，默认 core limit 为 64 bytes；
- `navigator.gpu.wgslLanguageFeatures` 包含 `immediate_address_space`；
- WGSL 使用 `requires immediate_address_space;`，pipeline layout 显式声明 `immediateSize`。

它只替代高频、小尺寸 pass/draw constants。大块数据、动态数组和长期资源仍走 buffer/bind group。缺失时使用同布局语义的 tiny uniform/ring-buffer specialization。

### Transient Attachments

使用前验证 `GPUTextureUsage.TRANSIENT_ATTACHMENT` API surface，并只用于真正 render-pass-local、单 mip、单 array layer 的 2D attachment。Texture usage 固定为 `RENDER_ATTACHMENT | TRANSIENT_ATTACHMENT`，`viewFormats` 为空；render pass 对相应 aspect 使用 `loadOp: "clear"` / `storeOp: "discard"`。它不得再带 sampled/storage/copy usage，不得作为 resolve target、canvas texture 或后续 FrameProduct；禁止把需要跨 Pass 读取的 depth、Surface、history 标为 transient。

它是内存/带宽优化提示，不是 FrameGraph 通用 aliasing 许可。缺失时使用普通 `RENDER_ATTACHMENT`，资源 lifetime 与结果语义不变。

## Shader 能力规则

- `enable f16;`、`enable subgroups;`、`enable primitive_index;` 和 `enable subgroup_size_control;` 只能出现在对应 `device.features` 已启用的模块 variant 中。
- `subgroup-size-control` 隐式依赖 `subgroups`；`texture-formats-tier2` 隐式依赖 Tier 1，Tier 1 隐式依赖 `rg11b10ufloat-renderable`。设备请求、cache key 和 evidence 要保存最终闭包。
- 未启用 `subgroup-size-control` 时，算法必须覆盖 `subgroupMinSize..subgroupMaxSize`，不得硬编码 32/64 lanes。
- f16 不能承载 VisibilityKey、稳定 handle、队列计数、depth comparison、world position accumulation 或 history identity；每个 f16 specialization 都要有数值误差和性能证据。
- `primitive_index` 只提供 primitive identity 输入，不自动解决 draw/work slot、meshlet identity、barycentric、derivative 或 LOD 合同。

## 不进入能力基线

截至本快照，multi-draw-indirect、mesh/task shader、buffer device address、通用 bindless/resource table、64 位通用原子以及 draft 的 sized binding arrays、subgroup matrix、view instancing 不是 OEngine WebGPU 2026 Desktop 的生产依赖。只有它们进入规范、目标浏览器稳定暴露、类型/CTS/运行验证齐全且新 ADR 证明必要时，才可改变本页。

## Capability record

Renderer 初始化后必须冻结一份 capability record，至少包含：

```text
adapter identity + fallback flag
requested featureLevel / observed core-features-and-limits
adapter features
requested features and limits
device features and limits
WGSL language features
immediate-data API + maxImmediateSize
transient-attachment API
selected shader/format/compression specializations
```

FrameGraph/pipeline cache key记录影响布局、Shader 或资源格式的 specialization。综合 benchmark 保存完整 capability fingerprint；不为 Portable 与 WebGPU 2026 Desktop 各复制一套正式基准。fallback 改动只补命中的正确性/parity 验证。

## 更新规则

1. 每次浏览器、`@webgpu/types` 或 WebGPU/WGSL 规范升级，重新核对 feature enum、feature dependency、limits、WGSL enable/language extensions 和 CTS。
2. 规范语义以 GPUWeb/WGSL 为准；MDN 的 Baseline/compatibility 状态只决定探测和发布范围，不改变 API 语义。
3. 只在生产 owner、fallback、feature-off、验证和 provenance 均有落点时，把能力从“候选”提升为生产 specialization。
4. `STATUS.md` 记录已落地能力和差距；ADR 记录改变产品能力线的长期决定；`docs/others/` 仅是研究输入，不覆盖本页。
