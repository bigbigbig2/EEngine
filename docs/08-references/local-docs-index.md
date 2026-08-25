# 本地母本索引导读

> 原文已统一放在 [`../source/`](../source/README.md)。

## 1. 建议阅读顺序

```txt
① source/webgpu-fundamentals.md
   WebGPU 相对 WebGL：显式资源、pipeline、command

② source/comparison-three-vs-shade.md
   WebGLRenderer / WebGPURenderer / Shade
   结论：换 API ≠ 换架构

③ source/webgpu-browser-limits.md
   标签页外壳：内存、加载、生命周期、DPR、预期

④ source/shade-reference-v3.md
   GPU-resident 全图：VB、meshlet、TAA、GI…
   上限参照，非逐行必实现清单

⑤ source/design-v2-full.md
   本工程产品母本：三层等式、表、管线、阶段 0–11

⑥ source/product-direction-webgpu-renderer-like.md
   门面像 WebGPURenderer、有限切换、TSL 边界

⑦ source/modules-phases-verification.md
   模块/阶段/验收整理；服从 ⑤
```

## 2. 主题 → 打开哪份

| 主题 | 打开 |
|------|------|
| 为何不改 WebGPURenderer | comparison + design-v2 §2 |
| 门面 / 与官方切换 / TSL | product-direction-webgpu-renderer-like |
| 浏览器能不能当 Unreal | webgpu-browser-limits |
| VB / meshlet 细节 | shade-reference-v3 |
| 本工程阶段顺序 | design-v2 §23 + docs/07 |
| 兼容 three 什么 | design-v2 §2.2§4 + docs/05 + product-direction |
| WebGPU 基础词汇 | webgpu-fundamentals |
| 按模块怎么做 | docs/07 execution-plan-by-module |

## 3. 旧文件名 → 新路径

| 旧（仓库根） | 新 |
|--------------|-----|
| `threejs_lite_shade_like_webgpu_full_design_v2.md` | `docs/source/design-v2-full.md` |
| `对比.md` | `docs/source/comparison-three-vs-shade.md` |
| `webgpu局限性.md` | `docs/source/webgpu-browser-limits.md` |
| `shade_webgpu_threejs_full_thread_v3.md` | `docs/source/shade-reference-v3.md` |
| `系统学习.md` | `docs/source/webgpu-fundamentals.md` |
| `threejs_lite_modules_phases_verification.md` | `docs/source/modules-phases-verification.md` |

## 4. docs 与母本

```txt
docs/00–09 = 分册
docs/source = 权威原文
冲突 → 改分册
```
