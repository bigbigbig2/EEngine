# ADR-0006 · Packed Render World 收敛与实施顺序

Status: accepted；能力口径由 [ADR-0010](./0010-webgpu-2026-capability-contract.md) 修订

Implementation: completed through Step 7 on 2026-09-09; Step 8 remains evidence-triggered follow-up work.

## Context

OEngine 已有两组同时存在的场景 GPU owner：

- 普通 Scene 通过 `GPUSceneManager` 和 `GPUSceneContext` 持有 legacy geometry、material、skinning、light、environment 与 shadow 状态；
- Packed Scene 通过当前 `GpuRenderWorld` 组合 `GpuAssetStore`、`GpuScene`、`GpuMaterialStore` 与 `TextureResidency`，并由 GPU hierarchy、exact raster work 和 indirect draw 形成 VisibilityKey producer/consumer 闭环。

Packed 主路径仍会先创建和更新 `GPUSceneContext`。Packed 注册还会向 `GPUMaterialRegistry` 注册相同材质，因此一个 Packed 材质同时触发 legacy material uniform、texture/bind-group、Material Expand pipeline，以及 Packed material/texture residency。Lighting、environment 和 shadow 又继续从 legacy scene context 取得资源。`Renderer.ts` 因而同时承担双路径选择、FrameGraph recipe、Feature/Service 组合、history、evidence 和生命周期收尾。

这与 [ADR-0002](./0002-runtime-assets-and-gpu-driven.md) 的唯一 GPU owner、[ADR-0003](./0003-unified-render-pipeline.md) 的单一主管线，以及 [ADR-0004](./0004-visibility-to-surface.md) 的统一 Surface 合同之间存在迁移债务。迁移必须保留 ADR-0010 的 WebGPU 2026 Desktop 能力合同、GPU producer 到 GPU consumer 闭环、mostly-static 加显式 patch、feature-off 接近零成本和单 main submit，不扩张完整 ECS、Gameplay 生命周期或第二套质量管线。

当前单机历史性能数字不作为本决定的排序依据。每一步只根据当前源码 owner、正确性和按 [VALIDATION.md](../VALIDATION.md) 重新产生的同条件证据进入下一步。

## Decision

### 目标边界

最终运行结构固定为：

```text
Application Scene / Packed source
               │
               ▼
       Scene Render Adapter
               │  deterministic delta
               ▼
┌──────── Authoritative GPU Render World ────────┐
│ GpuAssetStore          geometry residency      │
│ GpuScene               instances and patches  │
│ GpuMaterialStore       material records        │
│ TextureResidency       sampled textures        │
│ GPU light/environment owner                    │
└────────────────────────┬───────────────────────┘
                         ▼
                    FrameContext
                         ▼
                MainRenderPipeline
 Visibility → Surface → Lighting → Transparency
              → Temporal → Post
                         ▼
                    FrameGraph
                         ▼
                   one main submit
```

`Scene Render Adapter` 是 Application World 到现有 GPU owner 的增量适配 seam，不是 ECS，也不保存第二份长期 GPU world。普通 Scene 与 Packed source 可以有不同的导入和变更适配器，但必须汇入同一组 GPU owner、FrameProducts 和主管线消费者。

以下约束在整个迁移期间保持成立：

- 一个 GPU record/table/texture bank 只能有一个生命周期 owner；迁移桥不得长期复制同一事实；
- Packed 帧不得创建或更新未被其 GPU consumer 使用的 legacy geometry、material、skinning 或 draw-list owner；
- lights/environment 是场景 GPU 数据，shadow atlas、shadow work generation 和 shadow raster 是 Render Feature；`src/gpu` 不拥有具体 Pass 顺序；
- `Renderer` 只保留公开 API、设备/画布生命周期和顶层组合；FrameGraph recipe、Feature 顺序与 graph cache 由 `MainRenderPipeline` 持有；
- 普通 Scene 的迁移按 opaque、velocity、transparency、skinning 等垂直切片进行；一个切片的新路径通过验证后立即删除对应 legacy consumer，不增加永久兼容层；
- Feature 关闭时不创建 owner、Pass、attachment、history、readback、counter copy 或独立 submit；
- 任何新增队列或表必须同步定义 ABI、容量、overflow、producer、consumer、统计与销毁；
- WebGPU capability 遵循 ADR-0010：主路径优先使用已标准化且已协商的 subgroup 等 2026 能力；64 位原子、multi-draw-indirect、mesh/task shader、buffer device address 和 Draft 能力不能成为生产前提；
- 每一步使用独立提交完成，使失败可以按提交回退；不得用长期双写或运行时开关代替迁移完成。

### Step 0 · 建立收敛门禁

目标是在删除 owner 前建立少量、高价值的架构回归，不恢复随实现细节增长的大型历史测试集合。

实施内容：

1. 增加 Packed Render World contract 测试，覆盖 Packed stage、commit、abort、release 和稳定帧。
2. 增加 owner 创建证据，至少能够区分 legacy material、legacy geometry、Packed asset、Packed instance、Packed material 和 texture bank 是否创建。
3. 增加 submit、graph build/cache、upload/readback 和 feature-owned resource 断言。
4. 为 Texture Residency 增加加载排列、容量边界、rollback 和 release/reuse 测试夹具。
5. 保留现有 Browser Validation Registry；领域断言留在 fixture，Runner 不理解渲染实现。

必须验证：

```powershell
Set-Location OEngine
npm test

Set-Location ../examples
npm run test:validation-tools
npm run verify -- smoke.basic
npm run verify -- lifecycle.init-destroy
npm run verify -- visibility.basic
npm run verify -- surface.basic
npm run verify -- surface.textured
```

退出条件：

- 测试能够在故意创建 legacy owner、增加额外 submit、保留 feature-off 资源或破坏事务 rollback 时失败；
- 浏览器结果没有 validation error、uncaptured error 或 device loss；
- 测试不依赖类名存在或 DOM 文本来推断 GPU producer/consumer。

### Step 1 · 消除 Packed material 双 owner

目标是让 Packed 材质只由 `GpuMaterialStore` 和 `TextureResidency` 驻留。

实施内容：

1. 删除现 `GpuRenderWorld.stage()` 对 `GPUMaterialRegistry.obtain()` 的调用。
2. 将 `GraphicsContext` 中的 legacy material registry 改为只在 legacy consumer 首次请求时创建；Packed-only 初始化不得创建 legacy material metadata、默认纹理、Material Expand pipeline 或 per-material uniform/bind group。
3. 确认 Packed shadow、transparency、debug 与 material patch 全部使用 `GpuPackedMaterialBindings`，不得从 legacy registry 回取资源。
4. 保持 TextureResidency stage 与 GpuMaterialStore stage 的事务顺序；任一阶段失败时恢复 texture refcount、material slots 和 pending mutation。
5. 增加 legacy-owner creation、Packed material patch 和资源释放证据。

必须验证：

- Packed stage/abort/release 的 CPU contract 测试；
- `surface.basic`、`surface.textured`、`surface.material-switch`、`surface.texture-fallback`；
- `visibility.basic`，确认 VisibilityKey、RasterWork、indirect args 和 overflow counter 不变；
- Packed transparency 与 shadow 命中场景，确认不再依赖 legacy material bind group；
- 资源证据中 legacy material context、Material Expand pipeline 和 legacy material texture owner 均为未创建。

退出条件：

- `GpuRenderWorld`、Packed Visibility、Packed Surface、Packed Shadow 和 Packed Transparency 到 `GPUMaterialRegistry` 的生产依赖为零；
- Packed-only 帧没有 legacy material upload、pipeline 或 bind-group 创建；
- 普通 Scene 的 legacy 材质行为保持不变，直到 Step 6 迁移它的消费者。

### Step 2 · 使 Texture Residency 与加载顺序无关

目标是让同一资产集合在任意合法加载顺序下获得相同成功/失败语义和相同质量上限，不再由第一次 high-bank transaction 隐式决定后续可加载尺寸与容量。

先执行方案选择：

1. 在 [shading porting ledger](../porting/shading.md) 检查并登记采用的外部算法或实现；没有采用外部表达性代码时记录为 OEngine-authored policy。
2. 比较至少两类候选：有界 size-class banks，以及保持 TextureRef 稳定的可迁移 bank；不得假设 binding arrays、descriptor indexing 或其他非基线能力。
3. 对候选记录 TextureRef bits、bank 数、sampled-texture binding 数、shader branch、增长峰值、copy/resize dispatch、fragmentation、feature-off 和 device-limit 行为。
4. 用相同纹理集合和排列运行局部 benchmark；只有证据满足预算后才锁定具体 bank 数与尺寸等级。

被选实现必须满足：

- TextureRef 明确定义 invalid、bank class、layer 和版本；CPU/WGSL 只有一份 ABI 事实源；
- 每个 bank 有容量、free list、增长或封顶、overflow、refcount、retire 和 accounting；
- 新 bank/增长在 command transaction 中提交，abort 不发布新 ref；旧资源在提交完成后销毁；
- 未使用的 bank 不分配；降低质量上限不会意外降低允许的逻辑纹理数量；
- 超出 renderer policy 或 device limit 时在 preflight 失败，不留下部分 residency；
- Packed Surface、Packed Transparency、Shadow alpha sampling 和 debug view 使用相同 TextureRef decode。

必须验证：

- `512 → 2048`、`2048 → 512`、多批小纹理后追加大纹理，以及同集合随机排列；
- bank 容量恰好填满、超过一层、release 后复用、重复材质引用、stage abort 和 device-limit 边界；
- CPU TextureRef encode/decode 与 WGSL readback oracle 一致；
- `surface.textured`、`surface.texture-fallback`、Packed transparency 和 alpha-tested shadow；
- 相同 adapter、浏览器、分辨率、纹理集合与 warm-up 下比较 GPU P50/P95、CPU build/submit、resident、transient 和增长峰值。

退出条件：

- 合法资产集合不因加载顺序不同出现不同结果；
- resident logical 与增长期间 allocated peak 均在已声明预算内；
- shader sampling parity 通过，且没有新增无消费者 Pass、readback 或 submit。

### Step 3 · Packed frame 脱离完整 GPUSceneContext

目标是让 Packed frame 只同步 Packed geometry/instance/material 和共享 light/environment 数据，不再创建完整 legacy scene runtime。

实施内容：

1. 将当前 `GPUSceneContext` 拆为共享场景环境 owner 与临时 legacy geometry owner。共享 owner 只包含 lights、environment 和当前仍需要的 light-probe 数据。
2. 让 `GPUViewContext` 依赖 camera/view/HZB 与共享场景环境，不依赖 legacy geometry/material/skinning context。
3. Renderer 先判断场景是否有 Packed runtime；Packed 分支不得调用 `GPUSceneManager.obtain()` 创建 legacy geometry context，也不得调用 legacy `encodeFrame()`。
4. SceneChangeSet 继续为普通 Scene consumer 提供独立 revision；Packed patch 继续由当前 `GpuRenderWorld` 和 `GpuScene` 的显式 batch 负责。
5. 在 frame bindings 中把 geometry source 表达为互斥输入；不得同时发布 packed 与 legacy geometry consumer。

必须验证：

- Packed stable frame、transform patch、material patch、scene replacement、release/re-register；
- `lifecycle.init-destroy`、`lifecycle.recreate-renderer`、`lifecycle.replace-scene`；
- `visibility.frustum`、`visibility.occlusion`、`visibility.lod-near`、`visibility.lod-far`、`visibility.camera-cut`；
- owner evidence 中 legacy geometry table、legacy scene database、legacy skinning 和 MeshletDrawList 均未创建或更新；
- stable Packed frame 的 upload bytes 不包含 legacy scene upload，仍只有一个 main submit。

退出条件：

- Packed frame 从 Application Scene 读取 light/environment 和显式 Packed patch，但不扫描对象树构造最终可见列表；
- Packed scene 的 GPU geometry、instance、material 和 texture owner 唯一；
- 普通 Scene 暂存 legacy geometry 分支仍可运行，且没有扩张新功能。

### Step 4 · 将 Shadow 和 light orchestration 放回 Render 层

目标是消除 `src/gpu` 对具体 render Pass、ViewContext 和 CameraState 的反向依赖。

实施内容：

1. 新建统一 Shadow Feature/Service，拥有 shadow atlas、cascade selection、history/cache、Packed work generation、raster consumer 和 feature-off retire。
2. GPU light/environment owner 只发布稳定 light database 和环境资源；不 import 或构造具体 render Pass。
3. Shadow Feature 在迁移期间可以选择 Packed 或 legacy caster adapter，但两者共享 `ShadowVisibilityFrame`、atlas 生命周期、counter 和设置合同。
4. Renderer 只把 shadow 设置和 frame inputs 交给 Main pipeline；不直接调用 shadow selection/draw 算法。
5. 移除 GPU 层到 `render/passes`、GPU view 和 render camera state 的生产 import。

必须验证：

- directional cascade fit、texel snapping、cache hit/miss、alpha-tested caster、overflow 和 atlas accounting；
- shadows off 时无 atlas、shadow work buffers、shadow Pass、counter copy 或独立 submit；
- resize、camera cut、scene replacement、toggle off/on 和 device loss 后资源/history 语义；
- Packed 与普通 Scene 在相同 fixture 上的 cascade/debug view 数值或截图对照；
- Rendering Lab workload 和 shadow feature-off 对照，记录 main submit、GPU phase、CPU shadow setup 和 memory。

退出条件：

- `src/gpu` 不再依赖具体 render Pass 或 ViewContext；
- Shadow Feature 成为 atlas、Pass 顺序和 retire 的唯一 owner；
- Packed frame 不因启用 shadow 而重新创建 legacy material/geometry owner。

### Step 5 · 提取 FrameContext 与 MainRenderPipeline

目标是让 Renderer 成为 composition shell，同时避免把双路径永久封装进新层。

实施内容：

1. 建立不可变 `FrameContext`，只包含本帧 camera/view、resolution domain、feature topology、history validity、scene bindings、instrumentation 和 capture 请求；不把完整 Renderer 或 GraphicsContext 当作 service locator 传入 Pass。
2. 建立 `MainRenderPipeline`，拥有统一 Feature 顺序、FrameProducts 连接、FrameGraph recipe、compiled graph cache 和 graph evidence。
3. Feature 完整拥有内部 Pass 和按需资源；Renderer 不知道一个 Feature 内部有几个 Pass。
4. 将 lighting、AO、reflection、GI、transparency、temporal 和 post 的 graph composition 逐段迁入 Main pipeline，每次迁移保持 graph dump 和运行结果等价。
5. Renderer 保留 device/canvas 生命周期、public configuration、begin/sync/build/execute/submit 和顶层异常收尾。

必须验证：

- 固定 feature matrix 下迁移前后 executable order、resource domain、imported/transient owner 和 enabled/culled 状态等价；
- 相同 feature set 与尺寸的稳定帧复用 compiled graph，不重复构建 pipeline/bind group；
- full、每个 feature-off 组合、debug view、capture、resize、camera cut 和 abort；
- 每帧一个 FrameCoordinator command context 和一个 main submit；异步 evidence 不阻塞帧循环；
- Renderer 不再直接创建算法 Pass，也不直接持有 shadow/AO/SSR/post 的具体资源。

退出条件：

- Renderer 的主 render 函数只表达 frame lifecycle 与顶层组合；
- MainRenderPipeline 是唯一主管线 recipe owner，不存在 Core/Quality/Experimental 复制；
- graph cache key 覆盖 capability、尺寸、feature topology、visibility backend、instrumentation 和 history format。

### Step 6 · 将普通 Scene 垂直迁移到统一 GPU Render World

目标是让普通 Scene 成为 Application World adapter，而不是第二套 GPU renderer。

迁移顺序固定为：

1. Geometry/material residency：普通 Mesh 引用转换为稳定 Runtime Asset/GpuAssetStore handle 和 GpuMaterialStore slot；Loader 不拥有 GPU 资源，昂贵 cooker 工作优先离线完成。
2. Instances/patch：首次同步生成 bulk InstanceSource，稳定帧只消费 SceneChangeSet；transform、material、add/remove/reparent 使用确定性 patch 或明确 full-resync。
3. Opaque visibility/surface：普通 Scene 改用 hierarchy/work generation、VisibilityKey 和统一 Surface；通过后删除它对应的 legacy Visibility 与 Material Expand consumer。
4. Velocity/temporal metadata：普通 Scene 输出与 Packed 相同的 velocity、motion invalid 和 surface metadata 合同；通过后删除独立 Velocity consumer。
5. Transparency：普通 Scene 透明实例进入统一有界 raster work 和 Transparency Feature；通过后删除 legacy OIT。
6. Skinning/animation：按当前产品范围迁移仍需保留的最小能力；未进入产品范围的能力必须显式报 unsupported，不能静默把整条 legacy renderer 留作 fallback。

每个垂直切片必须验证：

- CPU reference 或旧路径只作为测试 oracle，不在生产帧双写；
- instance add/remove/reparent、transform、material、bounds、light 和 history revision；
- opaque、alpha-tested、double-sided、transparent、静态与动态实例；
- VisibilityKey、Surface attachments、velocity、reactive、shadow 和 debug view parity；
- stable frame 无全场景扫描和全量 GPU upload；overflow fail-visible；
- Packed 与普通 Scene 使用相同 FrameProducts consumer，feature-off 和 submit 证据一致。

退出条件：

- 普通 Scene 和 Packed source 只在导入/变更适配层不同；
- 最终可见工作由相同 GPU work queue 直接供 indirect consumer；
- 普通 Scene 不再需要 legacy scene database、mesh/triangle ID attachments、Material Expand、独立 Velocity 或 legacy OIT。

### Step 7 · 删除 legacy runtime 和兼容分支

目标是在所有消费者迁移后删除重复 owner，而不是将其降级为隐藏 fallback。

实施内容：

1. 删除 legacy Visibility、Material Expand、独立 Velocity、legacy OIT、MeshletDrawList 和不再需要的 scene database/material metadata GPU owner。
2. 删除 Renderer 中 packed/legacy graph recipe 分支和对应 cache-key 维度。
3. 删除旧 shader、bind-group layout、pipeline、counter、debug label、resource accounting 与公开类型；先确认真实 consumer 和 generated source owner。
4. 收窄 GraphicsContext，只保留设备级 allocator/cache 和权威 GPU Render World owner；Feature 只接收所需接口。
5. 更新 [ARCHITECTURE.md](../ARCHITECTURE.md)、[PIPELINE.md](../PIPELINE.md) 与 [STATUS.md](../STATUS.md)，将迁移后的实现写为当前事实。

必须验证：

- 静态依赖检查确认旧 owner、Pass、shader 和 import 没有生产 consumer；
- 完整 CPU/build 测试、所有 Canonical Browser Validation Case、Rendering Lab workload、VisibilityKey oracle 和 shader source audit；
- clean commit 上运行正式性能策略，记录三个独立 browser context、固定 workload/camera、warm-up、采样、adapter/browser provenance、GPU counter/timestamp、memory 和 diagnostics；
- 对比迁移前冻结基线，分别报告 CPU frame/build/submit、GPU phase、submit、upload/readback、resident/transient/history/shadow 与 feature-off；
- 1080p/60 FPS 仍只在满足产品证据合同后宣称完成。

退出条件：

- 生产代码只有一个 GPU Render World、一个 Visibility-to-Surface 合同和一条主管线；
- Packed 与普通 Scene 没有重复 GPU owner或最终 consumer；
- 关闭功能时对应 Pass、资源、history、readback 和额外 submit 均缺席；
- 文档、source audit、browser evidence 和 benchmark artifact 指向相同 owner。

Step 7 已按上述退出条件实施。`2392e4a` 删除 legacy runtime、重复 owner、兼容 graph 分支及其实际消费者，`520c2b0` 清除剩余的旧能力标签、采样默认键与无效 loader fallback 提示。完整 CPU/build、27 个 Canonical Browser Validation Case、Rendering Lab workload/feature-off matrix、VisibilityKey oracle 与 shader source audit 均通过；正式 clean-commit A/B 每侧使用 3 个独立 browser context、120 帧 warm-up 和 480 帧采样。机器可读结果见 [`OEngine/benchmarks/render-world-convergence-step7.json`](../../OEngine/benchmarks/render-world-convergence-step7.json)。

该证据只覆盖 NVIDIA Turing 上的固定 1920×1080 workload。Triangle Setup、Surface ABI 和双 vendor Tile backend 门禁仍为 `insufficient-evidence`，因此本 ADR 的架构实施完成不构成 1080p/60 FPS 产品目标声明。

### Step 8 · 证据触发的后续优化

以下工作不阻塞架构收敛，不得只因文件较大或理论内存估算提前插队。

#### Instance ABI

先用目标 workload 测量 192-byte record、CPU shadow、patch expansion 和 shader bandwidth。只有 resident 或 patch 带宽成为已证明瓶颈时，才比较当前 AoS 与 metadata/current-transform/optional-motion 拆表。候选必须检查额外 storage binding、随机读取和 WebGPU limit；目标门槛为静态实例 resident 明显下降、transform patch upload 明显下降且 Visibility/Surface GPU P95 无显著回退。具体阈值在冻结 benchmark 前进入 STATUS 或机器可读 gate，不写死在 ADR。

#### Public API

将 diagnostics、benchmark、inspector 和 experimental 能力放入 package subpath；根入口只保留稳定 Application API、Runtime Asset、Renderer 配置和明确需要的 evidence seam。移除导出前搜索仓库外调用方，并将 breaking change 写入发布说明。

#### FrameGraph execution state

当前 compiled graph 已显式接收 per-frame bindings，但代理解析仍使用 module-level active state。只有需要同一 JS realm 的 nested/reentrant execution、并行编码或该状态造成真实缺陷时，才改为 execution-local binding resolver；普通 sequential multi-view 不作为提前重写理由。

#### Loader canonical IR

现有 glTF 两个入口已共享 parser 和部分 geometry/material helper。只有实际发生行为漂移或普通 Scene 迁移需要统一静态/动画 projection 时，才增加 canonical asset IR；IR 不拥有 GPU 资源，也不得让运行时重复昂贵 cooker 工作。

### 提交与执行规则

每一步按以下顺序执行：

1. 先加入会在旧缺陷上失败的最小 contract、counter 或 browser assertion；
2. 修改一个 owner 边界并迁移命中消费者；
3. 删除该切片已无消费者的桥、资源和 dead code；
4. 运行本步骤测试和公共验证矩阵；
5. 检查工作区只包含本步骤文件与有意生成的 artifact；
6. 用独立提交保存该垂直切片，再进入下一步。

如果某一步需要新的 optional WebGPU capability、第二条主管线、CPU readback 控制可见工作、长期双写或完整 ECS，则停止实施并新增 ADR，不得在本决定下自行扩张范围。

## Consequences

- 迁移初期会增加 adapter 和测试 seam，但不会增加第二份长期 GPU world；所有临时桥都有明确删除步骤。
- Packed material、geometry、instance 和 texture 的隐藏 legacy 成本先被移除，能够在 Renderer 大拆分前获得可测量收益并降低后续改动面。
- Texture Residency 的具体数据结构由同条件证据决定；加载顺序无关、稳定 TextureRef、事务和预算是固定合同。
- Shadow ownership 从 GPU 数据层移动到 Render Feature，修复依赖方向，并允许 Packed frame 独立于 legacy GPUSceneContext。
- MainRenderPipeline 在 owner 收敛后接管 graph recipe，避免把迁移分支永久固化成新的抽象。
- 普通 Scene 保留 Application API，但最终成为统一 GPU Render World 的增量输入；不再拥有独立 renderer。
- Instance ABI、FrameGraph global state、Loader IR 和纯文件拆分延后到证据触发，避免用大规模重构替代当前最重要的 owner 收敛。

## Verification

每个步骤至少执行本节公共矩阵和该步骤列出的领域验证。

### 静态与 CPU 验证

```powershell
Set-Location OEngine
npm ci
npm test
npm run audit:shaders

Set-Location ../examples
npm run test:validation-tools
npm run build
```

检查项：

- 类型、构建、ABI encode/decode、transaction commit/abort/release；
- import direction、公开入口、dead consumer、shader owner 和文档 allowlist；
- GPU queue schema、capacity、attempted/written/overflow 和 indirect args；
- graph cache、feature-off、submit、upload/readback 和 resource accounting。

### 浏览器验证

开发迭代使用：

```powershell
Set-Location examples
npm run verify -- changed
```

合并前至少覆盖命中的 Smoke、Lifecycle、Visibility 和 Surface Case。涉及完整 lighting、shadow、transparency、temporal 或 post composition 时运行 Rendering Lab workload；涉及 VisibilityKey/Surface ABI 时同时运行 oracle。浏览器 console error、page error、request failure、GPU validation/uncaptured error、device loss、陈旧 run/frame 或失败 assertion 均为失败。

### 性能与内存验证

Step 2 方案选择、Step 5 pipeline 重组和 Step 7 legacy 删除必须在相同 adapter、浏览器版本、分辨率/DPR、feature set、workload、seed、camera path、warm-up、采样窗口和 cadence 下比较。至少报告：

- CPU frame/build/compile/execute/submit P50/P95；
- 完整可用的 GPU frame/phase P50/P95，不把不完整 phase sum 称为总 GPU 时间；
- main/private submit、upload/readback bytes 和 sample coverage；
- hierarchy/visibility/material/light/transparency/temporal queue counters 与 overflow；
- resident、transient、history、shadow、retiring、reclaimable 和增长峰值；
- feature-off 对应 Pass、资源、history、readback、counter copy 和 submit 缺席。

只有 clean commit、固定 provenance 和机器可读 evidence gate 通过的结果才能成为正式基线。历史报告和本机探索数字只用于定位，不决定步骤完成。
