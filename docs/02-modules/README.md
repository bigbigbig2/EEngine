# 02 · Modules

模块是 **设计 v2 能力在工程上的所有权切分**，不是另一套更窄的产品。

## 权威

```txt
产品与能力集合 → docs/source/design-v2-full.md
架构差         → docs/source/comparison-three-vs-shade.md
渲染核细节参照 → docs/source/shade-reference-v3.md
浏览器外壳     → docs/source/webgpu-browser-limits.md
WebGPU 词汇    → docs/source/webgpu-fundamentals.md
```

## 模块列表

| ID | 目录 | 对应母本能力（摘要） |
|----|------|----------------------|
| M00 | m00-engineering | 设计 v2 工程/目录 |
| M01 | m01-engine | 设计 v2 Engine / WebGPU-only |
| M02 | m02-world | 设计 v2 flat world / plain data |
| M03 | m03-adapter-three | 设计 v2 Layer 1 + §4 |
| M04 | m04-gpu-scene | 设计 v2 §6；对比/Shade GPU-resident |
| M05 | m05-frame-graph | 设计 v2 FrameGraph；Shade §10 |
| M06 | m06-shaders | 设计 v2 §18；非完整 TSL 内核 |
| M07 | m07-geometry | 设计 v2 meshlet；Shade §8 |
| M08 | m08-culling | 设计 v2 §7；Shade HZB；对比 occlusion |
| M09 | m09-shading-baseline | 可画对的 PBR 底座（通往 Layer 3 的阶梯，非最终替代） |
| M10 | m10-visibility | 设计 v2 §9；Shade §6 |
| M11 | m11-material-resolve | 设计 v2 §10；Shade material pass |
| M12 | m12-lighting | 设计 v2 lighting/shadow；Shade 光影/GI 接口 |
| M13 | m13-post | 设计 v2 TAA/SSR/Bloom…；Shade 后处理栈 |
| M14 | m14-browser | docs/source/webgpu-browser-limits.md |
| M15 | m15-debug-stats | 设计 v2 可测；对比需量化 |

## 每个模块文档写什么

```txt
写：职责、与母本哪一章对齐、拥有/不拥有、依赖、设计意图
部分模块已有 *‑design.md 加深（仍非实现锁字节）
不写：WGSL 全文定稿、最终 stride 冻结、周实现任务
```

## 已加深设计的模块

| 模块 | 加深文档 |
|------|----------|
| M00 | `engineering-design.md` |
| M01 | `engine-design.md` |
| M02 | `world-design.md` |
| M03 | `import-sync-design.md` |
| M04 | `tables-design.md` |
| M05 | `frame-graph-design.md` |
| M06 | `shader-system-design.md` |
| M07 | `geometry-design.md` |
| M08 | `culling-design.md` |
| M09 | `baseline-design.md` |
| M10 | `visibility-design.md` |
| M11 | `resolve-design.md` |
| M12 | `lighting-design.md` |
| M13 | `taa-ssr-design.md` |
| M14 | `browser-design.md` |
| M15 | `stats-design.md` |

## 阅读顺序

```txt
M03 → M02 → M04 → M01/M05/M06
 → M09（正确性底座）
 → M08 → M07 → M10 → M11 → M12 → M13
 → M14 / M15
```

## 实现步骤

按模块拆成多子阶段（S\*）并挂到全局 Phase 门闸：

→ [../07-roadmap/execution-plan-by-module.md](../07-roadmap/execution-plan-by-module.md)

