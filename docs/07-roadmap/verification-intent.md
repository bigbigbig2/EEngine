# 验收的设计含义

> 来源：设计 v2 P9；`docs/source/modules-phases-verification.md` 的 Must 精神；docs/source/comparison-three-vs-shade.md 要分瓶颈  
> 本文定义 **什么叫「阶段在设计上可宣布完成」**，不是实验室填表模板全集

## 1. 三类证明

| 类型 | 证明什么 | 典型手段（意图） |
|------|----------|------------------|
| **正确性** | 链路与外观语义成立 | debug view、与 three 并排主观/可接受差、无静默错误材质 |
| **架构性** | 主路径符合母本分层 | 无 per-frame render-list 主导；表驱动；模块依赖不破 |
| **性能/可测** | 声称的收益可观测 | stats：visible、draw、upload、时间；固定场景对比开关 |

## 2. 各 Phase 的「完成意图」一句话

| Phase | 完成意图 |
|-------|----------|
| 0 | 最小 WebGPU 环稳定存在 |
| 1 | three 静态不透明场景能进引擎并画对基础 PBR |
| 2 | 绘制以 GPU tables 为真源 |
| 3 | GPU frustum 改变提交工作量且可统计 |
| 4 | meshlet 成为几何与 cull 粒度 |
| 5 | VB 存在且 ID 可调试 |
| 6 | 可见像素路径上 material→G-buffer→light 闭环 |
| 7 | HZB occlusion 可开关且行为可解释 |
| 8 | TAA 为管线一部分，非孤立滤镜 |
| 9 | SSR/阴影进入集成栈 |
| 10 | GI 方向可运行并可分档关闭 |
| 11 | 动态/动画进入 GPU-resident 方向 |

## 3. 架构性检查（跨阶段，verification 精神）

```txt
- render 核不依赖 three 类型主路径
- 仅 Adapter 官方依赖 three
- 无 WebGLRenderer/WebGPURenderer 作为后端内核
- 超出支持面可观测（失败/降级）
- dispose / device lost / visibility 有定义行为（随阶段加深）
```

## 4. 场景意图（verification T0–T5 精神）

| 意图 ID | 用途 |
|---------|------|
| 冒烟 | 单物体 PBR |
| 导入 | 多 mesh / 白名单 |
| 实例压 | 大量 instance → cull/CPU |
| archviz | 多材质/纹理/遮挡 |
| overdraw | deferred/VB 收益讨论 |
| 运动 | occlusion popping / TAA ghost |

具体资产选型实施时再定；设计层要求 **尽早固定对照场景**，否则docs/source/comparison-three-vs-shade.md 的讨论无法复现。

## 5. 禁止的完成宣言

```txt
Phase 1 完成 ≠ 比 three 快
Phase 3 完成 ≠ 完整 Shade
Phase 8 完成 ≠ 原生引擎画质
任何阶段完成 ≠ 可忽略 docs/source/webgpu-browser-limits.md
```
