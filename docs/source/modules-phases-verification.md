# Three.js Lite — 模块划分 · 阶段路线 · 验收标准

> 版本：v1  
> 日期：2026-07-17  
> 定位：根据既有研究文档与讨论，把 **Three.js Lite** 拆成可执行的模块、阶段与验证门槛。  
> 目标一句话：**three.js 负责资产 / 数学 / PBR 语义；本项目只重构渲染架构（GPU-resident / GPU-driven）。**

相关文档（同目录 `docs/source/`）：

| 文档 | 作用 |
|------|------|
| [design-v2-full.md](./design-v2-full.md) | 完整技术设计（细节参考） |
| [shade-reference-v3.md](./shade-reference-v3.md) | Shade 架构参考 |
| [comparison-three-vs-shade.md](./comparison-three-vs-shade.md) | 与 WebGL / WebGPURenderer / Shade 的性能定位 |
| [webgpu-browser-limits.md](./webgpu-browser-limits.md) | 浏览器一等约束 |
| [webgpu-fundamentals.md](./webgpu-fundamentals.md) | WebGPU 基础 |

---

## 0. 设计总原则（写死）

```txt
P0  WebGPU-only（无 WebGL fallback）
P1  three.js = 输入层 + 数学/材质语义，≠ 渲染内核
P2  数据导向：plain data + flat tables，无 render-list 主路径
P3  Static opaque PBR 优先；动态 / 透明 / 动画后置
P4  每一阶段必须有可测验收，未通过不得进入下一阶段
P5  浏览器约束一等公民：DPR、visibility、device lost、带宽
P6  兼容性用白名单，不用「尽量兼容」
```

### 0.1 产品边界

**做：**

```txt
- 可挂 THREE.Scene 的 WebGPU Renderer
- 复用 three 的 loader / math / MeshStandard 参数语义
- GPU scene tables + GPU culling +（后期）visibility 管线
- 可 tree-shake 的模块化 runtime
```

**不做（v1 全周期）：**

```txt
- fork three.js 主仓库
- 完整 TSL / NodeMaterial / ShaderMaterial 兼容
- WebGL fallback
- 完整编辑器级 live 材质拓扑编辑
- 完整 AAA GI / path tracer 作为 MVP 目标
```

### 0.2 用户 API 目标形态

```ts
import * as THREE from 'three'
import { LiteRenderer } from 'three-lite'

const scene = new THREE.Scene()
// 使用 three 原有：GLTFLoader、Mesh、MeshStandardMaterial、Camera...

const renderer = await LiteRenderer.create({ canvas })
await renderer.compile(scene, camera)  // 一次：flatten → GPU tables
renderer.render(scene, camera)         // 每帧：dirty sync + FrameGraph
```

---

## 1. 总体架构（三层）

```txt
┌──────────────────────────────────────────────┐
│ Layer A · App / three.js Authoring            │
│ Scene · Mesh · Material · Camera · Loaders    │
└───────────────────────┬──────────────────────┘
                        │ import / track / dirty
┌───────────────────────▼──────────────────────┐
│ Layer B · Lite Runtime（数据 + 调度）          │
│ World stores · Adapter · FrameGraph · Engine  │
└───────────────────────┬──────────────────────┘
                        │ GPU tables / passes
┌───────────────────────▼──────────────────────┐
│ Layer C · Renderer Core（架构重构区）          │
│ Cull · Draw/VB · Material · Light · Post      │
└──────────────────────────────────────────────┘
```

**依赖规则：**

```txt
Layer C  禁止依赖 three.js
Layer B  仅 adapter-three 依赖 three（peerDependency）
Layer A  用户侧自由使用 three
```

---

## 2. 模块划分

每个模块包含：职责、输入/输出、依赖、不负责什么。

---

### M0 · 工程骨架（repo / build / examples）

| 项 | 内容 |
|----|------|
| **职责** | monorepo、TypeScript、打包、示例入口、CI 占位 |
| **产出** | 可 `pnpm install` / `pnpm dev` / 最小 canvas 挂载 |
| **依赖** | 无 |
| **不负责** | 渲染逻辑 |

建议包结构：

```txt
packages/
  core/              # M1 Engine + FrameGraph + 资源池
  world/             # M2 数据表与 ID
  adapter-three/     # M3 three 导入/同步（唯一依赖 three）
  geo/               # M7 meshlet 等几何预处理
  render/
    cull/            # M6
    forward/         # M5 早期绘制
    visibility/      # M8
    material/        # M5 / M8 resolve
    lighting/        # M5 / M9
    post/            # M10
  shaders/           # WGSL 源与 fragment 组合
  examples/
tests/
  unit/
  gpu/               # 需 WebGPU 的集成/性能
docs/                # 本文件与后续 spec
```

---

### M1 · Engine（WebGPU 设备与资源）

| 项 | 内容 |
|----|------|
| **职责** | adapter/device、canvas configure、pipeline/bindGroup/shader cache、resource pool、timestamp（可选） |
| **输入** | canvas、EngineOptions |
| **输出** | `EngineContext` |
| **依赖** | 浏览器 WebGPU |
| **不负责** | 场景语义、材质逻辑 |

核心类型（概念）：

```ts
EngineContext {
  adapter, device, queue
  canvas, context, format
  limits, features
  pipelineCache, bindGroupCache, shaderCache
  resourcePool
}
```

必须能力：

```txt
- createEngine / destroy
- device.lost 监听与重建钩子
- 统一 buffer/texture 分配与回收
```

---

### M2 · World（CPU 侧 plain data）

| 项 | 内容 |
|----|------|
| **职责** | flat stores、typed id、dirty range、与 GPU 表的版本对应 |
| **输入** | Adapter 写入的 record |
| **输出** | `WorldContext` |
| **依赖** | M1（仅持有 engine 引用，可选） |
| **不负责** | three 对象、draw call |

Stores：

```txt
TransformStore
MeshStore
InstanceStore
MaterialStore
TextureStore
LightStore
CameraStore（或每帧 uniform）
DirtyTracker
```

原则：

```txt
- 无 class 场景图 runtime
- 无 child 反向引用 World
- ID：0 = invalid，1..N = valid
```

---

### M3 · Adapter-Three（兼容入口）

| 项 | 内容 |
|----|------|
| **职责** | THREE.Scene → World；dirty 同步；材质/几何白名单校验 |
| **输入** | `THREE.Scene`、Camera、可选 ImportOptions |
| **输出** | ImportResult、SyncStats、LiteHandle 映射 |
| **依赖** | `three`（peer）、M2 |
| **不负责** | GPU 绘制、shader 编译细节 |

子模块：

```txt
ThreeSceneAdapter   — 全量 import / compile
ThreeSyncLayer      — 增量 sync
MaterialExtractor   — MeshStandard 子集 → MaterialRecord
GeometryExtractor   — BufferGeometry → 规范化属性
TextureUploader     — 贴图 → GPUTexture + TextureId
```

**v1 白名单（硬约束）：**

```txt
支持：
  Mesh, InstancedMesh（静态优先）
  BufferGeometry: position, normal, uv,（tangent 可生成）
  MeshStandardMaterial 子集：
    color, map, metalness, roughness,
    metalnessMap, roughnessMap, normalMap, aoMap,
    emissive, emissiveMap,
    transparent=false, alphaTest（可选）,
    side = FrontSide | DoubleSide
  PerspectiveCamera / OrthographicCamera
  Ambient / Hemisphere / Directional（简化）
  GLTF 静态不透明场景

不支持（报错或 unlit 降级）：
  ShaderMaterial / NodeMaterial / RawShaderMaterial
  transmission / clearcoat / sheen / 复杂透明
  SkinnedMesh / morph（后期阶段）
  Points / Line 主路径
  onBeforeCompile 钩子
```

复用 three：

```txt
可复用：math、Color、loaders、glTF 材质约定、PMREM/IBL 思路
不复用：WebGLRenderer、WebGPURenderer、RenderLists、TSL 全链
```

---

### M4 · GPU Scene（常驻表与上传）

| 项 | 内容 |
|----|------|
| **职责** | CPU store → GPUBuffer 表；dirty range upload；可见列表 buffer 池 |
| **输入** | World dirty ranges |
| **输出** | `GPUScene` |
| **依赖** | M1、M2 |
| **不负责** | culling 算法逻辑本身（只提供 buffer） |

最低表集合：

```txt
InstanceTable
TransformTable
MeshTable
MaterialTable
BoundsTable
Texture 元数据表（id → array layer / bind slot）
LightTable
VisibleInstanceList + counters
IndirectArgs（阶段推进后启用）
```

上传原则：

```txt
- 连续 dirty range 合并
- range 过多则 full upload
- 每帧 upload budget（可配置）
- 大资源：worker 解码 + 增量 copy（后期加强）
```

---

### M5 · Shading Baseline（PBR 正确性底座）

| 项 | 内容 |
|----|------|
| **职责** | 在架构未完全 GPU-driven 前，先保证「能画对」 |
| **路径** | 早期可 CPU 提交 draw；tables 就绪后改为 table-driven draw |
| **依赖** | M1–M4、M3 |
| **不负责** | occlusion、meshlet、TAA |

包含：

```txt
- 相机 MVP uniform
- MeshStandard 子集 WGSL
- 基础 IBL / 方向光
- 双面 / alphaTest（按白名单）
- debug：线框、法线、albedo 视图
```

---

### M6 · GPU Culling

| 项 | 内容 |
|----|------|
| **职责** | GPU frustum（及后续 occlusion）输出 visible list |
| **输入** | Instance/Bounds + camera |
| **输出** | compacted visible instances、stats |
| **依赖** | M4 |
| **不负责** | 材质 shading |

阶段内演进：

```txt
M6a  frustum cull only
M6b  Hi-Z / HZB occlusion + maybe-set（依赖 depth pyramid）
```

---

### M7 · Geometry / Meshlet（可选增强）

| 项 | 内容 |
|----|------|
| **职责** | mesh → meshlet 预处理；meshlet table；expansion/cull |
| **推荐依赖** | `meshoptimizer`（WASM） |
| **依赖** | M2、M4 |
| **不负责** | 最终像素 shading |

说明：

```txt
- Stage A 可不启用 meshlet，整 mesh 绘制即可
- Stage C 前必须稳定 meshlet builder + debug 可视化
```

---

### M8 · Visibility Buffer + Material Resolve

| 项 | 内容 |
|----|------|
| **职责** | 先写可见性 ID，再只对可见像素做材质 resolve |
| **依赖** | M4、M6、（推荐 M7）、M5 的 PBR 公式 |
| **不负责** | GI / 完整后处理 |

子能力：

```txt
VisibilityRaster     — rg32uint: mesh_id + triangle_id（或等价）
Depth + Pyramid      — 供 occlusion / SSR
MaterialId routing   — per-material pass 或 batch
Attribute reconstruct— barycentric 插值属性
G-buffer 输出        — albedo/normal/orm/motion/...
```

---

### M9 · Lighting

| 项 | 内容 |
|----|------|
| **职责** | deferred / clustered 光照、阴影接入点 |
| **依赖** | M5 公式、M8 G-buffer（或 forward 路径） |
| **不负责** | 完整 GI 系统 |

演进：

```txt
M9a  directional + IBL
M9b  multi-light（tiled/clustered 简化）
M9c  CSM + contact shadow（后期）
```

---

### M10 · Post / Temporal

| 项 | 内容 |
|----|------|
| **职责** | TAA、SSR、Bloom、Tonemap、动态分辨率 |
| **依赖** | motion vector、depth history、稳定 lighting 输出 |
| **不负责** | 场景导入 |

原则：

```txt
- TAA 是管线胶水，不是可随意开关的外挂滤镜
- SSR/GI 的 temporal 稳定性依赖 TAA 就绪
- 半分辨率 SSR / 控制 max DPR 默认开启策略
```

---

### M11 · Browser Resilience（横切）

| 项 | 内容 |
|----|------|
| **职责** | 标签页可见性、device lost、DPR/render scale、内存压力策略 |
| **依赖** | M1、M10 history |
| **贯穿** | 所有阶段，不是最后再补 |

```txt
visibility hidden  → 停 rAF / 停重 pass / 冻结 temporal
visibility shown   → 校验 device / 重建或清空 history
device.lost        → 丢弃旧 GPU 资源，完整 re-compile 路径
pixel ratio        → clamp maxDPR + internal scale
```

---

### M12 · Stats / Debug / Benchmark

| 项 | 内容 |
|----|------|
| **职责** | CPU/GPU 计时、draw/dispatch 计数、debug view、回归场景 |
| **依赖** | 全模块埋点接口 |
| **验收** | 每个阶段的验证都走本模块 |

Debug views（逐步加）：

```txt
albedo / normal / roughness / metalness
depth / HZB mip
instance id / meshlet id / material id
culling heatmap
motion vectors
TAA history weight
```

---

## 3. 模块依赖图

```txt
M0 工程
 └─ M1 Engine
     ├─ M2 World
     │   └─ M3 Adapter-Three ──(peer)── three.js
     ├─ M4 GPU Scene ← M2
     ├─ M5 Shading ← M3,M4
     ├─ M6 Culling ← M4
     ├─ M7 Meshlet ← M2,M4
     ├─ M8 Visibility ← M4,M6,M7,M5
     ├─ M9 Lighting ← M5/M8
     ├─ M10 Post ← M8,M9
     ├─ M11 Browser ─ 横切 M1/M10
     └─ M12 Stats ── 横切全部
```

---

## 4. 阶段总览

采用 **三级火箭 + 编号阶段**。未通过验收禁止宣称「架构完成」。

| 大阶段 | 阶段 ID | 名称 | 核心问题 | 预计量级* |
|--------|---------|------|----------|-----------|
| **Stage 0** | P0 | 工程可运行 | 项目能否启动？ | 1–2 周 |
| **Stage A** | P1–P4 | CPU 踢出主循环 | tables + cull 是否生效？ | 6–10 周 |
| **Stage B** | P5–P6 | 现代可见性/延迟 | overdraw 与遮挡是否可控？ | 4–6 周 |
| **Stage C** | P7–P9 | Shade-like 增强 | VB/meshlet/TAA 是否值得？ | 8–12 周 |
| **Stage D** | P10+ | 动态与高级效果 | 动画/SSR/GI 是否可维护？ | 持续 |

\*单人兼职/全职弹性大；以**验收**为准，不以日历承诺为准。

```txt
Stage 0 ──► Stage A ──► Stage B ──► Stage C ──► Stage D
  能跑       能快(CPU)    能省(GPU)    能强(上限)    能全
```

---

## 5. 分阶段详细设计与验收

每一阶段统一使用四段式：

```txt
目标 · 模块范围 · 交付物 · 验收（Must / Should / 禁止声称）
```

---

### P0 — 工程骨架与 WebGPU 最小环

**目标：** 仓库可构建，canvas 上稳定清屏 / 全屏三角形。

**模块：** M0、M1、M12（最小 stats）

**交付物：**

```txt
[ ] monorepo + TS 配置
[ ] createEngine(canvas)
[ ] requestAnimationFrame 循环
[ ] 清屏 + fullscreen triangle
[ ] shader / pipeline cache 雏形
[ ] examples/minimal
```

**验收 Must：**

```txt
1. Chrome/Edge WebGPU 下 examples/minimal 无报错运行
2. 连续 10 分钟不泄漏明显（简单 heap 观察 / 无 device lost）
3. 关闭页面可 dispose，无持续 rAF
```

**验收 Should：**

```txt
- FPS 计数显示
- 基本 README：如何跑示例
```

**禁止声称：**

```txt
- 已兼容 three.js
- 已具备高性能
```

---

### P1 — three 输入与静态几何通路

**目标：** 用 three 的 Scene/glTF 导入静态 mesh，数据进入 World。

**模块：** M2、M3、M4（buffer 上传，可先不做完整 table 语义）

**交付物：**

```txt
[ ] importThreeScene / compile
[ ] GeometryExtractor（pos/normal/uv）
[ ] 基础 TextureUploader
[ ] Mesh / Material / Transform 的 CPU store
[ ] 至少一个 glTF 示例场景加载
```

**验收 Must：**

```txt
1. 指定 glTF（如简单 glTF 或 Sponza 简化版）成功 import
2. 白名单外材质：明确 warn/error 或 unlit 降级，不静默错误渲染
3. import 后 World 内 instance 数、mesh 数、材质数可打印且合理
4. 不依赖 WebGPURenderer / RenderLists
```

**验收 Should：**

```txt
- 缺失 normal/tangent 时自动生成或关闭法线贴图
- ImportResult 含 unsupported 列表
```

**禁止声称：**

```txt
- 完整 glTF 扩展支持
- 任意 three Material 都能跑
```

---

### P2 — Forward PBR 画质底座

**目标：** 导入场景「画得对」，建立与 three 可对比的视觉基线。

**模块：** M5、M9a、M12 debug views

**交付物：**

```txt
[ ] MeshStandard 子集 WGSL
[ ] 方向光 + 环境/IBL（可先简化）
[ ] 相机控制示例（可继续用 three OrbitControls）
[ ] albedo/normal debug view
```

**验收 Must：**

```txt
1. 同场景同相机下，与 three WebGPU/WebGL 并排：材质响应合理（金属/粗糙度/法线可读）
2. 不要求像素级一致；允许色调映射/默认灯差异，但无黑屏/粉紫/全白爆炸
3. 切换 debug view 正常
4. 静态场景连续渲染稳定（无每帧重建全部 buffer）
```

**验收 Should：**

```txt
- 基础 tone mapping
- 双面材质正确
```

**验证方法：**

```txt
- 并排截图 + 主观 checklist
- 固定相机截图归档到 tests/reference（可选）
```

**禁止声称：**

```txt
- 已 GPU-driven
- 已超过 three 性能
```

---

### P3 — GPU Scene Tables 成为唯一绘制数据源

**目标：** 绘制只读 GPU tables / 或 table 映射后的 draw 数据，不再每帧 traverse 建 render list。

**模块：** M4 完整化、M5 改为 table-driven、M3 Sync 雏形

**交付物：**

```txt
[ ] Instance / Transform / Mesh / Material / Bounds 表
[ ] dirty range upload
[ ] render 路径：读 table 提交 draw（可仍 multi draw）
[ ] ThreeSyncLayer：transform dirty → 只更新 TransformTable
```

**验收 Must：**

```txt
1. 主渲染路径代码中不存在「每帧 scene.traverse 构建 draw 列表」
2. 仅移动若干物体 transform 时，upload 字节量远小于 full scene rebuild（有日志）
3. 与 P2 同场景视觉不回退
4. Stats：upload bytes / dirty instance count 可显示
```

**验收 Should：**

```txt
- material 参数修改只更新 MaterialTable 对应行
- freeList / 删除 instance 不泄漏 slot（基础）
```

**性能参考门槛（本机记录基线即可）：**

```txt
记录：
  - instanceCount
  - CPU time: sync + encode
  - drawCount
后续阶段只与本基线比，不与空口「快」比
```

**禁止声称：**

```txt
- 已完成 occlusion
- 已 meshlet
```

---

### P4 — GPU Frustum Culling（Stage A 完成门）

**目标：** GPU 产出 visible list；CPU 几乎只提交固定 pass。

**模块：** M6a、M12 stats 强化、M11 基础（visibility 停 rAF）

**交付物：**

```txt
[ ] cullInstances compute
[ ] visible list compaction
[ ] 仅绘制 visible（或 indirect 雏形）
[ ] culling debug（显示 culled 比例）
[ ] page visibility → 暂停循环
```

**验收 Must：**

```txt
1. 相机转出场景时，visible count → 0 或接近 0，draw 工作量显著下降
2. 无错误剔除导致「正视物体系统性消失」（允许边界 1px 级误差，需可调 padding）
3. 高实例场景（目标：≥1万 instance 测试场景，可用重复实例）下：
   - CPU frame 中 scene graph 遍历成本接近 0
   - 与「关闭 culling 全画」比，朝外相机时 GPU 更轻
4. Stats 固定输出：
   totalInstances / visibleInstances / drawCount / cpuMs / gpuMs(可选)
```

**验收 Should：**

```txt
- maxDPR clamp 生效
- device.lost 时能 log 并进入可恢复状态（完整恢复可 P4+ 加强）
```

**Stage A 完成定义：**

```txt
P0–P4 全部 Must 通过
= Three.js Lite「架构重构」的第一滴血：
  three 输入 + GPU tables + GPU frustum + 可测性能
```

**禁止声称（未进 Stage B/C 前）：**

```txt
- 已实现 Shade 级 renderer
- 已 0 overdraw material pass
- 已稳定 TAA/SSR/GI
```

---

### P5 — Depth Prepass / Deferred G-buffer

**目标：** 降低 overdraw 上的 shading 浪费；为 occlusion/TAA 打基础。

**模块：** M5 升级或并行 deferred 路径、M9 读 G-buffer、M12

**交付物：**

```txt
[ ] depth prepass 或 G-buffer 填充 pass
[ ] deferred lighting（方向光 + IBL）
[ ] motion vector 输出（可为 TAA 预留，可先粗糙）
[ ] G-buffer debug views
```

**验收 Must：**

```txt
1. 高 overdraw 测试场景（多层遮挡）下，对比 P4 forward：
   - 视觉可接受
   - 昂贵材质场景有 GPU 时间优势或持平且结构更清晰
2. G-buffer 各通道 debug 正确
3. 不影响 P4 culling 正确性
```

**验收 Should：**

```txt
- 半精度/打包格式控制带宽
- internal render scale 可调
```

---

### P6 — HZB Occlusion Culling（Stage B 完成门）

**目标：** 视锥内但被遮挡的物体少画。

**模块：** M6b、Depth Pyramid、M11 history 策略占位

**交付物：**

```txt
[ ] depth pyramid 构建
[ ] previous-frame / progressive occlusion
[ ] maybe-set 缓解错误剔除
[ ] occlusion debug view
```

**验收 Must：**

```txt
1. 室内/强遮挡场景（如 Sponza 相机贴墙）：visible 进一步下降，无大面积闪烁消失
2. 快速转动相机：允许少量 popping，但无持续错误黑洞；padding/延迟 1 帧策略可配置
3. Stats：occludedCount 可读
4. 与关闭 occlusion 对比：遮挡视角 GPU 更轻或 draw 更少
```

**Stage B 完成定义：**

```txt
P5–P6 Must 通过
= 具备现代 renderer 的「可见性」基础，仍可不做 VB
```

---

### P7 — Meshlet 管线

**目标：** 几何以 cluster 为粒度进入 GPU。

**模块：** M7、M12 meshlet debug

**交付物：**

```txt
[ ] meshlet builder（建议 meshoptimizer）
[ ] MeshletTable + bounds
[ ] meshlet cull（frustum，可接 HZB）
[ ] meshlet id 可视化
```

**验收 Must：**

```txt
1. 导入网格自动切 meshlet；异常网格（极小/极大）不崩溃
2. debug 下可见 meshlet 边界/颜色
3. 大 mesh 仅局部可见时，提交的 meshlet 数 < 全 mesh 等价工作（有统计）
4. 视觉与 P6 比无系统性破面
```

**验收 Should：**

```txt
- build 可离线缓存
- meshlet 三角形上限可配置（如 64/128）
```

---

### P8 — Visibility Buffer + Material Resolve（Stage C 核心）

**目标：** 材质 shading 只跑最终可见像素；draw 与 material 数相关而非 mesh 数。

**模块：** M8、M9 对接、纹理策略硬上限

**交付物：**

```txt
[ ] visibility buffer raster
[ ] barycentric 属性重建
[ ] material resolve → G-buffer
[ ] per-material 或 batch shading 路径
[ ] 纹理 array/atlas 策略文档 + 实现
```

**验收 Must：**

```txt
1. 多材质场景：geometry 阶段 draw 数稳定低；material pass ≈ unique materials（+固定 overhead）
2. 复杂材质 overdraw 场景：material shader 调用与 forward 比显著更合理（可用 GPU time / 设计论证 + 统计）
3. 超纹理上限：导入失败或自动 atlas，有明确错误信息
4. 无 bindless 前提下，目标场景（自定：如 ≤128 materials、≤256 textures）可跑通
```

**验收 Should：**

```txt
- alphaTest 物体正确写入 visibility
- double-sided 正确
```

**风险门（未过则降级方案）：**

```txt
若 VB 重建成本 > 收益：
  允许长期停在 P6 deferred + material batch
  文档标记 VB 为 optional advanced path
```

---

### P9 — 最小 TAA + 基础 Post（Stage C 完成门）

**目标：** 稳定 temporal 底座；为 SSR 等铺路。

**模块：** M10 子集、M11 history 恢复

**交付物：**

```txt
[ ] camera jitter
[ ] motion vector 使用
[ ] history + neighborhood clamp（可先简单）
[ ] tonemap / 可选 sharpen
[ ] 切标签页恢复时 history 丢弃或 fade
```

**验收 Must：**

```txt
1. 静态场景：锯齿优于无 AA；无明显 smear 长尾巴（可调参）
2. 慢速运动：可接受微糊，无严重 ghost 拖影
3. 快速运动：允许 artifact，但不永久污染 history
4. visibility hidden→shown：不崩溃，history 策略生效
```

**Stage C 完成定义：**

```txt
P7–P9 Must 通过（P8 若走降级，则 P7 可可选，P9 仍建议做）
= 达到「Shade-like 子集」可用状态
```

---

### P10+ — Stage D（路线图，不设死线）

按优先级，每项单独开阶段与验收：

| 序号 | 主题 | 验收要点 |
|------|------|----------|
| P10 | 半分辨率 SSR | 镜面可读；边缘/miss fade；依赖 TAA |
| P11 | CSM / contact shadow | 无严重 acne；性能可关 |
| P12 | 简化 GI（probe/bake） | 静态场景间接光合理；可关 |
| P13 | 动态对象强化 | 大量 transform 更新不炸 CPU |
| P14 | Skinning / GPU anim | 角色不破；motion vector 正确 |
| P15 | Streaming / 自定义格式 | 大场景分块加载 |
| P16 | Virtual texture 等 | 仅当纹理墙被证实后再做 |

---

## 6. 阶段 × 模块 矩阵

| 模块 | P0 | P1 | P2 | P3 | P4 | P5 | P6 | P7 | P8 | P9 | P10+ |
|------|----|----|----|----|----|----|----|----|----|----|------|
| M0 工程 | ■ | ░ | | | | | | | | | |
| M1 Engine | ■ | ░ | ░ | ░ | ░ | ░ | ░ | ░ | ░ | ░ | ░ |
| M2 World | | ■ | ░ | ■ | ░ | | | ░ | | | |
| M3 Adapter | | ■ | ░ | ■ | ░ | | | | | | ░ |
| M4 GPU Scene | | ░ | ░ | ■ | ■ | ░ | ░ | ░ | ■ | | |
| M5 Shading | | | ■ | ■ | ░ | ■ | | | ░ | | |
| M6 Culling | | | | | ■ | ░ | ■ | ░ | ░ | | |
| M7 Meshlet | | | | | | | | ■ | ░ | | |
| M8 Visibility | | | | | | | | | ■ | ░ | |
| M9 Lighting | | | ■ | | | ■ | | | ░ | | ░ |
| M10 Post | | | | | | | | | | ■ | ■ |
| M11 Browser | | | | | ■ | | ░ | | | ■ | ░ |
| M12 Stats | ■ | ░ | ■ | ■ | ■ | ■ | ■ | ■ | ■ | ■ | ■ |

```txt
■ 本阶段主交付    ░ 维护/小改
```

---

## 7. 统一验证体系

### 7.1 三类验证

| 类型 | 目的 | 工具 |
|------|------|------|
| **正确性** | 能画对、不乱剔 | debug view、并排 three、固定相机截图 |
| **架构性** | 主路径符合设计 | 代码审查清单 + stats 字段强制存在 |
| **性能** | 可量化变好 | 固定场景 + 固定机型记录表 |

### 7.2 标准测试场景（建议尽早固定）

| ID | 场景 | 验证点 |
|----|------|--------|
| T0 | 单 cube PBR | 管线冒烟 |
| T1 | 多 mesh 小场景 | import / 材质白名单 |
| T2 | 1万 instance 复制 | CPU / culling |
| T3 | Sponza 或同类 archviz | 遮挡、多材质、纹理上限 |
| T4 | 高 overdraw 人造场景 | deferred / VB 收益 |
| T5 | 快速转相机 | occlusion popping、TAA ghost |

### 7.3 每阶段必须提交的「验收记录」模板

```txt
阶段：P?
日期：
机器：GPU / 浏览器 / OS
场景：T?
配置：分辨率 / DPR / 特效开关

正确性：
  [ ] Must 列表逐条结果

架构：
  [ ] 主路径是否仍无 per-frame traverse render-list
  [ ] Stats 截图或日志附件

性能（填数字）：
  totalInstances:
  visibleInstances:
  drawCount:
  cpuMs (sync+encode):
  gpuMs (optional):
  uploadBytes:

结论：通过 / 不通过
阻塞项：
```

### 7.4 架构性检查清单（Stage A 起每阶段勾选）

```txt
[ ] packages/render 与 core 未 import three
[ ] 仅 adapter-three 依赖 three
[ ] 无 WebGLRenderer/WebGPURenderer 作为后端
[ ] 白名单外材质行为符合契约
[ ] dispose 可释放 GPU 资源
[ ] hidden tab 不空转重负载
```

---

## 8. 跨阶段非功能需求

### 8.1 性能预算（初始建议，可按实测改）

| 项 | Stage A 目标 | Stage C 目标 |
|----|--------------|--------------|
| 主线程 render 提交 | 尽量稳定，少 GC | 固定 pass 数为主 |
| maxDPR 默认 | ≤ 1.5 或 2 可配 | 同左 + dynamic scale |
| 纹理上限 v1 | 文档写死（如 256） | atlas/VT 再扩 |
| 材质上限 v1 | 文档写死（如 128） | 按 material pass 成本调 |

### 8.2 浏览器硬约束（任何阶段不可违背）

```txt
1. 必须处理 GPUDevice.lost
2. 必须处理 page visibility
3. 禁止默认 devicePixelRatio 无上限
4. 大资源路径规划 worker 解码（Stage A 可简，Stage B+ 加强）
5. 不假设 bindless / mesh shader 存在
```

### 8.3 许可证

```txt
- three.js：MIT，peer 依赖优先；复制公式/小段需保留版权声明
- meshoptimizer 等：遵循其许可证
- 不整包复制 WebGPURenderer 后端
```

---

## 9. 风险与降级策略（按阶段绑定）

| 风险 | 最早暴露阶段 | 降级 |
|------|--------------|------|
| three 兼容期望膨胀 | P1–P2 | 冻结白名单，新增走 RFC |
| dirty sync 复杂爆 | P3 | 静态场景 only，动态少物体 |
| 无 bindless 纹理墙 | P2/P8 | atlas + 硬上限 + 导入失败 |
| HZB popping | P6 | 增大 padding / 关 occlusion |
| meshlet 收益不足 | P7 | 跳过，整 mesh + batch |
| VB 重建成本过高 | P8 | 停在 deferred G-buffer |
| TAA 拖死进度 | P9 | FXAA/无 AA 先上线，TAA 并行研究 |
| pass 过碎 encode 慢 | P5+ | pass fusion / render bundle |

---

## 10. 建议的立即执行顺序（人话版）

```txt
本周–下周：
  P0 工程 + 清屏

紧接着：
  P1 three 导入
  P2 能画对 PBR

然后不要碰 VB：
  P3 GPU tables
  P4 GPU frustum   ← 第一里程碑对外可演示

确认 CPU 收益后：
  P5 deferred
  P6 HZB           ← 第二里程碑

数据证明需要再：
  P7 meshlet
  P8 VB
  P9 TAA           ← 第三里程碑
```

---

## 11. 阶段完成时对外可说的话

| 完成到 | 可以这样描述 | 不要这样描述 |
|--------|--------------|--------------|
| P2 | three 场景能在我们的 WebGPU 路径画出来 | 比 three 快 |
| P4 | three 兼容输入的 GPU-table + GPU cull 渲染器 | Shade 完整实现 |
| P6 | 具备 occlusion 的现代可见性管线 | 0 overdraw / Nanite |
| P9 | Shade-like 子集（VB/TAA 按实际完成度） | 浏览器里的 Unreal |

---

## 12. 文档维护规则

```txt
1. 阶段状态只改本文件顶部的「进度表」（见下）
2. 完整算法细节仍写在 design-v2-full.md
3. 验收记录可放 docs/verification/Pxx-日期.md
4. 白名单变更必须同步：本文件 §2 M3 + 设计文档
```

### 进度表（实施时勾选）

| 阶段 | 状态 | 日期 | 备注 |
|------|------|------|------|
| P0 | 未开始 | | |
| P1 | 未开始 | | |
| P2 | 未开始 | | |
| P3 | 未开始 | | |
| P4 Stage A | 未开始 | | |
| P5 | 未开始 | | |
| P6 Stage B | 未开始 | | |
| P7 | 未开始 | | |
| P8 | 未开始 | | |
| P9 Stage C | 未开始 | | |
| P10+ | 未开始 | | |

状态枚举：`未开始` | `进行中` | `验收中` | `已通过` | `降级通过` | `搁置`

---

## 13. 一页纸总结

```txt
模块：
  M1 Engine · M2 World · M3 Adapter(three) · M4 GPU Scene
  M5 PBR · M6 Cull · M7 Meshlet · M8 VB · M9 Light · M10 Post
  M11 Browser · M12 Stats

阶段：
  P0 能跑
  P1–P4 Stage A：three 输入 + tables + frustum   ← 先做完
  P5–P6 Stage B：deferred + HZB
  P7–P9 Stage C：meshlet + VB + TAA
  P10+ 动态/SSR/GI/...

验证：
  每阶段 Must 清单 + 固定场景 T0–T5 + stats 数字
  架构门：无 per-frame three traverse render-list
  未验收通过 = 未完成该阶段
```

---

## 附录 A · MaterialRecord 字段草案（P1–P2）

```ts
interface MaterialRecord {
  baseColor: [number, number, number, number]
  metalness: number
  roughness: number
  emissive: [number, number, number]
  baseColorTex: TextureId      // 0 = none
  normalTex: TextureId
  ormTex: TextureId            // occlusion-roughness-metalness 打包或分字段
  emissiveTex: TextureId
  flags: number                // doubleSided, alphaTest, ...
  alphaCutoff: number
}
```

## 附录 B · 每帧主路径草案（P4 目标）

```txt
render(scene, camera):
  if (!compiled) error
  syncAdapterDirty(world)           // 增量，禁止 full traverse 建 list
  uploadDirty(gpuScene)
  writeFrameUniforms(camera)
  frameGraph.execute:
    CullFrustum
    DrawVisibleForwardOrDeferred
    TonemapOptional
    Present
  updateStats()
```

## 附录 C · 与完整设计文档的映射

| 本文件 | `design-v2-full.md` |
|--------|---------------------------|
| M1–M2 | §3 Lite runtime、§19 Engine |
| M3 | §4 Three 轻量化层 |
| M4 | §6 GPU Scene Tables |
| M6 | §7 GPU Culling |
| M7 | §8 Meshlet |
| M8 | §9–10 Visibility / Material |
| M9–M10 | §11–16 Lighting / TAA / SSR... |
| 阶段 P0–P9 | §23 路线图的可验收裁剪版 |
| 风险 | §24 的阶段绑定版 |

---

**本文用途：** 实施与验收的「合同」。  
**细节算法：** 查完整设计 v2 与 Shade 解读 v3。  
**下一行动：** 从 P0 开工，或先把 T2/T3 测试场景与材质白名单数值定死。
