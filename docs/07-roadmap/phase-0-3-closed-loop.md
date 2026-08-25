# Phase 0–3 最小闭环（设计意图）

> 母本：设计 v2 §23 Phase 0–3；docs/source/comparison-three-vs-shade.md「先链路通 / 数据结构重写」；verification 里程碑 A 精神  
> 本文把 **Phase 0→3** 串成一条可评审的闭环故事：每阶段证明什么、表/Pass/模块如何接、何时可宣布「不是 WebGPURenderer 换皮」。  
> **不锁** stride / WGSL binding / 函数签名。

---

## 1. 闭环在说什么

```txt
闭环 = 从「能跑壳」到「表驱动 + GPU frustum 可见列表」的最短主路径
终点证明：主渲染不再由 three 每帧 Object3D render-list 主导
```

**不是闭环终点：**

```txt
Meshlet / Visibility Buffer / HZB / TAA / SSR / GI
（这些是后续阶段；本闭环不删它们的目标身份，见 ADR-0003）
```

与模式阶梯对照：本闭环达成 **模式 A**（table-driven + frustum）。见 [../04-pipelines/modes.md](../04-pipelines/modes.md)。

---

## 2. 四阶段一句话 + 证明类型

| Phase | 一句话目标 | 正确性 | 架构性 | 可测意图 |
|-------|------------|--------|--------|----------|
| **0** | WebGPU 壳 + FrameGraph 可画 fullscreen | 有像素输出 | Engine/World/Renderer 壳存在 | 启动不炸、Present 稳定 |
| **1** | three 静态不透明 mesh 进引擎并基础 PBR | 外观可接受 vs three | 仅 Adapter 碰 three | 导入白名单场景可画 |
| **2** | 绘制真源 = GPU scene tables | 表内容与画面一致 | 无 per-frame render-list 主路径 | dirty upload 可统计 |
| **3** | GPU frustum → VisibleInstanceList | 锥外不进可见列表 | Cull 在 GPU；CPU 不扫全量建 list | visible 随相机变化可降 |

三类证明定义见 [verification-intent.md](./verification-intent.md)。

---

## 3. 端到端数据流（闭环内）

```txt
[Phase 1+]  THREE.Scene
                │  import（低频全量 traverse，仅 Adapter）
                ▼
            CPU World stores（id 行）
                │  markDirty / dirty ranges
                ▼
[Phase 2+]  UploadDirtyScene → GPU tables
                │
                ▼
[Phase 3+]  CullInstances（Camera + Bounds）
                │
                ▼
            VisibleInstanceList + Counters
                │
                ▼
[Phase 1–3] BaselineDraw（forward PBR 子集）
                │  读 Instance → Mesh/Material/Transform
                ▼
            HDR/LDR → Present
```

Phase 0 只有：

```txt
BeginFrame → Fullscreen / clear → Present
```

---

## 4. 分阶段：目标 · 数据 · Pass · 模块 · 不做

### 4.0 Phase 0 — 基础工程

| 维度 | 意图 |
|------|------|
| **目标** | Device/Adapter 心智落地；FrameGraph 可跑；fullscreen 可画 |
| **数据** | 无场景表；仅 Frame 常量草稿（分辨率/帧号可有） |
| **Pass** | BeginFrame、Fullscreen、Present |
| **模块主责** | M00、M01、M05（壳）、M15（最小）、M14（挂钩子即可） |
| **明确不做** | three import、PBR、cull、VB |
| **完成意图** | 「最小 WebGPU 环稳定存在」 |

**docs/source/webgpu-fundamentals.md 对齐：** Adapter → Device → Pipeline → Command 已变成工程骨架，而非教程笔记。

---

### 4.1 Phase 1 — three / glTF 输入 + 链路通

| 维度 | 意图 |
|------|------|
| **目标** | 导入 `THREE.Scene` 静态不透明 mesh；基础 forward PBR |
| **数据** | CPU World 初值；几何/材质/纹理上传；相机映射到 Frame/Camera |
| **Pass** | BeginFrame、（简）Upload、BaselineDraw、Present |
| **模块主责** | M03、M02、M06/M09、M01 |
| **明确不做** | 表驱动为唯一真源的强制（可先「上传后画」，但架构上应朝表收敛）；GPU cull；VB |
| **完成意图** | 「静态不透明场景能进引擎并画对基础 PBR」 |
| **性能声明** | **不要求**超过 three；只要求链路与语义 |

**Import 流水线（设计意图，见 M03）：**

```txt
traverse（仅 import）→ Mesh/Material/Texture 提取
  → 分配 ids → 填 World → 首次 upload → Baseline 画
```

**兼容面：** MeshStandard 子集、opaque/alpha-test 方向；超白名单可观测。见 `05-compatibility`。

---

### 4.2 Phase 2 — GPU scene tables

| 维度 | 意图 |
|------|------|
| **目标** | 渲染 **完全基于** GPU scene tables |
| **数据就绪** | Instance / Transform / Mesh / Material / Bounds / Texture 元数据 |
| **Pass 主路径** | UploadDirtyScene 成为每帧场景对齐主路径 |
| **模块主责** | M04、M02、M03（sync）、M09 |
| **明确不做** | 仍可不做 meshlet/VB/HZB；可仍用 Baseline 全量或粗列表绘制 |
| **完成意图** | 「绘制以 GPU tables 为真源；three 仅经 Adapter 进表」 |

**架构性铁律（本阶段必须可审计）：**

```txt
✓ 每帧：dirty → upload → 读表绘制
✗ 每帧：全量 Object3D traverse 建 render-list 主导绘制
✗ 渲染核直接依赖 three 类型主路径
```

**表家族最小集合：**

| 表 | 闭环内用途 |
|----|------------|
| Instance | 绑 mesh/material/transform/bounds |
| Transform | world（prev 可先填同值，为 Phase 8 留口） |
| Mesh | 顶点/索引偏移与计数 |
| Material | PBR 因子 + texture id |
| Bounds | world 球/盒，供 Phase 3 |
| Texture 元数据 | Registry 描述，非 bindless 下标 |

字段语义见 [../03-data/records-fields.md](../03-data/records-fields.md) 与 [../03-data/mother-doc-field-map.md](../03-data/mother-doc-field-map.md)。

---

### 4.3 Phase 3 — GPU frustum culling

| 维度 | 意图 |
|------|------|
| **目标** | GPU 输出 **visible instance list** |
| **数据就绪** | + VisibleInstanceList、Counters（ResetCounters） |
| **Pass** | ResetCounters → CullInstances → Baseline（读可见列表） |
| **模块主责** | M08、M04、M15 |
| **明确不做** | HZB / maybe resolve（可简化为 visible-only）；meshlet 级 cull |
| **完成意图** | 「GPU frustum 改变提交工作量且可统计」 |

**Cull 语义（闭环最小集）：**

```txt
R: Instance、world Bounds、Camera（锥平面 / layer）
W: VisibleInstanceList、Counters
简化：仅 Visible；无 Maybe；无 previous-frame HZB
```

**与绘制衔接：**

```txt
BaselineDraw 只遍历 / 间接使用 VisibleInstanceList
相机转出场景时：visible count 应能下降（可测意图）
```

---

## 5. 闭环完成时的一帧（模式 A）

```txt
CPU
  Adapter sync dirty（非全量 render-list）
  写 Camera / Frame 常量
  提交 FrameGraph

GPU
  BeginFrame
  UploadDirtyScene
  ResetCounters
  CullInstances          ← Phase 3
  BaselineDraw           ← 读表 + 可见列表
  Present
```

与全量 Layer 3 帧对比：缺 meshlet / VB / resolve / HZB / TAA / SSR…——**有意**，见 ADR-0003。

---

## 6. 里程碑 A 对外话术

达成 Phase 2–3 意图后：

| 可以说 | 不可说 |
|--------|--------|
| 场景在 GPU 表上 | 已是完整 Shade |
| GPU frustum 产出可见列表 | 一定比 three 快 |
| 主路径不是 three render-list | VB/GI/TAA 已完成 |
| 模式 A 成立 | 可忽略 docs/source/webgpu-browser-limits.md |

见 [stage-groups.md](./stage-groups.md) 里程碑 A。

---

## 7. 阶段间依赖与「可并行」边界

```txt
硬依赖：
  Phase 0 壳 → 一切
  Phase 1 导入语义 → 表有内容可填
  Phase 2 表存在 → Phase 3 cull 有得读
  Phase 3 可见列表 → Baseline 工作量可随相机变

可重叠（设计允许，实施时用 ADR 记交叉）：
  Phase 1 末即可按表形状写 store（提前对齐 03-data）
  Phase 2 绘制可先「全表 instance」再接 Phase 3 列表
  prevWorld 可在 Phase 2 预留字段，逻辑在 Phase 8 才严格
```

---

## 8. 与文档其他页的接法

| 评审问题 | 去哪读 |
|----------|--------|
| 本阶段要哪些表/Pass | [phase-data-pass-map.md](./phase-data-pass-map.md) |
| 谁主责 | [phase-module-matrix.md](./phase-module-matrix.md) |
| 字段够不够 | [../03-data/records-fields.md](../03-data/records-fields.md)、[mother-doc-field-map.md](../03-data/mother-doc-field-map.md) |
| Pass 读写契约 | [../04-pipelines/pass-contracts.md](../04-pipelines/pass-contracts.md) |
| 如何宣布完成 | [verification-intent.md](./verification-intent.md) |
| 风险/关 cull | [risks-and-degrade.md](./risks-and-degrade.md) |

---

## 9. 闭环验收检查清单（设计层）

### 架构

```txt
[ ] 渲染核主路径无 three 类型
[ ] 仅 M03 Adapter 官方依赖 three
[ ] 无 WebGLRenderer / WebGPURenderer 作后端内核
[ ] Phase 2+：每帧场景对齐以 dirty upload 叙述，非 full traverse draw-list
[ ] Phase 3+：可见集合由 GPU cull 产出（可 debug 可视化）
```

### 正确性

```txt
[ ] 冒烟：单 mesh 基础 PBR
[ ] 导入：多 mesh 白名单场景
[ ] 锥外物体不出现在 Visible 统计中（Phase 3）
[ ] 超支持面有可观测失败/跳过，非静默错材质
```

### 可测

```txt
[ ] Stats：instance 总数、upload bytes、visible count（Phase 3）
[ ] 固定对照场景尽早锁定（verification 场景意图）
[ ] 相机飞出场景：visible 下降可演示
```

### 禁止的完成宣言

```txt
Phase 1 完成 ≠ 比 three 快
Phase 3 完成 ≠ 完整 Shade / 完整 Layer 3
闭环完成 ≠ 可砍 Phase 4+ 目标身份
```

---

## 10. 本闭环之后的自然下一刀

```txt
Phase 4  Meshlet（几何与 cull 粒度变细）
Phase 5  Visibility Buffer
…
```

顺序默认设计 v2；与 verification「风险叙事」交叉时记 ADR。本文件 **不** 展开 Phase 4+ 细节。
