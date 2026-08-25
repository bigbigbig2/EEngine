# 产品方向备忘：WebGPURenderer 形 API × 自研 GPU 管线

> **文档类型：** 产品 / 架构方向备忘（讨论收敛稿）  
> **产品名：** OEngine  
> **日期：** 2026-07-18  
> **状态：** 方向提案 — 与 `design-v2-full.md` **同向**，补充「用户门面」与「可切换」边界；**不替代** P0 完整设计  
> **优先级：** P1（产品门面与兼容契约）  
> **相关：** [design-v2-full.md](./design-v2-full.md) · [comparison-three-vs-shade.md](./comparison-three-vs-shade.md) · [webgpu-browser-limits.md](./webgpu-browser-limits.md) · [shade-reference-v3.md](./shade-reference-v3.md)

---

## 0. 一句话

```txt
做一个「用起来像 three.js WebGPURenderer」的自定义 Renderer：
  - 用户侧：Scene / Camera / render() 习惯尽量对齐官方
  - 内核侧：自研 GPU 常驻 / 数据驱动管线（大场景 + 现代画质栈）
  - 不把官方 WebGPURenderer 的 render-list 当渲染真源

目标场景：大场景为主，并承载可迁移的游戏级实时效果算法。
three 生态：保留为输入与资产生态，不保留为每帧场景图 / TSL 材质 core。
```

对外公式（与文档中心一致）：

```txt
OEngine
  = three 输入（Scene / Loader / 参数语义）
  + WebGPURenderer 形 API 门面（可选包装）
  + Lite / 数据导向 runtime
  + GPU 常驻 · 数据驱动渲染核
  + 现代效果路线（TAA / SSR / 阴影 / GI…，可分档）
  （全部在浏览器沙盒约束内）
```

---

## 1. 背景：想法从哪来

### 1.1 原始诉求

1. **想用 three.js 生态**（Loader、搭场景习惯、数学与 PBR 语义）。  
2. **想走 GPU-resident / GPU-driven 方向**（大场景可见性、低 CPU 主循环、现代管线）。  
3. **想要游戏级实时渲染效果**（算法可从游戏引擎迁移）。  
4. 后来补充：**用户使用方式尽量像官方 `WebGPURenderer`**，并希望在「官方后端」与「自研后端」之间 **有限切换**。

### 1.2 关键判断（已对齐）

| 判断 | 结论 |
|------|------|
| 换 WebGPU API ≠ 换架构 | 官方 `WebGPURenderer` 仍是 three CPU scene / render-list 体系 |
| three 场景图 / 完整材质系统当 **渲染 core** | 与 GPU-resident 方向冲突 |
| ECS / flat world / GPU tables 重做 runtime | 与大场景、自研管线同向，推荐 |
| 完整 TSL / NodeMaterial | 自研核 **不作为兼容目标** |
| 浏览器 vs 桌面引擎 | 能短时吃满资源，但 **不能阻止** 限流/回收；无「独占整机」契约 |
| Electron / Tauri | 可摆脱标签回收，若仍用 Web 渲染则 API 能力仍偏 Web |

### 1.3 与既有母本的关系

| 既有母本 | 本文补什么 |
|----------|------------|
| `design-v2-full.md` | 三层等式、表、管线、阶段 — **能力与内核** |
| `comparison-three-vs-shade.md` | 为何不能只改 WebGPURenderer — **架构差** |
| 本文 | **门面策略**：像 WebGPURenderer 的用法、可切换边界、兼容契约 |

```txt
不冲突：three 输入 + 自研核
有调整：用户 API 更明确对齐 WebGPURenderer 习惯（门面），而非另起一套完全陌生的调用方式
禁止误解：门面像官方 ≠ 内核是官方 WebGPURenderer
```

---

## 2. 目标负载与价值

### 2.1 主负载

```txt
大场景为主：
  - 多实例 / 城建 / 建筑 / 强遮挡
  - 规模上涨时 three 传统路径 CPU / 提交量先爆
```

### 2.2 画质目标

```txt
现代实时「游戏级」画面栈（Web 裁剪版）：
  PBR + IBL、GBuffer/深度地基、TAA、AO、阴影、SSR…
  算法可从游戏引擎迁移
  必须分档、可关，承认浏览器带宽与内存
```

### 2.3 价值主张（相对 three 官方路径）

```txt
不是：所有小场景都更快
而是：
  1) 大场景规模下 CPU 主循环与提交更可控
  2) 可见性（frustum → occlusion → 可选 VB）抬架构上限
  3) 现代效果栈有承重墙（FrameGraph + 中间缓冲），非插件拼盘
  4) 用户仍可用 three 搭场景 / 进资产，降低迁移心理成本
```

### 2.4 非目标（写死）

```txt
- 不是 three.js fork
- 不是「官方 WebGPURenderer 的完整 drop-in 替代」
- 不是完整 TSL / NodeMaterial / 任意 ShaderMaterial 兼容
- 不是浏览器里的 Unreal 无折损移植
- 不是承诺占满并锁定整机 CPU/GPU/内存（纯 Web）
```

---

## 3. 核心架构选择：方案 A（门面像，核自研）

### 3.1 两种「适配」必须分开

| 方案 | 含义 | 大场景 / 自研管线 | TSL | 本文态度 |
|------|------|-------------------|-----|----------|
| **A. 门面像 WebGPURenderer，内核自研** | `render(scene,camera)` 等 API 对齐；数据进自有表与 pass | **合适** | 仅参数子集 | **采用** |
| **B. 挂在官方 WebGPURenderer 上改** | 仍走 three render-list / 材质编译主路径 | **上限差** | 兼容最好 | **不采用作高性能核** |

```txt
一句话：
  可以「用起来像 WebGPURenderer」
  不要「跑起来还是 WebGPURenderer」
```

### 3.2 推荐分层

```txt
┌─────────────────────────────────────────────┐
│  用户代码（three 习惯）                        │
│  Scene / Mesh / Material 参数 / Camera / Loader │
└──────────────────────┬──────────────────────┘
                       │ render(scene, camera) 等
┌──────────────────────▼──────────────────────┐
│  门面 · WebGPURenderer 形 API                 │
│  setSize / setPixelRatio / compile / render   │
│  （OEngine Renderer 对外形状）                 │
└──────────────────────┬──────────────────────┘
                       │ import / compile / dirty sync
┌──────────────────────▼──────────────────────┐
│  Runtime · 数据真源                            │
│  World / ECS 味 stores · dirty · id           │
│  （不再以 Object3D 树为每帧渲染权威）            │
└──────────────────────┬──────────────────────┘
                       │ upload
┌──────────────────────▼──────────────────────┐
│  渲染核 · GPU 常驻 / 数据驱动                   │
│  GPU tables · cull ·（meshlet/VB）· lighting  │
│  · FrameGraph · 效果栈                         │
└─────────────────────────────────────────────┘
```

### 3.3 three 保留什么、不保留什么

| 保留 | 不保留（不当 core） |
|------|---------------------|
| GLTF 等 Loader 生态 | 每帧 `traverse` → render-list 主路径 |
| 用 Scene 搭场景 / 导入 | Object3D 树作为 GPU 绘制真源 |
| PBR / glTF **参数语义** | 完整 `Material` 继承体系驱动 draw |
| Camera / 基础数学约定 | TSL NodeBuilder 作为主编译器 |
| 可选：与官方后端切换的 **公共 API 子集** | 官方内部钩子、私有行为 |

### 3.4 数据真源

```txt
运行时渲染真源 = World 表 / 组件 + GPU tables
three Scene     = 作者态 / 进口 /（可选）受控同步源

推荐默认（大场景）：
  compile / import 后以 runtime 为权威
  仅少量脏实体同步；禁止每帧全树 traverse 当主路径

可选更贵模式：
  持续 Object3D → store 同步（兼容感强，大场景税高，需严格 dirty）
```

### 3.5 ECS

```txt
可以用 ECS 或等价 SoA + systems 重做 runtime。
名称其次；要点是：
  - 组件化数据
  - 系统驱动（sync / cull / upload / frame）
  - 与 GPU table 同构
不必绑定某一款 ECS 库。
```

---

## 4. 用户 API：像 WebGPURenderer，且支持「有限切换」

### 4.1 目标用法（示意）

```ts
import * as THREE from 'three'
// 官方：
// import { WebGPURenderer } from 'three/webgpu'
// 自研门面（名待定）：
import { OEngineRenderer } from '@oengine/renderer' // 示例

const scene = new THREE.Scene()
// … 与现有 three 代码相同的搭场景方式 …

// 只换构造：官方 ↔ 自研
const renderer = await OEngineRenderer.create({ canvas })
// const renderer = new WebGPURenderer({ canvas })
// await renderer.init() // 以官方实际 API 为准

renderer.setSize(width, height)
renderer.setPixelRatio(Math.min(devicePixelRatio, renderer.maxDPR ?? 2))

await renderer.compile?.(scene, camera) // 自研侧：flatten → tables（强烈建议）
renderer.render(scene, camera)
```

### 4.2 应对齐的「公共门面」能力（目标集）

以下为 **意图级** 列表，实现时按阶段兑现；名称尽量贴近官方习惯：

```txt
创建 / 初始化（async 可接受）
setSize / setPixelRatio
render(scene, camera)
compile(scene, camera)          // 自研强烈建议；官方语义可能不同，需文档对照
domElement / 与 canvas 关系
基础 clear / 色调相关（若做）
dispose
```

**不承诺**与官方逐方法、逐默认值一致。

### 4.3 「自由切换」的真实含义

```txt
✅ 有限切换（目标）：
  同一套 Scene 构建代码
  在「公共 API 子集 + 场景白名单」内
  只改 Renderer 构造即可在官方 / 自研间切换

❌ 无限切换（非目标）：
  任意 WebGPURenderer + TSL + 插件项目
  换一行就能 100% 行为一致
```

### 4.4 切换契约（兼容矩阵原则）

| 维度 | 可切换（目标） | 不可切换（默认） |
|------|----------------|------------------|
| 几何 | `BufferGeometry` 常规属性 | 怪异自定义属性未映射 |
| 材质 | `MeshStandard` / `MeshPhysical` **参数子集** | 完整 NodeMaterial / TSL 图 |
| 贴图 | 常见 baseColor/normal/ORM/emissive | 任意运行时节点改 shader |
| 灯光 | Directional + IBL（及后续白名单） | 全灯光模型 + 任意阴影模式 |
| 透明 | 后置；早期可不进切换承诺 | 复杂透明排序全兼容 |
| 动画 | 后置 | 完整 Mixer/Skinning 同步 |
| 后处理 | 自研管线内效果 | 依赖官方 renderer 的外部后处理链 |
| 钩子 | 无 / 极少 | `onBeforeRender` 等深层依赖 |

### 4.5 失败策略

```txt
白名单外：
  - 明确 throw 或 warning + placeholder
  - 禁止静默画错还宣称兼容

文档必须提供：
  - 兼容表
  - 「官方能跑、自研不能」清单
  - 推荐迁移路径（先减 TSL / 先 static opaque）
```

### 4.6 双后端产品叙事（对用户）

```txt
官方 WebGPURenderer：
  通用、生态、TSL、与 three 一体

OEngine Renderer（自研门面）：
  同一 Scene 习惯
  大场景与现代可见性 / 效果管线
  材质与能力为白名单子集

选择逻辑：
  要 TSL / 最大兼容 → 官方
  要大场景上限 / 自研画质栈 → OEngine
  子集场景 → 可切换做对比与渐进迁移
```

---

## 5. 材质与 TSL：兼容边界（重点）

### 5.1 结论

```txt
门面可以像 WebGPURenderer
完整 TSL / NodeMaterial 体系：不作为 A 方案兼容目标
```

原因：TSL 绑定 three 的 NodeBuilder 与官方绘制路径；自研核的真源是 **自有 WGSL / Material 表 / resolve**。  
要「真兼容 TSL」≈ 重做一半官方材质栈，会吃掉自研核收益。

### 5.2 分层兼容

| 层级 | 态度 |
|------|------|
| glTF / Standard **参数语义** | **要做**（映射进 Material 表） |
| 贴图槽与采样约定 | **要做**（受无 bindless 策略约束） |
| 官方 TSL 任意图 | **不做**完整兼容 |
| 用户自定义节点 / ShaderMaterial | **默认不做** |

### 5.3 对外话术

```txt
支持：three 材质参数子集（列表冻结、可版本扩展）
不支持：把 OEngine 当作 TSL 运行时
需要完整 TSL：请使用官方 WebGPURenderer
```

---

## 6. 渲染核方向（能力，非实现锁字节）

与 `design-v2-full` / Shade 参照一致，按大场景优先级理解：

```txt
规模档（先）：
  GPU scene tables
  实例化与 dirty upload
  GPU frustum cull
  stats / debug
  （随后）HZB occlusion
  分块 streaming / 资源预算

几何档：
  meshlet / cluster（compute + indirect；无 mesh shader）

着色档：
  正确 PBR baseline → GBuffer / deferred 或 VB + resolve

画质档：
  TAA 地基 → AO / 阴影 → SSR 等（半分辨率、可关）
  GI 类后置

浏览器横切：
  maxDPR、visibility 停帧、device lost 重建、history 丢弃
```

```txt
成功更看：
  实例总数 vs visible
  CPU frame 是否随 N 线性炸
  遮挡视角工作量是否下降
  而非「所有 example 比 three 快 50%」
```

---

## 7. 平台约束（CPU / GPU / 内存）— 决策相关摘要

### 7.1 纯浏览器

| | 说明 |
|--|------|
| 能否用很多 CPU/GPU/内存 | **能**，峰值可以很高 |
| 能否占满且不被管 | **不能保证**；共享、可限流、可回收 |
| 能否阻止被杀 | **不能**；只能少触发 + lost/后台后恢复 |
| 对架构 | 预算、分档、可重建是一等公民 |

### 7.2 Electron / Tauri / 原生

| | 说明 |
|--|------|
| Electron/Tauri | 独立应用，**不再是普通标签回收模型**；可更大胆吃资源 |
| 仍用 Web 渲染时 | WebGPU 能力边界大多还在 |
| 真原生引擎 | CPU/GPU/内存控制力最强 |

本文默认交付形态仍是 **Web + WebGPU**；壳是可选分发形态，不改变「核自研」选择。

### 7.3 迁游戏引擎算法时

```txt
可迁：数学、pass 拆分、剔除/延迟/TAA/SSR 思路
必重做：绑定（无完整 bindless）、加载流、history 生命周期、质量档、变体控制
```

---

## 8. 与「只改 WebGPURenderer」的对照

| | 官方 WebGPURenderer | 本文 OEngine 方向 |
|--|---------------------|-------------------|
| 用户 API | 官方标准 | **形似**，子集对齐 |
| 场景真源 | three 体系 | compile/sync 后 **自有表** |
| 材质 | TSL/Node 路径强 | **参数子集**，非 TSL 运行时 |
| 大场景上限 | 受 CPU scene/list 约束 | **主优化目标** |
| 现代效果栈 | 可加，易外挂化 | **管线内一等** |
| 与官方切换 | — | **白名单内有限切换** |
| 实现依赖 | three 渲染核 | **禁止**以官方 render-list 为主循环 |

---

## 9. 风险与应对

| 风险 | 应对 |
|------|------|
| 用户以为 100% drop-in | README/兼容表写死；不支持即报错 |
| TSL 期望膨胀 | 产品话术分离「参数兼容」与「TSL 运行时」 |
| 每帧全量 sync 吃掉收益 | 大场景默认 compile 权威 + 脏集；限制动态 |
| 双后端行为不一致引发纠纷 | 文档标明「切换的是后端不是同一实现」 |
| 效果 + 大场景抢带宽 | 质量档、半分辨率、可关 |
| 浏览器 lost/后台 | M14 类钩子；history 可丢 |
| 与 design-v2 包名/API 名漂移 | 门面名可演进；内核原则不回退到方案 B |

---

## 10. 决策摘要（可打勾）

```txt
[x] 主负载：大场景
[x] 画质：现代实时效果栈（可迁引擎算法，Web 分档）
[x] 架构：方案 A — 门面像 WebGPURenderer，内核自研 GPU-resident
[x] three：输入与生态，不当每帧场景图 / TSL core
[x] runtime：数据导向（ECS 或等价表 + systems）
[x] TSL：不完整兼容；仅材质参数子集
[x] 与官方切换：公共 API + 场景白名单内有限切换
[x] 禁止：以官方 WebGPURenderer 内部主循环当高性能核
[x] 浏览器：认共享与可回收；不承诺阻止杀进程级资源
```

---

## 11. 开放问题（后续 ADR / 分册）

```txt
1. 对外类名：OEngineRenderer vs 其它；是否提供 webgpu 风格子路径导出
2. compile 是否强制；动态物体同步协议（markDirty / 自动追踪范围）
3. 第一版材质白名单精确列表与失败策略（throw vs placeholder）
4. 与 three 版本 peer 范围
5. 官方 API 对齐到哪一版 three 的方法集
6. 包名 @oengine/* 与历史 @three-lite/* 迁移节奏
7. 是否提供「仅官方后端 / 仅自研 / 双后端对比」example
```

---

## 12. 建议阅读顺序（本文之后）

```txt
1. comparison-three-vs-shade.md     — 换 API ≠ 换架构
2. design-v2-full.md                — 表 / 管线 / 阶段细节
3. webgpu-browser-limits.md         — 外壳约束全文
4. shade-reference-v3.md            — 上限形态参照（非承诺清单）
5. docs/07-roadmap/…                — 工程落地顺序
```

---

## 13. 最终陈述

```txt
我们要做的是：

  一个面向大场景与现代实时画质的 WebGPU 渲染运行时；
  用 three.js 的场景与资产生态作为输入；
  用接近 WebGPURenderer 的 API 降低使用与迁移成本；
  在白名单内允许与官方 Renderer 切换对比；

  但渲染真源与管线是自研的 GPU 常驻 / 数据驱动架构，
  而不是 three 官方 WebGPURenderer 的内部实现，
  也不是完整 TSL 材质系统的替代运行时。
```

**门面求熟，内核求换，兼容求子集，切换求诚实。**
