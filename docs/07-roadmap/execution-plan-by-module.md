# 按模块分阶段执行计划

> **目标：** 把母本与 `docs/` 设计分册，落成可动手的工程步骤。  
> **权威顺序：** 设计 v2 §23 Phase 0–11；能力全集不因分期砍掉（ADR-0003）。  
> **近期闭环：** [phase-0-3-closed-loop.md](./phase-0-3-closed-loop.md)（模式 A）。  
> **模块主责矩阵：** [phase-module-matrix.md](./phase-module-matrix.md)。  
> **字段就绪：** [../03-data/mother-doc-field-map.md](../03-data/mother-doc-field-map.md)。

**本文性质：** 执行步骤与交付门槛（设计级任务拆分），**不是** stride/WGSL 定稿，也不是日历排期。

---

## 0. 怎么读、怎么用

### 0.1 符号

| 符号 | 含义 |
|------|------|
| **S0 / S1 / …** | 该模块内部的子阶段（可跨多个设计 v2 Phase） |
| **P0–P11** | 设计 v2 全局阶段；全局门闸以 P 为准 |
| **主交付** | 本全局阶段必须做出的能力 |
| **接入** | 已有能力挂到新 Pass/表上 |
| **预埋** | 接口/字段先留口，语义后严用 |
| **搁置** | 本阶段禁止实现（防范围膨胀） |

### 0.2 全局铁律（执行时写死）

```txt
1. 未过当前 Phase 验收门 → 不进入下一 Phase 主交付（P4 verification 精神）
2. 路线图 = 顺序，≠ 删除 Layer 3 目标
3. 仅 adapter-three 依赖 three；render 核禁止 three 类型主路径
4. 每阶段结束必须有：可运行示例 + 可观测 stats/debug + 书面「完成意图」勾选
5. 先正确性与架构，再谈超过 three 的性能（docs/source/comparison-three-vs-shade.md）
6. 浏览器约束（DPR / visibility / device lost）从 P0 挂钩，P8 变硬
```

### 0.3 推荐仓库切分（执行默认，可微调）

与 verification / M00 设计对齐：

```txt
packages/
  core/            # M01 Engine + M05 FrameGraph 壳 + 资源池
  world/           # M02 World stores / id / dirty
  adapter-three/   # M03 唯一 three peer
  gpu-scene/       # M04 tables / upload / lists
  geo/             # M07 meshlet builder 等
  render/
    baseline/      # M09
    cull/          # M08
    visibility/    # M10
    resolve/       # M11
    lighting/      # M12
    post/          # M13
  shaders/         # M06 WGSL 源与组合
  browser/         # M14 横切钩子（或并入 core）
  debug/           # M15
examples/
tests/
docs/              # 已有设计分册
```

实施时允许合并包，**不允许**合并依赖方向（Layer C 仍禁止 three）。

### 0.4 全局关键路径（谁堵住谁）

```txt
M00 → M01 → M05 ─────────────┐
         ↓                   │
       M02 → M03 → M04 ──────┤
         ↓         ↓         │
       M06 → M09 ──┴── M08 ──┤  ← 到此 = 里程碑 A / 模式 A
                             │
              M07 → M08' → M10 → M11 → M12 → M13
                             │
              M14 / M15 全程横切
```

- **P0–P3 主链：** M00→M01→M05→M02→M03→M04→M06→M09→M08（+M15）  
- **P4–P7 主链：** M07→M08→M10→M11→M12（+M05 挂 pass）  
- **P8–P11 主链：** M13→M12 阴影/GI→M03/M07 动态  

---

## 1. 全局 Phase 门闸（所有模块服从）

每完成一闸，再开下一闸的「主交付」；预埋工作可提前，但不得冒充完成。

| 闸 | 名称 | 必须同时成立 | 对应模式 |
|----|------|--------------|----------|
| **G0** | 壳可跑 | fullscreen Present；Device 稳定创建 | 壳 |
| **G1** | 链路通 | three 静态不透明场景可导入并基础 PBR | 链路 |
| **G2** | 表真源 | 绘制读 GPU tables；无 per-frame render-list 主导 | A 准备 |
| **G3** | GPU 可见列表 | frustum → VisibleInstance；stats 可证 | **模式 A / 里程碑 A** |
| **G4** | Meshlet | meshlet 表 + meshlet cull/expand 路径 | 向 C |
| **G5** | VB | visibility 纹理 + ID debug | C |
| **G6** | Resolve | 可见像素 material→GBuffer→light | C |
| **G7** | HZB | depth pyramid + occlusion 可开关 | B/C |
| **G8** | TAA | jitter/motion/history 进主管线 | D |
| **G9** | 高级光影 | SSR/阴影栈可开关 | D |
| **G10** | GI | 探针/体积方向可分档 | D |
| **G11** | 动态 | skin/anim 进 GPU-resident 方向 | E |

详细完成意图：[verification-intent.md](./verification-intent.md)、[stages.md](./stages.md)。

---

## 2. 分模块执行步骤

以下每个模块：**子阶段 S\* → 对齐全局 P\* → 交付物 → 验收 → 明确不做**。

---

### M00 · 工程骨架（Engineering）

| 子阶段 | 全局 | 做什么 | 交付物 | 验收 |
|--------|------|--------|--------|------|
| **S0 仓库骨架** | P0 | monorepo、TS、打包、eslint/格式、workspace | `pnpm i` / `pnpm build` 通 | 空包可 build |
| **S1 示例壳** | P0 | `examples/minimal` canvas 挂载 | 打开页有 canvas | 无渲染也可 |
| **S2 CI 占位** | P0–P1 | lint/typecheck（GPU 测可后置） | CI 绿或本地脚本 | 主分支可拦回归 |
| **S3 包边界固化** | P1–P2 | 按上节 packages 切依赖；adapter 唯一 three | import 图可审计 | Layer C 无 three |
| **S4 示例矩阵** | P1+ | minimal → gltf-static → cull-stress 等 | examples 列表 | 每闸至少 1 例 |

**不做（全程 v1）：** 完整编辑器、文档站大工程、三端发布流水线优先于渲染核。

**依赖：** 无。 **被依赖：** 全部。

---

### M01 · Engine（设备与资源）

| 子阶段 | 全局 | 做什么 | 交付物 | 验收 |
|--------|------|--------|--------|------|
| **S0 Device 生命周期** | P0 | requestAdapter/Device、canvas configure、resize | `EngineContext` | 丢设备有钩子位 |
| **S1 资源池壳** | P0 | Buffer/Texture/Pipeline 缓存入口 | ResourcePool API 意图落地 | fullscreen 用得上 |
| **S2 Shader 编译入口** | P0–P1 | 接 M06：createShaderModule / pipeline | 与 FG 联调 | 错误可观测 |
| **S3 时间戳/提交** | P2–P3 | 可选 timestamp；command 提交路径稳定 | 帧提交 API | 无隐式全局 device |
| **S4 丢失与恢复** | P3–P8 | device lost → 重建策略（与 M14） | 文档+最小实现 | 刷新/丢设备不静默死 |

**不做：** 场景语义、材质逻辑、three 类型。

**依赖：** M00。 **被依赖：** M04–M13、M05。

---

### M02 · World（CPU 真源 / plain data）

| 子阶段 | 全局 | 做什么 | 交付物 | 验收 |
|--------|------|--------|--------|------|
| **S0 Id + Store 壳** | P0–P1 | Id 分配、freeList、空表 | World 可创建 | 与 ids.md 一致 |
| **S1 行类型落地** | P1 | Instance/Mesh/Material/Transform/Bounds/Tex 元数据 CPU 行 | stores 可增删 | 导入能写入 |
| **S2 Dirty 模型** | P1–P2 | mark\*Dirty、range、分类 | dirty API | 无 dirty 不全量 traverse 画 |
| **S3 与 GPU 对齐契约** | P2 | 版本/世代与 M04 upload 对齐 | 帧内一致 | G2 架构检查过 |
| **S4 动态扩展** | P11 | 动态实例、bounds 更新入口 | 动态 API | 不破坏静态主路径 |

**不做：** GPUBuffer 镜像（属 M04）；three 遍历（属 M03）。

**依赖：** M00。 **被依赖：** M03、M04。

---

### M03 · Adapter-three（唯一 three 边界）

| 子阶段 | 全局 | 做什么 | 交付物 | 验收 |
|--------|------|--------|--------|------|
| **S0 白名单 import** | P1 | traverse 仅 compile；Mesh/标准材质/纹理子集 | `compile(scene)` | 超白名单可观测 |
| **S1 几何/材质提取** | P1 | BufferGeometry→Mesh 行；MeshStandard→Material 行 | 映射表 | 冒烟 PBR 可画 |
| **S2 相机映射** | P1 | three Camera→Frame/Camera 常量 | 每帧可写 | 与 three 朝向一致 |
| **S3 Sync（非 render-list）** | P2 | 消费 dirty；禁止每帧 full draw-list | `sync` 路径 | G2 架构检查 |
| **S4 静态 bake 选项** | P2–P3 | staticScene / bakeTransforms | 选项 | archviz 可少 sync |
| **S5 动态/动画入口** | P11 | 动画/skin 脏标记进 World | 动态 sync | 仍不进 Layer C three 类型 |

**不做：** 渲染核、完整 TSL/NodeMaterial、当 WebGPURenderer 用。

**依赖：** M02、three peer。 **被依赖：** 用户 API、示例。

---

### M04 · GPU Scene（表 / upload / 列表缓冲）

| 子阶段 | 全局 | 做什么 | 交付物 | 验收 |
|--------|------|--------|--------|------|
| **S0 表缓冲骨架** | P1–P2 | Instance/Transform/Mesh/Material/Bounds/Tex 元数据 GPUBuffer | 空表可 bind | 与 records 语义一致 |
| **S1 Dirty upload** | P2 | UploadDirtyScene；budget 可观测 | upload pass | 全量/range 比例可统计 |
| **S2 绘制读表** | P2 | Baseline 只读表 | G2 | 无 CPU render item 主导 |
| **S3 可见列表缓冲** | P3 | VisibleInstance + Counters + Reset | list buffer | Cull 可写 |
| **S4 Meshlet/Maybe/Indirect** | P4–P7 | Meshlet 表、VisibleMeshlet、Maybe、IndirectArgs | 扩展缓冲 | 随 Phase 接入 |
| **S5 上传摊销与 Stats** | 全程 | budget、跨帧摊销、M15 计数 | stats 字段 | 大场景不静默卡死 |

**不做：** cull 算法、VB 算法、发明字段语义（跟 03-data）。

**依赖：** M01、M02。 **被依赖：** M08–M13、M09。

**字段冻结建议：** G2 前冻结 **P2 主表 draft stride**（可标 draft）；G3 前冻结 Visible 列表元素。

---

### M05 · FrameGraph

| 子阶段 | 全局 | 做什么 | 交付物 | 验收 |
|--------|------|--------|--------|------|
| **S0 图执行壳** | P0 | pass 注册、依赖排序、Begin/Present | FG 跑通 | fullscreen |
| **S1 资源声明** | P0–P1 | 纹理/缓冲逻辑资源 + ResourcePool | 无泄漏意图 | resize 可重建 |
| **S2 场景主路径挂载** | P1–P3 | Upload、Cull、Baseline 顺序固定 | 模式 A 帧 | 与 closed-loop 一致 |
| **S3 VB/Resolve/Light 挂载** | P5–P6 | 插入 Raster/Resolve/DeferredLight | 模式 C 帧 | pass-contracts 对齐 |
| **S4 HZB/TAA/高级** | P7–P10 | Pyramid、TAA、SSR、GI 节点 | 可开关图 | 关节点可降级 |
| **S5 分档配置** | P6+ | 质量档 → 开哪些 pass | settings | docs/source/comparison-three-vs-shade.md 小场景可停 A/B |

**不做：** 具体着色公式、场景表内容。

**依赖：** M01。 **被依赖：** 所有 GPU pass 模块。

---

### M06 · Shaders

| 子阶段 | 全局 | 做什么 | 交付物 | 验收 |
|--------|------|--------|--------|------|
| **S0 编译与缓存** | P0 | WGSL 加载、错误报告、module cache | shader 管道 | 失败可读 |
| **S1 Fullscreen / 清屏** | P0 | 最小 VS/FS | present 有色 | G0 |
| **S2 Baseline PBR 子集** | P1–P2 | 表驱动 forward；MeshStandard 语义子集 | baseline shaders | 与 three 主观可对 |
| **S3 Cull compute** | P3 | cullInstances（及后续 meshlet cull） | compute 入口 | G3 |
| **S4 VB + Resolve lib** | P5–P6 | 轻量 raster + 属性重建 + GBuffer 写 | 公共 BRDF/采样 lib | 与 M09 收敛 |
| **S5 TAA/SSR/Post** | P8–P9 | 后处理与运动向量相关 | post shaders | 可关 |
| **S6 变体策略** | 全程 | 按 flags/质量档组合，非完整 TSL | 变体表 | 无无限排列爆炸 |

**不做：** 完整 TSL 内核、运行时任意节点图。

**依赖：** M01。 **被依赖：** M08–M13、M09。

---

### M07 · Geometry（网格与 Meshlet）

| 子阶段 | 全局 | 做什么 | 交付物 | 验收 |
|--------|------|--------|--------|------|
| **S0 属性规范化** | P1 | pos/n/tan/uv 打包进大缓冲；MeshRecord 偏移 | 几何 upload | Baseline 可画 |
| **S1 索引/共享缓冲策略** | P1–P2 | 合并与偏移规则 | 缓冲布局 draft | 多 mesh 稳定 |
| **S2 Meshlet builder** | P4 | CPU（或工具）切 meshlet；填 Meshlet 表 | bake 管线 | meshletCount>0 |
| **S3 供 cull/VB 使用** | P4–P5 | meshlet bounds/cone 意图字段 | 与 M08/M10 接通 | G4–G5 |
| **S4 压缩/LOD 方向** | P4+ 后置 | 可选压缩属性、LOD | 扩展 | 不挡主路径 |
| **S5 Skin 几何** | P11 | skinned 属性与 flags | skin 路径 | 动态闸 |

**不做：** 运行时每帧 CPU 切 meshlet 当主路径（bake 优先）；完整 DCC 工具链。

**依赖：** M02/M04。 **被依赖：** M08、M10。

**P0–P3：** 只做 S0–S1；**禁止**把 P4 做完才让 G1 过。

---

### M08 · Culling

| 子阶段 | 全局 | 做什么 | 交付物 | 验收 |
|--------|------|--------|--------|------|
| **S0 接口与缓冲约定** | P2–P3 | 与 M04 Visible/Counter 契约 | pass 注册 | 可空跑 |
| **S1 Frustum only** | **P3** | sphere→AABB 可选；layerMask；visible-only | cullInstances | **G3**；相机飞出 visible↓ |
| **S2 接 Baseline 绘制** | P3 | 只画 Visible 列表 | 模式 A 完整 | 工作量随 visible 变 |
| **S3 Meshlet cull/expand** | P4 | Expand + Cull meshlets | VisibleMeshlet | G4 |
| **S4 Depth pyramid** | P7 | HZB 生成 | pyramid 纹理 | mip 可 debug |
| **S5 Occlusion + Maybe** | P7 | prev-frame HZB；Maybe resolve | visible/maybe/reject | 可关；错杀策略有文档 |
| **S6 分档** | P7+ | 开阔场景可关 occlusion | settings | 保留 frustum |

**不做（P3）：** HZB、triangle cull、软件 raster。

**依赖：** M04、M01、Camera；后 M07/M10 深度。 **被依赖：** M09/M10。

---

### M09 · Baseline Shading（正确性底座）

| 子阶段 | 全局 | 做什么 | 交付物 | 验收 |
|--------|------|--------|--------|------|
| **S0 全量/简列表 forward** | P1 | 不依赖 GPU cull 也能画对 | 首帧 PBR | G1 |
| **S1 读表绘制** | P2 | Instance→Mesh/Mat/Xform | 表驱动 draw | G2 |
| **S2 读可见列表** | P3 | 接 M08 | 模式 A 着色 | G3 |
| **S3 Debug 视图** | P1–P3 | albedo/N/roughness 强制输出 | debug modes | 排错 |
| **S4 与 Resolve 共享 lib** | P6 | BRDF/采样与 M11 收敛 | 公共模块 | 双路径不漂语义 |
| **S5 降级/回退身份** | P6+ | Mode C 后作 fallback/低端档 | 仍可切换 | **不删目标 VB** |

**不做：** 终局唯一路径（VB 才是 Layer 3 中枢）；完整透明 blend 管线（后置）。

**依赖：** M04、M06、M03 数据。 **被依赖：** 早期全部正确性证明。

---

### M10 · Visibility Buffer

| 子阶段 | 全局 | 做什么 | 交付物 | 验收 |
|--------|------|--------|--------|------|
| **S0 规格与 ID 布局** | P4–P5 | instance/triangle/… 打包意图 | 设计确认 | 与 gbuffer/VB 契约 |
| **S1 Raster VB + Depth** | **P5** | 轻量光栅写 VB；主深度 | visibility tex | **G5**；ID debug 可见 |
| **S2 接 Visible meshlet** | P5 | 只光栅可见集 | 无全场景蛮力 | 架构 |
| **S3 供 Resolve** | P6 | 输出给 M11 | 契约稳定 | G6 输入成立 |
| **S4 与 HZB 协同** | P7 | 深度供 pyramid | 接 M08 | G7 |
| **S5（研究向）** | 后置 | compute soft-raster 等 | 可选 | 不挡 MVP |

**不做（P5 前）：** 完整 PBR 在 VB pass；软件 raster 必选项。

**依赖：** M07、M08、M04、M06。 **被依赖：** M11。

---

### M11 · Material Resolve

| 子阶段 | 全局 | 做什么 | 交付物 | 验收 |
|--------|------|--------|--------|------|
| **S0 属性重建路径** | P5–P6 | 从 VB id 取几何/插值意图 | reconstruct | 正确 UV/N |
| **S1 写 GBuffer** | **P6** | 仅可见像素 resolve | GBuffer | **G6 半** |
| **S2 接 Lighting** | P6 | 与 M12 输入对齐 | 延迟光照可喂 | **G6** |
| **S3 Motion 相关** | P8 | 供 TAA 的速度意图 | motion | G8 |
| **S4 材质变体** | P6+ | flags/贴图有无 | 与 MaterialRecord | 超白名单可观测 |

**不做：** 扫描 three 材质对象；bindless 幻想。

**依赖：** M10、M04、M06。 **被依赖：** M12、M13。

---

### M12 · Lighting（含阴影 / GI 入口）

| 子阶段 | 全局 | 做什么 | 交付物 | 验收 |
|--------|------|--------|--------|------|
| **S0 简单灯/IBL** | P1 | Baseline 用的方向光/环境 | 能看清材质 | G1 |
| **S1 Light 表** | P2–P6 | 灯不进 three 扫描主路径 | LightRecord 表 | 表驱动 |
| **S2 Deferred lighting** | **P6** | 读 GBuffer 光照 | lighting pass | G6 |
| **S3 Shadows（CSM 等）** | **P9** | 阴影图与接收 | shadow 可开关 | G9 部分 |
| **S4 Contact / 增强** | P9 | 按母本/Shade 方向 | 可选 | 分档 |
| **S5 GI 方向** | **P10** | probe / SVLM / bake 选路 | GI 可关 | **G10** |
| **S6 与 Post 合成** | P9–P10 | 进 HDR 目标 | 接 M13 | 不双算 |

**不做：** 把 GI 当 P1 必达；path tracer 作 MVP。

**依赖：** M11（延迟路径）、M09（早期）、M05。 **被依赖：** M13。

---

### M13 · Post（TAA / SSR / Bloom…）

| 子阶段 | 全局 | 做什么 | 交付物 | 验收 |
|--------|------|--------|--------|------|
| **S0 Tonemap/Present 基础** | P1–P6 | 曝光/tonemap 可极简 | 可显示 | 不挡主路径 |
| **S1 TAA 侵入点文档+实现** | **P8** | jitter、history、clamp、motion | TAA pass | **G8**；非孤立滤镜 |
| **S2 History 失效** | P8 | resize/tab/丢设备清 history（M14） | 失效策略 | 无永久鬼影策略 |
| **S3 SSR** | **P9** | 反射 + 与 TAA 关系 | SSR 可关 | G9 |
| **S4 Bloom/RCAS 等** | P9+ | 母本后处理栈子集 | 可开关 | 分档 |
| **S5 半分辨率策略** | 全程受 M14 | 按质量档 | settings | webgpu-browser-limits |

**不做：** EffectComposer 式无结构外挂堆成「架构完成」。

**依赖：** M11/M12 产物、M05、M14。 **被依赖：** 最终观感。

---

### M14 · Browser（沙盒一等公民）

| 子阶段 | 全局 | 做什么 | 交付物 | 验收 |
|--------|------|--------|--------|------|
| **S0 钩子位** | **P0** | visibility、resize、DPR 入口空实现 | 事件接上 | 不崩 |
| **S1 尺寸与 DPR 策略** | P1–P3 | 内部渲染分辨率策略 | 可配置 | 改窗稳定 |
| **S2 Device lost** | P3–P8 | 与 M01 恢复协作 | 恢复路径 | 可测或可演示 |
| **S3 页签隐藏** | P3+ | 降频/暂停策略 | 省电意图 | 回前台 history 策略 |
| **S4 与 TAA/SSR** | **P8–P9** | history 失效、带宽预期 | 与 M13 契约 | G8–G9 |
| **S5 产品分档默认** | P6+ | 低/中/高默认关哪些 | 默认配置表 | docs/source/comparison-three-vs-shade.md 预期 |

**不做：** 假装浏览器 = 原生引擎；忽略局限文档。

**依赖：** M01。 **横切：** M05、M13、M04 budget。

---

### M15 · Debug / Stats

| 子阶段 | 全局 | 做什么 | 交付物 | 验收 |
|--------|------|--------|--------|------|
| **S0 帧计数壳** | P0 | fps/帧号 | overlay 或 log | G0 |
| **S1 导入/表计数** | P1–P2 | mesh/instance/upload bytes | counters | G1–G2 |
| **S2 Cull 统计** | **P3** | total/visible/(maybe) | 必显 | **G3** |
| **S3 几何/VB debug** | P4–P5 | meshlet、primitive id 可视化 | debug views | G4–G5 |
| **S4 管线计时** | P6+ | pass 耗时（可选 timestamp） | 分段时间 | 对比瓶颈用 |
| **S5 运动/遮挡场景** | P7–P8 | popping/ghost 辅助 | 场景+开关 | verification 场景意图 |

**不做：** 把 stats 当性能测试替代固定场景。

**依赖：** 各模块埋点。 **全程主交付字段随 Phase 增加。**

---

## 3. 按全局 Phase 的「谁上工」（执行清单）

便于排迭代：每一行 = 该 Phase **必须动到的模块与子阶段**。

### Phase 0 — 壳

```txt
主：M00 S0–S1，M01 S0–S2，M05 S0–S1，M06 S0–S1，M15 S0，M14 S0
辅：M02 S0（可空 World）
禁：M03 import，M09 PBR，M08 cull，M10 VB
门闸：G0
```

### Phase 1 — three 输入 + 基础 PBR

```txt
主：M03 S0–S2，M02 S1–S2，M06 S2，M09 S0，M07 S0，M12 S0，M00 S3–S4
辅：M04 S0（可开始建表缓冲），M01/M05 接入，M15 S1，M14 S1
禁：强制 GPU cull，VB，完整表驱动铁律可未满（但方向对齐表）
门闸：G1
```

### Phase 2 — GPU tables 真源

```txt
主：M04 S0–S2，M02 S3，M03 S3–S4，M09 S1，M05 S2，M12 S1，M15 S1
辅：M06 表绑定，Transform.prev 预埋
禁：用 full traverse 建 draw-list 冒充完成
门闸：G2
```

### Phase 3 — GPU frustum

```txt
主：M08 S0–S2，M04 S3，M09 S2，M15 S2，M05 固定 Cull pass
辅：M14 S2 挂钩，M01 S3–S4
禁：HZB/Maybe 必做；meshlet 必做
门闸：G3 = 里程碑 A
```

### Phase 4 — Meshlet

```txt
主：M07 S2–S3，M04 S4（meshlet 表），M08 S3，M06 S3 扩展，M15 S3
门闸：G4
```

### Phase 5 — Visibility Buffer MVP

```txt
主：M10 S0–S2，M05 S3 起，M06 S4 起，M15 S3，M07 供几何
门闸：G5
```

### Phase 6 — Resolve + GBuffer + Deferred Light

```txt
主：M11 S0–S2，M12 S2，M09 S4–S5，M05 S3，M06 S4，M15 S4
门闸：G6
```

### Phase 7 — HZB / Occlusion

```txt
主：M08 S4–S6，M10 S4，M04 Maybe，M15，M05 S4 起
门闸：G7
```

### Phase 8 — TAA

```txt
主：M13 S1–S2，M11 S3，M14 S4，M06 S5，Transform.prev 严用，M05
门闸：G8
```

### Phase 9 — SSR / Shadows

```txt
主：M13 S3–S4，M12 S3–S4，M05，M15
门闸：G9
```

### Phase 10 — GI

```txt
主：M12 S5–S6，M13 合成，M05 分档，M14 S5
门闸：G10
```

### Phase 11 — 动态 / 动画

```txt
主：M03 S5，M02 S4，M07 S5，M04 动态 upload，M08 动态 bounds，M15
门闸：G11
```

---

## 4. 建议迭代切片（可当 Sprint 主题）

不设周数；每片结束应对齐一个 **G\*** 或明确预埋。

| 迭代片 | 主题 | 模块焦点 | 出口 |
|--------|------|----------|------|
| I0 | 仓库 + Present | M00 M01 M05 M06 M15 | G0 |
| I1 | 导入 + 画对 | M03 M02 M09 M07 M12 | G1 |
| I2 | 表驱动 | M04 M02 M03 M09 | G2 |
| I3 | GPU frustum | M08 M04 M09 M15 | **G3 里程碑 A** |
| I4 | Meshlet | M07 M08 M04 | G4 |
| I5 | VB | M10 M06 M05 | G5 |
| I6 | Resolve+Light | M11 M12 M09 | G6 |
| I7 | Occlusion | M08 M10 | G7 |
| I8 | TAA | M13 M14 M11 | G8 |
| I9 | SSR/Shadow | M13 M12 | G9 |
| I10 | GI 分档 | M12 M13 M14 | G10 |
| I11 | 动画 | M03 M07 M02 M04 | G11 |

**并行建议（人力≥2 时）：**

```txt
安全并行：
  M15 埋点 || 主路径
  M14 钩子 || P0–P3 主路径
  M06 着色草稿 || M04 表结构（接口先定）
  示例资产整理 || I1

危险并行（易返工）：
  未 G2 就上 VB
  未 G3 就上 HZB
  Layer C 直接 import three
  多套 bind group 号各写各的（先 draft 冻结一页）
```

---

## 5. 每阶段结束的固定仪式（强制）

```txt
1. 跑通对应该闸的 example
2. 勾选 verification-intent 该 Phase「完成意图」
3. 架构检查：three 边界、表驱动、无 WebGPURenderer 内核
4. Stats 截图或日志进记录（至少 visible/upload 等已有项）
5. 未决项：只允许「预埋」写入 ADR 或 issue，禁止静默扩大范围
6. 若改字段语义：同步 records-fields + mother-doc-field-map
```

---

## 6. 与文档的维护关系

| 执行中发生… | 更新哪里 |
|-------------|----------|
| Phase 完成 | stages / verification 勾选记录；可选 CHANGELOG |
| 字段/表变更 | 03-data + mother-doc-field-map |
| 依赖或「不做」变更 | ADR |
| Pass 读写变化 | pass-contracts |
| 包结构与本文冲突 | 改 M00 engineering-design + 本文 §0.3 |

---

## 7. 一页总表：模块 × 子阶段 × 首现门闸

| 模块 | 子阶段序列（摘要） | 首个必须通过的门闸 |
|------|--------------------|--------------------|
| M00 | 骨架→示例→CI→包边界→示例矩阵 | G0 |
| M01 | Device→池→编译→提交→丢失恢复 | G0 |
| M02 | Id/Store→行类型→Dirty→GPU 契约→动态 | G1（行）/ G2（契约） |
| M03 | 白名单→提取→相机→Sync→bake→动画 | G1 |
| M04 | 表→upload→读表→Visible→Meshlet/Maybe→budget | G2 / G3 |
| M05 | 壳→资源→模式A→VB链→高级→分档 | G0 |
| M06 | 编译→FS→PBR→cull→VB/resolve→post→变体 | G0→G3→G6 |
| M07 | 属性→缓冲→meshlet→供VB→压缩→skin | G1 / G4 |
| M08 | 契约→frustum→接画→meshlet→HZB→maybe→分档 | **G3** / G4 / G7 |
| M09 | 可画→读表→读可见→debug→共享lib→fallback | G1–G3 |
| M10 | 规格→raster→接meshlet→供resolve→HZB | **G5** |
| M11 | 重建→GBuffer→light→motion→变体 | **G6** |
| M12 | 简灯→表→deferred→shadow→GI | G1 / G6 / G9 / G10 |
| M13 | tonemap→TAA→失效→SSR→bloom→半分辨率 | G8 / G9 |
| M14 | 钩子→DPR→lost→hidden→history→分档默认 | G0 起横切 |
| M15 | 帧→表→cull→VB debug→计时→运动场景 | 每闸加字段 |

---

## 8. 立即可以开工的「第一刀」（无歧义）

若现在只开一个迭代片 **I0→I1**：

```txt
Week-less checklist:

I0
  [ ] packages 骨架 + examples/minimal
  [ ] Engine: adapter/device/canvas
  [ ] FrameGraph: Begin → Fullscreen → Present
  [ ] Shader: 清屏色
  [ ] Stats: 帧号
  [ ] Browser: resize 钩子空实现
  → G0

I1
  [ ] World: Mesh/Material/Transform/Instance CPU stores
  [ ] Adapter: compile 白名单静态 mesh
  [ ] 几何规范化 upload
  [ ] Baseline PBR + 一盏方向光/IBL
  [ ] example: 静态 glTF 或 three 手搭场景
  → G1

然后严格 I2→I3，不要插 VB。
```

---

## 9. 成功判据（工程级，不是文档级）

你的产品目标算「执行上进入正确轨道」当且仅当：

```txt
已过 G3：
  · three 只经 Adapter 进表
  · GPU tables 为绘制真源
  · GPU frustum 产出 VisibleInstance 且可统计
  · 仍保留 P4+ 为正式目标（代码可暂无，身份不删）

完整目标（远期）：
  · G5–G8 至少一条高质量档默认路径
  · G9–G10 可开关且受 M14 分档约束
  · G11 动态方向可演示
```

---

## 10. 相关链接

| 文档 | 用途 |
|------|------|
| [stages.md](./stages.md) | Phase 目标原文分册 |
| [phase-0-3-closed-loop.md](./phase-0-3-closed-loop.md) | 模式 A 串讲 |
| [phase-module-matrix.md](./phase-module-matrix.md) | 主责热力 |
| [phase-data-pass-map.md](./phase-data-pass-map.md) | 表/Pass |
| [verification-intent.md](./verification-intent.md) | 完成含义 |
| [risks-and-degrade.md](./risks-and-degrade.md) | 降级 |
| [../02-modules/README.md](../02-modules/README.md) | 模块设计入口 |
| 根目录母本六件套 | 权威细节 |
