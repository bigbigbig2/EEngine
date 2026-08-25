# 风险与降级（设计层）

> 设计 v2 §24；verification 风险表；Shade 限制；webgpu-browser-limits；对比「固定成本」

## 1. 风险清单（保留母本）

| 风险 | 含义 | 主要阶段暴露 |
|------|------|----------------|
| 纹理 / 无 bindless | 大材质场景撞墙 | P1–P2、P6 |
| VB 工程复杂 | 重建/属性/运动向量难 | P5–P6 |
| WebGPU pass 过碎 | encode 成本反噬 | P5+ |
| 高 bandwidth | VB+GBuffer+history | P5–P8 |
| TAA 拖进度 | 全管线侵入 | P8 |
| three 兼容期望膨胀 | 「所有 Material 都能跑」 | P1 起 |
| 浏览器外壳 | lost/visibility/DPR/加载 | 全程 |
| 小场景不划算 | 架构固定成本 | 产品配置 |

## 2. 降级原则（不删目标）

```txt
降级 = 默认路径或某平台关闭某能力
≠ 从工程等式中删除该能力

例：
  某端关 GI / 半分辨率 SSR / 关 occlusion
  VB 短期困难时延长 deferred 路径 —— 仍保留 VB 目标身份
  meshlet 收益不足时允许整 mesh + 表驱动 —— 仍保留 meshlet 方向
```

## 3. 与 verification「可降级通过」

```txt
允许：阶段以「降级通过」记录，并写明缺什么、为何、何时补
禁止：把降级写成「我们改做 WebGPURenderer 插件」
```

## 4. 决策出口

重大裁剪或长期跳过某 Phase 能力 → `09-decisions` ADR，并回指设计 v2 哪一条被暂缓。
