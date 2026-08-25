# 阶段总表（设计 v2 §23 分册）

> 每阶段只写：**目标 · 交付意图 · 明确不做 · 母本对齐**。  
> 不写周日历、不写函数签名、不写 WGSL。

---

> **Phase 0–3 串讲与验收清单：** [phase-0-3-closed-loop.md](./phase-0-3-closed-loop.md)

## Phase 0 — 基础工程

**目标（母本）：**

```txt
WebGPU engine 可运行
FrameGraph 可执行
fullscreen pass 可画
```

**交付意图：**

```txt
Engine / World / Renderer 壳
FrameGraph / ResourcePool
基础 shader 编译入口
examples/minimal
```

**本阶段不做：**

```txt
three.js import
PBR
visibility buffer
```

**模块主责：** M00、M01、M05（壳）、M15（最小）、M14（可先挂钩子）

**docs/source/webgpu-fundamentals.md：** 验证 Adapter→Device→Pipeline→Command 心智已落地为工程骨架。

---

## Phase 1 — three.js / glTF 输入

**目标：**

```txt
能导入 THREE.Scene 静态不透明 mesh
```

**交付意图：**

```txt
ThreeSceneAdapter
geometry / material 提取
texture upload
camera mapping
basic forward PBR（正确性，不要求超过 three 性能）
```

**模块主责：** M03、M02、M06/M09（基础着色）、M01

**对齐：** 设计 v2 Layer 1；`05-compatibility`；docs/source/comparison-three-vs-shade.md「先链路通」

---

## Phase 2 — GPU scene tables

**目标：**

```txt
渲染完全基于 GPU scene tables
```

**交付意图：**

```txt
Instance / Mesh / Material / Transform / Texture 表
dirty upload
绘制读表，而非每帧 Object3D render-list 主导
```

**模块主责：** M04、M02、M03（sync）、M09

**对齐：** 设计 v2 §6；docs/source/comparison-three-vs-shade.md「数据结构重写」；Shade GPU-resident

**设计完成标志（意图）：**  
主路径已能用「表」描述场景；three 仅通过 Adapter 进表。

---

## Phase 3 — GPU frustum culling

**目标：**

```txt
GPU 输出 visible instance list
```

**交付意图：**

```txt
cullInstances compute
visible list
culling debug + stats
```

**模块主责：** M08、M04、M15

**对齐：** docs/source/comparison-three-vs-shade.md CPU/draw；Shade 第一步 GPU 过滤

**设计完成标志：**  
相机转出场景时工作量应能随 visible 下降（可测意图，P9）。

---

## Phase 4 — Meshlet

**目标：**

```txt
geometry meshlet 化，GPU 可处理 meshlet list
```

**交付意图：**

```txt
meshlet builder / table
meshlet culling
meshlet debug
```

**模块主责：** M07、M08、M04

**对齐：** 设计 v2 §8；Shade §8（无 mesh shader、divergence 意识）

---

## Phase 5 — Visibility Buffer MVP

**目标：**

```txt
可 raster visibility buffer，primitive ID debug 可见
```

**交付意图：**

```txt
visibility texture + depth
ID 含义可调试
（重建可在本阶段起步或与 Phase 6 紧接）
```

**模块主责：** M10、M07、M08、M15

**对齐：** 设计 v2 §9；Shade §6；工程等式中的 visibility buffer

---

## Phase 6 — Material Resolve + G-buffer

**目标：**

```txt
只对可见像素输出 G-buffer（方向）
```

**交付意图：**

```txt
属性重建路径
PBR material resolve
G-buffer
lighting pass 接上
```

**模块主责：** M11、M12、M06、M10

**对齐：** 设计 v2 §10–11；Shade material pass / 0-overdraw 精神；对比 overdraw

---

## Phase 7 — Depth Pyramid + Occlusion

**目标：**

```txt
HZB culling 可用
```

**交付意图：**

```txt
depth pyramid
previous-frame / progressive occlusion
maybe set
错误剔除缓解策略（设计层承认需要）
```

**模块主责：** M08（occlusion 子部分）、M10 深度产物、M15

**对齐：** Shade §7；对比 §6；设计 v2 §7

**说明：** 母本 Phase 编号上 occlusion 在 VB 之后；与 verification 中「可先 depth/HZB 再 VB」的工程弹性不矛盾——**以设计 v2 顺序为默认叙事**，若实施交叉以 ADR 记录。

---

## Phase 8 — TAA

**目标：**

```txt
稳定 temporal pipeline
```

**交付意图：**

```txt
jitter、motion vector、history、clamp
debug tools
与整管线侵入点文档化（Shade：TAA 是胶水）
```

**模块主责：** M13、M11/M12（motion 等）、M14（history 失效）

**对齐：** 设计 v2 §13；Shade §12；对比 §8

---

## Phase 9 — SSR / Shadows

**目标：**

```txt
高级效果开始集成
```

**交付意图：**

```txt
SSR
CSM
contact shadow
temporal denoise（与 TAA 关系）
```

**模块主责：** M13、M12、M05

**对齐：** 设计 v2；Shade SSR/阴影路径；对比高端效果

---

## Phase 10 — GI

**目标：**

```txt
Probe / SVLM / bake-based GI（母本方向）
```

**交付意图：**

```txt
探针或稀疏体积等路线（Shade 时间线：DDGI→SVLM 等为参照）
可开关、可分档（webgpu-browser-limits）
```

**模块主责：** M12 扩展 / GI 子域、M13 合成、M05

**对齐：** 设计 v2 Phase 10；Shade §18；**属于目标身份，非永久删减**

---

## Phase 11 — 动态对象 / animation / skinning

**目标：**

```txt
动态角色与 GPU animation 方向
```

**交付意图：**

```txt
CPU animation sync 过渡
GPU skinning 方向
skinned motion vector
dynamic bounds
```

**模块主责：** M03/M02 动态、M07、M04、（Shade GPU anim 参照）

**对齐：** 设计 v2 Phase 11；Shade §22；P7「dynamic second」但保留路线

---

## 阶段与「模式阶梯」对照

见 [../04-pipelines/frame-overview.md](../04-pipelines/frame-overview.md)：

```txt
Phase 0–1     链路
Phase 2–3     模式 A 倾向（tables + frustum）
Phase 4–7     模式 B/C（meshlet / VB / HZB）
Phase 8–10    模式 D（temporal + 高级）
Phase 11      动态扩展
```
